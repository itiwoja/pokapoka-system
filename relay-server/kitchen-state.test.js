"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var kitchen = require("./kitchen-state");

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

test("スナップショットはrelayの起動識別子を含む (再起動の検出用)", function () {
  var snap = kitchen.snapshot(seeded());
  assert.equal(snap.sessionId, "s1");
  assert.equal(snap.rev, 1);
  assert.equal(snap.updatedAt, NOW);
});
