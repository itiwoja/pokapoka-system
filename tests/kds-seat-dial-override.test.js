"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { readKdsSources, functionSource: source } = require("./helpers/kds-source");
const { js } = readKdsSources();

function classList() {
  const set = new Set();
  return {
    add: c => set.add(c),
    remove: c => set.delete(c),
    toggle: (c, on) => { if (on === undefined ? !set.has(c) : on) set.add(c); else set.delete(c); },
    contains: c => set.has(c),
  };
}

// #295: 厨房の卓番上書きダイヤルは今の卓番で開く。最初の番号で置き換え、追記しない。
// 予約の「調理開始」ダイヤル (seatDrafts の続きを打つ) は従来どおり追記する。
function harness() {
  const calls = [];
  const display = { textContent: "", classList: classList() };
  const context = vm.createContext({
    mode: "kitchen",
    cards: {
      "o11": { order: { id: "o11", table: "11" } },
      "o6": { order: { id: "o6", table: "123456" } },
    },
    tableOverrideMap: {},
    seatDrafts: { "r1": "A1" },
    seatDialRid: null,
    seatDialBuf: "",
    seatDialContext: "reservation",
    seatDialReplaceNext: false,
    SEAT_MAX_LEN: 6,
    seatDialDisplayEl: display,
    seatDialZoneBtns: [],
    document: { body: { classList: classList() } },
    t: key => (key === "seatPh" ? "卓番" : key),
    closeTableOverrideConfirm() { calls.push(["closeTableOverrideConfirm"]); },
    commitTableOverride(id, value) { calls.push(["commitTableOverride", id, value]); },
    refreshSeatButton(rid) { calls.push(["refreshSeatButton", rid]); },
  });
  vm.runInContext([
    "effectiveTable", "renderSeatDialDisplay", "openSeatDial", "openTableOverride", "closeSeatDial",
    "commitSeatDial", "onSeatZoneTap", "onSeatDigitTap", "onSeatBackspace", "onSeatClear",
  ].map(source).join("\n"), context);
  return { context, calls, display };
}

test("宣言: 置き換え待ちのフラグは false で始まる", () => {
  assert.match(js, /\n    var seatDialReplaceNext = false;/);
});

test("卓番11の上書きダイヤルは今の卓番を見せたまま開き、「1」「2」で 12 になり確定できる", () => {
  const h = harness();
  h.context.openTableOverride("o11");
  assert.equal(h.display.textContent, "11");
  assert.equal(h.display.classList.contains("placeholder"), false);
  assert.equal(h.context.document.body.classList.contains("seat-dial-open"), true);

  h.context.onSeatDigitTap("1");
  assert.equal(h.display.textContent, "1");    // 修正前は 111
  h.context.onSeatDigitTap("2");
  assert.equal(h.display.textContent, "12");

  h.context.commitSeatDial();
  assert.deepEqual(h.calls.filter(c => c[0] === "commitTableOverride"), [["commitTableOverride", "o11", "12"]]);
  assert.equal(h.context.document.body.classList.contains("seat-dial-open"), false);
});

test("何も押さずに決定すると今の卓番のまま確定する", () => {
  const h = harness();
  h.context.openTableOverride("o11");
  h.context.commitSeatDial();
  assert.deepEqual(h.calls.filter(c => c[0] === "commitTableOverride"), [["commitTableOverride", "o11", "11"]]);
});

test("上限6桁の卓番でも、最初の番号タップで置き換えられる", () => {
  const h = harness();
  h.context.openTableOverride("o6");
  assert.equal(h.display.textContent, "123456");
  h.context.onSeatDigitTap("7");
  assert.equal(h.display.textContent, "7");
});

test("上書き済みの卓番で開いたときも、最初の番号で置き換える", () => {
  const h = harness();
  h.context.tableOverrideMap.o11 = "B5";
  h.context.openTableOverride("o11");
  assert.equal(h.display.textContent, "B5");
  h.context.onSeatDigitTap("3");
  assert.equal(h.display.textContent, "3");
});

test("⌫ を先に押したら今の卓番を手直しし、以降の番号は追記する", () => {
  const h = harness();
  h.context.openTableOverride("o11");
  h.context.onSeatBackspace();
  assert.equal(h.display.textContent, "1");
  h.context.onSeatDigitTap("2");
  assert.equal(h.display.textContent, "12");
});

test("全消・ゾーンを先に押したら、以降の番号は追記する", () => {
  const h = harness();
  h.context.openTableOverride("o11");
  h.context.onSeatClear();
  assert.equal(h.display.textContent, "卓番");
  assert.equal(h.display.classList.contains("placeholder"), true);
  h.context.onSeatDigitTap("1");
  h.context.onSeatDigitTap("2");
  assert.equal(h.display.textContent, "12");

  h.context.closeSeatDial();
  h.context.openTableOverride("o11");
  h.context.onSeatZoneTap("A");
  h.context.onSeatDigitTap("1");
  h.context.onSeatDigitTap("2");
  assert.equal(h.display.textContent, "A12");
});

test("閉じて開き直すたびに、最初の番号は置き換えに戻る", () => {
  const h = harness();
  h.context.openTableOverride("o11");
  h.context.onSeatDigitTap("1");
  h.context.closeSeatDial();
  h.context.openTableOverride("o11");
  h.context.onSeatDigitTap("9");
  assert.equal(h.display.textContent, "9");
});

test("予約の「調理開始」ダイヤルは従来どおり下書きの続きに追記する", () => {
  const h = harness();
  h.context.openSeatDial("r1");
  assert.equal(h.context.seatDialContext, "reservation");
  assert.equal(h.display.textContent, "A1");
  h.context.onSeatDigitTap("2");
  assert.equal(h.display.textContent, "A12");
  h.context.commitSeatDial();
  assert.equal(h.context.seatDrafts.r1, "A12");
  assert.equal(h.calls.some(c => c[0] === "commitTableOverride"), false);
});

test("卓番上書きを閉じたあとに開いた予約ダイヤルへ、置き換え待ちを持ち越さない", () => {
  const h = harness();
  h.context.openTableOverride("o11");
  h.context.closeSeatDial();
  h.context.openSeatDial("r1");
  h.context.onSeatDigitTap("2");
  assert.equal(h.display.textContent, "A12");
});

test("ホールモードでは卓番上書きダイヤルを開かない (従来どおり)", () => {
  const h = harness();
  h.context.mode = "hall";
  h.context.openTableOverride("o11");
  assert.equal(h.context.document.body.classList.contains("seat-dial-open"), false);
  assert.equal(h.context.seatDialReplaceNext, false);
});
