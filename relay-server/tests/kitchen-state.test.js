"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var kitchen = require("../kitchen-state");

var NOW = Date.parse("2026-08-02T18:05:00+09:00");

function seeded() {
  var state = kitchen.createState("s1");
  kitchen.applyEvents(state, [
    { type: "konro", id: "o-1", num: 1, state: "white" },
    { type: "konro", id: "o-1", num: 3, state: "red" },
    { type: "toggle", id: "o-1", index: 1, doneCount: 2 },
    { type: "timerLock", id: "o-1", locked: true },
    { type: "order", seq: ["o-1", "o-2"] },
  ], NOW);
  return state;
}

test("KDSのBroadcastChannelイベントをそのまま畳み込める", function () {
  var state = seeded();
  assert.deepEqual(state.konro, { "o-1": { "1": "white", "3": "red" } });
  // 歯抜けの配列は JSON 化で null になる。取り込み側の normalizeDoneCount() が 0 として吸収する
  assert.deepEqual(JSON.parse(JSON.stringify(state.done)), { "o-1": [null, 2] });
  assert.deepEqual(state.locked, { "o-1": true });
  assert.deepEqual(state.seq, ["o-1", "o-2"]);
  assert.equal(state.rev, 1);
});

test("コンロは skeleton で解除され、空になったカードはキーごと消える", function () {
  var state = seeded();
  kitchen.applyEvents(state, [{ type: "konro", id: "o-1", num: 1, state: "skeleton" }], NOW);
  assert.deepEqual(state.konro, { "o-1": { "3": "red" } });
  kitchen.applyEvents(state, [{ type: "konro", id: "o-1", num: 3, state: "skeleton" }], NOW);
  assert.deepEqual(state.konro, {});
});

test("タイマーロック解除とカード削除は関連状態も片づける", function () {
  var state = seeded();
  kitchen.applyEvents(state, [{ type: "timerLock", id: "o-1", locked: false }], NOW);
  assert.deepEqual(state.locked, {});

  kitchen.applyEvents(state, [{ type: "deleteOrder", id: "o-1" }], NOW);
  assert.deepEqual(state.deleted, { "o-1": true });
  assert.deepEqual(state.konro, {});
  assert.deepEqual(state.done, {});
  assert.deepEqual(state.seq, ["o-2"]);
});

test("同じイベントを何度適用しても結果が変わらない (再送・複数タブ対策)", function () {
  var a = seeded();
  var b = seeded();
  kitchen.applyEvents(b, [
    { type: "konro", id: "o-1", num: 1, state: "white" },
    { type: "toggle", id: "o-1", index: 1, doneCount: 2 },
    { type: "order", seq: ["o-1", "o-2"] },
  ], NOW);
  assert.deepEqual(kitchen.snapshot(b).konro, kitchen.snapshot(a).konro);
  assert.deepEqual(kitchen.snapshot(b).done, kitchen.snapshot(a).done);
  assert.deepEqual(kitchen.snapshot(b).seq, kitchen.snapshot(a).seq);
});

test("並び順は重複を畳み、不正な要素は受理しない", function () {
  var state = kitchen.createState("s1");
  kitchen.applyEvents(state, [{ type: "order", seq: ["a", "b", "a"] }], NOW);
  assert.deepEqual(state.seq, ["a", "b"]);
  assert.match(kitchen.applyEvents(state, [{ type: "order", seq: ["a", ""] }], NOW).error, /order\.seq\[1\]/);
});

test("送信側のバグは黙って飲み込まず400相当のエラーにする", function () {
  var state = kitchen.createState("s1");
  assert.match(kitchen.applyEvents(state, [{ type: "konro", id: "o-1", num: 0, state: "white" }], NOW).error, /konro\.num/);
  assert.match(kitchen.applyEvents(state, [{ type: "konro", id: "", num: 1, state: "white" }], NOW).error, /konro\.id/);
  assert.match(kitchen.applyEvents(state, [{ type: "toggle", id: "o-1", index: -1, doneCount: 0 }], NOW).error, /toggle\.index/);
  assert.match(kitchen.applyEvents(state, [{ type: "toggle", id: "o-1", index: 0, doneCount: 1.5 }], NOW).error, /toggle\.doneCount/);
  assert.match(kitchen.applyEvents(state, "konro", NOW).error, /events must be an array/);
  assert.match(kitchen.applyEvents(state, [], NOW).error, /events must not be empty/);
  assert.equal(state.rev, 0, "エラー時に rev を進めない");
});

test("誤りが1件でも混ざった一束は丸ごと受け付けず、状態もrevも変えない (#297)", function () {
  var state = seeded();
  var before = JSON.stringify(kitchen.snapshot(state));
  var result = kitchen.applyEvents(state, [
    { type: "konro", id: "o-2", num: 2, state: "white" },
    { type: "deleteOrder", id: "o-1" },
    { type: "tableOverride", id: "o-2", table: "12", removed: false },
    { type: "toggle", id: "o-2", index: 0, doneCount: 1.5 },
  ], NOW + 1000);
  // 誤りのあるイベントの番号を返す。それより前のイベントも畳み込まない
  assert.match(result.error, /^events\[3\]: toggle\.doneCount/);
  assert.equal(JSON.stringify(kitchen.snapshot(state)), before);
  assert.equal(state.rev, 1);
  assert.equal(state.updatedAt, NOW);

  // 誤りの無い一束は今までどおり受け付ける (未知の type は数えずに無視する)
  var accepted = kitchen.applyEvents(state, [
    { type: "konro", id: "o-2", num: 2, state: "white" },
    { type: "somethingNew", id: "o-2" },
    { type: "deleteOrder", id: "o-1" },
  ], NOW + 1000);
  assert.equal(accepted.applied, 2);
  assert.equal(state.rev, 2);
  assert.deepEqual(state.konro, { "o-2": { "2": "white" } });
  assert.deepEqual(state.deleted, { "o-1": true });
});

test("未知のtypeは受理して無視する (KDS側の拡張を止めない)", function () {
  var state = kitchen.createState("s1");
  var result = kitchen.applyEvents(state, [{ type: "somethingNew", id: "o-1" }], NOW);
  assert.equal(result.ok, true);
  assert.equal(state.rev, 0, "無視しただけなら rev は進めない");
});

test("最終更新からTTLを過ぎたら当日分を捨て、revは進める", function () {
  var state = seeded();
  assert.equal(kitchen.purgeStale(state, NOW + 60000, 3600000), false);

  assert.equal(kitchen.purgeStale(state, NOW + 7200000, 3600000), true);
  assert.deepEqual(state.konro, {});
  assert.deepEqual(state.seq, []);
  // rev を戻すと端末側が「取込済み」と誤認して空状態を取り込まないため、進める
  assert.equal(state.rev, 2);
});

function readySnapshot(over) {
  return Object.assign({
    orderId: "o-1", id: "o-1", table: 5, people: 3, completedAt: NOW, day: "2026-08-02", status: "active",
    items: [{ name: "土鍋御膳", qty: 2, note: "" }],
  }, over);
}

test("前菜/デザートと提供準備完了も畳み込み、KDSが使う項目だけを残す (#288)", function () {
  var state = kitchen.createState("s1");
  kitchen.applyEvents(state, [
    { type: "serveCue", id: "o-1", state: { starter: true, dessert: false, starterAt: NOW, day: "2026-08-02", extra: "x" } },
    { type: "hallReady", id: "o-1", snapshot: readySnapshot({ extra: "x" }) },
  ], NOW);
  var snap = kitchen.snapshot(state);
  assert.deepEqual(snap.serveCue, {
    "o-1": { starter: true, dessert: false, starterAt: NOW, dessertAt: null, day: "2026-08-02" },
  });
  assert.deepEqual(snap.hallReady, { "o-1": {
    orderId: "o-1", id: "o-1", table: "5", people: 3, completedAt: NOW, day: "2026-08-02", status: "active",
    items: [{ name: "土鍋御膳", qty: 2, note: "" }],
  } });
  assert.equal(snap.rev, 1);
});

test("提供準備完了は、取り下げより前の完了が遅れて届いても戻さない (#288)", function () {
  var state = kitchen.createState("s1");
  kitchen.applyEvents(state, [{ type: "hallReady", id: "o-1",
    snapshot: readySnapshot({ status: "retracted", retractedAt: NOW + 10 }) }], NOW);
  var result = kitchen.applyEvents(state, [{ type: "hallReady", id: "o-1", snapshot: readySnapshot() }], NOW);
  assert.equal(result.applied, 0);
  assert.equal(state.hallReady["o-1"].status, "retracted");

  // 取り下げの後にもう一度全品完了したものは受け取る
  kitchen.applyEvents(state, [{ type: "hallReady", id: "o-1", snapshot: readySnapshot({ completedAt: NOW + 20 }) }], NOW);
  assert.equal(state.hallReady["o-1"].status, "active");
});

test("前菜/デザートと提供準備完了の不正な形は受理しない (#288)", function () {
  var state = kitchen.createState("s1");
  assert.match(kitchen.applyEvents(state, [{ type: "serveCue", id: "", state: {} }], NOW).error, /serveCue\.id/);
  assert.match(kitchen.applyEvents(state, [{ type: "serveCue", id: "o-1", state: [] }], NOW).error, /serveCue\.state/);
  assert.match(kitchen.applyEvents(state, [{ type: "hallReady", id: "o-1", snapshot: readySnapshot({ status: "done" }) }], NOW).error,
    /hallReady\.snapshot/);
  assert.match(kitchen.applyEvents(state, [{ type: "hallReady", id: "o-1", snapshot: readySnapshot({ items: "x" }) }], NOW).error,
    /hallReady\.snapshot/);
  assert.equal(state.rev, 0);
});

test("カード削除とTTL切れでは前菜/デザートと提供準備完了も片づける (#288)", function () {
  var state = seeded();
  kitchen.applyEvents(state, [
    { type: "serveCue", id: "o-1", state: { starter: true } },
    { type: "hallReady", id: "o-1", snapshot: readySnapshot() },
    { type: "serveCue", id: "o-2", state: { dessert: true } },
  ], NOW);
  kitchen.applyEvents(state, [{ type: "deleteOrder", id: "o-1" }], NOW);
  assert.deepEqual(Object.keys(state.serveCue), ["o-2"]);
  assert.deepEqual(state.hallReady, {});

  kitchen.purgeStale(state, NOW + 7200000, 3600000);
  assert.deepEqual(state.serveCue, {});
});

test("卓番の上書きを畳み込み、removed か空の卓番で解除する (#293)", function () {
  var state = kitchen.createState("s1");
  kitchen.applyEvents(state, [
    { type: "tableOverride", id: "o-1", table: " 12 ", removed: false },
    { type: "tableOverride", id: "o-2", table: 7, removed: false },
    { type: "tableOverride", id: "o-3", table: "A1", removed: false },
  ], NOW);
  // KDS の受信と同じく文字列にそろえる (前後の空白は KDS の保存時と同じく落とす)
  assert.deepEqual(kitchen.snapshot(state).tableOverride, { "o-1": "12", "o-2": "7", "o-3": "A1" });

  // KDS の broadcastTableOverride は解除を { table:null, removed:true } で送る
  kitchen.applyEvents(state, [
    { type: "tableOverride", id: "o-1", table: null, removed: true },
    { type: "tableOverride", id: "o-2", table: "  ", removed: false },
    { type: "tableOverride", id: "o-3", table: "B2", removed: true },
  ], NOW);
  assert.deepEqual(state.tableOverride, {});
  assert.equal(state.rev, 2);
});

test("卓番の上書きの不正な形は受理しない (#293)", function () {
  var state = kitchen.createState("s1");
  assert.match(kitchen.applyEvents(state, [{ type: "tableOverride", id: "", table: "12" }], NOW).error, /tableOverride\.id/);
  assert.match(kitchen.applyEvents(state, [{ type: "tableOverride", id: "o-1", table: { n: 12 } }], NOW).error,
    /tableOverride\.table/);
  assert.match(kitchen.applyEvents(state, [{ type: "tableOverride", id: "o-1", table: ["12"] }], NOW).error,
    /tableOverride\.table/);
  // 切ると別の卓番になるので、長すぎるものは切らずに受理しない
  assert.match(kitchen.applyEvents(state, [{ type: "tableOverride", id: "o-1", table: "1".repeat(33) }], NOW).error,
    /tableOverride\.table/);
  assert.equal(state.rev, 0);
  assert.deepEqual(state.tableOverride, {});
});

test("カード削除とTTL切れでは卓番の上書きも片づける (#293)", function () {
  var state = seeded();
  kitchen.applyEvents(state, [
    { type: "tableOverride", id: "o-1", table: "12", removed: false },
    { type: "tableOverride", id: "o-2", table: "13", removed: false },
  ], NOW);
  kitchen.applyEvents(state, [{ type: "deleteOrder", id: "o-1" }], NOW);
  assert.deepEqual(state.tableOverride, { "o-2": "13" });

  kitchen.purgeStale(state, NOW + 7200000, 3600000);
  assert.deepEqual(state.tableOverride, {});
});

test("スナップショットはrelayの起動識別子を含む (再起動の検出用)", function () {
  var snap = kitchen.snapshot(seeded());
  assert.equal(snap.sessionId, "s1");
  assert.equal(snap.rev, 1);
  assert.equal(snap.updatedAt, NOW);
});
