"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "kds-a-grid.html"), "utf8");
// 単一HTML内の実装を実行し、別の参照実装とのずれを避ける。
function source(name) {
  const start = html.indexOf("    function " + name + "(");
  assert.notEqual(start, -1, "function must exist: " + name);
  const end = html.indexOf("\n    }", start);
  assert.notEqual(end, -1, "function must have a closing brace: " + name);
  return html.slice(start, end + 6);
}

// 最小の DOM。className・textContent・子要素・style だけを持つ
function fakeDocument() {
  function el(tag) {
    return {
      tagName: tag, className: "", textContent: "", children: [], style: {}, attrs: {},
      appendChild(child) { this.children.push(child); return child; },
      setAttribute(k, v) { this.attrs[k] = v; },
      set innerHTML(v) { this.children = []; },
    };
  }
  return { createElement: el };
}
function text(node) {
  return node.textContent + node.children.map(text).join("");
}

const ITEM = { name: "鯛めし土鍋御膳", qty: 2, options: "1つはご飯少なめ", allergies: "えび" };
const NOTE_FUNCS = ["normalizeNoteValue", "itemOptionText", "itemAllergyText", "buildItemAllergy", "itemNotesText"];

// #294: 品目のアレルギーを備考 (.item-opt) と分け、予約のアレルギーと同じ強調で描く
function cardHarness() {
  const document = fakeDocument();
  const context = vm.createContext({
    document,
    attachItemHandlers() {},
    updateItemButtonDone() {},
  });
  vm.runInContext(NOTE_FUNCS.concat(["buildItemsList"]).map(source).join("\n"), context);
  return context;
}

test("カードの品目: アレルギーは備考と別の要素・別のクラスで、品名のすぐ下に描く", () => {
  const ctx = cardHarness();
  const ul = ctx.buildItemsList({ id: "o1", items: [ITEM] });
  const btn = ul.children[0].children[0];
  const main = btn.children.find(c => c.className === "item-main");
  assert.deepEqual(main.children.map(c => c.className), ["item-name", "item-allergy", "item-opt"]);

  const allergy = main.children[1];
  assert.deepEqual(allergy.children.map(c => c.className), ["label", "value"]);
  assert.equal(allergy.children[0].textContent, "アレルギー");
  assert.equal(allergy.children[1].textContent, "えび");

  const opt = main.children[2];
  assert.equal(opt.textContent, "1つはご飯少なめ");      // 備考にアレルギーを混ぜない
  assert.doesNotMatch(opt.textContent, /アレルギー/);
});

test("カードの品目: アレルギーだけ・備考だけ・どちらも無い場合", () => {
  const ctx = cardHarness();
  const ul = ctx.buildItemsList({ id: "o1", items: [
    { name: "A", qty: 1, allergy: ["乳", "小麦"] },          // 表記ゆれ (allergy・配列) も拾う
    { name: "B", qty: 1, options: "大盛り" },
    { name: "C", qty: 1 },
  ] });
  const mains = ul.children.map(li => li.children[0].children.find(c => c.className === "item-main"));
  assert.deepEqual(mains[0].children.map(c => c.className), ["item-name", "item-allergy"]);
  assert.equal(mains[0].children[1].children[1].textContent, "乳、小麦");
  assert.deepEqual(mains[1].children.map(c => c.className), ["item-name", "item-opt"]);
  assert.deepEqual(mains[2].children.map(c => c.className), ["item-name"]);
});

test("まとめた注記 (構造シグネチャ・レーン表示・実機のテキスト印字) は従来の文字列のまま", () => {
  const context = vm.createContext({ document: fakeDocument() });
  vm.runInContext(NOTE_FUNCS.map(source).join("\n"), context);
  assert.equal(context.itemNotesText(ITEM), "1つはご飯少なめ / アレルギー: えび");
  assert.equal(context.itemNotesText({ allergyInfo: "卵" }), "アレルギー: 卵");
});

test("CSS: 品目のアレルギーは予約のアレルギーと同じ強調の規則にのり、完了時は備考と同じく打ち消す", () => {
  // 新しい色を作らず、.order-note.allergy の規則に並べる
  assert.match(html, /\.reservation-note\.allergy, \.order-note\.allergy, \.item-allergy \{\s*border-left-color: #b42318; background: #fff1f0; color: #7a1c16;/);
  assert.match(html, /\.reservation-note, \.order-note, \.item-allergy \{\s*display: flex;/);
  assert.match(html, /\.item\.done \.item-opt,\s*\.item\.done \.item-allergy \{ text-decoration: line-through; opacity: \.7; \}/);
});

// チビ伝: 描画エンジンへ渡す品目と、旧式 (DOM) の伝票
function slipHarness(renderer, style) {
  const document = fakeDocument();
  document.body = { classList: { toggle() {} } };
  const slipItemsEl = document.createElement("ul");
  const context = vm.createContext({
    document, window: { SlipRenderer: renderer },
    slipItemsEl, slipTableEl: { textContent: "" }, slipMetaEl: { textContent: "" },
    slipStoreEl: { textContent: "店" }, slipCanvasEl: {}, slipPageStyleEl: {},
    currentSlipOrder: null,
    refreshSlipStyleFromServer() {}, slipTemplate() { return null; }, applySlipStyle() {},
    loadSlipStyle() { return style || null; },
    effectiveTable(o) { return o.table; }, hhmm() { return "12:00"; }, t(k) { return k; },
    slipQtyText(st, qty) { return "x " + qty; },
  });
  vm.runInContext(NOTE_FUNCS.concat(["slipItemData", "slipAllergyLine", "populateSlip"]).map(source).join("\n"), context);
  return { context, slipItemsEl };
}
const RENDERER = { allergyLine: s => (s ? "【アレルギー】" + s : ""), isTemplate() { return false; } };

test("チビ伝の描画エンジンへは、アレルギーを備考と分けて渡す", () => {
  const { context } = slipHarness(RENDERER);
  assert.deepEqual(JSON.parse(JSON.stringify(context.slipItemData(ITEM))),
    { name: "鯛めし土鍋御膳", qty: 2, note: "1つはご飯少なめ", allergy: "えび" });
});

test("アレルギーの行を描けない古いエンジンには、従来どおり1本の注記で渡す (紙から消さない)", () => {
  const { context } = slipHarness({ isTemplate() { return false; } });
  assert.deepEqual(JSON.parse(JSON.stringify(context.slipItemData(ITEM))),
    { name: "鯛めし土鍋御膳", qty: 2, note: "1つはご飯少なめ / アレルギー: えび" });
});

test("旧式の伝票 (DOM): アレルギーは括弧書きに混ぜず、品名と同じ大きさの独立した行にする", () => {
  const { context, slipItemsEl } = slipHarness(RENDERER, { itemSize: 26, itemBold: true });
  context.populateSlip({ id: "o1", table: "11", start: 0, items: [ITEM] });
  const li = slipItemsEl.children[0];
  const [nm, q, a] = li.children;
  assert.equal(text(nm), "鯛めし土鍋御膳 (1つはご飯少なめ)");
  assert.equal(q.className, "q");
  assert.equal(a.className, "a");
  assert.equal(a.textContent, "【アレルギー】えび");
  assert.equal(a.style.fontSize, nm.style.fontSize);    // 品名と同じ大きさ
  assert.match(html, /\.slip li \.a \{ flex-basis: 100%;/);   // 独立した行
});

test("旧式の伝票 (DOM): 備考を印字しない設定では、アレルギーもこれまでどおり出さない", () => {
  const { context, slipItemsEl } = slipHarness(RENDERER, { noteShow: false });
  context.populateSlip({ id: "o1", table: "11", start: 0, items: [ITEM] });
  assert.deepEqual(slipItemsEl.children[0].children.map(c => c.className), ["", "q"]);
});
