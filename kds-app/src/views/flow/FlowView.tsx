import { useState } from "react";
import { Age, EmptyState, ItemControl, Notes, OrderTools, Workbench } from "../shared/Workbench";
import type { ViewProps } from "../shared/Workbench";
import { flowStage, progress } from "../shared/workbenchModel";
import "./FlowView.css";

const stages = [
  { id: "queue", number: "01", name: "受付", description: "未割当・まだ完了のない注文", empty: "未着手の注文はありません" },
  { id: "cooking", number: "02", name: "調理中", description: "コンロ割当済み、または一部完了", empty: "調理中の注文はありません" },
  { id: "finish", number: "03", name: "仕上げ", description: "一部完了で残り1個、または全品完了", empty: "仕上げ待ちの注文はありません" },
] as const;

export default function FlowView({ state, actions }: ViewProps) {
  const [openTools, setOpenTools] = useState<string | null>(null);
  return <Workbench state={state} actions={actions} name="調理リレー" eyebrow="05 / FROM ORDER TO THE PASS" theme="flow"
    footer="完了数・コンロ割当から工程を自動表示 · 品目をタップで完了、完了後のタップ／長押しで戻す">
    <div className="flow-intro"><h2>厨房の流れを、ひとつに。</h2><p>受付 <span>→</span> 調理 <span>→</span> 仕上げ。次に手を貸す場所が見つかります。</p></div>
    {!state.cards.length ? <EmptyState /> : <div className="flow-lanes">
      {stages.map((stage) => {
        const cards = state.cards.filter((card) => flowStage(card) === stage.id);
        return <section key={stage.id} className={`flow-lane flow-lane--${stage.id}`} aria-label={stage.name}>
          <header className="flow-lane-heading"><div><span>{stage.number}</span><h3>{stage.name}</h3><b>{cards.length}</b></div><p>{stage.description}</p></header>
          <div className="flow-lane-list">
            {!cards.length && <div className="flow-lane-empty"><span aria-hidden="true">○</span><p>{stage.empty}</p></div>}
            {cards.map((card) => {
              const p = progress(card);
              return <article key={card.order.id} className={`flow-order${p.complete ? " is-complete" : ""}`}>
                <header><div><strong>{card.order.table}<small>卓</small></strong><span>{card.order.type === "reserved" ? "予約" : "新規"}</span></div><Age card={card} now={state.now} /></header>
                <Notes card={card} />
                <div className="flow-order-progress"><span>{p.complete ? "✓ 全品完了・取り消し可能" : `あと ${p.remaining} 個`}</span><b>{p.done} / {p.total}</b></div>
                <progress className="wb-progress" max={p.total || 1} value={p.done} aria-label={`${card.order.table}卓の完了数`} />
                <div className="flow-items">{card.order.items.map((_, index) => <ItemControl key={index} card={card} index={index} actions={actions} />)}</div>
                <button className="flow-tools-toggle" aria-expanded={openTools === card.order.id} onClick={() => setOpenTools(openTools === card.order.id ? null : card.order.id)}>
                  <span>{Object.entries(card.konro).map(([n, v]) => `${v === "red" ? "タイマー" : "コンロ"}${n}`).join(" · ") || "コンロ未割当"}</span><span>{openTools === card.order.id ? "閉じる −" : "操作 +"}</span>
                </button>
                {openTools === card.order.id && <OrderTools card={card} state={state} actions={actions} />}
              </article>;
            })}
          </div>
        </section>;
      })}
    </div>}
  </Workbench>;
}
