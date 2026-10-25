"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { functionSource: source } = require("./helpers/kds-source");
const ServeLog = require("../serve-log.js");

function fixedDate(now) {
  return class FixedDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [now]));
    }
    static now() { return now.getTime(); }
  };
}

test("炊飯cueの30分境界は境界直前を含めず、境界時刻と超過を含む", () => {
  const now = new Date(2026, 8, 8, 12, 0, 0, 0);
  const context = vm.createContext({ Date: fixedDate(now) });
  vm.runInContext(source("minutesUntil"), context);

  assert.equal(context.minutesUntil("12:30"), 30);
  context.Date = fixedDate(new Date(2026, 8, 8, 11, 59, 31));
  assert.equal(context.minutesUntil("12:30"), 31);
  context.Date = fixedDate(new Date(2026, 8, 8, 12, 0, 1));
  assert.equal(context.minutesUntil("12:30"), 30);
  context.Date = fixedDate(new Date(2026, 8, 8, 12, 30, 1));
  assert.equal(context.minutesUntil("12:30"), -1);
});

test("完了取消は同一注文の当日の提供時間記録だけを取り除く", () => {
  let log = [
    { orderId: "daily-1", day: "2026-09-07" },
    { orderId: "daily-1", day: "2026-09-08" },
    { orderId: "other", day: "2026-09-08" },
  ];
  let saved = null;
  const context = vm.createContext({
    Date: fixedDate(new Date(2026, 8, 8, 12, 0, 0, 0)),
    window: { ServeLog },
    loadServeLog: () => log.slice(),
    saveServeLog: (next) => { saved = next.slice(); log = next.slice(); return true; },
  });
  vm.runInContext(["serveDayKey", "serveRecordDay", "removeLatestServeRecord"].map(source).join("\n"), context);

  assert.equal(context.removeLatestServeRecord("daily-1"), true);
  assert.deepEqual(saved, [
    { orderId: "daily-1", day: "2026-09-07" },
    { orderId: "other", day: "2026-09-08" },
  ]);
  // undo・poll・他タブ同期で重ねて呼ばれても、日次連番IDの前日記録は残す (#179)
  assert.equal(context.removeLatestServeRecord("daily-1"), false);
  assert.deepEqual(log, [
    { orderId: "daily-1", day: "2026-09-07" },
    { orderId: "other", day: "2026-09-08" },
  ]);
  assert.equal(context.removeLatestServeRecord("missing"), false);
});
