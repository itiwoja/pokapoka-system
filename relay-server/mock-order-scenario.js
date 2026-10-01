/**
 * mock-order-scenario.js — WebSocket配信の目視確認用モック注文シナリオ (MOCKモード専用・依存ゼロ)
 *
 * 配信仕様書 §17 の時間差シナリオを中継サーバー内で再生する。
 *   起動直後: mock-001, mock-002 を保持
 *   5秒後   : mock-003 を追加            → order.created
 *   10秒後  : mock-001 の数量を更新      → order.updated
 *   15秒後  : mock-002 を取消            → order.cancelled
 *
 * 注文は POST /api/orders と同じ正規化 (order-intake) を通すので、配信形式は実注文と共通になる。
 */
"use strict";

var intake = require("./order-intake");

var INITIAL = [
  { orderId: "mock-001", table: "12", people: 3,
    items: [{ name: "土鍋御膳", qty: 2, note: "塩少なめ" }] },
  { orderId: "mock-002", table: "5", people: 2,
    items: [{ name: "ウーロン茶", qty: 2 }] },
];

var STEPS = [
  { afterMs: 5000, put: { orderId: "mock-003", table: "8", people: 4,
    items: [{ name: "土鍋御膳", qty: 4 }, { name: "生ビール", qty: 2 }] } },
  { afterMs: 10000, put: { orderId: "mock-001", table: "12", people: 3,
    items: [{ name: "土鍋御膳", qty: 3, note: "塩少なめ" }] } },
  { afterMs: 15000, remove: "mock-002" },
];

/**
 * シナリオを開始する。戻り値の stop() で未実行の手順を取り消す。
 * refresh は差分配信 (orders-websocket の refresh) を呼ぶ関数。
 */
function startMockOrderScenario(options) {
  var orders = options.orders;
  var refresh = options.refresh;
  var log = options.log || function () {};
  var now = options.now || Date.now;
  var setTimeoutFn = options.setTimeout || setTimeout;
  var clearTimeoutFn = options.clearTimeout || clearTimeout;

  function put(body) {
    var result = intake.normalizeOrder(body, now());
    if (result.error) throw new Error("mock order is invalid: " + result.error);
    intake.putOrder(orders, result.order);
  }

  INITIAL.forEach(put);
  refresh();
  log("MOCK_ORDER_SCENARIO=1: mock-001, mock-002 を保持 (5秒後追加 / 10秒後更新 / 15秒後取消)");

  var timers = STEPS.map(function (step) {
    var timer = setTimeoutFn(function () {
      if (step.put) put(step.put);
      if (step.remove) intake.removeOrder(orders, step.remove);
      refresh();
      log("モック注文シナリオ: " + (step.put ? step.put.orderId + " を反映" : step.remove + " を取消"));
    }, step.afterMs);
    if (timer && typeof timer.unref === "function") timer.unref();
    return timer;
  });

  return { stop: function () { timers.forEach(function (timer) { clearTimeoutFn(timer); }); } };
}

module.exports = { startMockOrderScenario: startMockOrderScenario, INITIAL: INITIAL, STEPS: STEPS };
