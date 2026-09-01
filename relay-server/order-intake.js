/**
 * order-intake.js — 注文端末からの注文受け口 (当日メモリのみ・依存ゼロ)
 *
 * 契約の向き: 我々が受け口を定義し、注文端末チームがそれに合わせて送る (#139)。
 *
 * 受信形式 (注文端末 → relay / POST /api/orders):
 *   { orderId, table, people?, orderedAt?, items:[{ name, qty, note?, allergies? }] }
 * 配信形式 (relay → KDS / GET /api/orders):
 *   { id, table, type:"new", start, people, items:[{ name, qty, options, allergies, done }] }
 *   ※ start は epoch ミリ秒。KDS (kds-a-grid.html) の既存データ契約に合わせている。
 *
 * 方針:
 *   - 卓番はペイロードで受け取る。送信元IPからは引かない (DHCPで入れ替わると注文が黙って別の卓に付く)
 *   - orderId で冪等化する。同じ内容の再送は無変更、内容が違えば同じ注文を更新する
 *   - 保存しない (#115)。プロセスのメモリのみ・TTL 経過で自然に落ちる
 */
"use strict";

var MAX_TABLE_LENGTH = 6;    // seat-occupancy.js と揃える
var MAX_ORDER_ID_LENGTH = 64;
var MAX_ITEMS = 60;
var MAX_NAME_LENGTH = 80;
var MAX_NOTE_LENGTH = 200;
var MAX_QTY = 99;
var MAX_PEOPLE = 99;

function validateTable(value) {
  if (typeof value !== "string") return null;
  var table = value.trim();
  if (!table || table.length > MAX_TABLE_LENGTH) return null;
  return table;
}

function validateOrderId(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  var id = String(value).trim();
  if (!id || id.length > MAX_ORDER_ID_LENGTH) return null;
  return id;
}

/* 任意の注記。空文字は「注記なし」として null に寄せる (KDS 側は null を注記なしとして扱う)。
   undefined を返したときは検証エラー (型違い / 長すぎ) の意味 */
function normalizeNote(value) {
  if (value == null) return null;
  if (typeof value !== "string") return undefined;
  var text = value.trim();
  if (!text) return null;
  if (text.length > MAX_NOTE_LENGTH) return undefined;
  return text;
}

function normalizeItem(raw) {
  if (!raw || typeof raw !== "object") return { error: "item must be an object" };
  var name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) return { error: "item.name is required" };
  if (name.length > MAX_NAME_LENGTH) return { error: "item.name is too long" };

  var qty = raw.qty === undefined || raw.qty === null ? 1 : Number(raw.qty);
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) {
    return { error: "item.qty must be an integer between 1 and " + MAX_QTY };
  }

  // note は注文端末側の呼び名。KDS の表示欄は options なのでここで橋渡しする
  var note = normalizeNote(raw.note !== undefined ? raw.note : raw.options);
  if (note === undefined) return { error: "item.note must be a string of at most " + MAX_NOTE_LENGTH + " characters" };
  var allergies = normalizeNote(raw.allergies);
  if (allergies === undefined) return { error: "item.allergies must be a string of at most " + MAX_NOTE_LENGTH + " characters" };

  return { item: { name: name, qty: qty, options: note, allergies: allergies, done: false } };
}

/**
 * 受信ペイロードを KDS 配信形式へ正規化する。
 * 戻り値は { order } か { error }。エラー文言はそのまま 400 の body に載せて、
 * 別チームが送信側を直せるようにする。
 */
function normalizeOrder(body, now) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "body must be a JSON object" };

  var orderId = validateOrderId(body.orderId);
  if (!orderId) return { error: "orderId must be a non-empty string of at most " + MAX_ORDER_ID_LENGTH + " characters" };

  var table = validateTable(body.table);
  if (!table) return { error: "table must be a non-empty string of at most " + MAX_TABLE_LENGTH + " characters" };

  if (!Array.isArray(body.items) || !body.items.length) return { error: "items must be a non-empty array" };
  if (body.items.length > MAX_ITEMS) return { error: "items must contain at most " + MAX_ITEMS + " entries" };

  var items = [];
  for (var i = 0; i < body.items.length; i++) {
    var result = normalizeItem(body.items[i]);
    if (result.error) return { error: "items[" + i + "]: " + result.error };
    items.push(result.item);
  }

  var people = 0;
  if (body.people !== undefined && body.people !== null) {
    people = Number(body.people);
    if (!Number.isInteger(people) || people < 0 || people > MAX_PEOPLE) {
      return { error: "people must be an integer between 0 and " + MAX_PEOPLE };
    }
  }

  // 注文端末の時計ズレで「未来の注文」になると KDS の経過時間が止まって見えるため、
  // 未来時刻はサーバー時刻へ寄せる (端末の時計合わせは店の運用に依存できない)
  var start = now;
  if (body.orderedAt !== undefined && body.orderedAt !== null) {
    var parsed = typeof body.orderedAt === "number" ? body.orderedAt : Date.parse(String(body.orderedAt));
    if (!Number.isFinite(parsed)) return { error: "orderedAt must be an ISO 8601 datetime" };
    start = Math.min(parsed, now);
  }

  return { order: { id: orderId, table: table, type: "new", start: start, people: people, items: items } };
}

/* 更新対象だけを安定した形へ寄せる。start は初回受付時刻として不変にするため比較しない。 */
function mutableOrderContent(order) {
  return {
    table: order.table,
    people: order.people,
    items: (order.items || []).map(function (item) {
      return {
        name: item.name,
        qty: item.qty,
        options: item.options == null ? null : item.options,
        allergies: item.allergies == null ? null : item.allergies,
      };
    }),
  };
}

function sameOrderContent(a, b) {
  return JSON.stringify(mutableOrderContent(a)) === JSON.stringify(mutableOrderContent(b));
}

/**
 * 注文を投入する。同じ orderId・同じ内容は既存を返し、内容が違えば既存注文を置換する。
 * 更新でも初回の start を維持し、KDS のタイマーと受付順を巻き戻さない。
 * 戻り値は { created, updated, duplicate, order }。
 */
function putOrder(orders, order) {
  var existing = orders.get(order.id);
  if (existing) {
    if (sameOrderContent(existing, order)) {
      return { created: false, updated: false, duplicate: true, order: existing };
    }
    var updated = Object.assign({}, order, { start: existing.start });
    orders.set(order.id, updated);
    return { created: false, updated: true, duplicate: false, order: updated };
  }
  orders.set(order.id, order);
  return { created: true, updated: false, duplicate: false, order: order };
}

function removeOrder(orders, orderId) {
  var id = validateOrderId(orderId);
  return id ? orders.delete(id) : false;
}

/* TTL 超過分を落とす。relay は常駐プロセスなので、掃除しないと日跨ぎで前日の注文が残る (#115) */
function purgeExpired(orders, now, ttlMs) {
  orders.forEach(function (order, id) {
    if (now - order.start > ttlMs) orders.delete(id);
  });
}

/* KDS 配信用の配列。古い注文が先 (KDS 側は受付順に並べる) */
function toFeed(orders, now, ttlMs) {
  purgeExpired(orders, now, ttlMs);
  return Array.from(orders.values()).sort(function (a, b) {
    return a.start - b.start || String(a.id).localeCompare(String(b.id));
  });
}

module.exports = {
  validateTable: validateTable,
  validateOrderId: validateOrderId,
  normalizeOrder: normalizeOrder,
  mutableOrderContent: mutableOrderContent,
  sameOrderContent: sameOrderContent,
  putOrder: putOrder,
  removeOrder: removeOrder,
  purgeExpired: purgeExpired,
  toFeed: toFeed,
};
