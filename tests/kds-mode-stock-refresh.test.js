"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "kds-a-grid.html"), "utf8");
function source(name) {
  const start = html.indexOf("    function " + name + "(");
  assert.notEqual(start, -1);
  const end = html.indexOf("\n    }", start);
  return html.slice(start, end + 6);
}

// #262: モード切替で炊飯準備cueの確認ボタンの表示が更新されない
function run(next) {
  const calls = [];
  const context = vm.createContext({
    mode: "kitchen", grab: null, seatDialContext: null,
    LS_MODE: "kds_mode",
    lsSet() { calls.push("lsSet"); },
    cancelReorder() {}, closeTableOverrideConfirm() {}, closeSeatDial() {},
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
