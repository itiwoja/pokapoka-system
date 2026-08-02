/**
 * printer.js — チビ伝の実機印刷 (Star mC-Print3 MCP31LB WT JP 等・ESC/POS RAWポート)
 *
 * KDS(ブラウザ)は生TCPソケットを開けないため、relay-server(Node)が仲介する。
 * プリンターIPは店舗ネットワーク依存のため固定埋め込みせず、リクエストボディで受け取る(#144)。
 *
 * 依存: iconv-lite (Node標準にShift_JISが無いため。日本語ESC/POS印字にほぼ必須の変換)。
 * relay-server は元々「依存パッケージゼロ」方針だが、この変換だけは自前実装だと
 * 文字化けリスクが残るため例外的に依存を許容する(判断の経緯は #144 参照)。
 */
"use strict";

var net = require("net");
var iconv = require("iconv-lite");

var PRINT_PORT = 9100;                 // ESC/POS RAWポートの事実上の標準
var DEFAULT_TIMEOUT_MS = 5000;
var MAX_TABLE_LEN = 20;
var MAX_META_LEN = 40;
var MAX_ITEMS = 50;
var MAX_ITEM_NAME_LEN = 60;
var MAX_ITEM_NOTE_LEN = 80;

var ESC = "\x1b", GS = "\x1d";
var IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** 日本語テキストをShift_JISへ変換する */
function sjis(text) { return iconv.encode(String(text), "Shift_JIS"); }
/** ESC/POS制御バイト列。文字コード=バイト値のため latin1 でそのまま組み立てる */
function ctl(text) { return Buffer.from(text, "latin1"); }

/** 伝票データを検証・正規化する (店側の入力ミスや欠損で印字が壊れないよう既定値に丸める) */
function normalizeJob(body) {
  var items = Array.isArray(body && body.items) ? body.items.slice(0, MAX_ITEMS) : [];
  return {
    table: body && body.table != null ? String(body.table).slice(0, MAX_TABLE_LEN) : "--",
    meta: body && body.meta != null ? String(body.meta).slice(0, MAX_META_LEN) : "",
    items: items.map(function (it) {
      return {
        name: String((it && it.name) || "").slice(0, MAX_ITEM_NAME_LEN),
        qty: Math.max(1, Number(it && it.qty) || 1),
        note: it && it.note ? String(it.note).slice(0, MAX_ITEM_NOTE_LEN) : "",
      };
    }),
  };
}

/** チビ伝1枚分のESC/POSバイト列を組み立てる (80mm感熱ロール紙想定) */
function buildEscPos(job) {
  var parts = [];
  parts.push(ctl(ESC + "@"));                                              // 初期化
  parts.push(ctl(ESC + "\x61\x01" + GS + "\x21\x11" + ESC + "\x45\x01"));   // 中央寄せ・2倍角・太字
  parts.push(sjis("卓  " + job.table + "\n"));
  parts.push(ctl(ESC + "\x45\x00" + GS + "\x21\x00" + ESC + "\x61\x00"));   // 太字・拡大・寄せ 解除
  if (job.meta) parts.push(sjis(job.meta + "\n"));
  parts.push(ctl("================================\n"));
  job.items.forEach(function (it) {
    parts.push(ctl(GS + "\x21\x01" + ESC + "\x45\x01"));                   // 横2倍・太字
    parts.push(sjis(it.name + "\n"));
    parts.push(ctl(ESC + "\x45\x00" + GS + "\x21\x00"));                   // 太字・拡大 解除
    parts.push(sjis("  x " + it.qty + "\n"));
    if (it.note) parts.push(sjis("  ※ " + it.note + "\n"));
    parts.push(ctl("\n"));
  });
  parts.push(ctl(ESC + "\x64\x05"));                    // 5行送り
  parts.push(ctl(ESC + "\x64\x02" + ESC + "\x6d"));      // カット
  return Buffer.concat(parts);
}

/** 店内LAN想定のプライベートIPv4のみ許可する (印刷経由での外部/任意ホストへの送信を防ぐ) */
function isPrivateIPv4(value) {
  var m = IPV4_RE.exec(String(value == null ? "" : value).trim());
  if (!m) return false;
  var a = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (a.some(function (n) { return n < 0 || n > 255; })) return false;
  if (a[0] === 10) return true;
  if (a[0] === 172 && a[1] >= 16 && a[1] <= 31) return true;
  if (a[0] === 192 && a[1] === 168) return true;
  return false;
}

/**
 * 生ソケットでESC/POSバイト列をプリンターへ送信する。
 * connect は差し替え可能(テストで実ソケットを開かずに済ませるため)。
 */
function sendToPrinter(ip, buffer, options) {
  options = options || {};
  var port = options.port || PRINT_PORT;
  var timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  var connect = options.connect || net.connect;
  return new Promise(function (resolve, reject) {
    var socket = connect(port, ip);
    var settled = false;
    function finish(err) {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err); else resolve();
    }
    socket.setTimeout(timeoutMs);
    socket.on("timeout", function () { finish(new Error("printer timeout: " + ip + ":" + port)); });
    socket.on("error", finish);
    socket.on("connect", function () {
      socket.end(buffer, function () { finish(); });
    });
  });
}

module.exports = {
  normalizeJob: normalizeJob,
  buildEscPos: buildEscPos,
  isPrivateIPv4: isPrivateIPv4,
  sendToPrinter: sendToPrinter,
  PRINT_PORT: PRINT_PORT,
};
