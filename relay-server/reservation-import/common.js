/** 取込入口に依存しない文字コード・日時・人数・メニュー・備考・IDの解析。保存やI/Oは行わない。 */
"use strict";

var crypto = require("node:crypto");
var partySize = require("../party-size");

var MAX_MENU_ITEMS = 50;

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

function pad2(n) { return (n < 10 ? "0" : "") + n; }

module.exports = {
  partySize: partySize,
  decodeBytes: decodeBytes,
  nfkc: nfkc,
  parseDateTime: parseDateTime,
  parsePeople: parsePeople,
  parseCount: parseCount,
  parseMenuList: parseMenuList,
  allergyNote: allergyNote,
  allergyFromAnswers: allergyFromAnswers,
  joinNotes: joinNotes,
  note: note,
  statusFrom: statusFrom,
  guestName: guestName,
  derivedRid: derivedRid,
  ridFrom: ridFrom,
};
