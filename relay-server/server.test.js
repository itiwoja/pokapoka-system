"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("node:path");
var childProcess = require("node:child_process");
var http = require("node:http");
var events = require("node:events");
var serverModule = require("./server");
var printerModule = require("./printer");

test("server.js はimportだけでlistenせずcreateRelayを公開する", function () {
  var serverPath = path.join(__dirname, "server.js");
  var script = "var relay=require(" + JSON.stringify(serverPath) + ");" +
    "if(typeof relay.createRelay!=='function')process.exit(2);";
  var result = childProcess.spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    timeout: 1000,
  });

  assert.notEqual(result.error && result.error.code, "ETIMEDOUT", "import時にサーバーが常駐している");
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("印刷用の依存が無くてもサーバーは起動し、予約取込とKDS配信は生き残る", function () {
  // 現地で `npm install` が済んでいない状態を、モジュール解決を差し替えて再現する (#173)。
  // 以前はトップレベル require だったため、この状態でプロセスごと起動不能になっていた
  var serverPath = path.join(__dirname, "server.js");
  var script = [
    "var Module = require('module');",
    "var orig = Module._resolveFilename;",
    "Module._resolveFilename = function (request) {",
    "  if (request === 'iconv-lite' || request === 'qrcode') {",
    "    var e = new Error(\"Cannot find module '\" + request + \"'\"); e.code = 'MODULE_NOT_FOUND'; throw e;",
    "  }",
    "  return orig.apply(this, arguments);",
    "};",
    "var http = require('http');",
    "var relay = require(" + JSON.stringify(serverPath) + ").createRelay({",
    "  port: 0, env: { MOCK: '1' }, mockSource: {}, log: function () {},",
    "  source: { listReservations: async function () { return []; },",
    "            listSyncEvents: async function () { return []; },",
    "            getReservation: async function () { return null; } },",
    "});",
    "relay.start();",
    "relay.server.on('listening', async function () {",
    "  await relay.whenInitialSync();",
    "  var port = relay.server.address().port;",
    "  function req(pathname, method, body) {",
    "    return new Promise(function (resolve) {",
    "      var r = http.request({ host: '127.0.0.1', port: port, path: pathname, method: method || 'GET' },",
    "        function (res) { res.resume(); res.on('end', function () { resolve(res.statusCode); }); });",
    "      if (body) r.write(body);",
    "      r.end();",
    "    });",
    "  }",
    "  var out = {",
    "    stock: await req('/api/stock'),",
    "    kds: await req('/'),",
    "    health: await req('/api/health'),",
    "    print: await req('/api/print', 'POST', JSON.stringify({ ip: '192.168.1.50', table: '1', items: [] })),",
    "    qr: await req('/qr'),",
    "  };",
    "  console.log(JSON.stringify(out));",
    "  await relay.stop();",
    "});",
  ].join("\n");

  var result = childProcess.spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  var out = JSON.parse(String(result.stdout).trim().split("\n").pop());
  assert.equal(out.stock, 200, "予約配信が依存欠落に巻き込まれている");
  assert.equal(out.kds, 200, "KDS配信が依存欠落に巻き込まれている");
  assert.equal(out.health, 200);
  assert.equal(out.print, 503, "印刷は理由付きの503で断るべき (KDSはwindow.print()へフォールバックする)");
  assert.equal(out.qr, 503, "QRページも理由付きの503で断るべき");
});

function rawReservation(id) {
  var startAt = new Date();
  startAt.setHours(18, 30, 0, 0);
  return {
    id: id,
    start_at: startAt.toISOString(),
    status: "confirmed",
    first_name: "太郎",
    last_name: "山田",
    pax_adult: 2,
    orders: [{ menu_item_name_translations: { ja: "土鍋御膳" }, qty: 1 }],
  };
}

function requestJson(server, pathname) {
  var address = server.address();
  return new Promise(function (resolve, reject) {
    http.get({ host: "127.0.0.1", port: address.port, path: pathname }, function (res) {
      var chunks = [];
      res.on("data", function (chunk) { chunks.push(chunk); });
      res.on("end", function () {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        } catch (err) { reject(err); }
      });
    }).on("error", reject);
  });
}

function requestRaw(server, pathname, options) {
  options = options || {};
  var address = server.address();
  return new Promise(function (resolve, reject) {
    var req = http.request({
      host: "127.0.0.1",
      port: address.port,
      path: pathname,
      method: options.method || "GET",
      headers: options.headers || {},
    }, function (res) {
      var chunks = [];
      res.on("data", function (chunk) { chunks.push(chunk); });
      res.on("end", function () {
        resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") });
      });
    });
    req.on("error", reject);
    if (options.body != null) req.write(options.body);
    req.end();
  });
}

function createTestRelay(source, intervalCalls) {
  return serverModule.createRelay({
    port: 0,
    env: { MOCK: "1", POLL_MS: "3000", RESYNC_MS: "900000" },
    source: source,
    mockSource: {},
    log: function () {},
    setInterval: function (fn, ms) {
      intervalCalls.push({ fn: fn, ms: ms });
      return intervalCalls.length;
    },
    clearInterval: function () {},
  });
}

test("トークン認証は401を維持し、QRのGET/HEADはCookie発行後clean URLへリダイレクトする", async function (t) {
  var TOKEN = "pokapoka-kitchen-2026";
  var resolveReservations;
  // RELAY_TRUST_LOOPBACK=0 でループバック免除を切り、127.0.0.1 から「他端末」として叩く
  var relay = serverModule.createRelay({
    port: 0,
    env: { MOCK: "1", POLL_MS: "3000", RESYNC_MS: "900000", RELAY_TOKEN: TOKEN, RELAY_TRUST_LOOPBACK: "0" },
    source: {
      listReservations: function () { return new Promise(function (resolve) { resolveReservations = resolve; }); },
      listSyncEvents: async function () { return []; },
      getReservation: async function () { return null; },
    },
    mockSource: {},
    log: function () {},
    setInterval: function () { return 0; },
    clearInterval: function () {},
  });
  t.after(function () { return relay.stop(); });
  relay.start();
  await events.once(relay.server, "listening");
  resolveReservations([]);
  await relay.whenInitialSync();

  // トークン無し: ページも API も通らない
  assert.equal((await requestRaw(relay.server, "/")).status, 401);
  assert.equal((await requestRaw(relay.server, "/api/stock")).status, 401);
  assert.equal((await requestRaw(relay.server, "/api/seats", {
    method: "POST", body: JSON.stringify({ table: "5" }), headers: { "Content-Type": "application/json" },
  })).status, 401, "書き込みが素通りしている");
  assert.equal((await requestRaw(relay.server, "/api/seats/5", { method: "DELETE" })).status, 401);

  // 疎通診断のための /api/health だけは開けておく
  assert.equal((await requestRaw(relay.server, "/api/health")).status, 200);

  // Authorization ヘッダ
  assert.equal((await requestRaw(relay.server, "/api/stock", {
    headers: { Authorization: "Bearer " + TOKEN },
  })).status, 200);

  // QR経由: Cookieへ移したら、保護対象の本文を返さずtokenだけ除いたURLへ遷移する
  var viaQuery = await requestRaw(relay.server,
    "/kds-a-grid.html?view=compact&token=" + encodeURIComponent(TOKEN) + "&table=5", {
      headers: { "X-Forwarded-Proto": "https" },
    });
  assert.equal(viaQuery.status, 303);
  assert.equal(viaQuery.headers.location, "/kds-a-grid.html?view=compact&table=5");
  assert.equal(viaQuery.text, "", "token付きリクエストで保護対象の本文を配信しない");
  assert.doesNotMatch(String(viaQuery.headers.location), new RegExp(TOKEN));
  assert.doesNotMatch(viaQuery.text, new RegExp(TOKEN));
  var cookie = String(viaQuery.headers["set-cookie"]);
  assert.match(cookie, /relay_token=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /Max-Age=\d+/);
  assert.match(cookie, /SameSite=Lax/);
  assert.doesNotMatch(cookie, /; Secure/, "任意の転送ヘッダからSecureを推測しない");

  var viaHead = await requestRaw(relay.server, "/?keep=yes&token=" + encodeURIComponent(TOKEN), { method: "HEAD" });
  assert.equal(viaHead.status, 303);
  assert.equal(viaHead.headers.location, "/?keep=yes");
  assert.equal(viaHead.text, "");

  // 以後は Cookie だけで通る
  assert.equal((await requestRaw(relay.server, "/api/stock", {
    headers: { Cookie: "relay_token=" + encodeURIComponent(TOKEN) },
  })).status, 200);

  // 間違ったトークンは通さない
  assert.equal((await requestRaw(relay.server, "/api/stock", {
    headers: { Authorization: "Bearer wrong-token-value" },
  })).status, 401);

  // query tokenが明示された場合、その不正値を有効なCookieで迂回できない
  assert.equal((await requestRaw(relay.server, "/?token=wrong-token-value", {
    headers: { Cookie: "relay_token=" + encodeURIComponent(TOKEN) },
  })).status, 401);
});

test("RELAY_COOKIE_SECURE=1ならHTTPバックエンドでもSecure Cookieを明示発行できる", async function (t) {
  var TOKEN = "pokapoka-kitchen-2026";
  var relay = serverModule.createRelay({
    port: 0,
    env: { MOCK: "1", RELAY_TOKEN: TOKEN, RELAY_TRUST_LOOPBACK: "0", RELAY_COOKIE_SECURE: "1" },
    source: {
      listReservations: async function () { return []; },
      listSyncEvents: async function () { return []; },
      getReservation: async function () { return null; },
    },
    mockSource: {}, log: function () {}, setInterval: function () { return 0; }, clearInterval: function () {},
  });
  t.after(function () { return relay.stop(); });
  relay.start();
  await events.once(relay.server, "listening");
  await relay.whenInitialSync();

  var response = await requestRaw(relay.server, "/?token=" + encodeURIComponent(TOKEN));
  assert.equal(response.status, 303);
  assert.match(String(response.headers["set-cookie"]), /; Secure$/);

  var qr = await requestRaw(relay.server, "/qr", {
    headers: { Host: "relay.example.test", Authorization: "Bearer " + TOKEN },
  });
  assert.equal(qr.status, 200);
  assert.match(qr.text, /https:\/\/relay\.example\.test\//);
  assert.doesNotMatch(qr.text, /http:\/\/relay\.example\.test\//,
    "Secure Cookie運用のQRが平文HTTPへtokenを送っている");
});

test("トークン未設定なら従来どおり認証なしで通る", async function (t) {
  var resolveReservations;
  var relay = createTestRelay({
    listReservations: function () { return new Promise(function (resolve) { resolveReservations = resolve; }); },
    listSyncEvents: async function () { return []; },
    getReservation: async function () { return null; },
  }, []);
  t.after(function () { return relay.stop(); });
  relay.start();
  await events.once(relay.server, "listening");
  resolveReservations([]);
  await relay.whenInitialSync();

  assert.equal((await requestRaw(relay.server, "/")).status, 200);
  assert.equal((await requestRaw(relay.server, "/api/stock")).status, 200);
  assert.equal((await requestRaw(relay.server, "/api/audit")).status, 403,
    "認証無効時に監査ログをHTTP公開しない");
});

test("初回全件リシンク中は/api/stockが503、成功後は200になる", async function (t) {
  var resolveReservations;
  var intervalCalls = [];
  var relay = createTestRelay({
    listReservations: function () {
      return new Promise(function (resolve) { resolveReservations = resolve; });
    },
    listSyncEvents: async function () { return []; },
    getReservation: async function () { return null; },
  }, intervalCalls);
  t.after(function () { return relay.stop(); });

  relay.start();
  await events.once(relay.server, "listening");
  assert.deepEqual(await requestJson(relay.server, "/api/stock"), {
    status: 503,
    body: { ok: false, error: "initial reservation sync pending" },
  });

  resolveReservations([rawReservation("r1")]);
  await relay.whenInitialSync();
  var stock = await requestJson(relay.server, "/api/stock");
  assert.equal(stock.status, 200);
  assert.deepEqual(stock.body.map(function (r) { return r.rid; }), ["r1"]);

  var health = await requestJson(relay.server, "/api/health");
  assert.equal(health.body.ready, true);
  assert.equal(health.body.resyncMs, 900000);
  assert.deepEqual(intervalCalls.map(function (call) { return call.ms; }), [3000, 900000]);
});

test("初回失敗中の30秒tickは全件リシンクを再試行する", async function (t) {
  var attempts = 0;
  var relay = createTestRelay({
    listReservations: async function () {
      attempts++;
      if (attempts === 1) throw new Error("temporary failure");
      return [];
    },
    listSyncEvents: async function () { return []; },
    getReservation: async function () { return null; },
  }, []);
  t.after(function () { return relay.stop(); });

  relay.start();
  await events.once(relay.server, "listening");
  await relay.whenInitialSync();
  assert.equal((await requestJson(relay.server, "/api/stock")).status, 503);

  await relay.pollTick();
  assert.equal(attempts, 2);
  assert.deepEqual(await requestJson(relay.server, "/api/stock"), { status: 200, body: [] });
});

test("厨房状態APIはイベントを畳み込み、別端末が1回の取得で追いつける", async function (t) {
  var resolveReservations;
  var relay = createTestRelay({
    listReservations: function () {
      return new Promise(function (resolve) { resolveReservations = resolve; });
    },
    listSyncEvents: async function () { return []; },
    getReservation: async function () { return null; },
  }, []);
  t.after(function () { return relay.stop(); });
  relay.start();
  await events.once(relay.server, "listening");

  function push(payload) {
    return requestRaw(relay.server, "/api/kitchen-state", {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
    });
  }
  function snapshot() {
    return requestRaw(relay.server, "/api/kitchen-state").then(function (res) { return JSON.parse(res.text); });
  }

  var empty = await snapshot();
  assert.equal(empty.rev, 0);
  assert.ok(empty.sessionId, "再起動検出用の sessionId を返す");

  // 端末A: コンロ2口 + 品目完了 + 並べ替え
  var pushed = await push({ events: [
    { type: "konro", id: "o-1", num: 1, state: "white" },
    { type: "konro", id: "o-1", num: 3, state: "red" },
    { type: "toggle", id: "o-1", index: 0, doneCount: 2 },
    { type: "order", seq: ["o-1", "o-2"] },
  ] });
  assert.equal(pushed.status, 200);
  assert.equal(JSON.parse(pushed.text).rev, 1);

  // 端末B: 1回の取得で全部そろう (差分ではなく畳み込み済みの状態を返すため)
  var shared = await snapshot();
  assert.equal(shared.rev, 1);
  assert.deepEqual(shared.konro, { "o-1": { "1": "white", "3": "red" } });
  assert.deepEqual(shared.done, { "o-1": [2] });
  assert.deepEqual(shared.seq, ["o-1", "o-2"]);

  // 解除も共有される
  await push({ events: [{ type: "konro", id: "o-1", num: 1, state: "skeleton" }] });
  assert.deepEqual((await snapshot()).konro, { "o-1": { "3": "red" } });

  var invalid = await push({ events: [{ type: "konro", id: "o-1", num: 0, state: "white" }] });
  assert.equal(invalid.status, 400);
  assert.match(JSON.parse(invalid.text).error, /konro\.num/);

  assert.equal((await requestRaw(relay.server, "/api/kitchen-state", { method: "DELETE" })).status, 405);

  resolveReservations([]);
  await relay.whenInitialSync();
});

test("座席APIは初回同期前503で、同期後もwalk-in操作を維持する", async function (t) {
  var resolveReservations;
  var relay = createTestRelay({
    listReservations: function () {
      return new Promise(function (resolve) { resolveReservations = resolve; });
    },
    listSyncEvents: async function () { return []; },
    getReservation: async function () { return null; },
  }, []);
  t.after(function () { return relay.stop(); });
  relay.start();
  await events.once(relay.server, "listening");

  assert.equal((await requestRaw(relay.server, "/api/seats")).status, 503);
  resolveReservations([]);
  await relay.whenInitialSync();

  var created = await requestRaw(relay.server, "/api/seats", {
    method: "POST",
    body: JSON.stringify({ table: "5" }),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(created.status, 201);
  var occupied = JSON.parse((await requestRaw(relay.server, "/api/seats")).text);
  assert.equal(occupied.some(function (seat) { return seat.table === "5" && seat.source === "walkin"; }), true);
  assert.equal((await requestRaw(relay.server, "/api/seats/5", { method: "DELETE" })).status, 204);

  // 予約の着席 (#123): 卓番はKDSでスタッフが決めるローカルデータなので、rid付きで登録する
  var seated = await requestRaw(relay.server, "/api/seats", {
    method: "POST",
    body: JSON.stringify({ table: "3", rid: "r-1", name: "山田様" }),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(seated.status, 201);
  var seatedBody = JSON.parse(seated.text);
  assert.equal(seatedBody.source, "reservation");
  assert.equal(seatedBody.rid, "r-1");
  assert.equal(seatedBody.name, "山田様");

  var withSeated = JSON.parse((await requestRaw(relay.server, "/api/seats")).text);
  assert.equal(withSeated.some(function (seat) {
    return seat.table === "3" && seat.source === "reservation" && seat.rid === "r-1";
  }), true, "着席した予約が占有ビューに出ていない");
});

test("注文APIは投入・配信・再送・取消をこなし、予約同期の完了を待たない", async function (t) {
  // 初回全件リシンクを保留したまま注文APIを叩き、予約同期に依存しないことを見る
  var resolveReservations;
  var relay = createTestRelay({
    listReservations: function () {
      return new Promise(function (resolve) { resolveReservations = resolve; });
    },
    listSyncEvents: async function () { return []; },
    getReservation: async function () { return null; },
  }, []);
  t.after(function () { return relay.stop(); });
  relay.start();
  await events.once(relay.server, "listening");

  function post(payload) {
    return requestRaw(relay.server, "/api/orders", {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
    });
  }

  assert.equal((await requestRaw(relay.server, "/api/stock")).status, 503);   // 予約側は未同期

  var created = await post({ orderId: "t12-1", table: "12", people: 3, items: [{ name: "土鍋御膳", qty: 2, note: "塩少なめ" }] });
  assert.equal(created.status, 201);
  assert.equal(JSON.parse(created.text).duplicate, false);
  assert.equal(JSON.parse(created.text).updated, false);

  var feed = JSON.parse((await requestRaw(relay.server, "/api/orders")).text);
  assert.equal(feed.length, 1);
  assert.equal(feed[0].id, "t12-1");
  assert.equal(feed[0].table, "12");
  assert.equal(feed[0].type, "new");
  assert.equal(typeof feed[0].start, "number");
  assert.deepEqual(feed[0].items, [{ name: "土鍋御膳", qty: 2, options: "塩少なめ", allergies: null, done: false }]);

  // 通信断の再送: 200 + duplicate。カードは増えない
  var retry = await post({ orderId: "t12-1", table: "12", people: 3, items: [{ name: "土鍋御膳", qty: 2, note: "塩少なめ" }] });
  assert.equal(retry.status, 200);
  assert.equal(JSON.parse(retry.text).duplicate, true);
  assert.equal(JSON.parse(retry.text).updated, false);
  assert.equal(JSON.parse((await requestRaw(relay.server, "/api/orders")).text).length, 1);

  // 同じ orderId の内容変更: 200 + updated。同じカードの内容を置き換え、受付時刻は維持する
  var originalStart = feed[0].start;
  var update = await post({
    orderId: "t12-1",
    table: "15",
    people: 4,
    items: [
      { name: "土鍋御膳", qty: 1, note: "塩少なめ" },
      { name: "ウーロン茶", qty: 2, note: "氷なし" },
    ],
  });
  var updateBody = JSON.parse(update.text);
  assert.equal(update.status, 200);
  assert.equal(updateBody.duplicate, false);
  assert.equal(updateBody.updated, true);
  var updatedFeed = JSON.parse((await requestRaw(relay.server, "/api/orders")).text);
  assert.equal(updatedFeed.length, 1);
  assert.equal(updatedFeed[0].start, originalStart);
  assert.equal(updatedFeed[0].table, "15");
  assert.equal(updatedFeed[0].people, 4);
  assert.deepEqual(updatedFeed[0].items.map(function (item) { return [item.name, item.qty, item.options]; }),
    [["土鍋御膳", 1, "塩少なめ"], ["ウーロン茶", 2, "氷なし"]]);

  // 更新後の同一内容再送も duplicate になり、更新を繰り返さない
  var updateRetry = await post({
    orderId: "t12-1",
    table: "15",
    people: 4,
    items: [
      { name: "土鍋御膳", qty: 1, note: "塩少なめ" },
      { name: "ウーロン茶", qty: 2, note: "氷なし" },
    ],
  });
  assert.equal(JSON.parse(updateRetry.text).duplicate, true);
  assert.equal(JSON.parse(updateRetry.text).updated, false);

  // 卓番の欠落は 400 で理由を返す (別チームが送信側を直せるように)
  var invalid = await post({ orderId: "t13-1", items: [{ name: "茶" }] });
  assert.equal(invalid.status, 400);
  assert.match(JSON.parse(invalid.text).error, /^table/);

  assert.equal((await requestRaw(relay.server, "/api/orders/t12-1", { method: "DELETE" })).status, 204);
  assert.equal((await requestRaw(relay.server, "/api/orders/t12-1", { method: "DELETE" })).status, 404);
  assert.deepEqual(JSON.parse((await requestRaw(relay.server, "/api/orders")).text), []);

  // 取消後に明示的な POST が届けば最後の操作を正として再作成する
  var recreated = await post({ orderId: "t12-1", table: "16", items: [{ name: "茶", qty: 1 }] });
  assert.equal(recreated.status, 201);
  assert.equal(JSON.parse(recreated.text).order.table, "16");

  assert.equal((await requestRaw(relay.server, "/api/orders", { method: "PATCH" })).status, 405);

  resolveReservations([]);          // 保留していた初回リシンクを解いて stop() を待てるようにする
  await relay.whenInitialSync();
});

test("POST /api/print はプライベートIP検証・正規化を行い、送信結果をHTTPで返す(#144)", async function (t) {
  var sent = [];
  var relay = serverModule.createRelay({
    port: 0,
    env: { MOCK: "1", POLL_MS: "3000", RESYNC_MS: "900000" },
    source: {
      listReservations: async function () { return []; },
      listSyncEvents: async function () { return []; },
      getReservation: async function () { return null; },
    },
    mockSource: {},
    log: function () {},
    setInterval: function () { return 1; },
    clearInterval: function () {},
    printer: Object.assign({}, printerModule, {
      sendToPrinter: function (ip) {
        sent.push(ip);
        return ip === "192.168.1.99" ? Promise.reject(new Error("ECONNREFUSED")) : Promise.resolve();
      },
    }),
  });
  t.after(function () { return relay.stop(); });
  relay.start();
  await events.once(relay.server, "listening");
  await relay.whenInitialSync();

  var badIp = await requestRaw(relay.server, "/api/print", {
    method: "POST",
    body: JSON.stringify({ ip: "8.8.8.8", table: "5", items: [] }),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(badIp.status, 400);
  assert.equal(JSON.parse(badIp.text).ok, false);

  var ok = await requestRaw(relay.server, "/api/print", {
    method: "POST",
    body: JSON.stringify({ ip: "192.168.1.50", table: "A3", items: [{ name: "土鍋御膳", qty: 1 }] }),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.text), { ok: true });
  assert.deepEqual(sent, ["192.168.1.50"]);

  var fail = await requestRaw(relay.server, "/api/print", {
    method: "POST",
    body: JSON.stringify({ ip: "192.168.1.99", table: "A4", items: [] }),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(fail.status, 502);
  assert.equal(JSON.parse(fail.text).ok, false);
});

test("GET/POST /api/slip-style はスタイルを保存・配信し、印刷のstyle未指定時に使う(#144追補)", async function (t) {
  var os2 = require("os");
  var path2 = require("path");
  var stylePath = path2.join(os2.tmpdir(), "slip-style-test-" + process.pid + "-" + Date.now() + ".json");
  var printerIpPath = path2.join(os2.tmpdir(), "printer-ip-test-" + process.pid + "-" + Date.now() + ".json");
  var built = [];
  var relay = serverModule.createRelay({
    port: 0,
    env: { MOCK: "1", POLL_MS: "3000", RESYNC_MS: "900000" },
    slipStylePath: stylePath,
    printerIpPath: printerIpPath,
    source: {
      listReservations: async function () { return []; },
      listSyncEvents: async function () { return []; },
      getReservation: async function () { return null; },
    },
    mockSource: {},
    log: function () {},
    setInterval: function () { return 1; },
    clearInterval: function () {},
    printer: Object.assign({}, printerModule, {
      buildEscPos: function (job) { built.push(job); return Buffer.from("x"); },
      sendToPrinter: function () { return Promise.resolve(); },
    }),
  });
  t.after(function () {
    try { require("fs").unlinkSync(stylePath); } catch (e) {}
    try { require("fs").unlinkSync(printerIpPath); } catch (e) {}
    return relay.stop();
  });
  relay.start();
  await events.once(relay.server, "listening");
  await relay.whenInitialSync();

  // 未設定時は空オブジェクト
  var empty = await requestRaw(relay.server, "/api/slip-style");
  assert.equal(empty.status, 200);
  assert.deepEqual(JSON.parse(empty.text), {});

  // 保存すると許容値へ丸めた結果が返り、以後のGETで配信される
  var saved = await requestRaw(relay.server, "/api/slip-style", {
    method: "POST",
    body: JSON.stringify({ qtyFormat: "kosuu", paperWidth: 9999 }),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(saved.status, 200);
  var savedStyle = JSON.parse(saved.text).style;
  assert.equal(savedStyle.qtyFormat, "kosuu");
  assert.equal(savedStyle.paperWidth, 80);   // 不正値は既定値へ
  var got = JSON.parse((await requestRaw(relay.server, "/api/slip-style")).text);
  assert.equal(got.qtyFormat, "kosuu");

  // style未指定の印刷はサーバー保存スタイルで印字される
  await requestRaw(relay.server, "/api/print", {
    method: "POST",
    body: JSON.stringify({ ip: "192.168.1.50", table: "A3", items: [] }),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(built.length, 1);
  assert.equal(built[0].style.qtyFormat, "kosuu");

  // プリンターIPもサーバー保存でき、ip未指定の印刷に使われる(iPad等の未登録端末対応)
  var badIp = await requestRaw(relay.server, "/api/printer", {
    method: "POST",
    body: JSON.stringify({ ip: "8.8.8.8" }),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(badIp.status, 400);
  await requestRaw(relay.server, "/api/printer", {
    method: "POST",
    body: JSON.stringify({ ip: "192.168.1.60" }),
    headers: { "Content-Type": "application/json" },
  });
  assert.deepEqual(JSON.parse((await requestRaw(relay.server, "/api/printer")).text), { ip: "192.168.1.60" });
  var noIpPrint = await requestRaw(relay.server, "/api/print", {
    method: "POST",
    body: JSON.stringify({ table: "B1", items: [] }),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(noIpPrint.status, 200);
  assert.equal(built.length, 2);
});

test("LIVE adapterはBooking v1の全ページへshop_idsとBearerを付ける", async function () {
  var calls = [];
  var source = serverModule.createTableCheckSource({
    isMock: false,
    base: "https://api.tablecheck.test",
    apiKey: "test-secret",
    shopId: "shop-1",
    fetch: async function (url, options) {
      calls.push({ url: url, options: options });
      var page = Number(new URL(url).searchParams.get("page"));
      return {
        ok: true,
        status: 200,
        json: async function () {
          return { reservations: page === 0 ? new Array(200).fill({ id: "r" }) : [] };
        },
      };
    },
  });

  var reservations = await source.listReservations(new Date());
  assert.equal(reservations.length, 200);
  assert.equal(calls.length, 2);
  calls.forEach(function (call, page) {
    var url = new URL(call.url);
    assert.equal(url.pathname, "/api/booking/v1/reservations");
    assert.equal(url.searchParams.get("page"), String(page));
    assert.equal(url.searchParams.get("per_page"), "200");
    assert.equal(url.searchParams.get("shop_ids"), "shop-1");
    assert.equal(call.options.headers.Authorization, "Bearer test-secret");
  });
});

test("LIVE adapterは差分一覧・個別404・APIエラーを扱う", async function () {
  var responseQueue = [
    { ok: true, status: 200, body: { sync_events: [{ id: "e1" }] } },
    { ok: true, status: 404, body: {} },
    { ok: false, status: 429, body: {} },
    { ok: false, status: 500, body: {} },
  ];
  var source = serverModule.createTableCheckSource({
    isMock: false,
    base: "https://api.tablecheck.test",
    apiKey: "secret",
    shopId: "shop / 1",
    fetch: async function () {
      var response = responseQueue.shift();
      return {
        ok: response.ok,
        status: response.status,
        json: async function () { return response.body; },
      };
    },
  });

  assert.deepEqual(await source.listSyncEvents(), [{ id: "e1" }]);
  assert.equal(await source.getReservation("missing"), null);
  await assert.rejects(source.getReservation("rate-limited"), /429/);
  await assert.rejects(source.getReservation("broken"), /TableCheck 500/);
  assert.throws(function () {
    serverModule.createTableCheckSource({ isMock: false });
  }, /fetch is required/);
});

test("LIVE adapterは外部fetch停滞をタイムアウトする", async function () {
  var source = serverModule.createTableCheckSource({
    isMock: false,
    base: "https://api.tablecheck.test",
    apiKey: "secret",
    shopId: "shop-1",
    requestTimeoutMs: 5,
    fetch: function (url, options) {
      return new Promise(function (resolve, reject) {
        options.signal.addEventListener("abort", function () {
          var err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    },
  });
  await assert.rejects(source.getReservation("slow"), /timed out/);

  var bodySource = serverModule.createTableCheckSource({
    isMock: false,
    base: "https://api.tablecheck.test",
    apiKey: "secret",
    shopId: "shop-1",
    requestTimeoutMs: 5,
    fetch: async function (url, options) {
      return {
        ok: true,
        status: 200,
        json: function () {
          return new Promise(function (resolve, reject) {
            options.signal.addEventListener("abort", function () {
              var err = new Error("aborted body");
              err.name = "AbortError";
              reject(err);
            });
          });
        },
      };
    },
  });
  await assert.rejects(bodySource.listSyncEvents(), /timed out/);
});

test("静的配信・demo・404・不正URLを維持する", async function (t) {
  var relay = createTestRelay({
    listReservations: async function () { return []; },
    listSyncEvents: async function () { return []; },
    getReservation: async function () { return null; },
  }, []);
  t.after(function () { return relay.stop(); });
  relay.start();
  await events.once(relay.server, "listening");
  await relay.whenInitialSync();

  var root = await requestRaw(relay.server, "/");
  assert.equal(root.status, 200);
  var bridgeTags = root.text.match(/<script\b[^>]*\bsrc=["']\/relay-server\/kds-bridge\.js["'][^>]*><\/script>/gi) || [];
  assert.equal(bridgeTags.length, 1, "KDS bridge scriptがちょうど1件だけ注入される");
  var sound = await requestRaw(relay.server, "/assets/sounds/shishiodoshi.ogg");
  assert.equal(sound.status, 200);
  assert.equal(sound.headers["content-type"], "audio/ogg");
  assert.ok(sound.text && sound.text.length > 1000, "ししおどし音源が配信される");
  assert.equal((await requestRaw(relay.server, "/demo")).status, 200);
  assert.equal((await requestRaw(relay.server, "/relay-server/not-found.js")).status, 404);
  assert.equal((await requestRaw(relay.server, "/%E0%A4%A")).status, 400);
  assert.equal((await requestRaw(relay.server, "/%2e%2e%5cissue-122-evil%5csecret.txt")).status, 403);
});

test("MOCK予約APIの作成・入力エラー・未存在・method拒否を扱う", async function (t) {
  var db = {};
  var queue = [];
  var mockSource = {
    listReservations: function () { return Object.keys(db).map(function (id) { return db[id]; }); },
    listSyncEvents: function () { var current = queue; queue = []; return current; },
    getReservation: function (id) { return db[id] || null; },
    createReservation: function (body) {
      var rec = rawReservation(body.id || "created");
      db[rec.id] = rec;
      queue.push({ syncable_type: "Reservation", syncable_id: rec.id });
      return rec;
    },
    updateReservation: function () { return null; },
    cancelReservation: function () { return null; },
    seed: function () {},
  };
  var relay = serverModule.createRelay({
    port: 0,
    env: { MOCK: "1" },
    source: mockSource,
    mockSource: mockSource,
    log: function () {},
    setInterval: function () { return 1; },
    clearInterval: function () {},
  });
  t.after(function () { return relay.stop(); });
  relay.start();
  await events.once(relay.server, "listening");
  await relay.whenInitialSync();

  assert.deepEqual(JSON.parse((await requestRaw(relay.server, "/api/mock/reservations")).text), []);
  var created = await requestRaw(relay.server, "/api/mock/reservations", {
    method: "POST", body: JSON.stringify({ id: "r-created" }),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(created.status, 200);
  assert.equal(JSON.parse(created.text).reservation.id, "r-created");
  assert.equal((await requestRaw(relay.server, "/api/mock/reservations", { method: "POST", body: "{" })).status, 400);
  assert.equal((await requestRaw(relay.server, "/api/mock/reservations/missing", { method: "PATCH", body: "{}" })).status, 404);
  assert.equal((await requestRaw(relay.server, "/api/mock/reservations/missing", { method: "DELETE" })).status, 404);
  assert.equal((await requestRaw(relay.server, "/api/mock/reservations", { method: "PUT" })).status, 405);
  assert.equal((await requestRaw(relay.server, "/api/mock/unknown")).status, 404);
  assert.equal((await requestRaw(relay.server, "/api/mock/reservations/%E0%A4%A")).status, 400);
});

test("設定値はLIVEの30秒下限とRESYNC_MS下限を守る", function () {
  var relay = serverModule.createRelay({
    env: {
      TABLECHECK_API_KEY: "secret",
      POLL_MS: "1",
      RESYNC_MS: "1",
      PORT: "8123",
      HOST: "192.168.1.10",
      SHOP_ID: "shop",
      TABLECHECK_BASE: "https://example.test",
      TABLECHECK_ALLOW_CUSTOM_BASE: "1",
    },
    source: {
      listReservations: async function () { return []; },
      listSyncEvents: async function () { return []; },
      getReservation: async function () { return null; },
    },
    mockSource: {},
  });
  assert.equal(relay.config.isMock, false);
  assert.equal(relay.config.pollMs, 30000);
  assert.equal(relay.config.resyncMs, 60000);
  assert.equal(relay.config.port, 8123);
  assert.equal(relay.config.host, "192.168.1.10");
  assert.equal(relay.config.shopId, "shop");
  assert.equal(relay.config.base, "https://example.test");
});

test("LIVEはSHOP_ID必須かつTABLECHECK_BASEをHTTPSに限定する", function () {
  var source = {
    listReservations: async function () { return []; },
    listSyncEvents: async function () { return []; },
    getReservation: async function () { return null; },
  };
  assert.throws(function () {
    serverModule.createRelay({
      env: { TABLECHECK_API_KEY: "secret" }, source: source, mockSource: {},
    });
  }, /SHOP_ID/);
  assert.throws(function () {
    serverModule.createRelay({
      env: {
        TABLECHECK_API_KEY: "secret", SHOP_ID: "shop", TABLECHECK_BASE: "http://api.tablecheck.test",
      },
      source: source,
      mockSource: {},
    });
  }, /HTTPS/);
});

test("stopは進行中の初回同期が完了するまで解決しない", async function () {
  var releaseReservations;
  var relay = createTestRelay({
    listReservations: function () {
      return new Promise(function (resolve) { releaseReservations = resolve; });
    },
    listSyncEvents: async function () { return []; },
    getReservation: async function () { return null; },
  }, []);
  relay.start();
  await events.once(relay.server, "listening");

  var stopped = false;
  var stopPromise = relay.stop().then(function () { stopped = true; });
  await new Promise(function (resolve) { setImmediate(resolve); });
  assert.equal(stopped, false);

  releaseReservations([]);
  await stopPromise;
  assert.equal(stopped, true);
});

test("自由配置レイアウトの保存とラスター印字(/api/slip-style, /api/print)", async function (t) {
  var os2 = require("os");
  var path2 = require("path");
  var stylePath = path2.join(os2.tmpdir(), "slip-tpl-test-" + process.pid + "-" + Date.now() + ".json");
  var rasterJobs = [];
  var textJobs = [];
  var relay = serverModule.createRelay({
    port: 0,
    env: { MOCK: "1", POLL_MS: "3000", RESYNC_MS: "900000" },
    slipStylePath: stylePath,
    printerIpPath: path2.join(os2.tmpdir(), "printer-ip-tpl-" + process.pid + "-" + Date.now() + ".json"),
    source: {
      listReservations: async function () { return []; },
      listSyncEvents: async function () { return []; },
      getReservation: async function () { return null; },
    },
    mockSource: {},
    log: function () {},
    setInterval: function () { return 1; },
    clearInterval: function () {},
    printer: Object.assign({}, printerModule, {
      buildRaster: function (raster, opts) { rasterJobs.push({ raster: raster, opts: opts }); return Buffer.from("r"); },
      buildEscPos: function (job) { textJobs.push(job); return Buffer.from("t"); },
      sendToPrinter: function () { return Promise.resolve(); },
    }),
  });
  t.after(function () {
    try { require("fs").unlinkSync(stylePath); } catch (e) {}
    return relay.stop();
  });
  relay.start();
  await events.once(relay.server, "listening");
  await relay.whenInitialSync();

  // レイアウト(elements[])は丸めずそのまま預かる。描画はブラウザ側なのでサーバーは解釈しない
  var tpl = {
    version: 3, paperWidth: 58, feedLines: 2,
    elements: [{ id: "t1", type: "text", x: 0, y: 10, w: 384, text: "卓 {卓番}", size: 48 }],
  };
  var saved = await requestRaw(relay.server, "/api/slip-style", {
    method: "POST",
    body: JSON.stringify(tpl),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(JSON.parse((await requestRaw(relay.server, "/api/slip-style")).text), tpl);

  // ラスター付きの印刷は画像経路で組み立てられ、emulation がそのまま渡る
  var widthBytes = 48;   // 384ドット / 8
  var rasterBody = {
    ip: "192.168.1.50",
    feedLines: 2,
    emulation: "starprnt",
    raster: { width: 384, height: 4, data: Buffer.alloc(widthBytes * 4).toString("base64") },
  };
  var printed = await requestRaw(relay.server, "/api/print", {
    method: "POST",
    body: JSON.stringify(rasterBody),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(printed.status, 200);
  assert.equal(rasterJobs.length, 1);
  assert.equal(rasterJobs[0].opts.emulation, "starprnt");
  assert.equal(rasterJobs[0].raster.height, 4);
  assert.equal(textJobs.length, 0, "テキスト印字経路には落ちない");

  // 壊れたラスターは黙ってテキスト印字に落とさず400で返す(別物が印字される事故を防ぐ)
  var broken = JSON.parse(JSON.stringify(rasterBody));
  broken.raster.height = 99;
  var brokenRes = await requestRaw(relay.server, "/api/print", {
    method: "POST",
    body: JSON.stringify(broken),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(brokenRes.status, 400);
  assert.equal(textJobs.length, 0);

  // ラスター無しの印刷でサーバー保存がレイアウトの場合、テキスト印字にレイアウトを渡さない
  await requestRaw(relay.server, "/api/print", {
    method: "POST",
    body: JSON.stringify({ ip: "192.168.1.50", table: "A3", items: [] }),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(textJobs.length, 1);
  assert.equal(textJobs[0].style.paperWidth, 80, "レイアウトではなく既定スタイルで印字する");
});
