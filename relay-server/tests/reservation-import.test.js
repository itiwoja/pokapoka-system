"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var imp = require("../reservation-import");

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
