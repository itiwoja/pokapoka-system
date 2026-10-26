import { useState } from "react";
import { buildMockOrders, buildMockStock } from "../data/devMock";
import { buildSeatedOrder } from "../data/logic";
import type { KdsActions, KdsState } from "../data/contract";

export function sampleState(count: number, inProgress = false): KdsState {
  const now = new Date(2026, 9, 26, 12, 30).getTime();
  const samples = buildMockOrders(now);
  return {
    now, connection: "ok", stock: buildMockStock(now),
    cards: Array.from({ length: count }, (_, i) => ({
      order: { ...samples[i % samples.length], id: `lab-${i}`, table: String(i + 1) },
      doneCounts: samples[i % samples.length].items.map((item, index, items) => !inProgress || i % 3 === 0 ? 0
        : i % 3 === 2 ? item.qty - (index === items.length - 1 ? 1 : 0)
        : index === 0 ? Math.max(0, item.qty - 1) : 0),
      konro: i < 10 && (!inProgress || i % 3 !== 0) ? { [i + 1]: "white" as const } : {}, finishing: false,
    })),
  };
}

export function useLabData(initialProgress = false) {
  const [state, setState] = useState(() => sampleState(7, initialProgress));
  const changeDone = (id: string, index: number, delta: number) => setState((s) => ({
    ...s, cards: s.cards.map((c) => c.order.id !== id ? c : {
      ...c, doneCounts: c.doneCounts.map((n, i) => i === index ? Math.max(0, Math.min(c.order.items[i].qty, n + delta)) : n),
    }),
  }));
  const actions: KdsActions = {
    completeOne: (id, index) => changeDone(id, index, 1),
    undoOne: (id, index) => changeDone(id, index, -1),
    setKonro: (id, num, value) => setState((s) => ({ ...s, cards: s.cards.map((c) => {
      const konro = { ...c.konro };
      delete konro[num];
      if (c.order.id === id && value) konro[num] = value;
      return { ...c, konro };
    }) })),
    seatReservation: (rid, table) => setState((s) => {
      const reservation = s.stock.find((r) => r.rid === rid);
      if (!reservation || !table.trim()) return s;
      const order = buildSeatedOrder(reservation, table, s.now);
      return { ...s, stock: s.stock.filter((r) => r.rid !== rid), cards: [...s.cards, {
        order, doneCounts: order.items.map(() => 0), konro: {}, finishing: false,
      }] };
    }),
  };
  return { state, actions, reset: (count: number, inProgress = initialProgress) => setState(sampleState(count, inProgress)) };
}
