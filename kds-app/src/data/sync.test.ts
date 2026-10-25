import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Order } from "../types";
import { applySyncMessage } from "./sync";
import {
  loadDeleted, loadDone, loadKonro, loadOrderSeq, loadStock, readOrders,
  saveDeleted, saveDone, saveKonro, saveOrderSeq, saveStock,
} from "./storage";

const order: Order = {
  id: "o1", table: "3", type: "new", start: 1000,
  items: [{ name: "土鍋飯", qty: 2, options: null, allergies: null }],
};
const w = window as Window & { KDS_ORDERS?: Order[] };

beforeEach(() => { localStorage.clear(); delete w.KDS_ORDERS; });
afterEach(() => { localStorage.clear(); delete w.KDS_ORDERS; });

describe("applySyncMessage", () => {
  it("toggle は対象品目だけを更新して他の完了数を保つ", () => {
    saveDone({ o1: [0, true], other: [2] });
    applySyncMessage({ type: "toggle", id: "o1", index: 0, doneCount: 2 });
    expect(loadDone()).toEqual({ o1: [2, true], other: [2] });
    applySyncMessage({ type: "toggle", id: "new", index: 0, doneCount: 1 });
    expect(loadDone().new).toEqual([1]);
  });

  it("konro は追加・色更新・skeleton での解除を行い、空の注文エントリを除く", () => {
    saveKonro({ o1: { "1": "white" }, other: { "2": "red" } });
    applySyncMessage({ type: "konro", id: "o1", num: 1, state: "red" });
    applySyncMessage({ type: "konro", id: "o1", num: 3, state: "white" });
    expect(loadKonro()).toEqual({ o1: { "1": "red", "3": "white" }, other: { "2": "red" } });
    applySyncMessage({ type: "konro", id: "o1", num: 1, state: "skeleton" });
    expect(loadKonro().o1).toEqual({ "3": "white" });
    applySyncMessage({ type: "konro", id: "o1", num: 3, state: "skeleton" });
    applySyncMessage({ type: "konro", id: "missing", num: 9, state: "skeleton" });
    expect(loadKonro()).toEqual({ other: { "2": "red" } });
  });

  it("order は文字列化した並び順、stock は予約一覧を保存する", () => {
    saveOrderSeq(["old"]);
    saveStock([{ rid: "old", time: "10:00" }]);
    applySyncMessage({ type: "order", seq: [2, "o1", 1] });
    applySyncMessage({ type: "stock", stock: [{ rid: "R1", time: "12:00" }] });
    expect(loadOrderSeq()).toEqual(["2", "o1", "1"]);
    expect(loadStock()).toEqual([{ rid: "R1", time: "12:00" }]);
  });

  it("moveToMain は予約ストックと注文フィードを更新し、同じ id の注文は置き換える", () => {
    w.KDS_ORDERS = [order, { ...order, id: "other" }];
    saveStock([{ rid: "R1", time: "12:00" }]);
    const changed = { ...order, table: "5" };
    applySyncMessage({ type: "moveToMain", stock: [], order: changed });
    expect(loadStock()).toEqual([]);
    expect(readOrders()).toEqual([changed, { ...order, id: "other" }]);
    applySyncMessage({ type: "moveToMain", stock: [], order: { ...order, id: "new" } });
    expect(readOrders()).toHaveLength(3);
    applySyncMessage({ type: "moveToMain", stock: [{ rid: "R2", time: "13:00" }] });
    expect(loadStock()).toEqual([{ rid: "R2", time: "13:00" }]);
    expect(readOrders()).toHaveLength(3);
  });

  it("deleteOrder は削除記録を残し、文字列が一致する注文だけをフィードから除く", () => {
    w.KDS_ORDERS = [order, { ...order, id: "7" }];
    saveDeleted({ previous: true });
    applySyncMessage({ type: "deleteOrder", id: 7 });
    expect(loadDeleted()).toEqual({ previous: true, "7": true });
    expect(readOrders()).toEqual([order]);
    delete w.KDS_ORDERS;
    applySyncMessage({ type: "deleteOrder", id: "o1" });
    expect(w.KDS_ORDERS).toBeUndefined();
    expect(loadDeleted().o1).toBe(true);
  });

  it("未知の通知・timerLock・配列でない一覧は既存と同様に無視する", () => {
    saveOrderSeq(["o1"]);
    saveStock([{ rid: "R1", time: "12:00" }]);
    const before = { ...localStorage };
    for (const msg of [
      { type: "unknown" }, { type: "timerLock", id: "o1", locked: true },
      { type: "order", seq: null }, { type: "stock", stock: {} },
      { type: "moveToMain", stock: null, order }, { type: "deleteOrder", id: "" },
    ]) applySyncMessage(msg);
    expect({ ...localStorage }).toEqual(before);
    expect(readOrders()).toEqual([]);
  });
});
