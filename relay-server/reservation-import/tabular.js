/** CSV / Excel の列・見出し・行番号を解釈し、共通の予約下書きへ変換する。 */
"use strict";

var xlsxReader = require("../xlsx-reader");
var {
  partySize, decodeBytes, nfkc, parseDateTime, parsePeople, parseCount, parseMenuList,
  allergyNote, allergyFromAnswers, joinNotes, note, statusFrom, guestName, derivedRid, ridFrom,
} = require("./common");

var MAX_CSV_ROWS = 500;
var MAX_HEADER_SEARCH_ROWS = 5;   // 見出しの前にタイトル行などがあっても探す行数
var PEOPLE_FIELDS = partySize.KEYS;

// 列名 → 項目。上から順に照合するので、「人数:大人」が pax より先に adults へ当たる。
// TableCheck の予約一覧は「予約時間」に日付つきの日時 ("2026-10-20 11:00") が入り、「開始日」「開始時刻」もある
var CSV_FIELDS = [
  ["rid", ["予約id", "予約番号", "予約no", "id", "rid", "reservationid"]],
  ["datetime", ["来店日時", "予約日時", "日時", "startat", "datetime"]],
  ["date", ["来店日", "予約日", "開始日", "日付", "date"]],
  ["time", ["来店時間", "来店時刻", "予約時間", "開始時刻", "時間", "時刻", "time"]],
  ["name", ["予約者名", "予約者", "お名前", "名前", "氏名", "顧客名", "name"]],
  ["adults", ["大人人数", "大人", "adults", "adult"]],
  ["seniors", ["シニア人数", "シニア", "seniors", "senior"]],
  ["children", ["子供人数", "子供", "子ども", "お子様", "小人", "children", "child"]],
  ["kids", ["幼児人数", "幼児", "乳幼児", "0-2歳", "0〜2歳", "kids", "infants", "infant"]],
  ["pax", ["合計人数", "人数", "pax", "partysize"]],
  ["menu", ["事前メニュー", "メニュー", "コース", "注文", "menu", "orders"]],
  ["allergies", ["アレルギー", "allergies", "allergy"]],
  ["dislikes", ["苦手なもの", "苦手な食材", "苦手"]],
  ["request", ["ご要望", "要望", "リクエスト", "request"]],
  ["memo", ["メモ", "備考", "memo", "notes", "note"]],
  ["table", ["卓番", "卓", "テーブル", "席", "table"]],
  ["status", ["ステータス", "状態", "status"]],
];

// 年から書いた日付 ("2026-10-20" / "2026/10/20" / "2026年10月20日")
var ABSOLUTE_DATE = /\d{4}\s*[\/\-.年]\s*\d{1,2}\s*[\/\-.月]\s*\d{1,2}/;

// 部分一致で日時の項目に当てない列。予約の作成・更新・取消・終了の日時を来店日時と取り違えないため
var NOT_VISIT_TIME = /作成|更新|変更|登録|受付|取消|キャンセル|終了|支払|入金|生年|誕生/;
var TIME_FIELDS = { datetime: true, date: true, time: true };

function headerKey(value) {
  return nfkc(value).toLowerCase().replace(/[\s_\-]/g, "");
}

/** 見出し行の各列を項目へ割り当てる。完全一致を優先し、残りを部分一致 (日本語の2文字以上の別名だけ) で当てる */
function mapColumns(header) {
  var keys = header.map(headerKey);
  var columns = {};
  var used = {};
  CSV_FIELDS.forEach(function (field) {
    var index = keys.findIndex(function (key, i) { return !used[i] && field[1].indexOf(key) >= 0; });
    if (index >= 0) { columns[field[0]] = index; used[index] = true; }
  });
  CSV_FIELDS.forEach(function (field) {
    if (columns[field[0]] !== undefined) return;
    var aliases = field[1].filter(function (alias) { return alias.length >= 2 && /[^\x00-\x7f]/.test(alias); });
    var index = keys.findIndex(function (key, i) {
      if (used[i] || (TIME_FIELDS[field[0]] && NOT_VISIT_TIME.test(key))) return false;
      return aliases.some(function (alias) { return key.indexOf(alias) >= 0; });
    });
    if (index >= 0) { columns[field[0]] = index; used[index] = true; }
  });
  return columns;
}

/** RFC 4180 相当の CSV を行の配列へ (引用符・引用符内の改行に対応)。タブ区切りも受ける。各行に開始行番号を付ける */
function parseCsvRows(text) {
  text = String(text).replace(/^﻿/, "");
  // 区切り文字は先頭の数行で判定する。1行目がタイトル行 (「予約」だけ) のことがあるため
  var head = text.split(/\r?\n/, MAX_HEADER_SEARCH_ROWS + 1).join("\n");
  var delimiter = head.split("\t").length > head.split(",").length ? "\t" : ",";
  var rows = [], row = [], cell = "", quoted = false, line = 1, rowLine = 1;
  function endRow() {
    row.push(cell); cell = "";
    if (row.some(function (c) { return c.trim() !== ""; })) rows.push({ line: rowLine, cells: row });
    row = [];
  }
  for (var i = 0; i < text.length; i++) {
    var ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else {
        if (ch === "\n") line++;
        cell += ch;
      }
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === delimiter) { row.push(cell); cell = ""; }
    else if (ch === "\n") { endRow(); line++; rowLine = line; }
    else if (ch !== "\r") cell += ch;
  }
  if (cell !== "" || row.length) endRow();
  return rows;
}

/**
 * CSV → 予約の下書きの並び。
 * @param {string} text - CSV の本文 (decodeBytes 済み)
 * @param {{now?: Date}} [options]
 * @returns {{columns: Object, unmapped: string[], rows: Array<{line:number, draft:(Object|null), errors:string[]}>, error?: string}}
 *          columns は 項目 → 見出し名。error があるときはファイル全体を取り込めない
 */
function parseCsv(text, options) {
  var rows = parseCsvRows(text);
  if (!rows.length) return { columns: {}, unmapped: [], rows: [], error: "CSVに行がありません" };
  return parseTable(rows, options);
}

/** Excel (.xlsx) の最初のシート → parseCsv と同じ形 */
function parseXlsx(buffer, options) {
  var rows;
  try { rows = xlsxReader.readXlsxRows(buffer); }
  catch (err) { return { columns: {}, unmapped: [], rows: [], error: "Excelファイルを読めません (" + err.message + ")" }; }
  if (!rows.length) return { columns: {}, unmapped: [], rows: [], error: "シートに行がありません" };
  return parseTable(rows, options);
}

/** CSV か .xlsx かをバイト列の先頭で見分けて読む */
function parseSpreadsheet(buffer, options) {
  return xlsxReader.isXlsx(buffer) ? parseXlsx(buffer, options) : parseCsv(decodeBytes(buffer), options);
}

/**
 * 見出しの行を探す。来店日時 (または来店時間) の列が当たる最初の行。
 * TableCheck の出力は1行目がタイトル (「予約」) で、2行目が見出しになっている
 */
function findHeader(rows) {
  var limit = Math.min(rows.length, MAX_HEADER_SEARCH_ROWS);
  for (var i = 0; i < limit; i++) {
    var columns = mapColumns(rows[i].cells.map(function (c) { return c.trim(); }));
    if (columns.datetime !== undefined || columns.time !== undefined) return i;
  }
  return 0;
}

function parseTable(rows, options) {
  var now = options && options.now || new Date();
  var headerIndex = findHeader(rows);
  var header = rows[headerIndex].cells.map(function (c) { return c.trim(); });
  var columns = mapColumns(header);
  var named = {};
  Object.keys(columns).forEach(function (field) { named[field] = header[columns[field]]; });
  var mappedIndexes = Object.keys(columns).map(function (field) { return columns[field]; });
  var unmapped = header.filter(function (h, i) { return h && mappedIndexes.indexOf(i) < 0; });
  var base = { columns: named, unmapped: unmapped, rows: [] };
  var dataRows = rows.slice(headerIndex + 1);
  // 日付の列が無く時間の列だけなら、時間の列に日付まで入っている (TableCheck の「予約時間」) ときだけ読める
  var timeHasDate = columns.time !== undefined && dataRows.some(function (row) {
    return parseDateTime(String(row.cells[columns.time] || "").trim(), now) !== null;
  });
  if (columns.datetime === undefined && (columns.time === undefined || (columns.date === undefined && !timeHasDate))) {
    base.error = "来店日時の列が見つかりません (「来店日時」、または「来店日」と「来店時間」(「予約時間」) の列が必要)";
    return base;
  }
  if (rows.length - 1 - headerIndex > MAX_CSV_ROWS) {
    base.error = "行数が多すぎます (" + MAX_CSV_ROWS + "行まで)";
    return base;
  }

  base.rows = dataRows.map(function (row) {
    function cell(field) {
      var index = columns[field];
      return index === undefined || row.cells[index] == null ? "" : row.cells[index].trim();
    }
    var errors = [];
    // 時間の列に年つきの日付まで入っている (TableCheck の「予約時間」) なら、日付の列より優先する。
    // 日付の列が受付日など来店日でない場合に、来店日を取り違えないため。
    // 「本日19:00」のような相対の書き方は、日付の列を正とする
    var timeIsAbsolute = ABSOLUTE_DATE.test(nfkc(cell("time")));
    var startAt = (columns.datetime !== undefined && cell("datetime") ? parseDateTime(cell("datetime"), now) : null) ||
      (timeIsAbsolute ? parseDateTime(cell("time"), now) : null) ||
      parseDateTime(cell("date") + " " + cell("time"), now) ||
      (cell("time") ? parseDateTime(cell("time"), now) : null);
    if (!startAt) errors.push("来店日時を読み取れません");

    var counts = {};
    PEOPLE_FIELDS.forEach(function (field) { counts[field] = cell(field) ? parseCount(cell(field)) : null; });
    if (counts.adults == null && cell("pax")) {
      var people = parsePeople(cell("pax"));
      if (people) {
        // 合計人数の列しか無いときは、シニア・子供・幼児の列の分を引いて大人とする
        PEOPLE_FIELDS.forEach(function (field) { if (field !== "adults" && counts[field] == null) counts[field] = people[field]; });
        counts.adults = /大人/.test(cell("pax")) ? people.adults
          : Math.max(0, partySize.total(people) - counts.seniors - counts.children - counts.kids);
      }
    }
    var name = guestName(cell("name"));
    var draft = {
      rid: ridFrom(cell("rid")) || (startAt ? derivedRid("csv", startAt, name || "") : null),
      startAt: startAt,
      adults: counts.adults || 0,
      seniors: counts.seniors || 0,
      children: counts.children || 0,
      kids: counts.kids || 0,
      name: name,
      status: statusFrom(cell("status")),
      table: note(cell("table")),
      menu: parseMenuList(cell("menu")),
      // アレルギーの列・予約メモの質問の回答・苦手なものの列は、それぞれ別のことが書かれうるので全部つなぐ
      allergies: joinNotes([allergyNote(cell("allergies")), allergyFromAnswers(cell("memo")),
        allergyNote(cell("dislikes")) && "苦手: " + allergyNote(cell("dislikes"))]),
      request: note(cell("request")),
      memo: note(cell("memo")),
    };
    return { line: row.line, draft: draft, errors: errors };
  });
  return base;
}

module.exports = {
  parseCsv: parseCsv,
  parseXlsx: parseXlsx,
  parseSpreadsheet: parseSpreadsheet,
};
