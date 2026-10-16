"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

var bytes = fs.readFileSync(path.join(__dirname, "..", "scripts", "pr.ps1"));

// Windows PowerShell 5.1 は BOM の無い .ps1 を ANSI (Shift-JIS) として読み、
// 日本語の文字列が化けて構文エラーになる。エディタの保存で BOM が落ちたら CI で止める。
test("scripts/pr.ps1 は UTF-8 (BOM 付き) で保存されている", function () {
  assert.deepEqual([bytes[0], bytes[1], bytes[2]], [0xEF, 0xBB, 0xBF]);
  assert.doesNotThrow(function () {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  });
});
