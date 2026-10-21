/**
 * xlsx-fixture.js — テスト用に、作り物の値で小さな .xlsx を組み立てる (テストの補助。単独では走らない)
 *
 * zip は自前で書く (deflate と無圧縮の両方)。実物の書き出しはリポジトリに入れない。
 */
"use strict";

var zlib = require("node:zlib");

var NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
var REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function escapeXml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 0 始まりの列番号 → "A", "B", …, "AA" */
function colName(i) {
  var s = "";
  for (var n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s;
  return s;
}

/** 値の並び → インライン文字列のセルの行。空の値はセルを置かない (実物と同じく飛び飛びになる) */
function inlineRow(r, values) {
  return "<row r=\"" + r + "\">" + values.map(function (v, i) {
    if (v === "" || v == null) return "";
    return "<c r=\"" + colName(i) + r + "\" t=\"inlineStr\"><is><t xml:space=\"preserve\">" + escapeXml(v) + "</t></is></c>";
  }).join("") + "</row>";
}

function worksheet(rowsXml) {
  return "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<worksheet xmlns=\"" + NS + "\"><sheetData>" +
    rowsXml.join("") + "</sheetData></worksheet>";
}

/** 部品の並び [{name, data, method}] → zip のバイト列。method は 8 (deflate、既定) か 0 (無圧縮) */
function zip(files) {
  var parts = [], central = [], offset = 0;
  files.forEach(function (f) {
    var name = Buffer.from(f.name, "utf8");
    var data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, "utf8");
    var method = f.method == null ? 8 : f.method;
    var body = method === 8 ? zlib.deflateRawSync(data) : data;
    var crc = typeof zlib.crc32 === "function" ? zlib.crc32(data) : 0;
    var local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, body);
    var dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt32LE(crc >>> 0, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);
    offset += 30 + name.length + body.length;
  });
  var dirBuf = Buffer.concat(central);
  var end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dirBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat(parts.concat([dirBuf, end]));
}

/**
 * .xlsx を組み立てる。
 * @param {{sheet: string, sheetPath?: string, otherSheets?: Object, sharedStrings?: string, styles?: string, method?: number}} options
 *   sheet は最初のシートの XML。sheetPath は xl/ からの置き場所 (既定 worksheets/sheet1.xml)。
 *   otherSheets は {xl/ からの置き場所: XML}。最初のシートより後ろのシートとして並べる
 */
function xlsx(options) {
  var sheetPath = options.sheetPath || "worksheets/sheet1.xml";
  var others = options.otherSheets || {};
  var sheets = [{ path: sheetPath, xml: options.sheet }].concat(Object.keys(others).map(function (p) { return { path: p, xml: others[p] }; }));
  var workbook = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<workbook xmlns=\"" + NS + "\" xmlns:r=\"" + REL_NS + "\"><sheets>" +
    sheets.map(function (s, i) { return "<sheet name=\"S" + (i + 1) + "\" sheetId=\"" + (i + 1) + "\" r:id=\"rId" + (i + 10) + "\"/>"; }).join("") +
    "</sheets></workbook>";
  // 最初のシートの関係を後ろに書き、並び順ではなく r:id でたどることを確かめられるようにする
  var rels = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">" +
    sheets.map(function (s, i) {
      return "<Relationship Id=\"rId" + (i + 10) + "\" Type=\"" + REL_NS + "/worksheet\" Target=\"" + s.path + "\"/>";
    }).reverse().join("") + "</Relationships>";
  var files = [
    { name: "[Content_Types].xml", data: "<?xml version=\"1.0\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"/>" },
    { name: "xl/workbook.xml", data: workbook, method: 0 },
    { name: "xl/_rels/workbook.xml.rels", data: rels },
  ];
  sheets.forEach(function (s) { files.push({ name: "xl/" + s.path, data: s.xml, method: options.method }); });
  if (options.sharedStrings != null) files.push({ name: "xl/sharedStrings.xml", data: options.sharedStrings });
  if (options.styles != null) files.push({ name: "xl/styles.xml", data: options.styles, method: 0 });
  return zip(files);
}

module.exports = { colName: colName, escapeXml: escapeXml, inlineRow: inlineRow, worksheet: worksheet, zip: zip, xlsx: xlsx, NS: NS };
