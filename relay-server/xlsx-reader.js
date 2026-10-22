/**
 * xlsx-reader.js — Excel (.xlsx) の最初のシートを行の配列へ読む小さな読み手 (依存ゼロ)
 *
 * 予約の取込 (TableCheck の予約の書き出しは .xlsx) のためだけに使う。zip は Node 標準の zlib で開き、
 * xl/workbook.xml で最初のシートを探して、そのシートと xl/sharedStrings.xml・xl/styles.xml だけを読む。
 * 数式は計算せず、保存されている値を読む。日付の表示形式の数値セルは "YYYY-MM-DD HH:MM" の文字列にする。
 * パスワード付き (中身が zip ではない)・ZIP64・未対応の圧縮方式のファイルは読まない。
 */
"use strict";

var zlib = require("node:zlib");

var ZIP_LOCAL = 0x04034b50;
var ZIP_CENTRAL = 0x02014b50;
var ZIP_END = 0x06054b50;
var MAX_ENTRY_BYTES = 16 * 1024 * 1024;   // 1つの部品を展開した大きさの上限 (展開すると膨れる zip よけ)
var MAX_COLUMNS = 512;                    // これより右の列は読まない (TableCheck の書き出しは72列)

/** 読めない理由を店員に見せられる文で返すための例外 */
function fail(message) {
  var err = new Error(message);
  err.code = "XLSX_INVALID";
  return err;
}

/** 先頭が zip の局所ヘッダーなら xlsx とみなす */
function isXlsx(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 4 && buffer.readUInt32LE(0) === ZIP_LOCAL;
}

/* ---------------------------------------------------------------- zip */

/** 中央ディレクトリを読み、部品名から中身を取り出す関数を返す */
function openZip(buf) {
  var end = -1;
  for (var i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === ZIP_END) { end = i; break; }
  }
  if (end < 0) throw fail("zip の終わりが見つかりません");
  var total = buf.readUInt16LE(end + 10);
  var dirSize = buf.readUInt32LE(end + 12);
  var dirOffset = buf.readUInt32LE(end + 16);
  if (total === 0xffff || dirOffset === 0xffffffff) throw fail("ZIP64 の形式には対応していません");
  if (dirOffset + dirSize > end) throw fail("zip の目次が壊れています");

  var entries = {};
  var p = dirOffset;
  for (var n = 0; n < total; n++) {
    if (p + 46 > end || buf.readUInt32LE(p) !== ZIP_CENTRAL) throw fail("zip の目次が壊れています");
    var nameLength = buf.readUInt16LE(p + 28);
    var name = buf.toString("utf8", p + 46, p + 46 + nameLength).replace(/^\/+/, "").toLowerCase();
    entries[name] = {
      flags: buf.readUInt16LE(p + 8),
      method: buf.readUInt16LE(p + 10),
      compressedSize: buf.readUInt32LE(p + 20),
      size: buf.readUInt32LE(p + 24),
      offset: buf.readUInt32LE(p + 42),
    };
    p += 46 + nameLength + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }

  /** 部品を展開して文字列で返す (部品名の大文字・小文字は区別しない)。無ければ null */
  return function read(name) {
    var e = entries[name.toLowerCase()];
    if (!e) return null;
    if (e.flags & 1) throw fail("パスワード付きのファイルは読めません");
    if (e.size > MAX_ENTRY_BYTES) throw fail("ファイルが大きすぎます");
    if (e.offset + 30 > buf.length || buf.readUInt32LE(e.offset) !== ZIP_LOCAL) throw fail("zip の中身が壊れています");
    var start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
    if (start + e.compressedSize > buf.length) throw fail("zip の中身が壊れています");
    var raw = buf.subarray(start, start + e.compressedSize);
    var data;
    if (e.method === 0) data = raw;
    else if (e.method === 8) {
      try { data = zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES }); }
      catch (err) { throw fail(err && err.code === "ERR_BUFFER_TOO_LARGE" ? "ファイルが大きすぎます" : "zip の中身を展開できません"); }
    } else throw fail("未対応の圧縮方式です");
    return data.toString("utf8").replace(/^\uFEFF/, "");
  };
}

/* ---------------------------------------------------------------- XML の小道具 */

// 名前空間の接頭辞 (x:row など) が付いていても読めるようにする。[1] は属性、[2] は中身 (空要素なら undefined)
function tagPattern(tag, flags) {
  return new RegExp("<(?:\\w+:)?" + tag + "\\b([^>]*?)(?:/>|>([\\s\\S]*?)</(?:\\w+:)?" + tag + ">)", flags == null ? "g" : flags);
}

function attr(attrs, name) {
  var m = new RegExp("\\s" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)')").exec(" " + (attrs || ""));
  return m ? decodeXml(m[1] != null ? m[1] : m[2]) : null;
}

/** XML の文字参照と、OOXML の _xHHHH_ (改行などの制御文字) を戻す */
function decodeXml(s) {
  return String(s)
    .replace(/&(?:#x([0-9a-fA-F]+)|#(\d+)|(amp|lt|gt|quot|apos));/g, function (all, hex, dec, named) {
      if (named) return { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" }[named];
      var code = hex ? parseInt(hex, 16) : Number(dec);
      return code <= 0x10ffff ? String.fromCodePoint(code) : all;
    })
    .replace(/_x([0-9a-fA-F]{4})_/g, function (all, hex) { return String.fromCharCode(parseInt(hex, 16)); });
}

/** <si>・<is> の中の文字 (書式付きの <r><t> も) をつなぐ。ふりがな (<rPh>) は除く */
function richText(xml) {
  var out = "";
  var re = tagPattern("t");
  var body = String(xml || "").replace(tagPattern("rPh"), "");
  var m;
  while ((m = re.exec(body))) out += m[2] ? decodeXml(m[2]) : "";
  return out;
}

/* ---------------------------------------------------------------- 部品ごとの読み取り */

/** xl/workbook.xml の最初のシートの部品名。たどれなければ xl/worksheets/sheet1.xml */
function firstSheet(read) {
  var workbook = read("xl/workbook.xml");
  if (workbook == null) throw fail("Excel (.xlsx) のファイルではありません");
  var sheet = tagPattern("sheet").exec(workbook);
  var relId = sheet && /\s\w+:id\s*=\s*"([^"]*)"/.exec(" " + sheet[1]);
  var rels = read("xl/_rels/workbook.xml.rels") || "";
  var re = tagPattern("Relationship");
  var m, target = null;
  while (relId && (m = re.exec(rels))) {
    if (attr(m[1], "Id") === relId[1]) { target = attr(m[1], "Target"); break; }
  }
  return {
    path: target ? resolvePath(target) : "xl/worksheets/sheet1.xml",
    date1904: /<(?:\w+:)?workbookPr\b[^>]*\sdate1904\s*=\s*["'](?:1|true)["']/.test(workbook),
  };
}

/** workbook.xml.rels の Target (xl/ からの相対、または / からの絶対) を部品名にする */
function resolvePath(target) {
  var parts = target.charAt(0) === "/" ? [] : ["xl"];
  target.split("/").forEach(function (part) {
    if (!part || part === ".") return;
    if (part === "..") parts.pop(); else parts.push(part);
  });
  return parts.join("/");
}

function readSharedStrings(xml) {
  var out = [];
  var re = tagPattern("si");
  var m;
  while ((m = re.exec(xml || ""))) out.push(richText(m[2]));
  return out;
}

// 組み込みの日付・時刻の表示形式の番号 (日本語版の 27〜36・50〜58 を含む)
function builtInDateFormat(id) {
  return (id >= 14 && id <= 22) || (id >= 27 && id <= 36) || (id >= 45 && id <= 47) || (id >= 50 && id <= 58);
}

/** 自前の表示形式が日付・時刻か。"…" の文字列・\x のエスケープ・[色] を除いて、年月日時分秒の記号を探す */
function customDateFormat(code) {
  var s = String(code).replace(/"[^"]*"/g, "").replace(/\\./g, "").replace(/\[(?![hms]+\])[^\]]*\]/gi, "");
  return /[ymdhs]/i.test(s) && !/^general$/i.test(s.trim());
}

/** xl/styles.xml → セルのスタイル番号 (cellXfs の並び) ごとに、日付の表示形式かどうか */
function readDateStyles(xml) {
  if (!xml) return [];
  var custom = {};
  var re = tagPattern("numFmt");
  var m;
  while ((m = re.exec(xml))) custom[attr(m[1], "numFmtId")] = attr(m[1], "formatCode") || "";
  var cellXfs = tagPattern("cellXfs", "").exec(xml);
  if (!cellXfs || !cellXfs[2]) return [];
  var out = [];
  var xf = /<(?:\w+:)?xf\b([^>]*)>/g;
  while ((m = xf.exec(cellXfs[2]))) {
    var id = Number(attr(m[1], "numFmtId") || 0);
    out.push(custom[id] != null ? customDateFormat(custom[id]) : builtInDateFormat(id));
  }
  return out;
}

/** Excel の日付の通し番号 → "YYYY-MM-DD HH:MM" (時刻が0なら日付だけ、1未満なら時刻だけ) */
function serialToText(serial, date1904) {
  var days = Math.floor(serial);
  var minutes = Math.round((serial - days) * 1440);
  if (minutes >= 1440) { days += 1; minutes -= 1440; }
  var time = pad2(Math.floor(minutes / 60)) + ":" + pad2(minutes % 60);
  if (days === 0 && !date1904) return time;
  var d = date1904 ? new Date(Date.UTC(1904, 0, 1 + days)) : new Date(Date.UTC(1899, 11, 30 + days));
  var date = d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate());
  return minutes ? date + " " + time : date;
}

/** "AB12" → 列番号 (0 始まり)。読めなければ null */
function columnIndex(ref) {
  var m = /^([A-Za-z]{1,3})\d*$/.exec(ref || "");
  if (!m) return null;
  var n = 0;
  m[1].toUpperCase().split("").forEach(function (ch) { n = n * 26 + (ch.charCodeAt(0) - 64); });
  return n - 1;
}

function cellValue(attrs, body, ctx) {
  var type = attr(attrs, "t") || "n";
  if (type === "inlineStr") {
    var inline = tagPattern("is", "").exec(body || "");
    return inline ? richText(inline[2]) : "";
  }
  var v = tagPattern("v", "").exec(body || "");
  if (!v || v[2] == null) return "";
  var raw = v[2];
  if (type === "s") { var s = ctx.strings[Number(raw)]; return s == null ? "" : s; }
  if (type === "b") return raw.trim() === "1" ? "TRUE" : "FALSE";
  if (type === "d") return decodeXml(raw).replace("T", " ");
  if (type === "n" && ctx.dateStyles[Number(attr(attrs, "s") || 0)]) {
    var num = Number(raw);
    if (raw.trim() !== "" && isFinite(num) && num >= 0) return serialToText(num, ctx.date1904);
  }
  return decodeXml(raw);
}

/**
 * xlsx のバイト列 → 最初のシートの行 [{line, cells[]}]。line は Excel の行番号。
 * 空の行は飛ばす。maxRows 行を読んだら、その先は読まない (行数の上限は呼び出し側で判定する)
 * @throws {Error} 読めないときは code が "XLSX_INVALID" の例外 (message は画面に出せる文)
 */
function readFirstSheet(buffer, options) {
  var maxRows = options && options.maxRows || Infinity;
  if (!isXlsx(buffer)) throw fail("Excel (.xlsx) のファイルではありません");
  var read = openZip(buffer);
  var sheet = firstSheet(read);
  var xml = read(sheet.path);
  if (xml == null) throw fail("シートが見つかりません");
  var ctx = {
    strings: readSharedStrings(read("xl/sharedStrings.xml")),
    dateStyles: readDateStyles(read("xl/styles.xml")),
    date1904: sheet.date1904,
  };

  var rows = [];
  var rowRe = tagPattern("row");
  var m, lastLine = 0;
  while (rows.length < maxRows && (m = rowRe.exec(xml))) {
    var line = Number(attr(m[1], "r")) || lastLine + 1;
    lastLine = line;
    var cells = [];
    var cellRe = tagPattern("c");
    var c, next = 0;
    while ((c = cellRe.exec(m[2] || ""))) {
      var index = columnIndex(attr(c[1], "r"));
      if (index == null) index = next;
      next = index + 1;
      if (index >= MAX_COLUMNS) continue;
      while (cells.length < index) cells.push("");
      cells[index] = cellValue(c[1], c[2], ctx);
    }
    if (cells.some(function (cell) { return String(cell).trim() !== ""; })) rows.push({ line: line, cells: cells });
  }
  return rows;
}

function pad2(n) { return (n < 10 ? "0" : "") + n; }

module.exports = { isXlsx: isXlsx, readFirstSheet: readFirstSheet };
