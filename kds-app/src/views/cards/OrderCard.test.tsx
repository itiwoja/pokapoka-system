import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import type { Card } from "../../types";
import type { KdsActions } from "../../data/contract";
import OrderCard from "./OrderCard";

vi.mock("../print/printSlip", () => ({ printSlip: vi.fn(async () => "printed") }));

afterEach(cleanup);

const START = 1_000_000_000_000;
function makeCard(over: Partial<Card> = {}): Card {
  return {
    order: {
      id: "o1", table: "A3", type: "new", start: START, people: 2,
      items: [
        { name: "豚バラ", qty: 3, options: "タレ", allergies: null },
        { name: "ライス", qty: 1, options: null, allergies: "卵" },
      ],
    },
    doneCounts: [0, 1],
    konro: {},
    finishing: false,
    ...over,
  };
}
function makeActions(): KdsActions {
  return { completeOne: vi.fn(), undoOne: vi.fn(), setKonro: vi.fn(), seatReservation: vi.fn() };
}

describe("OrderCard", () => {
  it("未完了の行タップで completeOne", () => {
    const a = makeActions();
    render(<OrderCard card={makeCard()} now={START} actions={a} />);
    fireEvent.click(screen.getByText("豚バラ"));
    expect(a.completeOne).toHaveBeenCalledWith("o1", 0);
    expect(a.undoOne).not.toHaveBeenCalled();
  });

  it("全数完了の行タップで undoOne", () => {
    const a = makeActions();
    render(<OrderCard card={makeCard()} now={START} actions={a} />);
    fireEvent.click(screen.getByText("ライス"));
    expect(a.undoOne).toHaveBeenCalledWith("o1", 1);
    expect(a.completeOne).not.toHaveBeenCalled();
  });

  it("数量2以上は途中まで終えたときだけ 完了/全数 を出す", () => {
    const { unmount } = render(<OrderCard card={makeCard()} now={START} actions={makeActions()} />);
    expect(screen.queryByText("0/3")).toBeNull();
    unmount();
    render(<OrderCard card={makeCard({ doneCounts: [1, 1] })} now={START} actions={makeActions()} />);
    expect(screen.getByText("1/3")).toBeTruthy();
  });

  it("経過分の色クラスが 0/5/10 分で切り替わる", () => {
    const cls = (min: number) => {
      const { container, unmount } = render(<OrderCard card={makeCard()} now={START + min * 60000} actions={makeActions()} />);
      const c = container.querySelector("article")!.className;
      unmount();
      return c;
    };
    expect(cls(0)).toContain("kds-card--ok");
    expect(cls(4)).toContain("kds-card--ok");
    expect(cls(5)).toContain("kds-card--warn");
    expect(cls(10)).toContain("kds-card--alert");
  });

  it("コンロ番号チップは使用中のときだけ出る", () => {
    const { container, rerender } = render(<OrderCard card={makeCard()} now={START} actions={makeActions()} />);
    expect(container.querySelectorAll(".kds-chip").length).toBe(0);
    rerender(<OrderCard card={makeCard({ konro: { 2: "white", 7: "red" } })} now={START} actions={makeActions()} />);
    const chips = container.querySelectorAll(".kds-chip");
    expect(chips.length).toBe(2);
    expect(chips[1].className).toContain("kds-chip--red");
  });

  it("長押し0.8秒で undoOne、直後の click では何も起きない", () => {
    vi.useFakeTimers();
    const a = makeActions();
    render(<OrderCard card={makeCard()} now={START} actions={a} />);
    const row = screen.getByText("豚バラ");
    fireEvent.pointerDown(row, { clientX: 10, clientY: 10 });
    act(() => { vi.advanceTimersByTime(800); });
    fireEvent.pointerUp(row);
    fireEvent.click(row);
    vi.useRealTimers();
    expect(a.undoOne).toHaveBeenCalledWith("o1", 0);
    expect(a.completeOne).not.toHaveBeenCalled();
  });

  it("コンロ選択でタップすると 未使用→白 で setKonro", () => {
    const a = makeActions();
    render(<OrderCard card={makeCard()} now={START} actions={a} />);
    fireEvent.click(screen.getByText("コンロ"));
    fireEvent.click(screen.getByRole("button", { name: "3" }));
    expect(a.setKonro).toHaveBeenCalledWith("o1", 3, "white");
  });
});
