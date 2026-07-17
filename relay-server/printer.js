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
var MAX_STORE_LEN = 30;

/* 印刷スタイル (slip-style-designer.html の設定JSON) の既定値と許容値。
   ESC/POS は文字サイズが段階的(等倍/2倍)のため、px指定は倍率へ丸めて解釈する。
   未指定・不正値は従来の見た目(#144時点)と同じになるよう既定値へ丸める */
var STYLE_DEFAULTS = {
  paperWidth: 80,      // 58 or 80 (区切り線の桁数に影響)
  feedLines: 5,        // カット前の紙送り行数 0..8
  storeShow: true,     // 店名行を印字するか (店名文字列は job.store)
  tableSize: 40,       // >=40 で2倍角、それ未満は等倍 (拡大だけESC/POSに反映)
  tableBold: true,
  metaShow: true,
  itemSize: 18,        // >=22 で横2倍、それ未満は等倍
  itemBold: true,
  qtyFormat: "x",      // "x" | "times" | "kosuu"
  noteShow: true,
  sepTop: "dashed",    // "dashed" | "solid" | "none" (#144時点は"="の実線)
  sepBottom: "none",
};
var STYLE_ALLOWED = {
  paperWidth: [58, 80],
  feedLines: { min: 0, max: 8 },
  storeShow: "bool",
  tableSize: { min: 10, max: 99 },
  tableBold: "bool",
  metaShow: "bool",
  itemSize: { min: 10, max: 99 },
  itemBold: "bool",
  qtyFormat: ["x", "times", "kosuu"],
  noteShow: "bool",
  sepTop: ["dashed", "solid", "none"],
  sepBottom: ["dashed", "solid", "none"],
};

var ESC = "\x1b", GS = "\x1d";
var IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** 日本語テキストをShift_JISへ変換する */
function sjis(text) { return iconv.encode(String(text), "Shift_JIS"); }
/** ESC/POS制御バイト列。文字コード=バイト値のため latin1 でそのまま組み立てる */
function ctl(text) { return Buffer.from(text, "latin1"); }

/** 印刷スタイルを許容値へ丸める (不正なJSONを送られても印字が壊れない) */
function normalizeStyle(style) {
  var out = Object.assign({}, STYLE_DEFAULTS);
  if (!style || typeof style !== "object") return out;
  Object.keys(STYLE_DEFAULTS).forEach(function (key) {
    var rule = STYLE_ALLOWED[key];
    var val = style[key];
    if (val == null) return;
    if (rule === "bool") { out[key] = !!val; return; }
    if (Array.isArray(rule)) { if (rule.indexOf(val) !== -1) out[key] = val; return; }
    var n = Number(val);
    if (!isNaN(n)) out[key] = Math.min(rule.max, Math.max(rule.min, Math.round(n)));
  });
  return out;
}

/** 伝票データを検証・正規化する (店側の入力ミスや欠損で印字が壊れないよう既定値に丸める) */
function normalizeJob(body) {
  var items = Array.isArray(body && body.items) ? body.items.slice(0, MAX_ITEMS) : [];
  return {
    table: body && body.table != null ? String(body.table).slice(0, MAX_TABLE_LEN) : "--",
    meta: body && body.meta != null ? String(body.meta).slice(0, MAX_META_LEN) : "",
    store: body && body.store != null ? String(body.store).slice(0, MAX_STORE_LEN) : "",
    style: normalizeStyle(body && body.style),
    items: items.map(function (it) {
      return {
        name: String((it && it.name) || "").slice(0, MAX_ITEM_NAME_LEN),
        qty: Math.max(1, Number(it && it.qty) || 1),
        note: it && it.note ? String(it.note).slice(0, MAX_ITEM_NOTE_LEN) : "",
      };
    }),
  };
}

/** 数量1行分のテキスト表記 (設定ツールの「数量の表記」に対応) */
function qtyText(format, qty) {
  if (format === "times") return "  × " + qty;
  if (format === "kosuu") return "  " + qty + " 個";
  return "  x " + qty;
}

/** 区切り線1行 ("none"は空文字)。用紙幅で桁数を変える (58mm=24桁 / 80mm=32桁) */
function sepLine(kind, paperWidth) {
  if (kind === "none") return "";
  var cols = paperWidth === 58 ? 24 : 32;
  var ch = kind === "solid" ? "=" : "-";
  return new Array(cols + 1).join(ch) + "\n";
}

/** チビ伝1枚分のESC/POSバイト列を組み立てる (感熱ロール紙想定。style未指定は従来相当) */
function buildEscPos(job) {
  var st = job.style || STYLE_DEFAULTS;
  var parts = [];
  parts.push(ctl(ESC + "@"));                                              // 初期化

  if (st.storeShow && job.store) {
    parts.push(ctl(ESC + "\x61\x01"));                                     // 中央寄せ
    parts.push(sjis(job.store + "\n"));
    parts.push(ctl(ESC + "\x61\x00"));
  }

  var tableScale = st.tableSize >= 40 ? "\x11" : "\x00";                   // 2倍角 or 等倍
  parts.push(ctl(ESC + "\x61\x01" + GS + "\x21" + tableScale + (st.tableBold ? ESC + "\x45\x01" : "")));
  parts.push(sjis("卓  " + job.table + "\n"));
  parts.push(ctl(ESC + "\x45\x00" + GS + "\x21\x00" + ESC + "\x61\x00"));   // 太字・拡大・寄せ 解除

  if (st.metaShow && job.meta) parts.push(sjis(job.meta + "\n"));
  var top = sepLine(st.sepTop, st.paperWidth);
  if (top) parts.push(ctl(top));

  var itemScale = st.itemSize >= 22 ? "\x01" : "\x00";                     // 横2倍 or 等倍
  job.items.forEach(function (it) {
    parts.push(ctl(GS + "\x21" + itemScale + (st.itemBold ? ESC + "\x45\x01" : "")));
    parts.push(sjis(it.name + "\n"));
    parts.push(ctl(ESC + "\x45\x00" + GS + "\x21\x00"));                   // 太字・拡大 解除
    parts.push(sjis(qtyText(st.qtyFormat, it.qty) + "\n"));
    if (st.noteShow && it.note) parts.push(sjis("  ※ " + it.note + "\n"));
    parts.push(ctl("\n"));
  });

  var bottom = sepLine(st.sepBottom, st.paperWidth);
  if (bottom) parts.push(ctl(bottom));

  if (st.feedLines > 0) parts.push(ctl(ESC + "\x64" + String.fromCharCode(st.feedLines)));  // 紙送り
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
  normalizeStyle: normalizeStyle,
  buildEscPos: buildEscPos,
  isPrivateIPv4: isPrivateIPv4,
  sendToPrinter: sendToPrinter,
  PRINT_PORT: PRINT_PORT,
  STYLE_DEFAULTS: STYLE_DEFAULTS,
};
