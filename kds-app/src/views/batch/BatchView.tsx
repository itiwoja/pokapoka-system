import { useState } from "react";
import { Age, EmptyState, ItemControl, OrderOverlay, Workbench } from "../shared/Workbench";
import type { ViewProps } from "../shared/Workbench";
import { groupItems } from "../shared/workbenchModel";
import "./BatchView.css";

export default function BatchView({ state, actions }: ViewProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(true);
  const groups = groupItems(state.cards);
  const shown = showDone ? groups : groups.filter((group) => group.remaining > 0);
  const remaining = groups.reduce((sum, group) => sum + group.remaining, 0);
  return <Workbench state={state} actions={actions} name="まとめ調理" eyebrow="03 / COOK TOGETHER, SERVE PRECISELY" theme="batch">
    <div className="batch-intro"><div><h2>同じ料理を、ひと続きに。</h2><p>調理条件が同じ注文を集約。完了は卓ごとに記録します。</p></div><div className="batch-total"><b>{remaining}</b><span>個を調理待ち</span></div><button aria-pressed={showDone} onClick={() => setShowDone(!showDone)}>{showDone ? "✓ 完了した料理も表示" : "完了した料理を表示"}</button></div>
    {!state.cards.length ? <EmptyState /> : !shown.length ? <EmptyState text="すべての料理が揃いました" detail="完了した料理を表示すると、取り消し操作ができます。" /> : <div className="batch-grid">
      {shown.map((group, i) => <article className={`batch-group${group.remaining === 0 ? " is-complete" : ""}`} key={group.key}>
        <header className="batch-group-heading"><span className="batch-index">{String(i + 1).padStart(2, "0")}</span><div><h3>{group.item.name}</h3><p>{group.item.options || "標準の調理"}</p></div><div className="batch-remaining"><b>{group.remaining || "✓"}</b><span>{group.remaining ? "残り個数" : "全数完了"}</span></div></header>
        {(group.item.allergies || group.allergy || group.request) && <div className="batch-notes">
          {group.item.allergies && <p className="wb-allergy">アレルギー: {group.item.allergies}</p>}{group.allergy && <p className="wb-allergy">予約アレルギー: {group.allergy}</p>}{group.request && <p>要望: {group.request}</p>}
        </div>}
        <div className="batch-orders">{group.entries.map(({ card, index }) => <div className="batch-order" key={`${card.order.id}-${index}`}>
          <ItemControl card={card} index={index} actions={actions} compact showTable />
          <div className="batch-order-meta"><Age card={card} now={state.now} /><button onClick={() => setSelected(card.order.id)} aria-label={`${card.order.table}卓の注文詳細`}>詳細 ↗</button></div>
        </div>)}</div>
      </article>)}
    </div>}
    <OrderOverlay id={selected} state={state} actions={actions} onClose={() => setSelected(null)} />
  </Workbench>;
}
