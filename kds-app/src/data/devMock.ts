/**
 * 開発用モック (npm run dev でブリッジが無いときだけ)。
 * 呼び出し側が import.meta.env.DEV で囲むのでビルド成果物には入らない。
 */
import type { Order, Reservation } from "../types";
import { LS } from "./storage";

const MIN = 60_000;

export function buildMockOrders(now: number): Order[] {
  const o = (
    id: string, table: string, agoMin: number, items: Order["items"], type: Order["type"] = "new",
  ): Order => ({ id, table, type, start: now - agoMin * MIN, items, people: 2 });
  const it = (name: string, qty = 1, options: string | null = null, allergies: string | null = null) => ({
    name, qty, options, allergies,
  });
  return [
    o("mock-1", "3", 12, [it("鯛めし", 2, "大盛り"), it("味噌汁", 2), it("だし巻き玉子", 1, null, "卵")]),
    o("mock-2", "7", 9, [it("鶏めし", 1, "ごはん少なめ"), it("サラダ", 1, "ドレッシング抜き", "小麦")]),
    o("mock-3", "12", 6, [it("牛すき釜飯", 3), it("漬物", 3)], "reserved"),
    o("mock-4", "5", 4, [it("海鮮釜飯", 1, null, "えび・かに"), it("茶碗蒸し", 1)]),
    o("mock-5", "A2", 3, [it("きのこ釜飯", 2, "取り分け皿"), it("唐揚げ", 1)]),
    o("mock-6", "9", 1, [it("鯛めし", 1), it("味噌汁", 1), it("デザート", 1, "先出し")]),
    o("mock-7", "15", 0, [it("鶏めし", 4, "うち1つ子供用", null)]),
  ];
}

function hhmm(t: number): string {
  const d = new Date(t);
  const p = (n: number) => (n < 10 ? "0" + n : "" + n);
  return p(d.getHours()) + ":" + p(d.getMinutes());
}

export function buildMockStock(now: number): Reservation[] {
  return [
    { rid: "mock-r1", time: hhmm(now + 20 * MIN), name: "山田", adults: 4, kids: 1,
      menu: [{ name: "鯛めし", qty: 4 }, { name: "お子様セット", qty: 1 }] },
    { rid: "mock-r2", time: hhmm(now + 90 * MIN), name: "佐藤", adults: 2,
      menu: [{ name: "牛すき釜飯", qty: 2 }] },
    { rid: "mock-r3", time: hhmm(now + 150 * MIN), name: "鈴木", adults: 6,
      menu: [{ name: "海鮮釜飯", qty: 6 }] },
  ];
}

export function installDevMock(now: number = Date.now()): void {
  const w = window as { KDS_ORDERS?: Order[] };
  if (!Array.isArray(w.KDS_ORDERS) || !w.KDS_ORDERS.length) w.KDS_ORDERS = buildMockOrders(now);
  try {
    if (!localStorage.getItem(LS.stock)) localStorage.setItem(LS.stock, JSON.stringify(buildMockStock(now)));
  } catch { /* 無視 */ }
}
