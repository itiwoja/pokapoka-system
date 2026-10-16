"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("node:path");
var childProcess = require("node:child_process");
var http = require("node:http");
var events = require("node:events");
var serverModule = require("../server");
var printerModule = require("../printer");

test("server.js はimportだけでlistenせずcreateRelayを公開する", function () {
  var serverPath = path.join(__dirname, "..", "server.js");
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
  var serverPath = path.join(__dirname, "..", "server.js");
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
    "  port: 0, env: {}, log: function () {},",
    "});",
    "relay.start();",
    "relay.server.on('listening', async function () {",
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

function todayReservation(rid, fields) {
  var startAt = new Date();
  startAt.setHours(18, 30, 0, 0);
  return Object.assign({
    rid: rid,
    startAt: startAt.toISOString(),
    name: "山田 太郎",
    adults: 2,
    table: "3",
    menu: [{ name: "土鍋御膳", qty: 1 }],
  }, fields);
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

function createTestRelay(options) {
  return serverModule.createRelay(Object.assign({
    port: 0,
    env: {},
    log: function () {},
  }, options));
}

test("トークン認証は401を維持し、QRのGET/HEADはCookie発行後clean URLへリダイレクトする", async function (t) {
  var TOKEN = "pokapoka-kitchen-2026";
  // RELAY_TRUST_LOOPBACK=0 でループバック免除を切り、127.0.0.1 から「他端末」として叩く
  var relay = serverModule.createRelay({
    port: 0,
    env: { RELAY_TOKEN: TOKEN, RELAY_TRUST_LOOPBACK: "0" },
    log: function () {},
  });
  t.after(function () { return relay.stop(); });
  relay.start();
  await events.once(relay.server, "listening");

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
    env: { RELAY_TOKEN: TOKEN, RELAY_TRUST_LOOPBACK: "0", RELAY_COOKIE_SECURE: "1" }, log: function () {},
  });
  t.after(function () { return relay.stop(); });
  relay.start();
  await events.once(relay.server, "listening");

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
  var relay = createTestRelay();
  t.after(function () { return relay.stop(); });
  relay.start();
  await events.once(relay.server, "listening");

  assert.equal((await requestRaw(relay.server, "/")).status, 200);
  assert.equal((await requestRaw(relay.server, "/api/stock")).status, 200);
  assert.equal((await requestRaw(relay.server, "/api/audit")).status, 403,
    "認証無効時に監査ログをHTTP公開しない");
});

test("/api/stockは保存済みの当日予約を配信し、/api/healthは保存先を返す", async function (t) {
  var relay = createTestRelay();
  t.after(function () { return relay.stop(); });
  relay.start();
  await events.once(relay.server, "listening");
  assert.deepEqual(await requestJson(relay.server, "/api/stock"), { status: 200, body: [] }, "起動直後から200で空を返す");

  relay.reservations.save(todayReservation("r1"));
  relay.reservations.save(todayReservation("r2", { menu: [] }));   // 席だけ予約は載せない
  relay.reservations.save(todayReservation("r3"));
  relay.reservations.cancel("r3");
  var stock = await requestJson(relay.server, "/api/stock");
  assert.equal(stock.status, 200);
  assert.deepEqual(stock.body.map(function (r) { return r.rid; }), ["r1"]);
  assert.equal(stock.body[0].time, "18:30");

  var health = await requestJson(relay.server, "/api/health");
  assert.equal(health.body.ready, true);
  assert.deepEqual(health.body.reservations, { store: "sqlite", reservations: 3 });
});

test("予約を読めないときは/api/stockと/api/seatsが503を返し、プロセスは落ちない", async function (t) {
  var broken = function () { throw new Error("disk I/O error"); };
  var relay = createTestRelay({
    reservations: { stock: broken, todaySnapshot: broken, health: broken, file: ":memory:", close: function () {} },
  });
  t.after(function () { return relay.stop(); });
  relay.start();
  await events.once(relay.server, "listening");
  assert.deepEqual(await requestJson(relay.server, "/api/stock"),
    { status: 503, body: { ok: false, error: "reservation store unavailable" } });
  assert.equal((await requestRaw(relay.server, "/api/seats")).status, 503);
  assert.deepEqual((await requestJson(relay.server, "/api/health")).body.reservations, { store: "sqlite", error: "unavailable" });
  assert.equal((await requestRaw(relay.server, "/api/orders")).status, 200, "注文は予約ストアの故障に巻き込まれない");
});

test("予約はSQLiteファイルに残り、再起動後も配信される", async function (t) {
  var os2 = require("os");
  var fs2 = require("fs");
  var dir = fs2.mkdtempSync(path.join(os2.tmpdir(), "relay-reservations-"));
  var dbPath = path.join(dir, "reservations.sqlite");

  var first = createTestRelay({ reservationDbPath: dbPath });
  first.start();
  await events.once(first.server, "listening");
  first.reservations.save(todayReservation("r-keep"));
  await first.stop();

  var second = createTestRelay({ reservationDbPath: dbPath });
  t.after(function () { return second.stop(); });
  // t.after は登録順に動く。Windows は開いたままの SQLite を消せないため、stop より後に登録する
  t.after(function () { fs2.rmSync(dir, { recursive: true, force: true }); });
  second.start();
  await events.once(second.server, "listening");
  var stock = await requestJson(second.server, "/api/stock");
  assert.deepEqual(stock.body.map(function (r) { return r.rid; }), ["r-keep"]);
});

test("厨房状態APIはイベントを畳み込み、別端末が1回の取得で追いつける", async function (t) {
  var relay = createTestRelay();
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
});

test("座席APIは保存済み予約の占有を出し、walk-in操作を維持する", async function (t) {
  var relay = createTestRelay();
  t.after(function () { return relay.stop(); });
  relay.start();
  await events.once(relay.server, "listening");

  var soon = new Date(Date.now() + 10 * 60000).toISOString();
  relay.reservations.save(todayReservation("r-soon", { startAt: soon, table: "7" }));
  var fromStore = JSON.parse((await requestRaw(relay.server, "/api/seats")).text);
  assert.equal(fromStore.some(function (seat) {
    return seat.table === "7" && seat.source === "reservation" && seat.rid === "r-soon";
  }), true, "予約ストアの卓番が占有ビューに出ていない");

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

test("注文APIは投入・配信・再送・取消をこなす", async function (t) {
  var relay = createTestRelay();
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
});

test("POST /api/print はプライベートIP検証・正規化を行い、送信結果をHTTPで返す(#144)", async function (t) {
  var sent = [];
  var relay = serverModule.createRelay({
    port: 0,
    env: {},
    log: function () {},
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
    env: {},
    slipStylePath: stylePath,
    printerIpPath: printerIpPath,
    log: function () {},
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

test("静的配信・404・不正URLを維持し、撤去した /demo とモック予約APIは配信しない", async function (t) {
  var relay = createTestRelay();
  t.after(function () { return relay.stop(); });
  relay.start();
  await events.once(relay.server, "listening");

  var root = await requestRaw(relay.server, "/");
  assert.equal(root.status, 200);
  var bridgeTags = root.text.match(/<script\b[^>]*\bsrc=["']\/relay-server\/kds-bridge\.js["'][^>]*><\/script>/gi) || [];
  assert.equal(bridgeTags.length, 1, "KDS bridge scriptがちょうど1件だけ注入される");
  var sound = await requestRaw(relay.server, "/assets/sounds/shishiodoshi.ogg");
  assert.equal(sound.status, 200);
  assert.equal(sound.headers["content-type"], "audio/ogg");
  assert.ok(sound.text && sound.text.length > 1000, "ししおどし音源が配信される");
  assert.equal((await requestRaw(relay.server, "/demo")).status, 404);
  assert.equal((await requestRaw(relay.server, "/api/mock/reservations")).status, 404);
  assert.equal((await requestRaw(relay.server, "/relay-server/not-found.js")).status, 404);
  assert.equal((await requestRaw(relay.server, "/%E0%A4%A")).status, 400);
  assert.equal((await requestRaw(relay.server, "/%2e%2e%5cissue-122-evil%5csecret.txt")).status, 403);
});

test("設定値はポート・ホスト・予約の保存先を反映する", function () {
  var relay = serverModule.createRelay({
    env: { PORT: "8123", HOST: "192.168.1.10", RESERVATION_DB_FILE: "data/test-reservations.sqlite" },
    reservations: { close: function () {} },
  });
  assert.equal(relay.config.port, 8123);
  assert.equal(relay.config.host, "192.168.1.10");
  assert.equal(relay.config.reservationDbFile, "data/test-reservations.sqlite");
});

test("自由配置レイアウトの保存とラスター印字(/api/slip-style, /api/print)", async function (t) {
  var os2 = require("os");
  var path2 = require("path");
  var stylePath = path2.join(os2.tmpdir(), "slip-tpl-test-" + process.pid + "-" + Date.now() + ".json");
  var rasterJobs = [];
  var textJobs = [];
  var relay = serverModule.createRelay({
    port: 0,
    env: {},
    slipStylePath: stylePath,
    printerIpPath: path2.join(os2.tmpdir(), "printer-ip-tpl-" + process.pid + "-" + Date.now() + ".json"),
    log: function () {},
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
