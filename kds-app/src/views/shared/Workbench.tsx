import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Card } from "../../types";
import type { KdsActions, KdsState } from "../../data/contract";
import { StockPanel } from "../../components/StockPanel";
import { useLongPress } from "../../components/useLongPress";
import { printSlip } from "../../print/printSlip";
import { clock, duration, elapsed, isLate, orderNotes, progress } from "./workbenchModel";
import "./Workbench.css";

export interface ViewProps { state: KdsState; actions: KdsActions }

export function Workbench({ state, actions, name, eyebrow, theme, children, footer }: ViewProps & {
  name: string; eyebrow: string; theme: string; children: ReactNode; footer?: ReactNode;
}) {
  const [reservations, setReservations] = useState(false);
  const active = state.cards.filter((card) => !progress(card).complete);
  const late = active.filter((card) => isLate(card, state.now)).length;
  return <section className={`kds-workbench wb-${theme}`} aria-label={name}>
    <header className="wb-header">
      <div className="wb-brand"><span className="wb-mark" aria-hidden="true">ぽ</span><div><span className="wb-eyebrow">{eyebrow}</span><h1>{name}</h1></div></div>
      <div className="wb-metrics"><span><b>{active.length}</b> 件対応中</span><span className={late ? "wb-late-text" : ""}><b>{late}</b> 件10分以上</span></div>
      <button className="wb-reservations" onClick={() => setReservations(true)}>予約 <b>{state.stock.length}</b><span>組 ↗</span></button>
      <time className="wb-clock">{clock(state.now)}</time>
    </header>
    {state.connection === "offline" && <div className="wb-offline" role="status">接続が切れています — 新しい注文を受信できません</div>}
    <div className="wb-content">{children}</div>
    <footer className="wb-footer"><span>{footer || "品目をタップで1個完了 · 完了後のタップ／長押しで1個戻す"}</span><span>土鍋飯 ぽかぽか</span></footer>
    {reservations && <Overlay title="本日の予約" onClose={() => setReservations(false)}>
      <StockPanel stock={state.stock} now={state.now} onSeat={actions.seatReservation} />
    </Overlay>}
  </section>;
}

/** プレビュー内でも閉じ込められるローカルダイアログ。TabとEscapeに対応。 */
export function Overlay({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  return <div className="wb-overlay" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="wb-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={ref} onKeyDown={(event) => {
      // SeatPad自身のEscape処理に任せ、親まで同時に閉じない。
      if ((event.target as HTMLElement).closest(".kds-seatpad")) return;
      if (event.key === "Escape") { event.stopPropagation(); onClose(); }
      if (event.key === "Tab") {
        const nodes = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, textarea, [tabindex="0"]') ?? []);
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === ref.current)) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <div className="wb-dialog-heading"><h2 id={titleId}>{title}</h2><button onClick={onClose} aria-label={`${title}を閉じる`}>閉じる ×</button></div>
      <div className="wb-dialog-body">{children}</div>
    </div>
  </div>;
}

export function EmptyState({ text = "注文はありません", detail = "新しい注文が入ると、ここに表示されます。" }: { text?: string; detail?: string }) {
  return <div className="wb-empty"><span aria-hidden="true">◎</span><h2>{text}</h2><p>{detail}</p></div>;
}

export function Age({ card, now }: { card: Card; now: number }) {
  const complete = progress(card).complete;
  return <span className={`wb-age${isLate(card, now) ? " is-late" : ""}${complete ? " is-complete" : ""}`}>
    {complete ? "✓ 全品完了" : <>{isLate(card, now) && <small>10分以上 </small>}{duration(elapsed(card, now))}</>}
  </span>;
}

export function Notes({ card, includeItems = false }: { card: Card; includeItems?: boolean }) {
  const notes = orderNotes(card.order);
  const itemNotes = includeItems ? card.order.items.filter((item) => item.allergies || item.options) : [];
  if (!notes.allergy && !notes.request && !itemNotes.length) return null;
  return <div className="wb-notes">
    {notes.allergy && <p className="wb-allergy">アレルギー: {notes.allergy}</p>}
    {notes.request && <p>要望: {notes.request}</p>}
    {itemNotes.map((item, i) => <p key={i}>{item.name}: {item.options}{item.allergies && <strong className="wb-allergy"> アレルギー: {item.allergies}</strong>}</p>)}
  </div>;
}

export function ItemControl({ card, index, actions, compact = false, showTable = false }: {
  card: Card; index: number; actions: KdsActions; compact?: boolean; showTable?: boolean;
}) {
  const item = card.order.items[index];
  const done = card.doneCounts[index] ?? 0;
  const complete = done >= item.qty;
  const { pressing, handlers } = useLongPress({
    onTap: () => complete ? actions.undoOne(card.order.id, index) : actions.completeOne(card.order.id, index),
    onLongPress: () => actions.undoOne(card.order.id, index),
  });
  return <button type="button" {...handlers}
    className={`wb-item${compact ? " wb-item--compact" : ""}${complete ? " is-done" : ""}${pressing ? " is-pressing" : ""}`}
    aria-label={`${card.order.table}卓 ${item.name}${item.options ? ` ${item.options}` : ""} ${done}/${item.qty}個完了・${complete ? "1個戻す" : "1個完了"}`}>
    {showTable && <b className="wb-item-table">{card.order.table}<small>卓</small></b>}
    {!compact && <span className="wb-item-copy"><strong>{item.name}</strong>{item.options && <small>{item.options}</small>}{item.allergies && <small className="wb-allergy">アレルギー: {item.allergies}</small>}</span>}
    <span className="wb-item-count"><b>{complete ? "✓" : item.qty - done}</b><small>{complete ? "戻す" : "残り"}</small></span>
    <span className="wb-item-fraction">{done}/{item.qty}</span>
  </button>;
}

export function OrderTools({ card, state, actions }: ViewProps & { card: Card }) {
  const [picking, setPicking] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState("");
  const lab = new URLSearchParams(location.search).get("view") === "lab";
  const used = new Set(state.cards.filter((c) => c.order.id !== card.order.id).flatMap((c) => Object.keys(c.konro).map(Number)));
  const assigned = Object.entries(card.konro).map(([n, value]) => `${value === "red" ? "タイマー" : "コンロ"}${n}`).join("・");
  async function print() {
    setPrinting(true); setPrintError("");
    try { if (await printSlip(card.order) === "failed") setPrintError("印刷できませんでした。もう一度お試しください。"); }
    catch { setPrintError("印刷できませんでした。もう一度お試しください。"); }
    finally { setPrinting(false); }
  }
  return <div className="wb-tools">
    <div className="wb-tool-buttons"><button aria-expanded={picking} onClick={() => setPicking(!picking)}>{assigned || "コンロ未割当"}<span> {picking ? "−" : "+"}</span></button>
      <button disabled={printing || lab} title={lab ? "UIラボでは印刷しません" : undefined} onClick={print}>{printing ? "印刷中…" : "伝票印刷"}</button></div>
    {printError && <p role="status">{printError}</p>}
    {picking && <fieldset className="wb-konro"><legend>コンロ → タイマー → 解除の順に切替</legend><div>
      {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => {
        const value = card.konro[n];
        const occupied = !value && used.has(n);
        return <button key={n} disabled={occupied} className={value ? `is-${value}` : ""}
          aria-label={`${n}番 ${occupied ? "他卓使用中" : value === "red" ? "タイマー・解除する" : value === "white" ? "コンロ・タイマーにする" : "空き・割り当てる"}`}
          onClick={() => actions.setKonro(card.order.id, n, value === "white" ? "red" : value === "red" ? null : "white")}>
          <b>{n}</b><small>{occupied ? "使用中" : value === "red" ? "タイマー" : value === "white" ? "コンロ" : "空き"}</small>
        </button>;
      })}
    </div></fieldset>}
  </div>;
}

export function OrderDetail({ card, state, actions }: ViewProps & { card: Card }) {
  const p = progress(card);
  return <div className="wb-order-detail">
    <header className="wb-order-heading"><div><span className="wb-eyebrow">{card.order.type === "reserved" ? "予約の注文" : "新規の注文"} · 受付 {clock(card.order.start)}</span><h2>{card.order.table}<small>卓</small></h2></div><Age card={card} now={state.now} /></header>
    <Notes card={card} />
    <div className="wb-progress-label"><span>{p.complete ? "全品完了 · 品目を押すと戻せます" : `あと ${p.remaining} 個で、この注文が揃います`}</span><b>{p.done} / {p.total}</b></div>
    <progress className="wb-progress" max={p.total || 1} value={p.done} aria-label={`${card.order.table}卓の完了数`} />
    <div className="wb-item-list">{card.order.items.map((_, index) => <ItemControl key={index} card={card} index={index} actions={actions} />)}</div>
    <OrderTools card={card} state={state} actions={actions} />
  </div>;
}

export function OrderOverlay({ id, state, actions, onClose }: ViewProps & { id: string | null; onClose(): void }) {
  const card = state.cards.find((c) => c.order.id === id);
  if (!id) return null;
  return <Overlay title={card ? `${card.order.table}卓の注文` : "注文の完了"} onClose={onClose}>
    {card ? <OrderDetail key={card.order.id} card={card} state={state} actions={actions} /> : <EmptyState text="この注文は表示を終了しました" detail="注文一覧から次の注文を選んでください。" />}
  </Overlay>;
}
