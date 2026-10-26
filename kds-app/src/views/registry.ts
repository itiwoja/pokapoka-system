import { lazy } from "react";

/** 新しい案はコンポーネントと、この一覧の1行を追加する。 */
export const views = [
  { id: "cards", name: "カード型", tag: "卓ごとに把握", description: "注文をカードにまとめ、品目と進捗をひと目で確認。", component: lazy(() => import("./cards/CardsView")) },
  { id: "rail", name: "伝票レール", tag: "待ち時間を可視化", description: "古い注文ほど伝票が垂れ下がる、時間を軸にした配置。", component: lazy(() => import("./rail/RailView")) },
  { id: "stove", name: "コンロ盤", tag: "調理場所から探す", description: "10口のコンロを画面に再現し、調理中の注文を把握。", component: lazy(() => import("./stove/StoveView")) },
  { id: "board", name: "一枚の板", tag: "一覧性を優先", description: "1卓1行でコンパクトに並べ、注文全体を見渡す。", component: lazy(() => import("./board/BoardView")) },
  { id: "focus", name: "フォーカス", tag: "一卓に集中", description: "注文キューと大きな作業面。新着に選択を奪われず、一卓ずつ確実に仕上げる。", component: lazy(() => import("./focus/FocusView")) },
  { id: "matrix", name: "仕込みマトリクス", tag: "作り漏れを発見", description: "料理×卓の交差点で残数を把握。オプション・アレルギーが異なる料理は別行に表示。", component: lazy(() => import("./matrix/MatrixView")) },
  { id: "batch", name: "まとめ調理", tag: "同じ料理を集約", description: "調理条件が同じ料理の残数をまとめ、卓ごとに完了。まとめ作りと正確な配膳を両立。", component: lazy(() => import("./batch/BatchView")) },
  { id: "timeline", name: "タイムライン", tag: "時間を長さで把握", description: "受付からの経過を横棒で表示。10分の境界と品目操作を同じ視線上に配置。", component: lazy(() => import("./timeline/TimelineView")) },
  { id: "flow", name: "調理リレー", tag: "工程で連携", description: "コンロ割当・完了数から受付→調理中→仕上げを自動分類。応援が必要な工程を見つける。", component: lazy(() => import("./flow/FlowView")) },
] as const;

export const newViewIds: readonly string[] = ["focus", "matrix", "batch", "timeline", "flow"];
