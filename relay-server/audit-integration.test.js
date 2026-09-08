"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
var http = require("node:http");
var events = require("node:events");
var serverModule = require("./server");

function request(server, pathname, options) {
  options = options || {};
  return new Promise(function (resolve, reject) {
    var req = http.request({
      host: "127.0.0.1",
      port: server.address().port,
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

test("重要操作と認証拒否を秘匿済み監査ログへ残し、認証済みAPIで検索・exportできる", async function (t) {
  var TOKEN = "pokapoka-audit-secret";
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "pokapoka-audit-integration-"));
  t.after(function () { fs.rmSync(dir, { recursive: true, force: true }); });

  var fakePrinter = {
    isPrivateIPv4: function (ip) { return /^192\.168\./.test(String(ip)); },
    normalizeStyle: function (body) { return body || {}; },
  };
  var relay = serverModule.createRelay({
    port: 0,
    env: { MOCK: "1", RELAY_TOKEN: TOKEN, RELAY_TRUST_LOOPBACK: "0" },
    source: {
      listReservations: async function () { return []; },
      listSyncEvents: async function () { return []; },
      getReservation: async function () { return null; },
    },
    mockSource: {},
    printer: fakePrinter,
    auditLogPath: path.join(dir, "audit.jsonl"),
    printerIpPath: path.join(dir, "printer.json"),
    slipStylePath: path.join(dir, "style.json"),
    log: function () {},
    setInterval: function () { return 0; },
    clearInterval: function () {},
  });
  t.after(function () { return relay.stop(); });
  relay.start();
  await events.once(relay.server, "listening");
  await relay.whenInitialSync();

  var invalid = "not-the-real-secret";
  assert.equal((await request(relay.server, "/api/orders?token=" + invalid)).status, 401);

  var authHeaders = {
    Authorization: "Bearer " + TOKEN,
    "Content-Type": "application/json",
    "X-Relay-Device": "customer-alice@example.test",
  };
  assert.equal((await request(relay.server, "/api/seats", {
    method: "POST", headers: authHeaders, body: JSON.stringify({ table: "5" }),
  })).status, 201);
  assert.equal((await request(relay.server, "/api/seats/5", {
    method: "DELETE", headers: authHeaders,
  })).status, 204);
  assert.equal((await request(relay.server, "/api/orders", {
    method: "POST", headers: authHeaders,
    body: JSON.stringify({ orderId: "audit-o-1", table: "5", items: [{ name: "秘密にする品目", qty: 1 }] }),
  })).status, 201);
  assert.equal((await request(relay.server, "/api/orders/audit-o-1", {
    method: "DELETE", headers: authHeaders,
  })).status, 204);
  assert.equal((await request(relay.server, "/api/printer", {
    method: "POST", headers: authHeaders, body: JSON.stringify({ ip: "192.168.1.60" }),
  })).status, 200);
  assert.equal((await request(relay.server, "/api/slip-style", {
    method: "POST", headers: authHeaders, body: JSON.stringify({ fontSize: 28 }),
  })).status, 200);

  var searched = await request(relay.server, "/api/audit?operation=order.cancel", { headers: authHeaders });
  assert.equal(searched.status, 200);
  var rows = JSON.parse(searched.text);
  assert.equal(rows.length, 1);
  assert.match(rows[0].target, /^order:[0-9a-f]{16}$/);
  assert.equal(rows[0].actor.authMechanism, "header");
  assert.match(rows[0].actor.device, /^device:[0-9a-f]{16}$/);

  var exported = await request(relay.server, "/api/audit?format=jsonl", { headers: authHeaders });
  assert.equal(exported.status, 200);
  assert.match(String(exported.headers["content-type"]), /application\/x-ndjson/);
  assert.doesNotMatch(exported.text, new RegExp(TOKEN));
  assert.doesNotMatch(exported.text, new RegExp(invalid));
  assert.doesNotMatch(exported.text, /秘密にする品目/);
  assert.doesNotMatch(exported.text, /audit-o-1/);
  assert.doesNotMatch(exported.text, /customer-alice@example\.test/);
  var allRows = exported.text.trim().split("\n").map(JSON.parse);
  assert.ok(allRows.some(function (row) { return row.operation === "auth.denied" && row.result === "denied"; }));
  assert.ok(allRows.some(function (row) { return row.operation === "seat.create"; }));
  assert.ok(allRows.some(function (row) { return row.operation === "seat.release"; }));
  assert.ok(allRows.some(function (row) { return row.operation === "order.create"; }));
  assert.ok(allRows.some(function (row) { return row.operation === "order.cancel"; }));
  assert.ok(allRows.some(function (row) { return row.operation === "printer.update"; }));
  assert.ok(allRows.some(function (row) { return row.operation === "slip-style.update"; }));
});
