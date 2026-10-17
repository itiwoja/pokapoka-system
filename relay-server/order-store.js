/**
 * order-store.js — 受け付けた注文を中継サーバーの SQLite に残し、再起動後に読み戻す
 *
 * 注文は従来どおりメモリ上の Map で扱い(order-intake.js)、ここは「再起動で消えない控え」だけを持つ。
 * 注文端末からの転送元(注文サーバー)は再送キューをメモリに持つだけなので、中継サーバーが
 * 営業中に再起動すると KDS から当日の注文が消えていた(2026-10-17 一気通貫確認で再現)。
 *
 * 方針:
 *   - 履歴は持たない。保持期間 ttlMs(order.ttlMin と同じ)を過ぎた行は、読み戻し時と書込み時に削除する
 *   - 行の中身は配信形式の注文(JSON)をそのまま持つ。契約が変わってもスキーマを触らずに済む
 *   - 書込みに失敗しても注文受付は止めない(呼び出し側がログに残す)。配信を優先する
 */
"use strict";

var fs = require("node:fs");
var path = require("node:path");

var MAX_ID_LENGTH = 64;

var SCHEMA = [
  "CREATE TABLE IF NOT EXISTS orders (",
  "  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND " + MAX_ID_LENGTH + "),",
  "  start_ms INTEGER NOT NULL,",
  "  body TEXT NOT NULL,",
  "  updated_at TEXT NOT NULL",
  ") STRICT;",
  "CREATE INDEX IF NOT EXISTS orders_start_ms ON orders(start_ms);",
].join("\n");

/**
 * @param {string} filename - SQLite ファイルのパス。":memory:" ならメモリ上 (テスト用。再起動で消える)
 * @param {{now?: function(): (Date|number), ttlMs?: number}} [options]
 */
function openOrderStore(filename, options) {
  options = options || {};
  var now = typeof options.now === "function" ? options.now : function () { return new Date(); };
  var ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : 720 * 60000;
  var DatabaseSync = require("node:sqlite").DatabaseSync;
  if (filename !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
  var db = new DatabaseSync(filename);
  try {
    // 書き込み中の電源断でファイルを壊さないため WAL にする (予約ストアと同じ)
    if (filename !== ":memory:") db.exec("PRAGMA journal_mode=WAL");
    db.exec(SCHEMA);
  } catch (err) { db.close(); throw err; }

  var upsert = db.prepare(
    "INSERT INTO orders(id,start_ms,body,updated_at) VALUES(?,?,?,?)" +
    " ON CONFLICT(id) DO UPDATE SET start_ms=excluded.start_ms, body=excluded.body, updated_at=excluded.updated_at");
  var remove = db.prepare("DELETE FROM orders WHERE id=?");
  var deleteBefore = db.prepare("DELETE FROM orders WHERE start_ms <= ?");
  var selectAll = db.prepare("SELECT id, body FROM orders ORDER BY start_ms, id");
  var countAll = db.prepare("SELECT count(*) AS n FROM orders");

  function nowMs() { return Number(new Date(now())); }

  /** 保持期間を過ぎた行を消す。戻り値は消した件数 */
  function purge(at) {
    var t = at === undefined ? nowMs() : Number(at);
    return deleteBefore.run(t - ttlMs).changes;
  }

  /** 配信形式の注文(order-intake の normalizeOrder が返す形)を保存する。同じ id は置き換える */
  function put(order) {
    if (!order || typeof order !== "object" || typeof order.id !== "string" || !order.id) {
      throw new Error("order.id は空でない文字列");
    }
    if (!Number.isFinite(order.start)) throw new Error("order.start は epoch ミリ秒");
    upsert.run(order.id, order.start, JSON.stringify(order), new Date(nowMs()).toISOString());
    purge();
  }

  /** 取消。消せたら true */
  function del(orderId) {
    return remove.run(String(orderId)).changes > 0;
  }

  /**
   * 保持期間内の注文をメモリの Map へ読み戻す。Map に同じ id があればメモリ側を優先する。
   * 壊れた行は読み飛ばして削除する(1行のために全件を失わない)。戻り値は読み戻した件数
   */
  function loadInto(orders, at) {
    purge(at);
    var loaded = 0;
    selectAll.all().forEach(function (row) {
      var order;
      try { order = JSON.parse(row.body); } catch (err) { order = null; }
      if (!order || order.id !== row.id || !Number.isFinite(order.start) || !Array.isArray(order.items)) {
        remove.run(row.id);
        return;
      }
      if (orders.has(order.id)) return;
      orders.set(order.id, order);
      loaded++;
    });
    return loaded;
  }

  function count() { return countAll.get().n; }

  // /api/health は認証なしで開いているため、ファイルの場所は返さず起動ログにだけ出す
  function health() {
    return { store: "sqlite", orders: count() };
  }

  return {
    put: put,
    remove: del,
    purge: purge,
    loadInto: loadInto,
    count: count,
    health: health,
    ttlMs: ttlMs,
    file: filename === ":memory:" ? ":memory:" : path.resolve(filename),
    close: function () { if (db.isOpen) db.close(); },
  };
}

module.exports = { openOrderStore: openOrderStore };
