"use strict";

/**
 * テスト用の最小の .xlsx を組み立てる (共有文字列・ふりがな・日付シリアル・インライン文字列を含む)。
 * 実物の TableCheck の予約一覧は個人情報を含むため、リポジトリには入れずこれで代える
 */
var zlib = require("node:zlib");

function crc32(buf) {
  var c, crc = 0xffffffff;
  for (var i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries) {
  var locals = [], centrals = [], offset = 0;
  Object.keys(entries).forEach(function (name) {
    var raw = Buffer.from(entries[name], "utf8");
    var data = zlib.deflateRawSync(raw);
    var nameBuf = Buffer.from(name, "utf8");
    var local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(raw), 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    var central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10); central.writeUInt32LE(crc32(raw), 16); central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  });
  var dir = Buffer.concat(centrals);
  var end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat(locals.concat([dir, end]));
}

function colName(i) {
  var s = "";
  for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + (i - 1) % 26) + s;
  return s;
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * rows の各セルは文字列 (共有文字列にする)、{serial} (独自の日付書式の数値)、
 * {serial, builtin: true} (日本語版 Excel の組み込み日付書式 57 の数値)、{inline} (インライン文字列)。
 * options.date1904 が真なら、Mac 版 Excel の「1904年から計算」のブックにする。
 * options.relocated が真なら、Excel 以外のツールのように部品を別の場所・名前に置き、目次 (.rels) でたどらせる
 */
function buildXlsx(rows, options) {
  options = options || {};
  var strings = [];
  var sheetRows = rows.map(function (cells, r) {
    return '<row r="' + (r + 1) + '">' + cells.map(function (v, c) {
      var ref = colName(c) + (r + 1);
      if (v === "") return "";
      if (v && v.serial != null) return '<c r="' + ref + '" s="' + (v.builtin ? 2 : 1) + '"><v>' + v.serial + "</v></c>";
      if (v && v.inline != null) return '<c r="' + ref + '" t="inlineStr"><is><t>' + esc(v.inline) + "</t></is></c>";
      strings.push(v);
      return '<c r="' + ref + '" t="s"><v>' + (strings.length - 1) + "</v></c>";
    }).join("") + "</row>";
  }).join("");
  var ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  var dir = options.relocated ? "book/" : "xl/";
  var sharedName = options.relocated ? "strings/Shared.xml" : "sharedStrings.xml";
  var entries = {
    "[Content_Types].xml": '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
  };
  var rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";
  if (options.relocated) {
    entries["_rels/.rels"] = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="' + rel + 'officeDocument" Target="book/Workbook.xml"/></Relationships>';
  }
  entries[dir + (options.relocated ? "Workbook.xml" : "workbook.xml")] = '<?xml version="1.0"?><workbook ' + ns + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    (options.date1904 ? '<workbookPr date1904="1"/>' : "") +
    '<sheets><sheet name="予約" sheetId="1" r:id="rId1"/></sheets></workbook>';
  entries[dir + "_rels/" + (options.relocated ? "Workbook.xml" : "workbook.xml") + ".rels"] =
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="' + rel + 'worksheet" Target="worksheets/sheet1.xml"/>' +
    (options.relocated ? '<Relationship Id="rId2" Type="' + rel + 'sharedStrings" Target="' + sharedName + '"/>' +
      '<Relationship Id="rId3" Type="' + rel + 'styles" Target="/book/Styles.xml"/>' : "") +
    "</Relationships>";
  entries[dir + (options.relocated ? "Styles.xml" : "styles.xml")] = '<?xml version="1.0"?><styleSheet ' + ns + '><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm"/></numFmts>' +
    '<cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="164" applyNumberFormat="1"/><xf numFmtId="57" applyNumberFormat="1"/></cellXfs></styleSheet>';
  entries[dir + sharedName] = '<?xml version="1.0"?><sst ' + ns + ">" + strings.map(function (s) {
    // ふりがな (rPh) を付けておく。日本語の Excel で保存し直すと付き、本文ではないので読み飛ばす必要がある
    return '<si><t xml:space="preserve">' + esc(s) + '</t><rPh sb="0" eb="1"><t>フリガナ</t></rPh></si>';
  }).join("") + "</sst>";
  entries[dir + "worksheets/sheet1.xml"] = '<?xml version="1.0"?><worksheet ' + ns + "><sheetData>" + sheetRows + "</sheetData></worksheet>";
  return zip(entries);;
}

module.exports = { buildXlsx: buildXlsx };
