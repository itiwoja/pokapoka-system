"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { create } = require("../../order-client");
function memory() {
  const records = new Map();
  return {
    list: async () => structuredClone([...records.values()]),
    add: async r => { if (records.has(r.orderId)) throw Error("duplicate local ID"); records.set(r.orderId, structuredClone(r)); },
    put: async r => { records.set(r.orderId, structuredClone(r)); }
  };
}
const payload = () => ({ orderId: "test-1", table: "3", items: [{ name: "土鍋御膳", qty: 2 }] });
const ack = (id = "test-1") => ({ status: 201, json: async () => ({ ok: true, order: { id } }) });
const opts = store => ({ store, baseURL: "http://localhost/" });

test("保存完了前は送らず、ACKまで保持し、送信済みを再送しない", async () => {
  const store = memory(); let calls = 0;
  const client = create({ ...opts(store), fetch: async () => { calls++; assert.equal((await store.list())[0].status, "sending"); return ack(); } });
  const input = payload(); await client.submit(input); input.items[0].qty = 99;
  assert.equal(calls, 0);
  await client.flush(); await client.flush();
  assert.equal(calls, 1);
  assert.equal((await client.list())[0].status, "sent");
  assert.equal((await client.list())[0].payload.items[0].qty, 2);
  await assert.rejects(client.submit(payload()), /duplicate/);
});

test("ACK喪失・再起動後も同じIDと内容で再送し、バックオフする", async () => {
  const store = memory(); let clock = 100000; const bodies = [];
  const fetch = async (_, request) => { bodies.push(request.body); if (bodies.length === 1) throw Error("connection lost"); return ack(); };
  const first = create({ ...opts(store), now: () => clock, fetch });
  await first.submit(payload()); await first.flush(); await first.flush();
  assert.equal(bodies.length, 1);
  clock += 1000;
  const reopened = create({ ...opts(store), now: () => clock, fetch });
  await reopened.flush();
  assert.equal(bodies[0], bodies[1]);
  assert.equal((await reopened.list())[0].status, "sent");
});

test("401は自動再送せず、異なるIDのACKは成功扱いしない", async () => {
  const client = create({ ...opts(memory()), fetch: async () => ({ status: 401 }) });
  await client.submit(payload()); await client.flush();
  assert.equal((await client.list())[0].status, "failed");
  const other = create({ ...opts(memory()), fetch: async () => ack("wrong-id") });
  await other.submit(payload()); await other.flush();
  assert.equal((await other.list())[0].status, "pending");
});

test("保存失敗時は通信しない・期限切れは確認待ちにする", async () => {
  let calls = 0;
  const client = create({ ...opts({ add: async () => { throw Error("quota"); } }), fetch: async () => { calls++; } });
  await assert.rejects(client.submit(payload()), /quota/); assert.equal(calls, 0);
  let clock = 0;
  const old = create({ ...opts(memory()), now: () => clock, fetch: async () => { calls++; } });
  await old.submit(payload()); clock = 31 * 60 * 1000; await old.flush();
  assert.equal((await old.list())[0].status, "needs_review"); assert.equal(calls, 0);
});

test("実HTTPサーバーで受付後に応答を失っても注文は1件", async () => {
  const relay = require("../server").createRelay({ port: 0, env: { MOCK: "1" }, mockSource: {}, log: () => {},
    source: { listReservations: async () => [], listSyncEvents: async () => [], getReservation: async () => null } });
  relay.start();
  await require("node:events").once(relay.server, "listening");
  try {
    const baseURL = "http://127.0.0.1:" + relay.server.address().port;
    let clock = Date.now(), calls = 0;
    const client = create({ store: memory(), baseURL, now: () => clock,
      fetch: async (...args) => { const response = await fetch(...args); if (++calls === 1) { await response.text(); throw Error("ACK lost"); } return response; } });
    await client.submit(payload()); await client.flush(); clock += 1000; await client.flush();
    assert.equal((await client.list())[0].status, "sent");
    const orders = await (await fetch(baseURL + "/api/orders")).json();
    assert.equal(orders.length, 1); assert.equal(orders[0].id, "test-1");
  } finally { await relay.stop(); }
});
