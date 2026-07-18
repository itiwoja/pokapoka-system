const test = require("node:test");
const assert = require("node:assert/strict");

const {
  completeOrder,
  getAlertableOrderIds,
  getSummaryMetrics,
  getTimeLevel,
  markAlerted,
  remainingTasteSeconds,
  startTasteTimer,
} = require("./app.logic.js");

const baseTime = new Date("2026-07-03T10:00:00.000Z");

test("getTimeLevel marks orders over 10 minutes as alert", () => {
  assert.equal(getTimeLevel(4), "time-ok");
  assert.equal(getTimeLevel(7), "time-warn");
  assert.equal(getTimeLevel(10), "time-warn");
  assert.equal(getTimeLevel(11), "time-alert");
});

test("getAlertableOrderIds returns only overdue orders that have not alerted", () => {
  const orders = [
    { id: "001", timestamp: new Date(baseTime.getTime() - 9 * 60000) },
    { id: "002", timestamp: new Date(baseTime.getTime() - 11 * 60000) },
    { id: "003", timestamp: new Date(baseTime.getTime() - 18 * 60000) },
  ];

  assert.deepEqual(getAlertableOrderIds(orders, baseTime, new Set(["003"])), ["002"]);
});

test("markAlerted returns a new set with all alerted ids", () => {
  const previous = new Set(["001"]);
  const next = markAlerted(previous, ["002", "003"]);

  assert.deepEqual([...previous], ["001"]);
  assert.deepEqual([...next], ["001", "002", "003"]);
});

test("completeOrder moves an order into completion history with duration", () => {
  const activeOrders = [
    { id: "001", timestamp: new Date(baseTime.getTime() - 5 * 60000), tableNumber: "A-1" },
    { id: "002", timestamp: new Date(baseTime.getTime() - 12 * 60000), tableNumber: "B-3" },
  ];
  const result = completeOrder(activeOrders, [], "002", baseTime);

  assert.deepEqual(result.activeOrders.map((order) => order.id), ["001"]);
  assert.equal(result.completedOrders.length, 1);
  assert.equal(result.completedOrders[0].id, "002");
  assert.equal(result.completedOrders[0].durationMinutes, 12);
  assert.equal(result.completedOrders[0].completedAt.toISOString(), baseTime.toISOString());
});

test("getSummaryMetrics counts completed orders and average duration", () => {
  const metrics = getSummaryMetrics([
    { durationMinutes: 8 },
    { durationMinutes: 12 },
    { durationMinutes: 10 },
  ]);

  assert.deepEqual(metrics, {
    completedCount: 3,
    averageDurationMinutes: 10,
  });
});

test("startTasteTimer and remainingTasteSeconds support a two minute serving timer", () => {
  const timers = startTasteTimer({}, "001", baseTime);
  const oneMinuteLater = new Date(baseTime.getTime() + 60000);
  const afterEnd = new Date(baseTime.getTime() + 130000);

  assert.equal(timers["001"].durationMs, 120000);
  assert.equal(remainingTasteSeconds(timers["001"], oneMinuteLater), 60);
  assert.equal(remainingTasteSeconds(timers["001"], afterEnd), 0);
});
