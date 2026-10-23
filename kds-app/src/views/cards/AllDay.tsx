import { useMemo } from "react";
import type { Card } from "../../types";
import "./AllDay.css";

interface Props {
  cards: Card[];
}

/** 進行中の全カードから、品名ごとの残り個数を集計する (完了した分と消えかけのカードは数えない) */
export function allDayTotals(cards: Card[]): { name: string; qty: number }[] {
  const totals = new Map<string, number>();
  for (const c of cards) {
    if (c.finishing) continue;
    c.order.items.forEach((item, i) => {
      const left = Math.max(0, item.qty - (c.doneCounts[i] ?? 0));
      if (left > 0) totals.set(item.name, (totals.get(item.name) ?? 0) + left);
    });
  }
  return [...totals].map(([name, qty]) => ({ name, qty })).sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name, "ja"));
}

/**
 * 品目の合計 (商用 KDS の All Day View に相当)。
 * 釜飯のように同じ品を何件分かまとめて仕込むとき、カードを数えて回らずに1つの数で読める
 */
export default function AllDay({ cards }: Props) {
  const totals = useMemo(() => allDayTotals(cards), [cards]);
  if (totals.length === 0) return null;
  return (
    <div className="kds-allday" aria-label="品目の合計">
      {totals.map((t) => (
        <span key={t.name} className="kds-allday-item">
          <b>{t.qty}</b>
          {t.name}
        </span>
      ))}
    </div>
  );
}
