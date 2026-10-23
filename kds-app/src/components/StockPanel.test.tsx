import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StockPanel } from "./StockPanel";
import type { Reservation } from "../types";

afterEach(cleanup);

const at = (h: number, m: number, s = 0) => new Date(2026, 9, 23, h, m, s).getTime();
const res: Reservation = { rid: "r1", time: "18:00", name: "山田", adults: 2, children: 1, menu: [{ name: "土鍋飯", qty: 3 }] };

function soon(now: number) {
  const { container } = render(<StockPanel stock={[res]} now={now} onSeat={() => {}} />);
  const has = !!container.querySelector(".kds-res.soon");
  cleanup();
  return has;
}

describe("StockPanel", () => {
  it("まもなくの判定: 30分前から開始ちょうどまで", () => {
    expect(soon(at(17, 29, 59))).toBe(false); // 30分を超える
    expect(soon(at(17, 30, 0))).toBe(true);   // ちょうど30分前
    expect(soon(at(18, 0, 0))).toBe(true);    // 開始ちょうど
    expect(soon(at(18, 0, 1))).toBe(false);   // 過ぎた後
  });
  it("0件は案内文、件数と内容を表示", () => {
    render(<StockPanel stock={[]} now={at(12, 0)} onSeat={() => {}} />);
    expect(screen.getByText("本日の予約はありません")).toBeTruthy();
    cleanup();
    render(<StockPanel stock={[res]} now={at(12, 0)} onSeat={() => {}} />);
    expect(screen.getByText("山田")).toBeTruthy();
    expect(screen.getByText("×3")).toBeTruthy();
  });
  it("来店→卓番→決定で onSeat", () => {
    const onSeat = vi.fn();
    render(<StockPanel stock={[res]} now={at(12, 0)} onSeat={onSeat} />);
    fireEvent.click(screen.getByText("来店"));
    fireEvent.click(screen.getByText("B"));
    fireEvent.click(screen.getByText("7"));
    fireEvent.click(screen.getByText("決定"));
    expect(onSeat).toHaveBeenCalledWith("r1", "B7");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
