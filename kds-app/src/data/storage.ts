/**
 * localStorage の読み書き (現行 kds-a-grid.html と同じキー・同じ形)。
 * 容量超過・private モードなどで例外が出ても画面を止めない。
 */
import { dayString, isStaleDay, type DoneMap, type KonroMap } from "./logic";
import type { Order, Reservation } from "../types";

export const LS = {
  done: "kds_done_v2",
  doneV1: "kds_done_v1",
  konro: "kds_konro_v1",
  order: "kds_order_v1",
  stock: "kds_stock_v1",
  locked: "kds_locked_v1",
  day: "kds_day_v1",
  deleted: "kds_deleted_v1",
  bridgeSeen: "kds_bridge_seen_v1",
  riceCue: "kds_rice_cue_v1",
  tableOverride: "kds_table_override_v1",
  hallReady: "kds_hall_ready_v1",
  slipPrinted: "kds_slip_printed_v1",
  serveCue: "kds_serve_cue_v1",
} as const;

/** 日付が変わったら捨てる当日データ (現行 purgeStaleDay と同じ一覧 #63/#172) */
export const DAILY_KEYS: string[] = [
  LS.stock, LS.done, LS.doneV1, LS.order, LS.konro, LS.locked, LS.deleted,
  LS.bridgeSeen, LS.riceCue, LS.tableOverride, LS.hallReady, LS.slipPrinted, LS.serveCue,
];

function read(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 容量超過などは黙って諦める。画面はメモリ上の状態で動き続ける */
  }
}

function isObject(v: unknown): v is Record<string, any> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export function loadDone(): DoneMap {
  const v2 = read(LS.done);
  if (isObject(v2)) return v2 as DoneMap;
  const v1 = read(LS.doneV1);
  return isObject(v1) ? (v1 as DoneMap) : {};
}
export function saveDone(map: DoneMap): void { write(LS.done, map); }

export function loadKonro(): KonroMap {
  const v = read(LS.konro);
  return isObject(v) ? (v as KonroMap) : {};
}
export function saveKonro(map: KonroMap): void { write(LS.konro, map); }

export function loadOrderSeq(): string[] {
  const v = read(LS.order);
  return Array.isArray(v) ? v.map(String) : [];
}
export function saveOrderSeq(seq: string[]): void { write(LS.order, seq); }

export function loadStock(): Reservation[] {
  const v = read(LS.stock);
  return Array.isArray(v) ? v.filter((r) => r && r.rid != null) : [];
}
export function saveStock(stock: Reservation[]): void { write(LS.stock, stock); }

export function loadDeleted(): Record<string, unknown> {
  const v = read(LS.deleted);
  return isObject(v) ? v : {};
}
export function saveDeleted(map: Record<string, unknown>): void { write(LS.deleted, map); }

/** 日付が変わっていたら当日データを破棄し、今日を記録する。破棄したら true */
export function purgeStaleDay(now: Date = new Date()): boolean {
  const today = dayString(now);
  let purged = false;
  try {
    const last = localStorage.getItem(LS.day);
    if (isStaleDay(last, today)) {
      DAILY_KEYS.forEach((k) => localStorage.removeItem(k));
      purged = true;
    }
    localStorage.setItem(LS.day, today);
  } catch {
    /* 無視 */
  }
  return purged;
}

/** window.KDS_ORDERS (注文フィード)。無ければ空 */
export function readOrders(): Order[] {
  const v = (window as { KDS_ORDERS?: unknown }).KDS_ORDERS;
  return Array.isArray(v) ? (v as Order[]) : [];
}

/** window.KDS_ORDERS に注文を投入する (重複は上書き。現行 ensureOrderInBus) */
export function putOrder(order: Order): void {
  const w = window as { KDS_ORDERS?: Order[] };
  if (!Array.isArray(w.KDS_ORDERS)) w.KDS_ORDERS = [];
  const i = w.KDS_ORDERS.findIndex((o) => String(o.id) === String(order.id));
  if (i >= 0) w.KDS_ORDERS[i] = order;
  else w.KDS_ORDERS.push(order);
}
