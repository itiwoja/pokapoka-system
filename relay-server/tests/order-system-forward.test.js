"use strict";
// order-system (注文サーバー) が転送するペイロードそのものを実サーバーへ流す契約テスト。
// 両リポジトリで食い違うと注文が KDS に届かないため、ブリーフの JSON 例をそのまま使う。
var test = require("node:test");
var assert = require("node:assert/strict");
var events = require("node:events");
var WS = require("ws");
var createRelay = require("../server").createRelay;

var ORDER_ID = "9daa53b5-a7e7-43b5-8e9c-139f521dc79d";

function payload(overrides) {
  return Object.assign({
    orderId: ORDER_ID,
    table: "3,4",
    tables: [3, 4],
    people: 4,
    orderedAt: new Date(Date.now() - 60000).toISOString(),
    items: [
      { name: "山城牛の肉たく土鍋御膳", qty: 2, note: "サイズ: 大盛り / 辛さ: 中辛" },
      { name: "ウーロン茶", qty: 4 },
    ],
  }, overrides || {});
}

async function setup(t, env) {
  var relay = createRelay({ port: 0, env: env || {}, log: function () {}, auditLog: { record: function () {} } });
  relay.start();
  await events.once(relay.server, "listening");
  t.after(function () { return relay.stop(); });
  var base = "http://127.0.0.1:" + relay.server.address().port;
  function post(body, headers) {
    return fetch(base + "/api/orders", {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, headers || {}),
      body: JSON.stringify(body),
    });
  }
  return { base: base, post: post };
}

test("転送ペイロードを受け付け、同内容の再送は duplicate になる", { timeout: 8000 }, async function (t) {
  var s = await setup(t);
  var res = await s.post(payload());
  assert.equal(res.status, 201);
  var json = await res.json();
  assert.equal(json.ok, true);
  assert.equal(json.order.id, ORDER_ID);
  assert.equal(json.order.table, "3,4");
  assert.deepEqual(json.order.tables, [3, 4]);
  assert.equal(json.order.items[0].options, "サイズ: 大盛り / 辛さ: 中辛");
  assert.equal(json.order.items[1].options, null);

  var again = await s.post(payload());
  assert.equal(again.status, 200);
  assert.equal((await again.json()).duplicate, true);
});

test("GET /api/orders のフィードと /ws/orders のスナップショットに tables と table が入る", { timeout: 8000 }, async function (t) {
  var s = await setup(t);
  assert.equal((await s.post(payload())).status, 201);

  var feed = await (await fetch(s.base + "/api/orders")).json();
  var list = Array.isArray(feed) ? feed : (feed.orders || []);
  var found = list.filter(function (o) { return o.id === ORDER_ID; })[0];
  assert.ok(found, "フィードに注文がある");
  assert.equal(found.table, "3,4");
  assert.deepEqual(found.tables, [3, 4]);

  var socket = new WS(s.base.replace("http:", "ws:") + "/ws/orders", { origin: s.base });
  t.after(function () { socket.terminate(); });
  var snapshot = JSON.parse((await events.once(socket, "message"))[0]);
  assert.equal(snapshot.type, "orders.snapshot");
  var order = snapshot.orders.filter(function (o) { return o.orderId === ORDER_ID; })[0];
  assert.ok(order, "スナップショットに注文がある");
  assert.deepEqual(order.tables, [3, 4]);
  assert.equal(order.table, "3,4");
});

test("RELAY_TOKEN を設定した relay は Bearer 付きだけ受け付ける", { timeout: 8000 }, async function (t) {
  var s = await setup(t, { RELAY_TOKEN: "test-token-123", RELAY_TRUST_LOOPBACK: "0" });
  assert.equal((await s.post(payload())).status, 401);
  assert.equal((await s.post(payload(), { Authorization: "Bearer test-token-123" })).status, 201);
});

test("people を省略した転送は people: 0 で受け付ける", { timeout: 8000 }, async function (t) {
  var s = await setup(t);
  var body = payload();
  delete body.people;
  var res = await s.post(body);
  assert.equal(res.status, 201);
  assert.equal((await res.json()).order.people, 0);
});

test("15 卓の転送でも受け付け、table は連結文字列になる", { timeout: 8000 }, async function (t) {
  var s = await setup(t);
  var tables = [];
  for (var i = 1; i <= 15; i++) tables.push(i);
  var res = await s.post(payload({ table: tables.join(","), tables: tables }));
  assert.equal(res.status, 201);
  var json = await res.json();
  assert.equal(json.order.table, "1,2,3,4,5,6,7,8,9,10,11,12,13,14,15");
  assert.deepEqual(json.order.tables, tables);
});
