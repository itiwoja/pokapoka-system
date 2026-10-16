/**
 * reservation-samples.js — 予約入力画面 (/reservations) を試すためのサンプルを作る
 *
 *   npm run reservation:samples
 *
 * 当日の日付で、CSV (B)・貼り付け用テキスト (C)・予約メール (D) を data/samples/ に書き出し、
 * メール2通を取込フォルダ data/mail-inbox/ に置く。内容はすべて架空で、実在の予約ではない。
 * TableCheck の実物の書式ではなく、この試作が読める形の例である。
 * data/ は .gitignore 済みなので、何度実行してもリポジトリは汚れない。
 */
"use strict";

var fs = require("node:fs");
var path = require("node:path");

var root = path.resolve(__dirname, "..");
var samplesDir = path.join(root, "data", "samples");
var inboxDir = path.join(root, "data", "mail-inbox");

var now = new Date();
var day = now.getFullYear() + "/" + (now.getMonth() + 1) + "/" + now.getDate();

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
  console.log("作成: " + path.relative(root, file));
}

function mail(subject, lines) {
  return [
    "From: reservation@example.com",
    "Subject: =?UTF-8?B?" + Buffer.from(subject, "utf8").toString("base64") + "?=",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
  ].concat(lines).join("\r\n") + "\r\n";
}

// B. CSV取込: 列名から項目を判別する。3行目は日付が読めず、取り込めない行の例
write(path.join(samplesDir, "sample.csv"), [
  "予約番号,来店日,来店時間,予約者名,大人,子供,コース,アレルギー,ご要望,ステータス,電話番号",
  "S-001," + day + ",11:30,田中 一郎,2,0,山城牛の焼きすき土鍋御膳 x2,なし,,確定,000-0000-0000",
  "S-002," + day + ",12:00,伊藤 花子,4,1,\"うなぎ土鍋御膳 x2\n山城牛の焼きすき土鍋御膳 x2\",そば,窓側の席を希望,確定,000-0000-0000",
  "S-003,日付未定,12:30,鈴木 次郎,2,0,うなぎ土鍋御膳 x2,,,確定,000-0000-0000",
  "S-004," + day + ",13:00,佐藤 三郎,3,0,山城牛の焼きすき土鍋御膳 x3,,,キャンセル,000-0000-0000",
].join("\n") + "\n");

// C. 貼り付け: 「項目名: 値」の行を読む。電話番号の行は取り込まれない
write(path.join(samplesDir, "sample-paste.txt"), [
  "■ご予約内容",
  "来店日時: " + day + " 18:00",
  "お名前: 渡辺 美咲 様",
  "人数: 大人2名 子供1名",
  "【メニュー】",
  "・山城牛の焼きすき土鍋御膳 x2",
  "・うなぎ土鍋御膳 x1",
  "",
  "アレルギー: かに",
  "ご要望: ベビーカーで来店します",
  "電話番号: 000-0000-0000",
].join("\n") + "\n");

// D. メール: 取込フォルダに置くと画面の候補に並ぶ。2通目は件名で取消と判定される例
var booked = mail("ご予約確定のお知らせ", [
  "来店日時: " + day + " 18:30",
  "お名前: 高橋 健 様",
  "人数: 大人2名",
  "メニュー:",
  "山城牛の焼きすき土鍋御膳 x2",
  "",
  "アレルギー: えび",
  "電話番号: 000-0000-0000",
]);
var canceled = mail("ご予約キャンセルのお知らせ", [
  "来店日時: " + day + " 19:00",
  "お名前: 小林 涼 様",
  "人数: 大人4名",
  "メニュー:",
  "うなぎ土鍋御膳 x4",
]);
write(path.join(samplesDir, "sample-mail.eml"), booked);
write(path.join(inboxDir, "sample-booked.eml"), booked);
write(path.join(inboxDir, "sample-canceled.eml"), canceled);

console.log("\n次に `npm start` で起動し、http://127.0.0.1:8000/reservations を開く。");
