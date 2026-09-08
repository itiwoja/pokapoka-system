"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openDatabase } = require("./database");

test("モック注文の商品ID・個数・人数を保存し、再接続で取得する", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pokapoka-mock-"));
  const filename = path.join(dir, "mock.sqlite");
  let db;
  try {
    db = openDatabase(filename);
    const order = { people: 2, items: [{ productId: "MOCK-001", qty: 2 }, { productId: "MOCK-002", qty: 1 }] };
    const id = db.addOrder(order);
    assert.throws(() => db.addOrder({ people: 2, items: [{ productId: "MOCK-001", qty: 0 }] }));
    db.close(); db = null;
    db = openDatabase(filename);
    assert.deepEqual(db.listOrders(), [{ id, ...order }]);
  } finally {
    if (db) db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
