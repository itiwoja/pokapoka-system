"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var imp = require("../reservation-import");
var buildXlsx = require("./xlsx-fixture").buildXlsx;

// 2026-10-13 12:00 (サーバーのローカル時刻) を「今」とする
var NOW = new Date(2026, 9, 13, 12, 0, 0);
var OPTS = { now: NOW };

function local(y, m, d, h, mi) { return new Date(y, m - 1, d, h, mi).getTime(); }

test("公開API: 既存の9関数だけを同じ名前で公開する", function () {
  assert.deepEqual(Object.keys(imp), ["decodeBytes", "parseDateTime", "parsePeople", "parseMenuList",
    "parseCsv", "parseXlsx", "parseSpreadsheet", "parseText", "parseMail"]);
  Object.keys(imp).forEach(function (name) { assert.equal(typeof imp[name], "function", name); });
});

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

function people(adults, seniors, children, kids) {
  return { adults: adults, seniors: seniors, children: children, kids: kids };
}

test("人数: 大人・シニア・子供・幼児を分けて読み、合計だけなら残りを大人に寄せる", function () {
  assert.deepEqual(imp.parsePeople("大人2名 子供1名"), people(2, 0, 1, 0));
  assert.deepEqual(imp.parsePeople("大人2名 シニア1名 子供1名 幼児1名"), people(2, 1, 1, 1), "まとめない");
  assert.deepEqual(imp.parsePeople("3名"), people(3, 0, 0, 0));
  assert.deepEqual(imp.parsePeople("3名(子供1名)"), people(2, 0, 1, 0));
  assert.deepEqual(imp.parsePeople("5名(シニア1名・乳幼児1名)"), people(3, 1, 0, 1));
  assert.deepEqual(imp.parsePeople("お子様1名を含む4名"), people(3, 0, 1, 0), "区分つきの人数を合計と取り違えない");
  assert.deepEqual(imp.parsePeople("シニア1名・計3名"), people(2, 1, 0, 0));
  assert.deepEqual(imp.parsePeople("４"), people(4, 0, 0, 0));
  assert.equal(imp.parsePeople("未定"), null);
});

test("メニュー: 数量の書き方の違いを受け、requireQty では数量のある行だけ拾う", function () {
  assert.deepEqual(imp.parseMenuList("土鍋御膳 x2、うなぎ×1\n・茶 3個\nプリン"), [
    { name: "土鍋御膳", qty: 2 }, { name: "うなぎ", qty: 1 }, { name: "茶", qty: 3 }, { name: "プリン", qty: 1 },
  ]);
  assert.deepEqual(imp.parseMenuList("1 × 鰻と和牛レアすき極上土鍋御膳, 2 × 山城牛のカニクラ土鍋御膳"), [
    { name: "鰻と和牛レアすき極上土鍋御膳", qty: 1 }, { name: "山城牛のカニクラ土鍋御膳", qty: 2 },
  ], "TableCheck は数量を先に書く");
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
  assert.equal(first.draft.children, 1, "「子供」は幼児 (kids) と分けて持つ");
  assert.equal(first.draft.kids, 0);
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
  assert.equal(a.children, 1);
  assert.match(a.rid, /^csv-[0-9a-f]{16}$/);
  assert.equal(a.rid, b.rid, "再取込で二重登録にならない");
});

/*
 * TableCheck の予約一覧の形 (2026-10-22 に店から受け取った .xlsx の見出しと値の書き方)。
 * 名前・電話番号などは架空の値に置き換えている。列は実物の72列のうち取込に関わるものと、使わない列の例
 */
var TC_HEADER = ["店舗", "予約ID", "予約時間", "滞在時間", "人数:大人", "人数:シニア", "人数:子供", "人数:幼児",
  "テーブル", "名前", "電話", "Eメール", "注文", "予約メモ", "ステータス", "食事制限・アレルギー", "苦手なもの",
  "開始日", "開始時刻", "注文合計金額", "顧客メモ"];
var TC_ROWS = [
  ["土鍋飯ぽかぽかminatogawa", "TEST01", "2026-10-20 11:00", "1時間 30分", "4", "0", "0", "1",
    "A1/2", "てすと たろう", "090-0000-0000", "", "", "", "確認", "", "", "2026-10-20", "11:00", "0", ""],
  ["土鍋飯ぽかぽかminatogawa", "TEST02", "2026-10-20 13:30", "1時間 30分", "2", "1", "1", "0",
    "B5", "しさく はなこ", "070-0000-0000", "test@example.com",
    "1 × 鰻と和牛レアすき極上土鍋御膳, 2 × 山城牛のカニクラ土鍋御膳",
    "質問1: アレルギーやお苦手な食材のあ… 回答1: えび\nご利用回数: 初来店", "確認", "", "", "2026-10-20", "13:30", "13520.0", ""],
  ["土鍋飯ぽかぽかminatogawa", "TEST03", "2026-10-20 18:00", "2時間", "2", "0", "0", "0",
    "C1", "とりけし", "", "", "1 × 炙り鰻のひつまぶし土鍋御膳", "質問1: アレルギーやお苦手な食材のあ… 回答1: なし",
    "キャンセル", "", "", "2026-10-20", "18:00", "0", ""],
];

function csvLine(cells) {
  return cells.map(function (c) { return /[",\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c; }).join(",");
}

function assertTableCheckRows(out) {
  assert.equal(out.error, undefined);
  assert.equal(out.columns.time, "予約時間");
  assert.equal(out.columns.seniors, "人数:シニア");
  assert.equal(out.columns.kids, "人数:幼児");
  assert.ok(out.unmapped.indexOf("電話") >= 0 && out.unmapped.indexOf("Eメール") >= 0, "連絡先は取り込まない");
  assert.equal(out.rows.length, 3, "タイトル行と見出し行は予約に数えない");

  var first = out.rows[0];
  assert.equal(first.line, 3, "タイトル行・見出し行を含めた行番号");
  assert.deepEqual(first.errors, []);
  assert.equal(first.draft.rid, "TEST01");
  assert.equal(Date.parse(first.draft.startAt), local(2026, 10, 20, 11, 0));
  assert.deepEqual([first.draft.adults, first.draft.seniors, first.draft.children, first.draft.kids], [4, 0, 0, 1]);
  assert.equal(first.draft.table, "A1/2");
  assert.equal(first.draft.status, "booked", "「確認」は予約済み");
  assert.deepEqual(first.draft.menu, [], "電話予約で注文なし");

  var second = out.rows[1].draft;
  assert.deepEqual([second.adults, second.seniors, second.children, second.kids], [2, 1, 1, 0], "まとめない");
  assert.deepEqual(second.menu, [
    { name: "鰻と和牛レアすき極上土鍋御膳", qty: 1 }, { name: "山城牛のカニクラ土鍋御膳", qty: 2 },
  ]);
  assert.equal(second.allergies, "えび", "予約メモの質問の回答から拾う");
  assert.match(second.memo, /ご利用回数: 初来店/);
  assert.equal(JSON.stringify(out.rows).indexOf("090-"), -1, "電話番号は下書きに入らない");
  assert.equal(JSON.stringify(out.rows).indexOf("example.com"), -1, "メールアドレスは下書きに入らない");

  assert.equal(out.rows[2].draft.status, "canceled");
  assert.equal(out.rows[2].draft.allergies, null, "回答「なし」はアレルギーにしない");
}

test("CSV: TableCheck の予約一覧 (1行目がタイトル、日時が「予約時間」1列) を読む", function () {
  var csv = ["予約", csvLine(TC_HEADER)].concat(TC_ROWS.map(csvLine)).join("\r\n") + "\r\n";
  assertTableCheckRows(imp.parseCsv(csv, OPTS));
});

test("Excel: TableCheck の予約一覧 (.xlsx) を CSV と同じように読む", function () {
  var rows = [["予約"], TC_HEADER].concat(TC_ROWS.map(function (r) { return r.slice(); }));
  // Excel で保存し直すと日時が日付シリアルの数値になり、セルがインライン文字列になることがある
  rows[3][2] = { serial: 46315.5625 };   // 2026-10-20 13:30
  rows[4][9] = { inline: "とりけし" };
  var buf = buildXlsx(rows);
  var out = imp.parseSpreadsheet(buf, OPTS);
  assertTableCheckRows(out);
  assert.equal(out.rows[1].draft.name, "しさく はなこ", "ふりがなは名前に混ぜない");
  assert.equal(Date.parse(out.rows[1].draft.startAt), local(2026, 10, 20, 13, 30), "日付シリアルを日時として読む");
});

test("Excel: 和暦などの組み込み日付書式と、1904年基準のブックの日付シリアルを読む", function () {
  var header = ["予約ID", "予約時間", "人数:大人", "注文"];
  var builtin = imp.parseSpreadsheet(buildXlsx([header, ["J1", { serial: 46315.5625, builtin: true }, "2", "1 × 茶"]]), OPTS);
  assert.equal(Date.parse(builtin.rows[0].draft.startAt), local(2026, 10, 20, 13, 30), "日本語版 Excel の組み込み書式 57");
  // 1904年基準では同じ日時のシリアルが 1462 小さい
  var mac = imp.parseSpreadsheet(buildXlsx([header, ["M1", { serial: 46315.5625 - 1462 }, "2", "1 × 茶"]], { date1904: true }), OPTS);
  assert.equal(Date.parse(mac.rows[0].draft.startAt), local(2026, 10, 20, 13, 30), "Mac 版 Excel の1904年基準");
});

test("Excel: 部品の場所や名前が違うファイルも、目次 (.rels) をたどって読む", function () {
  var rows = [["予約"], ["予約ID", "予約時間", "人数:大人", "注文"], ["R1", { serial: 46315.5625 }, "2", "1 × 茶"]];
  var out = imp.parseSpreadsheet(buildXlsx(rows, { relocated: true }), OPTS);
  assert.equal(out.error, undefined);
  assert.equal(out.rows[0].draft.rid, "R1");
  assert.equal(Date.parse(out.rows[0].draft.startAt), local(2026, 10, 20, 13, 30), "書式も別の場所から読む");
});

test("Excel: 日時の書式なら0時ちょうどでも時刻を残し、右端の列は読み飛ばす", function () {
  var rows = [["予約時間", "名前"], [{ serial: 46315 }, "山田", { ref: "XFD", inline: "右端" }]];
  var out = imp.parseSpreadsheet(buildXlsx(rows), OPTS);
  assert.deepEqual(out.rows[0].errors, []);
  assert.equal(Date.parse(out.rows[0].draft.startAt), local(2026, 10, 20, 0, 0), "2026-10-20 00:00");
  assert.equal(out.unmapped.length, 0, "1000列目より右は読まない");
});

test("Excel: 行が多すぎるファイルは、読み切る前に断る", function () {
  var rows = [["予約時間", "名前"]];
  for (var i = 0; i < 5001; i++) rows.push(["2026-10-20 18:00", "山田" + i]);
  assert.match(imp.parseSpreadsheet(buildXlsx(rows), OPTS).error, /行数が多すぎます/);
});

test("Excel: 壊れたファイルは全体を断り、CSV は先頭のバイトで見分けて従来どおり読む", function () {
  var broken = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(40)]);
  assert.match(imp.parseSpreadsheet(broken, OPTS).error, /Excelファイルを読めません/);
  var csv = imp.parseSpreadsheet(Buffer.from("来店日時,名前,大人\n2026-10-14 18:30,山田,2\n", "utf8"), OPTS);
  assert.equal(csv.rows[0].draft.adults, 2);
});

test("CSV: 作成日時・受付日など来店でない日時の列を来店日時と取り違えない", function () {
  var out = imp.parseCsv("作成日時,予約日,予約時間,名前\n2026-10-01 09:00,2026-10-01,2026-10-25 18:00,山田\n", OPTS);
  assert.equal(out.columns.datetime, undefined, "作成日時は来店日時にしない");
  assert.equal(Date.parse(out.rows[0].draft.startAt), local(2026, 10, 25, 18, 0), "時間の列の日付を日付の列より優先する");
  var relative = imp.parseCsv("予約日,時間,名前\n2026-10-25,本日19:00,田中\n", OPTS);
  assert.equal(Date.parse(relative.rows[0].draft.startAt), local(2026, 10, 25, 19, 0), "相対の書き方なら日付の列を正とする");
  var ended = imp.parseCsv("予約時間,終了日時,名前\n2026-10-25 18:00,2026-10-25 20:00,山田\n", OPTS);
  assert.equal(Date.parse(ended.rows[0].draft.startAt), local(2026, 10, 25, 18, 0), "終了日時は来店日時にしない");
});

test("CSV: 来店日時列を最優先し、読めなければ絶対日時の予約時間列へ戻る", function () {
  var csv = "来店日時,予約日,予約時間,名前\n" +
    "2026-10-24 17:00,2026-10-01,2026-10-25 18:00,山田\n" +
    "不明,2026-10-01,2026-10-25 18:00,田中\n";
  var out = imp.parseCsv(csv, OPTS);
  assert.equal(Date.parse(out.rows[0].draft.startAt), local(2026, 10, 24, 17, 0));
  assert.equal(Date.parse(out.rows[1].draft.startAt), local(2026, 10, 25, 18, 0));
  assert.deepEqual(out.rows.map(function (row) { return row.errors; }), [[], []]);
});

test("CSV: 見出し探索は5行まで、予約データは500行まで受ける", function () {
  var titles = "予約\n一覧\n出力\n当日分\n";
  var header = "来店日時,名前\n";
  var row = "2026-10-14 18:30,山田\n";
  var atLimit = imp.parseCsv(titles + header + row.repeat(500), OPTS);
  assert.equal(atLimit.error, undefined);
  assert.equal(atLimit.rows.length, 500);
  assert.equal(atLimit.rows[0].line, 6);
  assert.equal(atLimit.rows[499].line, 505);
  assert.equal(imp.parseCsv(titles + header + row.repeat(501), OPTS).error, "行数が多すぎます (500行まで)");
  assert.match(imp.parseCsv(titles + "追加タイトル\n" + header + row, OPTS).error, /来店日時の列/);
});

test("アレルギー: 「特にありません」など否定の自由回答はアレルギーにしない", function () {
  ["特にありません", "ありません。", "大丈夫です", "なし。", "問題ないです"].forEach(function (answer) {
    var csv = "来店日時,予約メモ\n2026-10-14 18:30,\"質問1: アレルギーやお苦手な食材のあ… 回答1: " + answer + "\"\n";
    assert.equal(imp.parseCsv(csv, OPTS).rows[0].draft.allergies, null, answer);
  });
  var csv = "来店日時,アレルギー\n2026-10-14 18:30,ありません、えびが苦手です\n";
  assert.equal(imp.parseCsv(csv, OPTS).rows[0].draft.allergies, "ありません、えびが苦手です", "続きのある回答は残す");
});

test("アレルギー: 列・予約メモの複数行の回答・苦手なものを全部つなぎ、どれも落とさない", function () {
  var csv = "予約\n来店日時,食事制限・アレルギー,予約メモ,苦手なもの\n2026-10-14 18:30,小麦," +
    "\"質問1: アレルギーやお苦手な食材のあ… 回答1: えび\nかに\n落花生\nご利用回数: 初来店\",しいたけ\n";
  var draft = imp.parseCsv(csv, OPTS).rows[0].draft;
  assert.equal(draft.allergies, "小麦 / えび、かに、落花生 / 苦手: しいたけ");
});

test("CSV: 1行目がタイトルだけでも、タブ区切りを見分ける", function () {
  var out = imp.parseCsv("予約\n予約時間\t名前\t人数:大人\n2026-10-14 18:30\t山田\t2\n", OPTS);
  assert.equal(out.error, undefined);
  assert.equal(out.rows[0].draft.name, "山田");
  assert.equal(out.rows[0].draft.adults, 2);
});

test("CSV: 来店日時の列が無ければファイル全体を断る", function () {
  var out = imp.parseCsv("名前,人数\n山田,2\n", OPTS);
  assert.match(out.error, /来店日時の列/);
  assert.match(imp.parseCsv("来店時間,名前\n18:30,山田\n", OPTS).error, /来店日時の列/, "日付の無い時刻だけの列は断る");
  assert.deepEqual(out.rows, []);
  assert.match(imp.parseCsv("", OPTS).error, /行がありません/);
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
  assert.equal(out.draft.children, 1);
  assert.equal(out.draft.kids, 0);
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
  assert.deepEqual(out.draft, {
    rid: null, startAt: null, adults: 0, seniors: 0, children: 0, kids: 0, name: null,
    status: "booked", table: null, menu: [], allergies: null, request: null, memo: null,
  });
  assert.deepEqual(out.warnings, ["来店日時を読み取れませんでした", "予約者名を読み取れませんでした",
    "人数を読み取れませんでした", "メニューを読み取れませんでした (メニューの無い予約は厨房画面に出ません)"]);
});

test("ID: 日時の瞬間と空白除去・NFKCした名前をハッシュ化し、入口ごとの接頭辞を保つ", function () {
  var startAt = "2026-10-14T18:30:00+09:00";
  var hash = require("node:crypto").createHash("sha256")
    .update(String(Date.parse(startAt)) + "|山田A", "utf8").digest("hex").slice(0, 16);
  var csv = "来店日時,名前\n" + startAt + ",山田　Ａ 様\n";
  var text = "来店日時: " + startAt + "\n名前: 山田 A 様\n";
  assert.equal(imp.parseCsv(csv, OPTS).rows[0].draft.rid, "csv-" + hash);
  assert.equal(imp.parseText(text, OPTS).draft.rid, "txt-" + hash);
  assert.equal(imp.parseMail(text, OPTS).draft.rid, "mail-" + hash);
  assert.equal(imp.parseText(text, { now: NOW, ridPrefix: "custom" }).draft.rid, "custom-" + hash);
  var namelessCsv = imp.parseCsv("来店日時\n" + startAt + "\n", OPTS).rows[0].draft;
  assert.match(namelessCsv.rid, /^csv-[0-9a-f]{16}$/, "CSV は名前が無くても日時から採番する");
  assert.equal(imp.parseText("来店日時: " + startAt, OPTS).draft.rid, null, "貼り付けは名前も必要");
  assert.equal(imp.parseMail("来店日時: " + startAt, OPTS).draft.rid, null, "メールも名前が必要");
  assert.equal(imp.parseText("予約番号: Ａ １２３\n" + text, OPTS).draft.rid, "A123", "明示の番号を優先する");
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

test("メール: HTMLだけならタグを外す。件名のキャンセルは取消にする", function () {
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

function multipart(parts, boundary) {
  return "Content-Type: multipart/alternative; boundary=\"" + boundary + "\"\r\n\r\n" +
    parts.map(function (part) { return "--" + boundary + "\r\n" + part + "\r\n"; }).join("") +
    "--" + boundary + "--\r\n";
}

function mailPart(type, body) {
  return "Content-Type: " + type + "; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n" +
    Buffer.from(body, "utf8").toString("base64");
}

test("メール: plainとHTMLを両方含むMIMEでは順序によらずplainを優先する", function () {
  var body = "来店日時: 2026/10/14 18:30\n名前: 本文の山田\n人数: 2名\nメニュー: 茶 x2";
  var text = mailPart("text/plain", body);
  var html = mailPart("text/html", "<p>来店日時: 2026/10/15 19:00</p><p>名前: HTMLの田中</p><p>人数: 3名</p>");
  [[html, text], [text, html]].forEach(function (parts) {
    var out = imp.parseMail(Buffer.from(multipart(parts, "both"), "latin1"), OPTS);
    assert.equal(out.body, body);
    assert.equal(out.draft.name, "本文の山田");
    assert.equal(out.draft.adults, 2);
    assert.deepEqual(out.warnings, []);
    assert.equal(Date.parse(out.draft.startAt), local(2026, 10, 14, 18, 30));
  });
});

test("メール: quoted-printableのsoft breakをLF/CRLFとも除き、日本語のバイト列をつなぐ", function () {
  var body = "来店日時: 2026/10/14 18:30\r\n名前: 山田\r\n人数: 2名\r\nメニュー: 土鍋御膳 x2";
  var encoded = Array.from(Buffer.from(body, "utf8")).map(function (byte) {
    return "=" + byte.toString(16).toUpperCase().padStart(2, "0");
  }).join("");
  ["\n", "\r\n"].forEach(function (newline) {
    // =XX の途中でも折り返し、soft break の除去後に復元されることを確かめる
    var folded = encoded.match(/.{1,17}/g).join("=" + newline);
    var eml = "Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n" + folded;
    var out = imp.parseMail(Buffer.from(eml, "latin1"), OPTS);
    assert.equal(out.body, body);
    assert.equal(out.draft.name, "山田");
    assert.deepEqual(out.draft.menu, [{ name: "土鍋御膳", qty: 2 }]);
    assert.deepEqual(out.warnings, []);
  });
});

test("メール: multipartは5段まで展開し、6段目は読まず外側のHTMLへフォールバックする", function () {
  var body = "来店日時: 2026/10/14 18:30\n名前: 山田\n人数: 2名\nメニュー: 茶 x2";
  var nested = mailPart("text/plain", body);
  for (var depth = 1; depth <= 6; depth++) {
    nested = multipart([nested], "depth" + depth);
    var out = imp.parseMail(Buffer.from(nested, "latin1"), OPTS);
    if (depth <= 5) {
      assert.equal(out.body, body, depth + "段");
      assert.deepEqual(out.warnings, []);
    } else {
      assert.equal(out.body, "", "6段目の本文は展開しない");
      assert.equal(out.warnings.length, 4);
    }
  }
  var fallback = multipart([nested, mailPart("text/html", "<p>名前: HTMLの田中</p>")], "fallback");
  assert.equal(imp.parseMail(Buffer.from(fallback, "latin1"), OPTS).draft.name, "HTMLの田中");
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

test("人数の区分: 合計と内訳は party-size.js の1か所で決める", function () {
  var partySize = require("../party-size");
  var rec = { adults: 2, seniors: 1, children: 1, kids: 1 };
  assert.deepEqual(partySize.KEYS, ["adults", "seniors", "children", "kids"]);
  assert.equal(partySize.total(rec), 5);
  assert.deepEqual(partySize.breakdown(rec).map(function (p) { return p.short + p.n; }), ["大2", "シ1", "子1", "幼1"]);
  assert.deepEqual(partySize.breakdown({ adults: 4 }, { onlyMixed: true }), [], "大人だけなら KDS は合計だけ");
  assert.equal(partySize.total({ adults: "3", kids: null }), 3, "文字列や欠けた値も数える");
});
