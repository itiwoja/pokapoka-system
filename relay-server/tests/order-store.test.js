"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
var openOrderStore = require("../order-store").openOrderStore;

var NOW = Date.parse("2026-10-17T13:00:00+09:00");
var TTL = 720 * 60000;

function order(id, start, fields) {
  return Object.assign({
    id: id, table: "3,4", tables: [3, 4], type: "new", start: start, people: 2,
    items: [{ name: "ゴーヤチャンプルー", qty: 2, options: "ご飯の量: 大盛", allergies: null, done: false }],
  }, fields);
}

function open(t, filename, now) {
  var s = openOrderStore(filename || ":memory:", { now: function () { return now || NOW; }, ttlMs: TTL });
  t.after(function () { s.close(); });
  return s;
}

test("保存した注文をそのままの形で Map へ読み戻し、同じ id は置き換える", function (t) {
  var s = open(t);
  s.put(order("o-1", NOW - 60000));
  s.put(order("o-2", NOW - 30000, { table: "7", tables: null, people: 1 }));
  s.put(order("o-1", NOW - 60000, { people: 3 }));
  assert.equal(s.count(), 2);

  var orders = new Map();
  assert.equal(s.loadInto(orders, NOW), 2);
  assert.deepEqual(orders.get("o-1"), order("o-1", NOW - 60000, { people: 3 }));
  assert.deepEqual(orders.get("o-2"), order("o-2", NOW - 30000, { table: "7", tables: null, people: 1 }));
  assert.deepEqual(s.health(), { store: "sqlite", orders: 2 });
});

test("取消した注文は読み戻さず、保持期間を過ぎた注文は読み戻し時に消える", function (t) {
  var s = open(t);
  s.put(order("o-old", NOW - TTL - 1));
  s.put(order("o-keep", NOW - TTL + 60000));
  s.put(order("o-cancel", NOW - 1000));
  assert.equal(s.remove("o-cancel"), true);
  assert.equal(s.remove("o-cancel"), false);

  var orders = new Map();
  assert.equal(s.loadInto(orders, NOW), 1);
  assert.deepEqual(Array.from(orders.keys()), ["o-keep"]);
  assert.equal(s.count(), 1, "期限切れの行は削除される");
});

test("読み戻し先に同じ id があればメモリ側を優先し、形の崩れた注文は保存を断る", function (t) {
  var s = open(t);
  s.put(order("o-1", NOW - 60000));
  assert.throws(function () { s.put({ id: "", start: NOW }); }, /order\.id/);
  assert.throws(function () { s.put({ id: "o-x", start: "x" }); }, /order\.start/);

  var orders = new Map([["o-1", order("o-1", NOW - 60000, { people: 9 })]]);
  assert.equal(s.loadInto(orders, NOW), 0);
  assert.equal(orders.get("o-1").people, 9);
});

test("ファイルに保存した注文は開き直しても残る", function (t) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-orders-"));
  var file = path.join(dir, "orders.sqlite");
  var first = openOrderStore(file, { now: function () { return NOW; }, ttlMs: TTL });
  first.put(order("o-1", NOW - 60000));
  first.close();

  var second = openOrderStore(file, { now: function () { return NOW; }, ttlMs: TTL });
  t.after(function () { second.close(); });
  t.after(function () { fs.rmSync(dir, { recursive: true, force: true }); });
  var orders = new Map();
  assert.equal(second.loadInto(orders, NOW), 1);
  assert.equal(orders.get("o-1").table, "3,4");
  assert.equal(second.file, path.resolve(file));
});
