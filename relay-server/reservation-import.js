/**
 * reservation-import.js — 予約の取込 (CSV・貼り付けテキスト・メール) の公開ファサード
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
 *
 * 実装は reservation-import/ 以下へ分ける。依存は mail → text → common、
 * tabular → common / xlsx-reader の一方向とし、この入口は既存の9関数だけを公開する。
 */
"use strict";

var common = require("./reservation-import/common");
var tabular = require("./reservation-import/tabular");
var text = require("./reservation-import/text");
var mail = require("./reservation-import/mail");

module.exports = {
  decodeBytes: common.decodeBytes,
  parseDateTime: common.parseDateTime,
  parsePeople: common.parsePeople,
  parseMenuList: common.parseMenuList,
  parseCsv: tabular.parseCsv,
  parseXlsx: tabular.parseXlsx,
  parseSpreadsheet: tabular.parseSpreadsheet,
  parseText: text.parseText,
  parseMail: mail.parseMail,
};
