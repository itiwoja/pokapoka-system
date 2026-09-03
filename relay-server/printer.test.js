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

test("buildEscPos: 属性リセットで始まり、卓番・品名がShift_JISで含まれる", function () {
  var job = printer.normalizeJob({
    table: "A3",
    meta: "18:30",
    items: [{ name: "究極の卵かけ御飯", qty: 2, note: "卵多め" }],
  });
  var buf = printer.buildEscPos(job);
  // ESC @ は実機で解釈されず "@" が印字されてしまうので送らない。代わりに寄せ・拡大・強調を既定へ戻す
  assert.equal(buf.slice(0, 10).toString("latin1"), "\x1b\x1da\x00\x1bi\x00\x00\x1bF");
  assert.equal(buf.indexOf(Buffer.from("\x1b@", "latin1")), -1, "ESC @ は送らない");
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

test("buildEscPos: スタイル指定が印字コマンドへ反映される (#144追補)", function () {
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
  var buf = printer.buildEscPos(job);
  assert.notEqual(buf.indexOf(iconv.encode("土鍋飯ぽかぽか", "Shift_JIS")), -1);  // 店名印字
  assert.equal(buf.indexOf(iconv.encode("12:00", "Shift_JIS")), -1);              // metaShow:false
  assert.notEqual(buf.indexOf(iconv.encode("  3 個", "Shift_JIS")), -1);          // 数量表記
  assert.equal(buf.indexOf(iconv.encode("醤油なし", "Shift_JIS")), -1);           // noteShow:false
  assert.equal(buf.indexOf(Buffer.from("========", "latin1")), -1);               // sepTop:none
  assert.notEqual(buf.indexOf(Buffer.from(new Array(25).join("-"), "latin1")), -1); // 58mm=24桁の破線
  // 卓番: tableSize<40 なので2倍角(GS ! 0x11)ではなく等倍(GS ! 0x00)
  assert.equal(buf.indexOf(Buffer.from("\x1d\x21\x11", "latin1")), -1);
  // 品目: itemSize<22 なので横2倍(GS ! 0x01)を使わない
  assert.equal(buf.indexOf(Buffer.from("\x1d\x21\x01", "latin1")), -1);
});

test("buildEscPos: style未指定は従来相当 (店名なし・x表記・2倍角卓番)", function () {
  var job = printer.normalizeJob({
    table: "A3", meta: "18:30",
    items: [{ name: "焼売", qty: 2, note: "" }],
  });
  var buf = printer.buildEscPos(job);
  assert.equal(buf.indexOf(iconv.encode("ぽかぽか", "Shift_JIS")), -1);  // storeが空なら印字しない
  assert.notEqual(buf.indexOf(iconv.encode("  x 2", "Shift_JIS")), -1);
  // 卓番2倍角は Star の ESC i n1 n2。ESC/POS の GS ! は本番機(mC-Print3)で効かないことを実機で確認済み
  assert.notEqual(buf.indexOf(Buffer.from("\x1b\x69\x01\x01", "latin1")), -1);
  assert.equal(buf.indexOf(Buffer.from("\x1d\x21", "latin1")), -1, "ESC/POS の文字サイズ命令は送らない");
  assert.equal(buf.indexOf(Buffer.from("\x1b\x61", "latin1")), -1, "ESC/POS の寄せ命令は送らない");
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

/** 実ソケットの代役。end() は FIN 相当で、close は相手が閉じたときにテスト側から発火させる */
function fakeSocket() {
  var socket = new EventEmitter();
  socket.setTimeout = function () {};
  socket.destroy = function () {};
  socket.end = function (buffer) { socket.written = buffer; };
  return socket;
}

test("sendToPrinter: 書き込み完了ではなく、相手が接続を閉じてから解決する", async function () {
  var socket = fakeSocket();
  var seen = null;
  var resolved = false;
  var promise = printer.sendToPrinter("192.168.1.50", Buffer.from("hi"), {
    connect: function (port, ip) { seen = { port: port, ip: ip }; return socket; },
  }).then(function () { resolved = true; });

  socket.emit("connect");
  await new Promise(function (r) { setImmediate(r); });
  // プリンターが読み切る前に解決すると、RSTでジョブが捨てられても成功扱いになってしまう
  assert.equal(resolved, false, "close 前は解決しない");
  assert.equal(socket.written.toString(), "hi");

  socket.emit("close");
  await promise;
  assert.equal(resolved, true);
  assert.deepEqual(seen, { port: printer.PRINT_PORT, ip: "192.168.1.50" });
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

/* ===== ラスター(画像)印字 ===== */

/** 幅widthドット・高さheight行の1bitラスターを作る (中身は0埋め) */
function fakeRaster(width, height) {
  var widthBytes = Math.ceil(width / 8);
  return {
    raster: {
      width: width,
      height: height,
      data: Buffer.alloc(widthBytes * height).toString("base64"),
    },
  };
}

test("normalizeRaster: 正しい寸法とデータ長なら受理する", function () {
  var r = printer.normalizeRaster(fakeRaster(576, 10));
  assert.equal(r.widthBytes, 72);
  assert.equal(r.height, 10);
  assert.equal(r.bits.length, 720);
});

test("normalizeRaster: 寸法とデータ長が食い違うものは拒否する", function () {
  var body = fakeRaster(576, 10);
  body.raster.height = 11;     // データは10行ぶんしかない
  assert.equal(printer.normalizeRaster(body), null);
});

test("normalizeRaster: 上限を超える寸法・ラスター無しは拒否する", function () {
  assert.equal(printer.normalizeRaster(fakeRaster(600, 10)), null);    // 幅が印字可能幅超え
  assert.equal(printer.normalizeRaster(fakeRaster(576, 2401)), null);  // 高さが上限超え
  assert.equal(printer.normalizeRaster({}), null);
});

test("buildRaster(escpos): GS v 0 を帯に分けて送り、カットで終わる", function () {
  var r = printer.normalizeRaster(fakeRaster(576, 300));
  var buf = printer.buildRaster(r, { feedLines: 3, emulation: "escpos" });
  var hex = buf.toString("latin1");
  assert.ok(hex.startsWith("\x1b@"), "初期化で始まる");
  // 300行 = 128 + 128 + 44 の3帯
  var bands = hex.split("\x1d\x76\x30\x00").length - 1;
  assert.equal(bands, 3);
  // 最終帯の高さ(44)がリトルエンディアンで入っている
  assert.ok(hex.indexOf("\x1d\x76\x30\x00\x48\x00\x2c\x00") !== -1);
  assert.ok(hex.indexOf("\x1b\x64\x03") !== -1, "紙送り3行");
  assert.ok(hex.endsWith("\x1b\x64\x02\x1bm"), "カットで終わる");
});

test("buildRaster(starprnt): ESC GS S で画像を1コマンドで送り、Starのカットで終わる", function () {
  var r = printer.normalizeRaster(fakeRaster(576, 300));
  var buf = printer.buildRaster(r, { feedLines: 2, emulation: "starprnt" });
  var hex = buf.toString("latin1");
  // 1B 1D 53 01 xL xH yL yH 00 : 幅72バイト(=576ドット)・高さ300ドット
  assert.ok(hex.indexOf("\x1b\x1dS\x01\x48\x00\x2c\x01\x00") !== -1, "ESC GS S のヘッダ");
  assert.equal(hex.split("\x1b\x1dS").length - 1, 1, "画像は1コマンドで送る");
  assert.ok(hex.indexOf("\x1d\x76\x30") === -1, "ESC/POS の GS v 0 は混ぜない");
  assert.ok(hex.indexOf("\x1b@") === -1, "ESC @ は送らない (実機で @ が印字される)");
  assert.ok(hex.startsWith("\x1b\x1da\x00\x1bi\x00\x00\x1bF"), "属性リセットで始まる");
  assert.ok(hex.endsWith("\n\n\x1b\x64\x33"), "紙送り2行 + ESC d 3 (ASCIIの'3') で終わる");
});

test("buildRaster(starline): ラスターモードで囲み、b コマンドを行数ぶん送る", function () {
  var r = printer.normalizeRaster(fakeRaster(384, 5));
  var buf = printer.buildRaster(r, { feedLines: 0, emulation: "starline" });
  var hex = buf.toString("latin1");
  assert.ok(hex.indexOf("\x1b\x2a\x72\x41") !== -1, "ESC * r A で開始");
  assert.ok(hex.indexOf("\x1b\x2a\x72\x50\x30\x00") !== -1, "ページ長=連続紙");
  // b n1 n2 が5行ぶん (48mm=384ドット → 48バイト/行)
  assert.equal(hex.split("\x62\x30\x00").length - 1, 5);
  assert.ok(hex.indexOf("\x1b\x0c\x00") !== -1, "ESC FF NUL で印字");
  assert.ok(hex.indexOf("\x1b\x2a\x72\x42") !== -1, "ESC * r B で終了");
  assert.ok(hex.indexOf("\x1b@") === -1, "ESC @ は送らない (実機で @ が印字される)");
  assert.ok(hex.endsWith("\x1b\x64\x33"), "Star のカットで終わる");
});

test("buildRaster: 既定は本番機(mC-Print3)の StarPRNT。未知の指定も既定へ倒す", function () {
  var r = printer.normalizeRaster(fakeRaster(576, 2));
  assert.ok(printer.buildRaster(r, {}).toString("latin1").indexOf("\x1b\x1dS") !== -1);
  assert.ok(printer.buildRaster(r, { emulation: "unknown" }).toString("latin1").indexOf("\x1b\x1dS") !== -1);
});

test("buildRaster: feedLines は 0..8 に丸める", function () {
  var r = printer.normalizeRaster(fakeRaster(576, 2));
  var over = printer.buildRaster(r, { feedLines: 99, emulation: "escpos" }).toString("latin1");
  assert.ok(over.indexOf("\x1b\x64\x08") !== -1, "8行に丸める");
  var under = printer.buildRaster(r, { feedLines: -5, emulation: "starprnt" }).toString("latin1");
  assert.ok(under.endsWith("\x1b\x64\x33"), "0行なら紙送り無しでカットへ");
});
