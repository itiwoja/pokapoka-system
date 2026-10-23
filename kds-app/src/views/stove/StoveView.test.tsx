import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { Card } from "../../types";
import type { KdsActions, KdsState } from "../../data/contract";
import StoveView from "./StoveView";

vi.mock("../print/printSlip", () => ({ printSlip: vi.fn(async () => "printed") }));
afterEach(cleanup);

const START = 1_000_000_000_000;
function card(id: string, table: string, konro: Card["konro"]): Card {
  return {
    order: { id, table, type: "new", start: START, items: [
      { name: "鯛めし", qty: 2, options: null, allergies: null },
      { name: "味噌汁", qty: 2, options: null, allergies: null },
    ] },
    doneCounts: [0, 0], konro, finishing: false,
  };
}
const actions = (): KdsActions => ({ completeOne: vi.fn(), undoOne: vi.fn(), setKonro: vi.fn(), seatReservation: vi.fn() });
const mk = (cards: Card[]): KdsState => ({ cards, stock: [], connection: "ok", now: START + 125_000 });

describe("StoveView", () => {
  it("コンロ口にカードが載り、タップで white→red", () => {
    const a = actions();
    render(<StoveView state={mk([card("o1", "3", { 1: "white" })])} actions={a} />);
    expect(screen.getByText("02:05")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("コンロ1 3卓"));
    expect(a.setKonro).toHaveBeenCalledWith("o1", 1, "red");
  });

  it("待ちトークンを選び、空の口をタップで setKonro", () => {
    const a = actions();
    render(<StoveView state={mk([card("o2", "5", {})])} actions={a} />);
    fireEvent.click(screen.getByRole("button", { name: /鯛めし ×2/ }));
    fireEvent.click(screen.getByLabelText("コンロ4 空き"));
    expect(a.setKonro).toHaveBeenCalledWith("o2", 4, "white");
  });
});
