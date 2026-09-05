"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "kds-a-grid.html"), "utf8");
// 単一HTML内の実装を実行し、別の参照実装とのずれを避ける。
function source(name) {
  const start = html.indexOf("    function " + name + "(");
  assert.notEqual(start, -1);
  const end = html.indexOf("\n    }", start);
  return html.slice(start, end + 6);
}

function harness() {
  const saved = {};
  const calls = [];
  const context = vm.createContext({
    konroMap: { "123": { 1: "red", 2: "white" }, other: { 1: "white", 3: "red" } },
    lockedTimers: { "123": true, other: true },
    deletedIds: {}, orderSeq: ["123", "other"],
    window: { KDS_ORDERS: [{ id: 123 }, { id: "other" }] },
    bc: null, BC_NAME: "test",
    BroadcastChannel: function () {},
    saveKonro() { saved.konro = JSON.parse(JSON.stringify(context.konroMap)); },
    saveLocked() { saved.locked = JSON.parse(JSON.stringify(context.lockedTimers)); },
    saveDeleted() {}, saveOrderSeq() {}, reflectEmpty() {},
    removeCard(id) { calls.push(["remove", id]); },
    refreshAllKonro() { calls.push(["refresh"]); },
    updateKonroHud() { calls.push(["hud"]); },
    broadcastDeleteOrder(id) { calls.push(["broadcast", id]); },
    broadcastOrderSeq() {}
  });
  vm.runInContext(["clearDeletedOrderTimers", "deleteOrder", "initSync"].map(source).join("\n"), context);
  return { context, saved, calls };
}

function assertReleased(h) {
  assert.equal(h.context.konroMap["123"], undefined);
  assert.equal(h.context.lockedTimers["123"], undefined);
  assert.deepEqual(h.saved.konro, { other: { 1: "white", 3: "red" } });
  assert.deepEqual(h.saved.locked, { other: true });
  assert.equal(h.context.deletedIds["123"], true);
  assert.equal(JSON.stringify(h.context.window.KDS_ORDERS), '[{"id":"other"}]');
  assert.equal(JSON.stringify(h.context.orderSeq), '["other"]');
  assert.ok(h.calls.some(c => c[0] === "refresh"));
  assert.ok(h.calls.some(c => c[0] === "hud"));
}

test("注文削除でタイマー・コンロ・停止状態を即時解放し、同番号の他卓資源は維持する", () => {
  const h = harness();
  h.context.deleteOrder(123);
  assertReleased(h);
  assert.ok(h.calls.some(c => c[0] === "broadcast"));
});

test("削除同期の受信でも資源を解放し、重複受信しても他卓に影響しない", () => {
  const h = harness();
  h.context.initSync();
  const event = { data: { type: "deleteOrder", id: "123" } };
  h.context.bc.onmessage(event);
  h.context.bc.onmessage(event);
  assertReleased(h);
  assert.equal(h.calls.some(c => c[0] === "broadcast"), false);
});

test("カードが既に存在しない削除でも保存されたタイマーを解放する", () => {
  const h = harness();
  h.context.removeCard = function () {};
  h.context.deleteOrder("123");
  assertReleased(h);
});
