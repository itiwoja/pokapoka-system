import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Card } from "../types";
import type { KdsActions, KdsState } from "../data/contract";
import { printSlip } from "../print/printSlip";
import OrderCard from "./cards/OrderCard";
import BoardView from "./board/BoardView";
import RailView from "./rail/RailView";
import StoveView from "./stove/StoveView";

vi.mock("../print/printSlip", () => ({ printSlip: vi.fn() }));
const print = vi.mocked(printSlip);
const card: Card = {
  order: {
    id: "o1", table: "A3", type: "new", start: 1000,
    items: [{ name: "土鍋飯", qty: 1, options: null, allergies: null }],
  },
  doneCounts: [0], konro: {}, finishing: false,
};
const state: KdsState = { cards: [card], stock: [], connection: "ok", now: 2000 };
const actions: KdsActions = {
  completeOne: vi.fn(), undoOne: vi.fn(), setKonro: vi.fn(), seatReservation: vi.fn(),
};

function setup(view: "cards" | "board" | "rail" | "stove") {
  if (view === "cards") return render(<OrderCard card={card} now={state.now} actions={actions} />);
  if (view === "board") return render(<BoardView state={state} actions={actions} />);
  if (view === "rail") return render(<RailView state={state} actions={actions} />);
  const result = render(<StoveView state={state} actions={actions} />);
  fireEvent.click(result.container.querySelector(".kds-stove-tb")!);
  return result;
}

const button = () => screen.getByRole<HTMLButtonElement>("button", { name: "伝票" });
const clickPrint = async () => { await act(async () => { fireEvent.click(button()); }); };

beforeEach(() => { vi.useFakeTimers(); print.mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe.each(["cards", "board"] as const)("%s の共通印刷 UI", (view) => {
  it("送信中だけボタンを無効化し、対象注文を印刷する", async () => {
    let resolve!: (value: Awaited<ReturnType<typeof printSlip>>) => void;
    print.mockImplementation(() => new Promise((r) => { resolve = r; }));
    setup(view);
    fireEvent.click(button());
    expect(button().disabled).toBe(true);
    expect(print).toHaveBeenCalledWith(card.order);
    await act(async () => { resolve("printed"); });
    expect(button().disabled).toBe(false);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it.each(["printed", "browser", "busy"] as const)("%s は失敗表示しない", async (result) => {
    print.mockResolvedValue(result);
    setup(view);
    await clickPrint();
    expect(button().disabled).toBe(false);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it.each(["failed", "exception"] as const)("%s は3秒だけ失敗表示する", async (result) => {
    if (result === "failed") print.mockResolvedValue("failed");
    else print.mockRejectedValue(new Error("print"));
    setup(view);
    await clickPrint();
    expect(button().disabled).toBe(false);
    expect(screen.getByRole("status").textContent).toBe("印刷できませんでした");
    act(() => { vi.advanceTimersByTime(2999); });
    expect(screen.getByRole("status")).toBeTruthy();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("再失敗で3秒を数え直し、アンマウントでタイマーを解除する", async () => {
    print.mockResolvedValue("failed");
    const { unmount } = setup(view);
    await clickPrint();
    act(() => { vi.advanceTimersByTime(2000); });
    await clickPrint();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByRole("status")).toBeTruthy();
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["printed", "browser", "busy"] as const)("再試行が %s でも既存エラーの3秒表示は変えない", async (result) => {
    print.mockResolvedValueOnce("failed").mockResolvedValueOnce(result);
    setup(view);
    await clickPrint();
    act(() => { vi.advanceTimersByTime(1000); });
    await clickPrint();
    expect(screen.getByRole("status")).toBeTruthy();
    act(() => { vi.advanceTimersByTime(2000); });
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("案ごとに異なる印刷失敗 UI を維持", () => {
  it.each(["failed", "exception"] as const)("rail は %s でも失敗表示しない", async (result) => {
    if (result === "failed") print.mockResolvedValue("failed");
    else print.mockRejectedValue(new Error("print"));
    setup("rail");
    await clickPrint();
    expect(print).toHaveBeenCalledWith(card.order);
    expect(button().disabled).toBe(false);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it.each(["printed", "browser", "busy"] as const)("stove は失敗を表示し続け、%s で解除する", async (result) => {
    print.mockResolvedValueOnce("failed").mockResolvedValueOnce(result);
    setup("stove");
    await clickPrint();
    act(() => { vi.advanceTimersByTime(5000); });
    expect(screen.getByRole("status").textContent).toBe("印刷できませんでした");
    expect(button().disabled).toBe(false);
    await clickPrint();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
