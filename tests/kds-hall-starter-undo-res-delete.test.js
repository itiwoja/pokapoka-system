"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { readKdsSources, functionSource: source } = require("./helpers/kds-source");
const { js } = readKdsSources();

// 手で進める setTimeout
function fakeClock() {
  let now = 0, seq = 0;
  const timers = new Map();
  return {
    setTimeout(fn, ms) { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) {
      now += ms;
      for (const [id, t] of Array.from(timers)) if (t.at <= now) { timers.delete(id); t.fn(); }
    },
  };
}
// 最小の DOM
function el(tag) {
  const node = {
    tagName: tag, textContent: "", children: [], attrs: {}, style: {}, listeners: {},
    get className() { return Array.from(this._cls).join(" "); },
    set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); },
    set innerHTML(v) { this._html = v; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k]; },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    click() { (this.listeners.click || []).forEach(fn => fn({ stopPropagation() {} })); },
  };
  node._cls = new Set();
  node.classList = {
    add: (...cs) => cs.forEach(c => node._cls.add(c)),
    remove: (...cs) => cs.forEach(c => node._cls.delete(c)),
    contains: c => node._cls.has(c),
  };
  return node;
}
function find(node, pred) {
  if (pred(node)) return node;
  for (const c of node.children) { const r = find(c, pred); if (r) return r; }
  return null;
}

// ---- #295: ホールで前菜の「出した」を取り消せる ----
function starterHarness(mode) {
  const clock = fakeClock();
  const calls = [];
  const toast = el("div"), msg = el("span");
  const context = vm.createContext({
    mode: mode || "hall",
    serveCueMap: {},
    cards: { o3: { order: { id: "o3", table: "3", people: 4 } } },
    document: { createElement: el },
    SERVE_REVERT_MS: 2000, HALL_READY_UNDO_MS: 6000, serveCueSuppressClick: false,
    starterUndoId: null, starterUndoTimer: null,
    starterUndoToastEl: toast, starterUndoMsgEl: msg,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    t: k => (k === "people" ? "名" : k),
    effectiveTable: o => o.table,
    todayStr: () => "2026-10-21",
    saveServeCues() {}, broadcastServeCue(id, st) { calls.push(["broadcast", id, st.starter]); },
    applyServeCueToCard() {}, renderHallViews() {},
    attachServeHoldHandlers() {},
  });
  vm.runInContext(["serveCueState", "setServeCue", "buildServeCue",
    "showStarterUndo", "hideStarterUndo", "undoStarter"].map(source).join("\n"), context);
  return { context, clock, calls, toast, msg };
}

test("ホールで前菜の「出した」を押すと、「戻す」の知らせを出し、押せば前菜を未提供に戻す", () => {
  const h = starterHarness();
  const cue = h.context.buildServeCue("o3", "starter", 4);
  find(cue, n => n.tagName === "button").click();
  assert.equal(h.context.serveCueState("o3").starter, true);
  assert.ok(h.toast.classList.contains("show"));
  assert.equal(h.msg.textContent, "卓 3 の前菜を出しました");

  h.context.undoStarter();
  assert.equal(h.context.serveCueState("o3").starter, false);
  assert.equal(h.toast.classList.contains("show"), false);
  assert.deepEqual(h.calls.map(c => c[2]), [true, false], "他タブ・中継サーバーにも戻した状態を伝える");
});

test("「戻す」の知らせは6秒で消え、その後は戻さない", () => {
  const h = starterHarness();
  find(h.context.buildServeCue("o3", "starter", 4), n => n.tagName === "button").click();
  h.clock.advance(5999);
  assert.ok(h.toast.classList.contains("show"));
  h.clock.advance(1);
  assert.equal(h.toast.classList.contains("show"), false);
  h.context.undoStarter();
  assert.equal(h.context.serveCueState("o3").starter, true);
});

test("キッチンでは前菜の取り消しを実行しない (記録はホールだけ #228)", () => {
  const h = starterHarness("hall");
  find(h.context.buildServeCue("o3", "starter", 4), n => n.tagName === "button").click();
  h.context.mode = "kitchen";
  h.context.undoStarter();
  assert.equal(h.context.serveCueState("o3").starter, true);
  assert.equal(h.toast.classList.contains("show"), false);
});

test("厨房へ切り替えると、前菜の取り消しの知らせも閉じる", () => {
  assert.match(source("setMode"), /else \{ hideHallReadyUndo\(\); hideStarterUndo\(\); \}/);
  assert.match(js, /starterUndoBtn\.addEventListener\("click", undoStarter\)/);
});

// ---- #295: 予約の「×」を2段階にする ----
function resHarness() {
  const clock = fakeClock();
  const deleted = [];
  const context = vm.createContext({
    document: { createElement: el },
    DELETE_ARM_MS: 3000,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    seatDrafts: {},
    t: k => ({ del: "削除", seatPh: "卓番", go: "調理開始", soon: "まもなく", people: "名", kidsLabel: "幼" }[k] || k),
    buildReservationNotes() { return null; }, buildRiceCue() { return null; },
    // main の buildResCard は人数を peopleTotal / peopleBreakdown で組む (relay-server/party-size.js と共有)
    peopleTotal(r) { return (r.adults || 0) + (r.kids || 0); }, peopleBreakdown() { return ""; },
    openSeatDial() {}, moveResToMain() {},
    deleteRes(rid) { deleted.push(rid); },
  });
  vm.runInContext(source("buildResCard"), context);
  const card = context.buildResCard({ rid: "r1", time: "18:00", adults: 2, kids: 0, name: "テスト", menu: [] });
  const del = find(card, n => n.className.split(" ").includes("res-del"));
  return { context, clock, deleted, del };
}

test("予約の「×」は1回目では消さず「削除?」に変わり、猶予内にもう一度押すと消す", () => {
  const h = resHarness();
  h.del.click();
  assert.deepEqual(h.deleted, []);
  assert.ok(h.del.classList.contains("armed"));
  assert.equal(h.del.textContent, "削除?");
  assert.equal(h.del.getAttribute("aria-label"), "もう一度タップで予約を削除");
  h.clock.advance(2000);
  h.del.click();
  assert.deepEqual(h.deleted, ["r1"]);
  assert.equal(h.del.classList.contains("armed"), false);
});

test("猶予 (DELETE_ARM_MS) が過ぎたら元に戻り、次の1回では消さない", () => {
  const h = resHarness();
  h.del.click();
  h.clock.advance(3000);
  assert.equal(h.del.classList.contains("armed"), false);
  assert.equal(h.del.textContent, "×");
  h.del.click();
  assert.deepEqual(h.deleted, []);
});
