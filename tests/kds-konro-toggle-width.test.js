"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "..", "kds-a-grid.html"), "utf8");

// #295: 「コンロ割当」⇔「閉じる」で幅が変わると隣の「卓番」がずれる。
// CSS の ::after に長いほうの文言を見えない行として重ね、幅を固定している。
// JS の文言だけを変えて CSS を直し忘れると、幅がまた文言に合わせて変わる。
// (実際の幅はブラウザで確かめる。ここでは文言の取り違えだけを見張る)
test("コンロ割当ボタンの幅を決める ::after の文言が、JS の開閉の文言のうち長いほうと一致する", () => {
  const css = html.match(/\.card-sub \.konro-toggle::after \{[^}]*content: "([^"]+)";/);
  assert.ok(css, ".card-sub .konro-toggle::after の content が見つからない");

  const js = html.match(/kToggle\.textContent = open \? "([^"]+)" : "([^"]+)";/);
  assert.ok(js, "kToggle の開閉の文言が見つからない");
  const longest = js[1].length >= js[2].length ? js[1] : js[2];
  assert.equal(css[1], longest);
});

test("コンロ割当ボタンは ::after の行を重ねる縦並びの flex にし、その行は高さ0で見せない", () => {
  assert.match(html, /\.card-sub \.konro-toggle \{\s*display: inline-flex;\s*flex-direction: column;/);
  assert.match(html, /\.card-sub \.konro-toggle::after \{[^}]*height: 0;[^}]*visibility: hidden;/);
});
