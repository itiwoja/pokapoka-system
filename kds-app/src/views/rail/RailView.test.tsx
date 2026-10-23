import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { Card } from "../../types";
import type { KdsActions, KdsState } from "../../data/contract";
import RailView, { dropPx, LINE10_PX } from "./RailView";

vi.mock("../print/printSlip", () => ({ printSlip: vi.fn(async () => "printed") }));
afterEach(cleanup);

const START = 1_000_000_000_000;
const card = (id: string, table: string): Card => ({
  order: { id, table, type: "new", start: START, items: [{ name: "鯛めし", qty: 1, options: null, allergies: null }] },
  doneCounts: [0], konro: {}, finishing: false,
});
const actions = (): KdsActions => ({ completeOne: vi.fn(), undoOne: vi.fn(), setKonro: vi.fn(), seatReservation: vi.fn() });
const st = (now: number, cards: Card[]): KdsState => ({ cards, stock: [], connection: "ok", now });

describe("RailView", () => {
  it("カードが並び、経過で垂れ下がりが変わる", () => {
    const { rerender } = render(<RailView state={st(START, [card("a", "3"), card("b", "7")])} actions={actions()} />);
    const strips = screen.getAllByTestId("rail-strip");
    expect(strips).toHaveLength(2);
    expect(strips[0].style.marginTop).toBe("0px");
    rerender(<RailView state={st(START + 600_000, [card("a", "3"), card("b", "7")])} actions={actions()} />);
    expect(screen.getAllByTestId("rail-strip")[0].style.marginTop).toBe(`${LINE10_PX}px`);
    expect(dropPx(99 * 60000)).toBeLessThan(800);
  });
  it("品目タップで completeOne、空なら文言", () => {
    const a = actions();
    render(<RailView state={st(START, [card("a", "3")])} actions={a} />);
    fireEvent.click(screen.getByText("鯛めし"));
    expect(a.completeOne).toHaveBeenCalledWith("a", 0);
    cleanup();
    render(<RailView state={st(START, [])} actions={a} />);
    expect(screen.getByText("注文はありません")).toBeTruthy();
  });
});
