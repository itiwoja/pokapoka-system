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
var seats = require("./seat-occupancy");
var mock = require("./mock-tablecheck");

var PORT = Number(process.env.PORT) || 8000;
var API_KEY = process.env.TABLECHECK_API_KEY || "";
var SHOP_ID = process.env.SHOP_ID || "";
var BASE = process.env.TABLECHECK_BASE || "https://api.tablecheck.com";
var IS_MOCK = process.env.MOCK === "1" || !API_KEY;
// ポーリング間隔: LIVE は 30秒未満不可(Sync v1 仕様の下限)。MOCK はローカル完結なので
// デモの手応えを良くするため下限を撤廃し、既定を短く(3秒)する。
var POLL_MS = IS_MOCK
  ? (Number(process.env.POLL_MS) || 3000)
  : Math.max(Number(process.env.POLL_MS) || 30000, 30000);

var ROOT = path.resolve(__dirname, "..");   // リポジトリ直下を配信ルートに
var store = new Map();                       // rid -> 正規化済みレコード
var walkins = new Map();                     // table -> 当日walk-in占有 (メモリのみ)
var SEAT_BEFORE_MIN = Math.max(Number(process.env.SEAT_BEFORE_MIN) || 30, 0);
var SEAT_AFTER_MIN = Math.max(Number(process.env.SEAT_AFTER_MIN) || 120, 0);
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

  if (url.pathname === "/api/seats" || url.pathname.indexOf("/api/seats/") === 0) {
    return handleSeats(req, res, url);
  }
  if (url.pathname === "/api/stock") {          // KDS 予約ストック形式で返す
    return json(res, sync.toKdsStock(store, Date.now()));
  }
  if (url.pathname === "/api/health") {         // 運用確認用
    return json(res, { mode: IS_MOCK ? "mock" : "live", pollMs: POLL_MS, store: store.size, lastPoll: lastPoll });
  }

  // デモGUI (SaaS 操作コンソール) からの予約注入。MOCK モード限定 (LIVE では拒否)
  if (url.pathname.indexOf("/api/mock/") === 0) {
    if (!IS_MOCK) { res.writeHead(403); return res.end("mock endpoints are disabled in LIVE mode"); }
    return handleMock(req, res, url);
  }
  if (url.pathname === "/demo") {               // 操作コンソールへのショートカット
    return serveFile(res, path.join(__dirname, "tablecheck-demo.html"));
  }

  // 静的配信 (リポジトリ直下)。"/" は KDS 本体へ
  var rel = url.pathname === "/" ? "/kds-a-grid.html" : decodeURIComponent(url.pathname);
  var file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end("forbidden"); }
  fs.readFile(file, function (err, data) {
    if (err) { res.writeHead(404); return res.end("not found"); }
    // KDS 本体は無改修のまま、配信時にだけ取込ブリッジを1行注入する。
    // (ブリッジは KDS と別の BroadcastChannel オブジェクトを持つので、同一タブ内でも
    //  KDS の受信ハンドラへ配信され、単一タブで自己完結して反映される)
    if (path.basename(file) === "kds-a-grid.html") {
      var html = data.toString("utf8");
      if (html.indexOf("kds-bridge.js") < 0 && html.indexOf("</body>") >= 0) {
        // 中継サーバー配信時は「外部がデータ源」なので KDS 内蔵の自動デモを抑止し、
        // 予約中継ブリッジを注入する (どちらも </body> 直前。KDS 本体ファイルは無改修)。
        html = html.replace("</body>",
          '  <script>window.__KDS_SUPPRESS_DEMO__=true;</script>\n' +
          '  <script src="/relay-server/kds-bridge.js"></script>\n</body>');
        data = Buffer.from(html, "utf8");
      }
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
});

function handleSeats(req, res, url) {
  if (url.pathname === "/api/seats" && req.method === "GET") {
    return json(res, seats.toOccupiedSeats(store, walkins, Date.now(), SEAT_BEFORE_MIN, SEAT_AFTER_MIN));
  }
  if (url.pathname === "/api/seats" && req.method === "POST") {
    return readJson(req, res, function (body) {
      var occupancy = seats.registerWalkin(walkins, body && body.table, Date.now());
      if (!occupancy) return json(res, { ok: false, error: "table must be a non-empty string of at most 6 characters" }, 400);
      json(res, occupancy, 201);
    });
  }
  if (url.pathname.indexOf("/api/seats/") === 0 && req.method === "DELETE") {
    var rawTable = url.pathname.slice("/api/seats/".length);
    var table;
    try { table = decodeURIComponent(rawTable); }
    catch (e) { return json(res, { ok: false, error: "invalid table" }, 400); }
    if (!seats.validateTable(table)) return json(res, { ok: false, error: "invalid table" }, 400);
    if (!seats.releaseWalkin(walkins, table)) return json(res, { ok: false, error: "seat not found" }, 404);
    res.writeHead(204, { "Cache-Control": "no-store" });
    return res.end();
  }
  return json(res, { ok: false, error: "method not allowed" }, 405);
}

function json(res, obj, code) {
  res.writeHead(code || 200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}
function serveFile(res, file) {
  fs.readFile(file, function (err, data) {
    if (err) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}
function log(msg) { console.log("[relay " + new Date().toLocaleTimeString("ja-JP") + "] " + msg); }

/* ===================== デモGUI 予約注入 (MOCK 限定) ===================== */

/** /api/mock/reservations[/{id}] を GET(一覧)/POST(作成)/PATCH(変更)/DELETE(キャンセル) で捌く */
function handleMock(req, res, url) {
  var parts = url.pathname.replace(/^\/api\/mock\//, "").split("/");
  if (parts[0] !== "reservations") { res.writeHead(404); return res.end("not found"); }
  var id = parts[1] ? decodeURIComponent(parts[1]) : null;

  if (req.method === "GET" && !id) {                 // 上流(TableCheck相当)の生予約一覧
    return json(res, mock.listReservations());
  }
  if (req.method === "POST" && !id) {                // 予約作成
    return readJson(req, res, function (body) {
      afterMutation(res, { ok: true, reservation: mock.createReservation(body || {}) });
    });
  }
  if (req.method === "PATCH" && id) {                // 予約変更 (人数・メニュー等)
    return readJson(req, res, function (body) {
      var rec = mock.updateReservation(id, body || {});
      if (!rec) return json(res, { ok: false, error: "no such reservation" }, 404);
      afterMutation(res, { ok: true, reservation: rec });
    });
  }
  if (req.method === "DELETE" && id) {               // 予約キャンセル
    var rec = mock.cancelReservation(id);
    if (!rec) return json(res, { ok: false, error: "no such reservation" }, 404);
    return afterMutation(res, { ok: true, reservation: rec });
  }
  json(res, { ok: false, error: "method not allowed" }, 405);
}

/** 変更を即 KDS へ届けるため、応答前に1回ポーリングを回して store を最新化する */
function afterMutation(res, payload) {
  pollOnce().then(function () {
    payload.stock = sync.toKdsStock(store, Date.now());
    json(res, payload);
  });
}

/** リクエストボディを JSON として読む (1MB 上限)。空ボディは {} を返す */
function readJson(req, res, cb) {
  var chunks = [], size = 0;
  req.on("data", function (c) {
    size += c.length;
    if (size > 1e6) { req.destroy(); json(res, { ok: false, error: "payload too large" }, 413); }
    else chunks.push(c);
  });
  req.on("end", function () {
    var raw = Buffer.concat(chunks).toString("utf8").trim();
    if (!raw) return cb({});
    try { cb(JSON.parse(raw)); }
    catch (e) { json(res, { ok: false, error: "invalid JSON" }, 400); }
  });
  req.on("error", function () { json(res, { ok: false, error: "read error" }, 400); });
}

server.listen(PORT, function () {
  log("起動: http://127.0.0.1:" + PORT + "  (モード: " + (IS_MOCK ? "MOCK — デモ予約を配信" : "LIVE — TableCheck へ " + POLL_MS / 1000 + "秒間隔で pull") + ")");
  if (IS_MOCK) {
    // 既定はシードなし = デシャップは空の状態から始まり、コンソールで作った予約だけが出る。
    // 開いてすぐ1件見せたいときは SEED=1 で起動する。
    if (process.env.SEED === "1") { mock.seed(); log("SEED=1: デモ予約を1件シード"); }
    log("デモ操作コンソール: http://127.0.0.1:" + PORT + "/demo  (ここで予約を作成→デシャップへ流れる)");
  }
  log("KDS(デシャップ): http://127.0.0.1:" + PORT + "/  / 予約: /api/stock / 状態: /api/health");
  pollOnce();
  setInterval(pollOnce, POLL_MS);
});
