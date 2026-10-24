import { useState } from "react";
import type { Card, OrderItem, Reservation } from "../../types";
import type { KdsActions, KdsState } from "../../data/contract";
import { printSlip } from "../../print/printSlip";
import { reservationNotes } from "../../reservationNotes";
import KonroPicker from "../../components/KonroPicker";
import { SeatPad } from "../../components/SeatPad";
import { peopleTotal } from "../../components/StockPanel";
import { useLongPress } from "../../components/useLongPress";
import "./RailView.css";

/** 10分の位置 (px)。赤い点線と伝票の上端がここで重なる */
export const LINE10_PX = 420;
/** 垂れ下がりの最大 (px)。画面内に収める */
export const MAX_DROP_PX = 470;

/** 経過ミリ秒から伝票の垂れ下がり量を出す。0分でレール直下、10分で点線 */
export function dropPx(elapsedMs: number): number {
  const min = Math.max(0, elapsedMs) / 60000;
  return Math.min(MAX_DROP_PX, Math.round((min / 10) * LINE10_PX));
}

function mmss(sec: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(sec / 60))}:${pad(sec % 60)}`;
}

function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function Row({ item, done, onComplete, onUndo }: { item: OrderItem; done: number; onComplete(): void; onUndo(): void }) {
  const isDone = done >= item.qty;
  const { pressing, handlers } = useLongPress({
    onTap: () => (isDone ? onUndo() : onComplete()),
    onLongPress: onUndo, // 誤タップの戻し (#153)
  });
  return (
    <button type="button" className={`kds-rail-it${isDone ? " done" : ""}${pressing ? " pressing" : ""}`} {...handlers}>
      <span className="kds-rail-q">{item.qty}</span>
      {item.name}
      {item.qty >= 2 && done > 0 && !isDone && <span className="kds-rail-prog"> {done}/{item.qty}</span>}
      {item.options && <small>{item.options}</small>}
      {item.allergies && <small className="al">{item.allergies}</small>}
    </button>
  );
}

function Strip({ card, now, actions, usedElsewhere }: { card: Card; now: number; actions: KdsActions; usedElsewhere: Set<number> }) {
  const { order } = card;
  const [picking, setPicking] = useState(false);
  const elapsed = Math.max(0, now - order.start);
  const nums = Object.keys(card.konro).map(Number).sort((a, b) => a - b);
  const notes = reservationNotes(order as unknown as Record<string, unknown>);
  return (
    <div
      className={`kds-rail-strip${card.finishing ? " finishing" : ""}`}
      style={{ marginTop: dropPx(elapsed) }}
      data-testid="rail-strip"
    >
      {nums.length > 0 && (
        <button type="button" className="kds-rail-k" aria-label="コンロ番号" onClick={() => setPicking(true)}>
          {nums.join(" ")}
        </button>
      )}
      <div className="kds-rail-t">{order.table}</div>
      <div className="kds-rail-age">{mmss(Math.floor(elapsed / 1000))}</div>
      {notes.allergy && <div className="kds-rail-note al">アレルギー: {notes.allergy}</div>}
      {notes.request && <div className="kds-rail-note">要望: {notes.request}</div>}
      {order.items.map((item, i) => (
        <Row
          key={i}
          item={item}
          done={card.doneCounts[i] ?? 0}
          onComplete={() => actions.completeOne(order.id, i)}
          onUndo={() => actions.undoOne(order.id, i)}
        />
      ))}
      <div className="kds-rail-foot">
        {nums.length === 0 && (
          <button type="button" className="kds-rail-mini" onClick={() => setPicking(true)}>コンロ</button>
        )}
        <button type="button" className="kds-rail-mini" onClick={() => { void printSlip(order).catch(() => undefined); }}>伝票</button>
      </div>
      {picking && (
        <KonroPicker
          card={card}
          usedElsewhere={usedElsewhere}
          onSet={(n, s) => actions.setKonro(order.id, n, s)}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}

function ResStrip({ r, onSeat }: { r: Reservation; onSeat(r: Reservation): void }) {
  const notes = reservationNotes(r);
  return (
    <div className="kds-rail-strip res">
      <div className="kds-rail-t">{r.time || "--:--"}</div>
      <div className="kds-rail-age">{r.name || "—"} {peopleTotal(r)}名</div>
      {(r.menu ?? []).map((m, i) => (
        <div key={i} className="kds-rail-it static"><span className="kds-rail-q">{Number(m.qty) || 1}</span>{m.name}</div>
      ))}
      {notes.allergy && <div className="kds-rail-note al">アレルギー: {notes.allergy}</div>}
      {notes.request && <div className="kds-rail-note">要望: {notes.request}</div>}
      <div className="kds-rail-foot">
        <button type="button" className="kds-rail-mini" onClick={() => onSeat(r)}>来店</button>
      </div>
    </div>
  );
}

export default function RailView({ state, actions }: { state: KdsState; actions: KdsActions }) {
  const { cards, stock, now } = state;
  const [seating, setSeating] = useState<Reservation | null>(null);
  const usedBy = (id: string) => {
    const s = new Set<number>();
    for (const c of cards) if (c.order.id !== id) Object.keys(c.konro).forEach((n) => s.add(Number(n)));
    return s;
  };
  return (
    <div className="kds-rail-view">
      <div className="kds-rail-clock">{hhmm(now)}</div>
      <div className="kds-rail-bar" />
      <div className="kds-rail-stage">
        <div className="kds-rail-line10" style={{ top: LINE10_PX }}><span>10分</span></div>
        {cards.length === 0 && <div className="kds-rail-empty">注文はありません</div>}
        <div className="kds-rail-strips">
          {cards.map((c) => (
            <Strip key={c.order.id} card={c} now={now} actions={actions} usedElsewhere={usedBy(c.order.id)} />
          ))}
          <div className="kds-rail-spacer" />
          {stock.map((r) => <ResStrip key={r.rid} r={r} onSeat={setSeating} />)}
        </div>
      </div>
      {seating && (
        <SeatPad
          title={`${seating.time ?? ""} ${seating.name ?? ""}`.trim() || "卓番"}
          onClose={() => setSeating(null)}
          onSubmit={(table) => { actions.seatReservation(seating.rid, table); setSeating(null); }}
        />
      )}
    </div>
  );
}
