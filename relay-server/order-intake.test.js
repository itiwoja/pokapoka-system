"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var intake = require("./order-intake");

var NOW = Date.parse("2026-08-02T18:05:00+09:00");

function body(overrides) {
  return Object.assign({
    orderId: "t12-0001",
    table: "12",
    items: [{ name: "土鍋御膳", qty: 2 }],
  }, overrides || {});
}

test("受信形式をKDSの配信形式へ正規化する", function () {
  var result = intake.normalizeOrder(body({
    people: 4,
    orderedAt: "2026-08-02T18:00:00+09:00",
    items: [{ name: " 土鍋御膳 ", qty: 2, note: " 塩少なめ " }, { name: "ウーロン茶" }],
  }), NOW);

  assert.deepEqual(result.order, {
    id: "t12-0001",
    table: "12",
    type: "new",
    start: Date.parse("2026-08-02T18:00:00+09:00"),
    people: 4,
    items: [
      { name: "土鍋御膳", qty: 2, options: "塩少なめ", allergies: null, done: false },
      { name: "ウーロン茶", qty: 1, options: null, allergies: null, done: false },
    ],
  });
});

test("orderedAt 省略時と未来時刻はサーバー時刻に寄せる", function () {
  assert.equal(intake.normalizeOrder(body(), NOW).order.start, NOW);
  // 注文端末の時計が進んでいると経過時間が止まって見えるため
  assert.equal(intake.normalizeOrder(body({ orderedAt: "2026-08-02T19:00:00+09:00" }), NOW).order.start, NOW);
  assert.equal(intake.normalizeOrder(body({ orderedAt: "きのう" }), NOW).error,
    "orderedAt must be an ISO 8601 datetime");
});

test("検証エラーは直す場所が分かる文言を返す", function () {
  assert.match(intake.normalizeOrder(body({ orderId: "" }), NOW).error, /^orderId/);
  assert.match(intake.normalizeOrder(body({ orderId: "x".repeat(65) }), NOW).error, /^orderId/);
  assert.match(intake.normalizeOrder(body({ table: "1234567" }), NOW).error, /^table/);
  assert.match(intake.normalizeOrder(body({ table: 12 }), NOW).error, /^table/);
  assert.match(intake.normalizeOrder(body({ items: [] }), NOW).error, /^items/);
  assert.equal(intake.normalizeOrder(body({ items: [{ name: "" }] }), NOW).error, "items[0]: item.name is required");
  assert.equal(intake.normalizeOrder(body({ items: [{ name: "茶", qty: 0 }] }), NOW).error,
    "items[0]: item.qty must be an integer between 1 and 99");
  assert.equal(intake.normalizeOrder(body({ items: [{ name: "茶", qty: 1.5 }] }), NOW).error,
    "items[0]: item.qty must be an integer between 1 and 99");
  assert.match(intake.normalizeOrder(body({ people: -1 }), NOW).error, /^people/);
  assert.match(intake.normalizeOrder([], NOW).error, /^body/);
});

test("同じ orderId・同じ内容の再送は二重注文にも更新にもならない", function () {
  var orders = new Map();
  var first = intake.putOrder(orders, intake.normalizeOrder(body(), NOW).order);
  assert.equal(first.created, true);

  // orderedAt 省略時は再正規化の start が変わっても、更新対象の内容が同じなら冪等再送
  var retry = intake.putOrder(orders, intake.normalizeOrder(body(), NOW + 5000).order);
  assert.equal(retry.created, false);
  assert.equal(retry.updated, false);
  assert.equal(retry.duplicate, true);
  assert.equal(orders.size, 1);
  assert.equal(retry.order.start, NOW);
});

test("同じ orderId で内容が違えば既存注文を更新し、初回受付時刻を維持する", function () {
  var orders = new Map();
  intake.putOrder(orders, intake.normalizeOrder(body({
    people: 2,
    orderedAt: NOW - 60000,
  }), NOW).order);

  var changed = intake.putOrder(orders, intake.normalizeOrder(body({
    table: "15",
    people: 3,
    orderedAt: NOW,
    items: [
      { name: "土鍋御膳", qty: 1, note: "塩少なめ" },
      { name: "ウーロン茶", qty: 2 },
    ],
  }), NOW).order);

  assert.equal(changed.created, false);
  assert.equal(changed.updated, true);
  assert.equal(changed.duplicate, false);
  assert.equal(orders.size, 1);
  assert.equal(changed.order.start, NOW - 60000);
  assert.equal(changed.order.table, "15");
  assert.equal(changed.order.people, 3);
  assert.deepEqual(changed.order.items.map(function (item) {
    return [item.name, item.qty, item.options];
  }), [["土鍋御膳", 1, "塩少なめ"], ["ウーロン茶", 2, null]]);
});

test("取消後の同じ orderId の POST は新規注文として再作成する", function () {
  var orders = new Map();
  intake.putOrder(orders, intake.normalizeOrder(body(), NOW).order);
  assert.equal(intake.removeOrder(orders, "t12-0001"), true);

  var recreated = intake.putOrder(orders, intake.normalizeOrder(body({ table: "13" }), NOW).order);
  assert.equal(recreated.created, true);
  assert.equal(recreated.order.table, "13");
});

test("取消は orderId で消え、未知のIDは false", function () {
  var orders = new Map();
  intake.putOrder(orders, intake.normalizeOrder(body(), NOW).order);
  assert.equal(intake.removeOrder(orders, "t12-0001"), true);
  assert.equal(intake.removeOrder(orders, "t12-0001"), false);
  assert.equal(intake.removeOrder(orders, ""), false);
});

test("配信は受付順で、TTL超過分は落ちる", function () {
  var orders = new Map();
  intake.putOrder(orders, intake.normalizeOrder(body({ orderId: "new", orderedAt: NOW - 60000 }), NOW).order);
  intake.putOrder(orders, intake.normalizeOrder(body({ orderId: "old", orderedAt: NOW - 3600000 }), NOW).order);

  assert.deepEqual(intake.toFeed(orders, NOW, 7200000).map(function (o) { return o.id; }), ["old", "new"]);

  // TTL=30分: 1時間前の注文は日跨ぎで残らないよう落とす (#115 当日メモリのみ)
  assert.deepEqual(intake.toFeed(orders, NOW, 1800000).map(function (o) { return o.id; }), ["new"]);
  assert.equal(orders.size, 1);
});
