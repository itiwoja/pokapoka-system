import type { Card, Order, OrderItem } from "../../types";
import { reservationNotes } from "../../reservationNotes";

export function orderNotes(order: Order) {
  return reservationNotes(order as unknown as Record<string, unknown>);
}

export function progress(card: Card) {
  const total = card.order.items.reduce((sum, item) => sum + item.qty, 0);
  const done = card.order.items.reduce((sum, item, i) => sum + Math.min(item.qty, card.doneCounts[i] ?? 0), 0);
  return { total, done, remaining: total - done, complete: total > 0 && done === total };
}

export function elapsed(card: Card, now: number) {
  return Math.max(0, Math.floor((now - card.order.start) / 1000));
}

export function isLate(card: Card, now: number) {
  return !progress(card).complete && elapsed(card, now) >= 600;
}

export function clock(now: number) {
  const d = new Date(now);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function duration(seconds: number) {
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export interface ItemEntry { card: Card; item: OrderItem; index: number }
export interface ItemGroup { key: string; item: OrderItem; allergy: string; request: string; entries: ItemEntry[]; remaining: number }

/** 調理条件と予約全体の注意事項が一致するものだけ集約。元の品目indexは必ず保持する。 */
export function groupItems(cards: Card[]): ItemGroup[] {
  const groups = new Map<string, ItemGroup>();
  for (const card of cards) {
    const { allergy, request } = orderNotes(card.order);
    card.order.items.forEach((item, index) => {
      const key = JSON.stringify([item.name, item.options || "", item.allergies || "", allergy, request]);
      const group = groups.get(key) ?? { key, item, allergy, request, entries: [], remaining: 0 };
      group.entries.push({ card, item, index });
      group.remaining += Math.max(0, item.qty - (card.doneCounts[index] ?? 0));
      groups.set(key, group);
    });
  }
  return [...groups.values()];
}

export type FlowStage = "queue" | "cooking" | "finish";
export function flowStage(card: Card): FlowStage {
  const p = progress(card);
  if (p.complete || (p.done > 0 && p.remaining === 1)) return "finish";
  return p.done > 0 || Object.keys(card.konro).length > 0 ? "cooking" : "queue";
}
