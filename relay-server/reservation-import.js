/**
 * reservation-import.js — 予約の取込 (CSV・貼り付けテキスト・メール) の純粋ロジック
 *
 * TableCheck API 連携の中止 (2026-10-11) を受け、店員が TableCheck の管理画面や通知メールから
 * 予約を持ち込むための解析だけを持つ。保存はしない。どの入口も reservation-store.js の save() に
 * 渡せる下書き ({rid?,startAt,adults,seniors,children,kids,name,table,menu[],allergies,request,memo,status}) を返す。
 * 人数は 大人 (adults)・シニア (seniors)・子供 (children)・幼児 (kids、0〜2歳) を分けて持ち、まとめない。
 *
 * TableCheck の予約一覧は、2026-10-22 に店から受け取った .xlsx (1行目がタイトル「予約」、2行目が見出し) で
 * 列名を確かめた。予約詳細の書式・通知メールの文面は実物を確認できていない。
 * 列名やラベルは表記ゆれを広く受け、読み取れなかった項目は warnings で返す。
 * 取り込む前に必ず人が確認する前提で使う (自動では保存しない)。
 */
"use strict";

var crypto = require("node:crypto");
var xlsxReader = require("./xlsx-reader");
var partySize = require("./party-size");

var MAX_MENU_ITEMS = 50;
var MAX_CSV_ROWS = 500;
var MAX_MIME_DEPTH = 5;
var MAX_HEADER_SEARCH_ROWS = 5;   // 見出しの前にタイトル行などがあっても探す行数
var PEOPLE_FIELDS = partySize.KEYS;

/* ============================================================ 共通: 文字コード・日時・人数・メニュー */

/**
 * バイト列を文字列へ。charset 指定があればそれを使い、無ければ UTF-8 として読めるか試して
 * 読めなければ Shift_JIS とみなす (日本語の管理画面が出す CSV は Shift_JIS のことが多い)
 */
function decodeBytes(buf, charset) {
  if (charset) {
    try { return new TextDecoder(charset).decode(buf); }
    catch (err) { /* 未知の charset は下の自動判定へ */ }
  }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); }
  catch (err) {
    try { return new TextDecoder("shift_jis").decode(buf); }
    catch (err2) { return buf.toString("utf8"); }
  }
}

/** 全角英数・全角記号を半角へ寄せる。日時・人数・ラベルの照合前に通す */
function nfkc(value) {
  return String(value == null ? "" : value).normalize("NFKC");
}

/** 文字列から日付を拾う。年が無ければ now から推定する。拾えなければ null */
function parseDate(value, now) {
  var s = nfkc(value);
  var m = /(\d{4})\s*[\/\-.年]\s*(\d{1,2})\s*[\/\-.月]\s*(\d{1,2})/.exec(s);
  if (m) return realDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(s) || /(?:^|[^\d\/])(\d{1,2})\/(\d{1,2})(?![\d\/])/.exec(s);
  if (m) return realDate(inferYear(Number(m[1]), Number(m[2]), now), Number(m[1]), Number(m[2]));
  var today = new Date(now);
  if (/今日|本日/.test(s)) return { y: today.getFullYear(), m: today.getMonth() + 1, d: today.getDate() };
  if (/明日/.test(s)) {
    var t = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    return { y: t.getFullYear(), m: t.getMonth() + 1, d: t.getDate() };
  }
  return null;
}

function realDate(y, m, d) {
  var date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d ? { y: y, m: m, d: d } : null;
}

/** 年の無い日付は今年とみなす。半年以上前になるなら来年の予約と解釈する (12月に1月の予約を入れる場合) */
function inferYear(month, day, now) {
  var today = new Date(now);
  var year = today.getFullYear();
  var candidate = new Date(year, month - 1, day);
  return today.getTime() - candidate.getTime() > 180 * 86400000 ? year + 1 : year;
}

/** 文字列から時刻を拾う ("18:30" / "18時30分" / "18時半" / "18時")。拾えなければ null */
function parseTime(value) {
  var s = nfkc(value);
  var m = /(\d{1,2}):(\d{2})/.exec(s);
  var h, mi;
  if (m) { h = Number(m[1]); mi = Number(m[2]); }
  else {
    m = /(\d{1,2})\s*時\s*(?:(\d{1,2})\s*分|(半))?/.exec(s);
    if (!m) return null;
    h = Number(m[1]);
    mi = m[3] ? 30 : (m[2] ? Number(m[2]) : 0);
  }
  return h <= 23 && mi <= 59 ? { h: h, mi: mi } : null;
}

/**
 * 日付と時刻を含む文字列 → サーバーのローカル時刻の ISO8601 (オフセット付き)。
 * オフセット付きの ISO8601 ならそのまま返す。日付か時刻のどちらかが拾えなければ null
 */
function parseDateTime(value, now) {
  var s = nfkc(value).trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/.test(s) && !isNaN(Date.parse(s))) return s;
  var date = parseDate(s, now);
  // 日付の数字を時刻と取り違えないよう、日付らしい部分を除いてから時刻を探す
  var time = parseTime(s.replace(/\d{4}\s*[\/\-.年]\s*\d{1,2}\s*[\/\-.月]\s*\d{1,2}\s*日?/, " ")
    .replace(/\d{1,2}\s*月\s*\d{1,2}\s*日/, " "));
  if (!date || !time) return null;
  return toLocalIso(date.y, date.m, date.d, time.h, time.mi);
}

function toLocalIso(y, m, d, h, mi) {
  var date = new Date(y, m - 1, d, h, mi, 0, 0);
  var offset = -date.getTimezoneOffset();
  var sign = offset < 0 ? "-" : "+";
  var abs = Math.abs(offset);
  return date.getFullYear() + "-" + pad2(date.getMonth() + 1) + "-" + pad2(date.getDate()) +
    "T" + pad2(date.getHours()) + ":" + pad2(date.getMinutes()) + ":00" +
    sign + pad2(Math.floor(abs / 60)) + ":" + pad2(abs % 60);
}

var PEOPLE_PATTERNS = [
  ["adults", /大人\s*:?\s*(\d+)/],
  ["seniors", /シニア\s*:?\s*(\d+)/],
  ["children", /(?:子供|子ども|こども|お子様|お子さま|小人)\s*:?\s*(\d+)/],
  ["kids", /(?:乳幼児|幼児)\s*:?\s*(\d+)/],
];

/**
 * "大人2名 シニア1名 子供1名 幼児1名" / "3名" / "3" → {adults,seniors,children,kids}。拾えなければ null。
 * 合計だけのときは、書いてあるシニア・子供・幼児を引いた残りを大人とする
 */
function parsePeople(value) {
  var s = nfkc(value);
  var people = partySize.zero();
  var found = false;
  PEOPLE_PATTERNS.forEach(function (p) {
    var m = p[1].exec(s);
    if (m) { people[p[0]] = Number(m[1]); found = true; }
  });
  if (PEOPLE_PATTERNS[0][1].test(s)) return people;
  // 区分つきの「N名」を除いてから合計を探す (「お子様1名を含む4名」の1を合計と取り違えない)
  var rest = PEOPLE_PATTERNS.reduce(function (text, p) {
    return text.replace(new RegExp(p[1].source + "\\s*(?:名|人)?"), " ");
  }, s);
  var total = /(\d+)\s*(?:名|人)/.exec(rest) || /^\s*(\d+)\s*$/.exec(rest);
  if (total) {
    people.adults = Math.max(0, Number(total[1]) - people.seniors - people.children - people.kids);
    return people;
  }
  return found ? people : null;
}

function parseCount(value) {
  var m = /(\d+)/.exec(nfkc(value));
  return m ? Number(m[1]) : null;
}

/**
 * メニューの並びを品目へ分ける ("土鍋御膳 x2、うなぎ×1" など。区切りは改行・読点・カンマ・セミコロン)。
 * requireQty が真なら、数量の書いてある行だけを品目とみなす (本文全体から拾うときの誤検出よけ)
 */
function parseMenuList(value, options) {
  var requireQty = !!(options && options.requireQty);
  var out = [];
  nfkc(value).split(/\r?\n|、|,|;/).forEach(function (line) {
    line = line.replace(/^[\s・●○◆■▼*\-]+/, "").trim();
    if (!line || out.length >= MAX_MENU_ITEMS) return;
    // TableCheck は数量を先に書く ("1 × 鰻と和牛レアすき極上土鍋御膳")
    var lead = /^(\d+)\s*[x×✕*]\s*(.+)$/i.exec(line);
    if (lead && Number(lead[1]) >= 1) return out.push({ name: lead[2].trim(), qty: Number(lead[1]) });
    var m = /^(.+?)\s*[x×✕*]\s*(\d+)\s*(?:個|つ|名分|人前|膳|点)?$/i.exec(line) ||
      /^(.+?)\s+(\d+)\s*(?:個|つ|名分|人前|膳|点)?$/.exec(line) ||
      /^(.+?)(\d+)\s*(?:個|つ|名分|人前|膳|点)$/.exec(line);
    if (m && Number(m[2]) >= 1) return out.push({ name: m[1].trim(), qty: Number(m[2]) });
    if (!requireQty) out.push({ name: line, qty: 1 });
  });
  return out;
}

/**
 * 自由回答の「ありません」系。定型の「なし」より広く、文末の句読点や「です」も許す。
 * アレルギーありの回答 (「えびアレルギーがあります」) は「あり」で始まらないので当たらない
 */
var NEGATIVE_ANSWER = /^(?:特に)?(?:なし|無し|ない|無い|ありません|ございません|大丈夫|問題(?:ない|無い|ありません|ございません))(?:です)?(?:よ|ね)?[。.!！、\s]*$/;

/** 「なし」「特になし」などの否定の回答はアレルギーとして扱わない */
function allergyNote(value) {
  var s = String(value == null ? "" : value).trim();
  return !s || /^(?:なし|無し|無|ない|特になし|特に無し|なしです|no|none|n\/a|-|ー)$/i.test(s) || NEGATIVE_ANSWER.test(nfkc(s)) ? null : s;
}

/**
 * 予約フォームの質問と回答 ("質問1: アレルギーやお苦手な食材のあ… 回答1: なし") から、
 * アレルギー・苦手な食材を尋ねた質問の回答を拾う。質問文は途中で「…」と切れていることがある。
 * 回答は複数行にわたることがあるので、次の「質問N:」か「ラベル: 値」の行 (「ご利用回数: 初来店」など) までを読む
 */
function allergyFromAnswers(value) {
  var s = nfkc(value).replace(/\r\n?/g, "\n");
  var pattern = /質問\s*(\d+)\s*:\s*([\s\S]*?)\s*回答\s*\1\s*:\s*([\s\S]*?)\s*(?=質問\s*\d+\s*:|\n[^\n:]{1,15}:|$)/g;
  var answers = [], m;
  while ((m = pattern.exec(s))) {
    var text = m[3].split(/\n+/).map(function (line) { return line.trim(); }).filter(Boolean).join("、");
    var answer = /アレルギー|苦手|食事制限/.test(m[2]) ? allergyNote(text) : null;
    if (answer && answers.indexOf(answer) < 0) answers.push(answer);
  }
  return answers.length ? answers.join(" / ") : null;
}

/** 空と重複を除いて " / " でつなぐ。何も無ければ null */
function joinNotes(values) {
  var out = [];
  values.forEach(function (v) { if (v && out.indexOf(v) < 0) out.push(v); });
  return out.length ? out.join(" / ") : null;
}

function note(value) {
  var s = String(value == null ? "" : value).trim();
  return s || null;
}

function statusFrom(value) {
  var s = nfkc(value).toLowerCase();
  if (/キャンセル|取消|取り消|cancel|reject/.test(s)) return "canceled";
  if (/ノーショー|no[\s_-]?show|無断/.test(s)) return "no_show";
  if (/来店済|完了|done|finish/.test(s)) return "done";
  return "booked";
}

function guestName(value) {
  return String(value == null ? "" : value).trim().replace(/\s*(?:様|さま|さん)\s*$/, "").trim() || null;
}

/**
 * 予約番号の無い予約に、来店日時と名前から決まる rid を付ける。
 * 同じ CSV やメールを2回取り込んでも二重登録にならず、同じ予約の上書きになる
 */
function derivedRid(prefix, startAt, name) {
  var ms = Date.parse(startAt);
  var key = (isNaN(ms) ? String(startAt) : String(ms)) + "|" + nfkc(name).replace(/\s+/g, "");
  return prefix + "-" + crypto.createHash("sha256").update(key, "utf8").digest("hex").slice(0, 16);
}

function ridFrom(value) {
  var s = nfkc(value).trim().replace(/\s+/g, "");
  return s ? s.slice(0, 64) : null;
}

/* ============================================================ B. CSV */

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

/* ============================================================ C. 貼り付けテキスト */

// ラベル → 項目。長いラベルを先に照合する (「来店日時」を「来店日」より先に)
var TEXT_LABELS = {
  datetime: ["ご来店日時", "ご予約日時", "来店日時", "予約日時", "日時"],
  date: ["ご来店日", "来店日", "予約日", "日付", "日にち"],
  time: ["ご来店時間", "来店時間", "来店時刻", "予約時間", "時間", "時刻"],
  name: ["ご予約者名", "予約者名", "ご予約名", "予約者", "お名前", "名前", "氏名"],
  people: ["ご利用人数", "利用人数", "人数"],
  adults: ["大人"],
  seniors: ["シニア"],
  children: ["お子様", "子ども", "子供", "小人"],
  kids: ["乳幼児", "幼児"],
  menu: ["事前メニュー", "ご注文内容", "注文内容", "メニュー", "コース", "ご注文", "注文"],
  allergies: ["食物アレルギー", "アレルギー"],
  request: ["ご要望", "ご希望", "要望", "リクエスト"],
  memo: ["メモ", "備考"],
  table: ["卓番", "テーブル", "卓", "席"],
  rid: ["ご予約番号", "予約番号", "予約ID", "予約No"],
  status: ["ステータス", "状態"],
};
var MULTILINE_FIELDS = { menu: true, allergies: true, request: true, memo: true };

var LABEL_TO_FIELD = {};
var LABEL_PATTERN = (function () {
  var labels = [];
  Object.keys(TEXT_LABELS).forEach(function (field) {
    TEXT_LABELS[field].forEach(function (label) { LABEL_TO_FIELD[nfkc(label).toLowerCase()] = field; labels.push(nfkc(label)); });
  });
  labels.sort(function (a, b) { return b.length - a.length; });
  var alternatives = labels.map(function (l) { return l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }).join("|");
  // 「ラベル: 値」「【ラベル】値」「■ラベル」の形だけをラベルとみなす。本文中にたまたま出てきた語は拾わない
  return new RegExp("^[\\s■●◆▼・*\\-]*[\\[【<]?(" + alternatives + ")[\\]】>]?\\s*(?::|=|\\t|\\s{2,}|$)\\s*(.*)$", "i");
})();

// 「何か: 値」の形をした行。数字だけの左辺 (「18:30 到着」の 18) はラベルとみなさない
var OTHER_LABEL_PATTERN = /^[\s■●◆▼・*\-]*[\[【<]?(?=[^\s:=]*[^\d\s:=])[^\s:=]{1,15}[\]】>]?\s*[:=]/;

/**
 * 貼り付けた予約詳細のテキスト → 予約の下書き1件。
 * 「ラベル: 値」の行を読む。ラベルの無い日時・名前・人数は本文全体から拾う。
 * @returns {{draft: Object, warnings: string[]}} 読み取れなかった項目は warnings に入る
 */
function parseText(text, options) {
  var now = options && options.now || new Date();
  var prefix = options && options.ridPrefix || "txt";
  var source = nfkc(text).replace(/\r\n?/g, "\n");
  var fields = {};
  var current = null;
  var loose = [];

  source.split("\n").forEach(function (line) {
    var m = LABEL_PATTERN.exec(line);
    if (m) {
      current = LABEL_TO_FIELD[m[1].toLowerCase()];
      // 同じラベルが2回出たら最初の値を残す (署名や注意書きの再掲を拾わない)
      if (fields[current] !== undefined) { current = null; return; }
      fields[current] = m[2].trim();
      return;
    }
    if (!line.trim()) { current = null; return; }
    // 知らないラベルの行 (「電話番号: …」など) は前の項目の続きにしない。要望やメモへ連絡先が紛れ込むのを防ぐ
    if (OTHER_LABEL_PATTERN.test(line)) current = null;
    if (current && MULTILINE_FIELDS[current]) fields[current] += (fields[current] ? "\n" : "") + line.trim();
    else { current = null; loose.push(line); }
  });

  var looseText = loose.join("\n");
  var startAt = fields.datetime ? parseDateTime(fields.datetime, now) : null;
  if (!startAt && (fields.date || fields.time)) startAt = parseDateTime((fields.date || "") + " " + (fields.time || ""), now);
  if (!startAt) startAt = parseDateTime([fields.datetime, fields.date, fields.time, looseText].filter(Boolean).join("\n"), now);

  var name = guestName(fields.name);
  if (!name) {
    var nameMatch = /^[\s■●◆▼・*\-]*(.{1,40}?)\s*(?:様|さま)\s*$/m.exec(looseText);
    name = nameMatch ? guestName(nameMatch[1]) : null;
  }

  var people = fields.people ? parsePeople(fields.people) : null;
  var labeled = {};
  PEOPLE_FIELDS.forEach(function (field) {
    if (fields[field] && parseCount(fields[field]) != null) labeled[field] = parseCount(fields[field]);
  });
  if (Object.keys(labeled).length) {
    // 合計人数だけが分かっているときは、シニア・子供・幼児の人数を引いて大人とする
    var total = people ? partySize.total(people) : 0;
    var explicitAdults = labeled.adults != null || /大人/.test(fields.people || "");
    people = people || partySize.zero();
    Object.keys(labeled).forEach(function (field) { people[field] = labeled[field]; });
    if (!explicitAdults) people.adults = Math.max(0, total - people.seniors - people.children - people.kids);
  }
  if (!people) people = parsePeople(looseText);

  var menu = fields.menu ? parseMenuList(fields.menu) : parseMenuList(looseText, { requireQty: true });

  var warnings = [];
  if (!startAt) warnings.push("来店日時を読み取れませんでした");
  if (!name) warnings.push("予約者名を読み取れませんでした");
  if (!people) warnings.push("人数を読み取れませんでした");
  if (!menu.length) warnings.push("メニューを読み取れませんでした (メニューの無い予約は厨房画面に出ません)");

  return {
    draft: {
      rid: ridFrom(fields.rid) || (startAt && name ? derivedRid(prefix, startAt, name) : null),
      startAt: startAt,
      adults: people ? people.adults : 0,
      seniors: people ? people.seniors : 0,
      children: people ? people.children : 0,
      kids: people ? people.kids : 0,
      name: name,
      status: fields.status ? statusFrom(fields.status) : "booked",
      table: note(fields.table),
      menu: menu,
      allergies: allergyNote(fields.allergies),
      request: note(fields.request),
      memo: note(fields.memo),
    },
    warnings: warnings,
  };
}

/* ============================================================ D. メール */

/**
 * メール1通 (RFC 822 の生データ、または本文だけのテキスト) → 予約の下書き。
 * 件名に「キャンセル」とあれば取消として扱う。
 * @param {Buffer|string} input - .eml のバイト列。文字列で渡した場合は UTF-8 のテキストとして扱う
 * @returns {{draft: Object, warnings: string[], subject: (string|null), from: (string|null), body: string}}
 */
function parseMail(input, options) {
  var isText = typeof input === "string";
  var raw = (isText ? Buffer.from(input, "utf8") : input).toString("latin1");
  var message = splitMessage(raw);
  var subject = null, from = null, body;

  if (message) {
    subject = decodeHeader(message.headers.subject, isText);
    from = decodeHeader(message.headers.from, isText);
    body = extractText(message, isText, 0);
  } else {
    // ヘッダーの無い入力は、メール本文をそのまま貼り付けたものとして読む
    body = isText ? input : decodeBytes(input);
  }

  var parsed = parseText(body || "", { now: options && options.now, ridPrefix: "mail" });
  if (subject && statusFrom(subject) === "canceled" && !/キャンセル待ち/.test(subject)) parsed.draft.status = "canceled";
  return { draft: parsed.draft, warnings: parsed.warnings, subject: subject, from: from, body: body || "" };
}

/** latin1 で読んだメッセージをヘッダーと本文に分ける。先頭がヘッダーの形でなければ null */
function splitMessage(raw) {
  if (!/^[A-Za-z][A-Za-z0-9-]*:/.test(raw)) return null;
  var m = /\r?\n\r?\n/.exec(raw);
  var head = m ? raw.slice(0, m.index) : raw;
  var body = m ? raw.slice(m.index + m[0].length) : "";
  var headers = {};
  head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/).forEach(function (line) {
    var colon = line.indexOf(":");
    if (colon <= 0) return;
    var name = line.slice(0, colon).trim().toLowerCase();
    if (headers[name] === undefined) headers[name] = line.slice(colon + 1).trim();
  });
  return { headers: headers, body: body };
}

/** RFC 2047 の encoded-word (=?charset?B?...?= / =?charset?Q?...?=) を戻す */
function decodeHeader(value, isText) {
  if (value == null) return null;
  var decoded = String(value).replace(/(\?=)\s+(=\?)/g, "$1$2")
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, function (all, charset, encoding, data) {
      var bytes = encoding.toLowerCase() === "b" ? Buffer.from(data, "base64")
        : decodeQuotedPrintable(data.replace(/_/g, " "));
      return decodeBytes(bytes, charset);
    });
  // encoded-word でない8bitのヘッダーは、貼り付けテキストなら UTF-8 として戻す
  if (decoded === value && /[\x80-\xff]/.test(decoded)) decoded = decodeBytes(Buffer.from(decoded, "latin1"), isText ? "utf-8" : null);
  return decoded.trim() || null;
}

function decodeQuotedPrintable(value) {
  var s = String(value).replace(/=\r?\n/g, "");
  var bytes = [];
  for (var i = 0; i < s.length; i++) {
    if (s[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(s.substr(i + 1, 2))) { bytes.push(parseInt(s.substr(i + 1, 2), 16)); i += 2; }
    else bytes.push(s.charCodeAt(i) & 0xff);
  }
  return Buffer.from(bytes);
}

function parseContentType(value) {
  var parts = String(value || "text/plain").split(";");
  var params = {};
  parts.slice(1).forEach(function (part) {
    var eq = part.indexOf("=");
    if (eq > 0) params[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim().replace(/^"|"$/g, "");
  });
  return { type: parts[0].trim().toLowerCase() || "text/plain", params: params };
}

/** メッセージ (またはその一部) から読める本文を取り出す。text/plain を優先し、無ければ text/html のタグを外す */
function extractText(part, isText, depth) {
  var contentType = parseContentType(part.headers["content-type"]);
  if (contentType.type.indexOf("multipart/") === 0) {
    var boundary = contentType.params.boundary;
    if (!boundary || depth >= MAX_MIME_DEPTH) return "";
    var plain = null, html = null;
    part.body.split("--" + boundary).slice(1).forEach(function (chunk) {
      if (chunk.indexOf("--") === 0) return;   // 終端の "--boundary--"
      var child = splitMessage(chunk.replace(/^\r?\n/, ""));
      if (!child) return;
      var childType = parseContentType(child.headers["content-type"]).type;
      var childText = extractText(child, isText, depth + 1);
      if (!childText) return;
      if (childType === "text/html") { if (html === null) html = childText; }
      else if (plain === null) plain = childText;
    });
    return plain !== null ? plain : (html || "");
  }
  if (contentType.type !== "text/plain" && contentType.type !== "text/html") return "";

  var encoding = String(part.headers["content-transfer-encoding"] || "").trim().toLowerCase();
  var bytes, charset = contentType.params.charset;
  if (encoding === "base64") bytes = Buffer.from(part.body.replace(/\s+/g, ""), "base64");
  else if (encoding === "quoted-printable") bytes = decodeQuotedPrintable(part.body);
  else {
    bytes = Buffer.from(part.body, "latin1");
    // 貼り付けたテキストは既に UTF-8 へ変換済みなので、ヘッダーの charset 宣言を信用しない
    if (isText) charset = "utf-8";
  }
  var text = decodeBytes(bytes, charset);
  return contentType.type === "text/html" ? htmlToText(text) : text;
}

function htmlToText(html) {
  return String(html)
    .replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(?:p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function pad2(n) { return (n < 10 ? "0" : "") + n; }

module.exports = {
  decodeBytes: decodeBytes,
  parseDateTime: parseDateTime,
  parsePeople: parsePeople,
  parseMenuList: parseMenuList,
  parseCsv: parseCsv,
  parseXlsx: parseXlsx,
  parseSpreadsheet: parseSpreadsheet,
  parseText: parseText,
  parseMail: parseMail,
};
