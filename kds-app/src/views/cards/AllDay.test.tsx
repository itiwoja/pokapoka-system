import { describe, expect, it } from "vitest";
import { allDayTotals } from "./AllDay";
import type { Card } from "../../types";

function card(id: string, items: [string, number][], doneCounts: number[], finishing = false): Card {
  return {
    order: { id, table: "1", type: "new", start: 0, items: items.map(([name, qty]) => ({ name, qty, options: null, allergies: null })) },
    doneCounts,
    konro: {},
    finishing,
  };
}

describe("allDayTotals", () => {
  it("同じ品名を全カードで合算し、完了した分は引く", () => {
    const totals = allDayTotals([
      card("a", [["鯛めし", 2], ["味噌汁", 1]], [1, 0]),
      card("b", [["鯛めし", 3]], [0]),
    ]);
    expect(totals).toEqual([{ name: "鯛めし", qty: 4 }, { name: "味噌汁", qty: 1 }]);
  });
  it("消えかけのカードと残り0の品は数えない", () => {
    const totals = allDayTotals([
      card("a", [["鯛めし", 2]], [2]),
      card("b", [["味噌汁", 1]], [0], true),
    ]);
    expect(totals).toEqual([]);
  });
});
