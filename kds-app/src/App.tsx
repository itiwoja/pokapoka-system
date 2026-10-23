import { lazy, Suspense } from "react";
import { useKds } from "./data/useKds";

/*
 * 比較中のレイアウト案。?view= で切り替える (画面上に切替は出さない)。
 *   (無指定) 案0 カード型   views/cards
 *   rail     案A 伝票レール views/rail
 *   stove    案B コンロ盤   views/stove
 *   board    案C 一枚の板   views/board
 * どれかに決まったら残りのディレクトリを消す
 */
const VIEWS = {
  cards: lazy(() => import("./views/cards/CardsView")),
  rail: lazy(() => import("./views/rail/RailView")),
  stove: lazy(() => import("./views/stove/StoveView")),
  board: lazy(() => import("./views/board/BoardView")),
} as const;

function viewName(): keyof typeof VIEWS {
  try {
    const v = new URLSearchParams(location.search).get("view");
    if (v && v in VIEWS) return v as keyof typeof VIEWS;
  } catch { /* location が無い環境ではカード型 */ }
  return "cards";
}

export default function App() {
  const { state, actions } = useKds();
  const View = VIEWS[viewName()];
  return (
    <Suspense fallback={null}>
      <View state={state} actions={actions} />
    </Suspense>
  );
}
