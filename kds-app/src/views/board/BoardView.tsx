import { useState } from "react";
import type { Card, OrderItem } from "../../types";
import type { KdsActions, KdsState } from "../../data/contract";
import { usePrintSlip } from "../../print/usePrintSlip";
import { reservationNotes } from "../../reservationNotes";
import { hhmm, mmss } from "../../time";
import KonroPicker from "../../components/KonroPicker";
import { SeatPad } from "../../components/SeatPad";
import { useLongPress } from "../../components/useLongPress";
import { minutesUntil, peopleTotal } from "../../components/StockPanel";
import type { Reservation } from "../../types";
import "./BoardView.css";

interface Props {
  state: KdsState;
  actions: KdsActions;
}

const LATE_MIN = 10;
const SOON_MIN = 30;
const NONE: Set<number> = new Set();

/* 品目1つ。押す動作は OrderCard の ItemRow と同じ (タップ=完了、完了行タップ・長押し=戻す #153) */
function Item({ item, done, onComplete, onUndo }: { item: OrderItem; done: number; onComplete: () => void; onUndo: () => void }) {
  const isDone = done >= item.qty;
  const { pressing, handlers } = useLongPress({
    onTap: () => (isDone ? onUndo() : onComplete()),
    onLongPress: onUndo,
  });
  return (
    <button
      type="button"
      className={`kds-bd-item${isDone ? " kds-bd-item--done" : ""}${pressing ? " kds-bd-item--pressing" : ""}`}
      {...handlers}
    >
      <i>{item.qty}</i>
      <span className="kds-bd-name">{item.name}</span>
      {item.qty >= 2 && done > 0 && !isDone && <small>{done}/{item.qty}</small>}
      {item.options && <small>{item.options}</small>}
      {item.allergies && <small className="kds-bd-al">{item.allergies}</small>}
    </button>
  );
}

function Row({ card, now, actions, usedElsewhere }: { card: Card; now: number; actions: KdsActions; usedElsewhere: Set<number> }) {
  const { order } = card;
  const sec = Math.max(0, Math.floor((now - order.start) / 1000));
  const late = Math.floor(sec / 60) >= LATE_MIN;
  const nums = Object.keys(card.konro).map(Number).sort((a, b) => a - b);
  const notes = reservationNotes(order as unknown as Record<string, unknown>);
  const [picking, setPicking] = useState(false);
  const { printing, printError, onPrint } = usePrintSlip(order);

  return (
    <div className={`kds-bd-row${late ? " late" : ""}${card.finishing ? " kds-bd-row--finishing" : ""}`} data-table={order.table}>
      <div className="kds-bd-left">
        <button type="button" className="kds-bd-table" onClick={() => setPicking(true)}>{order.table}</button>
        {nums.length > 0 && (
          <span className="kds-bd-konro">
            コンロ{" "}
            {nums.map((n, i) => (
              <span key={n} className={card.konro[n] === "red" ? "kds-bd-konro--red" : undefined}>{i > 0 && "・"}{n}</span>
            ))}
          </span>
        )}
      </div>
      <div className="kds-bd-mid">
        {(notes.allergy || notes.request) && (
          <div className="kds-bd-notes">
            {notes.allergy && <span className="kds-bd-al">アレルギー: {notes.allergy}</span>}
            {notes.request && <span>要望: {notes.request}</span>}
          </div>
        )}
        <div className="kds-bd-items">
          {order.items.map((item, i) => (
            <Item
              key={i}
              item={item}
              done={card.doneCounts[i] ?? 0}
              onComplete={() => actions.completeOne(order.id, i)}
              onUndo={() => actions.undoOne(order.id, i)}
            />
          ))}
        </div>
      </div>
      <div className="kds-bd-right">
        <span className="kds-bd-age">{mmss(sec)}</span>
        <button type="button" className="kds-bd-slip" disabled={printing} onClick={onPrint}>伝票</button>
        {printError && <span className="kds-bd-err" role="status">印刷できませんでした</span>}
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

function ReservationRow({ r, now, onSeat }: { r: Reservation; now: number; onSeat: () => void }) {
  const mu = minutesUntil(r.time, now);
  const notes = reservationNotes(r);
  return (
    <div className="kds-bd-row kds-bd-res" data-rid={r.rid}>
      <div className="kds-bd-left"><div className="kds-bd-rtime">{r.time || "--:--"}</div></div>
      <div className="kds-bd-mid">
        <div className="kds-bd-rinfo">
          <span>{r.name || "—"} {peopleTotal(r)}名</span>
          {(r.menu ?? []).map((m, i) => (
            <span key={i}><i>{Number(m.qty) || 1}</i>{m.name}</span>
          ))}
          {notes.allergy && <span className="kds-bd-al">アレルギー: {notes.allergy}</span>}
          {notes.request && <span>要望: {notes.request}</span>}
        </div>
      </div>
      <div className="kds-bd-right">
        <span className="kds-bd-soon">{mu >= 0 && mu <= SOON_MIN ? `あと${mu}分` : ""}</span>
        <button type="button" className="kds-bd-slip" onClick={onSeat}>来店</button>
      </div>
    </div>
  );
}

export default function BoardView({ state, actions }: Props) {
  const { cards, stock, now } = state;
  const [seating, setSeating] = useState<Reservation | null>(null);
  const lateCount = cards.filter((c) => (now - c.order.start) / 60000 >= LATE_MIN).length;

  return (
    <div className="kds-bd">
      <div className="kds-bd-head">
        <span className="kds-bd-clock">{hhmm(now)}</span>
        <span className="kds-bd-count">{cards.length}卓 ・ 10分超 {lateCount}</span>
      </div>
      {cards.length === 0 && <p className="kds-bd-empty">注文はありません</p>}
      {cards.map((card) => {
        const used = new Set<number>();
        for (const c of cards) if (c !== card) for (const k of Object.keys(c.konro)) used.add(Number(k));
        return <Row key={card.order.id} card={card} now={now} actions={actions} usedElsewhere={cards.length > 1 ? used : NONE} />;
      })}
      {stock.length > 0 && <div className="kds-bd-hr">予 約</div>}
      {stock.map((r) => (
        <ReservationRow key={r.rid} r={r} now={now} onSeat={() => setSeating(r)} />
      ))}
      {seating && (
        <SeatPad
          title={`${seating.time ?? ""} ${seating.name ?? ""}`.trim() || "卓番"}
          onClose={() => setSeating(null)}
          onSubmit={(table) => {
            actions.seatReservation(seating.rid, table);
            setSeating(null);
          }}
        />
      )}
    </div>
  );
}
