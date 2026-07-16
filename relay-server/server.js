/**
 * server.js — ぽかぽか店内 中継サーバー (依存ゼロ・Node 18+)
 *
 * 役割:
 *   1. リポジトリ直下の静的ファイルを配信
 *   2. Sync v1 を30秒間隔で取得し、予約変更を即時反映
 *   3. Booking v1 を起動時+15分間隔で全件取得し、当日storeを自己修復
 *   4. 初回全件取得が成功するまで /api/stock を503にしてKDSの誤削除を防止
 *
 * 起動:
 *   本番:   HOST=<店内LAN固定IP> TABLECHECK_API_KEY=xxx SHOP_ID=xxx node relay-server/server.js
 *   モック: MOCK=1 node relay-server/server.js
 */
"use strict";

var http = require("http");
var fs = require("fs");
var path = require("path");
var seats = require("./seat-occupancy");
var booking = require("./booking-resync");

var MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css",
  ".json": "application/json",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function createRelay(options) {
  options = options || {};
  var env = options.env || process.env;
  var config = createConfig(env, options);
  var mock = options.mockSource || require("./mock-tablecheck");
  var log = options.log || defaultLog;
  var now = options.now || function () { return new Date(); };
  var fetchFn = options.fetch || globalThis.fetch;
  var setIntervalFn = options.setInterval || setInterval;
  var clearIntervalFn = options.clearInterval || clearInterval;
  var root = path.resolve(__dirname, "..");
  var allowedStaticFiles = [
    "kds-a-grid.html",
    path.join("relay-server", "kds-bridge.js"),
  ];
  var timers = [];
  var inFlight = new Set();
  var walkins = new Map();
  var started = false;
  var initialSync = Promise.resolve();

  var tableCheckSource = options.source || createTableCheckSource({
    apiKey: config.apiKey,
    base: config.base,
    shopId: config.shopId,
    isMock: config.isMock,
    mock: mock,
    fetch: fetchFn,
    requestTimeoutMs: config.requestTimeoutMs,
  });

  var reservationSync = booking.createReservationSync({
    now: now,
    log: log,
    listReservations: tableCheckSource.listReservations,
    listSyncEvents: tableCheckSource.listSyncEvents,
    getReservation: tableCheckSource.getReservation,
  });

  var server = http.createServer(function (req, res) {
    var url;
    try { url = new URL(req.url, "http://localhost"); }
    catch (err) { res.writeHead(400); return res.end("bad request"); }

    if (url.pathname === "/api/stock") {
      var stock = reservationSync.stockResponse(Date.now());
      return json(res, stock.body, stock.code);
    }
    if (url.pathname === "/api/health") {
      return json(res, Object.assign({
        mode: config.isMock ? "mock" : "live",
        pollMs: config.pollMs,
        resyncMs: config.resyncMs,
      }, reservationSync.health()));
    }

    if (url.pathname === "/api/seats" || url.pathname.indexOf("/api/seats/") === 0) {
      return handleSeats(req, res, url, {
        reservationSync: reservationSync,
        walkins: walkins,
        beforeMin: config.seatBeforeMin,
        afterMin: config.seatAfterMin,
      });
    }

    if (url.pathname.indexOf("/api/mock/") === 0) {
      if (!config.isMock) {
        res.writeHead(403);
        return res.end("mock endpoints are disabled in LIVE mode");
      }
      return handleMock(req, res, url, mock, reservationSync);
    }
    if (url.pathname === "/demo") {
      return serveFile(res, path.join(__dirname, "tablecheck-demo.html"));
    }

    var rel;
    try { rel = url.pathname === "/" ? "/kds-a-grid.html" : decodeURIComponent(url.pathname); }
    catch (err) { res.writeHead(400); return res.end("bad request"); }
    var file = path.normalize(path.join(root, rel));
    var relativePath = path.relative(root, file);
    if (relativePath === ".." || relativePath.indexOf(".." + path.sep) === 0 || path.isAbsolute(relativePath)) {
      res.writeHead(403);
      return res.end("forbidden");
    }
    if (allowedStaticFiles.indexOf(relativePath) < 0) {
      res.writeHead(404);
      return res.end("not found");
    }
    fs.readFile(file, function (err, data) {
      if (err) { res.writeHead(404); return res.end("not found"); }
      if (path.basename(file) === "kds-a-grid.html") {
        var html = data.toString("utf8");
        if (html.indexOf("kds-bridge.js") < 0 && html.indexOf("</body>") >= 0) {
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

  function resyncThenPoll() {
    return track(reservationSync.enqueueResync().then(function () {
      return reservationSync.enqueuePoll();
    }));
  }

  function pollTick() {
    return reservationSync.health().ready ? track(reservationSync.enqueuePoll()) : resyncThenPoll();
  }

  function track(promise) {
    var tracked = Promise.resolve(promise).finally(function () { inFlight.delete(tracked); });
    inFlight.add(tracked);
    return tracked;
  }

  function start() {
    if (started) return server;
    started = true;
    server.listen(config.port, config.host, function () {
      var address = server.address();
      var listenPort = address && address.port || config.port;
      log("起動: http://" + config.host + ":" + listenPort + "  (モード: " +
        (config.isMock ? "MOCK — デモ予約を配信" : "LIVE — TableCheck へ " + config.pollMs / 1000 + "秒間隔で pull") + ")");
      if (config.isMock) {
        if (env.SEED === "1") { mock.seed(); log("SEED=1: デモ予約を1件シード"); }
        log("デモ操作コンソール: http://127.0.0.1:" + listenPort + "/demo");
      }
      log("KDS(デシャップ): http://127.0.0.1:" + listenPort + "/  / 予約: /api/stock / 状態: /api/health");

      initialSync = resyncThenPoll();
      timers = [
        setIntervalFn(pollTick, config.pollMs),
        setIntervalFn(resyncThenPoll, config.resyncMs),
      ];
    });
    return server;
  }

  function stop() {
    timers.forEach(function (timer) { clearIntervalFn(timer); });
    timers = [];
    started = false;
    var closeServer = new Promise(function (resolve, reject) {
      if (!server.listening) return resolve();
      server.close(function (err) { if (err) reject(err); else resolve(); });
    });
    return closeServer.then(function () {
      return Promise.all(Array.from(inFlight));
    }).then(function () {});
  }

  return {
    config: config,
    server: server,
    sync: reservationSync,
    start: start,
    stop: stop,
    pollTick: pollTick,
    resyncThenPoll: resyncThenPoll,
    whenInitialSync: function () { return initialSync; },
  };
}

function createConfig(env, options) {
  var apiKey = env.TABLECHECK_API_KEY || "";
  var isMock = env.MOCK === "1" || !apiKey;
  var shopId = env.SHOP_ID || "";
  var base = env.TABLECHECK_BASE || "https://api.tablecheck.com";
  if (!isMock && !shopId) throw new Error("SHOP_ID is required in LIVE mode");
  if (!isMock) validateTableCheckBase(base, env.TABLECHECK_ALLOW_CUSTOM_BASE === "1");
  var pollMs = normalizeInterval(env.POLL_MS, isMock ? 3000 : 30000, isMock ? 100 : 30000);
  var resyncMs = normalizeInterval(env.RESYNC_MS, 900000, isMock ? 1000 : 60000);
  return {
    port: options.port !== undefined ? options.port : (Number(env.PORT) || 8000),
    host: env.HOST || "127.0.0.1",
    apiKey: apiKey,
    shopId: shopId,
    base: base,
    isMock: isMock,
    pollMs: pollMs,
    resyncMs: resyncMs,
    requestTimeoutMs: normalizeInterval(env.TABLECHECK_TIMEOUT_MS, 15000, 1000, 120000),
    seatBeforeMin: Math.max(Number(env.SEAT_BEFORE_MIN) || 30, 0),
    seatAfterMin: Math.max(Number(env.SEAT_AFTER_MIN) || 120, 0),
  };
}

function normalizeInterval(value, fallback, minimum, maximum) {
  var number = Number(value);
  if (!Number.isFinite(number) || number <= 0) number = fallback;
  number = Math.round(number);
  return Math.min(Math.max(number, minimum), maximum || 2147483647);
}

function validateTableCheckBase(base, allowCustom) {
  var url;
  try { url = new URL(base); }
  catch (err) { throw new Error("TABLECHECK_BASE must be a valid HTTPS URL"); }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("TABLECHECK_BASE must be a valid HTTPS URL without credentials");
  }
  if (url.hostname !== "api.tablecheck.com" && !allowCustom) {
    throw new Error("custom TABLECHECK_BASE requires TABLECHECK_ALLOW_CUSTOM_BASE=1");
  }
}

function createTableCheckSource(config) {
  if (config.isMock) {
    return {
      listReservations: async function () { return config.mock.listReservations(); },
      listSyncEvents: async function () { return config.mock.listSyncEvents(); },
      getReservation: async function (id) { return config.mock.getReservation(id); },
    };
  }
  if (typeof config.fetch !== "function") throw new Error("fetch is required in LIVE mode");

  async function tcFetchJson(pathname, allow404) {
    var controller = new AbortController();
    var timeout = setTimeout(function () { controller.abort(); }, config.requestTimeoutMs || 15000);
    try {
      var res = await config.fetch(config.base + pathname, {
        headers: { "Authorization": "Bearer " + config.apiKey, "Accept": "application/json" },
        signal: controller.signal,
      });
      if (!res.ok && !(allow404 && res.status === 404)) {
        if (res.status === 429) throw new Error("429 レート制限。POLL_MS を見直す");
        throw new Error("TableCheck " + res.status + " " + pathname);
      }
      if (allow404 && res.status === 404) return { status: 404, body: null };
      return { status: res.status, body: await res.json() };
    } catch (err) {
      if (err && err.name === "AbortError") throw new Error("TableCheck request timed out");
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    listReservations: function (current) {
      return booking.listAllReservations(async function (query) {
        var params = new URLSearchParams();
        Object.keys(query).forEach(function (key) { params.set(key, query[key]); });
        var result = await tcFetchJson("/api/booking/v1/reservations?" + params.toString());
        return result.body;
      }, { now: current, shopId: config.shopId, perPage: booking.DEFAULT_PER_PAGE });
    },
    listSyncEvents: async function () {
      var pathname = "/api/sync/v1/sync_events?deliver=true" +
        (config.shopId ? "&shop_id=" + encodeURIComponent(config.shopId) : "");
      var result = await tcFetchJson(pathname);
      var body = result.body;
      return body && body.sync_events || [];
    },
    getReservation: async function (id) {
      var result = await tcFetchJson("/api/booking/v1/reservations/" + encodeURIComponent(id), true);
      if (result.status === 404) return null;
      var body = result.body;
      return body && (body.reservation || body);
    },
  };
}

function handleMock(req, res, url, mock, reservationSync) {
  var parts = url.pathname.replace(/^\/api\/mock\//, "").split("/");
  if (parts[0] !== "reservations") { res.writeHead(404); return res.end("not found"); }
  var id = null;
  if (parts[1]) {
    try { id = decodeURIComponent(parts[1]); }
    catch (err) { return json(res, { ok: false, error: "invalid reservation id" }, 400); }
  }

  if (req.method === "GET" && !id) return json(res, mock.listReservations());
  if (req.method === "POST" && !id) {
    return readJson(req, res, function (body) {
      afterMutation(res, { ok: true, reservation: mock.createReservation(body || {}) }, reservationSync);
    });
  }
  if (req.method === "PATCH" && id) {
    return readJson(req, res, function (body) {
      var rec = mock.updateReservation(id, body || {});
      if (!rec) return json(res, { ok: false, error: "no such reservation" }, 404);
      afterMutation(res, { ok: true, reservation: rec }, reservationSync);
    });
  }
  if (req.method === "DELETE" && id) {
    var rec = mock.cancelReservation(id);
    if (!rec) return json(res, { ok: false, error: "no such reservation" }, 404);
    return afterMutation(res, { ok: true, reservation: rec }, reservationSync);
  }
  return json(res, { ok: false, error: "method not allowed" }, 405);
}

function afterMutation(res, payload, reservationSync) {
  reservationSync.enqueuePoll().then(function () {
    var stock = reservationSync.stockResponse(Date.now());
    payload.stock = stock.code === 200 ? stock.body : [];
    json(res, payload);
  });
}

function handleSeats(req, res, url, context) {
  if (url.pathname === "/api/seats" && req.method === "GET") {
    if (!context.reservationSync.health().ready) {
      return json(res, { ok: false, error: "initial reservation sync pending" }, 503);
    }
    return json(res, seats.toOccupiedSeats(
      context.reservationSync.storeSnapshot(),
      context.walkins,
      Date.now(),
      context.beforeMin,
      context.afterMin
    ));
  }
  if (url.pathname === "/api/seats" && req.method === "POST") {
    return readJson(req, res, function (body) {
      var occupancy = seats.registerWalkin(context.walkins, body && body.table, Date.now());
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
    if (!seats.releaseWalkin(context.walkins, table)) return json(res, { ok: false, error: "seat not found" }, 404);
    res.writeHead(204, { "Cache-Control": "no-store" });
    return res.end();
  }
  return json(res, { ok: false, error: "method not allowed" }, 405);
}

function json(res, obj, code) {
  res.writeHead(code || 200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(obj));
}

function serveFile(res, file) {
  fs.readFile(file, function (err, data) {
    if (err) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}

function readJson(req, res, cb) {
  var chunks = [], size = 0, ended = false;
  req.on("data", function (chunk) {
    if (ended) return;
    size += chunk.length;
    if (size > 1e6) {
      ended = true;
      json(res, { ok: false, error: "payload too large" }, 413);
      return req.destroy();
    }
    chunks.push(chunk);
  });
  req.on("end", function () {
    if (ended) return;
    ended = true;
    var raw = Buffer.concat(chunks).toString("utf8").trim();
    if (!raw) return cb({});
    try { cb(JSON.parse(raw)); }
    catch (err) { json(res, { ok: false, error: "invalid JSON" }, 400); }
  });
  req.on("error", function () {
    if (!ended) { ended = true; json(res, { ok: false, error: "read error" }, 400); }
  });
}

function defaultLog(message) {
  console.log("[relay " + new Date().toLocaleTimeString("ja-JP") + "] " + message);
}

if (require.main === module) createRelay().start();

module.exports = {
  createRelay: createRelay,
  createTableCheckSource: createTableCheckSource,
};
