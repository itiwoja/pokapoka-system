import { useEffect, useRef, useState } from "react";
import type { Card, OrderItem } from "../../types";
import type { KdsActions } from "../../data/contract";
import { printSlip } from "../../print/printSlip";
import { reservationNotes } from "../../reservationNotes";
import KonroPicker from "../../components/KonroPicker";
import { useLongPress } from "../../components/useLongPress";
import "./OrderCard.css";

interface Props {
  card: Card;
  now: number;
  actions: KdsActions;
  /** 他のカードが使っているコンロ番号 (Board が計算して渡す) */
  usedElsewhere?: Set<number>;
  /** 新着のカード。表示直後に一度だけ明滅させて、目の端でも気づけるようにする */
  fresh?: boolean;
}

/* 「抜き」「なし」などの打ち消しは、作ってしまってからでは戻せないので太字にする */
const NEGATION = /抜き|なし|無し|不要|入れない|ぬき|NO\b/i;

const NONE: Set<number> = new Set();

/** 経過秒を "MM:SS" にする。60分を超えても分はそのまま数える (例 75:03) */
function mmss(sec: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(sec / 60))}:${pad(sec % 60)}`;
}

function elapsedLevel(min: number): "ok" | "warn" | "alert" {
  if (min >= 10) return "alert";
  if (min >= 5) return "warn";
  return "ok";
}

interface ItemRowProps {
  item: OrderItem;
  done: number;
  onComplete: () => void;
  onUndo: () => void;
}

function ItemRow({ item, done, onComplete, onUndo }: ItemRowProps) {
  const [flash, setFlash] = useState(false);
  const isDone = done >= item.qty;
  const { pressing, handlers } = useLongPress({
    // 全数完了の行タップは1個戻す。それ以外は1個完了
    onTap: () => {
      setFlash(true);
      if (isDone) onUndo();
      else onComplete();
    },
    // 長押しで戻す (誤タップの戻し #153)
    onLongPress: onUndo,
  });
  return (
    <button
      type="button"
      className={`kds-item${isDone ? " kds-item--done" : ""}${flash ? " kds-item--flash" : ""}${pressing ? " kds-item--pressing" : ""}`}
      onAnimationEnd={(e) => { if (e.animationName.includes("flash")) setFlash(false); }}
      {...handlers}
    >
      <span className="kds-item-qty">{item.qty}</span>
      <span className="kds-item-body">
        <span className="kds-item-name">
          {item.name}
          {/* 途中まで終えた行だけ進み具合を出す。0個や全数完了では数量箱で足りる */}
          {item.qty >= 2 && done > 0 && !isDone && <span className="kds-item-progress">{done}/{item.qty}</span>}
        </span>
        {item.options && (
          <span className={`kds-item-sub${NEGATION.test(item.options) ? " kds-item-sub--strong" : ""}`}>{item.options}</span>
        )}
        {item.allergies && <span className="kds-item-allergy">{item.allergies}</span>}
      </span>
      <span className="kds-item-bar" aria-hidden="true" />
    </button>
  );
}

export default function OrderCard({ card, now, actions, usedElsewhere = NONE, fresh = false }: Props) {
  const { order } = card;
  const elapsedSec = Math.max(0, Math.floor((now - order.start) / 1000));
  const min = Math.floor(elapsedSec / 60);
  const level = elapsedLevel(min);
  const konroNums = Object.keys(card.konro).map(Number).sort((a, b) => a - b);
  // 予約から来店した注文は、予約時のアレルギー・要望を持っている (現行の order-notes と同じ扱い)
  const notes = reservationNotes(order as unknown as Record<string, unknown>);

  const [picking, setPicking] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState(false);
  const errTimer = useRef<number | null>(null);
  useEffect(() => () => { if (errTimer.current) window.clearTimeout(errTimer.current); }, []);

  const onPrint = async () => {
    setPrinting(true);
    try {
      const r = await printSlip(order);
      if (r === "busy") return; // 別のカードの印刷を送信中。失敗ではないので何も出さない
      if (r === "failed") throw new Error("failed");
    } catch {
      setPrintError(true);
      if (errTimer.current) window.clearTimeout(errTimer.current);
      errTimer.current = window.setTimeout(() => setPrintError(false), 3000);
    } finally {
      setPrinting(false);
    }
  };

  return (
    <article className={`kds-card kds-card--${level}${card.finishing ? " kds-card--finishing" : ""}${fresh ? " kds-card--fresh" : ""}`}>
      <div className="kds-card-band" />
      <header className="kds-card-head">
        <span className="kds-card-table">{order.table}</span>
        {order.type === "reserved" && <span className="kds-card-reserved">予約</span>}
        {card.finishing && <span className="kds-card-finishing">完了</span>}
        <span className="kds-card-elapsed">
          {mmss(elapsedSec)}
        </span>
      </header>
      {notes.allergy && <div className="kds-card-note kds-card-note--allergy">アレルギー: {notes.allergy}</div>}
      {notes.request && <div className="kds-card-note">要望: {notes.request}</div>}
      <div className="kds-card-items">
        {order.items.map((item, i) => (
          <ItemRow
            key={i}
            item={item}
            done={card.doneCounts[i] ?? 0}
            onComplete={() => actions.completeOne(order.id, i)}
            onUndo={() => actions.undoOne(order.id, i)}
          />
        ))}
      </div>
      {printError && <div className="kds-card-error" role="status">印刷できませんでした</div>}
      <footer className="kds-card-foot">
        <div className="kds-card-chips">
          {konroNums.map((n) => (
            <span key={n} className={`kds-chip kds-chip--${card.konro[n]}`}>{n}</span>
          ))}
        </div>
        <button type="button" className="kds-card-btn" onClick={() => setPicking(true)}>コンロ</button>
        <button type="button" className="kds-card-btn" disabled={printing} onClick={onPrint}>伝票</button>
      </footer>
      {picking && (
        <KonroPicker
          card={card}
          usedElsewhere={usedElsewhere}
          onSet={(n, s) => actions.setKonro(order.id, n, s)}
          onClose={() => setPicking(false)}
        />
      )}
    </article>
  );
}
