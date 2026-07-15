/**
 * server.js — ぽかぽか店内 中継サーバー (依存ゼロ・Node 18+)
 *
 * 役割 (6/18 議事録の「見かけ上のサーバー」+ TableCheck 取込の2役):
 *   1. 静的配信: リポジトリ直下のファイル (kds-a-grid.html 等) を配る Web サーバー
 *   2. TableCheck 取込: /sync_events を 30 秒間隔でポーリング (外向き pull のみ。
 *      店内は NAT 内のため Webhook(push) は使わない — 2026-06-04 検討 / 裏どり済み)
 *   3. KDS への配信: GET /api/stock が kds_stock_v1 と同じ形式の JSON を返す
 *      (KDS 側は kds-bridge.js がこれを取り込み LocalStorage + BroadcastChannel へ反映)
 *
 * 起動:
 *   本番:   TABLECHECK_API_KEY=xxx SHOP_ID=xxx node relay-server/server.js
 *   モック: MOCK=1 node relay-server/server.js   (API 契約前でも動作確認できる)
 *
 * 環境変数:
 *   PORT               (default 8000)
 *   POLL_MS            ポーリング間隔 (default/最小 30000。TableCheck 指定の下限)
 *   TABLECHECK_API_KEY secret_key (契約後に発行される)
 *   SHOP_ID            対象店舗 ID
 *   TABLECHECK_BASE    default https://api.tablecheck.com  (旧 tablesolution.com は使わない)
 *   MOCK=1             TableCheck を呼ばずデモ予約を流す
 *
 * データ保持: メモリのみ (当日分)。営業日をまたいだ予約はパージされる。
 */
"use strict";

var http = require("http");
var fs = require("fs");
var path = require("path");
var sync = require("./tablecheck-sync");
var mock = require("./mock-tablecheck");

var PORT = Number(process.env.PORT) || 8000;
var POLL_MS = Math.max(Number(process.env.POLL_MS) || 30000, 30000); // 30秒未満は不可 (Sync v1 仕様)
var API_KEY = process.env.TABLECHECK_API_KEY || "";
var SHOP_ID = process.env.SHOP_ID || "";
var BASE = process.env.TABLECHECK_BASE || "https://api.tablecheck.com";
var IS_MOCK = process.env.MOCK === "1" || !API_KEY;

var ROOT = path.resolve(__dirname, "..");   // リポジトリ直下を配信ルートに
var store = new Map();                       // rid -> 正規化済みレコード
var lastPoll = { at: null, ok: null, events: 0, error: null };

/* ===================== TableCheck ポーラー ===================== */

async function pollOnce() {
  try {
    var events = IS_MOCK ? mock.listSyncEvents() : await tcListSyncEvents();
    var resEvents = events.filter(function (e) {
      return e && /reservation/i.test(e.syncable_type || "") && e.syncable_id;
    });
    var fetched = [];
    for (var i = 0; i < resEvents.length; i++) {
      var id = String(resEvents[i].syncable_id);
      var raw = IS_MOCK ? mock.getReservation(id) : await tcGetReservation(id);
      // 404 (raw=null) は削除扱い / created・updated は upsert (Sync v1 推奨方針)
      fetched.push({ rid: id, record: raw == null ? null : sync.normalizeReservation(raw) });
    }
    sync.applyFetched(store, fetched);
    sync.purge(store, new Date());
    lastPoll = { at: new Date().toISOString(), ok: true, events: resEvents.length, error: null };
    if (resEvents.length) log("poll: " + resEvents.length + " 件のイベントを反映 (store=" + store.size + ")");
  } catch (err) {
    lastPoll = { at: new Date().toISOString(), ok: false, events: 0, error: String(err && err.message || err) };
    log("poll ERROR: " + lastPoll.error + " (次回リトライまで表示は直前状態を保持)");
  }
}

/** GET /api/sync/v1/sync_events?deliver=true — 未配信イベントの取得 (取得と同時に配信済みフラグ) */
async function tcListSyncEvents() {
  var res = await tcFetch("/api/sync/v1/sync_events?deliver=true" + (SHOP_ID ? "&shop_id=" + encodeURIComponent(SHOP_ID) : ""));
  var body = await res.json();
  return (body && body.sync_events) || [];
}

/** GET /api/booking/v1/reservations/{id} — SyncEvent の ID から実データを取得 (2段構え) */
async function tcGetReservation(id) {
  var res = await tcFetch("/api/booking/v1/reservations/" + encodeURIComponent(id), true);
  if (res.status === 404) return null;
  var body = await res.json();
  return body && (body.reservation || body);
}

async function tcFetch(pathname, allow404) {
  // ⚠️ 認証ヘッダーの正確な形式 (Bearer か独自ヘッダーか) は API 契約時のドキュメントで要確認
  var res = await fetch(BASE + pathname, {
    headers: { "Authorization": "Bearer " + API_KEY, "Accept": "application/json" },
  });
  if (!res.ok && !(allow404 && res.status === 404)) {
    if (res.status === 429) throw new Error("429 レート制限。POLL_MS を見直す");
    throw new Error("TableCheck " + res.status + " " + pathname);
  }
  return res;
}

/* ===================== HTTP サーバー ===================== */

var MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".json": "application/json", ".md": "text/markdown; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };

var server = http.createServer(function (req, res) {
  var url = new URL(req.url, "http://localhost");

  if (url.pathname === "/api/stock") {          // KDS 予約ストック形式で返す
    return json(res, sync.toKdsStock(store, Date.now()));
  }
  if (url.pathname === "/api/health") {         // 運用確認用
    return json(res, { mode: IS_MOCK ? "mock" : "live", pollMs: POLL_MS, store: store.size, lastPoll: lastPoll });
  }

  // 静的配信 (リポジトリ直下)。"/" は KDS 本体へ
  var rel = url.pathname === "/" ? "/kds-a-grid.html" : decodeURIComponent(url.pathname);
  var file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end("forbidden"); }
  fs.readFile(file, function (err, data) {
    if (err) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
});

function json(res, obj) {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}
function log(msg) { console.log("[relay " + new Date().toLocaleTimeString("ja-JP") + "] " + msg); }

server.listen(PORT, function () {
  log("起動: http://127.0.0.1:" + PORT + "  (モード: " + (IS_MOCK ? "MOCK — デモ予約を配信" : "LIVE — TableCheck へ " + POLL_MS / 1000 + "秒間隔で pull") + ")");
  log("KDS: http://127.0.0.1:" + PORT + "/kds-a-grid.html  / 予約: /api/stock / 状態: /api/health");
  pollOnce();
  setInterval(pollOnce, POLL_MS);
});
