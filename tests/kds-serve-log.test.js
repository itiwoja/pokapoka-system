"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ServeLog = require("../serve-log.js");
const { functionSource: source } = require("./helpers/kds-source");

function harness(globals) {
  const context = vm.createContext(Object.assign({ window: { ServeLog }, tableOverrideMap: {} }, globals));
  vm.runInContext([
    "effectiveTable", "serveDayKey", "serveRecordDay", "pruneServeLog", "hasServeRecord",
    "buildServeRecord", "computeServeStats", "formatServeDuration", "serveToCSV",
  ].map(source).join("\n"), context);
  return context;
}

test("serve-log.jsはブラウザのwindow.ServeLogとNodeに同じAPIを公開する", () => {
  const context = vm.createContext({});
  context.window = context;
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "serve-log.js"), "utf8"), context);
  assert.deepEqual(Object.keys(context.window.ServeLog).sort(), Object.keys(ServeLog).sort());
  for (const name of Object.keys(ServeLog)) assert.equal(typeof context.window.ServeLog[name], "function", name);
  const order = { id: "browser", table: "3", start: 1000, items: [{ qty: 2 }] };
  assert.equal(JSON.stringify(context.window.ServeLog.buildServeRecord(order, 61000)),
    JSON.stringify(ServeLog.buildServeRecord(order, 61000)));
});

test("KDSの提供時間レコードは上書き卓番だけを反映し、元注文を変更しない", () => {
  const context = harness({ tableOverrideMap: { o1: "B5" } });
  const order = Object.freeze({ id: "o1", table: "11", type: "reserved", people: 3,
    start: 1000, items: Object.freeze([Object.freeze({ qty: 2 }), Object.freeze({ qty: 1 })]) });
  const expected = Object.assign({}, ServeLog.buildServeRecord(order, 61000), { table: "B5" });
  assert.deepEqual(context.buildServeRecord(order, 61000), expected);
  assert.equal(order.table, "11");
  context.tableOverrideMap = {};
  assert.deepEqual(context.buildServeRecord(order, 61000), ServeLog.buildServeRecord(order, 61000));
});

test("KDSの提供時間アダプターは保持日数・件数・重複・統計・CSVを共有APIへ渡す", () => {
  const context = harness();
  const log = [
    { orderId: 7, day: "2026-09-07", start: 0, completedAt: 60000, serveMs: 60000, table: 'A,"1' },
    { orderId: "8", day: "2026-09-08", start: 0, completedAt: 600000, serveMs: 600000 },
  ];
  assert.equal(context.serveDayKey(60000), ServeLog.dayKey(60000));
  assert.equal(context.serveRecordDay({ completedAt: 60000 }), ServeLog.recordDay({ completedAt: 60000 }));
  assert.deepEqual(context.pruneServeLog(log, "2026-09-08", 14, 1), [log[1]]);
  assert.deepEqual(context.pruneServeLog(log, "2026-09-08", 1, 3000), [log[1]]);
  assert.equal(context.hasServeRecord(log, "7", "2026-09-07"), true);
  assert.equal(context.hasServeRecord(log, "7", "2026-09-08"), false);
  assert.deepEqual(context.computeServeStats(log), ServeLog.computeServeStats(log));
  assert.equal(context.formatServeDuration(65000), "1分05秒");
  assert.equal(context.serveToCSV(log), ServeLog.toCSV(log));
});

test("提供完了は当日だけ重複を防ぎ、取消後の再完了を記録できる", () => {
  const now = new Date(2026, 8, 8, 12).getTime();
  let log = [{ orderId: "daily-1", day: "2026-09-07" }];
  let saves = 0;
  const context = harness({
    Date: class extends Date { static now() { return now; } },
    todayStr: () => "2026-09-08", SERVE_KEEP_DAYS: 14, SERVE_MAX_RECORDS: 3000,
    loadServeLog: () => log.slice(),
    saveServeLog: next => { log = next.slice(); saves++; return true; },
  });
  vm.runInContext(["recordServe", "removeLatestServeRecord"].map(source).join("\n"), context);
  const entry = { order: { id: "daily-1", table: "3", start: now - 60000, items: [{ qty: 1 }] } };
  context.recordServe(entry);
  context.recordServe(entry);
  assert.equal(saves, 1);
  assert.equal(log.length, 2);
  assert.equal(log[1].day, "2026-09-08");
  assert.equal(log[1].serveMs, 60000);
  assert.equal(context.removeLatestServeRecord("daily-1"), true);
  assert.equal(log.length, 1);
  assert.equal(log[0].day, "2026-09-07");
  context.recordServe(entry);
  assert.equal(log.length, 2);
  assert.equal(saves, 3);
});

test("保存容量不足では共有ロジックでログを当日分へ整理して1回だけ再試行する", () => {
  const writes = [], warnings = [], errors = [];
  let attempts = 0;
  const context = harness({
    LS_SERVE: "kds_serve_log_v1", SERVE_MAX_RECORDS: 3000,
    storageFailed: false, storageReclaiming: false, storageWarnEl: { hidden: true },
    todayStr: () => "2026-09-08",
    loadServeLog: () => [{ day: "2026-09-07" }, { day: "2026-09-08" }],
    localStorage: { setItem(key, value) {
      writes.push([key, value]);
      if (key === "done" && attempts++ === 0) throw new Error("quota");
    } },
    console: { warn: message => warnings.push(message), error: message => errors.push(message) },
  });
  vm.runInContext(["lsSet", "reclaimStorage", "reportStorageFailure"].map(source).join("\n"), context);
  assert.equal(context.lsSet("done", "{}"), true);
  assert.deepEqual(writes, [["done", "{}"], ["kds_serve_log_v1", '[{"day":"2026-09-08"}]'], ["done", "{}"]]);
  assert.equal(warnings.length, 1);
  assert.equal(errors.length, 0);
  assert.equal(context.storageWarnEl.hidden, true);
  assert.equal(context.storageReclaiming, false);

  context.localStorage.setItem = () => { throw new Error("still full"); };
  assert.equal(context.lsSet("kds_serve_log_v1", "[]"), false);
  assert.equal(context.storageWarnEl.hidden, false);
  assert.equal(errors.length, 1);
});

test("提供時間CSVのダウンロードはBOM・ファイル名・URL解放を維持する", () => {
  const calls = [];
  let blob;
  const anchor = { click() { calls.push("click"); } };
  const log = [{ orderId: "csv", table: "3", start: 0, completedAt: 60000, serveMs: 60000 }];
  const context = harness({
    loadServeLog: () => log,
    Blob: function (parts, options) { blob = { parts, options }; },
    URL: { createObjectURL() { return "blob:serve"; }, revokeObjectURL(url) { calls.push(url); } },
    document: {
      createElement(tag) { assert.equal(tag, "a"); return anchor; },
      body: { appendChild(el) { assert.equal(el, anchor); calls.push("append"); },
        removeChild(el) { assert.equal(el, anchor); calls.push("remove"); } },
    },
  });
  vm.runInContext(source("downloadServeCSV"), context);
  context.downloadServeCSV();
  assert.equal(blob.parts[0], "\uFEFF" + ServeLog.toCSV(log));
  assert.equal(blob.options.type, "text/csv;charset=utf-8");
  assert.equal(anchor.download, "kds-serve-log.csv");
  assert.equal(anchor.href, "blob:serve");
  assert.deepEqual(calls, ["append", "click", "remove", "blob:serve"]);
});
