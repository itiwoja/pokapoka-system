import { useState } from "react";
import type { CSSProperties } from "react";
import { Age, EmptyState, ItemControl, Notes, OrderTools, Workbench } from "../shared/Workbench";
import type { ViewProps } from "../shared/Workbench";
import { elapsed, isLate, progress } from "../shared/workbenchModel";
import "./TimelineView.css";

export default function TimelineView({ state, actions }: ViewProps) {
  const [oldestFirst, setOldestFirst] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const cards = oldestFirst ? [...state.cards].sort((a, b) => a.order.start - b.order.start) : state.cards;
  const maxMinutes = Math.max(15, Math.ceil(Math.max(0, ...cards.map((card) => elapsed(card, state.now) / 60)) / 5) * 5);
  const ticks = Array.from({ length: 4 }, (_, i) => Math.round(maxMinutes * i / 3));
  return <Workbench state={state} actions={actions} name="タイムライン" eyebrow="04 / TIME MADE VISIBLE" theme="timeline">
    <div className="timeline-toolbar"><div><h2>待ち時間を、見渡す。</h2><p>線の長さは受付からの経過時間。赤い境界は10分です。</p></div><button aria-pressed={oldestFirst} onClick={() => setOldestFirst(!oldestFirst)}>{oldestFirst ? "経過が長い順 ↓" : "配膳順 ↓"}</button></div>
    {!cards.length ? <EmptyState /> : <div className="timeline-scroll">
      <div className="timeline-board" style={{ "--timeline-threshold": `${10 / maxMinutes * 100}%` } as CSSProperties}>
        <div className="timeline-ruler"><span>卓 / 経過</span><div>{ticks.map((n) => <span key={n} style={{ left: `${n / maxMinutes * 100}%` }}>{n}分</span>)}<b style={{ left: "var(--timeline-threshold)" }}>10分</b></div><span>料理をタップして完了</span></div>
        {cards.map((card) => {
          const p = progress(card);
          const late = isLate(card, state.now);
          const open = expanded === card.order.id;
          return <article className={`timeline-row${late ? " is-late" : ""}${p.complete ? " is-complete" : ""}`} key={card.order.id}>
            <div className="timeline-order"><button aria-expanded={open} aria-label={`${card.order.table}卓のコンロ操作`} onClick={() => setExpanded(open ? null : card.order.id)}><strong>{card.order.table}<small>卓</small></strong><span>{card.order.type === "reserved" ? "予約" : "新規"} {open ? "−" : "+"}</span></button><Age card={card} now={state.now} /></div>
            <div className="timeline-plot"><div className="timeline-track"><span style={{ width: `${Math.max(1, elapsed(card, state.now) / 60 / maxMinutes * 100)}%` }}><i /></span></div><div className="timeline-progress"><span>{p.complete ? "すべて揃いました" : `残り ${p.remaining} 個`}</span><b>{p.done}/{p.total}</b></div><Notes card={card} /></div>
            <div className="timeline-items">{card.order.items.map((_, index) => <ItemControl key={index} card={card} index={index} actions={actions} />)}</div>
            {open && <div className="timeline-tools"><OrderTools card={card} state={state} actions={actions} /></div>}
          </article>;
        })}
      </div>
    </div>}
  </Workbench>;
}
