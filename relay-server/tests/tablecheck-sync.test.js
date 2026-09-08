/**
 * tablecheck-sync.test.js — node relay-server/tests/tablecheck-sync.test.js で実行
 */
"use strict";
var s = require("../tablecheck-sync");
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
eq("アレルギー設問/自由記述→安全情報", recReal.allergies, "えび");
eq("アレルギーだけの自由記述は要望へ重複しない", recReal.request, undefined);
var recNotes = s.normalizeReservation({
  id: "tc-notes", status: "confirmed", start_at: "2026-07-15T18:30:00+0900",
  questions: [
    { id: "q-allergy", question: "アレルギーはありますか？", answer: "卵・乳" },
    { id: "q-request", question: "その他の要望", answer: "子供用椅子" },
  ],
  special_request: "窓側希望",
});
eq("questionsと要望の振り分け", [recNotes.allergies, recNotes.request], ["卵・乳", "その他の要望: 子供用椅子 / 窓側希望"]);
var recNoAllergy = s.normalizeReservation({
  id: "tc-no-allergy", status: "confirmed", start_at: "2026-07-15T18:30:00+0900",
  questions: [{ question: "アレルギーはありますか？", answer: "なし" }],
  special_request: "アレルギーなし",
});
eq("アレルギーなしは安全情報に載せない", [recNoAllergy.allergies, recNoAllergy.request], [undefined, undefined]);
eq("seat_types既定値", recReal.seatTypes, []);
var recSeat = s.normalizeReservation({ id: "tc-seat", status: "confirmed", start_at: "2026-07-15T18:30:00+0900", table_number: " 5 ", seat_types: ["table", "counter"] });
eq("確定卓番候補を保持", recSeat.table, "5");
eq("seat_typesを保持", recSeat.seatTypes, ["table", "counter"]);
eq("confirmedはアクティブ扱い(booked)", recReal.status, "booked");

console.log("normalizeStatus(確定enum)");
eq("cancelled(英綴り)検知", s.normalizeStatus("cancelled"), "canceled");
eq("noshow検知", s.normalizeStatus("noshow"), "no_show");

console.log("normalizeStatus");
eq("canceled検知", s.normalizeStatus("Cancelled_by_user"), "canceled");
eq("no_show検知", s.normalizeStatus("no-show"), "no_show");
eq("既定はbooked", s.normalizeStatus("something"), "booked");
eq("未知のseat系statusは安全側のbooked", s.normalizeStatus("seating_soon"), "booked");
eq("未知のarrival系statusは安全側のbooked", s.normalizeStatus("arrival_pending"), "booked");

console.log("normalizeStatus(確定enum 11値 → KDS挙動 / Issue #117)");
// 載る (内部status=booked / ACTIVE_STATUSES)
["accepted", "confirmed", "attended"].forEach(function (st) {
  eq(st + " → booked(棚に載る)", s.normalizeStatus(st), "booked");
});
// 外す (キャンセル・拒否・ノーショー)
eq("cancelled → canceled(外す)", s.normalizeStatus("cancelled"), "canceled");
eq("rejected → canceled(外す) ★取りこぼし修正", s.normalizeStatus("rejected"), "canceled");
eq("noshow → no_show(外す)", s.normalizeStatus("noshow"), "no_show");
// 外す (確定前は暫定デフォルトで出さない)
["tentative", "pending", "request", "iou_prepay", "iou_auth"].forEach(function (st) {
  eq(st + " → unconfirmed(外す)", s.normalizeStatus(st), "unconfirmed");
});
// ACTIVE_STATUSES は booked のみ (normalizeStatus の出力値と整合)
eq("ACTIVE_STATUSESはbookedのみ", s.ACTIVE_STATUSES, ["booked"]);

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

store.set("notes", { rid: "notes", startAt: iso(18, 10), adults: 2, kids: 0, name: "注記あり",
  status: "booked", allergies: "卵・乳", request: "子供用椅子", memo: "窓側希望",
  menu: [{ name: "御膳", qty: 1, options: null, allergies: null }] });
stock = s.toKdsStock(store, 789);
var noteStock = stock.find(function (r) { return r.rid === "notes"; });
eq("KDS stockへアレルギー/要望を配信", [noteStock.allergies, noteStock.request, noteStock.memo], ["卵・乳", "子供用椅子", "窓側希望"]);

console.log("purge: 確定enum status で棚に載る/外す (Issue #117)");
var store2 = new Map();
function put(rid, rawStatus) {
  store2.set(rid, { rid: rid, startAt: iso(18, 30), adults: 2, kids: 0, name: rid,
    status: s.normalizeStatus(rawStatus), menu: [{ name: "御膳", qty: 1, options: null, allergies: null }] });
}
put("rej", "rejected");      // ★取りこぼし: 従来はbooked扱いで残っていた
put("iou", "iou_prepay");    // 確定前: 暫定で外す
put("cfm", "confirmed");     // 確定: 残る
put("att", "attended");      // 来店済(暫定booked): 残る
put("unknown-seat", "seating_soon"); // 未知値は安全側で棚に残す
s.purge(store2, now);
eq("rejectedはpurgeで除去", store2.has("rej"), false);
eq("iou_prepayはpurgeで除去", store2.has("iou"), false);
eq("confirmedは残る", store2.has("cfm"), true);
eq("attendedは残る(暫定)", store2.has("att"), true);
eq("未知のseat系statusはpurgeで残る", store2.has("unknown-seat"), true);

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
