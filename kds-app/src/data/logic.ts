/**
 * データ層の純粋関数 (localStorage / BroadcastChannel に触らない)。
 * 現行 kds-a-grid.html の挙動を、同じ契約のまま関数に切り出したもの。
 */
import type { Card, KonroState, Order, Reservation } from "../types";

/** 品目ごとの完了個数 (kds_done_v2: id -> number[]。旧 v1 は boolean 混在) */
export type DoneMap = Record<string, unknown[]>;
/** kds_konro_v1: cardId -> { "1": "white", ... } */
export type KonroMap = Record<string, Record<string, string>>;

/** 全完了カードを残しておく時間 (undo の猶予) */
export const FINISHING_MS = 4000;

/** 画面に渡すカード (finishing を持つ Card そのもの) */
export type KdsCard = Card;

/** doneMap の1件を 0..qty へ正規化する (#153: v1 bool / v2 number / 未登録を吸収) */
export function normalizeDoneCount(v: unknown, qty: number): number {
  const q = Number(qty) || 0;
  if (v === true) return q;
  if (v === false || v == null) return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return q > 0 ? Math.min(n, q) : n;
}

function qtyOf(item: { qty?: unknown }): number {
  return Number(item.qty) || 1;
}

/** 注文1件の品目ごとの完了個数。保存が無ければ item.done (外部契約) を見る */
export function doneCountsFor(order: Order, done: DoneMap): number[] {
  const saved = done[order.id];
  return (order.items || []).map((it, i) => {
    const qty = qtyOf(it);
    if (saved) return normalizeDoneCount(saved[i], qty);
    return (it as { done?: boolean }).done ? qty : 0;
  });
}

export function isAllDone(order: Order, counts: number[]): boolean {
  const items = order.items || [];
  return items.length > 0 && items.every((it, i) => (counts[i] || 0) >= qtyOf(it));
}

/** 並び順: kds_order_v1 にある id はその順、無いものは start 昇順で末尾 (新着=末尾、作業中を動かさない) */
export function sortOrders(orders: Order[], seq: string[]): Order[] {
  const pos = new Map<string, number>();
  seq.forEach((id, i) => {
    if (!pos.has(String(id))) pos.set(String(id), i);
  });
  const known: Order[] = [];
  const fresh: Order[] = [];
  for (const o of orders) (pos.has(String(o.id)) ? known : fresh).push(o);
  known.sort((a, b) => (pos.get(String(a.id)) as number) - (pos.get(String(b.id)) as number));
  fresh.sort((a, b) => (Number(a.start) || 0) - (Number(b.start) || 0));
  return [...known, ...fresh];
}

export function konroFor(map: KonroMap, id: string): Record<number, KonroState> {
  const out: Record<number, KonroState> = {};
  const src = map[id];
  if (!src || typeof src !== "object") return out;
  for (const k of Object.keys(src)) {
    const s = src[k];
    const n = Number(k);
    if ((s === "white" || s === "red") && Number.isInteger(n)) out[n] = s;
  }
  return out;
}

export interface ComposeInput {
  orders: Order[];
  done: DoneMap;
  konro: KonroMap;
  seq: string[];
  /** 削除済み注文 id (トゥームストーン #67) */
  deleted: Record<string, unknown>;
}

export interface Composed {
  card: Omit<Card, "finishing">;
  allDone: boolean;
}

/** 注文 + 厨房状態 → カード (全完了も含む。表示可否は applyFinishing で決める) */
export function composeCards(input: ComposeInput): Composed[] {
  const live = input.orders.filter((o) => o && o.id != null && !input.deleted[String(o.id)]);
  return sortOrders(live, input.seq).map((order) => {
    const doneCounts = doneCountsFor(order, input.done);
    return {
      card: { order, doneCounts, konro: konroFor(input.konro, String(order.id)) },
      allDone: isAllDone(order, doneCounts),
    };
  });
}

/**
 * 全完了カードの猶予処理。
 * finishAt: id -> 全完了を最初に見た時刻。未完了に戻った id は消す (undo で通常に戻る)。
 * 4 秒経った全完了カードは外す (フィードに残っていても再表示しない)。
 */
export function applyFinishing(
  composed: Composed[],
  prevFinishAt: Record<string, number>,
  now: number,
  finishingMs: number = FINISHING_MS,
): { cards: KdsCard[]; finishAt: Record<string, number> } {
  const finishAt: Record<string, number> = {};
  const cards: KdsCard[] = [];
  for (const { card, allDone } of composed) {
    const id = String(card.order.id);
    if (!allDone) {
      cards.push({ ...card, finishing: false });
      continue;
    }
    const at = prevFinishAt[id] ?? now;
    finishAt[id] = at;
    if (now - at < finishingMs) cards.push({ ...card, finishing: true });
  }
  return { cards, finishAt };
}

/** 品目を1個完了にする。変化が無ければ null。戻り値は保存する配列全体と、その品目の新しい個数 */
export function completeOne(
  order: Order,
  done: DoneMap,
  index: number,
): { counts: number[]; doneCount: number } | null {
  const item = order.items?.[index];
  if (!item) return null;
  const counts = doneCountsFor(order, done);
  const qty = qtyOf(item);
  if ((counts[index] || 0) >= qty) return null;
  counts[index] = (counts[index] || 0) + 1;
  return { counts, doneCount: counts[index] };
}

/** 品目を1個未完了に戻す (0 なら null) */
export function undoOne(
  order: Order,
  done: DoneMap,
  index: number,
): { counts: number[]; doneCount: number } | null {
  const item = order.items?.[index];
  if (!item) return null;
  const counts = doneCountsFor(order, done);
  if ((counts[index] || 0) <= 0) return null;
  counts[index] = counts[index] - 1;
  return { counts, doneCount: counts[index] };
}

/** コンロの変更1件。state "skeleton" は「未使用に戻す」(現行の KONRO_DEFAULT。保存はしない) */
export interface KonroChange {
  id: string;
  num: number;
  state: KonroState | "skeleton";
}

/**
 * コンロ番号を設定する。同じ番号を別カードが使っていたらそちらは外す。
 * 戻り値の changes は BroadcastChannel に流す順 (外す側 → 設定する側)。
 */
export function assignKonro(
  map: KonroMap,
  orderId: string,
  num: number,
  state: KonroState | null,
): { map: KonroMap; changes: KonroChange[] } {
  const next: KonroMap = {};
  for (const id of Object.keys(map)) next[id] = { ...map[id] };
  const key = String(num);
  const changes: KonroChange[] = [];

  if (state !== null) {
    for (const id of Object.keys(next)) {
      if (id !== orderId && next[id][key] !== undefined) {
        delete next[id][key];
        if (!Object.keys(next[id]).length) delete next[id];
        changes.push({ id, num, state: "skeleton" });
      }
    }
    next[orderId] = { ...(next[orderId] || {}), [key]: state };
    changes.push({ id: orderId, num, state });
  } else if (next[orderId]) {
    delete next[orderId][key];
    if (!Object.keys(next[orderId]).length) delete next[orderId];
    changes.push({ id: orderId, num, state: "skeleton" });
  } else {
    changes.push({ id: orderId, num, state: "skeleton" });
  }
  return { map: next, changes };
}

/** 日付が変わったら当日データを破棄する対象か (#63)。初回 (last 無し) は破棄しない */
export function isStaleDay(last: string | null, today: string): boolean {
  return !!last && last !== today;
}

export function dayString(d: Date): string {
  const p = (n: number) => (n < 10 ? "0" + n : "" + n);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 4区分の合計 (window.PartySize があればそれを使い、無ければ同じ4区分で数える) */
export function partyTotal(r: Record<string, unknown>): number {
  const ps = (globalThis as { PartySize?: { total(r: unknown): number } }).PartySize;
  if (ps) return ps.total(r);
  return ["adults", "seniors", "children", "kids"].reduce((sum, key) => {
    const n = Number(r[key]);
    return sum + (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
  }, 0);
}

/** 予約 → 配膳カード用の注文 (現行 moveResToMain と同じ形。id は "res-<rid>") */
export function buildSeatedOrder(r: Reservation, table: string, now: number): Order {
  const x = r as Record<string, any>;
  const order = {
    id: "res-" + r.rid,
    table,
    type: "reserved" as const,
    start: now,
    people: partyTotal(x),
    adults: Number(x.adults) || 0,
    seniors: Number(x.seniors) || 0,
    children: Number(x.children) || 0,
    kids: Number(x.kids) || 0,
    allergies: x.allergies || null,
    request: x.request || null,
    memo: x.memo || null,
    items: (r.menu || []).map((m: Record<string, any>) => ({
      name: m.name,
      qty: Number(m.qty) || 1,
      options: m.options || null,
      allergies: m.allergies || m.allergy || m.allergyInfo || null,
      done: false,
    })),
  };
  return order as unknown as Order;
}

/** 接続状態: ブリッジが無ければ常に ok。あるときは注文 (orders) 経路が offline のときだけ offline */
export function connectionFrom(
  hasBridge: boolean,
  status: { channels?: Record<string, { state?: string } | undefined> } | null | undefined,
): "ok" | "offline" {
  if (!hasBridge) return "ok";
  return status?.channels?.orders?.state === "offline" ? "offline" : "ok";
}
