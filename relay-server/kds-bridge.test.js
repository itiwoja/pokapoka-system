/**
 * kds-bridge.test.js — node --test relay-server/kds-bridge.test.js で実行
 *
 * mergeStock() のマージ・削除判定 (Issue #129):
 *   由来判定は rid の形式 (接頭辞/長さ) ではなく「ブリッジが取り込んだ実績 (seen)」で行う。
 */
"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var mergeStock = require("./kds-bridge").mergeStock;

function rec(rid, over) {
  var r = { rid: rid, time: "18:30", adults: 2, kids: 0, name: "テスト", menu: [{ name: "土鍋御膳", qty: 2 }], seenAt: 100 };
  Object.keys(over || {}).forEach(function (k) { r[k] = over[k]; });
  return r;
}

test("新規のサーバー予約を取り込み、seen に記録する", function () {
  var seen = {};
  var out = mergeStock([], seen, [rec("abc123")]);
  assert.equal(out.changed, true);
  assert.deepEqual(out.stock.map(function (r) { return r.rid; }), ["abc123"]);
  assert.equal(seen["abc123"], 1);
});

test("取込済み(seen)の予約がサーバーから消えたら削除する (キャンセル反映)", function () {
  var out = mergeStock([rec("mock-1")], { "mock-1": 1 }, []);
  assert.equal(out.changed, true);
  assert.deepEqual(out.stock, []);
});

test("tc- 無し・12文字未満の生IDでも取込済みなら削除される (Issue #129 本題)", function () {
  // 旧実装は isServerRid("abc123") が false のため削除されず、キャンセル予約が残り続けた
  var out = mergeStock([rec("abc123")], { "abc123": 1 }, []);
  assert.equal(out.changed, true);
  assert.deepEqual(out.stock, []);
});

test("手動追加の予約 (12文字以上のrid) はサーバーに無くても削除しない", function () {
  // 旧実装は length >= 12 で server 由来と誤判定し、手動予約を次 tick で消していた
  var manual = rec("r1752745600000_123");
  var out = mergeStock([manual], {}, []);
  assert.equal(out.changed, false);
  assert.deepEqual(out.stock, [manual]);
});

test("手動追加とサーバー予約が混在時、消えたサーバー予約だけ削除する", function () {
  var manual = rec("r1752745600000_123", { time: "19:00" });
  var out = mergeStock([manual, rec("mock-1"), rec("mock-2")], { "mock-1": 1, "mock-2": 1 },
    [rec("mock-2")]);
  assert.equal(out.changed, true);
  assert.deepEqual(out.stock.map(function (r) { return r.rid; }), ["mock-2", "r1752745600000_123"]);
});

test("着手済み (seen にあるが stock に無い) 予約はサーバーに居ても復活しない", function () {
  var out = mergeStock([], { "mock-1": 1 }, [rec("mock-1")]);
  assert.equal(out.changed, false);
  assert.deepEqual(out.stock, []);
});

test("内容更新の上書き時も seenAt (取込時刻) は維持する (30分前通知の再発火防止)", function () {
  var out = mergeStock([rec("mock-1", { seenAt: 100 })], { "mock-1": 1 },
    [rec("mock-1", { adults: 4, seenAt: 999 })]);
  assert.equal(out.changed, true);
  assert.equal(out.stock[0].adults, 4);
  assert.equal(out.stock[0].seenAt, 100);
});

test("内容が同じなら changed = false (無駄な書換・配信をしない)", function () {
  var out = mergeStock([rec("mock-1")], { "mock-1": 1 }, [rec("mock-1")]);
  assert.equal(out.changed, false);
});

test("結果は time 昇順に整列される", function () {
  var seen = {};
  var out = mergeStock([], seen, [rec("b", { time: "19:30" }), rec("a", { time: "18:00" })]);
  assert.deepEqual(out.stock.map(function (r) { return r.time; }), ["18:00", "19:30"]);
});
