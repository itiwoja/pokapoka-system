import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Order, Reservation } from "../types";
import { createKdsActions } from "./actions";
import { loadDone, loadKonro, loadStock, putOrder, readOrders, saveDone, saveKonro, saveStock } from "./storage";
import type { KdsMessage } from "./sync";

const NOW = new Date(2026, 9, 25, 12).getTime();
const order: Order = {
  id: "o1", table: "A3", type: "new", start: NOW,
  items: [
    { name: "土鍋飯", qty: 3, options: null, allergies: null },
    { name: "汁物", qty: 1, options: null, allergies: null },
  ],
};
const w = window as Window & { KDS_ORDERS?: Order[] };

beforeEach(() => {
  localStorage.clear();
  w.KDS_ORDERS = [order];
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  localStorage.clear();
  delete w.KDS_ORDERS;
  vi.useRealTimers();
});

describe("createKdsActions", () => {
  it("完了・戻す操作は最新の保存値を使い、保存→通知→再読込の順で反映する", () => {
    saveDone({ o1: [0, true], other: [2] });
    const counts: number[] = [];
    const post = vi.fn((msg: KdsMessage) => {
      expect(msg.type).toBe("toggle");
      if (msg.type === "toggle") {
        expect(loadDone().o1[0]).toBe(msg.doneCount);
        counts.push(msg.doneCount);
      }
    });
    const refresh = vi.fn(() => { expect(post).toHaveBeenCalledTimes(counts.length); });
    const actions = createKdsActions(post, refresh);
    actions.completeOne("o1", 0);
    expect(JSON.parse(localStorage.getItem("kds_done_v2")!)).toEqual({ o1: [1, 1], other: [2] });
    expect(post).toHaveBeenLastCalledWith({ type: "toggle", id: "o1", index: 0, doneCount: 1 });

    // 操作オブジェクトの作成後に他タブが変えても、古い値で上書きしない。
    saveDone({ o1: [3, 1], other: [2] });
    actions.undoOne("o1", 0);
    expect(loadDone()).toEqual({ o1: [2, 1], other: [2] });
    expect(counts).toEqual([1, 2]);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(post.mock.invocationCallOrder[0]).toBeLessThan(refresh.mock.invocationCallOrder[0]);
    expect(post.mock.invocationCallOrder[1]).toBeLessThan(refresh.mock.invocationCallOrder[1]);
  });

  it("旧 v1 の boolean 完了数を読み、v2 に保存する", () => {
    localStorage.setItem("kds_done_v1", JSON.stringify({ o1: [true, false] }));
    const actions = createKdsActions(vi.fn(), vi.fn());
    actions.undoOne("o1", 0);
    expect(JSON.parse(localStorage.getItem("kds_done_v2")!)).toEqual({ o1: [2, 0] });
  });

  it("注文・品目が無い、全数完了、0個から戻す操作は保存・通知・再読込しない", () => {
    const post = vi.fn();
    const refresh = vi.fn();
    const actions = createKdsActions(post, refresh);
    actions.completeOne("missing", 0);
    actions.completeOne("o1", 9);
    actions.undoOne("o1", 0);
    expect(localStorage.getItem("kds_done_v2")).toBeNull();
    saveDone({ o1: [3, 0] });
    actions.completeOne("o1", 0);
    expect(loadDone()).toEqual({ o1: [3, 0] });
    expect(post).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("コンロの競合を解除して保存し、解除→設定の順で通知する", () => {
    saveKonro({ other: { "2": "white" }, o1: { "4": "red" } });
    const post = vi.fn(() => { expect(loadKonro()).toEqual({ o1: { "2": "red", "4": "red" } }); });
    const refresh = vi.fn(() => { expect(post).toHaveBeenCalledTimes(2); });
    const actions = createKdsActions(post, refresh);
    actions.setKonro("o1", 2, "red");
    expect(post.mock.calls).toEqual([
      [{ type: "konro", id: "other", num: 2, state: "skeleton" }],
      [{ type: "konro", id: "o1", num: 2, state: "red" }],
    ]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("コンロ解除は skeleton を通知し、最後の番号なら注文の保存エントリも除く", () => {
    saveKonro({ o1: { "2": "white" } });
    const post = vi.fn();
    createKdsActions(post, vi.fn()).setKonro("o1", 2, null);
    expect(loadKonro()).toEqual({});
    expect(post).toHaveBeenCalledWith({ type: "konro", id: "o1", num: 2, state: "skeleton" });
  });

  it("予約来店は卓番を trim し、注文投入・ストック削除の後に同じデータを通知する", () => {
    const seated: Reservation = {
      rid: "R1", time: "12:00", adults: 2, kids: 1,
      allergies: "えび", request: "静かな席", menu: [{ name: "土鍋飯", qty: 2 }],
    };
    const later: Reservation = { rid: "R2", time: "13:00" };
    saveStock([seated, later]);
    // 再来店操作でも同じ res-<rid> は重複させず更新する。
    putOrder({ ...order, id: "res-R1", table: "old" });
    const post = vi.fn((msg: KdsMessage) => {
      expect(loadStock()).toEqual([later]);
      expect(msg).toEqual({ type: "moveToMain", stock: [later], order: readOrders()[1] });
    });
    const refresh = vi.fn(() => { expect(post).toHaveBeenCalledTimes(1); });
    createKdsActions(post, refresh).seatReservation("R1", "  5  ");
    expect(readOrders()).toHaveLength(2);
    expect(readOrders()[1]).toMatchObject({
      id: "res-R1", table: "5", type: "reserved", start: NOW, people: 3,
      allergies: "えび", request: "静かな席",
      items: [{ name: "土鍋飯", qty: 2, options: null, allergies: null, done: false }],
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("卓番が空または予約が無ければ来店処理しない", () => {
    saveStock([{ rid: "R1", time: "12:00" }]);
    const post = vi.fn();
    const refresh = vi.fn();
    const actions = createKdsActions(post, refresh);
    actions.seatReservation("R1", "   ");
    actions.seatReservation("missing", "5");
    expect(readOrders()).toEqual([order]);
    expect(loadStock()).toEqual([{ rid: "R1", time: "12:00" }]);
    expect(post).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
});
