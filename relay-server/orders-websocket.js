"use strict";

const crypto = require("crypto");
const auth = require("./auth");
const intake = require("./order-intake");

// HTTP と同じメモリ状態を配信する。履歴は保持せず再接続時に全件を渡す。
function attachOrdersWebSocket(server, orders, config, log) {
  let WebSocketServer;
  try { WebSocketServer = require("ws").WebSocketServer; }
  catch (err) {
    if (err.code !== "MODULE_NOT_FOUND") throw err;
    log("WebSocket無効: relay-server で npm ci を実行してください。HTTP注文取得は継続します。");
    return { refresh() {}, close() {} };
  }
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
  const sessionId = crypto.randomUUID();
  let sequence = 0;
  let previous = new Map();
  function message(type, body) {
    return Object.assign({ type, sessionId, sequence, sentAt: new Date().toISOString() }, body);
  }
  function wire(order) {
    return { orderId: order.id, table: order.table, status: order.type,
      orderedAt: new Date(order.start).toISOString(), people: order.people,
      items: order.items.map(item => ({ name: item.name, qty: item.qty,
        note: item.options, allergies: item.allergies, done: false })) };
  }
  function send(client, data) {
    if (client.readyState !== 1) return;
    if (client.bufferedAmount > 1024 * 1024) return client.terminate();
    client.send(JSON.stringify(data), err => { if (err) client.terminate(); });
  }
  function broadcast(type, body) {
    sequence++;
    const data = message(type, body);
    wss.clients.forEach(client => send(client, data));
  }
  function refresh() {
    const feed = intake.toFeed(orders, Date.now(), config.orderTtlMs);
    const next = new Map(feed.map(order => [order.id, JSON.stringify(order)]));
    feed.forEach(order => {
      if (previous.get(order.id) !== next.get(order.id)) {
        broadcast(previous.has(order.id) ? "order.updated" : "order.created", { order: wire(order) });
      }
    });
    previous.forEach((value, id) => {
      if (!next.has(id)) broadcast("order.cancelled", { orderId: id });
    });
    previous = next;
    return feed;
  }
  function upgrade(req, socket, head) {
    socket.on("error", () => {});
    function reject(code) { socket.end("HTTP/1.1 " + code + "\r\nConnection: close\r\n\r\n"); }
    let url, origin;
    try {
      url = new URL(req.url, "http://localhost");
      origin = new URL(req.headers.origin);
    } catch (_) { return reject("403 Forbidden"); }
    if (url.pathname !== "/ws/orders") return reject("404 Not Found");
    if (!/^https?:$/.test(origin.protocol) || origin.host !== req.headers.host || url.search) return reject("403 Forbidden");
    if (!auth.check(req, url, config.authToken, socket.remoteAddress, config.authTrustLoopback).ok) return reject("401 Unauthorized");
    if (wss.clients.size >= 64) return reject("503 Service Unavailable");
    const feed = refresh();
    wss.handleUpgrade(req, socket, head, client => {
      client.on("error", () => client.terminate());
      client.alive = true;
      client.on("pong", () => { client.alive = true; });
      // この経路は配信専用。注文の書込みは検証済みHTTP APIに限定する。
      client.on("message", () => {});
      send(client, message("orders.snapshot", { orders: feed.map(wire) }));
    });
  }
  server.on("upgrade", upgrade);
  const expiry = setInterval(refresh, 1000);
  const heartbeat = setInterval(() => {
    wss.clients.forEach(client => {
      if (!client.alive) return client.terminate();
      client.alive = false;
      client.ping();
      send(client, message("heartbeat"));
    });
  // KDS は最終受信から10秒で同期遅延を表示するため、通信・タイマーの余裕を残す。
  }, 5000);
  expiry.unref();
  heartbeat.unref();
  return { refresh, close() {
    clearInterval(expiry);
    clearInterval(heartbeat);
    server.removeListener("upgrade", upgrade);
    wss.clients.forEach(client => client.terminate());
    wss.close();
  } };
}

module.exports = { attachOrdersWebSocket };
