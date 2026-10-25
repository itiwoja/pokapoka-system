"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { functionSource: source } = require("./helpers/kds-source");

// #262: モード切替で炊飯準備cueの確認ボタンの表示が更新されない
function run(next) {
  const calls = [];
  const context = vm.createContext({
    mode: "kitchen", grab: null, seatDialContext: null,
    LS_MODE: "kds_mode",
    lsSet() { calls.push("lsSet"); },
    cancelReorder() {}, closeTableOverrideConfirm() {}, closeSeatDial() {},
    hideUndoToast() {}, hideHallReadyUndo() {},   // #261: setMode が呼ぶ
    hideStarterUndo() {},   // #295: setMode が呼ぶ
    applyMode() { calls.push("applyMode"); },
    renderStock() { calls.push("renderStock:" + context.mode); }
  });
  vm.runInContext(source("setMode"), context);
  context.setMode(next);
  return calls;
}

test("setModeはモード確定後に予約ストックを再描画する(ホール)", function () {
  const calls = run("hall");
  assert.ok(calls.includes("renderStock:hall"));
  assert.ok(calls.indexOf("renderStock:hall") > calls.indexOf("applyMode"));
});

test("setModeはモード確定後に予約ストックを再描画する(厨房)", function () {
  assert.ok(run("kitchen").includes("renderStock:kitchen"));
});
