import { describe, expect, it } from "vitest";
import { hhmm, mmss } from "./time";

describe("mmss", () => {
  it.each([
    [0, "00:00"], [9, "00:09"], [59, "00:59"], [60, "01:00"],
    [599, "09:59"], [600, "10:00"], [4503, "75:03"], [6000, "100:00"],
  ])("経過 %i 秒を %s と表示する", (sec, text) => {
    expect(mmss(sec)).toBe(text);
  });
});

describe("hhmm", () => {
  it.each([[0, 0], [9, 5], [12, 30], [23, 59]])("端末のローカル時刻 %i:%i をゼロ埋めする", (hour, minute) => {
    const ms = new Date(2026, 9, 25, hour, minute, 59).getTime();
    expect(hhmm(ms)).toBe(`${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
  });
});
