/**
 * kds-bridge-browser.test.js — kds-bridge.js をブラウザと同じ読み込み方で実行し、取込経路を検証する
 *
 * kds-bridge.test.js は require して純粋関数だけを見ている。ここでは module の無い文脈へ
 * スクリプトをそのまま流し、/api/stock・/api/orders・/api/kitchen-state・/api/health の
 * ポーリングが localStorage・window.KDS_ORDERS・同期状態へどう反映されるかを確かめる。
 * WebSocket は用意しないので、注文は HTTP ポーリング経路を通る。
 */
"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var vm = require("node:vm");

var source = fs.readFileSync(path.join(__dirname, "..", "kds-bridge.js"), "utf8");

function settle() {
  return new Promise(function (resolve) { setTimeout(resolve, 10); });
}

async function waitUntil(predicate, timeoutMs) {
  var deadline = Date.now() + (timeoutMs || 1000);
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not met before timeout");
    await settle();
  }
}

/* vm 文脈で作られた値はプロトタイプが別物なので、比較前に JSON で写し取る */
function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/**
 * routes は "GET /api/stock" → function(init) の対応表。戻り値は { status, body } か
 * { status, invalidJson:true }。対応が無い URL は通信断 (fetch が reject) として扱う。
 */
function startBridge(routes, initial) {
  initial = initial || {};
  var storage = Object.assign({}, initial.storage);
  var intervals = {};
  var events = [];
  var channels = [];
  var requests = [];

  function CustomEvent(type, init) { this.type = type; this.detail = init && init.detail; }
  function BroadcastChannel(name) { this.name = name; this.posted = []; this.onmessage = null; channels.push(this); }
  BroadcastChannel.prototype.postMessage = function (message) { this.posted.push(message); };

  var window = {
    KDS_ORDERS: initial.orders,
    CustomEvent: CustomEvent,
    dispatchEvent: function (event) { events.push({ type: event.type, detail: plain(event.detail) }); return true; },
    addEventListener: function () {},
  };

  var context = vm.createContext({
    window: window,
    CustomEvent: CustomEvent,
    BroadcastChannel: BroadcastChannel,
    localStorage: {
      getItem: function (key) { return Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null; },
      setItem: function (key, value) { storage[key] = String(value); },
    },
    fetch: async function (url, init) {
      var method = init && init.method || "GET";
      requests.push({ method: method, url: url, body: init && init.body ? JSON.parse(init.body) : undefined });
      var handler = routes[method + " " + url];
      if (!handler) throw new Error("network down");
      var response = handler(init);
      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        json: async function () {
          if (response.invalidJson) throw new SyntaxError("Unexpected token");
          return response.body;
        },
      };
    },
    // 定期実行は登録だけ受けて、テストから名前で1回ずつ進める
    setInterval: function (fn) { intervals[fn.name] = fn; return 0; },
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    console: { log: function () {} },
    document: { hidden: false, addEventListener: function () {} },
    location: { protocol: "http:", host: "kds.local" },
  });
  vm.runInContext(source, context, { filename: "kds-bridge.js" });

  return {
    window: window,
    events: events,
    requests: requests,
    channel: channels[0],
    stored: function (key) { return storage[key] === undefined ? undefined : JSON.parse(storage[key]); },
    status: function () { return plain(window.__KDS_SYNC_STATUS__); },
    tick: async function (name) { await intervals[name](); await settle(); },
    posts: function (url) {
      return requests.filter(function (r) { return r.method === "POST" && r.url === url; })
        .map(function (r) { return r.body; });
    },
  };
}

function ok(body) { return function () { return { status: 200, body: body }; }; }

function reservation(rid, over) {
  return Object.assign({ rid: rid, time: "18:30", adults: 2, kids: 0, name: "山田", menu: [{ name: "土鍋御膳", qty: 2 }], seenAt: 100 }, over);
}

function order(id, items) {
  return { id: id, table: "3", type: "new", start: 1000, people: 2,
    items: items || [{ name: "土鍋御膳", qty: 2, options: null, allergies: null, done: false }] };
}

test("予約ストックの取得結果を localStorage へマージし、他タブへ流して同期状態を正常にする", async function () {
  var bridge = startBridge({
    "GET /api/stock": ok([reservation("r1")]),
    "GET /api/health": ok({ ready: true }),
  });
  await settle();

  assert.equal(bridge.window.__KDS_RELAY_BRIDGE__, true);
  assert.deepEqual(bridge.stored("kds_stock_v1"), [reservation("r1")]);
  assert.deepEqual(bridge.stored("kds_bridge_seen_v1"), { r1: 1 });
  assert.deepEqual(plain(bridge.channel.posted), [{ type: "stock", stock: [reservation("r1")] }]);

  var status = bridge.status();
  assert.equal(status.channels.reservations.state, "normal");
  assert.equal(status.channels.reservations.failureCount, 0);
  assert.equal(status.relay.state, "normal");

  // 変化の無い取得では保存も通知もしない
  await bridge.tick("tickOnce");
  assert.equal(bridge.channel.posted.length, 1);
});

test("取得に失敗した経路は保存済みデータと表示中の注文に触れず、失敗だけを記録する", async function () {
  var manual = [reservation("manual-1", { name: "手動追加" })];
  var showing = [order("res-9")];
  var bridge = startBridge({
    "GET /api/stock": function () { return { status: 503, body: { ok: false } }; },
    "GET /api/orders": ok({ unexpected: "object" }),
    "GET /api/kitchen-state": function () { return { status: 200, invalidJson: true }; },
    "GET /api/health": function () { return { status: 500, body: {} }; },
  }, {
    storage: { kds_stock_v1: JSON.stringify(manual), kds_konro_v1: JSON.stringify({ o1: { 1: "red" } }) },
    orders: showing,
  });
  await settle();

  assert.deepEqual(bridge.stored("kds_stock_v1"), manual);
  assert.equal(bridge.stored("kds_bridge_seen_v1"), undefined);
  assert.deepEqual(bridge.stored("kds_konro_v1"), { o1: { 1: "red" } });
  assert.equal(bridge.window.KDS_ORDERS, showing);
  assert.equal(bridge.channel.posted.length, 0);

  var status = bridge.status();
  assert.equal(status.channels.reservations.error, "HTTP 503");
  assert.equal(status.channels.orders.error, "通信エラー");      // 配列でない本文
  assert.equal(status.channels.kitchen.error, "通信エラー");     // JSON として読めない本文
  assert.equal(status.relay.error, "HTTP 500");
  ["reservations", "orders", "kitchen"].forEach(function (name) {
    assert.equal(status.channels[name].failureCount, 1);
    assert.equal(status.channels[name].retrying, true);
    assert.equal(status.channels[name].lastSuccessAt, null);
  });
});

test("通信断では失敗を記録し、復旧後の取得で正常へ戻る", async function () {
  var routes = {};
  var bridge = startBridge(routes);
  await settle();
  assert.equal(bridge.status().channels.reservations.error, "通信エラー");
  assert.equal(bridge.status().relay.error, "通信エラー");

  routes["GET /api/stock"] = ok([]);
  routes["GET /api/health"] = ok({ ready: true });
  await bridge.tick("tickOnce");
  await bridge.tick("tickHealth");
  assert.equal(bridge.status().channels.reservations.state, "normal");
  assert.equal(bridge.status().channels.reservations.error, null);
  assert.equal(bridge.status().relay.state, "normal");

  // /api/health は配列を本文として認めない
  routes["GET /api/health"] = ok([]);
  await bridge.tick("tickHealth");
  assert.equal(bridge.status().relay.error, "通信エラー");
});

test("注文フィードは KDS 内の注文を残して置き換え、2回目以降の新しい注文だけを通知する", async function () {
  var feed = [order("A1")];
  var bridge = startBridge({
    "GET /api/orders": function () { return { status: 200, body: feed }; },
  }, { orders: [order("res-1")] });
  await settle();

  assert.deepEqual(plain(bridge.window.KDS_ORDERS).map(function (o) { return o.id; }), ["res-1", "A1"]);
  assert.deepEqual(bridge.stored("kds_server_orders_v1"), [order("A1")]);
  assert.deepEqual(bridge.events.filter(function (e) { return e.type === "kds:order-added"; }), []);
  assert.equal(bridge.status().channels.orders.state, "normal");

  feed = [order("A1"), order("B2")];
  await bridge.tick("tickOrders");
  assert.deepEqual(plain(bridge.window.KDS_ORDERS).map(function (o) { return o.id; }), ["res-1", "A1", "B2"]);
  var added = bridge.events.filter(function (e) { return e.type === "kds:order-added"; });
  assert.equal(added.length, 1);
  assert.deepEqual(added[0].detail.orders.map(function (o) { return o.id; }), ["B2"]);

  // サーバーから消えた注文は外し、KDS 内で生まれた注文は残す
  feed = [order("B2")];
  await bridge.tick("tickOrders");
  assert.deepEqual(plain(bridge.window.KDS_ORDERS).map(function (o) { return o.id; }), ["res-1", "B2"]);
});

test("注文内容の更新では品目完了数を内容で引き継ぎ、厨房状態として relay へ送る", async function () {
  var feed = [order("A1", [
    { name: "土鍋御膳", qty: 2, options: null, allergies: null, done: false },
    { name: "味噌汁", qty: 1, options: null, allergies: null, done: false },
  ])];
  var bridge = startBridge({
    "GET /api/orders": function () { return { status: 200, body: feed }; },
    "POST /api/kitchen-state": ok({ ok: true, rev: 1, sessionId: "s1" }),
  }, { storage: { kds_done_v2: JSON.stringify({ A1: [2, 1] }) } });
  await settle();

  // 先頭に品目が追加されても、完了数は行番号ではなく内容へ追従する
  feed = [order("A1", [
    { name: "お茶", qty: 1, options: null, allergies: null, done: false },
    { name: "土鍋御膳", qty: 2, options: null, allergies: null, done: false },
    { name: "味噌汁", qty: 1, options: null, allergies: null, done: false },
  ])];
  await bridge.tick("tickOrders");
  assert.deepEqual(bridge.stored("kds_done_v2"), { A1: [0, 2, 1] });

  await waitUntil(function () { return bridge.posts("/api/kitchen-state").length > 0; });
  assert.deepEqual(bridge.posts("/api/kitchen-state")[0], { events: [
    { type: "toggle", id: "A1", index: 0, doneCount: 0 },
    { type: "toggle", id: "A1", index: 1, doneCount: 2 },
    { type: "toggle", id: "A1", index: 2, doneCount: 1 },
  ] });
});

test("relay の厨房状態が空なら手元の状態を種として送り、新しい rev だけを取り込む", async function () {
  var snapshot = { sessionId: "s1", rev: 0, konro: {}, done: {}, locked: {}, seq: [], deleted: {} };
  var bridge = startBridge({
    "GET /api/kitchen-state": function () { return { status: 200, body: snapshot }; },
    "POST /api/kitchen-state": ok({ ok: true, rev: 1, sessionId: "s1" }),
  }, { storage: {
    kds_konro_v1: JSON.stringify({ o1: { 1: "red" } }),
    kds_locked_v1: JSON.stringify({ o1: true }),
    kds_order_v1: JSON.stringify(["o1"]),
  } });
  await settle();

  assert.deepEqual(bridge.posts("/api/kitchen-state"), [{ events: [
    { type: "konro", id: "o1", num: 1, state: "red" },
    { type: "timerLock", id: "o1", locked: true },
    { type: "order", seq: ["o1"] },
  ] }]);
  assert.deepEqual(bridge.stored("kds_konro_v1"), { o1: { 1: "red" } });   // 空の relay 状態では上書きしない

  snapshot = { sessionId: "s1", rev: 2, konro: { o2: { 2: "white" } }, done: { o2: [1] }, locked: {}, seq: ["o2"], deleted: { o1: true } };
  await bridge.tick("tickKitchen");
  assert.deepEqual(bridge.stored("kds_konro_v1"), { o2: { 2: "white" } });
  assert.deepEqual(bridge.stored("kds_done_v2"), { o2: [1] });
  assert.deepEqual(bridge.stored("kds_locked_v1"), {});
  assert.deepEqual(bridge.stored("kds_order_v1"), ["o2"]);
  assert.deepEqual(bridge.stored("kds_deleted_v1"), { o1: true });
  assert.equal(bridge.status().channels.kitchen.state, "normal");

  // 取込済みの rev は再適用しない
  snapshot = { sessionId: "s1", rev: 2, konro: {}, done: {}, locked: {}, seq: [], deleted: {} };
  await bridge.tick("tickKitchen");
  assert.deepEqual(bridge.stored("kds_konro_v1"), { o2: { 2: "white" } });

  // rev を持たない本文は失敗として扱い、手元の状態を保持する
  snapshot = { sessionId: "s1" };
  await bridge.tick("tickKitchen");
  assert.equal(bridge.status().channels.kitchen.error, "通信エラー");
  assert.deepEqual(bridge.stored("kds_konro_v1"), { o2: { 2: "white" } });
});

test("KDS の操作イベントを relay へ送り、着席は予約者名付きで座席占有へ登録する", async function () {
  var bridge = startBridge({
    "GET /api/stock": ok([reservation("r1")]),
    "POST /api/kitchen-state": ok({ ok: true, rev: 1, sessionId: "s1" }),
    "POST /api/seats": function () { return { status: 201, body: {} }; },
  });
  await settle();

  bridge.channel.onmessage({ data: { type: "konro", id: "A1", num: 3, state: "red" } });
  bridge.channel.onmessage({ data: { type: "moveToMain", order: { id: "res-r1", table: 5 } } });
  bridge.channel.onmessage({ data: { type: "stock", stock: [] } });   // 厨房イベントではないので送らない

  await waitUntil(function () { return bridge.posts("/api/kitchen-state").length > 0; });
  assert.deepEqual(bridge.posts("/api/kitchen-state"), [{ events: [{ type: "konro", id: "A1", num: 3, state: "red" }] }]);
  assert.deepEqual(bridge.posts("/api/seats"), [{ table: "5", rid: "r1", name: "山田" }]);
});
