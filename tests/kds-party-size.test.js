"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "kds-a-grid.html"), "utf8");
const PartySize = require("../relay-server/party-size.js");

// 予約の人数の合計と内訳 (PEOPLE_FALLBACK から peopleBreakdown の終わりまで) を切り出す
function peopleSource() {
  const start = html.indexOf("    var PEOPLE_FALLBACK");
  assert.notEqual(start, -1);
  const fn = html.indexOf("    function peopleBreakdown(", start);
  const end = html.indexOf("\n    }", fn);
  return html.slice(start, end + 6);
}

function load(window) {
  const context = vm.createContext({ window: window });
  vm.runInContext(peopleSource(), context);
  return context;
}

const MIXED = { adults: 2, seniors: 1, children: 1, kids: 1 };

test("KDSの人数: party-size.js を読めたときは共有の合計と内訳を使う", function () {
  const kds = load({ PartySize: PartySize });
  assert.equal(kds.peopleTotal(MIXED), 5);
  assert.equal(kds.peopleBreakdown(MIXED), "大2 シ1 子1 幼1");
  assert.equal(kds.peopleBreakdown({ adults: 4 }), "", "大人だけなら合計だけ");
});

test("KDSの人数: party-size.js を読めなくても (HTML単体) 同じ表示で落ちない", function () {
  const kds = load({});
  assert.equal(kds.peopleTotal(MIXED), 5);
  assert.equal(kds.peopleBreakdown(MIXED), "大2 シ1 子1 幼1");
  assert.equal(kds.peopleBreakdown({ adults: 4 }), "");
  assert.equal(kds.peopleTotal({ adults: 2, kids: 1 }), 3, "古い予約ストック (adults/kids だけ) も数える");
});
