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
        resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") });
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
  assert.match(root.text, /kds-bridge\.js/);
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
