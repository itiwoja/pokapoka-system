import { useState } from "react";
import type { CSSProperties } from "react";
import type { Card, OrderItem } from "../../types";
import type { KdsActions, KdsState } from "../../data/contract";
import { printSlip } from "../../print/printSlip";
import { SeatPad } from "../../components/SeatPad";
import { useLongPress } from "../../components/useLongPress";
import { peopleTotal } from "../../components/StockPanel";
import "./StoveView.css";

interface Props {
  state: KdsState;
  actions: KdsActions;
}

const SLOTS = Array.from({ length: 10 }, (_, i) => i + 1);
/** リングが1周する時間。炊き時間の目安 */
const RING_SEC = 15 * 60;
const KAMA = /釜飯|めし|飯/;

function mmss(sec: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(sec / 60))}:${pad(sec % 60)}`;
}
function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const remaining = (card: Card, i: number) => card.order.items[i].qty - (card.doneCounts[i] ?? 0);
const pendingIdx = (card: Card) => card.order.items.map((_, i) => i).filter((i) => remaining(card, i) > 0);
const isKama = (it: OrderItem) => KAMA.test(it.name);

/** 口に出す品目: 釜飯系の最初の未完了行。無ければ最初の未完了行 */
function mainIndex(card: Card): number | null {
  const p = pendingIdx(card);
  return p.find((i) => isKama(card.order.items[i])) ?? p[0] ?? null;
}

interface PopRowProps {
  item: OrderItem;
  done: number;
  onComplete: () => void;
  onUndo: () => void;
}

/* OrderCard の ItemRow と同じ挙動: 完了行タップで戻す、長押しでも戻す (#153) */
function PopRow({ item, done, onComplete, onUndo }: PopRowProps) {
  const isDone = done >= item.qty;
  const { handlers } = useLongPress({
    onTap: () => (isDone ? onUndo() : onComplete()),
    onLongPress: onUndo,
  });
  return (
    <button type="button" className={`kds-stove-item${isDone ? " kds-stove-item--done" : ""}`} {...handlers}>
      <span className="kds-stove-item-qty">{item.qty}</span>
      <span className="kds-stove-item-body">
        <span className="kds-stove-item-name">
          {item.name}
          {item.qty >= 2 && done > 0 && !isDone && <span className="kds-stove-item-prog">{done}/{item.qty}</span>}
        </span>
        {item.options && <span className="kds-stove-item-sub">{item.options}</span>}
        {item.allergies && <span className="kds-stove-item-allergy">{item.allergies}</span>}
      </span>
    </button>
  );
}

export default function StoveView({ state, actions }: Props) {
  const { cards, stock, now } = state;
  const [selected, setSelected] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [seatingRid, setSeatingRid] = useState<string | null>(null);
  const [printError, setPrintError] = useState(false);

  const sorted = [...cards].sort((a, b) => a.order.start - b.order.start);
  const byNum = new Map<number, Card>();
  for (const c of sorted) for (const k of Object.keys(c.konro)) byNum.set(Number(k), c);
  const waiting = sorted.filter((c) => !c.finishing && Object.keys(c.konro).length === 0);
  const over = cards.filter((c) => (now - c.order.start) / 60000 >= 10).length;
  const openCard = cards.find((c) => c.order.id === openId) ?? null;
  const seating = stock.find((r) => r.rid === seatingRid) ?? null;

  const onSlot = (n: number) => {
    const card = byNum.get(n);
    if (card) {
      const cur = card.konro[n];
      actions.setKonro(card.order.id, n, cur === "white" ? "red" : null);
    } else if (selected) {
      actions.setKonro(selected, n, "white");
      setSelected(null);
    }
  };

  const onPrint = async () => {
    if (!openCard) return;
    try {
      const r = await printSlip(openCard.order);
      if (r === "failed") throw new Error("failed");
      setPrintError(false);
    } catch {
      setPrintError(true);
    }
  };

  return (
    <div className="kds-stove">
      <div className="kds-stove-clock">{hhmm(now)}</div>
      <div className="kds-stove-hd">
        卓 {cards.length}　/　10分超 <b className={over > 0 ? "kds-stove-over" : ""}>{over}</b>
      </div>

      <div className="kds-stove-grid">
        {SLOTS.map((n) => {
          const card = byNum.get(n);
          if (!card) {
            return (
              <button
                key={n}
                type="button"
                className={`kds-stove-slot kds-stove-slot--empty${selected ? " kds-stove-slot--target" : ""}`}
                onClick={() => onSlot(n)}
                aria-label={`コンロ${n} 空き`}
              >
                <span className="kds-stove-num">{n}</span>
              </button>
            );
          }
          // 正確な炊き始め時刻はデータに無いので、注文からの経過で代用する (15分で1周)
          const sec = Math.max(0, Math.floor((now - card.order.start) / 1000));
          const p = Math.min(100, (sec / RING_SEC) * 100);
          const mi = mainIndex(card);
          const item = mi === null ? null : card.order.items[mi];
          const red = card.konro[n] === "red";
          return (
            <button
              key={n}
              type="button"
              className={`kds-stove-slot${red ? " kds-stove-slot--red" : ""}`}
              onClick={() => onSlot(n)}
              aria-label={`コンロ${n} ${card.order.table}卓`}
            >
              <span className="kds-stove-num">{n}</span>
              <span className="kds-stove-ring" style={{ "--p": `${p}%` } as CSSProperties}>
                <span>{mmss(sec)}</span>
              </span>
              <span className="kds-stove-what">{item?.name ?? "完了"}</span>
              <span className="kds-stove-tbl">
                {card.order.table}卓
                {item?.options && <> ・ {item.options}</>}
                {item?.allergies && <> ・ <b className="kds-stove-allergy">{item.allergies}</b></>}
              </span>
            </button>
          );
        })}
      </div>

      <div className="kds-stove-tray">
        <h2>待ち</h2>
        {waiting.length === 0 && <span className="kds-stove-none">なし</span>}
        {waiting.map((c) => {
          const mi = mainIndex(c);
          const it = mi === null ? null : c.order.items[mi];
          const left = mi === null ? 0 : remaining(c, mi);
          const sel = selected === c.order.id;
          return (
            <button
              key={c.order.id}
              type="button"
              className={`kds-stove-tok${sel ? " kds-stove-tok--sel" : ""}`}
              aria-pressed={sel}
              onClick={() => setSelected(sel ? null : c.order.id)}
            >
              {it?.name ?? "完了"}{left >= 2 ? ` ×${left}` : ""}
              <b>{c.order.table}卓{it?.options ? ` ・ ${it.options}` : ""}</b>
            </button>
          );
        })}
      </div>

      <div className="kds-stove-side">
        <div className="kds-stove-tables">
          {sorted.map((c) => {
            const p = pendingIdx(c);
            const waitKama = p.filter((i) => isKama(c.order.items[i])).reduce((s, i) => s + remaining(c, i), 0);
            const ready = p.length === 0;
            return (
              <button
                key={c.order.id}
                type="button"
                className={`kds-stove-tb${ready ? " kds-stove-tb--ready" : ""}`}
                onClick={() => setOpenId(c.order.id)}
              >
                <span className="kds-stove-tb-t">{c.order.table}</span>
                <span className="kds-stove-tb-s">
                  <b>
                    {ready
                      ? "すべて完了"
                      : p.map((i) => `${c.order.items[i].name}${remaining(c, i) >= 2 ? ` ${remaining(c, i)}` : ""}`).join(" ・ ")}
                  </b>
                  {ready ? "そろいました" : waitKama > 0 ? `炊き上がり待ち ${waitKama}` : " "}
                </span>
              </button>
            );
          })}
        </div>
        {stock.length > 0 && (
          <div className="kds-stove-rsv">
            {stock.map((r) => {
              return (
                <div key={r.rid} className="kds-stove-rsv-row">
                  <span className="kds-stove-rsv-time">{r.time}</span>
                  <span className="kds-stove-rsv-name">{r.name ?? ""}</span>
                  <span className="kds-stove-rsv-n">{peopleTotal(r)}名</span>
                  <button type="button" className="kds-stove-rsv-btn" onClick={() => setSeatingRid(r.rid)}>来店</button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {openCard && (
        <div className="kds-stove-backdrop" onClick={() => setOpenId(null)}>
          <div className="kds-stove-pop" role="dialog" aria-label={`${openCard.order.table}卓`} onClick={(e) => e.stopPropagation()}>
            <header className="kds-stove-pop-head">
              <span className="kds-stove-pop-table">{openCard.order.table}</span>
              <button type="button" className="kds-stove-btn" onClick={onPrint}>伝票</button>
              <button type="button" className="kds-stove-btn" onClick={() => setOpenId(null)}>閉じる</button>
            </header>
            {printError && <div className="kds-stove-err" role="status">印刷できませんでした</div>}
            <div className="kds-stove-pop-items">
              {openCard.order.items.map((item, i) => (
                <PopRow
                  key={i}
                  item={item}
                  done={openCard.doneCounts[i] ?? 0}
                  onComplete={() => actions.completeOne(openCard.order.id, i)}
                  onUndo={() => actions.undoOne(openCard.order.id, i)}
                />
              ))}
            </div>
          </div>
        </div>
      )}
      {seating && (
        <SeatPad
          title={`${seating.name ?? seating.time} さんの卓番`}
          onSubmit={(t) => { actions.seatReservation(seating.rid, t); setSeatingRid(null); }}
          onClose={() => setSeatingRid(null)}
        />
      )}
    </div>
  );
}
