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
 * 設定:
 *   接続先は config/config.json (config.example.json をコピーして作る)。
 *   優先順位は「既定値 < config/config.json < 環境変数」。
 *   APIキーだけは設定ファイルに置かず TABLECHECK_API_KEY で渡す。
 *
 * 起動:
 *   本番:   TABLECHECK_API_KEY=xxx node relay-server/server.js   (host/shopId は config.json)
 *   モック: MOCK=1 node relay-server/server.js
 */
"use strict";

var http = require("http");
var fs = require("fs");
var os = require("os");
var path = require("path");
var seats = require("./seat-occupancy");
var kitchen = require("./kitchen-state");
var orderIntake = require("./order-intake");
var auth = require("./auth");
var booking = require("./booking-resync");
var loadConfig = require("./load-config");
var printer = require("./printer");

/* qrcode は /qr ページ専用なので、トップレベルでは読み込まない (#173)。
   npm install が済んでいない店内ミニPCで、QRページのためにサーバー全体
   (予約取込・KDS配信) を起動不能にしないため */
var qrcodeModule = null;
function loadQRCode() {
  if (!qrcodeModule) qrcodeModule = require("qrcode");
  return qrcodeModule;
}

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
  var printerModule = options.printer || printer;
  var log = options.log || defaultLog;
  var now = options.now || function () { return new Date(); };
  var fetchFn = options.fetch || globalThis.fetch;
  var setIntervalFn = options.setInterval || setInterval;
  var clearIntervalFn = options.clearInterval || clearInterval;
  var root = path.resolve(__dirname, "..");
  var allowedStaticFiles = [
    "kds-a-grid.html",
    "slip-style-designer.html",   // 印刷スタイル設定ツール。KDSと同一オリジンで配信しlocalStorageを共有する
    "slip-renderer.js",           // 伝票レイアウトの描画エンジン。フォーマッターとKDSで同じ絵を出すため共有する
    path.join("relay-server", "kds-bridge.js"),
  ];
  var timers = [];
  var inFlight = new Set();
  var walkins = new Map();
  // 厨房状態の共有 (#132)。sessionId は relay 再起動を端末側が検出するための識別子で、
  // 再起動すると rev が 0 に戻るため、これが無いと端末が「取込済み」と誤認する
  var kitchenState = kitchen.createState(options.sessionId || String(Date.now().toString(36)));
  var orders = new Map();      // 注文端末から受けた注文 (当日メモリのみ #115)
  var started = false;
  var initialSync = Promise.resolve();
  var slipStyle = createSlipStyleStore(options.slipStylePath || path.join(root, "config", "slip-style.json"), printerModule, log);
  var printerIp = createPrinterIpStore(options.printerIpPath || path.join(root, "config", "printer-ip.json"), printerModule, log);

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

    /* 共有トークン認証 (#174)。未設定なら素通し = 従来どおりの挙動。
       ページもAPIもまとめて守る: ページだけ素通しにするとトークンを読み出されて意味がない */
    var allowed = auth.check(req, url, config.authToken,
      req.socket && req.socket.remoteAddress, config.authTrustLoopback);
    if (!allowed.ok) {
      res.writeHead(401, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({ ok: false, error: "unauthorized: " + allowed.reason }));
    }
    // QR経由(?token=)で来た端末には Cookie を渡す。以後はURLにトークンが要らない
    if (allowed.setCookie) res.setHeader("Set-Cookie", auth.cookieHeader(config.authToken));

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
        walkinTtlMs: config.seatWalkinTtlMs,
      });
    }

    if (url.pathname === "/api/kitchen-state") {
      return handleKitchenState(req, res, { state: kitchenState, ttlMs: config.kitchenTtlMs });
    }

    if (url.pathname === "/api/orders" || url.pathname.indexOf("/api/orders/") === 0) {
      return handleOrders(req, res, url, { orders: orders, ttlMs: config.orderTtlMs });
    }

    if (url.pathname === "/api/print" && req.method === "POST") {
      return handlePrint(req, res, printerModule, slipStyle, printerIp);
    }

    /* プリンターIP (#144追補)。スタイル同様サーバー保存にして、どの端末のKDSからでも
       登録なしで実機印刷できるようにする(iPadで再入力不要) */
    if (url.pathname === "/api/printer") {
      if (req.method === "GET") return json(res, { ip: printerIp.get() });
      if (req.method === "POST") {
        return readJson(req, res, function (body) {
          var ip = body && body.ip != null ? String(body.ip).trim() : "";
          if (ip && !printerModule.isPrivateIPv4(ip)) {
            return json(res, { ok: false, error: "printer ip must be a private LAN IPv4 address" }, 400);
          }
          printerIp.set(ip);   // 空文字は「未設定に戻す」
          return json(res, { ok: true, ip: ip });
        });
      }
      res.writeHead(405);
      return res.end("method not allowed");
    }

    /* 印刷スタイル (#144追補)。サーバー保存にすることで、設定した端末に関係なく
       KDSを開いた全端末(PC/iPad)が同じスタイルで印刷できる */
    if (url.pathname === "/api/slip-style") {
      if (req.method === "GET") return json(res, slipStyle.get());
      if (req.method === "POST") {
        return readJson(req, res, function (body) {
          json(res, { ok: true, style: slipStyle.set(body) });
        });
      }
      res.writeHead(405);
      return res.end("method not allowed");
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
    /* iPad等の他端末からの接続用QRを表示するページ (#144追補)。
       エンコードするURLは「今この端末が実際に他端末から見えるアドレス」を使う:
       LAN IPで待ち受けていればそのIP、127.0.0.1待ち受けならLAN IPを検出して案内する */
    if (url.pathname === "/qr") {
      return handleQrPage(res, config, req.headers && req.headers.host);
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
      log("KDS(デシャップ): http://127.0.0.1:" + listenPort + "/  / 予約: /api/stock / 注文: /api/orders / 状態: /api/health");
      if (config.authToken) {
        log("認証: 有効 (他端末は /qr のQR経由で開く。ミニPC自身は" +
          (config.authTrustLoopback ? "認証なしで開ける" : "トークンが必要") + ")");
      } else {
        log("認証: 無効 — 到達できる端末なら誰でも操作できます。" +
          "店内Wi-Fiを客と共用しているなら config.json の auth.token を設定してください (#174)");
      }

      // 依存の欠落は起動を止めないが、現地で「印刷だけ効かない」の原因が分かるよう起動時に言う (#173)
      var deps = printerModule.checkDependencies ? printerModule.checkDependencies() : { ok: true };
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

function createConfig(env, options) {
  // 既定値 < config/config.json < 環境変数。ファイル由来の値も env と同じ経路を通るので、
  // 下限クランプや HTTPS 検証はどちらから来た値にも等しく効く。
  var src = loadConfig.mergeEnv(options.configFile || {}, env);
  var apiKey = src.TABLECHECK_API_KEY || "";
  var isMock = src.MOCK === "1" || !apiKey;
  var shopId = src.SHOP_ID || "";
  var base = src.TABLECHECK_BASE || "https://api.tablecheck.com";
  if (!isMock && !shopId) throw new Error("SHOP_ID is required in LIVE mode");
  if (!isMock) validateTableCheckBase(base, src.TABLECHECK_ALLOW_CUSTOM_BASE === "1");
  var pollMs = normalizeInterval(src.POLL_MS, isMock ? 3000 : 30000, isMock ? 100 : 30000);
  var resyncMs = normalizeInterval(src.RESYNC_MS, 900000, isMock ? 1000 : 60000);
  return {
    port: options.port !== undefined ? options.port : (Number(src.PORT) || 8000),
    host: resolveHost(src.HOST),
    apiKey: apiKey,
    shopId: shopId,
    base: base,
    isMock: isMock,
    pollMs: pollMs,
    resyncMs: resyncMs,
    requestTimeoutMs: normalizeInterval(src.TABLECHECK_TIMEOUT_MS, 15000, 1000, 120000),
    seatBeforeMin: Math.max(Number(src.SEAT_BEFORE_MIN) || 30, 0),
    seatAfterMin: Math.max(Number(src.SEAT_AFTER_MIN) || 120, 0),
    // ローカル登録した占有をいつ諦めるか。POS連携が無く「退店した」というイベントが
    // 存在しないため、解除し忘れた席が永久に埋まったままにならないよう時間で切る (#123)
    seatWalkinTtlMs: normalizeInterval(src.SEAT_WALKIN_TTL_MIN, 120, 1, 1440) * 60000,
    // 厨房状態(#132)を最後の更新から何分保持するか。常駐プロセスなので、
    // 掃除しないと前日の完了・コンロ状態が翌日へ持ち越される (#115)
    kitchenTtlMs: normalizeInterval(src.KITCHEN_TTL_MIN, 720, 1, 1440) * 60000,
    // 注文の保持上限。常駐プロセスなので、掃除しないと日跨ぎで前日の注文が残る (#115)
    orderTtlMs: normalizeInterval(src.ORDER_TTL_MIN, 720, 1, 1440) * 60000,
    // 未設定なら認証なし (従来どおり)。店内Wi-Fiを客と共用する場合に設定する (#174)
    authToken: auth.normalizeToken(src.RELAY_TOKEN),
    // ミニPC自身(ループバック)を信頼するか。既定は信頼する — QRでトークンを配る導線が
    // ミニPC上の /qr から始まるため。ミニPCを他人が触る運用なら 0 にする
    authTrustLoopback: src.RELAY_TRUST_LOOPBACK !== "0",
  };
}

/**
 * 待ち受けホストの解決。"auto" なら今のLAN IPv4を検出して使う (#144追補)。
 * 店/自宅などWi-Fiが変わるとIPも変わるため、config.json に実IPを書くと陳腐化する。
 * "auto" にしておけば起動のたびに正しいIPで待ち受け、iPad等の他端末から届く。
 * 0.0.0.0(全IF)は使わない方針のまま(検出できないときは従来どおり 127.0.0.1)。
 */
function resolveHost(value) {
  if (!value) return "127.0.0.1";
  if (value !== "auto") return value;
  return detectLanIp() || "127.0.0.1";
}

/** 今のLAN IPv4 (ループバック・リンクローカル除外。Wi-Fi優先) */
function detectLanIp() {
  var ifaces = os.networkInterfaces();
  var candidates = [];
  Object.keys(ifaces).forEach(function (name) {
    (ifaces[name] || []).forEach(function (addr) {
      if (addr.family !== "IPv4" || addr.internal) return;
      if (addr.address.indexOf("169.254.") === 0) return;
      candidates.push({ name: name, address: addr.address });
    });
  });
  var wifi = candidates.filter(function (c) { return /wi-?fi|wlan|無線/i.test(c.name); });
  var hit = wifi[0] || candidates[0];
  return hit ? hit.address : null;
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

/** GET /qr — iPadでKDS/スタイル設定を開くQRコードのページ (#144追補) */
function handleQrPage(res, config, hostHeader) {
  // このページを開いた端末が実際に到達したアドレス(Hostヘッダ)を最優先で使う。
  // PCが有線とWi-Fiの両方に繋がっていると、待ち受けアドレス(config.host)を埋めた場合に
  // 「iPadからは届かない側のIP」が載ったQRになる。0.0.0.0待ち受けではURLごと壊れる
  var fromHeader = typeof hostHeader === "string" ? hostHeader.trim() : "";
  var usable = fromHeader &&
    !/^(0\.0\.0\.0|\[?::\]?)(:\d+)?$/.test(fromHeader) &&
    !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(fromHeader);

  var base, reachable;
  if (usable) {
    base = "http://" + fromHeader;                  // Hostヘッダはポートを含む
    reachable = true;
  } else {
    var isLoopback = config.host === "127.0.0.1" || config.host === "localhost";
    var lanIp = isLoopback ? detectLanIp() : config.host;
    if (lanIp === "0.0.0.0" || lanIp === "::") lanIp = detectLanIp();
    reachable = !!lanIp && lanIp !== "127.0.0.1";   // 127.0.0.1待ち受けでは他端末から届かない
    base = "http://" + (lanIp || "127.0.0.1") + ":" + config.port;
  }
  // 認証有効時は QR にトークンを載せる。iPad は1回読めば Cookie が入り、以後は不要 (#174)
  var tokenQuery = config.authToken ? "?token=" + encodeURIComponent(config.authToken) : "";
  var kdsUrl = base + "/" + tokenQuery;
  var styleUrl = base + "/slip-style-designer.html" + tokenQuery;
  var QRCode;
  try { QRCode = loadQRCode(); }
  catch (err) {
    // 依存が入っていないだけ。原因が現地で分かるよう理由を返す (サーバー本体は動き続ける #173)。
    // QRが出せなくても、トークン付きURLを本文に出せば手入力で繋げる (#174)
    res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("QRページは qrcode パッケージが必要です。relay-server で npm install を実行してください。\n" +
      "接続先URL: " + kdsUrl + "\n");
  }
  Promise.all([
    QRCode.toDataURL(kdsUrl, { width: 420, margin: 2 }),
    QRCode.toDataURL(styleUrl, { width: 420, margin: 2 }),
  ]).then(function (imgs) {
    var warn = reachable ? "" :
      '<p class="warn">⚠ いまサーバーは 127.0.0.1(このPC専用)で待ち受けているため、iPadからは届きません。' +
      'config/config.json の server.host を "auto" にして再起動してください。</p>';
    var html = '<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<title>iPad接続用QR</title><style>' +
      'body{font-family:sans-serif;background:#f4f1ec;color:#1a1612;text-align:center;padding:24px;margin:0}' +
      'h1{font-size:20px}h2{font-size:15px;margin:8px 0 4px}' +
      '.qr{display:inline-block;background:#fff;border:1px solid #ddd6cc;border-radius:8px;padding:16px;margin:12px}' +
      '.qr img{display:block;width:280px;height:280px}' +
      '.url{font-size:13px;color:#6b6258;word-break:break-all}' +
      '.warn{background:#fbeaea;color:#7a1f1f;border:1px solid #e3b8b8;border-radius:6px;padding:10px;max-width:560px;margin:12px auto}' +
      '</style></head><body>' +
      '<h1>iPadのカメラでQRを読むと開きます</h1>' + warn +
      '<div class="qr"><h2>KDS(厨房画面)</h2><img src="' + imgs[0] + '" alt="KDSを開くQR"><div class="url">' + kdsUrl + '</div></div>' +
      '<div class="qr"><h2>印刷スタイル設定</h2><img src="' + imgs[1] + '" alt="スタイル設定を開くQR"><div class="url">' + styleUrl + '</div></div>' +
      '<p class="url">iPadはこのPCと同じWi-Fiにつないでください</p>' +
      '</body></html>';
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  }).catch(function (err) {
    res.writeHead(500);
    res.end("QR生成に失敗しました: " + err.message);
  });
}

/**
 * 印刷スタイルの保存領域 (#144追補)。printer.normalizeStyle で許容値へ丸めてから
 * メモリ+ファイル(config/slip-style.json)に保持する。ファイルは再起動しても設定が
 * 残るようにするためで、環境ごとに値が違うので git 管理しない。
 */
function createSlipStyleStore(filePath, printerModule, log) {
  var MAX_TEMPLATE_BYTES = 50000;

  /* 自由配置レイアウト(elements[])は描画がブラウザ側なので、サーバーは中身を解釈しない。
     形(配列であること)とサイズだけ検査してそのまま預かる。旧テキスト型は従来どおり丸める */
  function accept(raw) {
    if (raw && typeof raw === "object" && Array.isArray(raw.elements)) {
      var json = JSON.stringify(raw);
      if (json.length > MAX_TEMPLATE_BYTES) {
        log("slip-style: レイアウトが大きすぎるため保存しません (" + json.length + " bytes)");
        return null;
      }
      return JSON.parse(json);
    }
    return printerModule.normalizeStyle(raw);
  }

  var current = null;
  try {
    current = accept(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch (e) { current = null; }  // 無い・壊れているときは未設定扱い
  return {
    get: function () { return current || {}; },
    set: function (body) {
      var next = accept(body);
      if (!next) return current || {};   // 上限超過。既存の設定は壊さない
      current = next;
      try { fs.writeFileSync(filePath, JSON.stringify(current, null, 2) + "\n", "utf8"); }
      catch (err) { log("slip-style の保存に失敗(メモリ上は反映済み): " + err.message); }
      return current;
    },
  };
}

/** プリンターIPの保存領域 (#144追補)。空文字=未設定。ファイルはgit管理外 */
function createPrinterIpStore(filePath, printerModule, log) {
  var current = "";
  try {
    var loaded = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (loaded && printerModule.isPrivateIPv4(loaded.ip)) current = loaded.ip;
  } catch (e) {}
  return {
    get: function () { return current; },
    set: function (ip) {
      current = ip || "";
      try { fs.writeFileSync(filePath, JSON.stringify({ ip: current }, null, 2) + "\n", "utf8"); }
      catch (err) { log("printer-ip の保存に失敗(メモリ上は反映済み): " + err.message); }
    },
  };
}

/** POST /api/print — チビ伝を実機プリンターへ送る (#144)。IPは店内LANのプライベートアドレスのみ許可 */
function handlePrint(req, res, printerModule, slipStyle, printerIp) {
  // 依存(iconv-lite)が入っていなければ、原因の分かる 503 で返す (#173)。
  // KDS 側は非200で window.print() にフォールバックするので、印刷操作自体は止まらない
  var deps = printerModule.checkDependencies ? printerModule.checkDependencies() : { ok: true };
  if (!deps.ok) return json(res, { ok: false, error: deps.error }, 503);

  readJson(req, res, function (body) {
    // ip未指定はサーバー保存のプリンターIP(/api/printer)を使う。端末ごとの再登録を不要にする
    var ip = (body && body.ip) || (printerIp && printerIp.get());
    if (!printerModule.isPrivateIPv4(ip)) {
      return json(res, { ok: false, error: "printer ip must be a private LAN IPv4 address" }, 400);
    }
    var buffer;
    // ラスター(画像)が付いていれば画像として印字する。自由配置レイアウトの経路で、
    // プリンター内蔵フォントを使わないぶん書体・位置の制限が無い
    var raster = printerModule.normalizeRaster(body);
    if (raster) {
      try {
        buffer = printerModule.buildRaster(raster, {
          feedLines: body && body.feedLines,
          emulation: body && body.emulation,
        });
      } catch (err) {
        return json(res, { ok: false, error: "failed to build raster job: " + err.message }, 500);
      }
    } else {
      if (body && body.raster) {
        // 寸法とデータ長が食い違うラスターは、黙ってテキスト印字に落ちると
        // 「何か出たが別物」になって原因が分かりにくい。ここで明示的に弾く
        return json(res, { ok: false, error: "invalid raster (width/height and data length do not match)" }, 400);
      }
      // style未指定はサーバー保存のスタイル(/api/slip-style)を使う。どの端末から印刷しても同じ見た目になる。
      // ただし保存されているのが自由配置レイアウトの場合、テキスト印字では解釈できないので使わない
      var saved = slipStyle ? slipStyle.get() : null;
      if (body && body.style == null && saved && !Array.isArray(saved.elements)) body.style = saved;
      var job = printerModule.normalizeJob(body);
      try { buffer = printerModule.buildEscPos(job); }
      catch (err) { return json(res, { ok: false, error: "failed to build print job: " + err.message }, 500); }
    }
    printerModule.sendToPrinter(ip, buffer).then(function () {
      json(res, { ok: true });
    }).catch(function (err) {
      json(res, { ok: false, error: String(err && err.message || err) }, 502);
    });
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
      context.afterMin,
      context.walkinTtlMs
    ));
  }
  if (url.pathname === "/api/seats" && req.method === "POST") {
    return readJson(req, res, function (body) {
      // rid があれば「予約の着席」。卓番はスタッフが KDS で割り当てるローカルデータで、
      // TableCheck 側には無い(あっても希望席種まで)ため、ここが唯一の正本になる
      var occupancy = seats.registerWalkin(context.walkins, body && body.table, Date.now(), body);
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

/**
 * 厨房状態の端末間共有 (#132)。
 * 端末は「自分が起こした変更イベント」を POST し、「全体のスナップショット」を GET で取り込む。
 * 差分ではなく畳み込み済みの状態を返すので、遅れて起動した端末も1回の取得で追いつける。
 */
function handleKitchenState(req, res, context) {
  if (req.method === "GET") {
    kitchen.purgeStale(context.state, Date.now(), context.ttlMs);
    return json(res, kitchen.snapshot(context.state));
  }
  if (req.method === "POST") {
    return readJson(req, res, function (body) {
      kitchen.purgeStale(context.state, Date.now(), context.ttlMs);
      var result = kitchen.applyEvents(context.state, body && body.events, Date.now());
      if (result.error) return json(res, { ok: false, error: result.error }, 400);
      return json(res, { ok: true, rev: result.rev, sessionId: context.state.sessionId });
    });
  }
  return json(res, { ok: false, error: "method not allowed" }, 405);
}

/**
 * 注文端末 → relay → KDS の受け口 (#139)。
 * 卓番はペイロードで受け取る (送信元IPからは引かない)。
 * 同じ orderId の同一内容は冪等再送、内容差分は既存注文の更新として扱う。
 */
function handleOrders(req, res, url, context) {
  if (url.pathname === "/api/orders" && req.method === "GET") {
    return json(res, orderIntake.toFeed(context.orders, Date.now(), context.ttlMs));
  }
  if (url.pathname === "/api/orders" && req.method === "POST") {
    return readJson(req, res, function (body) {
      var result = orderIntake.normalizeOrder(body, Date.now());
      if (result.error) return json(res, { ok: false, error: result.error }, 400);
      var put = orderIntake.putOrder(context.orders, result.order);
      // 冪等再送も更新も成功として返す。注文端末は duplicate / updated で結果を識別できる。
      return json(res, {
        ok: true,
        duplicate: put.duplicate,
        updated: put.updated,
        order: put.order,
      }, put.created ? 201 : 200);
    });
  }
  if (url.pathname.indexOf("/api/orders/") === 0 && req.method === "DELETE") {
    var raw = url.pathname.slice("/api/orders/".length);
    var orderId;
    try { orderId = decodeURIComponent(raw); }
    catch (e) { return json(res, { ok: false, error: "invalid orderId" }, 400); }
    if (!orderIntake.validateOrderId(orderId)) return json(res, { ok: false, error: "invalid orderId" }, 400);
    if (!orderIntake.removeOrder(context.orders, orderId)) return json(res, { ok: false, error: "order not found" }, 404);
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
