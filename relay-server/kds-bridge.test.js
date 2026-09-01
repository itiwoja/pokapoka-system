/**
 * kds-bridge.test.js — node --test relay-server/kds-bridge.test.js で実行
 *
 * mergeStock() のマージ・削除判定 (Issue #129):
 *   由来判定は rid の形式 (接頭辞/長さ) ではなく「ブリッジが取り込んだ実績 (seen)」で行う。
 */
"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var bridge = require("./kds-bridge");
var mergeStock = bridge.mergeStock;
var createKitchenQueue = bridge.createKitchenQueue;
var postKitchenBatch = bridge.postKitchenBatch;

function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

async function waitUntil(predicate, timeoutMs) {
  var deadline = Date.now() + (timeoutMs || 500);
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not met before timeout");
    await delay(5);
  }
}

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

/* ---- Issue #175: incoming に載った rid は新規取込以外でも seen へ記録する ---- */

test("stockにあるがseenに無い予約を上書きした場合も seen に記録する (Issue #175 本題)", function () {
  // 旧実装は「既存→上書き」分岐で seen[rid] を立てず、以後キャンセルされても消えなかった
  var seen = {};
  var out = mergeStock([rec("abc123")], seen, [rec("abc123", { adults: 4 })]);
  assert.equal(out.changed, true);
  assert.equal(seen["abc123"], 1);
  assert.equal(out.seenChanged, true);
});

test("上書きして seen に載った予約は、次tickでサーバーから消えたら削除される", function () {
  var seen = {};
  var first = mergeStock([rec("abc123")], seen, [rec("abc123", { adults: 4 })]);
  var second = mergeStock(first.stock, seen, []);   // キャンセル
  assert.equal(second.changed, true);
  assert.deepEqual(second.stock, []);
});

test("内容が同じでも stockにあってseenに無い予約は seen へ記録する", function () {
  // changed = false の tick でも取込実績は残す必要がある (seenChanged で保存を判断する)
  var seen = {};
  var out = mergeStock([rec("abc123")], seen, [rec("abc123")]);
  assert.equal(out.changed, false);
  assert.equal(out.seenChanged, true);
  assert.equal(seen["abc123"], 1);
});

test("seen に載せても手動追加の予約は保護される (incoming に無いものは記録しない)", function () {
  var manual = rec("r1752745600000_123");
  var seen = {};
  var out = mergeStock([manual, rec("mock-1")], seen, [rec("mock-1")]);
  assert.equal(seen["mock-1"], 1);
  assert.equal(seen["r1752745600000_123"], undefined);   // 手動分は seen に載らない
  var next = mergeStock(out.stock, seen, []);            // サーバーが空になっても
  assert.deepEqual(next.stock.map(function (r) { return r.rid; }), ["r1752745600000_123"]);
});

test("着手済み予約は seen 記録の変更が無く seenChanged = false (無駄な書換をしない)", function () {
  var seen = { "mock-1": 1 };
  var out = mergeStock([], seen, [rec("mock-1")]);
  assert.equal(out.changed, false);
  assert.equal(out.seenChanged, false);
  assert.deepEqual(out.stock, []);                      // 復活させない挙動は維持
});

/* ---- Issue #205: 厨房同期イベントの送信失敗・再送 ---- */

test("厨房イベントはネットワークエラー後もキューに残り、復旧後に再送される", async function () {
  var attempts = [];
  var queue = createKitchenQueue(async function (batch) {
    attempts.push(batch.slice());
    if (attempts.length === 1) throw new Error("offline");
  }, { flushMs: 1000, retryMs: 10 });
  var event = { type: "konro", id: "order-1", num: 0, state: "on" };

  queue.enqueue(event);
  await queue.flushNow();
  assert.deepEqual(queue.pending(), [event]);

  await waitUntil(function () { return attempts.length === 2 && !queue.isBusy(); });
  assert.deepEqual(attempts, [[event], [event]]);
  assert.deepEqual(queue.pending(), []);
});

test("失敗batchは送信中に追加された後続イベントより前に再キューされる", async function () {
  var rejectFirst;
  var attempts = [];
  var firstAttempt = new Promise(function (_, reject) { rejectFirst = reject; });
  var queue = createKitchenQueue(function (batch) {
    attempts.push(batch.slice());
    return attempts.length === 1 ? firstAttempt : Promise.resolve();
  }, { flushMs: 1000, retryMs: 10 });
  var first = { type: "toggle", id: "order-1", index: 0, doneCount: 1 };
  var later = { type: "toggle", id: "order-1", index: 0, doneCount: 2 };

  queue.enqueue(first);
  var flushing = queue.flushNow();
  queue.enqueue(later);
  rejectFirst(new Error("connection reset"));
  await flushing;
  assert.deepEqual(queue.pending(), [first, later]);

  await waitUntil(function () { return attempts.length === 2 && !queue.isBusy(); });
  assert.deepEqual(attempts[1], [first, later]);
});

test("厨房イベントPOSTはHTTPエラー応答を送信失敗として扱う", async function () {
  var jsonCalled = false;
  await assert.rejects(postKitchenBatch(async function () {
    return {
      ok: false,
      status: 503,
      json: async function () { jsonCalled = true; return {}; },
    };
  }, [{ type: "timerLock", id: "order-1", locked: true }]), /503/);
  assert.equal(jsonCalled, false);
});

test("HTTPエラー時は待機して再送し、通信断中に高速ループしない", async function () {
  var attempts = 0;
  var fetchStub = async function () {
    attempts += 1;
    if (attempts === 1) return { ok: false, status: 502, json: async function () { return {}; } };
    return { ok: true, status: 200, json: async function () { return { rev: 2 }; } };
  };
  var queue = createKitchenQueue(function (batch) {
    return postKitchenBatch(fetchStub, batch);
  }, { flushMs: 1000, retryMs: 30 });

  queue.enqueue({ type: "order", seq: ["order-1"] });
  await queue.flushNow();
  await delay(5);
  assert.equal(attempts, 1);

  await waitUntil(function () { return attempts === 2 && !queue.isBusy(); });
  assert.equal(attempts, 2);
});
