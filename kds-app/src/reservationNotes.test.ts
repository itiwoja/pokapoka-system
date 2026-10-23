import { describe, expect, it } from "vitest";
import { reservationNotes } from "./reservationNotes";

describe("reservationNotes", () => {
  it("allergies 配列はアレルギーとして「、」でつなぐ", () => {
    expect(reservationNotes({ allergies: ["卵", "そば"], request: "窓側" })).toEqual({
      allergy: "卵、そば",
      request: "窓側",
    });
  });

  it("memo に書かれたアレルギーはアレルギーへ振り分け、要望には残さない", () => {
    expect(reservationNotes({ memo: "アレルギー: えび" })).toEqual({ allergy: "えび", request: "" });
    expect(reservationNotes({ memo: "食物アレルギー：小麦" })).toEqual({ allergy: "小麦", request: "" });
  });

  it("「アレルギー: なし」は表示しない (memo でも要望欄のラベル付きでも)", () => {
    expect(reservationNotes({ memo: "アレルギー: なし" })).toEqual({ allergy: "", request: "" });
    expect(reservationNotes({ request: "アレルギー: なし" })).toEqual({ allergy: "", request: "" });
    expect(reservationNotes({ memo: "アレルギー: none" })).toEqual({ allergy: "", request: "" });
  });

  it("要望のみ (memo でも request でも) は要望として出す", () => {
    expect(reservationNotes({ request: "誕生日" })).toEqual({ allergy: "", request: "誕生日" });
    expect(reservationNotes({ memo: "禁煙席希望" })).toEqual({ allergy: "", request: "禁煙席希望" });
    expect(reservationNotes({ specialRequest: "子ども椅子" })).toEqual({ allergy: "", request: "子ども椅子" });
  });

  it("アレルギーがあるときは旧 memo を要望に二重表示しない", () => {
    expect(reservationNotes({ allergyInfo: "乳", memo: "乳製品なし" })).toEqual({ allergy: "乳", request: "" });
  });

  it("どちらも無ければ空", () => {
    expect(reservationNotes({ name: "山田", adults: 2 })).toEqual({ allergy: "", request: "" });
    expect(reservationNotes(null)).toEqual({ allergy: "", request: "" });
    expect(reservationNotes(undefined)).toEqual({ allergy: "", request: "" });
  });
});
