"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "kds-a-grid.html"), "utf8");
// 単一HTML内の実装をそのまま実行する (kds-delete-order.test.js と同じ流儀)。
function source(name) {
  const start = html.indexOf("    function " + name + "(");
  assert.notEqual(start, -1, name);
  const end = html.indexOf("\n    }", start);
  return html.slice(start, end + 6);
}

const doneOrder = { id: 7, items: [{ done: true }, { done: true }] };
const openOrder = { id: 7, items: [{ done: true }, { done: false }] };

function waitingHarness(snapshot, dessertServed) {
  const context = vm.createContext({
    hallReadyMap: snapshot ? { "7": snapshot } : {},
    serveCueState() { return { starter: false, dessert: !!dessertServed }; }
  });
  vm.runInContext(["isOrderAllDone", "isDessertWaiting"].map(source).join("\n"), context);
  return context;
}

test("全品完了でデザート未提供の卓は、リロード後もカードを再生成する対象になる", () => {
  assert.equal(waitingHarness({ status: "active" }, false).isDessertWaiting(doneOrder), true);
});

test("デザート提供済み・未完了・snapshotなし・取り下げ済みは待ち扱いにしない", () => {
  assert.equal(waitingHarness({ status: "dismissed" }, true).isDessertWaiting(doneOrder), false);
  assert.equal(waitingHarness({ status: "active" }, false).isDessertWaiting(openOrder), false);
  assert.equal(waitingHarness(null, false).isDessertWaiting(doneOrder), false);
  assert.equal(waitingHarness({ status: "retracted" }, false).isDessertWaiting(doneOrder), false);
});

test("render は全完了でもデザート待ちならカードを作る", () => {
  assert.match(html, /if \(!entry && allDone && !isDessertWaiting\(order\)\) return;/);
});

function undoHarness(dessertServed) {
  const calls = [];
  const snapshot = { status: "dismissed", dismissedAt: 1 };
  const context = vm.createContext({
    hallReadyUndoId: "7",
    hallReadyMap: { "7": snapshot },
    serveCueState() { return { starter: false, dessert: dessertServed }; },
    hideHallReadyUndo() { calls.push(["hide"]); },
    saveHallReady() {}, broadcastHallReady() {}, renderHallViews() {},
    setServeCue(id, kind, served) { calls.push(["serve", id, kind, served]); },
    poll() { calls.push(["poll"]); }
  });
  vm.runInContext(source("undoHallReady"), context);
  return { context, snapshot, calls };
}

test("「戻す」はスナップショットに加えてデザート提供済みも外し、カードを再描画する", () => {
  const h = undoHarness(true);
  h.context.undoHallReady();
  assert.equal(h.snapshot.status, "active");
  assert.deepEqual(h.calls.filter(c => c[0] === "serve"), [["serve", "7", "dessert", false]]);
  assert.ok(h.calls.some(c => c[0] === "poll"));
});

test("デザートを出していない卓の「戻す」ではデザート状態に触れない", () => {
  const h = undoHarness(false);
  h.context.undoHallReady();
  assert.equal(h.calls.some(c => c[0] === "serve"), false);
});
