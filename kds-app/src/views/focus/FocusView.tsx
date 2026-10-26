import { useState } from "react";
import { Age, EmptyState, Notes, OrderDetail, Workbench } from "../shared/Workbench";
import type { ViewProps } from "../shared/Workbench";
import { isLate, progress } from "../shared/workbenchModel";
import "./FocusView.css";

export default function FocusView({ state, actions }: ViewProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [lateOnly, setLateOnly] = useState(false);
  const visible = lateOnly ? state.cards.filter((card) => isLate(card, state.now)) : state.cards;
  // 新着で選択を奪わず、選択中の注文が消えたときだけ次へ進む。
  const current = visible.find((card) => card.order.id === selected) ?? visible[0];
  return <Workbench state={state} actions={actions} name="フォーカス" eyebrow="01 / ONE TABLE, ONE MOMENT" theme="focus">
    <div className="focus-layout">
      <aside className="focus-queue" aria-label="注文キュー">
        <div className="focus-queue-heading"><h2>次の一卓へ。</h2><span>{visible.length} 件</span></div>
        <div className="focus-filters"><button aria-pressed={!lateOnly} onClick={() => setLateOnly(false)}>すべて</button><button aria-pressed={lateOnly} onClick={() => setLateOnly(true)}>10分以上</button></div>
        <div className="focus-queue-list">
          {visible.map((card, i) => {
            const p = progress(card);
            return <button key={card.order.id} className={`focus-ticket${current?.order.id === card.order.id ? " is-selected" : ""}`} aria-pressed={current?.order.id === card.order.id} onClick={() => setSelected(card.order.id)}>
              <span className="focus-ticket-top"><span className="focus-sequence">{String(i + 1).padStart(2, "0")}</span><strong>{card.order.table}<small>卓</small></strong><Age card={card} now={state.now} /></span>
              <span className="focus-ticket-bottom"><span>{card.order.type === "reserved" ? "予約" : "新規"} · 残り {p.remaining} 個</span><span>{current?.order.id === card.order.id ? "作業中 →" : "開く ↗"}</span></span>
              <Notes card={card} includeItems />
            </button>;
          })}
          {!visible.length && <p className="focus-no-results">{lateOnly ? "10分以上の注文はありません" : "注文を待っています"}</p>}
        </div>
      </aside>
      <main className="focus-desk">
        {current ? <><div className="focus-desk-caption"><span>いま、ここに集中</span><span>FOCUS ON THIS TABLE</span></div><OrderDetail key={current.order.id} card={current} state={state} actions={actions} /></> : <EmptyState text={lateOnly ? "10分以上の注文はありません" : "注文はありません"} detail={lateOnly ? "「すべて」で他の注文を確認できます。" : undefined} />}
      </main>
    </div>
  </Workbench>;
}
