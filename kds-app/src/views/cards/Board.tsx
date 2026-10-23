import { useMemo, useRef } from "react";
import type { Card } from "../../types";
import type { KdsActions } from "../../data/contract";
import OrderCard from "./OrderCard";
import "./Board.css";

interface Props {
  cards: Card[];
  now: number;
  actions: KdsActions;
}

export default function Board({ cards, now, actions }: Props) {
  // 一度表示した注文の id。初回表示のカードは光らせず、その後に増えたカードだけ光らせる
  const seen = useRef<Set<string> | null>(null);
  const fresh = new Set<string>();
  if (seen.current === null) {
    seen.current = new Set(cards.map((c) => c.order.id));
  } else {
    for (const c of cards) {
      if (!seen.current.has(c.order.id)) { fresh.add(c.order.id); seen.current.add(c.order.id); }
    }
  }
  // 各カードから見て「他のカードが使っているコンロ番号」を渡す (移動の目印)
  const elsewhere = useMemo(() => {
    return cards.map((c) => {
      const s = new Set<number>();
      for (const o of cards) {
        if (o === c) continue;
        for (const k of Object.keys(o.konro)) s.add(Number(k));
      }
      return s;
    });
  }, [cards]);

  if (cards.length === 0) {
    return <main className="kds-board kds-board--empty">注文はありません</main>;
  }
  return (
    <main className="kds-board">
      {cards.map((c, i) => (
        <OrderCard key={c.order.id} card={c} now={now} actions={actions} usedElsewhere={elsewhere[i]} fresh={fresh.has(c.order.id)} />
      ))}
    </main>
  );
}
