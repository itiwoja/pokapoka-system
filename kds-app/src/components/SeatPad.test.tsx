import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach } from "vitest";
import { SeatPad } from "./SeatPad";

afterEach(cleanup);

describe("SeatPad", () => {
  it("空のあいだは決定が無効", () => {
    render(<SeatPad title="t" onSubmit={() => {}} onClose={() => {}} />);
    expect((screen.getByText("決定") as HTMLButtonElement).disabled).toBe(true);
  });
  it("ゾーン+数字を入力して決定、⌫で消せる", () => {
    const onSubmit = vi.fn();
    render(<SeatPad title="t" onSubmit={onSubmit} onClose={() => {}} />);
    fireEvent.click(screen.getByText("A"));
    fireEvent.click(screen.getByText("1"));
    fireEvent.click(screen.getByText("2"));
    fireEvent.click(screen.getByText("⌫"));
    fireEvent.click(screen.getByText("3"));
    fireEvent.click(screen.getByText("決定"));
    expect(onSubmit).toHaveBeenCalledWith("A13");
  });
  it("Esc と背景タップで閉じる", () => {
    const onClose = vi.fn();
    const { container } = render(<SeatPad title="t" onSubmit={() => {}} onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(container.querySelector(".kds-seatpad-backdrop")!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
