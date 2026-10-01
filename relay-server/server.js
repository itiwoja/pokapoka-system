/**
 * server.js — ぽかぽか店内 中継サーバー (依存ほぼゼロ・Node 18+。printer.js の iconv-lite のみ例外 #144)
 *
 * 役割:
 *   1. リポジトリ直下の静的ファイルを配信
 *   2. Sync v1 を30秒間隔で取得し、予約変更を即時反映
 *   3. Booking v1 を起動時+15分間隔で全件取得し、当日storeを自己修復
 *   4. 初回全件取得が成功するまで /api/stock を503にしてKDSの誤削除を防止
 *   5. POST /api/print でチビ伝を実機プリンターへ中継(ブラウザは生ソケットを開けないため #144)
 *
 * このファイルが持つのは、部品の組み立て・認証・URLの振り分け・起動と停止だけ。
 * 各APIの処理は routes/、設定の解決は relay-config.js にある。
 *
 * 設定:
 *   接続先は config/config.json (config.example.json をコピーして作る)。
 *   優先順位は「既定値 < config/config.json < 環境変数」。
 *   APIキーだけは設定ファイルに置かず TABLECHECK_API_KEY で渡す。
 *
 * 起動:
 *   本番:   TABLECHECK_API_KEY=xxx node relay-server/server.js   (host/shopId は config.json)
 *   モック: MOCK=1 node relay-server/server.js
 *   WSS検証: TLS_CERT_FILE=cert.pem TLS_KEY_FILE=key.pem MOCK=1 MOCK_ORDER_SCENARIO=1 node relay-server/server.js
 */
"use strict";

var http = require("http");
var https = require("https");
var fs = require("fs");
var path = require("path");
var kitchen = require("./kitchen-state");
var auth = require("./auth");
var audit = require("./audit-log");
var booking = require("./booking-resync");
var loadConfig = require("./load-config");
var printer = require("./printer");
var createTableCheckSource = require("./tablecheck-source").createTableCheckSource;
var printerSettings = require("./printer-settings");
var attachOrdersWebSocket = require("./orders-websocket").attachOrdersWebSocket;
var createConfig = require("./relay-config").createConfig;
var httpUtil = require("./http-util");
var requestAudit = require("./request-audit");
var handleAudit = require("./routes/audit").handleAudit;
var handleKitchenState = require("./routes/kitchen").handleKitchenState;
var handleMock = require("./routes/mock").handleMock;
var handleOrders = require("./routes/orders").handleOrders;
var printRoutes = require("./routes/print");
var handleQrPage = require("./routes/qr-page").handleQrPage;
var handleSeats = require("./routes/seats").handleSeats;
var serveStatic = require("./routes/static").serveStatic;

var json = httpUtil.json;

function createRelay(options) {
  options = options || {};
  var env = options.env || process.env;
  var config = createConfig(env, options);
  var mock = options.mockSource || require("./mock-tablecheck");
  var printerModule = options.printer || printer;
  var log = options.log || defaultLog;
  var now = options.now || function () { return new Date(); };
  var fetchFn = options.fetch || globalThis.fetch;
  var setIntervalFn = options.setInterval || setInterval;
  var clearIntervalFn = options.clearInterval || clearInterval;
  var root = path.resolve(__dirname, "..");
  var auditLog = options.auditLog || audit.createAuditLog({
    filePath: options.auditLogPath || path.join(root, "config", "audit-log.jsonl"),
    retentionDays: options.auditRetentionDays,
    maxRecords: options.auditMaxRecords,
    now: options.auditNow,
    logger: {
      error: function (message, err) {
        log("audit: " + message + (err && err.message ? " (" + err.message + ")" : ""));
      },
    },
  });
  var timers = [];
  var inFlight = new Set();
  var walkins = new Map();
  // 厨房状態の共有 (#132)。sessionId は relay 再起動を端末側が検出するための識別子で、
  // 再起動すると rev が 0 に戻るため、これが無いと端末が「取込済み」と誤認する
  var kitchenState = kitchen.createState(options.sessionId || String(Date.now().toString(36)));
  var orders = new Map();      // 注文端末から受けた注文 (当日メモリのみ #115)
  var started = false;
  var initialSync = Promise.resolve();
  var slipStyle = printerSettings.createSlipStyleStore(options.slipStylePath || path.join(root, "config", "slip-style.json"), printerModule, log);
  var printerIp = printerSettings.createPrinterIpStore(options.printerIpPath || path.join(root, "config", "printer-ip.json"), printerModule, log);

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

  // TLS証明書を渡したときだけNode自身がHTTPS/WSSで待ち受ける (実機WSS検証用)。
  // 本番の推奨構成はリバースプロキシでの終端のまま。読めない証明書は起動前に止める
  var tlsOptions = config.tlsCertFile ? {
    cert: fs.readFileSync(path.resolve(root, config.tlsCertFile)),
    key: fs.readFileSync(path.resolve(root, config.tlsKeyFile)),
  } : null;
  var mockOrderScenario = null;

  var server = createListener(tlsOptions, function (req, res) {
    var url;
    try { url = new URL(req.url, "http://localhost"); }
    catch (err) { return httpUtil.text(res, 400, "bad request"); }

    var auditContext = authorize(req, res, url);
    if (auditContext) route(req, res, url, auditContext);
  });

  var orderStream = attachOrdersWebSocket(server, orders, config, log);

  /**
   * 共有トークン認証 (#174)。未設定なら素通し = 従来どおりの挙動。
   * ページもAPIもまとめて守る: ページだけ素通しにするとトークンを読み出されて意味がない。
   * 通してよければ監査用の文脈を返す。ここで応答を済ませた場合 (拒否・リダイレクト) は null。
   */
  function authorize(req, res, url) {
    var allowed = auth.check(req, url, config.authToken,
      req.socket && req.socket.remoteAddress, config.authTrustLoopback);
    if (!allowed.ok) {
      auditLog.record({
        operation: "auth.denied",
        target: "route:" + req.method + " " + requestAudit.auditRoute(url.pathname),
        result: "denied",
        actor: requestAudit.requestActor(req, "invalid"),
      });
      json(res, { ok: false, error: "unauthorized: " + allowed.reason }, 401);
      return null;
    }
    // GET/HEADのQR導線はCookieへ移した直後にclean URLへリダイレクトし、保護対象の
    // 本文をtoken付きURLでは返さない。Location・本文にもtoken値を残さない (#209)。
    if (allowed.setCookie) {
      var secureCookie = config.authCookieSecure === "1" ||
        (config.authCookieSecure === "auto" && !!(req.socket && req.socket.encrypted));
      res.setHeader("Set-Cookie", auth.cookieHeader(config.authToken, secureCookie));
      if (req.method === "GET" || req.method === "HEAD") {
        url.searchParams.delete("token");
        var cleanLocation = url.pathname + (url.searchParams.toString() ? "?" + url.searchParams.toString() : "");
        res.writeHead(303, {
          "Location": cleanLocation,
          "Cache-Control": "no-store",
          "Content-Length": "0",
        });
        res.end();
        return null;
      }
    }
    return { auditLog: auditLog, actor: requestAudit.requestActor(req, allowed.reason) };
  }

  function route(req, res, url, auditContext) {
    var pathname = url.pathname;

    if (pathname === "/api/stock") {
      var stock = reservationSync.stockResponse(Date.now());
      return json(res, stock.body, stock.code);
    }
    if (pathname === "/api/health") {
      return json(res, Object.assign({
        mode: config.isMock ? "mock" : "live",
        pollMs: config.pollMs,
        resyncMs: config.resyncMs,
        ordersStream: orderStream.stats(),
      }, reservationSync.health()));
    }
    if (pathname === "/api/audit") {
      return handleAudit(req, res, url, { auditLog: auditLog, authToken: config.authToken });
    }
    if (pathname === "/api/seats" || pathname.indexOf("/api/seats/") === 0) {
      return handleSeats(req, res, url, {
        reservationSync: reservationSync,
        walkins: walkins,
        beforeMin: config.seatBeforeMin,
        afterMin: config.seatAfterMin,
        walkinTtlMs: config.seatWalkinTtlMs,
        audit: auditContext,
      });
    }
    if (pathname === "/api/kitchen-state") {
      return handleKitchenState(req, res, { state: kitchenState, ttlMs: config.kitchenTtlMs, audit: auditContext });
    }
    if (pathname === "/api/orders" || pathname.indexOf("/api/orders/") === 0) {
      return handleOrders(req, res, url, { orders: orders, ttlMs: config.orderTtlMs, stream: orderStream, audit: auditContext });
    }

    var printContext = { printer: printerModule, slipStyle: slipStyle, printerIp: printerIp, audit: auditContext };
    if (pathname === "/api/print" && req.method === "POST") return printRoutes.handlePrint(req, res, printContext);
    if (pathname === "/api/printer") return printRoutes.handlePrinterIp(req, res, printContext);
    if (pathname === "/api/slip-style") return printRoutes.handleSlipStyle(req, res, printContext);

    if (pathname.indexOf("/api/mock/") === 0) {
      if (!config.isMock) return httpUtil.text(res, 403, "mock endpoints are disabled in LIVE mode");
      return handleMock(req, res, url, mock, reservationSync);
    }
    if (pathname === "/demo") return httpUtil.serveFile(res, path.join(__dirname, "tablecheck-demo.html"));
    if (pathname === "/qr") return handleQrPage(res, config, req.headers && req.headers.host);

    return serveStatic(res, url, root);
  }

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
      var baseUrl = (tlsOptions ? "https://" : "http://") + (config.host.includes(":") ? "[" + config.host + "]" : config.host) + ":" + listenPort;
      log("起動: " + baseUrl + "  (モード: " +
        (config.isMock ? "MOCK — デモ予約を配信" : "LIVE — TableCheck へ " + config.pollMs / 1000 + "秒間隔で pull") + ")");
      if (config.isMock) {
        if (env.SEED === "1") { mock.seed(); log("SEED=1: デモ予約を1件シード"); }
        log("デモ操作コンソール: " + baseUrl + "/demo");
        if (config.mockOrderScenario) {
          mockOrderScenario = require("./mock-order-scenario").startMockOrderScenario({
            orders: orders, refresh: orderStream.refresh, log: log,
          });
        }
      }
      log("KDS(デシャップ): " + baseUrl + "/  / 予約: /api/stock / 注文: /api/orders / 状態: /api/health");
      if (config.authToken) {
        log("認証: 有効 (他端末は /qr のQR経由で開く。ミニPC自身は" +
          (config.authTrustLoopback ? "認証なしで開ける" : "トークンが必要") + ")");
      } else {
        log("認証: 無効 — 到達できる端末なら誰でも操作できます。" +
          "店内Wi-Fiを客と共用しているなら config.json の auth.token を設定してください (#174)");
      }

      // 依存の欠落は起動を止めないが、現地で「印刷だけ効かない」の原因が分かるよう起動時に言う (#173)
      var deps = printRoutes.printerDependencies(printerModule);
      if (!deps.ok) {
        log("⚠ 実機印刷は無効: " + deps.error);
        log("⚠ 予約取込とKDS配信は通常どおり動きます (印刷を使うなら relay-server で npm install)");
      }

      initialSync = resyncThenPoll();
      timers = [
        setIntervalFn(pollTick, config.pollMs),
        setIntervalFn(resyncThenPoll, config.resyncMs),
      ];
    });
    return server;
  }

  function stop() {
    if (mockOrderScenario) mockOrderScenario.stop();
    mockOrderScenario = null;
    orderStream.close();
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
    kitchenState: kitchenState,
    orders: orders,
    start: start,
    stop: stop,
    pollTick: pollTick,
    resyncThenPoll: resyncThenPoll,
    whenInitialSync: function () { return initialSync; },
  };
}

function createListener(tlsOptions, handler) {
  return tlsOptions ? https.createServer(tlsOptions, handler) : http.createServer(handler);
}

function defaultLog(message) {
  console.log("[relay " + new Date().toLocaleTimeString("ja-JP") + "] " + message);
}

// 設定ファイルの読込は起動時のここだけ。createRelay() は値を注入で受け取るので、
// テストは各自の config/config.json に影響されない。
// 設定ミスは店舗やチーム間で起きる想定なので、スタックトレースではなく直す場所を示して止める。
if (require.main === module) {
  var configFile;
  try { configFile = loadConfig.load(); }
  catch (err) {
    console.error("[relay] 設定エラー: " + err.message);
    console.error("[relay] 雛形: config/config.example.json");
    process.exit(1);
  }
  createRelay({ configFile: configFile }).start();
}

module.exports = {
  createRelay: createRelay,
  createTableCheckSource: createTableCheckSource,
};
