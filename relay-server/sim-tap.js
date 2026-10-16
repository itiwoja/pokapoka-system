/**
 * sim-tap.js — 通信フロー・シミュレーター用の盗聴 (tap)
 *
 * SIMULATOR=1 のときだけ server.js が組み込む。HTTP の要求・応答と WebSocket の動きを
 * 記録して、/sim/events (SSE) で画面へ流す。本物の処理には手を入れず、req/res を包んで読むだけ。
 * 記録はメモリ上のリングバッファのみ (再起動で消える)。
 */
"use strict";

var crypto = require("crypto");

var BACKLOG_MAX = 200;
var SSE_MAX_CLIENTS = 8;
var PING_INTERVAL_MS = 15000;
var BODY_CAPTURE_BYTES = 64 * 1024;   // 要求・応答本文を集める上限
var JSON_LIMIT_CHARS = 16 * 1024;     // これを超える本文は先頭だけにする
var PREVIEW_CHARS = 2000;
var CLIENTS = ["deshap", "kds2", "order"];

var KITCHEN_EVENT_NAMES = {
  konro: "コンロ割当",
  toggle: "品目完了",
  timerLock: "タイマーロック",
  order: "並び替え",
  deleteOrder: "注文削除",
};

function createSimTap(options) {
  options = options || {};
  var state = options.state || function () { return {}; };
  var sessionId = crypto.randomUUID();
  var startedAt = new Date().toISOString();
  var backlog = [];
  var nextId = 1;
  var sseClients = [];
  var lastSignature = {};   // "client|path" -> 前回応答の署名 (changed 判定)
  // 処理中の HTTP 要求の数。注文の POST は応答を返す前に WS 配信するため、そのまま記録すると
  // 「配信」が「受付」より先に並ぶ。処理中の要求がある間は WS の記録を待たせ、要求の記録の後に出す
  var inFlight = 0;
  var deferred = [];

  var pingTimer = setInterval(function () {
    sseClients.slice().forEach(function (client) { sseWrite(client, ": ping\n\n"); });
  }, PING_INTERVAL_MS);
  pingTimer.unref();

  function sseWrite(client, chunk) {
    try { client.write(chunk); }
    catch (err) { removeClient(client); }
  }

  function removeClient(client) {
    var index = sseClients.indexOf(client);
    if (index >= 0) sseClients.splice(index, 1);
  }

  function push(entry) {
    var flow = Object.assign({
      id: nextId++,
      at: new Date().toISOString(),
      client: null, method: null, path: null, status: null, durationMs: null,
      request: null, response: null, summary: "", changed: true, wsClients: null,
    }, entry);
    backlog.push(flow);
    if (backlog.length > BACKLOG_MAX) backlog.shift();
    var chunk = "event: flow\ndata: " + JSON.stringify(flow) + "\n\n";
    sseClients.slice().forEach(function (client) { sseWrite(client, chunk); });
    return flow;
  }

  /** /sim/events と /sim/state を処理する。処理したら true */
  function handle(req, res, url) {
    if (url.pathname === "/sim/events" && req.method === "GET") {
      if (sseClients.length >= SSE_MAX_CLIENTS) {
        res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("too many simulator connections");
        return true;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      sseClients.push(res);
      req.on("close", function () { removeClient(res); });
      res.write("event: hello\ndata: " + JSON.stringify({ sessionId: sessionId, startedAt: startedAt }) + "\n\n");
      backlog.forEach(function (flow) { res.write("event: flow\ndata: " + JSON.stringify(flow) + "\n\n"); });
      return true;
    }
    if (url.pathname === "/sim/state" && req.method === "GET") {
      var body;
      try { body = state(); }
      catch (err) { body = { error: String(err && err.message || err) }; }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(body));
      return true;
    }
    return false;
  }

  /** 記録対象のパスか。/sim*・/order-client.js・音声など他の静的ファイルは対象外 */
  function tappable(pathname) {
    return pathname.indexOf("/api/") === 0 || pathname === "/" || pathname === "/kds" ||
      pathname === "/relay-server/kds-bridge.js";
  }

  /** ルートに渡す前の req/res を包む。要求本文は同じティックで 'data' を足すだけで、読み取りは奪わない */
  function wrap(req, res, url) {
    if (!tappable(url.pathname)) return;
    var started = Date.now();
    var settled = false;
    inFlight++;
    function settle() {
      if (settled) return;
      settled = true;
      inFlight--;
      if (inFlight === 0) deferred.splice(0).forEach(push);
    }
    res.on("close", settle);
    var reqChunks = [], reqSize = 0;
    if (req.method !== "GET" && req.method !== "HEAD") {
      req.on("data", function (chunk) {
        if (reqSize >= BODY_CAPTURE_BYTES) return;
        reqChunks.push(chunk);
        reqSize += chunk.length;
      });
    }
    var resChunks = [], resSize = 0;
    var headerType = null;
    function collect(chunk, encoding) {
      if (chunk == null || typeof chunk === "function" || resSize >= BODY_CAPTURE_BYTES) return;
      var buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof encoding === "string" ? encoding : "utf8");
      resChunks.push(buf);
      resSize += buf.length;
    }
    var origWriteHead = res.writeHead;
    res.writeHead = function (code, a, b) {
      var headers = (a && typeof a === "object") ? a : (b && typeof b === "object" ? b : null);
      if (headers) Object.keys(headers).forEach(function (key) {
        if (key.toLowerCase() === "content-type") headerType = String(headers[key]);
      });
      return origWriteHead.apply(res, arguments);
    };
    var origWrite = res.write;
    res.write = function (chunk, encoding) { collect(chunk, encoding); return origWrite.apply(res, arguments); };
    var origEnd = res.end;
    res.end = function (chunk, encoding) { collect(chunk, encoding); return origEnd.apply(res, arguments); };

    res.on("finish", function () {
      try {
        var type = headerType || String(res.getHeader("content-type") || "");
        var isApiJson = url.pathname.indexOf("/api/") === 0 && /json/i.test(type);
        var request = parseBody(Buffer.concat(reqChunks), reqSize >= BODY_CAPTURE_BYTES);
        var response = isApiJson ? parseBody(Buffer.concat(resChunks), resSize >= BODY_CAPTURE_BYTES) : null;
        var method = req.method;
        var client = identifyClient(req, url);
        var status = res.statusCode;
        var changed = true;
        if (method === "GET") {
          var key = (client || "") + "|" + url.pathname;
          var signature = signatureOf(url.pathname, status, response);
          changed = lastSignature[key] !== signature;
          lastSignature[key] = signature;
        }
        push({
          kind: "http", client: client, method: method, path: url.pathname, status: status,
          durationMs: Date.now() - started,
          request: limit(request), response: limit(response),
          summary: summarize(method, url.pathname, status, request, response),
          changed: changed,
        });
      } catch (err) {
        if (options.log) options.log("sim-tap: 記録に失敗 (" + (err && err.message || err) + ")");
      }
      settle();
    });
  }

  /** orders-websocket.js へ渡すフック。heartbeat は画面が埋まるので来ない */
  function pushWs(entry) {
    if (inFlight > 0) deferred.push(entry);
    else push(entry);
  }

  var wsHooks = {
    open: function (origin) {
      pushWs({ kind: "ws-open", path: "/ws/orders", origin: origin || null, summary: "WS接続" });
    },
    send: function (type, data, clients, origin) {
      pushWs({ kind: "ws-send", path: "/ws/orders", origin: origin || null, response: limit(data),
        summary: "WS配信: " + type, wsClients: clients });
    },
    recv: function (data, origin) {
      pushWs({ kind: "ws-recv", path: "/ws/orders", origin: origin || null, response: limit(data),
        summary: "WS受信確認 seq " + data.sequence });
    },
    close: function (origin) {
      pushWs({ kind: "ws-close", path: "/ws/orders", origin: origin || null, summary: "WS切断" });
    },
  };

  function close() {
    clearInterval(pingTimer);
    sseClients.slice().forEach(function (client) {
      try { client.end(); } catch (err) { /* 既に切れている */ }
    });
    sseClients.length = 0;
  }

  return { handle: handle, wrap: wrap, wsHooks: wsHooks, close: close, push: push };
}

/** X-Sim-Client > Referer の simClient > 自分の URL の simClient。deshap|kds2|order 以外は null */
function identifyClient(req, url) {
  var header = req.headers["x-sim-client"];
  if (header) return CLIENTS.indexOf(String(header)) >= 0 ? String(header) : null;
  var value = null;
  var referer = req.headers.referer;
  if (referer) {
    try { value = new URL(referer).searchParams.get("simClient"); } catch (err) { value = null; }
  }
  if (!value) value = url.searchParams.get("simClient");
  return CLIENTS.indexOf(value) >= 0 ? value : null;
}

/** 本文を JSON として読めれば値、だめなら先頭2000文字。空は null */
function parseBody(buffer, overflow) {
  if (!buffer.length) return null;
  var raw = buffer.toString("utf8");
  if (!overflow) {
    try { return JSON.parse(raw); } catch (err) { /* 文字列として扱う */ }
  }
  return raw.slice(0, PREVIEW_CHARS);
}

/** JSON 化して 16KB を超えるものは先頭だけに置き換える */
function limit(value) {
  if (value === null || value === undefined) return null;
  var text = JSON.stringify(value);
  if (text.length > JSON_LIMIT_CHARS) return { truncated: true, preview: text.slice(0, PREVIEW_CHARS) };
  return value;
}

/** changed 判定用。/api/health は ordersStream だけで比べる (他は時刻などで毎回変わり得る) */
function signatureOf(pathname, status, response) {
  if (response === null || response === undefined) return String(status);
  if (pathname === "/api/health" && response && typeof response === "object") {
    return status + ":" + JSON.stringify(response.ordersStream === undefined ? null : response.ordersStream);
  }
  return status + ":" + JSON.stringify(response);
}

function summarize(method, pathname, status, request, response) {
  var failed = status >= 400;
  var text;
  if (pathname === "/api/orders" && method === "POST") {
    if (failed) text = "注文の受付に失敗";
    else if (response && response.duplicate) text = "注文を受付（重複）";
    else if (response && response.updated) text = "注文を受付（更新）";
    else text = "注文を受付（新規）";
  } else if (pathname.indexOf("/api/orders/") === 0 && method === "DELETE") {
    text = failed ? "注文の取消に失敗" : "注文を取消";
  } else if (pathname === "/api/orders" && method === "GET") {
    text = "注文一覧を取得" + (Array.isArray(response) ? " (" + response.length + "件)" : "");
  } else if (pathname === "/api/kitchen-state" && method === "POST") {
    text = failed ? "厨房操作の送信に失敗" : "厨房操作: " + kitchenEvents(request);
  } else if (pathname === "/api/kitchen-state" && method === "GET") {
    text = "厨房状態を取得" + (response && response.rev !== undefined ? " (rev " + response.rev + ")" : "");
  } else if (pathname === "/api/stock" && method === "GET") {
    text = "予約ストックを取得" + (Array.isArray(response) ? " (" + response.length + "件)" : "");
  } else if (pathname === "/api/health") {
    text = "死活確認";
  } else if (pathname === "/api/seats" && method === "POST") {
    text = failed ? "着席の登録に失敗" : "着席を登録";
  } else if (pathname === "/api/seats" && method === "GET") {
    text = "着席状況を取得";
  } else if (pathname === "/") {
    text = "KDS画面を配信";
  } else if (pathname === "/kds") {
    text = "KDS画面を配信";
  } else if (pathname === "/relay-server/kds-bridge.js") {
    text = "KDSブリッジを配信";
  } else {
    text = method + " " + pathname;
  }
  if (failed && text.indexOf("失敗") < 0) text += "（失敗 " + status + "）";
  return text;
}

function kitchenEvents(request) {
  var events = request && Array.isArray(request.events) ? request.events : [];
  var counts = {}, order = [];
  events.forEach(function (event) {
    var type = event && event.type;
    var name = KITCHEN_EVENT_NAMES[type] || (type ? String(type) : "不明");
    if (!counts[name]) { counts[name] = 0; order.push(name); }
    counts[name]++;
  });
  if (!order.length) return "イベントなし";
  return order.map(function (name) { return name + "×" + counts[name]; }).join(", ");
}

module.exports = { createSimTap: createSimTap, summarize: summarize };
