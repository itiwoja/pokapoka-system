/**
 * xlsx-reader.js — Excel (.xlsx) の最初のシートを行の配列へ読む
 *
 * TableCheck の管理画面から受け取った予約一覧が .xlsx だったため、CSV と同じ取込処理へ渡せるよう
 * セルの文字列だけを取り出す。書式・数式・結合セルは扱わない。依存を増やさないよう、
 * ZIP の展開は node:zlib、XML は必要な要素だけを正規表現で読む。
 */
"use strict";

var zlib = require("node:zlib");

var MAX_ENTRIES = 2000;
// 展開後の合計。ZIP 爆弾よけ。展開と走査はリクエストの処理中に同期で行うため、止まる時間も抑える
var MAX_INFLATED_BYTES = 10 * 1024 * 1024;
var EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
var EXCEL_1904_EPOCH_MS = Date.UTC(1904, 0, 1);   // Mac 版 Excel の「1904年から計算」
// 日付・時刻の組み込み書式の番号。27〜36・50〜58 は日本語版 Excel の和暦・年月日の書式
var BUILTIN_DATE_FORMATS = [[14, 22], [27, 36], [45, 47], [50, 58]];

/** バイト列が ZIP (xlsx) かどうか */
function isXlsx(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50;
}

/**
 * .xlsx のバイト列 → 最初のシートの行 [{line, cells: string[]}]。空の行は除く。
 * 読めないファイルなら Error を投げる
 */
function readXlsxRows(buf) {
  var files = unzip(buf);
  var parts = locateParts(files);
  var sheet = part(files, parts.sheet);
  if (sheet == null) throw new Error("シートが見つかりません");
  var sharedXml = part(files, parts.sharedStrings);
  var stylesXml = part(files, parts.styles);
  var shared = sharedXml != null ? sharedStrings(sharedXml) : [];
  var dateStyles = stylesXml != null ? dateStyleIndexes(stylesXml) : {};
  var workbookPr = /<workbookPr\b([^>]*)/.exec(part(files, parts.workbook) || "");
  var date1904 = workbookPr ? /^(?:1|true)$/.test(attr(workbookPr[1], "date1904") || "") : false;
  var epoch = date1904 ? EXCEL_1904_EPOCH_MS : EXCEL_EPOCH_MS;

  var rows = [];
  var rowPattern = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
  var m, sequential = 0;
  while ((m = rowPattern.exec(sheet))) {
    var rowNumber = Number(attr(m[1], "r")) || sequential + 1;
    sequential = rowNumber;
    var cells = [];
    var cellPattern = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    var c, column = -1;
    while ((c = cellPattern.exec(m[2] || ""))) {
      var ref = attr(c[1], "r");
      column = ref ? columnIndex(ref) : column + 1;
      cells[column] = cellValue(c[1], c[2] || "", shared, dateStyles, epoch);
    }
    for (var i = 0; i < cells.length; i++) if (cells[i] == null) cells[i] = "";
    if (cells.some(function (v) { return v.trim() !== ""; })) rows.push({ line: rowNumber, cells: cells });
  }
  return rows;
}

/* ---- ZIP ---- */

/** ZIP の中身を {パス: UTF-8 の文字列} で返す。xlsx に要る .xml / .rels だけを展開する */
function unzip(buf) {
  var eocd = -1;
  for (var i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("ZIP の終端が見つかりません");
  var count = buf.readUInt16LE(eocd + 10);
  var offset = buf.readUInt32LE(eocd + 16);
  if (count > MAX_ENTRIES) throw new Error("ファイル数が多すぎます");

  var files = {};
  var inflated = 0;
  for (var n = 0; n < count; n++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50) throw new Error("ZIP の目次が壊れています");
    var method = buf.readUInt16LE(offset + 10);
    var compressedSize = buf.readUInt32LE(offset + 20);
    var nameLength = buf.readUInt16LE(offset + 28);
    var extraLength = buf.readUInt16LE(offset + 30);
    var commentLength = buf.readUInt16LE(offset + 32);
    var localOffset = buf.readUInt32LE(offset + 42);
    var name = buf.toString("utf8", offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    if (!/\.(?:xml|rels)$/i.test(name)) continue;

    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("ZIP の中身が壊れています");
    var start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    var data = buf.subarray(start, start + compressedSize);
    var out;
    if (method === 0) out = data;
    else if (method === 8) out = zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, MAX_INFLATED_BYTES - inflated) });
    else throw new Error("対応していない圧縮形式です");
    inflated += out.length;
    if (inflated > MAX_INFLATED_BYTES) throw new Error("展開後のサイズが大きすぎます");
    files[name] = out.toString("utf8");
  }
  return files;
}

/** ZIP 内の部品を名前で引く。部品名は大文字小文字を区別しない (OPC の決まり) */
function part(files, name) {
  if (name == null) return null;
  if (files[name] != null) return files[name];
  var lower = name.toLowerCase();
  var key = Object.keys(files).find(function (k) { return k.toLowerCase() === lower; });
  return key ? files[key] : null;
}

/** 目次 (.rels) の Target を、元の部品のあるフォルダから見たパスにする */
function resolveTarget(baseDir, target) {
  if (target.charAt(0) === "/") return target.slice(1);
  var out = baseDir ? baseDir.split("/") : [];
  target.split("/").forEach(function (seg) {
    if (seg === "..") out.pop();
    else if (seg && seg !== ".") out.push(seg);
  });
  return out.join("/");
}

function relationships(xml) {
  var out = [];
  var pattern = /<Relationship\b([^>]*)\/?>/g, r;
  while ((r = pattern.exec(xml || ""))) out.push({ id: attr(r[1], "Id"), type: attr(r[1], "Type") || "", target: attr(r[1], "Target") || "" });
  return out;
}

/**
 * 目次をたどって、ブック・最初のシート・共有文字列・書式の部品の場所を決める。
 * Excel 以外のツールで作り直したファイルは置き場所が違うことがあるため、決め打ちにしない
 */
function locateParts(files) {
  var office = relationships(part(files, "_rels/.rels")).find(function (rel) { return /\/officeDocument$/.test(rel.type); });
  var workbook = office ? resolveTarget("", office.target) : "xl/workbook.xml";
  var dir = workbook.indexOf("/") >= 0 ? workbook.slice(0, workbook.lastIndexOf("/")) : "";
  var rels = relationships(part(files, (dir ? dir + "/" : "") + "_rels/" + workbook.slice(dir ? dir.length + 1 : 0) + ".rels"));
  function byType(suffix) {
    var rel = rels.find(function (x) { return x.type.slice(-suffix.length) === suffix; });
    return rel ? resolveTarget(dir, rel.target) : null;
  }
  var sheet = /<sheet\b([^>]*)\/?>/.exec(part(files, workbook) || "");
  var id = sheet && (attr(sheet[1], "r:id") || attr(sheet[1], "id"));
  var sheetRel = id && rels.find(function (x) { return x.id === id; });
  return {
    workbook: workbook,
    sheet: sheetRel ? resolveTarget(dir, sheetRel.target) : (dir ? dir + "/" : "") + "worksheets/sheet1.xml",
    sharedStrings: byType("/sharedStrings") || (dir ? dir + "/" : "") + "sharedStrings.xml",
    styles: byType("/styles") || (dir ? dir + "/" : "") + "styles.xml",
  };
}

/* ---- XML ---- */

// 属性名ごとの正規表現。セルごとに作り直さないよう作り置く
var attrPatterns = {};

function attr(attrs, name) {
  var pattern = attrPatterns[name] || (attrPatterns[name] =
    new RegExp("(?:^|\\s)" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*=\\s*(\"([^\"]*)\"|'([^']*)')"));
  var m = pattern.exec(attrs);
  return m ? decodeXml(m[2] != null ? m[2] : m[3]) : null;
}

function decodeXml(s) {
  return String(s)
    .replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g, function (all, dec, hex, named) {
      if (named) return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[named];
      return String.fromCodePoint(dec ? Number(dec) : parseInt(hex, 16));
    })
    // OOXML の制御文字の書き方 (_x000D_ など)
    .replace(/_x([0-9A-Fa-f]{4})_/g, function (all, hex) { return String.fromCharCode(parseInt(hex, 16)); });
}

/** <t> の文字列をつなぐ。ふりがな (<rPh>) は本文ではないので除く */
function richText(xml) {
  var out = "";
  var pattern = /<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g, m;
  var body = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
  while ((m = pattern.exec(body))) out += decodeXml(m[1] || "");
  return out;
}

function sharedStrings(xml) {
  var out = [];
  var pattern = /<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g, m;
  while ((m = pattern.exec(xml))) out.push(richText(m[1] || ""));
  return out;
}

/** 日付の表示形式が付いたセル書式の番号 (cellXfs の並び順) → true */
function dateStyleIndexes(xml) {
  var custom = {};
  var fmtPattern = /<numFmt\b([^>]*)\/?>/g, f;
  while ((f = fmtPattern.exec(xml))) {
    var code = (attr(f[1], "formatCode") || "").replace(/"[^"]*"|\[[^\]]*\]/g, "");
    custom[attr(f[1], "numFmtId")] = /[ymdhs]/i.test(code);
  }
  var out = {};
  var xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml);
  if (!xfs) return out;
  var xfPattern = /<xf\b([^>]*?)(?:\/>|>)/g, x, index = 0;
  while ((x = xfPattern.exec(xfs[1]))) {
    var id = Number(attr(x[1], "numFmtId") || 0);
    var builtin = BUILTIN_DATE_FORMATS.some(function (range) { return id >= range[0] && id <= range[1]; });
    if (builtin || custom[String(id)]) out[index] = true;
    index++;
  }
  return out;
}

function cellValue(attrs, inner, shared, dateStyles, epoch) {
  var type = attr(attrs, "t") || "n";
  if (type === "inlineStr") return richText(inner);
  var v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner);
  var raw = v ? decodeXml(v[1]) : "";
  if (type === "s") return shared[Number(raw)] != null ? shared[Number(raw)] : "";
  if (type === "b") return raw === "1" ? "TRUE" : raw === "0" ? "FALSE" : raw;
  if (type === "n" && raw !== "" && dateStyles[Number(attr(attrs, "s") || 0)] && isFinite(Number(raw))) return serialToText(Number(raw), epoch);
  return raw;
}

/** Excel の日付シリアル値 → "YYYY-MM-DD HH:MM" (時刻が0なら日付だけ) */
function serialToText(serial, epoch) {
  var d = new Date(epoch + Math.round(serial * 86400) * 1000);
  var date = d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate());
  if (serial >= 1 && serial % 1 === 0) return date;
  var time = pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes());
  return serial < 1 ? time : date + " " + time;
}

function columnIndex(ref) {
  var letters = /^[A-Z]+/i.exec(ref);
  if (!letters) return 0;
  var n = 0;
  for (var i = 0; i < letters[0].length; i++) n = n * 26 + letters[0].toUpperCase().charCodeAt(i) - 64;
  return n - 1;
}

function pad2(n) { return (n < 10 ? "0" : "") + n; }

module.exports = {
  isXlsx: isXlsx,
  readXlsxRows: readXlsxRows,
};
