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
// 展開後の合計。ZIP 爆弾よけ。展開と走査はリクエストの処理中に同期で行うため、止まる時間も抑える。
// 展開するのは読む部品 (ブック・目次・最初のシート・共有文字列・書式) だけなので、取込の上限 (5MB) の圧縮率でも足りる
var MAX_INFLATED_BYTES = 20 * 1024 * 1024;
// 1行の列数と行数の上限。右端の列 (XFD) に1セルだけ置いた行を大量に並べたファイルで、メモリと時間を食わないため
var MAX_COLUMNS = 1000;
var MAX_ROWS = 5000;
var EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
var EXCEL_1904_EPOCH_MS = Date.UTC(1904, 0, 1);   // Mac 版 Excel の「1904年から計算」
// 日付・時刻の組み込み書式の番号 → 種類。27〜36・50〜58 は日本語版 Excel の書式 (32〜35 は時刻)
var BUILTIN_DATE_FORMATS = [
  [14, 17, "date"], [18, 21, "time"], [22, 22, "datetime"], [27, 31, "date"], [32, 35, "time"],
  [36, 36, "date"], [45, 47, "time"], [50, 58, "date"],
];

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
      if (column >= MAX_COLUMNS) continue;   // 予約一覧に要る列はずっと左にある。右端の列は読まない
      cells[column] = cellValue(c[1], c[2] || "", shared, dateStyles, epoch);
    }
    for (var i = 0; i < cells.length; i++) if (cells[i] == null) cells[i] = "";
    if (cells.some(function (v) { return v.trim() !== ""; })) {
      if (rows.length >= MAX_ROWS) throw new Error("行数が多すぎます");
      rows.push({ line: rowNumber, cells: cells });
    }
  }
  return rows;
}

/* ---- ZIP ---- */

/**
 * ZIP の目次を読み、.xml / .rels の部品を {パス: 圧縮されたままの中身} で返す。
 * 展開は part() で読むときに行い、読まない部品 (ほかのシート・ピボット・図形など) は展開しない
 */
function unzip(buf) {
  var eocd = -1;
  for (var i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("ZIP の終端が見つかりません");
  var count = buf.readUInt16LE(eocd + 10);
  var offset = buf.readUInt32LE(eocd + 16);
  if (count > MAX_ENTRIES) throw new Error("ファイル数が多すぎます");

  var entries = {};
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
    entries[name] = { method: method, data: buf.subarray(start, start + compressedSize) };
  }
  return { entries: entries, inflated: 0, cache: {} };
}

/** ZIP 内の部品を名前で引き、UTF-8 の文字列にする。部品名は大文字小文字を区別しない (OPC の決まり) */
function part(files, name) {
  if (name == null) return null;
  var key = files.entries[name] ? name : Object.keys(files.entries).find(function (k) { return k.toLowerCase() === name.toLowerCase(); });
  if (!key) return null;
  if (files.cache[key] != null) return files.cache[key];
  var entry = files.entries[key];
  var out;
  if (entry.method === 0) out = entry.data;
  else if (entry.method === 8) {
    try { out = zlib.inflateRawSync(entry.data, { maxOutputLength: Math.max(1, MAX_INFLATED_BYTES - files.inflated) }); }
    catch (err) {
      // 上限を超えると zlib が英語の RangeError を投げるので、画面に出す言葉へ置き換える
      throw new Error(err instanceof RangeError ? "展開後のサイズが大きすぎます。期間を区切って書き出してください" : "ZIP の中身を展開できません");
    }
  } else throw new Error("対応していない圧縮形式です");
  files.inflated += out.length;
  if (files.inflated > MAX_INFLATED_BYTES) throw new Error("展開後のサイズが大きすぎます。期間を区切って書き出してください");
  return (files.cache[key] = out.toString("utf8"));
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

/** 日付・時刻の表示形式が付いたセル書式の番号 (cellXfs の並び順) → "date" / "time" / "datetime" */
function dateStyleIndexes(xml) {
  var custom = {};
  var fmtPattern = /<numFmt\b([^>]*)\/?>/g, f;
  while ((f = fmtPattern.exec(xml))) {
    var code = (attr(f[1], "formatCode") || "").replace(/"[^"]*"|\[[^\]]*\]/g, "");
    // m は月にも分にも使うので、年 (y) か日 (d) があるものを日付とみなす
    var hasDate = /[yd]/i.test(code);
    var hasTime = /[hs]/i.test(code);
    custom[attr(f[1], "numFmtId")] = hasDate && hasTime ? "datetime" : hasTime ? "time" : hasDate ? "date" : null;
  }
  var out = {};
  var xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml);
  if (!xfs) return out;
  var xfPattern = /<xf\b([^>]*?)(?:\/>|>)/g, x, index = 0;
  while ((x = xfPattern.exec(xfs[1]))) {
    var id = Number(attr(x[1], "numFmtId") || 0);
    var builtin = BUILTIN_DATE_FORMATS.find(function (range) { return id >= range[0] && id <= range[1]; });
    var kind = builtin ? builtin[2] : custom[String(id)];
    if (kind) out[index] = kind;
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
  var kind = dateStyles[Number(attr(attrs, "s") || 0)];
  if (type === "n" && raw !== "" && kind && isFinite(Number(raw))) return serialToText(Number(raw), epoch, kind);
  return raw;
}

/**
 * Excel の日付シリアル値 → "YYYY-MM-DD HH:MM" / "YYYY-MM-DD" / "HH:MM"。
 * 書式が日時なら 0時ちょうど (整数のシリアル) でも時刻を残す。日付の書式でも端数があれば時刻を付ける
 */
function serialToText(serial, epoch, kind) {
  var d = new Date(epoch + Math.round(serial * 86400) * 1000);
  var date = d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate());
  var time = pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes());
  if (kind === "time" || serial < 1) return time;
  if (kind === "datetime" || serial % 1 !== 0) return date + " " + time;
  return date;
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
