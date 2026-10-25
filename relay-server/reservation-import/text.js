/** 貼り付け本文のラベル・複数行・不足項目の警告を扱う。メールの本文解析からも利用する。 */
"use strict";

var {
  partySize, nfkc, parseDateTime, parsePeople, parseCount, parseMenuList,
  allergyNote, note, statusFrom, guestName, derivedRid, ridFrom,
} = require("./common");

var PEOPLE_FIELDS = partySize.KEYS;

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

module.exports = { parseText: parseText };
