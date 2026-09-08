"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const WS = require("ws");
const { createRelay } = require("../server");
const { createOrderStreamState, createSyncStatusTracker } = require("../kds-bridge");

async function setup(t, env = {}) {
  const relay = createRelay({ port: 0, env: Object.assign({ MOCK: "1" }, env),
    log() {}, auditLog: { record() {} }, source: {
      async listReservations() { return []; }, async listSyncEvents() { return []; }, async getReservation() { return null; }
    } });
  relay.start();
  await once(relay.server, "listening");
  t.after(() => relay.stop());
  const base = "http://127.0.0.1:" + relay.server.address().port;
  function connect(headers = {}) {
    const socket = new WS(base.replace("http:", "ws:") + "/ws/orders", { origin: headers.Origin || base, headers });
    t.after(() => socket.terminate());
    return socket;
  }
  return { relay, base, connect };
}

test("注文がなくてもheartbeatで同期正常を保ち、受信停止時は遅延を検出する", { timeout: 9000 }, async t => {
  const { connect } = await setup(t);
  const socket = connect();
  const first = JSON.parse((await once(socket, "message"))[0]);
  const state = createOrderStreamState();
  const tracker = createSyncStatusTracker({ channels: ["orders"] });
  state.accept(first);
  tracker.success("orders", 0);
  const received = once(socket, "message");
  const heartbeat = JSON.parse((await received)[0]);
  assert.equal(heartbeat.type, "heartbeat");
  assert.equal(heartbeat.sequence, first.sequence);
  assert.equal(state.accept(heartbeat), null);
  // ネットワーク配送が500ms遅れても、次のheartbeat直前まで正常を維持する。
  tracker.success("orders", 5500);
  assert.equal(tracker.snapshot(10500).channels.orders.state, "normal");
  // 受信が止まった場合の既存の警告は維持する。
  assert.equal(tracker.snapshot(15500).channels.orders.state, "delayed");
});

test("WebSocket: 初期全件・複数端末への差分・冪等再送・取消・再接続", { timeout: 10000 }, async t => {
  const { base, connect } = await setup(t);
  const a = connect(), b = connect();
  const initial = await Promise.all([once(a, "message"), once(b, "message")]);
  assert.equal(JSON.parse(initial[0][0]).type, "orders.snapshot");
  async function post(qty) {
    return fetch(base + "/api/orders", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId: "test-1", table: "1", items: [{ name: "ご飯", qty }] }) });
  }
  let waiting = Promise.all([once(a, "message"), once(b, "message")]);
  assert.equal((await post(1)).status, 201);
  const created = (await waiting).map(x => JSON.parse(x[0]));
  assert.deepEqual(created[0], created[1]);
  assert.equal(created[0].type, "order.created");
  assert.equal((await (await post(1)).json()).duplicate, true);
  waiting = once(a, "message");
  await post(3);
  const updated = JSON.parse((await waiting)[0]);
  assert.equal(updated.type, "order.updated");
  assert.equal(updated.sequence, created[0].sequence + 1);
  assert.equal(updated.order.items[0].qty, 3);
  const c = connect();
  const snapshot = JSON.parse((await once(c, "message"))[0]);
  assert.equal(snapshot.sequence, updated.sequence);
  assert.equal(snapshot.orders[0].items[0].qty, 3);
  waiting = once(a, "message");
  await fetch(base + "/api/orders/test-1", { method: "DELETE" });
  assert.equal(JSON.parse((await waiting)[0]).type, "order.cancelled");
  assert.equal((await fetch(base + "/kds")).status, 200);
});

test("WebSocket: Originと既存Cookie認証を検証", { timeout: 10000 }, async t => {
  const { connect } = await setup(t, { RELAY_TOKEN: "test-token-123", RELAY_TRUST_LOOPBACK: "0" });
  const bad = connect({ Origin: "https://evil.example" });
  bad.on("error", () => {});
  const rejected = once(bad, "unexpected-response");
  const [, res] = await rejected;
  assert.equal(res.statusCode, 403);
  res.resume();
  bad.terminate();
  const unauthenticated = connect();
  unauthenticated.on("error", () => {});
  const [, denied] = await once(unauthenticated, "unexpected-response");
  assert.equal(denied.statusCode, 401);
  denied.resume();
  unauthenticated.terminate();
  const good = connect({ Cookie: "relay_token=test-token-123" });
  assert.equal(JSON.parse((await once(good, "message"))[0]).type, "orders.snapshot");
});

test("受信状態: 重複を無視し欠番を拒否、再起動はスナップショットで復旧", () => {
  const state = createOrderStreamState();
  const order = { orderId: "a", table: "1", orderedAt: new Date().toISOString(), items: [] };
  assert.equal(state.accept({ type: "orders.snapshot", sessionId: "a", sequence: 5, orders: [order] }).length, 1);
  assert.equal(state.accept({ type: "order.cancelled", sessionId: "a", sequence: 5, orderId: "a" }), null);
  assert.throws(() => state.accept({ type: "order.cancelled", sessionId: "a", sequence: 7, orderId: "a" }));
  assert.throws(() => state.accept({ type: "heartbeat", sessionId: "b", sequence: 0 }));
  assert.deepEqual(state.accept({ type: "orders.snapshot", sessionId: "b", sequence: 0, orders: [] }), []);
});


test("接続前の注文は最初のsnapshotに入り、TTL切れを取消配信する", { timeout: 5000 }, async t => {
  const { relay, connect } = await setup(t);
  relay.orders.set("seed", { id: "seed", table: "1", type: "new", start: Date.now(), people: 1, items: [] });
  const socket = connect();
  const first = JSON.parse((await once(socket, "message"))[0]);
  assert.equal(first.type, "orders.snapshot");
  assert.equal(first.orders[0].orderId, "seed");
  const waiting = once(socket, "message");
  relay.orders.get("seed").start = 0;
  const cancelled = JSON.parse((await waiting)[0]);
  assert.equal(cancelled.type, "order.cancelled");
  assert.equal(cancelled.sequence, first.sequence + 1);
});
