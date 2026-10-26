import { Suspense, useEffect, useRef, useState } from "react";
import { newViewIds, views } from "../views/registry";
import type { KdsActions, KdsState } from "../data/contract";
import { useLabData } from "./useLabData";
import "./UiLab.css";

type ViewId = typeof views[number]["id"];
type Review = { favorite: boolean; note: string };
const REVIEW_KEY = "kds_ui_lab_reviews_v1";
function loadReviews(): Partial<Record<ViewId, Review>> {
  try {
    const value = JSON.parse(localStorage.getItem(REVIEW_KEY) || "{}");
    return Object.fromEntries(views.flatMap(({ id }) => {
      const r = value?.[id];
      return r && typeof r.favorite === "boolean" && typeof r.note === "string" ? [[id, r]] : [];
    }));
  } catch { return {}; }
}

function Preview({ id, state, actions, width }: { id: ViewId; state: KdsState; actions: KdsActions; width: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.5);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setScale(entry.contentRect.width / width));
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [width]);
  const View = views.find((v) => v.id === id)!.component;
  return <div ref={ref} className="lab-preview" style={{ height: 800 * scale }}>
    <div className="lab-canvas" style={{ width, height: 800, transform: `scale(${scale})` }}>
      <Suspense fallback={<p>読み込み中…</p>}><View state={state} actions={actions} /></Suspense>
    </div>
  </div>;
}

export default function UiLab() {
  const { state, actions, reset } = useLabData(true);
  const initialIdea = views.find((v) => v.id === new URLSearchParams(location.search).get("idea"));
  const [mode, setMode] = useState<"all" | "compare" | "single">(initialIdea ? "single" : "all");
  const [collection, setCollection] = useState("new");
  const [left, setLeft] = useState<ViewId>(initialIdea?.id || "focus");
  const [right, setRight] = useState<ViewId>("matrix");
  const [count, setCount] = useState(7);
  const [inProgress, setInProgress] = useState(true);
  const [width, setWidth] = useState(1280);
  const [revision, setRevision] = useState(0);
  const [reviews, setReviews] = useState(loadReviews);
  const [saveError, setSaveError] = useState(false);
  useEffect(() => { document.title = "デシャップ UIラボ"; }, []);
  function updateReview(id: ViewId, change: Partial<Review>) {
    const next = { ...reviews, [id]: { favorite: false, note: "", ...reviews[id], ...change } };
    setReviews(next);
    try { localStorage.setItem(REVIEW_KEY, JSON.stringify(next)); setSaveError(false); }
    catch { setSaveError(true); }
  }
  const shown = mode === "all" ? views.filter((v) => collection === "all" || newViewIds.includes(v.id)) : mode === "single" ? [views.find((v) => v.id === left)!] : [views.find((v) => v.id === left)!, views.find((v) => v.id === right)!];
  const selectView = (label: string, value: ViewId, onChange: (value: ViewId) => void) => <label>{label}<select value={value} onChange={(e) => onChange(e.target.value as ViewId)}>{views.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label>;
  return <main className="ui-lab">
    <header className="lab-header"><div><span className="lab-eyebrow">POKAPOKA / DESIGN PLAYGROUND</span><h1>デシャップ UIラボ<span>{views.length} IDEAS</span></h1><p>見比べて、触って、厨房に合うかたちを探す。</p></div><span className="lab-demo">サンプルで操作体験</span></header>
    <section className="lab-toolbar" aria-label="比較設定">
      <div className="lab-modes">{([["all", "案を一覧"], ["compare", "2案を比較"], ["single", "1案を大きく"]] as const).map(([id, label]) => <button key={id} aria-pressed={mode === id} onClick={() => setMode(id)}>{label}</button>)}</div>
      {mode === "all" && <label>表示範囲<select value={collection} onChange={(e) => setCollection(e.target.value)}><option value="new">新しい5案</option><option value="all">すべての9案</option></select></label>}
      {mode !== "all" && selectView(mode === "compare" ? "左の案" : "表示する案", left, setLeft)}
      {mode === "compare" && selectView("右の案", right, setRight)}
      <label>注文シーン<select value={count} onChange={(e) => { const n = Number(e.target.value); setCount(n); reset(n, inProgress); setRevision((r) => r + 1); }}><option value={3}>落ち着いた時間・3卓</option><option value={7}>通常営業・7卓</option><option value={16}>ピーク・16卓</option><option value={0}>注文なし・0卓</option></select></label>
      <label>進捗<select value={inProgress ? "mixed" : "initial"} onChange={(e) => { const mixed = e.target.value === "mixed"; setInProgress(mixed); reset(count, mixed); setRevision((r) => r + 1); }}><option value="mixed">作業途中</option><option value="initial">完了数ゼロ</option></select></label>
      <label>想定画面<select value={width} onChange={(e) => setWidth(Number(e.target.value))}><option value={1280}>1280 × 800</option><option value={1024}>1024 × 800</option></select></label>
      <button className="lab-reset" onClick={() => { reset(count, inProgress); setRevision((r) => r + 1); }}>操作をリセット</button>
    </section>
    <p className="lab-hint">全案で同じ注文・操作結果を共有します。品目をタップして完了、もう一度／長押しで戻す。時刻は固定・完了した注文は比較用に残ります。印刷は行いません。</p>
    <div className={`lab-grid ${mode === "single" ? "lab-grid--single" : ""}`}>
      {shown.map((v, i) => <article className="lab-idea" key={`${v.id}-${i}`}>
        <div className="lab-idea-heading"><div><span className="lab-number">{String(views.indexOf(v) + 1).padStart(2, "0")}</span><h2>{v.name}</h2><span className="lab-tag">{v.tag}</span></div><button className="lab-favorite" aria-label={`${v.name}を候補にする`} aria-pressed={reviews[v.id]?.favorite || false} onClick={() => updateReview(v.id, { favorite: !reviews[v.id]?.favorite })}>{reviews[v.id]?.favorite ? "★ 候補" : "☆ 候補"}</button></div>
        <p className="lab-description">{v.description}</p>
        <Preview key={revision} id={v.id} state={state} actions={actions} width={width} />
        <div className="lab-review"><label>比較メモ<textarea rows={2} placeholder="見やすさ、操作のしやすさ、混雑時の気づき…" value={reviews[v.id]?.note || ""} onChange={(e) => updateReview(v.id, { note: e.target.value })} /></label><button onClick={() => { setLeft(v.id); setMode("single"); window.scrollTo({ top: 0, behavior: "smooth" }); }}>大きく試す ↗</button></div>
      </article>)}
    </div>
    <footer className="lab-footer" role="status">{saveError ? "メモを保存できません。このページを閉じる前に控えてください。" : "候補・メモはこのブラウザに自動保存されます。"} <span>次の案も、このラボに追加して比較できます。</span></footer>
  </main>;
}
