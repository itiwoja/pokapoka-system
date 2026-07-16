/**
 * tablecheck-sync.test.js — node relay-server/tablecheck-sync.test.js で実行
 */
"use strict";
var s = require("./tablecheck-sync");
var pass = 0, fail = 0;
function eq(name, got, want) {
  var g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log("  ok: " + name); }
  else { fail++; console.error("  NG: " + name + "\n    got:  " + g + "\n    want: " + w); }
}

console.log("normalizeReservation");
var rec = s.normalizeReservation({
  id: "r1", status: "Booked", start_at: "2026-07-15T18:30:00+0900",
  customer_name: "山田", adults: 2, kids: 1,
  courses: [{ name: "土鍋御膳", qty: 2, options: "大盛り", allergies: "えび" }],
});
eq("rid", rec.rid, "r1");
eq("adults/kids", [rec.adults, rec.kids], [2, 1]);
eq("menu構造化", rec.menu, [{ name: "土鍋御膳", qty: 2, options: "大盛り", allergies: "えび" }]);

var recPax = s.normalizeReservation({ id: "r2", start_at: "2026-07-15T19:00:00+0900", pax: 4, status: "booked" });
eq("内訳なし→paxをadultsへ", [recPax.adults, recPax.kids], [4, 0]);

eq("start_at無しはnull", s.normalizeReservation({ id: "r3" }), null);

// --- 確定スキーマ(2026-07-16 実機確認)での正規化 ---
var recReal = s.normalizeReservation({
  id: "tc-100", status: "confirmed", start_at: "2026-07-15T18:30:00+0900",
  last_name: "金城", first_name: "花子",
  pax: 3, pax_adult: 2, pax_child: 1,
  orders: [
    { id: "o1", menu_item_name_translations: { en: "Nabe Gozen", ja: "土鍋御膳" }, qty: 2, price: 3800 },
    { id: "o2", menu_item_name_translations: { en: "Agedashi" }, qty: 1 },
  ],
  special_request: "アレルギー: えび",
});
eq("pax_adult/pax_child", [recReal.adults, recReal.kids], [2, 1]);
eq("first+last→name", recReal.name, "金城 花子");
eq("orders→menu(ja優先/en fallback)", recReal.menu,
  [{ name: "土鍋御膳", qty: 2, options: null, allergies: null },
   { name: "Agedashi", qty: 1, options: null, allergies: null }]);
eq("special_request→memo", recReal.memo, "アレルギー: えび");
eq("confirmedはアクティブ扱い(booked)", recReal.status, "booked");

console.log("normalizeStatus(確定enum)");
eq("cancelled(英綴り)検知", s.normalizeStatus("cancelled"), "canceled");
eq("noshow検知", s.normalizeStatus("noshow"), "no_show");

console.log("normalizeStatus");
eq("canceled検知", s.normalizeStatus("Cancelled_by_user"), "canceled");
eq("no_show検知", s.normalizeStatus("no-show"), "no_show");
eq("既定はbooked", s.normalizeStatus("something"), "booked");

console.log("parseMenuFromMemo");
eq("x区切り", s.parseMenuFromMemo("土鍋御膳 x2"), [{ name: "土鍋御膳", qty: 2, options: null, allergies: null }]);
eq("×と個", s.parseMenuFromMemo("御膳×3\n厚揚げ 1個"),
  [{ name: "御膳", qty: 3, options: null, allergies: null }, { name: "厚揚げ", qty: 1, options: null, allergies: null }]);
eq("空memo", s.parseMenuFromMemo(""), []);

console.log("applyFetched / purge / toKdsStock");
var store = new Map();
var now = new Date();
function iso(h, m) { var d = new Date(now); d.setHours(h, m, 0, 0); return d.toISOString(); }
s.applyFetched(store, [
  { rid: "a", record: { rid: "a", startAt: iso(18, 30), adults: 2, kids: 0, name: "A", status: "booked", menu: [{ name: "御膳", qty: 1, options: null, allergies: null }] } },
  { rid: "b", record: { rid: "b", startAt: iso(19, 0), adults: 4, kids: 0, name: "B", status: "booked", menu: [] } }, // 席だけ予約
  { rid: "c", record: { rid: "c", startAt: iso(20, 0), adults: 2, kids: 0, name: "C", status: "canceled", menu: [{ name: "御膳", qty: 1, options: null, allergies: null }] } },
]);
eq("upsertで3件", store.size, 3);
s.applyFetched(store, [{ rid: "a", record: null }]);           // 404 = 削除
eq("404削除で2件", store.size, 2);
s.purge(store, now);
eq("purgeでcanceled除去", store.size, 1);                       // b のみ残る
var stock = s.toKdsStock(store, 123);
eq("席だけ予約はKDSに出ない", stock.length, 0);

store.set("d", { rid: "d", startAt: iso(18, 0), adults: 1, kids: 2, name: "D", status: "booked", menu: [{ name: "御膳", qty: 2, options: null, allergies: "乳" }] });
stock = s.toKdsStock(store, 456);
eq("KDS stock形式", stock[0], { rid: "d", time: "18:00", adults: 1, kids: 2, name: "D", menu: [{ name: "御膳", qty: 2, options: null, allergies: "乳" }], seenAt: 456 });

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
