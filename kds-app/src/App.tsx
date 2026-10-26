import { lazy, Suspense } from "react";
import { useKds } from "./data/useKds";
import { views } from "./views/registry";

/*
 * 比較中のレイアウト案。?view= で切り替える (画面上に切替は出さない)。
 *   (無指定) 案0 カード型   views/cards
 *   rail     案A 伝票レール views/rail
 *   stove    案B コンロ盤   views/stove
 *   board    案C 一枚の板   views/board
 *   focus / matrix / batch / timeline / flow 追加5案 (views/registry.ts)
 *   lab      UIラボ（サンプルによる一覧・比較）
 */
const Lab = lazy(() => import("./lab/UiLab"));

function LiveApp() {
  const { state, actions } = useKds();
  const View = (views.find((v) => v.id === new URLSearchParams(location.search).get("view")) || views[0]).component;
  return (
    <Suspense fallback={null}>
      <View state={state} actions={actions} />
    </Suspense>
  );
}

export default function App() {
  return new URLSearchParams(location.search).get("view") === "lab"
    ? <Suspense fallback={<p>UIラボを読み込み中…</p>}><Lab /></Suspense>
    : <LiveApp />;
}
