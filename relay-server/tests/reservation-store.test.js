"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
var store = require("../reservation-store");

// 2026-10-11 12:00 (サーバーのローカル時刻) を「今」とする
var NOW = new Date(2026, 9, 11, 12, 0, 0);

function at(day, hours, minutes) {
  return new Date(2026, 9, day, hours, minutes || 0).toISOString();
}

function open(t, filename, now) {
  var current = { value: now || NOW };
  var s = store.openReservationStore(filename || ":memory:", { now: function () { return current.value; } });
  t.after(function () { s.close(); });
  return { store: s, setNow: function (d) { current.value = d; } };
}

test("保存した予約を正規化して読み出し、同じridは上書きする", function (t) {
  var s = open(t).store;
  var saved = s.save({
    rid: " r1 ", startAt: at(11, 18, 30), name: " 山田 ", adults: 2, seniors: 1, children: 2, kids: 1, table: "5",
    menu: [{ name: "土鍋御膳", qty: 2, options: "大盛り", allergies: "えび" }, { name: "茶" }],
    allergies: "卵", request: "窓側", memo: "誕生日",
  });
  assert.equal(saved.rid, "r1");
  assert.equal(saved.name, "山田");
  assert.equal(saved.status, "booked");
  assert.deepEqual([saved.adults, saved.seniors, saved.children, saved.kids], [2, 1, 2, 1], "人数の内訳はまとめない");
  assert.deepEqual(saved.menu, [
    { name: "土鍋御膳", qty: 2, options: "大盛り", allergies: "えび" },
    { name: "茶", qty: 1, options: null, allergies: null },
  ]);
  assert.equal(saved.allergies, "卵");

  var updated = s.save({ rid: "r1", startAt: at(11, 19, 0), adults: 3, menu: [{ name: "土鍋御膳", qty: 3 }] });
  assert.equal(updated.adults, 3);
  assert.equal(updated.seniors, 0, "省略した内訳は0");
  assert.equal(updated.name, "(名前なし)");
  assert.equal(updated.allergies, undefined, "上書きは部分更新ではなく置き換え");
  assert.equal(s.health().reservations, 1);
});

test("ridを省略すると採番する", function (t) {
  var s = open(t).store;
  var saved = s.save({ startAt: at(11, 18), menu: [{ name: "茶" }] });
  assert.match(saved.rid, /^[0-9a-f-]{36}$/);
});

test("不正な入力は理由を示して弾き、保存しない", function (t) {
  var s = open(t).store;
  var base = { rid: "r", startAt: at(11, 18) };
  [
    [null, /オブジェクト/],
    [{ rid: "r" }, /startAt/],
    [Object.assign({}, base, { startAt: "not a date" }), /startAt/],
    [Object.assign({}, base, { adults: -1 }), /adults/],
    [Object.assign({}, base, { seniors: -1 }), /seniors/],
    [Object.assign({}, base, { children: 1.5 }), /children/],
    [Object.assign({}, base, { kids: 1.5 }), /kids/],
    [Object.assign({}, base, { status: "confirmed" }), /status/],
    [Object.assign({}, base, { menu: "御膳" }), /menu/],
    [Object.assign({}, base, { menu: [{ qty: 1 }] }), /menu\[0\]\.name/],
    [Object.assign({}, base, { menu: [{ name: "茶", qty: 0 }] }), /menu\[0\]\.qty/],
    [Object.assign({}, base, { name: 123 }), /name/],
    [Object.assign({}, base, { memo: "x".repeat(501) }), /memo/],
    [Object.assign({}, base, { rid: "x".repeat(65) }), /rid/],
  ].forEach(function (c) {
    assert.throws(function () { s.save(c[0]); }, c[1]);
  });
  assert.equal(s.health().reservations, 0);
});

test("予約ストックは当日のbookedかつメニューありだけを時刻順に返す", function (t) {
  var s = open(t).store;
  s.save({ rid: "late", startAt: at(11, 19), menu: [{ name: "茶" }], request: "窓側" });
  s.save({ rid: "early", startAt: at(11, 17, 5), adults: 2, menu: [{ name: "御膳" }] });
  s.save({ rid: "seat-only", startAt: at(11, 18) });
  s.save({ rid: "canceled", startAt: at(11, 18), menu: [{ name: "茶" }] });
  s.cancel("canceled");
  s.save({ rid: "no-show", startAt: at(11, 18), status: "no_show", menu: [{ name: "茶" }] });
  s.save({ rid: "tomorrow", startAt: at(12, 18), menu: [{ name: "茶" }] });

  var stock = s.stock(1234);
  assert.deepEqual(stock.map(function (r) { return r.rid; }), ["early", "late"]);
  assert.deepEqual(stock[0], {
    rid: "early", time: "17:05", adults: 2, seniors: 0, children: 0, kids: 0, name: "(名前なし)",
    menu: [{ name: "御膳", qty: 1, options: null, allergies: null }], seenAt: 1234,
  });
  assert.equal(stock[1].request, "窓側");
  assert.deepEqual(Array.from(s.todaySnapshot().keys()).sort(),
    ["canceled", "early", "late", "no-show", "seat-only"], "座席占有の判定用に当日分はstatusを問わず返す");
});

test("取消は行を残してcanceledにし、未知のridはnull", function (t) {
  var s = open(t).store;
  s.save({ rid: "r1", startAt: at(11, 18), menu: [{ name: "茶" }] });
  assert.equal(s.cancel("r1").status, "canceled");
  assert.equal(s.get("r1").status, "canceled");
  assert.equal(s.cancel("missing"), null);
});

test("日付が変わると前日以前の予約を削除し、先の日付の予約は残す", function (t) {
  var opened = open(t);
  var s = opened.store;
  s.save({ rid: "today", startAt: at(11, 18), menu: [{ name: "茶" }] });
  s.save({ rid: "tomorrow", startAt: at(12, 18), menu: [{ name: "茶" }] });
  s.save({ rid: "next-week", startAt: at(18, 18), menu: [{ name: "茶" }] });

  opened.setNow(new Date(2026, 9, 12, 9, 0));
  assert.deepEqual(s.stock(0).map(function (r) { return r.rid; }), ["tomorrow"]);
  assert.equal(s.get("today"), null, "前日の予約は消える");
  assert.notEqual(s.get("next-week"), null);
});

test("ファイルに保存した予約は開き直しても残る", function (t) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "reservation-store-"));
  var file = path.join(dir, "nested", "reservations.sqlite");

  var first = store.openReservationStore(file, { now: function () { return NOW; } });
  first.save({ rid: "r1", startAt: at(11, 18), menu: [{ name: "茶" }] });
  first.close();

  var second = open(t, file).store;
  // t.after は登録順に動く。Windows は開いたままの SQLite を消せないため、閉じる処理より後に登録する
  t.after(function () { fs.rmSync(dir, { recursive: true, force: true }); });
  assert.equal(second.get("r1").rid, "r1");
  assert.equal(second.file, file);
});

test("人数の内訳を足す前に作ったファイルは、開いたときにシニア・子供の列を足し、既存の予約を残す", function (t) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "reservation-store-"));
  var file = path.join(dir, "reservations.sqlite");
  // 2026-10-22 より前の表 (seniors・children の列が無い)
  var DatabaseSync = require("node:sqlite").DatabaseSync;
  var old = new DatabaseSync(file);
  old.exec("CREATE TABLE reservations (rid TEXT PRIMARY KEY, start_at TEXT NOT NULL, start_ms INTEGER NOT NULL," +
    " adults INTEGER NOT NULL CHECK(adults >= 0), kids INTEGER NOT NULL CHECK(kids >= 0), name TEXT NOT NULL," +
    " status TEXT NOT NULL, table_no TEXT, menu TEXT NOT NULL, allergies TEXT, request TEXT, memo TEXT," +
    " updated_at TEXT NOT NULL) STRICT");
  old.prepare("INSERT INTO reservations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run("old", at(11, 18), Date.parse(at(11, 18)),
    2, 1, "山田", "booked", null, JSON.stringify([{ name: "茶", qty: 1 }]), null, null, null, NOW.toISOString());
  old.close();

  var s = open(t, file).store;
  t.after(function () { fs.rmSync(dir, { recursive: true, force: true }); });
  var rec = s.get("old");
  assert.deepEqual([rec.adults, rec.seniors, rec.children, rec.kids], [2, 0, 0, 1]);
  var saved = s.save({ rid: "new", startAt: at(11, 19), adults: 1, seniors: 1, children: 1, menu: [{ name: "茶" }] });
  assert.deepEqual([saved.seniors, saved.children], [1, 1]);
});
