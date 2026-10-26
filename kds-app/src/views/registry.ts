import { lazy } from "react";

/** 新しい案はコンポーネントと、この一覧の1行を追加する。 */
export const views = [
  { id: "cards", name: "カード型", tag: "卓ごとに把握", description: "注文をカードにまとめ、品目と進捗をひと目で確認。", component: lazy(() => import("./cards/CardsView")) },
  { id: "rail", name: "伝票レール", tag: "待ち時間を可視化", description: "古い注文ほど伝票が垂れ下がる、時間を軸にした配置。", component: lazy(() => import("./rail/RailView")) },
  { id: "stove", name: "コンロ盤", tag: "調理場所から探す", description: "10口のコンロを画面に再現し、調理中の注文を把握。", component: lazy(() => import("./stove/StoveView")) },
  { id: "board", name: "一枚の板", tag: "一覧性を優先", description: "1卓1行でコンパクトに並べ、注文全体を見渡す。", component: lazy(() => import("./board/BoardView")) },
] as const;
