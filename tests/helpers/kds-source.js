"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");

// ページ・実装・スタイルを分けて読み、検証対象の取り違えを防ぐ。
function readKdsSources() {
  return {
    html: fs.readFileSync(path.join(root, "kds-a-grid.html"), "utf8"),
    js: fs.readFileSync(path.join(root, "assets", "kds", "kds.js"), "utf8"),
    css: fs.readFileSync(path.join(root, "assets", "kds", "kds.css"), "utf8"),
  };
}

const { js } = readKdsSources();

// IIFE内の4スペース字下げを保った実関数をVMで実行する。
function functionSource(name) {
  const start = js.indexOf("    function " + name + "(");
  assert.notEqual(start, -1, "function must exist: " + name);
  const end = js.indexOf("\n    }", start);
  assert.notEqual(end, -1, "function must have a closing brace: " + name);
  return js.slice(start, end + 6);
}

module.exports = { readKdsSources, functionSource };
