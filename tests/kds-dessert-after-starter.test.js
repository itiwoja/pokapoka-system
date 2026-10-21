"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "kds-a-grid.html"), "utf8");
// 単一HTML内の実装をそのまま実行する (kds-dessert-wait-card.test.js と同じ流儀)。
function source(name) {
  const start = html.indexOf("    function " + name + "(");
  assert.notEqual(start, -1, name);
  const end = html.indexOf("\n    }", start);
  return html.slice(start, end + 6);
}

// 最小の DOM。className / classList / 属性 / 子要素 / replaceChild だけを持つ
function el(tag) {
  const node = {
    tagName: tag, textContent: "", children: [], attrs: {}, style: {}, parentNode: null, listeners: {},
    get className() { return Array.from(this._cls).join(" "); },
    set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); },
    classList: null,
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k]; },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    replaceChild(n, o) { const i = this.children.indexOf(o); n.parentNode = this; this.children[i] = n; return o; },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    querySelector(sel) {
      const m = /data-serve-kind="(\w+)"/.exec(sel);
      return this.children.find(c => c.attrs["data-serve-kind"] === m[1]) || null;
    },
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

// #289 案A: 前菜を出すまでデザートを出せない
function harness(state, mode) {
  const calls = [];
  const holds = [];   // attachServeHoldHandlers に渡された onHold
  const card = el("article");
  const context = vm.createContext({
    mode: mode || "hall",
    serveCueMap: { "7": Object.assign({ starter: false, dessert: false }, state || {}) },
    cards: {},
    document: { createElement: el },
    SERVE_REVERT_MS: 2000, serveCueSuppressClick: false,
    t: k => (k === "people" ? "名" : k),
    todayStr: () => "2026-10-21",
    saveServeCues() { calls.push(["save"]); },
    broadcastServeCue(id, st) { calls.push(["broadcast", id, JSON.parse(JSON.stringify(st))]); },
    renderHallViews() { calls.push(["renderHall"]); },
    dismissHallReady(id) { calls.push(["dismissHallReady", id]); },
    removeCard(id) { calls.push(["removeCard", id]); },
    attachServeHoldHandlers(cue, button, progress, ms, onHold) {
      holds.push({ kind: cue.attrs["data-serve-kind"], served: cue.classList.contains("served"), onHold });
    },
  });
  vm.runInContext(["serveCueState", "setServeCue", "buildServeCue", "applyServeCueToCard"].map(source).join("\n"), context);
  // カードには前菜とデザートの帯を両方貼る (buildCard と同じ)
  card.appendChild(context.buildServeCue(7, "starter", 3));
  card.appendChild(context.buildServeCue(7, "dessert", 3));
  context.cards["7"] = { el: card, order: { id: 7, people: 3 } };
  const dessertCue = () => card.querySelector('.serve-cue[data-serve-kind="dessert"]');
  const starterCue = () => card.querySelector('.serve-cue[data-serve-kind="starter"]');
  return { context, calls, holds, card, dessertCue, starterCue };
}
const button = cue => find(cue, n => n.tagName === "button");
const lastDessertHold = h => h.holds.filter(x => x.kind === "dessert" && !x.served).pop();

test("前菜が未提供なら、デザートの帯は出したままボタンを置かず「先に前菜を出してください」と出す", () => {
  const h = harness({ starter: false });
  const cue = h.dessertCue();
  assert.equal(button(cue), null);
  assert.ok(cue.classList.contains("readonly"));
  const wait = find(cue, n => n.className === "serve-cue-wait");
  assert.equal(wait.textContent, "先に前菜を出してください");
  assert.equal(find(cue, n => n.className === "serve-cue-label").textContent, "デザート ×3名");
  assert.equal(lastDessertHold(h), undefined, "長押しの onHold を配線しない");
  // 前菜の帯 (「出した」ボタン付き) はこれまでどおり
  assert.equal(button(h.starterCue()).textContent, "出した");
});

test("前菜が未提供なら、setServeCue でもデザートを提供済みにしない (経路の側でも止める)", () => {
  const h = harness({ starter: false });
  h.context.setServeCue(7, "dessert", true);
  assert.equal(h.context.serveCueState(7).dessert, false);
  assert.equal(h.calls.some(c => c[0] === "broadcast" || c[0] === "save"), false);
});

test("前菜を「出した」にすると、デザートの帯がすぐ長押しのボタン付きに変わり、長押しで卓を閉じる", () => {
  const h = harness({ starter: false });
  // 前菜の「出した」(通常タップ)
  button(h.starterCue()).listeners.click[0]();
  assert.equal(h.context.serveCueState(7).starter, true);
  const cue = h.dessertCue();
  assert.equal(button(cue).textContent, "長押しで出した");
  assert.equal(find(cue, n => n.className === "serve-cue-wait"), null);

  lastDessertHold(h).onHold();
  assert.equal(h.context.serveCueState(7).dessert, true);
  assert.ok(h.calls.some(c => c[0] === "dismissHallReady"));
  assert.ok(h.calls.some(c => c[0] === "removeCard"));
});

test("長押しのボタンを出した後に前菜が戻されたら、onHold を通ってもデザートを出さず、帯を戻す", () => {
  const h = harness({ starter: true });
  const hold = lastDessertHold(h);
  assert.ok(hold, "前菜済みなら長押しのボタンがある");
  // 他タブ・他端末で前菜が取り消された (帯はまだ古いまま)
  h.context.serveCueMap["7"].starter = false;
  hold.onHold();
  assert.equal(h.context.serveCueState(7).dessert, false);
  assert.equal(h.calls.some(c => c[0] === "removeCard" || c[0] === "dismissHallReady"), false);
  assert.equal(button(h.dessertCue()), null, "帯は「先に前菜を」へ作り直す");
});

test("前菜の提供済みを取り消すと、デザートも押せない状態に戻る", () => {
  const h = harness({ starter: true });
  assert.equal(button(h.dessertCue()).textContent, "長押しで出した");
  h.context.setServeCue(7, "starter", false);
  assert.equal(button(h.dessertCue()), null);
  assert.equal(find(h.dessertCue(), n => n.className === "serve-cue-wait").textContent, "先に前菜を出してください");
});

test("デザートが既に出ている卓には触れない (取り消しは前菜に関係なくできる)", () => {
  const h = harness({ starter: false, dessert: true });
  assert.equal(button(h.dessertCue()).textContent, "長押しで戻す");
  h.context.setServeCue(7, "dessert", false);
  assert.equal(h.context.serveCueState(7).dessert, false);
});

test("キッチンの帯はこれまでどおり読取専用で、待ちの文言も出さない", () => {
  const h = harness({ starter: false }, "kitchen");
  const cue = h.dessertCue();
  assert.equal(button(cue), null);
  assert.equal(find(cue, n => n.className === "serve-cue-wait"), null);
});
