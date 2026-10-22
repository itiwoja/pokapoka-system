"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var imp = require("../reservation-import");
var fixture = require("./xlsx-fixture");

// 2026-10-13 12:00 (サーバーのローカル時刻) を「今」とする
var NOW = new Date(2026, 9, 13, 12, 0, 0);
var OPTS = { now: NOW };

function local(y, m, d, h, mi) { return new Date(y, m - 1, d, h, mi).getTime(); }

test("日時: 表記ゆれを受け、年が無ければ今年、半年以上前なら来年とみなす", function () {
  assert.equal(Date.parse(imp.parseDateTime("2026/10/14 18:30", NOW)), local(2026, 10, 14, 18, 30));
  assert.equal(Date.parse(imp.parseDateTime("2026年10月14日(水) 18時30分", NOW)), local(2026, 10, 14, 18, 30));
  assert.equal(Date.parse(imp.parseDateTime("１０月１４日　１８時半", NOW)), local(2026, 10, 14, 18, 30));
  assert.equal(Date.parse(imp.parseDateTime("10/14 18時", NOW)), local(2026, 10, 14, 18, 0));
  assert.equal(Date.parse(imp.parseDateTime("1/5 12:00", NOW)), local(2027, 1, 5, 12, 0), "年明けの予約は来年");
  assert.equal(imp.parseDateTime("2026-10-14T18:30:00+09:00", NOW), "2026-10-14T18:30:00+09:00");
  assert.equal(imp.parseDateTime("2026/02/30 18:30", NOW), null, "実在しない日付");
  assert.equal(imp.parseDateTime("2026/10/14", NOW), null, "時刻が無い");
  assert.equal(imp.parseDateTime("18:30", NOW), null, "日付が無い");
});

test("人数: 内訳があれば内訳、合計だけなら大人に寄せる", function () {
  assert.deepEqual(imp.parsePeople("大人2名 子供1名"), { adults: 2, kids: 1 });
  assert.deepEqual(imp.parsePeople("3名"), { adults: 3, kids: 0 });
  assert.deepEqual(imp.parsePeople("3名(子供1名)"), { adults: 2, kids: 1 });
  assert.deepEqual(imp.parsePeople("４"), { adults: 4, kids: 0 });
  assert.equal(imp.parsePeople("未定"), null);
});

test("メニュー: 数量の書き方の違いを受け、requireQty では数量のある行だけ拾う", function () {
  assert.deepEqual(imp.parseMenuList("土鍋御膳 x2、うなぎ×1\n・茶 3個\nプリン"), [
    { name: "土鍋御膳", qty: 2 }, { name: "うなぎ", qty: 1 }, { name: "茶", qty: 3 }, { name: "プリン", qty: 1 },
  ]);
  assert.deepEqual(imp.parseMenuList("よろしくお願いします\n土鍋御膳 x2", { requireQty: true }), [{ name: "土鍋御膳", qty: 2 }]);
});

test("CSV: 列名から項目を判別し、引用符内の改行とカンマを保つ", function () {
  var csv = "﻿予約番号,来店日,来店時間,予約者名,大人,子供,コース,アレルギー,ご要望,ステータス,電話番号\r\n" +
    "R-1,2026/10/14,18:30,山田 太郎 様,2,1,\"土鍋御膳 x2\nうなぎ x1\",えび,\"窓側, 静かな席\",確定,090-0000-0000\r\n" +
    "R-2,2026/10/14,19:00,佐藤,3,,,なし,,キャンセル,\r\n" +
    ",,,,,,,,,,\r\n" +
    "R-3,日付なし,19:00,鈴木,2,,茶,,,,\r\n";
  var out = imp.parseCsv(csv, OPTS);
  assert.equal(out.error, undefined);
  assert.equal(out.columns.rid, "予約番号");
  assert.equal(out.columns.menu, "コース");
  assert.deepEqual(out.unmapped, ["電話番号"], "連絡先は取り込まない");
  assert.equal(out.rows.length, 3, "空行は数えない");

  var first = out.rows[0];
  assert.equal(first.line, 2);
  assert.deepEqual(first.errors, []);
  assert.equal(first.draft.rid, "R-1");
  assert.equal(Date.parse(first.draft.startAt), local(2026, 10, 14, 18, 30));
  assert.equal(first.draft.name, "山田 太郎", "敬称は外す");
  assert.equal(first.draft.adults, 2);
  assert.equal(first.draft.kids, 1);
  assert.deepEqual(first.draft.menu, [{ name: "土鍋御膳", qty: 2 }, { name: "うなぎ", qty: 1 }]);
  assert.equal(first.draft.allergies, "えび");
  assert.equal(first.draft.request, "窓側, 静かな席");
  assert.equal(first.draft.status, "booked");

  assert.equal(out.rows[1].draft.status, "canceled");
  assert.equal(out.rows[1].draft.allergies, null, "「なし」はアレルギーにしない");
  assert.deepEqual(out.rows[1].draft.menu, []);
  assert.equal(out.rows[2].line, 6, "引用符内の改行と空行を数えた行番号");
  assert.deepEqual(out.rows[2].errors, ["来店日時を読み取れません"]);
});

test("CSV: 来店日時の1列・合計人数・タブ区切りを受け、予約番号が無ければ同じ内容から同じridを作る", function () {
  var tsv = "来店日時\t名前\t人数\t子供人数\tメニュー\n2026-10-14 18:30\t山田\t3名\t1\t土鍋御膳×2\n";
  var a = imp.parseCsv(tsv, OPTS).rows[0].draft;
  var b = imp.parseCsv(tsv, OPTS).rows[0].draft;
  assert.equal(a.adults, 2, "合計3名から子供1名を引く");
  assert.equal(a.kids, 1);
  assert.match(a.rid, /^csv-[0-9a-f]{16}$/);
  assert.equal(a.rid, b.rid, "再取込で二重登録にならない");
});

test("CSV: 来店日時の列が無ければファイル全体を断る", function () {
  var out = imp.parseCsv("名前,人数\n山田,2\n", OPTS);
  assert.match(out.error, /来店日時の列/);
  assert.deepEqual(out.rows, []);
  assert.match(imp.parseCsv("", OPTS).error, /行がありません/);
});

test("CSV: 作成日時・更新日時などの列を来店日時と取り違えない", function () {
  // 来店日と時刻が別の列で、ほかに作成日時・更新日時がある (予約サイトの書き出しによくある形)
  var csv = "予約番号,作成日時,来店日,時刻,お名前,人数,更新日時,キャンセル日時\n" +
    "R-1,2026/10/01 09:00,2026/10/14,18:30,山田,2,2026/10/02 10:15,\n";
  var out = imp.parseCsv(csv, OPTS);
  assert.equal(out.error, undefined);
  assert.equal(out.columns.datetime, undefined);
  assert.equal(out.columns.date, "来店日");
  assert.equal(out.columns.time, "時刻");
  assert.deepEqual(out.unmapped, ["作成日時", "更新日時", "キャンセル日時"]);
  assert.equal(Date.parse(out.rows[0].draft.startAt), local(2026, 10, 14, 18, 30));

  // 来店日時の列が作成日時しか無いなら、作成日時で取り込まずに断る
  assert.match(imp.parseCsv("お名前,人数,登録日時\n山田,2,2026/10/01 09:00\n", OPTS).error, /来店日時の列/);

  // 「来店」を含む列は、変更などの語があっても来店日時として読む
  var changed = imp.parseCsv("来店日時(変更後),お名前,変更日時\n2026/10/15 19:00,佐藤,2026/10/03 08:00\n", OPTS);
  assert.equal(changed.columns.datetime, "来店日時(変更後)");
  assert.equal(Date.parse(changed.rows[0].draft.startAt), local(2026, 10, 15, 19, 0));
});

/* ---- TableCheck の予約の書き出し (2026-10-21 に受け取った実物と同じ列の並び。値はすべて作り物) ---- */

var TC_HEADER = ("店舗,予約ID,予約時間,滞在時間,人数:大人,人数:シニア,人数:子供,人数:幼児,禁煙・喫煙の希望,席タイプの希望," +
  "テーブル,顧客ID,名前,性別,会社名,肩書,電話,Eメール,注文,予約メモ,ポイント,用途,来店経路,きっかけ,ステータス," +
  "作成者,作成日,更新者,更新日,タグ,食事制限・アレルギー,お好み,苦手なもの,氏 (あ·ア·A),名 (あ·ア·A),氏 (漢字),名 (漢字)," +
  "開始日,開始時刻,フラグ,終了時間,終了日,終了時刻,注文合計金額,席のカテゴリ,フロアレイアウト,セクション,テーブルの席のカテゴリ," +
  "予約メモ 2,グループ名,顧客 2: 名前,顧客 3: 名前,顧客 4: 名前,店舗 ID,店舗 Web ID,POS 伝票番号,POS 合計,部屋番号," +
  "キャンセル理由タイプ,キャンセル理由,営業担当,顧客メモ,店舗メモ,プロモーションコード,支払ステータス,TableCheck Pay必要," +
  "会員プログラム,会員ステージ,会員ID,UTM Source（きっかけ）,UTM Campaign（配信）,UTM Medium（媒体）").split(",");

var TC_ROWS = [
  {
    "店舗": "テスト店", "予約ID": "TST001", "予約時間": "2026-10-14 11:00", "滞在時間": "1時間 30分",
    "人数:大人": 2, "人数:シニア": 1, "人数:子供": 1, "人数:幼児": 1, "テーブル": "A1/2", "顧客ID": "cust-test-1",
    "名前": "テスト 太郎", "性別": "不明", "電話": "000-0000-0001", "Eメール": "taro@example.com",
    "注文": "1 × 鮭といくらの土鍋御膳, 2 × 鶏ときのこ、季節の土鍋御膳",
    "予約メモ": "質問1: アレルギーや苦手な食材はありますか 回答1: えび\nご利用回数: 初来店",
    "用途": "家族との食事", "来店経路": "電話予約", "ステータス": "確認", "作成者": "スタッフ", "作成日": "2026-10-01 09:00",
    "更新日": "2026-10-02 10:00", "食事制限・アレルギー": "そば", "お好み": "窓側", "苦手なもの": "しいたけ",
    "氏 (あ·ア·A)": "てすと", "名 (あ·ア·A)": "たろう", "開始日": "2026-10-14", "開始時刻": "11:00",
    "終了時間": "2026-10-14 12:30", "終了日": "2026-10-14", "終了時刻": "12:30", "注文合計金額": "9000",
    "予約メモ 2": "メモ二", "顧客 2: 名前": "同席 花子", "顧客メモ": "顧客のメモ", "店舗メモ": "店舗のメモ", "会員ID": "member-1",
  },
  {
    "予約ID": "TST002", "予約時間": "2026-10-14 13:30", "人数:大人": 3, "人数:シニア": 0, "人数:子供": 0, "人数:幼児": 0,
    "テーブル": "B5", "名前": "テスト 花子", "ステータス": "確認",
    "予約メモ": "質問1: アレルギーや苦手な食材はありますか 回答1: なし\n質問2: ご来店のきっかけ 回答2: 紹介",
    "開始日": "2026-10-14", "開始時刻": "13:30", "終了時間": "2026-10-14 15:00",
  },
  {
    "予約ID": "TST003", "予約時間": "2026-10-15 18:00", "人数:大人": 2, "人数:シニア": 0, "人数:子供": 0, "人数:幼児": 0,
    "名前": "テスト 次郎", "注文": "2 × 土鍋御膳", "ステータス": "キャンセル", "開始日": "2026-10-15", "開始時刻": "18:00",
  },
];

function tcCells(row) {
  return TC_HEADER.map(function (h) { return row[h] == null ? "" : String(row[h]); });
}

function csvLine(cells) {
  return cells.map(function (c) { return /[",\n]/.test(c) ? "\"" + c.replace(/"/g, "\"\"") + "\"" : c; }).join(",");
}

var TC_CSV = "予約\r\n" + [TC_HEADER].concat(TC_ROWS.map(tcCells)).map(csvLine).join("\r\n") + "\r\n";

// 取り込まない列 (連絡先・顧客2〜4・苦手なもの・お好み・用途・店舗メモなど) に入れた値
var TC_NOT_IMPORTED = ["テスト店", "1時間", "cust-test", "000-0000", "example.com", "家族との食事", "電話予約", "スタッフ",
  "窓側", "しいたけ", "てすと", "たろう", "9000", "メモ二", "同席", "顧客のメモ", "店舗のメモ", "member-1"];

/** lines は各予約の開始行。CSV は引用符の中の改行も数えた行、Excel はシートの行番号 */
function assertTableCheckRows(out, lines) {
  assert.equal(out.error, undefined);
  assert.deepEqual(out.columns, {
    rid: "予約ID", datetime: "予約時間", date: "開始日", time: "開始時刻", name: "名前", menu: "注文", table: "テーブル",
    status: "ステータス", adults: "人数:大人", kids: "人数:子供", seniors: "人数:シニア", infants: "人数:幼児",
    allergies: "食事制限・アレルギー", memo: "予約メモ",
  }, "「人数:シニア」を合計人数に当てず、「顧客 2: 名前」を名前に当てない");
  assert.equal(out.unmapped.length, TC_HEADER.length - 14);
  ["電話", "Eメール", "顧客ID", "顧客 2: 名前", "終了時間", "終了日", "終了時刻", "滞在時間", "用途", "苦手なもの", "お好み",
    "予約メモ 2", "店舗メモ", "顧客メモ", "作成日", "更新日"].forEach(function (h) {
    assert.ok(out.unmapped.indexOf(h) >= 0, h + " は使わない列");
  });
  assert.deepEqual(out.rows.map(function (r) { return r.line; }), lines, "1行目のタイトルと2行目の見出しを飛ばす");
  out.rows.forEach(function (r) { assert.deepEqual(r.errors, []); });

  var a = out.rows[0].draft;
  assert.equal(a.rid, "TST001");
  assert.equal(Date.parse(a.startAt), local(2026, 10, 14, 11, 0));
  assert.equal(a.adults, 3, "大人2 + シニア1");
  assert.equal(a.kids, 2, "子供1 + 幼児1");
  assert.equal(a.name, "テスト 太郎");
  assert.equal(a.table, "A1/2");
  assert.equal(a.status, "booked", "「確認」は予約として扱う");
  assert.deepEqual(a.menu, [{ name: "鮭といくらの土鍋御膳", qty: 1 }, { name: "鶏ときのこ、季節の土鍋御膳", qty: 2 }]);
  assert.equal(a.allergies, "そば、えび", "食事制限・アレルギーの列と、予約メモのアレルギーの答え");
  assert.equal(a.memo, "ご利用回数: 初来店", "アレルギーの質問と答えはメモから外す");

  var b = out.rows[1].draft;
  assert.equal(Date.parse(b.startAt), local(2026, 10, 14, 13, 30));
  assert.equal(b.adults, 3);
  assert.equal(b.kids, 0);
  assert.equal(b.allergies, null, "答えが「なし」ならアレルギーにしない");
  assert.equal(b.memo, "質問2: ご来店のきっかけ 回答2: 紹介", "答えが「なし」でもアレルギーの問答は外し、ほかの問答は残す");
  assert.deepEqual(b.menu, []);

  assert.equal(out.rows[2].draft.status, "canceled");
  assert.deepEqual(out.rows[2].draft.menu, [{ name: "土鍋御膳", qty: 2 }]);

  var json = JSON.stringify(out.rows);
  TC_NOT_IMPORTED.forEach(function (value) { assert.equal(json.indexOf(value), -1, value + " は取り込まない"); });
}

test("CSV: TableCheck の書き出し (1行目タイトル・72列) を読み、要る列だけを取り込む", function () {
  assert.equal(TC_HEADER.length, 72);
  // 1件目・2件目の予約メモは2行にわたるので、CSV の行は 3・5・7 行目から始まる
  assertTableCheckRows(imp.parseCsv(TC_CSV, OPTS), [3, 5, 7]);
  // 1行目のタイトルが無くても同じに読む
  var noTitle = imp.parseCsv(TC_CSV.replace(/^予約\r\n/, ""), OPTS);
  assert.deepEqual(noTitle.rows.map(function (r) { return r.line; }), [2, 4, 6]);
  assert.deepEqual(noTitle.rows.map(function (r) { return r.draft; }), imp.parseCsv(TC_CSV, OPTS).rows.map(function (r) { return r.draft; }));
});

test("CSV: 見出しは分かる列が3つ以上ある最初の行。予約時間が時刻だけなら今までどおり時刻として読む", function () {
  var titled = imp.parseCsv("予約一覧\n出力日 2026/10/13,,\n予約日,予約時間,名前,人数\n2026/10/14,18:30,山田,2\n", OPTS);
  assert.equal(titled.error, undefined);
  assert.equal(titled.columns.datetime, undefined);
  assert.equal(titled.columns.date, "予約日");
  assert.equal(titled.columns.time, "予約時間");
  assert.equal(titled.rows.length, 1);
  assert.equal(titled.rows[0].line, 4);
  assert.equal(Date.parse(titled.rows[0].draft.startAt), local(2026, 10, 14, 18, 30));

  // 予約時間に日付が入っていれば来店日時の列として読み、日付の列が無くても取り込める
  var dated = imp.parseCsv("予約ID,予約時間,名前\nR-1,2026-10-14 18:30,山田\n", OPTS);
  assert.equal(dated.columns.datetime, "予約時間");
  assert.equal(Date.parse(dated.rows[0].draft.startAt), local(2026, 10, 14, 18, 30));

  // 予約者のほかの同席者の名前は、予約者名に当てない
  var guests = imp.parseCsv("来店日時,顧客 2: 名前,人数,メニュー\n2026-10-14 18:30,同席,2,茶\n", OPTS);
  assert.equal(guests.columns.name, undefined);
  assert.equal(guests.rows[0].draft.name, null);
});

test("CSV: 終了時間・終了日・終了時刻・滞在時間を来店日時に当てない", function () {
  var out = imp.parseCsv("名前,人数,終了時間,滞在時間,開始日,開始時刻\n山田,2,2026-10-14 20:00,1時間 30分,2026-10-14,18:30\n", OPTS);
  assert.equal(out.columns.datetime, undefined);
  assert.equal(out.columns.date, "開始日");
  assert.equal(out.columns.time, "開始時刻");
  assert.equal(Date.parse(out.rows[0].draft.startAt), local(2026, 10, 14, 18, 30));
  assert.match(imp.parseCsv("名前,人数,終了日時\n山田,2,2026-10-14 20:00\n", OPTS).error, /来店日時の列/);
  assert.match(imp.parseCsv("名前,人数,終了日,終了時刻,滞在時間\n山田,2,2026-10-14,20:00,2時間\n", OPTS).error, /来店日時の列/);
});

test("メニュー: 数が先の形 (1 × 品名, 2 × 品名) を読み、品名の中の読点・カンマで割らない", function () {
  assert.deepEqual(imp.parseMenuList("1 × 鮭といくらの特製土鍋御膳, 2 × 鶏ときのこ、季節の土鍋御膳, 1 × 茶,ほうじ茶"), [
    { name: "鮭といくらの特製土鍋御膳", qty: 1 }, { name: "鶏ときのこ、季節の土鍋御膳", qty: 2 }, { name: "茶,ほうじ茶", qty: 1 },
  ]);
  assert.deepEqual(imp.parseMenuList("2×土鍋御膳\n・1 x うなぎ"), [{ name: "土鍋御膳", qty: 2 }, { name: "うなぎ", qty: 1 }]);
  assert.deepEqual(imp.parseMenuList("よろしくお願いします\n2 × 土鍋御膳", { requireQty: true }), [{ name: "土鍋御膳", qty: 2 }]);
  // 今までの「品名 × 数」の形も読める
  assert.deepEqual(imp.parseMenuList("土鍋御膳 x2, うなぎ×1"), [{ name: "土鍋御膳", qty: 2 }, { name: "うなぎ", qty: 1 }]);
});

test("CSV: 予約メモのアレルギーの質問の答えをアレルギーへ移し、質問と答えはメモから外す", function () {
  function memoOf(memo, allergies) {
    var csv = "来店日時,名前,予約メモ,食事制限・アレルギー\n" + csvLine(["2026-10-14 18:30", "山田", memo, allergies || ""]) + "\n";
    return imp.parseCsv(csv, OPTS).rows[0].draft;
  }
  var nextLine = memoOf("質問1: 食物アレルギーはありますか\n回答1: 卵\nご利用回数: 2回目");
  assert.equal(nextLine.allergies, "卵", "答えが次の行にあっても読む");
  assert.equal(nextLine.memo, "ご利用回数: 2回目");

  var oneLine = memoOf("質問1: ご来店のきっかけ 回答1: 紹介 質問2: アレルギーの有無 回答2: 小麦\n誕生日です");
  assert.equal(oneLine.allergies, "小麦");
  assert.equal(oneLine.memo, "質問1: ご来店のきっかけ 回答1: 紹介\n誕生日です");

  var midLine = memoOf("窓側希望 質問1: アレルギー 回答1: なし\n誕生日です");
  assert.equal(midLine.allergies, null);
  assert.equal(midLine.memo, "窓側希望\n誕生日です", "前の文と次の行をつなげない");

  var same = memoOf("質問1: アレルギー 回答1: えび", "えび");
  assert.equal(same.allergies, "えび", "同じ記載を重ねない");
  assert.equal(same.memo, null, "問答しか無いメモは空にする");
});

test("Excel: TableCheck の書き出しと同じ形の .xlsx を CSV と同じに読む", function () {
  var rows = [fixture.inlineRow(1, ["予約"]), fixture.inlineRow(2, TC_HEADER)].concat(TC_ROWS.map(function (row, i) {
    return fixture.inlineRow(i + 3, tcCells(row));
  }));
  var book = fixture.xlsx({ sheet: fixture.worksheet(rows) });
  var out = imp.parseImportFile(book, OPTS);
  assertTableCheckRows(out, [3, 4, 5]);
  var csv = imp.parseCsv(TC_CSV, OPTS);
  assert.deepEqual(out.columns, csv.columns);
  assert.deepEqual(out.unmapped, csv.unmapped);
  assert.deepEqual(out.rows.map(function (r) { return r.draft; }), csv.rows.map(function (r) { return r.draft; }), "同じ中身の CSV と同じ下書き");
});

test("Excel: 共有文字列・ふりがな・書式付きの文字・日付の数値を読み、最初のシートを r:id でたどる", function () {
  var strings = [
    "<si><t>予約ID</t></si>", "<si><t>予約時間</t></si>", "<si><t>人数:大人</t></si>", "<si><t>名前</t></si>", "<si><t>注文</t></si>",
    "<si><t>テスト 太郎</t><rPh sb=\"0\" eb=\"3\"><t>テスト タロウ</t></rPh><phoneticPr fontId=\"1\"/></si>",
    "<si><r><t xml:space=\"preserve\">1 × うなぎ</t></r><r><rPr><b/></rPr><t>&amp;たまご</t></r></si>",
    "<si><t>人数:幼児</t></si>", "<si/>", "<si><t>ステータス</t></si>",
  ];
  var sst = "<sst xmlns=\"" + fixture.NS + "\" count=\"10\" uniqueCount=\"10\">" + strings.join("") + "</sst>";
  var styles = "<styleSheet xmlns=\"" + fixture.NS + "\"><numFmts count=\"1\"><numFmt numFmtId=\"101\" formatCode=\"yyyy/mm/dd hh:mm:ss\"/></numFmts>" +
    "<cellXfs count=\"3\"><xf numFmtId=\"0\"/><xf numFmtId=\"101\" applyNumberFormat=\"1\"/><xf numFmtId=\"14\"/></cellXfs></styleSheet>";
  var serial = (Date.UTC(2026, 9, 14) - Date.UTC(1899, 11, 30)) / 86400000 + 11 / 24;
  function s(ref, index) { return "<c r=\"" + ref + "\" t=\"s\"><v>" + index + "</v></c>"; }
  var sheet = fixture.worksheet([
    "<row r=\"1\"><c r=\"A1\" t=\"inlineStr\"><is><t>予約</t></is></c></row>",
    "<row r=\"2\">" + s("A2", 0) + s("B2", 1) + s("C2", 2) + s("D2", 7) + s("E2", 3) + s("F2", 4) + s("G2", 9) + "</row>",
    "<row r=\"3\"><c r=\"A3\" t=\"inlineStr\"><is><t>X1</t></is></c><c r=\"B3\" s=\"1\"><v>" + serial + "</v></c>" +
      "<c r=\"C3\"><v>2</v></c><c r=\"D3\" t=\"n\"><v>1</v></c>" + s("E3", 5) + s("F3", 6) +
      "<c r=\"G3\" t=\"str\"><f>\"確認\"</f><v>確認</v></c></row>",
    "<row r=\"4\"/>",
    "<row r=\"5\"><c r=\"A5\" t=\"inlineStr\"><is><t>X2</t></is></c><c r=\"B5\" t=\"d\"><v>2026-10-15T19:00:00</v></c>" +
      "<c r=\"C5\"><v>3</v></c><c r=\"E5\" t=\"inlineStr\"><is><t>テスト &lt;次郎&gt;</t></is></c>" + s("G5", 8) + "</row>",
  ]);
  var decoy = fixture.worksheet([fixture.inlineRow(1, ["来店日時", "名前", "人数"]), fixture.inlineRow(2, ["2026-10-01 10:00", "別シート", "9"])]);
  var book = fixture.xlsx({
    sheet: sheet, sheetPath: "worksheets/sheet2.xml", otherSheets: { "worksheets/sheet1.xml": decoy },
    sharedStrings: sst, styles: styles, method: 0,
  });

  var out = imp.parseXlsx(book, OPTS);
  assert.equal(out.error, undefined);
  assert.equal(out.columns.datetime, "予約時間", "日付の数値も年月日の入った値として見る");
  assert.deepEqual(out.rows.map(function (r) { return r.line; }), [3, 5], "空の行を飛ばし、Excel の行番号を返す");
  var a = out.rows[0].draft;
  assert.equal(a.rid, "X1");
  assert.equal(Date.parse(a.startAt), local(2026, 10, 14, 11, 0));
  assert.equal(a.adults, 2, "数値の人数は日付にしない");
  assert.equal(a.kids, 1);
  assert.equal(a.name, "テスト 太郎", "ふりがなを名前に混ぜない");
  assert.deepEqual(a.menu, [{ name: "うなぎ&たまご", qty: 1 }]);
  assert.equal(a.status, "booked");
  var b = out.rows[1].draft;
  assert.equal(b.rid, "X2");
  assert.equal(Date.parse(b.startAt), local(2026, 10, 15, 19, 0));
  assert.equal(b.name, "テスト <次郎>");
});

test("Excel: 読めないファイルは理由を返し、行数の上限を守る", function () {
  var broken = imp.parseImportFile(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(40)]), OPTS);
  assert.match(broken.error, /Excelファイルを読めません/);
  assert.deepEqual(broken.rows, []);
  assert.match(imp.parseImportFile(fixture.zip([{ name: "a.txt", data: "x" }]), OPTS).error, /Excelファイルを読めません/);
  var ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64)]);
  assert.match(imp.parseImportFile(ole, OPTS).error, /古い形式の Excel/);

  var many = [fixture.inlineRow(1, ["来店日時", "名前", "人数"])];
  for (var i = 0; i < 501; i++) many.push(fixture.inlineRow(i + 2, ["2026-10-14 18:30", "山田", "2"]));
  assert.match(imp.parseXlsx(fixture.xlsx({ sheet: fixture.worksheet(many) }), OPTS).error, /行数が多すぎます/);
  assert.equal(imp.parseXlsx(fixture.xlsx({ sheet: fixture.worksheet(many.slice(0, 501)) }), OPTS).rows.length, 500);
});

test("文字コード: UTF-8 として読めないバイト列は Shift_JIS とみなす", function () {
  // "来店日時" の Shift_JIS
  var sjis = Buffer.from([0x97, 0x88, 0x93, 0x58, 0x93, 0xfa, 0x8e, 0x9e]);
  assert.equal(imp.decodeBytes(sjis), "来店日時");
  assert.equal(imp.decodeBytes(Buffer.from("来店日時", "utf8")), "来店日時");
});

test("貼り付け: ラベル付きの行を読み、複数行のメニューを品目に分ける", function () {
  var out = imp.parseText([
    "■ご予約内容",
    "予約番号：TC12345",
    "来店日時：2026年10月14日(水) 18:30",
    "お名前：山田　太郎 様",
    "人数：大人2名 子供1名",
    "【メニュー】",
    "・土鍋御膳 x2",
    "・うなぎ ×1",
    "",
    "アレルギー：えび、かに",
    "ご要望：窓側の席を希望",
    "電話番号：090-0000-0000",
  ].join("\n"), OPTS);
  assert.deepEqual(out.warnings, []);
  assert.equal(out.draft.rid, "TC12345");
  assert.equal(Date.parse(out.draft.startAt), local(2026, 10, 14, 18, 30));
  assert.equal(out.draft.name, "山田 太郎");
  assert.equal(out.draft.adults, 2);
  assert.equal(out.draft.kids, 1);
  assert.deepEqual(out.draft.menu, [{ name: "土鍋御膳", qty: 2 }, { name: "うなぎ", qty: 1 }]);
  assert.equal(out.draft.allergies, "えび、かに");
  assert.equal(out.draft.request, "窓側の席を希望");
  assert.equal(JSON.stringify(out.draft).indexOf("090"), -1, "連絡先は取り込まない");
});

test("貼り付け: ラベルが無くても本文から日時・名前・人数・数量付きの品目を拾う", function () {
  var out = imp.parseText("山田 様\n10/14 18:30 から 3名\n土鍋御膳 x3\nよろしくお願いします", OPTS);
  assert.equal(Date.parse(out.draft.startAt), local(2026, 10, 14, 18, 30));
  assert.equal(out.draft.name, "山田");
  assert.equal(out.draft.adults, 3);
  assert.deepEqual(out.draft.menu, [{ name: "土鍋御膳", qty: 3 }]);
  assert.match(out.draft.rid, /^txt-/);
});

test("貼り付け: 読み取れなかった項目を warnings で返し、ridは付けない", function () {
  var out = imp.parseText("こんにちは", OPTS);
  assert.equal(out.draft.startAt, null);
  assert.equal(out.draft.rid, null);
  assert.equal(out.warnings.length, 4);
});

test("メール: base64の本文と、折り返してエンコードされた件名を読む", function () {
  var body = "来店日時: 2026/10/14 18:30\r\nお名前: 山田 太郎 様\r\n人数: 2名\r\nメニュー: 土鍋御膳 x2\r\nアレルギー: なし\r\n";
  var eml = [
    "From: =?UTF-8?B?" + Buffer.from("予約システム").toString("base64") + "?= <noreply@example.com>",
    "Subject: =?UTF-8?B?" + Buffer.from("ご予約確定の").toString("base64") + "?=",
    " =?UTF-8?B?" + Buffer.from("お知らせ").toString("base64") + "?=",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=\"UTF-8\"",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(body, "utf8").toString("base64").replace(/(.{60})/g, "$1\r\n"),
  ].join("\r\n");
  var out = imp.parseMail(Buffer.from(eml, "latin1"), OPTS);
  assert.equal(out.subject, "ご予約確定のお知らせ");
  assert.match(out.from, /予約システム/);
  assert.equal(out.draft.name, "山田 太郎");
  assert.equal(Date.parse(out.draft.startAt), local(2026, 10, 14, 18, 30));
  assert.deepEqual(out.draft.menu, [{ name: "土鍋御膳", qty: 2 }]);
  assert.equal(out.draft.allergies, null);
  assert.equal(out.draft.status, "booked");
  assert.match(out.draft.rid, /^mail-/);
});

/** ISO-2022-JP へ符号化する (JIS X 0208 の符号は EUC-JP の各バイトから 0x80 を引いたもの) */
function iso2022jp(text) {
  var iconv = require("iconv-lite");
  var out = "", kanji = false;
  Array.from(text).forEach(function (ch) {
    if (ch.charCodeAt(0) < 0x80) {
      if (kanji) { out += "\x1b(B"; kanji = false; }
      out += ch;
      return;
    }
    if (!kanji) { out += "\x1b$B"; kanji = true; }
    var euc = iconv.encode(ch, "eucjp");
    out += String.fromCharCode(euc[0] - 0x80, euc[1] - 0x80);
  });
  return kanji ? out + "\x1b(B" : out;
}

test("メール: ISO-2022-JP の7bit本文を読む", function () {
  var iso = iso2022jp("来店日時: 2026/10/14 18:30\r\n名前: 山田\r\n");
  assert.ok(!/[\x80-\xff]/.test(iso), "7bitだけで表せている");
  var eml = "Subject: test\r\nContent-Type: text/plain; charset=ISO-2022-JP\r\nContent-Transfer-Encoding: 7bit\r\n\r\n" + iso;
  var out = imp.parseMail(Buffer.from(eml, "latin1"), OPTS);
  assert.equal(Date.parse(out.draft.startAt), local(2026, 10, 14, 18, 30));
  assert.equal(out.draft.name, "山田");
});

test("メール: multipart は text/plain を優先し、HTMLだけならタグを外す。件名のキャンセルは取消にする", function () {
  var html = "<html><body><p>来店日時: 2026/10/14 18:30</p><div>お名前: 山田&nbsp;様</div><p>人数: 2名</p></body></html>";
  var eml = [
    "Subject: =?UTF-8?Q?=E3=82=AD=E3=83=A3=E3=83=B3=E3=82=BB=E3=83=AB?=",
    "Content-Type: multipart/alternative; boundary=\"b1\"",
    "",
    "--b1",
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    Buffer.from(html, "utf8").toString("latin1").replace(/[\x80-\xff=]/g, function (c) {
      return "=" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0");
    }),
    "--b1--",
    "",
  ].join("\r\n");
  var out = imp.parseMail(Buffer.from(eml, "latin1"), OPTS);
  assert.equal(out.subject, "キャンセル");
  assert.equal(out.draft.status, "canceled");
  assert.equal(out.draft.name, "山田");
  assert.equal(out.draft.adults, 2);
  assert.equal(Date.parse(out.draft.startAt), local(2026, 10, 14, 18, 30));
});

test("メール: ヘッダーの無いテキストは本文として読み、確定と取消で同じridになる", function () {
  var text = "来店日時: 2026/10/14 18:30\nお名前: 山田 様\n人数: 2名\n";
  var booked = imp.parseMail(text, OPTS);
  var canceled = imp.parseMail("Subject: 予約キャンセルのお知らせ\nContent-Type: text/plain; charset=iso-2022-jp\n\n" + text, OPTS);
  assert.equal(booked.subject, null);
  assert.equal(booked.draft.name, "山田");
  assert.equal(canceled.subject, "予約キャンセルのお知らせ");
  assert.equal(canceled.draft.status, "canceled");
  assert.equal(canceled.draft.rid, booked.draft.rid, "取消メールが確定メールの予約を上書きできる");
});
