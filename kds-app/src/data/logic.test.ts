import { describe, expect, it } from "vitest";
import {
  applyFinishing, assignKonro, buildSeatedOrder, completeOne, composeCards, connectionFrom,
  dayString, isStaleDay, sortOrders, undoOne,
} from "./logic";
import { konroMsg, moveToMainMsg, toggleMsg } from "./sync";
import type { Order } from "../types";

const order = (id: string, start: number, qtys: number[] = [1]): Order => ({
  id, table: id, type: "new", start,
  items: qtys.map((qty, i) => ({ name: "品" + i, qty, options: null, allergies: null })),
});

describe("sortOrders", () => {
  it("seq にある id はその順、無いものは start 昇順で末尾", () => {
    const list = [order("a", 50), order("b", 10), order("c", 30), order("d", 20)];
    expect(sortOrders(list, ["c", "a"]).map((o) => o.id)).toEqual(["c", "a", "b", "d"]);
  });
});

describe("composeCards", () => {
  it("完了個数・コンロ・削除済みの除外", () => {
    const orders = [order("a", 1, [3, 1]), order("b", 2), order("x", 3)];
    const r = composeCards({
      orders, done: { a: [true, 0] as unknown[] }, konro: { a: { "2": "red", "4": "skeleton" } },
      seq: [], deleted: { x: true },
    });
    expect(r.map((c) => c.card.order.id)).toEqual(["a", "b"]);
    expect(r[0].card.doneCounts).toEqual([3, 0]);
    expect(r[0].card.konro).toEqual({ 2: "red" });
    expect(r[0].allDone).toBe(false);
  });
  it("保存が無ければ item.done を見る", () => {
    const o = order("a", 1);
    (o.items[0] as { done?: boolean }).done = true;
    expect(composeCards({ orders: [o], done: {}, konro: {}, seq: [], deleted: {} })[0].allDone).toBe(true);
  });
});

describe("completeOne / undoOne", () => {
  const o = order("a", 1, [2, 1]);
  it("1個ずつ進み、全数なら null", () => {
    expect(completeOne(o, {}, 0)).toEqual({ counts: [1, 0], doneCount: 1 });
    expect(completeOne(o, { a: [2, 0] }, 0)).toBeNull();
    expect(completeOne(o, {}, 9)).toBeNull();
  });
  it("undo は1個戻し、0 なら null", () => {
    expect(undoOne(o, { a: [2, 1] }, 0)).toEqual({ counts: [1, 1], doneCount: 1 });
    expect(undoOne(o, { a: [0, 0] }, 0)).toBeNull();
  });
});

describe("applyFinishing", () => {
  const done = [{ card: { order: order("a", 1), doneCounts: [1], konro: {} }, allDone: true }];
  it("4秒残し、経過後に外し、undo で通常に戻る", () => {
    const t0 = 10_000;
    const r0 = applyFinishing(done, {}, t0);
    expect(r0.cards[0].finishing).toBe(true);
    const r1 = applyFinishing(done, r0.finishAt, t0 + 3999);
    expect(r1.cards).toHaveLength(1);
    const r2 = applyFinishing(done, r0.finishAt, t0 + 4000);
    expect(r2.cards).toHaveLength(0);
    const undone = [{ ...done[0], allDone: false }];
    const r3 = applyFinishing(undone, r0.finishAt, t0 + 1000);
    expect(r3.cards[0].finishing).toBe(false);
    expect(r3.finishAt).toEqual({});
  });
});

describe("assignKonro", () => {
  it("同じ番号を別カードが使っていたら外す", () => {
    const { map, changes } = assignKonro({ a: { "1": "white" }, b: { "2": "red" } }, "b", 1, "red");
    expect(map).toEqual({ b: { "1": "red", "2": "red" } });
    expect(changes).toEqual([
      { id: "a", num: 1, state: "skeleton" },
      { id: "b", num: 1, state: "red" },
    ]);
  });
  it("null で解除", () => {
    const { map, changes } = assignKonro({ a: { "1": "white" } }, "a", 1, null);
    expect(map).toEqual({});
    expect(changes).toEqual([{ id: "a", num: 1, state: "skeleton" }]);
  });
});

describe("日付", () => {
  it("日付が変わったときだけ破棄", () => {
    expect(isStaleDay(null, "2026-10-23")).toBe(false);
    expect(isStaleDay("2026-10-23", "2026-10-23")).toBe(false);
    expect(isStaleDay("2026-10-22", "2026-10-23")).toBe(true);
    expect(dayString(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});

describe("buildSeatedOrder", () => {
  it("res-<rid>・人数合計・品目を現行どおり作る", () => {
    const o = buildSeatedOrder(
      { rid: "R1", time: "18:00", adults: 2, kids: 1, menu: [{ name: "鯛めし", qty: 2 }] }, "5", 1000,
    ) as unknown as Record<string, unknown>;
    expect(o).toMatchObject({ id: "res-R1", table: "5", type: "reserved", start: 1000, people: 3, adults: 2, kids: 1 });
    expect(o.items).toEqual([{ name: "鯛めし", qty: 2, options: null, allergies: null, done: false }]);
  });
});

describe("connectionFrom", () => {
  it("ブリッジ無しは ok、orders が offline のときだけ offline", () => {
    expect(connectionFrom(false, { channels: { orders: { state: "offline" } } })).toBe("ok");
    expect(connectionFrom(true, { channels: { orders: { state: "offline" } } })).toBe("offline");
    expect(connectionFrom(true, { channels: { orders: { state: "normal" }, kitchen: { state: "offline" } } })).toBe("ok");
    expect(connectionFrom(true, undefined)).toBe("ok");
  });
});

describe("BroadcastChannel メッセージの形 (現行と一致)", () => {
  it("toggle / konro / moveToMain", () => {
    expect(toggleMsg("a", 1, 2)).toEqual({ type: "toggle", id: "a", index: 1, doneCount: 2 });
    expect(konroMsg({ id: "a", num: 3, state: "white" })).toEqual({ type: "konro", id: "a", num: 3, state: "white" });
    expect(konroMsg({ id: "a", num: 3, state: "skeleton" })).toEqual({ type: "konro", id: "a", num: 3, state: "skeleton" });
    const ord = order("res-R1", 1);
    expect(moveToMainMsg([], ord)).toEqual({ type: "moveToMain", stock: [], order: ord });
    expect(Object.keys(toggleMsg("a", 0, 1)).sort()).toEqual(["doneCount", "id", "index", "type"]);
  });
});
