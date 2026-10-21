"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "kds-a-grid.html"), "utf8");
// 単一HTML内の実装をそのまま実行する (既存の KDS テストと同じ流儀)。
function source(name) {
  const start = html.indexOf("    function " + name + "(");
  assert.notEqual(start, -1, name);
  const end = html.indexOf("\n    }", start);
  return html.slice(start, end + 6);
}

// 最小の DOM。className / classList / 属性 / 子要素 / replaceChild / querySelector だけを持つ
function el(tag) {
  const node = {
    tagName: tag, textContent: "", children: [], attrs: {}, style: {}, parentNode: null, listeners: {},
    get className() { return Array.from(this._cls).join(" "); },
    set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k]; },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    replaceChild(n, o) { const i = this.children.indexOf(o); n.parentNode = this; this.children[i] = n; return o; },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    querySelector(sel) {
      if (sel === ".js-badge") return this.children.find(c => c._cls.has("js-badge")) || null;
      const m = /data-serve-kind="(\w+)"/.exec(sel);
      return this.children.find(c => c.attrs["data-serve-kind"] === m[1]) || null;
    },
  };
  node._cls = new Set();
  node.classList = {
    add: (...cs) => cs.forEach(c => node._cls.add(c)),
    remove: (...cs) => cs.forEach(c => node._cls.delete(c)),
    contains: c => node._cls.has(c),
    toggle: (c, on) => { if (on === undefined ? !node._cls.has(c) : on) node._cls.add(c); else node._cls.delete(c); },
  };
  return node;
}
function find(node, pred) {
  if (pred(node)) return node;
  for (const c of node.children) { const r = find(c, pred); if (r) return r; }
  return null;
}
const button = cue => find(cue, n => n.tagName === "button");
const wait = cue => find(cue, n => n.className === "serve-cue-wait");

function order(id, table, start, done) {
  return { id, table, type: "new", start, people: 4, items: [{ name: "膳", qty: 1, doneCount: done ? 1 : 0, done: !!done }] };
}

// #299: 前菜・デザートは来店 (同じ実効の卓番で、画面に残っているカード) の単位で1回
function harness(orders, opts) {
  opts = opts || {};
  const calls = [];
  const holds = [];
  const cards = {};
  const hallReadyMap = {};
  const context = vm.createContext({
    mode: opts.mode || "hall",
    cards, hallReadyMap,
    serveCueMap: {},
    document: { createElement: el },
    SERVE_REVERT_MS: 2000, serveCueSuppressClick: false,
    hallReadyUndoId: null,
    t: k => ({ new: "新規", reserved: "予約", people: "名", visitExtra: "追加" }[k] || k),
    effectiveTable: o => o.table,
    todayStr: () => "2026-10-21",
    saveServeCues() {}, broadcastServeCue(id, st) { calls.push(["broadcastServeCue", id, st.dessert]); },
    renderHallViews() {}, saveHallReady() {}, broadcastHallReady(id) { calls.push(["broadcastHallReady", id]); },
    showHallReadyUndo(id, table) { calls.push(["undoToast", id, table]); context.hallReadyUndoId = String(id); },
    hideHallReadyUndo() { context.hallReadyUndoId = null; },
    poll() { calls.push(["poll"]); },
    removeCard(id) { calls.push(["removeCard", id]); delete cards[id]; },
    attachServeHoldHandlers(cue, btn, progress, ms, onHold) {
      holds.push({ id: cue.attrs["data-serve-id"], kind: cue.attrs["data-serve-kind"], served: cue.classList.contains("served"), onHold });
    },
  });
  vm.runInContext([
    "serveCueState", "setServeCue", "isOrderAllDone", "isAllDone",
    "compareVisitIds", "visitOf", "refreshVisits",
    "buildServeCue", "applyServeCueToCard",
    "dismissHallReady", "dismissHallReadyVisit", "undoHallReady",
  ].map(source).join("\n"), context);
  context.addCard = function (o) {
    const card = el("article");
    const badge = el("span"); badge.className = "badge-type js-badge"; badge.textContent = "新規";
    card.appendChild(badge);
    card.appendChild(context.buildServeCue(o.id, "starter", o.people));   // buildCard と同じく、作る時点では cards に無い
    card.appendChild(context.buildServeCue(o.id, "dessert", o.people));
    cards[o.id] = { el: card, order: o };
    if (o.items.every(i => i.done)) hallReadyMap[o.id] = { orderId: o.id, id: o.id, table: o.table, status: "active" };
  };
  (orders || []).forEach(o => context.addCard(o));
  context.refreshVisits();
  const cue = (id, kind) => cards[id].el.querySelector('.serve-cue[data-serve-kind="' + kind + '"]');
  return { context, calls, holds, cards, hallReadyMap, cue };
}
const lastHold = (h, id) => h.holds.filter(x => x.id === id && x.kind === "dessert" && !x.served).pop();

test("同じ卓の後から来た注文は「追加」になり、最初の注文 (受付が早いほう) はそのまま", () => {
  const h = harness([order("o3b", "3", 200, false), order("o3a", "3", 100, false), order("o5", "5", 150, false)]);
  const a = h.cards.o3a.el, b = h.cards.o3b.el, five = h.cards.o5.el;
  assert.equal(a.classList.contains("visit-extra"), false);
  assert.equal(b.classList.contains("visit-extra"), true);
  assert.equal(five.classList.contains("visit-extra"), false, "別の卓とはまとめない");
  assert.equal(a.querySelector(".js-badge").textContent, "新規");
  assert.equal(b.querySelector(".js-badge").textContent, "追加");
  assert.equal(b.getAttribute("aria-label"), "卓 3 追加");
});

test("追加のカードの前菜・デザートの帯は CSS で隠す (厨房の前菜の出し分けより強く)", () => {
  assert.match(html, /html body \.card\.visit-extra \.serve-cue\[data-serve-kind\] \{ display: none; \}/);
});

test("卓番を上書きして別の卓になれば、追加ではなくなる", () => {
  const h = harness([order("o3a", "3", 100, false), order("o3b", "3", 200, false)]);
  h.cards.o3b.order.table = "7";
  h.context.refreshVisits();
  assert.equal(h.cards.o3b.el.classList.contains("visit-extra"), false);
  assert.equal(h.cards.o3b.el.querySelector(".js-badge").textContent, "新規");
});

test("同じ卓のカードが全部消えた後の注文は、新しい来店 (追加ではない)", () => {
  const h = harness([]);
  h.context.addCard(order("o3c", "3", 900, false));
  h.context.refreshVisits();
  assert.equal(h.cards.o3c.el.classList.contains("visit-extra"), false);
});

test("追加の膳が残っている間、最初のカードのデザートはボタンを置かず「追加の膳がまだです」と出す", () => {
  const h = harness([order("o3a", "3", 100, true), order("o3b", "3", 200, false)]);
  const cue = h.cue("o3a", "dessert");
  assert.equal(button(cue), null);
  assert.ok(cue.classList.contains("readonly"));
  assert.equal(wait(cue).textContent, "追加の膳がまだです");
  // 作り直す前の帯に配線された長押しが残っていても、来店の側で止める (最後のテスト)
});

test("追加の膳も全部できたら、最初のカードのデザートに長押しのボタンが出る", () => {
  const h = harness([order("o3a", "3", 100, true), order("o3b", "3", 200, false)]);
  const b = h.cards.o3b.order.items[0];
  b.done = true; b.doneCount = 1;
  h.context.refreshVisits();
  assert.equal(button(h.cue("o3a", "dessert")).textContent, "長押しで出した");
});

test("デザートを出すと、その来店のカードを全部消し、提供準備完了もまとめて閉じる (「戻す」は1つ)", () => {
  const h = harness([order("o3a", "3", 100, true), order("o3b", "3", 200, true)]);
  lastHold(h, "o3a").onHold();
  assert.equal(h.context.serveCueState("o3a").dessert, true);
  assert.equal(h.context.serveCueState("o3b").dessert, true);
  assert.equal(h.hallReadyMap.o3a.status, "dismissed");
  assert.equal(h.hallReadyMap.o3b.status, "dismissed");
  assert.deepEqual(Array.from(h.hallReadyMap.o3a.visitIds), ["o3a", "o3b"]);
  assert.deepEqual(h.calls.filter(c => c[0] === "undoToast"), [["undoToast", "o3a", "3"]]);
  assert.deepEqual(h.calls.filter(c => c[0] === "removeCard").map(c => c[1]), ["o3a", "o3b"]);
});

test("「戻す」でデザートを取り消すと、その来店のカードがそろって戻る", () => {
  const h = harness([order("o3a", "3", 100, true), order("o3b", "3", 200, true)]);
  lastHold(h, "o3a").onHold();
  h.context.undoHallReady();
  ["o3a", "o3b"].forEach(id => {
    assert.equal(h.hallReadyMap[id].status, "active", id);
    assert.equal(h.hallReadyMap[id].visitIds, undefined, id);
    assert.equal(h.context.serveCueState(id).dessert, false, id);   // 次の render でカードが再生成される (#260)
  });
  assert.ok(h.calls.some(c => c[0] === "poll"));
});

test("1枚だけの卓は従来どおり (デザートのボタン、長押しでその1枚を消す)", () => {
  const h = harness([order("o5", "5", 100, true)]);
  assert.equal(button(h.cue("o5", "dessert")).textContent, "長押しで出した");
  lastHold(h, "o5").onHold();
  assert.equal(h.hallReadyMap.o5.status, "dismissed");
  assert.equal(h.hallReadyMap.o5.visitIds, undefined);
  assert.deepEqual(h.calls.filter(c => c[0] === "removeCard").map(c => c[1]), ["o5"]);
});

test("ボタンを出した後に同じ卓の注文が来たら、長押しを通っても出さず、帯を「追加の膳がまだです」に戻す", () => {
  const h = harness([order("o3a", "3", 100, true)]);
  const hold = lastHold(h, "o3a");
  h.context.addCard(order("o3b", "3", 200, false));   // 追加注文が届いた (まだ refreshVisits 前)
  hold.onHold();
  assert.equal(h.context.serveCueState("o3a").dessert, false);
  assert.equal(h.calls.some(c => c[0] === "removeCard"), false);
  assert.equal(wait(h.cue("o3a", "dessert")).textContent, "追加の膳がまだです");
});
