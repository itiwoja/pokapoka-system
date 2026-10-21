"use strict";
/**
 * slip-renderer-allergy.test.js — チビ伝の品目アレルギー行 (#294)
 * 実行: node --test tests/slip-renderer-allergy.test.js
 *
 * canvas は Node に無いので、fillText の呼び出しと font を記録するだけの偽物に描かせる。
 * 文字幅は「文字数 × 文字サイズ」で測る (全角を1文字=1em とみなす最も広い見積もり)。
 */
var test = require("node:test");
var assert = require("node:assert/strict");
var R = require("../slip-renderer.js");

function fakeCanvas() {
  var calls = [];
  var ctx = {
    font: "", textAlign: "left", textBaseline: "alphabetic", fillStyle: "", strokeStyle: "", lineWidth: 1,
    measureText: function (t) {
      var m = /(\d+)px/.exec(this.font);
      return { width: t.length * (m ? Number(m[1]) : 10) };
    },
    fillText: function (text, x, y) { calls.push({ text: text, x: x, y: y, font: this.font }); },
    fillRect: function () {}, save: function () {}, restore: function () {}, setLineDash: function () {},
    beginPath: function () {}, moveTo: function () {}, lineTo: function () {}, stroke: function () {},
  };
  return { width: 0, height: 0, calls: calls, getContext: function () { return ctx; } };
}
function sizeOf(call) { return Number(/(\d+)px/.exec(call.font)[1]); }

var ORDER = {
  table: "11", meta: "12:00", store: "店",
  items: [{ name: "鯛めし土鍋御膳", qty: 2, note: "1つはご飯少なめ", allergy: "えび" }],
};

test("allergyLine: 見出しを付けた1行の文言にし、空なら空文字", function () {
  assert.equal(R.allergyLine("えび"), "【アレルギー】えび");
  assert.equal(R.allergyLine("  卵 "), "【アレルギー】卵");
  assert.equal(R.allergyLine(""), "");
  assert.equal(R.allergyLine(null), "");
  assert.equal(R.allergyLine(undefined), "");
});

test("既定レイアウト: アレルギーは品名と同じ大きさの太字で独立した行、備考はその下に小さく", function () {
  var tpl = R.defaultTemplate();
  var items = tpl.elements.filter(function (el) { return el.type === "items"; })[0];
  var canvas = fakeCanvas();
  R.renderToCanvas(canvas, tpl, ORDER);

  var name = canvas.calls.filter(function (c) { return c.text === "鯛めし土鍋御膳"; })[0];
  var allergy = canvas.calls.filter(function (c) { return c.text === "【アレルギー】えび"; })[0];
  var note = canvas.calls.filter(function (c) { return c.text === "※ 1つはご飯少なめ"; })[0];
  assert.ok(name && allergy && note, "品名・アレルギー・備考がそれぞれ別の行で描かれる");
  assert.equal(sizeOf(allergy), items.size);          // 品名と同じ大きさ (既定 32)
  assert.equal(sizeOf(name), items.size);
  assert.match(allergy.font, /^700 /);                 // 太字
  assert.equal(sizeOf(note), items.noteSize);          // 備考は従来どおり (既定 24)
  assert.ok(name.y < allergy.y && allergy.y < note.y, "品名 → アレルギー → 備考 の順");
  // 備考の行にアレルギーを混ぜない
  assert.equal(canvas.calls.some(function (c) { return /アレルギー/.test(c.text) && c !== allergy; }), false);
});

test("アレルギーの行のぶんだけ伝票が伸び、無ければ従来と同じ高さ", function () {
  var tpl = R.defaultTemplate();
  var items = tpl.elements.filter(function (el) { return el.type === "items"; })[0];
  var withA = R.renderToCanvas(fakeCanvas(), tpl, ORDER).height;
  var without = R.renderToCanvas(fakeCanvas(), tpl, {
    table: "11", meta: "12:00", store: "店", items: [{ name: "鯛めし土鍋御膳", qty: 2, note: "1つはご飯少なめ" }],
  }).height;
  assert.equal(withA - without, Math.round(items.size * items.lineHeight));
});

test("58mm 紙: 長いアレルギーは字下げした枠の中で折り返し、印字幅をはみ出さない", function () {
  var tpl = R.normalizeTemplate({
    paperWidth: 58,
    elements: [{ id: "items", type: "items", x: 12, y: 0, w: 360, size: 32, noteIndent: 24, noteSize: 24 }],
  });
  var canvas = fakeCanvas();
  R.renderToCanvas(canvas, tpl, {
    items: [{ name: "鯛めし", qty: 1, allergy: "えび、かに、小麦、卵、乳、そば、落花生" }],
  });
  var lines = canvas.calls.filter(function (c) { return sizeOf(c) === 32 && c.text !== "鯛めし" && !/^x /.test(c.text); });
  assert.ok(lines.length >= 2, "折り返して複数行になる");
  assert.equal(lines.map(function (c) { return c.text; }).join(""), "【アレルギー】えび、かに、小麦、卵、乳、そば、落花生");
  lines.forEach(function (c) {
    assert.equal(c.x, 12 + 24);                                    // 備考と同じ字下げ
    assert.ok(c.text.length * 32 <= 360 - 24, "字下げした枠の幅に収まる: " + c.text);
    assert.ok(c.x + c.text.length * 32 <= R.DOTS[58], "58mm の印字可能幅に収まる");
  });
});

test("備考を印字しない設定では、アレルギーの行もこれまでどおり出さない", function () {
  var tpl = R.normalizeTemplate({
    elements: [{ id: "items", type: "items", x: 12, y: 0, w: 552, noteShow: false }],
  });
  var canvas = fakeCanvas();
  R.renderToCanvas(canvas, tpl, ORDER);
  assert.equal(canvas.calls.some(function (c) { return /アレルギー|ご飯少なめ/.test(c.text); }), false);
});
