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

test("buildStarLine: 状態リセットで始まり、卓番・品名がShift_JISで含まれる", function () {
  var job = printer.normalizeJob({
    table: "A3",
    meta: "18:30",
    items: [{ name: "究極の卵かけ御飯", qty: 2, note: "卵多め" }],
  });
  var buf = printer.buildStarLine(job);
  // 左寄せ(ESC GS a 0) + 等倍(ESC i 0 0) + 強調解除(ESC F) の10バイトで始まる
  assert.equal(buf.slice(0, 10).toString("latin1"), "\x1b\x1d\x61\x00\x1b\x69\x00\x00\x1b\x46");
  // ESC @ は実機(mC-Print3)で解釈されず "@" が印字されるため一切使わない
  assert.equal(buf.indexOf(Buffer.from("\x1b\x40", "latin1")), -1);
  assert.notEqual(buf.indexOf(iconv.encode("卓  A3", "Shift_JIS")), -1);
  assert.notEqual(buf.indexOf(iconv.encode("究極の卵かけ御飯", "Shift_JIS")), -1);
  assert.notEqual(buf.indexOf(iconv.encode("  x 2", "Shift_JIS")), -1);
  assert.notEqual(buf.indexOf(iconv.encode("卵多め", "Shift_JIS")), -1);
});

test("normalizeStyle: 不正値・欠損は既定値へ丸める", function () {
  var st = printer.normalizeStyle({
    paperWidth: 9999, qtyFormat: "evil", feedLines: -3,
    tableBold: 0, sepTop: "solid", itemSize: 22,
  });
  assert.equal(st.paperWidth, 80);       // 許容リスト外 → 既定値
  assert.equal(st.qtyFormat, "x");
  assert.equal(st.feedLines, 0);         // 範囲へクランプ
  assert.equal(st.tableBold, false);
  assert.equal(st.sepTop, "solid");
  assert.equal(st.itemSize, 22);
  assert.deepEqual(printer.normalizeStyle(null), printer.STYLE_DEFAULTS);
});

test("buildStarLine: スタイル指定が印字コマンドへ反映される (#144追補)", function () {
  var job = printer.normalizeJob({
    table: "B7",
    meta: "12:00",
    store: "土鍋飯ぽかぽか",
    style: {
      storeShow: true, metaShow: false, qtyFormat: "kosuu",
      tableSize: 24, tableBold: false, itemSize: 14, itemBold: false,
      sepTop: "none", sepBottom: "dashed", paperWidth: 58, feedLines: 2, noteShow: false,
    },
    items: [{ name: "焼売", qty: 3, note: "醤油なし" }],
  });
  var buf = printer.buildStarLine(job);
  assert.notEqual(buf.indexOf(iconv.encode("土鍋飯ぽかぽか", "Shift_JIS")), -1);  // 店名印字
  assert.equal(buf.indexOf(iconv.encode("12:00", "Shift_JIS")), -1);              // metaShow:false
  assert.notEqual(buf.indexOf(iconv.encode("  3 個", "Shift_JIS")), -1);          // 数量表記
  assert.equal(buf.indexOf(iconv.encode("醤油なし", "Shift_JIS")), -1);           // noteShow:false
  assert.equal(buf.indexOf(Buffer.from("========", "latin1")), -1);               // sepTop:none
  assert.notEqual(buf.indexOf(Buffer.from(new Array(25).join("-"), "latin1")), -1); // 58mm=24桁の破線
  // 卓番: tableSize<40 なので拡大しない (ESC i 1 1 を出さない)
  assert.equal(buf.indexOf(Buffer.from("\x1b\x69\x01\x01", "latin1")), -1);
  // 品目: itemSize<22 なので横2倍(ESC i 0 1)を使わない
  assert.equal(buf.indexOf(Buffer.from("\x1b\x69\x00\x01", "latin1")), -1);
  // tableBold/itemBold ともに false なら強調ON(ESC E)は一度も出ない
  assert.equal(buf.indexOf(Buffer.from("\x1b\x45", "latin1")), -1);
  assert.notEqual(buf.indexOf(Buffer.from("\x1b\x61\x02", "latin1")), -1);        // feedLines:2 → ESC a 2
});

test("buildStarLine: style未指定は既定の見た目 (店名なし・x表記・卓番2倍角)", function () {
  var job = printer.normalizeJob({
    table: "A3", meta: "18:30",
    items: [{ name: "焼売", qty: 2, note: "" }],
  });
  var buf = printer.buildStarLine(job);
  assert.equal(buf.indexOf(iconv.encode("ぽかぽか", "Shift_JIS")), -1);  // storeが空なら印字しない
  assert.notEqual(buf.indexOf(iconv.encode("  x 2", "Shift_JIS")), -1);
  assert.notEqual(buf.indexOf(Buffer.from("\x1b\x1d\x61\x01", "latin1")), -1);   // 卓番は中央寄せ ESC GS a 1
  assert.notEqual(buf.indexOf(Buffer.from("\x1b\x69\x01\x01", "latin1")), -1);   // 卓番は縦横2倍 ESC i 1 1
  assert.notEqual(buf.indexOf(Buffer.from("\x1b\x45", "latin1")), -1);           // tableBold既定true → ESC E
  assert.notEqual(buf.indexOf(Buffer.from("\x1b\x64\x03", "latin1")), -1);       // 末尾は部分カット ESC d 3
});

/* エミュレーション取り違えの再発防止 (#144)。
   ESC/POS のコマンドを送ると mC-Print3 (STAR Line Mode) では解釈されず、
   コマンド文字がそのまま伝票に印字される。送信自体は成功扱いになり気づけないため、
   ESC/POS 固有のバイト列が混ざっていないことをテストで固定する */
test("buildStarLine: ESC/POS 固有のコマンドを混ぜない", function () {
  var job = printer.normalizeJob({
    table: "A3", meta: "18:30", store: "土鍋飯ぽかぽか",
    items: [{ name: "焼売", qty: 2, note: "醤油" }],
  });
  var buf = printer.buildStarLine(job);
  assert.equal(buf.indexOf(Buffer.from("\x1d\x21", "latin1")), -1);       // GS !  (ESC/POSの文字サイズ)
  assert.equal(buf.indexOf(Buffer.from("\x1b\x6d", "latin1")), -1);       // ESC m (ESC/POSの部分カット)
  assert.equal(buf.indexOf(Buffer.from("\x1b\x64\x02", "latin1")), -1);   // ESC d 2 (STARではフルカット)
  assert.equal(buf.indexOf(Buffer.from("\x1b\x40", "latin1")), -1);       // ESC @ (実機では "@" が印字される)
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
