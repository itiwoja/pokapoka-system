"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var EventEmitter = require("node:events");
var iconv = require("iconv-lite");
var printer = require("./printer");

test("normalizeJob: 既定値へ丸め、上限文字数で切り詰める", function () {
  var job = printer.normalizeJob({
    table: "A" + "1".repeat(30),
    meta: "x".repeat(60),
    items: [
      { name: "y".repeat(80), qty: "3", note: "z".repeat(100) },
      { name: "焼売", qty: 0 },
    ],
  });
  assert.equal(job.table.length, 20);
  assert.equal(job.meta.length, 40);
  assert.equal(job.items[0].name.length, 60);
  assert.equal(job.items[0].qty, 3);
  assert.equal(job.items[0].note.length, 80);
  assert.equal(job.items[1].qty, 1); // 0以下は1に丸める
});

test("normalizeJob: 欠損値は既定値になる", function () {
  var job = printer.normalizeJob({});
  assert.equal(job.table, "--");
  assert.equal(job.meta, "");
  assert.deepEqual(job.items, []);
});

test("buildEscPos: 初期化コマンドで始まり、卓番・品名がShift_JISで含まれる", function () {
  var job = printer.normalizeJob({
    table: "A3",
    meta: "18:30",
    items: [{ name: "究極の卵かけ御飯", qty: 2, note: "卵多め" }],
  });
  var buf = printer.buildEscPos(job);
  assert.equal(buf.slice(0, 2).toString("latin1"), "\x1b@");
  assert.notEqual(buf.indexOf(iconv.encode("卓  A3", "Shift_JIS")), -1);
  assert.notEqual(buf.indexOf(iconv.encode("究極の卵かけ御飯", "Shift_JIS")), -1);
  assert.notEqual(buf.indexOf(iconv.encode("  x 2", "Shift_JIS")), -1);
  assert.notEqual(buf.indexOf(iconv.encode("卵多め", "Shift_JIS")), -1);
});

test("isPrivateIPv4: 店内LAN想定のプライベートアドレスのみ許可する", function () {
  assert.equal(printer.isPrivateIPv4("192.168.1.50"), true);
  assert.equal(printer.isPrivateIPv4("10.0.0.5"), true);
  assert.equal(printer.isPrivateIPv4("172.16.0.1"), true);
  assert.equal(printer.isPrivateIPv4("172.31.255.255"), true);
  assert.equal(printer.isPrivateIPv4("172.32.0.1"), false);
  assert.equal(printer.isPrivateIPv4("8.8.8.8"), false);
  assert.equal(printer.isPrivateIPv4("printer.example.com"), false);
  assert.equal(printer.isPrivateIPv4("999.1.1.1"), false);
  assert.equal(printer.isPrivateIPv4(""), false);
  assert.equal(printer.isPrivateIPv4(null), false);
});

function fakeSocket() {
  var socket = new EventEmitter();
  socket.setTimeout = function () {};
  socket.destroy = function () {};
  socket.end = function (buffer, cb) { socket.written = buffer; cb(); };
  return socket;
}

test("sendToPrinter: connectしてバイト列を書き込んだら解決する", async function () {
  var socket = fakeSocket();
  var seen = null;
  var promise = printer.sendToPrinter("192.168.1.50", Buffer.from("hi"), {
    connect: function (port, ip) { seen = { port: port, ip: ip }; return socket; },
  });
  socket.emit("connect");
  await promise;
  assert.deepEqual(seen, { port: printer.PRINT_PORT, ip: "192.168.1.50" });
  assert.equal(socket.written.toString(), "hi");
});

test("sendToPrinter: ソケットエラーで拒否する", async function () {
  var socket = fakeSocket();
  var promise = printer.sendToPrinter("192.168.1.50", Buffer.from("hi"), {
    connect: function () { return socket; },
  });
  socket.emit("error", new Error("ECONNREFUSED"));
  await assert.rejects(promise, /ECONNREFUSED/);
});

test("sendToPrinter: タイムアウトで拒否する", async function () {
  var socket = fakeSocket();
  var promise = printer.sendToPrinter("192.168.1.50", Buffer.from("hi"), {
    connect: function () { return socket; },
  });
  socket.emit("timeout");
  await assert.rejects(promise, /timeout/);
});
