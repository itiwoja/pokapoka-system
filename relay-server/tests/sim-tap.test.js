"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const WS = require("ws");
const { createRelay } = require("../server");

async function setup(t, env) {
  const relay = createRelay({ port: 0, env: env || {}, log() {}, auditLog: { record() {} } });
  relay.start();
  await once(relay.server, "listening");
  t.after(() => relay.stop());
  const port = relay.server.address().port;
  return { relay, port, base: "http://127.0.0.1:" + port };
}

// SSE を読み、条件を満たす flow が揃うまで待つ
function openEvents(t, base) {
  const events = [];
  const waiters = [];
  let req;
  const ready = new Promise((resolve, reject) => {
    req = http.get(base + "/sim/events", res => {
      res.setEncoding("utf8");
      let buf = "";
      res.on("data", chunk => {
        buf += chunk;
        let at;
        while ((at = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, at); buf = buf.slice(at + 2);
          const name = /^event: (.*)$/m.exec(block);
          const data = /^data: (.*)$/m.exec(block);
          if (name && data) events.push({ name: name[1], data: JSON.parse(data[1]) });
          waiters.slice().forEach(w => w());
        }
      });
      resolve(res);
    });
    req.on("error", reject);
  });
  t.after(() => req.destroy());
  function waitFor(pred, ms = 3000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for event")), ms);
      function check() {
        const hit = events.find(pred);
        if (hit) { clearTimeout(timer); waiters.splice(waiters.indexOf(check), 1); resolve(hit); }
      }
      waiters.push(check);
      check();
    });
  }
  return { events, ready, waitFor };
}

const flowOf = (path, extra) => e => e.name === "flow" && e.data.path === path && (!extra || extra(e.data));

test("SIMULATOR無効時は /sim/events /sim/state /order-client.js が404", async t => {
  const { base } = await setup(t);
  for (const p of ["/sim/events", "/sim/state", "/order-client.js", "/sim"]) {
    const res = await fetch(base + p);
    assert.equal(res.status, 404, p);
    await res.arrayBuffer();
  }
});

test("有効時: hello とバックログが届き、注文・厨房操作が flow に出る", async t => {
  const { base } = await setup(t, { SIMULATOR: "1" });
  const order = { orderId: "sim-1", table: "3", items: [{ name: "ご飯", qty: 2 }] };
  const post = await fetch(base + "/api/orders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(order) });
  assert.equal(post.status, 201);
  const sse = openEvents(t, base);
  const res = await sse.ready;
  assert.match(res.headers["content-type"], /text\/event-stream/);
  const hello = await sse.waitFor(e => e.name === "hello");
  assert.ok(hello.data.sessionId && hello.data.startedAt);
  // 接続前の POST がバックログで届く
  const created = await sse.waitFor(flowOf("/api/orders", d => d.method === "POST"));
  assert.equal(created.data.summary, "注文を受付（新規）");
  assert.equal(created.data.kind, "http");
  assert.equal(created.data.status, 201);
  assert.deepEqual(created.data.request, order);
  assert.equal(created.data.response.ok, true);
  assert.equal(created.data.changed, true);
  assert.equal(created.data.client, null);

  // 同じ内容の再送は重複
  await fetch(base + "/api/orders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(order) });
  await sse.waitFor(flowOf("/api/orders", d => d.method === "POST" && d.summary === "注文を受付（重複）"));

  // 厨房操作
  const events = [{ type: "toggle", id: "sim-1", index: 0, doneCount: 1 }, { type: "konro", id: "sim-1", num: 1, state: "cooking" }];
  const kp = await fetch(base + "/api/kitchen-state", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ events }) });
  await kp.arrayBuffer();
  const kitchen = await sse.waitFor(flowOf("/api/kitchen-state", d => d.method === "POST"));
  assert.match(kitchen.data.summary, /^厨房操作: /);
  assert.equal(kitchen.data.request.events.length, 2);

  // 失敗は summary に「失敗」を含む
  await fetch(base + "/api/orders", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const bad = await sse.waitFor(flowOf("/api/orders", d => d.status === 400));
  assert.match(bad.data.summary, /失敗/);

  // id は単調増加
  const ids = sse.events.filter(e => e.name === "flow").map(e => e.data.id);
  assert.deepEqual(ids, ids.slice().sort((a, b) => a - b));
  assert.equal(ids[0], 1);
});

test("Referer の simClient で client が決まり、同じ GET の2回目は changed=false", async t => {
  const { base } = await setup(t, { SIMULATOR: "1" });
  const headers = { Referer: "http://x/?simClient=deshap" };
  await (await fetch(base + "/api/orders", { headers })).arrayBuffer();
  await (await fetch(base + "/api/orders", { headers })).arrayBuffer();
  await (await fetch(base + "/api/health", { headers })).arrayBuffer();
  await (await fetch(base + "/api/health", { headers })).arrayBuffer();
  await (await fetch(base + "/api/orders", { headers: { "X-Sim-Client": "order", Referer: "http://x/?simClient=kds2" } })).arrayBuffer();
  await (await fetch(base + "/api/orders", { headers: { "X-Sim-Client": "bogus" } })).arrayBuffer();
  const sse = openEvents(t, base);
  await sse.ready;
  await sse.waitFor(flowOf("/api/orders", d => d.client === null));
  const flows = sse.events.filter(e => e.name === "flow").map(e => e.data);
  const orders = flows.filter(d => d.path === "/api/orders" && d.client === "deshap");
  assert.equal(orders.length, 2);
  assert.equal(orders[0].changed, true);
  assert.equal(orders[1].changed, false);
  assert.equal(orders[0].summary, "注文一覧を取得 (0件)");
  const health = flows.filter(d => d.path === "/api/health");
  assert.equal(health[0].summary, "死活確認");
  assert.equal(health[1].changed, false);
  assert.equal(flows.filter(d => d.client === "order").length, 1);
});

test("/sim/state の形と tap 対象外のパス", async t => {
  const { base } = await setup(t, { SIMULATOR: "1" });
  const state = await (await fetch(base + "/sim/state")).json();
  assert.deepEqual(Object.keys(state).sort(), ["kitchen", "orders", "ordersStream", "seats", "stock"]);
  assert.ok(Array.isArray(state.orders));
  assert.equal(typeof state.kitchen.rev, "number");
  assert.ok(state.ordersStream && typeof state.ordersStream.sequence === "number");
  // 画面ファイルが無ければ 404 (別の子が作る)。order-client.js はリポジトリ直下にあれば 200
  const sim = await fetch(base + "/sim"); await sim.arrayBuffer();
  assert.ok(sim.status === 200 || sim.status === 404);
  const sse = openEvents(t, base);
  await sse.ready;
  await sse.waitFor(e => e.name === "hello");
  await new Promise(r => setTimeout(r, 100));
  assert.equal(sse.events.filter(e => e.name === "flow" && /^\/sim|order-client/.test(e.data.path)).length, 0);
});

test("WebSocket: ws-open と order.created の ws-send、ack の ws-recv、ws-close", { timeout: 8000 }, async t => {
  const { base } = await setup(t, { SIMULATOR: "1" });
  const sse = openEvents(t, base);
  await sse.ready;
  const socket = new WS(base.replace("http:", "ws:") + "/ws/orders", { origin: base });
  t.after(() => socket.terminate());
  const msgs = [];
  socket.on("message", d => msgs.push(JSON.parse(d)));
  await once(socket, "open");
  const open = await sse.waitFor(e => e.name === "flow" && e.data.kind === "ws-open");
  assert.equal(open.data.origin, base.replace("http://", ""));
  assert.equal(open.data.path, "/ws/orders");
  await fetch(base + "/api/orders", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderId: "ws-1", table: "5", items: [{ name: "麺", qty: 1 }] }) });
  const sent = await sse.waitFor(e => e.name === "flow" && e.data.kind === "ws-send" && e.data.summary === "WS配信: order.created");
  assert.equal(sent.data.wsClients, 1);
  assert.equal(sent.data.response.type, "order.created");
  const snapshot = msgs.find(m => m.type === "orders.snapshot");
  assert.ok(snapshot);
  socket.send(JSON.stringify({ type: "orders.ack", sessionId: snapshot.sessionId, sequence: 0 }));
  const recv = await sse.waitFor(e => e.name === "flow" && e.data.kind === "ws-recv");
  assert.equal(recv.data.summary, "WS受信確認 seq 0");
  socket.close();
  await sse.waitFor(e => e.name === "flow" && e.data.kind === "ws-close");
  assert.ok(!sse.events.some(e => e.data && e.data.summary === "WS配信: heartbeat"));
});
