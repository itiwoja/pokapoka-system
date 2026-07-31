/**
 * printer.js — チビ伝の実機印刷 (Star mC-Print3 MCP31LB WT JP・STAR Line Mode / RAWポート)
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

var PRINT_PORT = 9100;                 // RAWポートの事実上の標準
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

/* ---- STAR Line Mode コマンド ----
   mC-Print3 の出荷時エミュレーションは STAR Line Mode で、ESC/POS とは体系が違う。
   同じバイト列でも意味が変わるうえ、解釈できないバイトはそのまま文字として印字されるため
   間違えても送信は成功扱いになり誰も気づけない (実測: ESC/POS版は伝票に "@" と "!" が
   混ざり、中央寄せ・倍角・太字が無言で全滅していた。ESC/POSの中央寄せ ESC a 1 は
   STAR Line Mode では「1行紙送り」)。プリンター側の設定に依存させず、出荷状態のまま
   挿せば正しく出るよう Star のネイティブコマンドで組み立てる。
   出典: STAR Line Mode Command Specifications Rev.1.80 */
function chr(n) { return String.fromCharCode(n); }
function starAlign(n)         { return ESC + GS + "\x61" + chr(n); }         // 1B 1D 61 n   0=左 1=中央
function starExpand(hi, wide) { return ESC + "\x69" + chr(hi) + chr(wide); } // 1B 69 n1 n2  0=等倍 1=2倍
function starBold(on)         { return ESC + (on ? "\x45" : "\x46"); }       // 1B 45 / 1B 46
function starFeed(lines)      { return ESC + "\x61" + chr(lines); }          // 1B 61 n      n行紙送り(1..127)
function starCut()            { return ESC + "\x64\x03"; }                   // 1B 64 03     カット位置まで送り部分カット

/* 先頭の状態リセット。初期化コマンド ESC @ (1B 40) は使わない。
   mC-Print3 実機では解釈されず "@" が伝票の1行目に印字されてしまうため(実測)。
   このモジュールが触る属性は寄せ・拡大・強調の3つだけなので、
   それらを明示的に既定へ戻せば ESC @ 無しでも開始状態は確定する */
function starReset() { return starAlign(0) + starExpand(0, 0) + starBold(false); }

/** チビ伝1枚分のSTAR Line Modeバイト列を組み立てる (感熱ロール紙想定) */
function buildStarLine(job) {
  var st = job.style || STYLE_DEFAULTS;
  var parts = [];
  parts.push(ctl(starReset()));

  if (st.storeShow && job.store) {
    parts.push(ctl(starAlign(1)));
    parts.push(sjis(job.store + "\n"));
    parts.push(ctl(starAlign(0)));
  }

  // 卓番は遠くから読めることが最優先なので縦横とも2倍にする
  var tableBig = st.tableSize >= 40 ? 1 : 0;
  parts.push(ctl(starAlign(1) + starExpand(tableBig, tableBig) + (st.tableBold ? starBold(true) : "")));
  parts.push(sjis("卓  " + job.table + "\n"));
  parts.push(ctl(starBold(false) + starExpand(0, 0) + starAlign(0)));

  if (st.metaShow && job.meta) parts.push(sjis(job.meta + "\n"));
  var top = sepLine(st.sepTop, st.paperWidth);
  if (top) parts.push(ctl(top));

  // 品名は横だけ広げる。縦に伸ばすと1枚に載る品数が減るため
  var itemWide = st.itemSize >= 22 ? 1 : 0;
  job.items.forEach(function (it) {
    parts.push(ctl(starExpand(0, itemWide) + (st.itemBold ? starBold(true) : "")));
    parts.push(sjis(it.name + "\n"));
    parts.push(ctl(starBold(false) + starExpand(0, 0)));
    parts.push(sjis(qtyText(st.qtyFormat, it.qty) + "\n"));
    if (st.noteShow && it.note) parts.push(sjis("  ※ " + it.note + "\n"));
    parts.push(ctl("\n"));
  });

  var bottom = sepLine(st.sepBottom, st.paperWidth);
  if (bottom) parts.push(ctl(bottom));

  if (st.feedLines > 0) parts.push(ctl(starFeed(st.feedLines)));
  parts.push(ctl(starCut()));
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
  buildStarLine: buildStarLine,
  isPrivateIPv4: isPrivateIPv4,
  sendToPrinter: sendToPrinter,
  PRINT_PORT: PRINT_PORT,
  STYLE_DEFAULTS: STYLE_DEFAULTS,
};
