import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { Card } from "../../types";
import type { KdsActions, KdsState } from "../../data/contract";
import BoardView from "./BoardView";

vi.mock("../print/printSlip", () => ({ printSlip: vi.fn(async () => "printed") }));
afterEach(cleanup);

const START = 1_000_000_000_000;
function card(id: string, table: string, startOffsetMin: number): Card {
  return {
    order: { id, table, type: "new", start: START - startOffsetMin * 60000, items: [{ name: `品${id}`, qty: 1, options: null, allergies: null }] },
    doneCounts: [0], konro: {}, finishing: false,
  };
}
function setup(cards: Card[]) {
  const actions: KdsActions = { completeOne: vi.fn(), undoOne: vi.fn(), setKonro: vi.fn(), seatReservation: vi.fn() };
  const state: KdsState = { cards, stock: [], connection: "ok", now: START };
  const { container } = render(<BoardView state={state} actions={actions} />);
  return { actions, container };
}

describe("BoardView", () => {
  it("卓ごとに行が並ぶ", () => {
    const { container } = setup([card("1", "3", 1), card("2", "7", 2)]);
    expect(container.querySelectorAll(".kds-bd-row").length).toBe(2);
  });
  it("品目タップで completeOne", () => {
    const { actions } = setup([card("1", "3", 1)]);
    fireEvent.click(screen.getByText("品1"));
    expect(actions.completeOne).toHaveBeenCalledWith("1", 0);
  });
  it("10分超の行だけ late クラス", () => {
    const { container } = setup([card("1", "3", 12), card("2", "7", 2)]);
    const rows = container.querySelectorAll(".kds-bd-row");
    expect(rows[0].classList.contains("late")).toBe(true);
    expect(rows[1].classList.contains("late")).toBe(false);
  });
  it("空のとき文言を出す", () => {
    setup([]);
    expect(screen.getByText("注文はありません")).toBeTruthy();
  });
});
