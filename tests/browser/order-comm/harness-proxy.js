"use strict";
/* 検証ハーネス用の同一origin前段サーバー (製品コードではない)。
 *  - /harness (検証画面) と /order-client.js (検証対象の root 配下) を配信する
 *  - それ以外は 127.0.0.1 の実relayへそのまま中継する (relay は無改造)
 *  - POST /api/orders だけに、制御APIで指定した通信障害を注入する
 * 外部へは一切接続しない。 */
var http = require("http");
var net = require("net");
var fs = require("fs");
var path = require("path");

function startProxy(opts) {
  var relayPort = opts.relayPort;
  var root = opts.root;
  var state = { mode: "pass", times: Infinity, status: 500, delayMs: 0 };
  var stats = { posts: [], dropped: 0 };

  function resetStats() { stats = { posts: [], dropped: 0 }; }

  function readBody(req, cb) {
    var chunks = [];
    req.on("data", function (c) { chunks.push(c); });
    req.on("end", function () { cb(Buffer.concat(chunks)); });
  }
  function consumeMode() {
    var mode = state.mode;
    if (mode === "pass") return "pass";
    if (state.times <= 0) { state.mode = "pass"; return "pass"; }
    state.times -= 1;
    return mode;
  }
  function forward(req, body, cb) {
    var headers = Object.assign({}, req.headers, { host: "127.0.0.1:" + relayPort });
    var r = http.request({ host: "127.0.0.1", port: relayPort, method: req.method, path: req.url, headers: headers }, function (res) {
      var chunks = [];
      res.on("data", function (c) { chunks.push(c); });
      res.on("end", function () { cb(null, res, Buffer.concat(chunks)); });
    });
    r.on("error", function (e) { cb(e); });
    r.end(body);
  }
  function send(res, status, headers, data) { res.writeHead(status, headers); res.end(data); }

  function handleOrderPost(req, res) {
    readBody(req, function (body) {
      var text = body.toString("utf8");
      var parsed = null; try { parsed = JSON.parse(text); } catch (e) {}
      var id = parsed && parsed.orderId != null ? String(parsed.orderId) : null;
      var entry = { orderId: id, body: text, auth: req.headers.authorization ? "present" : "absent",
        mode: null, relayStatus: null, duplicate: null, created: null, at: Date.now() };
      stats.posts.push(entry);
      var mode = consumeMode(); entry.mode = mode;
      var json = { "Content-Type": "application/json" };
      if (mode === "drop-before") { stats.dropped++; return req.socket.destroy(); }
      if (mode === "status") return send(res, state.status, json, JSON.stringify({ ok: false, error: "injected" }));
      if (mode === "ack-wrong-id") return send(res, 200, json, JSON.stringify({ ok: true, order: { id: "other-id" } }));
      if (mode === "ack-no-ok") return send(res, 200, json, JSON.stringify({ order: { id: id } }));
      if (mode === "ack-html") return send(res, 200, { "Content-Type": "text/html" }, "<html>captive portal</html>");
      function doForward() {
        forward(req, body, function (err, relayRes, relayBody) {
          if (err) { stats.dropped++; return req.socket.destroy(); }
          entry.relayStatus = relayRes.statusCode;
          try { var j = JSON.parse(relayBody.toString("utf8")); entry.duplicate = !!j.duplicate; entry.created = relayRes.statusCode === 201; } catch (e) {}
          if (mode === "drop-after") { stats.dropped++; return req.socket.destroy(); }
          send(res, relayRes.statusCode, relayRes.headers, relayBody);
        });
      }
      if (mode === "delay") return setTimeout(doForward, state.delayMs);
      doForward();
    });
  }

  var server = http.createServer(function (req, res) {
    var url = new URL(req.url, "http://x");
    if (url.pathname === "/__ctl" && req.method === "POST") {
      return readBody(req, function (b) {
        var c = JSON.parse(b.toString("utf8") || "{}");
        state = { mode: c.mode || "pass", times: c.times == null ? Infinity : c.times, status: c.status || 500, delayMs: c.delayMs || 0 };
        send(res, 200, { "Content-Type": "application/json" }, "{}");
      });
    }
    if (url.pathname === "/__stats") return send(res, 200, { "Content-Type": "application/json" }, JSON.stringify(stats));
    if (url.pathname === "/__reset") { resetStats(); return send(res, 200, {}, "ok"); }
    if (url.pathname === "/harness") return send(res, 200, { "Content-Type": "text/html; charset=utf-8" }, fs.readFileSync(path.join(__dirname, "harness.html")));
    if (url.pathname === "/order-client.js") return send(res, 200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" }, fs.readFileSync(path.join(root, "order-client.js")));
    if (url.pathname === "/api/orders" && req.method === "POST") return handleOrderPost(req, res);
    readBody(req, function (body) {
      forward(req, body, function (err, relayRes, relayBody) {
        if (err) return send(res, 502, {}, "bad gateway");
        send(res, relayRes.statusCode, relayRes.headers, relayBody);
      });
    });
  });
  server.on("upgrade", function (req, socket, head) {
    var up = net.connect(relayPort, "127.0.0.1", function () {
      var lines = [req.method + " " + req.url + " HTTP/1.1"];
      Object.keys(req.headers).forEach(function (k) { lines.push(k + ": " + (k === "host" ? "127.0.0.1:" + relayPort : req.headers[k])); });
      up.write(lines.join("\r\n") + "\r\n\r\n"); if (head && head.length) up.write(head);
      socket.pipe(up); up.pipe(socket);
    });
    up.on("error", function () { socket.destroy(); });
    socket.on("error", function () { up.destroy(); });
  });
  return new Promise(function (resolve) {
    server.listen(opts.port, "127.0.0.1", function () {
      resolve({ server: server, getStats: function () { return stats; }, close: function () { return new Promise(function (r) { server.closeAllConnections && server.closeAllConnections(); server.close(r); }); } });
    });
  });
}
module.exports = { startProxy: startProxy };
