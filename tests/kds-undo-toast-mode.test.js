"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "kds-a-grid.html"), "utf8");
function source(name) {
  const start = html.indexOf("    function " + name + "(");
  assert.notEqual(start, -1, name);
  const end = html.indexOf("\n    }", start);
  return html.slice(start, end + 6);
}

function el() {
  const set = new Set();
  return { textContent: "", classList: { add: c => set.add(c), remove: c => set.delete(c), has: c => set.has(c) } };
}

// #261: 厨房の完了undoと提供準備完了undoのトーストはモード切替で重ならず、
// ホールでは厨房の完了undoを実行しない。
function harness(mode) {
  const calls = [];
  const context = vm.createContext({
    mode, undoInfo: { id: "o1", index: 0 }, undoTimer: null,
    hallReadyUndoId: "o1", hallReadyUndoTimer: null,
    hallReadyMap: { o1: { status: "dismissed" } },
    undoToastEl: el(), hallReadyUndoToastEl: el(),
    doneMap: { o1: [1] }, grab: null, seatDialContext: "",
    LS_MODE: "mode", setTimeout, clearTimeout,
    saveDone() { calls.push("saveDone"); },
    broadcastToggle() { calls.push("broadcastToggle"); },
    poll() { calls.push("poll"); },
    saveHallReady() { calls.push("saveHallReady"); },
    broadcastHallReady() { calls.push("broadcastHallReady"); },
    renderHallViews() {}, applyMode() {}, cancelReorder() {},
    renderStock() {},   // #262: setMode が呼ぶ
    serveCueState() { return { starter: false, dessert: false }; }, setServeCue() {},   // #260: undoHallReady が呼ぶ
    closeTableOverrideConfirm() {}, closeSeatDial() {}, lsSet() {}
  });
  vm.runInContext(["hideUndoToast", "undoComplete", "hideHallReadyUndo", "undoHallReady", "setMode"].map(source).join("\n"), context);
  context.undoToastEl.classList.add("show");
  context.hallReadyUndoToastEl.classList.add("show");
  return { context, calls };
}

test("ホールへ切り替えると厨房の完了undoトーストを閉じる", () => {
  const h = harness("kitchen");
  h.context.setMode("hall");
  assert.equal(h.context.undoToastEl.classList.has("show"), false);
  assert.equal(h.context.undoInfo, null);
  assert.equal(h.context.hallReadyUndoToastEl.classList.has("show"), true);
});

test("厨房へ切り替えるとホールの提供準備完了undoトーストを閉じる", () => {
  const h = harness("hall");
  h.context.setMode("kitchen");
  assert.equal(h.context.hallReadyUndoToastEl.classList.has("show"), false);
  assert.equal(h.context.hallReadyUndoId, null);
  assert.equal(h.context.undoToastEl.classList.has("show"), true);
});

test("ホールでは厨房の完了undoを実行しない", () => {
  const h = harness("hall");
  h.context.undoComplete();
  assert.equal(h.context.doneMap.o1[0], 1);
  assert.ok(!h.calls.includes("saveDone"));
  assert.equal(h.context.undoToastEl.classList.has("show"), false);
});

test("厨房では完了undoが従来どおり実行される", () => {
  const h = harness("kitchen");
  h.context.undoComplete();
  assert.equal(h.context.doneMap.o1[0], 0);
  assert.ok(h.calls.includes("saveDone"));
  assert.ok(h.calls.includes("poll"));
});

test("厨房では提供準備完了undoを実行しない", () => {
  const h = harness("kitchen");
  h.context.undoHallReady();
  assert.equal(h.context.hallReadyMap.o1.status, "dismissed");
  assert.ok(!h.calls.includes("saveHallReady"));
});

test("ホールでは提供準備完了undoが従来どおり実行される", () => {
  const h = harness("hall");
  h.context.undoHallReady();
  assert.equal(h.context.hallReadyMap.o1.status, "active");
});
