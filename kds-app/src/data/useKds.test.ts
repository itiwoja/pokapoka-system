import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { Order } from "../types";
import { useKds } from "./useKds";
import { openChannel } from "./sync";
import { startOrderSound } from "./sound";
import { installDevMock } from "./devMock";
import { LS, saveDeleted, saveDone, saveKonro, saveOrderSeq, saveStock } from "./storage";

vi.mock("./sync", async (importOriginal) => ({
  ...await importOriginal<typeof import("./sync")>(),
  openChannel: vi.fn(),
}));
vi.mock("./sound", () => ({ startOrderSound: vi.fn() }));
vi.mock("./devMock", () => ({ installDevMock: vi.fn() }));

const NOW = new Date(2026, 9, 25, 12).getTime();
const order: Order = {
  id: "o1", table: "3", type: "new", start: NOW - 1000,
  items: [{ name: "土鍋飯", qty: 2, options: null, allergies: null }],
};
const w = window as Window & {
  KDS_ORDERS?: Order[];
  __KDS_RELAY_BRIDGE__?: boolean;
  __KDS_SYNC_STATUS__?: { channels: { orders: { state: string } } };
};
const post = vi.fn();
const close = vi.fn();
const stopSound = vi.fn();
let receive: Parameters<typeof openChannel>[0];

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  localStorage.clear();
  w.KDS_ORDERS = [order];
  w.__KDS_RELAY_BRIDGE__ = true;
  delete w.__KDS_SYNC_STATUS__;
  vi.mocked(openChannel).mockImplementation((listener) => {
    receive = listener;
    return { post, close };
  });
  vi.mocked(startOrderSound).mockReturnValue(stopSound);
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  delete w.KDS_ORDERS;
  delete w.__KDS_RELAY_BRIDGE__;
  delete w.__KDS_SYNC_STATUS__;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useKds のデータ層接続", () => {
  it("初期 snapshot は保存済みの並び・完了数・コンロ・削除記録・予約時刻順を反映する", () => {
    w.KDS_ORDERS = [{ ...order, id: "fresh", start: NOW - 5000 }, order, { ...order, id: "deleted" }];
    saveOrderSeq(["o1"]);
    saveDone({ o1: [1] });
    saveKonro({ o1: { "2": "red" } });
    saveDeleted({ deleted: true });
    saveStock([{ rid: "late", time: "13:00" }, { rid: "early", time: "11:00" }]);
    w.__KDS_SYNC_STATUS__ = { channels: { orders: { state: "offline" } } };
    const { result } = renderHook(useKds);
    expect(result.current.state.cards.map((c) => c.order.id)).toEqual(["o1", "fresh"]);
    expect(result.current.state.cards[0]).toMatchObject({ doneCounts: [1], konro: { 2: "red" }, finishing: false });
    expect(result.current.state.stock.map((r) => r.rid)).toEqual(["early", "late"]);
    expect(result.current.state.connection).toBe("offline");
    expect(result.current.state.now).toBe(NOW);
    expect(installDevMock).not.toHaveBeenCalled();
  });

  it("自画面の操作は即反映し、全完了の4秒猶予を tick 間で保ち、戻すと再表示する", () => {
    const { result } = renderHook(useKds);
    const actions = result.current.actions;
    act(() => {
      actions.completeOne("o1", 0);
      actions.completeOne("o1", 0);
    });
    expect(post.mock.calls).toEqual([
      [{ type: "toggle", id: "o1", index: 0, doneCount: 1 }],
      [{ type: "toggle", id: "o1", index: 0, doneCount: 2 }],
    ]);
    expect(result.current.state.cards[0].finishing).toBe(true);
    act(() => { vi.advanceTimersByTime(3000); });
    expect(result.current.state.cards).toHaveLength(1);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(result.current.state.cards).toEqual([]);
    act(() => { actions.undoOne("o1", 0); });
    expect(result.current.state.cards[0]).toMatchObject({ doneCounts: [1], finishing: false });
    expect(result.current.actions).toBe(actions);
    expect(openChannel).toHaveBeenCalledTimes(1);
  });

  it("他画面からの通知を保存してから即座に読み直し、受信内容を再送信しない", () => {
    const { result } = renderHook(useKds);
    act(() => { receive({ type: "toggle", id: "o1", index: 0, doneCount: 1 }); });
    expect(result.current.state.cards[0].doneCounts).toEqual([1]);
    act(() => { receive({ type: "konro", id: "o1", num: 2, state: "white" }); });
    expect(result.current.state.cards[0].konro).toEqual({ 2: "white" });
    act(() => { receive({ type: "stock", stock: [{ rid: "R1", time: "13:00" }] }); });
    expect(result.current.state.stock).toEqual([{ rid: "R1", time: "13:00" }]);
    act(() => { receive({ type: "deleteOrder", id: "o1" }); });
    expect(result.current.state.cards).toEqual([]);
    expect(post).not.toHaveBeenCalled();
  });

  it("接続通知と1秒 tick を購読し、終了時にタイマー・音・チャンネル・購読を片付ける", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const { result, unmount } = renderHook(useKds);
    const listener = add.mock.calls.find(([type]) => type === "kds-sync-status")![1];
    expect(result.current.state.connection).toBe("ok");
    act(() => {
      w.__KDS_SYNC_STATUS__ = { channels: { orders: { state: "offline" } } };
      window.dispatchEvent(new Event("kds-sync-status"));
    });
    expect(result.current.state.connection).toBe("offline");
    act(() => { vi.advanceTimersByTime(1000); });
    expect(result.current.state.now).toBe(NOW + 1000);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(stopSound).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith("kds-sync-status", listener);
  });

  it("前日の保存値は初期読込で破棄するが、注文フィードはそのまま読む", () => {
    localStorage.setItem(LS.day, "2026-10-24");
    saveDone({ o1: [2] });
    saveKonro({ o1: { "2": "red" } });
    saveDeleted({ o1: true });
    saveStock([{ rid: "old", time: "11:00" }]);
    const { result } = renderHook(useKds);
    expect(result.current.state.cards).toHaveLength(1);
    expect(result.current.state.cards[0]).toMatchObject({ doneCounts: [0], konro: {}, finishing: false });
    expect(result.current.state.stock).toEqual([]);
    expect(localStorage.getItem(LS.day)).toBe("2026-10-25");
  });
});
