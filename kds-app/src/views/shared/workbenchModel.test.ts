import { describe, expect, it } from "vitest";
import type { Card } from "../../types";
import { elapsed, flowStage, groupItems, isLate, progress } from "./workbenchModel";

const card = (id: string, options: string | null = null, allergies: string | null = null): Card => ({
  order: { id, table: "A1", type: "new", start: 1000, items: [{ name: "鯛めし", qty: 3, options, allergies }] },
  doneCounts: [1], konro: {}, finishing: false,
});

describe("品目の集約", () => {
  it("同じ調理条件だけ集約し、卓番が同じでも元の注文とindexを保つ", () => {
    const a = card("a"), b = card("b");
    b.order.items.push({ ...b.order.items[0], qty: 2 });
    b.doneCounts.push(0);
    const groups = groupItems([a, b]);
    expect(groups).toHaveLength(1);
    expect(groups[0].remaining).toBe(6);
    expect(groups[0].entries.map((entry) => [entry.card.order.id, entry.index])).toEqual([["a", 0], ["b", 0], ["b", 1]]);
  });

  it("オプション・品目アレルギー・予約アレルギー・要望を混ぜない", () => {
    const reservedAllergy = card("d");
    Object.assign(reservedAllergy.order, { allergies: "小麦" });
    const requested = card("e");
    Object.assign(requested.order, { request: "先出し" });
    const groups = groupItems([card("a"), card("b", "大盛り"), card("c", null, "卵"), reservedAllergy, requested]);
    expect(groups).toHaveLength(5);
    expect(groups[3].allergy).toBe("小麦");
    expect(groups[4].request).toBe("先出し");
  });

  it("全数完了でも取り消しのために元の品目を残す", () => {
    const a = card("a");
    a.doneCounts = [3];
    expect(groupItems([a])[0].remaining).toBe(0);
    expect(groupItems([a])[0].entries).toHaveLength(1);
  });
});

it("工程は実データだけで判定し、1個だけの未着手注文を仕上げ扱いしない", () => {
  const a = card("a");
  a.doneCounts = [0];
  expect(flowStage(a)).toBe("queue");
  a.konro = { 1: "white" };
  expect(flowStage(a)).toBe("cooking");
  a.konro = {};
  a.doneCounts = [1];
  expect(flowStage(a)).toBe("cooking");
  a.doneCounts = [2];
  expect(flowStage(a)).toBe("finish");
  a.doneCounts = [3];
  expect(flowStage(a)).toBe("finish");
  expect(progress(a)).toEqual({ total: 3, done: 3, remaining: 0, complete: true });
  a.order.items[0].qty = 1;
  a.doneCounts = [0];
  expect(flowStage(a)).toBe("queue");
});

it("10分の境界で遅延表示し、全品完了・未来の受付を遅延扱いしない", () => {
  const a = card("a");
  expect(isLate(a, 600_999)).toBe(false);
  expect(isLate(a, 601_000)).toBe(true);
  expect(elapsed(a, 0)).toBe(0);
  a.doneCounts = [3];
  expect(isLate(a, 900_000)).toBe(false);
});
