"use strict";
/**
 * slip-renderer.test.js — 依存ゼロの素の Node テスト
 * 実行: node --test slip-renderer.test.js
 *
 * 描画そのもの(canvas)はブラウザでしか動かないため、ここではテンプレートの
 * 正規化・判定・差込フィールド置換という純粋関数だけを検証する。
 */
var test = require("node:test");
var assert = require("node:assert/strict");
var R = require("./slip-renderer.js");

test("defaultTemplate: 80mm・品目リストを1つ持つ既定レイアウトを返す", function () {
  var t = R.defaultTemplate();
  assert.equal(t.version, 3);
  assert.equal(t.paperWidth, 80);
  assert.equal(t.elements.filter(function (el) { return el.type === "items"; }).length, 1);
});

test("isTemplate: elements[] を持つものだけ自由配置レイアウトとみなす", function () {
  assert.equal(R.isTemplate({ elements: [] }), true);
  assert.equal(R.isTemplate({ qtyFormat: "x", paperWidth: 80 }), false);   // 旧フォーム式スタイル
  assert.equal(R.isTemplate(null), false);
});

test("normalizeTemplate: 未知のtype・壊れた要素は捨て、値は許容範囲へ丸める", function () {
  var t = R.normalizeTemplate({
    paperWidth: 58,
    feedLines: 99,
    elements: [
      { id: "a", type: "text", x: -9999, y: 10, w: 9999, size: 999, align: "middle", font: "手書き" },
      { id: "b", type: "qrcode" },     // 未対応のtypeは捨てる
      null,
    ],
  });
  assert.equal(t.paperWidth, 58);
  assert.equal(t.feedLines, 8);                 // 0..8へ丸め
  assert.equal(t.elements.length, 1);
  assert.equal(t.elements[0].w, 384);           // 58mmの印字可能幅まで
  assert.equal(t.elements[0].x, -384);
  assert.equal(t.elements[0].size, 120);        // 上限
  assert.equal(t.elements[0].align, "left");    // 未知の値は既定へ
  assert.equal(t.elements[0].font, "gothic");
  assert.equal(t.elements[0].anchor, "top");
});

test("normalizeTemplate: 要素が1つも残らない・elements以外は既定レイアウトへ戻す", function () {
  assert.equal(R.normalizeTemplate({ elements: [{ type: "unknown" }] }).elements.length,
    R.defaultTemplate().elements.length);
  assert.equal(R.normalizeTemplate({ qtyFormat: "x" }).paperWidth, 80);
  assert.equal(R.normalizeTemplate(undefined).version, 3);
});

test("normalizeTemplate: 要素数の上限を超えたぶんは切り捨てる", function () {
  var many = [];
  for (var i = 0; i < 100; i++) many.push({ id: "e" + i, type: "line", x: 0, y: i, w: 100 });
  assert.equal(R.normalizeTemplate({ elements: many }).elements.length, R.MAX_ELEMENTS);
});

test("fillFields: 差込フィールドを注文データへ置換し、欠損は空文字にする", function () {
  var text = R.fillFields("卓 {卓番} / {人数}名 / {受付} / {店名} / {区分}", {
    table: "A1", people: 2, meta: "12:34", store: "土鍋飯ぽかぽか",
  });
  assert.equal(text, "卓 A1 / 2名 / 12:34 / 土鍋飯ぽかぽか / ");
});

test("fillFields: 同じフィールドが複数あってもすべて置換する", function () {
  assert.equal(R.fillFields("{卓番}-{卓番}", { table: "B2" }), "B2-B2");
});
