"use strict";

const fs = require("node:fs");
const path = require("node:path");

// 注文端末チームの仕様確定前に使う、独立したモックDB。
function openDatabase(filename) {
  const { DatabaseSync } = require("node:sqlite");
  if (filename !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
  const db = new DatabaseSync(filename);
  try {
    db.exec("PRAGMA foreign_keys=ON");
    db.exec(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"));
    const insertOrder = db.prepare("INSERT INTO mock_orders(people) VALUES(?)");
    const insertItem = db.prepare("INSERT INTO mock_order_items(order_id,position,product_id,qty) VALUES(?,?,?,?)");
    const items = db.prepare("SELECT product_id AS productId, qty FROM mock_order_items WHERE order_id=? ORDER BY position");
    return {
      addOrder(order) {
        if (!order || !Number.isInteger(order.people) || order.people < 1 ||
            !Array.isArray(order.items) || !order.items.length || order.items.some(item =>
              !item || typeof item.productId !== "string" || !item.productId.trim() ||
              !Number.isInteger(item.qty) || item.qty < 1)) {
          throw new Error("people・qtyは正の整数、productIdは空でない文字列、itemsは1件以上必要です");
        }
        db.exec("BEGIN");
        try {
          const id = Number(insertOrder.run(order.people).lastInsertRowid);
          order.items.forEach((item, position) => insertItem.run(id, position, item.productId, item.qty));
          db.exec("COMMIT");
          return id;
        } catch (err) { db.exec("ROLLBACK"); throw err; }
      },
      listOrders() {
        return db.prepare("SELECT id, people FROM mock_orders ORDER BY id").all()
          .map(order => ({ ...order, items: items.all(order.id).map(item => ({ ...item })) }));
      },
      close() { db.close(); },
    };
  } catch (err) { db.close(); throw err; }
}

if (require.main === module) {
  const filename = path.join(__dirname, "..", "data", "mock-orders.sqlite");
  const db = openDatabase(filename);
  try {
    if (db.listOrders().length === 0) {
      db.addOrder({ people: 2, items: [{ productId: "MOCK-001", qty: 2 }, { productId: "MOCK-002", qty: 1 }] });
    }
    console.log("モックDB: " + filename);
    console.log(JSON.stringify(db.listOrders(), null, 2));
  } finally { db.close(); }
}

module.exports = { openDatabase };
