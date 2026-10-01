"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");
const WS = require("ws");
const { createRelay } = require("../server");
const { createOrderStreamState } = require("../kds-bridge");
const { startMockOrderScenario } = require("../mock-order-scenario");

const SOURCE = {
  async listReservations() { return []; }, async listSyncEvents() { return []; }, async getReservation() { return null; },
};

async function setup(t, env = {}) {
  const relay = createRelay({ port: 0, env: Object.assign({ MOCK: "1" }, env), log() {}, auditLog: { record() {} }, source: SOURCE });
  relay.start();
  await once(relay.server, "listening");
  t.after(() => relay.stop());
  return { relay, port: relay.server.address().port };
}

function selfSignedCert(t) {
  try { execFileSync("openssl", ["version"], { stdio: "ignore" }); }
  catch (_) { return null; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-tls-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cert = path.join(dir, "cert.pem"), key = path.join(dir, "key.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=127.0.0.1", "-keyout", key, "-out", cert], { stdio: "ignore" });
  return { cert, key };
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { rejectUnauthorized: false }, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    }).on("error", reject);
  });
}

test("TLS証明書を渡すとHTTPSで画面を配信し、WSSでスナップショットを受信できる", { timeout: 15000 }, async t => {
  const tls = selfSignedCert(t);
  if (!tls) return t.skip("openssl がないため自己署名証明書を作れない");
  const { port } = await setup(t, { TLS_CERT_FILE: tls.cert, TLS_KEY_FILE: tls.key, MOCK_ORDER_SCENARIO: "1" });
  const base = "https://127.0.0.1:" + port;
  const socket = new WS("wss://127.0.0.1:" + port + "/ws/orders", { origin: base, rejectUnauthorized: false });
  t.after(() => socket.terminate());
  const snapshot = JSON.parse((await once(socket, "message"))[0]);
  assert.equal(snapshot.type, "orders.snapshot");
  assert.deepEqual(snapshot.orders.map(order => order.orderId), ["mock-001", "mock-002"]);
  const health = await getJson(base + "/api/health");
  assert.equal(health.status, 200);
  assert.equal(health.body.ordersStream.clients, 1);
});

test("TLS証明書と秘密鍵の片方だけ、LIVEでのモックシナリオは起動エラー", () => {
  const options = { port: 0, log() {}, auditLog: { record() {} }, source: SOURCE };
  assert.throws(() => createRelay(Object.assign({ env: { MOCK: "1", TLS_CERT_FILE: "cert.pem" } }, options)), /tlsKey/);
  assert.throws(() => createRelay(Object.assign({ env: { TABLECHECK_API_KEY: "k", SHOP_ID: "s", MOCK_ORDER_SCENARIO: "1" } }, options)),
    /MOCK モードでのみ/);
});

test("KDSのACKを記録し、/api/health で追従状況を確認できる", { timeout: 10000 }, async t => {
  const { port } = await setup(t);
  const base = "http://127.0.0.1:" + port;
  const socket = new WS("ws://127.0.0.1:" + port + "/ws/orders", { origin: base });
  t.after(() => socket.terminate());
  const state = createOrderStreamState();
  assert.equal(state.ack(), null);
  state.accept(JSON.parse((await once(socket, "message"))[0]));
  // 別セッション・未来の番号・不正JSONは記録しない
  socket.send(JSON.stringify({ type: "orders.ack", sessionId: "other", sequence: 0 }));
  socket.send(JSON.stringify(Object.assign(state.ack(), { sequence: 99 })));
  socket.send("{");
  await new Promise(resolve => setTimeout(resolve, 200));
  let stream = (await (await fetch(base + "/api/health")).json()).ordersStream;
  assert.equal(stream.lowestAck, null);
  assert.equal(stream.upToDate, 0);
  socket.send(JSON.stringify(state.ack()));
  for (let i = 0; i < 50; i++) {
    stream = (await (await fetch(base + "/api/health")).json()).ordersStream;
    if (stream.upToDate === 1) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(stream.upToDate, 1);
  assert.equal(stream.lowestAck, stream.sequence);
});

test("モック注文シナリオ: 初期2件、5秒後追加・10秒後更新・15秒後取消", () => {
  const orders = new Map();
  const timers = [];
  let refreshed = 0;
  const scenario = startMockOrderScenario({ orders, refresh: () => refreshed++, now: () => 1000,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {} });
  assert.deepEqual(Array.from(orders.keys()), ["mock-001", "mock-002"]);
  assert.equal(refreshed, 1);
  assert.deepEqual(timers.map(timer => timer.ms), [5000, 10000, 15000]);
  timers[0].fn();
  assert.ok(orders.has("mock-003"));
  timers[1].fn();
  assert.equal(orders.get("mock-001").items[0].qty, 3);
  timers[2].fn();
  assert.equal(orders.has("mock-002"), false);
  assert.equal(refreshed, 4);
  scenario.stop();
});
