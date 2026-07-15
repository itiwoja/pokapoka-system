/**
 * mock-tablecheck.js — TableCheck API のふるまいを模したデモデータ供給源
 *
 * API 契約・スキーマ確定前に中継サーバー〜KDS の疎通を確認するためのモック。
 * server.js が MOCK=1 (または API キー未設定) のとき使う。
 *
 * シナリオ: 起動から数回のポーリングで
 *   1回目: 予約2件 created (メニュー予約 + 席だけ予約 ※後者は KDS に出ない)
 *   2回目: 予約1件 created (memo 自由テキストでメニュー記載 → パーサ経由)
 *   3回目: 最初の予約が updated (人数変更) / 以降: 変化なし
 *   5回目: 2件目相当の予約が canceled → KDS から消える
 */
"use strict";

var tick = 0;

function today(h, m) {
  var d = new Date();
  d.setHours(h, m, 0, 0);
  // ISO8601 (ローカルTZオフセット付き) — TableCheck の start_at 形式に合わせる
  var off = -d.getTimezoneOffset();
  var sign = off >= 0 ? "+" : "-";
  var pad = function (n) { return (Math.abs(n) < 10 ? "0" : "") + Math.abs(n); };
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
    "T" + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":00" +
    sign + pad(Math.floor(off / 60)) + pad(off % 60);
}

var DB = {
  "mock-r1": {
    id: "mock-r1", status: "booked", start_at: today(18, 30),
    customer_name: "山田", adults: 2, kids: 1,
    courses: [
      { name: "山城牛の焼きすき土鍋御膳", qty: 2, options: "ご飯大盛り", allergies: null },
      { name: "うなぎの土鍋御膳", qty: 1, options: null, allergies: "えび" },
    ],
  },
  "mock-r2": { // 席だけ予約 (メニュー無し) → KDS 予約ストックには出ないのが正
    id: "mock-r2", status: "booked", start_at: today(19, 0),
    customer_name: "比嘉", pax: 4, memo: null, courses: [],
  },
  "mock-r3": { // 事前メニューが memo 自由テキストの場合 (構造化フィールド無し)
    id: "mock-r3", status: "booked", start_at: today(19, 30),
    customer_name: "金城", pax: 3,
    memo: "山城牛の焼きすき土鍋御膳 x2\n島豆腐の厚揚げ 1個",
  },
};

function listSyncEvents() {
  tick++;
  if (tick === 1) return [ev("created", "mock-r1"), ev("created", "mock-r2")];
  if (tick === 2) return [ev("created", "mock-r3")];
  if (tick === 3) { DB["mock-r1"].adults = 3; return [ev("updated", "mock-r1")]; }
  if (tick === 5) { DB["mock-r3"].status = "canceled"; return [ev("updated", "mock-r3")]; }
  return [];
}

function getReservation(id) {
  return DB[id] ? JSON.parse(JSON.stringify(DB[id])) : null; // 404 相当は null
}

function ev(type, id) {
  return { id: "ev-" + tick + "-" + id, event_type: type, syncable_type: "reservation", syncable_id: id, created_at: new Date().toISOString() };
}

module.exports = { listSyncEvents: listSyncEvents, getReservation: getReservation };
