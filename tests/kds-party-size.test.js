"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { readKdsSources } = require("./helpers/kds-source");
const { js } = readKdsSources();
const PartySize = require("../relay-server/party-size.js");

// 予約の人数の合計と内訳 (PEOPLE_FALLBACK から peopleBreakdown の終わりまで) を切り出す
function peopleSource() {
  const start = js.indexOf("    var PEOPLE_FALLBACK");
  assert.notEqual(start, -1);
  const fn = js.indexOf("    function peopleBreakdown(", start);
  assert.notEqual(fn, -1);
  const end = js.indexOf("\n    }", fn);
  assert.notEqual(end, -1);
  return js.slice(start, end + 6);
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

test("KDSの人数: party-size.js を読めなくても同じ表示で落ちない", function () {
  const kds = load({});
  assert.equal(kds.peopleTotal(MIXED), 5);
  assert.equal(kds.peopleBreakdown(MIXED), "大2 シ1 子1 幼1");
  assert.equal(kds.peopleBreakdown({ adults: 4 }), "");
  assert.equal(kds.peopleTotal({ adults: 2, kids: 1 }), 3, "古い予約ストック (adults/kids だけ) も数える");
});
