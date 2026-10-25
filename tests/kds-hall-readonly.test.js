"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { functionSource: source } = require("./helpers/kds-source");

function harness(mode) {
  const calls = [];
  const item = { qty: 2, doneCount: 0, done: false };
  const context = vm.createContext({
    mode, view: "grid",
    doneMap: {},
    cards: { "1": { order: { id: 1, items: [item] }, el: { querySelectorAll() { return []; }, classList: { add() {} } } } },
    saveDone() { calls.push("save"); },
    broadcastToggle() { calls.push("broadcast"); },
    updateItemButtonDone() {},
    isAllDone() { return false; },
    renderLanes() { calls.push("lanes"); }
  });
  vm.runInContext(["onToggle", "onItemDecrement"].map(source).join("\n"), context);
  return { context, calls, item };
}

test("ホールモードでは onToggle が完了数を変更しない (キーボード・レーン経路)", () => {
  const { context, calls, item } = harness("hall");
  context.onToggle("1", 0);
  assert.equal(item.doneCount, 0);
  assert.deepEqual(calls, []);
  assert.deepEqual(context.doneMap, {});
});

test("ホールモードでは onItemDecrement が完了数を変更しない", () => {
  const { context, calls, item } = harness("hall");
  item.doneCount = 1;
  context.onItemDecrement("1", 0);
  assert.equal(item.doneCount, 1);
  assert.deepEqual(calls, []);
});

test("キッチンモードでは従来どおり完了数が増減する", () => {
  const { context, calls, item } = harness("kitchen");
  context.onToggle("1", 0);
  assert.equal(item.doneCount, 1);
  assert.ok(calls.includes("save") && calls.includes("broadcast"));
  context.onItemDecrement("1", 0);
  assert.equal(item.doneCount, 0);
});
