import { useState } from "react";
import { Age, EmptyState, ItemControl, Notes, OrderOverlay, Workbench } from "../shared/Workbench";
import type { ViewProps } from "../shared/Workbench";
import { groupItems, progress } from "../shared/workbenchModel";
import "./MatrixView.css";

export default function MatrixView({ state, actions }: ViewProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const groups = groupItems(state.cards);
  const filtered = groups.filter((g) => `${g.item.name} ${g.item.options || ""}`.includes(query.trim()));
  return <Workbench state={state} actions={actions} name="仕込みマトリクス" eyebrow="02 / EVERY DISH, EVERY TABLE" theme="matrix">
    <div className="matrix-toolbar"><div><h2>作り漏れを、なくす。</h2><p>縦に料理、横に卓。数字は残り個数です。</p></div><label><span>料理を探す</span><input type="search" placeholder="料理名・オプション" value={query} onChange={(e) => setQuery(e.target.value)} /></label></div>
    {!state.cards.length ? <EmptyState /> : !filtered.length ? <EmptyState text="該当する料理はありません" detail="検索する言葉を変えてください。" /> : <div className="matrix-scroll" tabIndex={0} aria-label="品目と卓の一覧・左右にスクロールできます">
      <table className="matrix-table">
        <caption>品目と注文の残数一覧。同じ卓の追加注文も別の列に表示します。</caption>
        <thead><tr><th scope="col" className="matrix-corner">料理 / 残数<span>{groups.length} 種類 · {state.cards.length} 件</span></th>{state.cards.map((card) => <th scope="col" key={card.order.id}>
          <button className="matrix-table-button" onClick={() => setSelected(card.order.id)} aria-label={`${card.order.table}卓の注文詳細`}><strong>{card.order.table}<small>卓</small></strong><span>残り {progress(card).remaining} 個 ↗</span></button><Age card={card} now={state.now} /><Notes card={card} />
        </th>)}</tr></thead>
        <tbody>{filtered.map((group) => <tr key={group.key}>
          <th scope="row"><div className="matrix-dish"><strong>{group.item.name}</strong><b>{group.remaining}</b></div>
            {group.item.options && <small>{group.item.options}</small>}{group.item.allergies && <small className="wb-allergy">アレルギー: {group.item.allergies}</small>}
            {group.allergy && <small className="wb-allergy">予約アレルギー: {group.allergy}</small>}{group.request && <small>要望: {group.request}</small>}
          </th>
          {state.cards.map((card) => <td key={card.order.id}>{group.entries.filter((entry) => entry.card.order.id === card.order.id).map((entry) => <ItemControl key={entry.index} card={card} index={entry.index} actions={actions} compact />)}{!group.entries.some((entry) => entry.card.order.id === card.order.id) && <span className="matrix-absent" aria-label="注文なし">—</span>}</td>)}
        </tr>)}</tbody>
      </table>
    </div>}
    <OrderOverlay id={selected} state={state} actions={actions} onClose={() => setSelected(null)} />
  </Workbench>;
}
