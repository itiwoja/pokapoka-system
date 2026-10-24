import type { Order, OrderItem } from "../types";

/**
 * 伝票(チビ伝)の印刷。現行 kds-a-grid.html の printSlip と同じ経路:
 *   1. サーバー保存の書式を取り直す (#230: 直した書式を次の1枚から反映)
 *   2. 自由配置レイアウト(window.SlipRenderer)があれば canvas を1bit画像にして、なければテキストの job を作る
 *   3. POST /api/print (IP 未設定ならサーバー保存のIPに任せる)
 *   4. 失敗したら window.print の簡易伝票 (#144)
 * プレビューは出さない (#224)。連打による重複印字は busy フラグで防ぐ (#176)。
 */

const LS_PRINTER_IP = "kds_printer_ip_v1";
const LS_SLIP_STYLE = "slip_style_designer_v1";
const LS_EMULATION = "kds_printer_emulation_v1";
const STORE_NAME = "土鍋飯ぽかぽか";

interface SlipTemplate {
  paperWidth?: number;
  feedLines?: number;
  [k: string]: unknown;
}
interface SlipRendererApi {
  isTemplate(st: unknown): boolean;
  normalizeTemplate(st: unknown): SlipTemplate;
  renderToCanvas(canvas: HTMLCanvasElement, tpl: SlipTemplate, order: unknown): void;
  canvasToRaster(canvas: HTMLCanvasElement): unknown;
}
type SlipStyle = Record<string, unknown>;
interface SlipItem { name: string; qty: number; note: string }

let busy = false;

function renderer(): SlipRendererApi | undefined {
  return (window as unknown as { SlipRenderer?: SlipRendererApi }).SlipRenderer;
}

function lsGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function loadSlipStyle(): SlipStyle | null {
  try {
    const raw = lsGet(LS_SLIP_STYLE);
    if (!raw) return null;
    const st = JSON.parse(raw);
    return st && typeof st === "object" ? (st as SlipStyle) : null;
  } catch { return null; }
}

/** サーバー保存の書式が正。取れなければ localStorage のまま進める */
async function refreshSlipStyle(): Promise<void> {
  try {
    const res = await fetch("/api/slip-style");
    if (!res.ok) return;
    const st = await res.json();
    if (!st || typeof st !== "object" || Object.keys(st).length === 0) return;
    try { localStorage.setItem(LS_SLIP_STYLE, JSON.stringify(st)); } catch { /* 保存できなくても印刷は続ける */ }
  } catch { /* サーバー未経由では localStorage の書式で動く */ }
}

function emulation(): string {
  const saved = lsGet(LS_EMULATION);
  return saved === "starprnt" || saved === "starline" || saved === "escpos" ? saved : "starprnt";
}

function noteText(v: unknown): string {
  if (v == null) return "";
  if (Array.isArray(v)) return v.filter((x) => x != null && String(x).trim() !== "").map((x) => String(x).trim()).join("、");
  return String(v).trim();
}

/** 品目の補足。オプション / アレルギーの順で「 / 」区切り (現行 itemNotesText) */
function itemNotes(item: OrderItem): string {
  const notes: string[] = [];
  const opt = noteText(item.options);
  const alg = noteText(item.allergies);
  if (opt) notes.push(opt);
  if (alg) notes.push("アレルギー: " + alg);
  return notes.join(" / ");
}

function pad2(n: number): string { return (n < 10 ? "0" : "") + n; }
function hhmm(ts: number): string {
  const d = new Date(ts);
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}

function peopleText(p: Order["people"]): string {
  if (p == null) return "";
  if (typeof p === "number") return String(p);
  return String((p.adults ?? 0) + (p.kids ?? 0));
}

function slipItems(order: Order): SlipItem[] {
  return (order.items || []).map((it) => ({ name: it.name, qty: Number(it.qty) || 1, note: itemNotes(it) }));
}

/** SlipRenderer が受け取る注文オブジェクト (差込フィールドの実データ) */
function slipOrderData(order: Order) {
  const now = new Date();
  const d = new Date(order.start);
  return {
    store: STORE_NAME,
    table: order.table || "--",
    meta: hhmm(order.start),
    metaDate: isNaN(d.getTime()) ? "" : `${d.getMonth() + 1}/${d.getDate()}`, // 日を跨いだ卓か分かるように
    people: peopleText(order.people),
    kind: order.type === "reserved" ? "予約" : "新規",
    orderNo: order.id != null ? String(order.id) : "",
    date: `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`,
    time: `${pad2(now.getHours())}:${pad2(now.getMinutes())}`,
    items: slipItems(order),
  };
}

function qtyText(st: SlipStyle | null, qty: number): string {
  if (!st) return "×" + qty;
  if (st.qtyFormat === "kosuu") return qty + " 個";
  if (st.qtyFormat === "x") return "x " + qty;
  return "× " + qty;
}

/** 印刷時だけ表示される伝票 DOM を body 直下に作る。戻り値は片付け関数 */
function mountPrintDom(order: Order, st: SlipStyle | null, tpl: SlipTemplate | null): () => void {
  const root = document.createElement("div");
  root.id = "kds-print-slip";
  const w = (tpl ? tpl.paperWidth : st?.paperWidth) === 58 ? 58 : 80;
  const style = document.createElement("style");
  style.textContent =
    "#kds-print-slip{display:none}\n" +
    `@page{size:${w}mm auto;margin:0}\n` +
    "@media print{body>*:not(#kds-print-slip){display:none!important}" +
    `#kds-print-slip{display:block;width:${w}mm;color:#000;background:#fff;font-family:sans-serif}` +
    "#kds-print-slip .t{font-size:40px;font-weight:900}#kds-print-slip .m{font-size:14px}" +
    "#kds-print-slip li{display:flex;justify-content:space-between;font-size:20px;padding:2px 0}" +
    "#kds-print-slip ul{list-style:none;margin:6px 0;padding:6px 0;border-top:1px dashed #000;border-bottom:1px dashed #000}" +
    "#kds-print-slip img{width:100%}}";
  root.appendChild(style);

  let drew = false;
  const sr = renderer();
  if (tpl && sr) {
    // 自由配置レイアウトは画面と紙を一致させるため、印字画像と同じ絵を出す
    try {
      const canvas = document.createElement("canvas");
      sr.renderToCanvas(canvas, tpl, slipOrderData(order));
      const img = document.createElement("img");
      img.src = canvas.toDataURL("image/png");
      root.appendChild(img);
      drew = true;
    } catch { /* 描けなければ簡易伝票に落とす */ }
  }
  if (!drew) {
    if (!st || st.storeShow !== false) {
      const s = document.createElement("div");
      s.textContent = STORE_NAME;
      root.appendChild(s);
    }
    const t = document.createElement("div");
    t.className = "t";
    t.textContent = order.table || "--";
    root.appendChild(t);
    if (!st || st.metaShow !== false) {
      const m = document.createElement("div");
      m.className = "m";
      m.textContent = "受付 " + hhmm(order.start);
      root.appendChild(m);
    }
    const ul = document.createElement("ul");
    for (const it of slipItems(order)) {
      const li = document.createElement("li");
      const nm = document.createElement("span");
      nm.textContent = it.name + (it.note && (!st || st.noteShow !== false) ? ` (${it.note})` : "");
      const q = document.createElement("span");
      q.textContent = qtyText(st, it.qty);
      li.append(nm, q);
      ul.appendChild(li);
    }
    root.appendChild(ul);
  }
  document.body.appendChild(root);
  return () => root.remove();
}

/** 実機に送れなかったときのブラウザ印刷。印刷ダイアログは同期的に画面を止めるので、閉じてから片付ける */
function browserPrint(order: Order, st: SlipStyle | null, tpl: SlipTemplate | null): boolean {
  const cleanup = mountPrintDom(order, st, tpl);
  try {
    window.print();
    return true;
  } catch {
    return false;
  } finally {
    cleanup();
  }
}

export async function printSlip(order: Order): Promise<"printed" | "browser" | "failed" | "busy"> {
  if (busy) return "busy"; // 連打ガード (#176)。送信中の2回目は何もしない (失敗表示も出さない)
  busy = true;
  try {
    await refreshSlipStyle();
    const st = loadSlipStyle();
    const sr = renderer();
    const tpl = sr && sr.isTemplate(st) ? sr.normalizeTemplate(st) : null;
    const ip = lsGet(LS_PRINTER_IP) || undefined; // 未設定ならサーバー保存のIPに委ねる

    let job: Record<string, unknown>;
    try {
      if (tpl && sr) {
        // 画面と同じ絵を1bit画像にして送る。プリンター内蔵フォントに縛られない
        const canvas = document.createElement("canvas");
        sr.renderToCanvas(canvas, tpl, slipOrderData(order));
        job = { ip, raster: sr.canvasToRaster(canvas), feedLines: tpl.feedLines, emulation: emulation() };
      } else {
        job = {
          ip,
          table: order.table || "--",
          meta: "受付 " + hhmm(order.start),
          store: STORE_NAME,
          style: st || undefined, // 設定ツールのスタイルを実機印字にも反映 (relay側で許容値へ丸める)
          items: slipItems(order),
        };
      }
    } catch {
      return browserPrint(order, st, null) ? "browser" : "failed";
    }

    try {
      const res = await fetch("/api/print", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(job),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || !data.ok) throw new Error((data && data.error) || "HTTP " + res.status);
      return "printed";
    } catch (err) {
      console.error("[伝票] 実機印刷に失敗。ブラウザ印刷にフォールバック:", err);
      return browserPrint(order, st, tpl) ? "browser" : "failed";
    }
  } finally {
    busy = false;
  }
}
