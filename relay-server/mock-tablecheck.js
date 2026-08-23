/**
 * mock-tablecheck.js — TableCheck API のふるまいを模した「可変」デモ供給源
 *
 * API 契約・本番接続の前に、SaaS デモGUI (tablecheck-demo.html) から予約を
 * 作成・変更・キャンセルし、中継サーバー〜KDS(デシャップ) までの疎通を
 * 実際に手で操作して検証するためのモック。server.js が MOCK モードのとき使う。
 *
 * 供給する予約オブジェクトは、2026-07-16 の APIコンソール実機確認で確定した
 * 「本物の TableCheck Reservation スキーマ」に合わせてある:
 *   first_name / last_name, pax / pax_adult / pax_child,
 *   orders[].menu_item_name_translations({ja,en}) / qty / price,
 *   status(enum: confirmed / cancelled ...), special_request, start_at(ISO8601+TZ)
 * → こうしておくと本番切替時は server.js の供給源を tcFetch 実データに
 *    差し替えるだけで、正規化以降の経路は一切変えずに済む。
 *   (出典: knowledge/2026-07-15_テーブルチェックAPI連携_データ定義・裏どり結果.md §6)
 *
 * Sync v1 の "deliver=true" ポーリングを模して、listSyncEvents() は
 * 「前回取得以降に発生した未配信イベント」だけをドレイン方式で返す。
 */
"use strict";

var DB = {};          // id -> Reservation (本物スキーマ)
var queue = [];       // 未配信 SyncEvent の待ち行列 (deliver=true でドレインされる)
var ridSeq = 0;       // mock 予約IDの連番 (kds-bridge が "mock-" を server 由来と判定する)
var evSeq = 0;        // SyncEvent ID の連番

/** ISO8601 (ローカルTZオフセット付き) — TableCheck の start_at 形式に合わせる */
function isoLocal(d) {
  var off = -d.getTimezoneOffset();
  var sign = off >= 0 ? "+" : "-";
  var p = function (n) { return (Math.abs(n) < 10 ? "0" : "") + Math.abs(n); };
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
    "T" + p(d.getHours()) + ":" + p(d.getMinutes()) + ":00" +
    sign + p(Math.floor(off / 60)) + p(off % 60);
}

/** 当日 h:m の start_at 文字列 */
function today(h, m) {
  var d = new Date();
  d.setHours(h, m, 0, 0);
  return isoLocal(d);
}

function nextRid() { return "mock-r" + (++ridSeq); }

function pushEvent(type, id) {
  queue.push({
    id: "ev-" + (++evSeq) + "-" + id,
    event_type: type,                 // "created" | "updated"
    syncable_type: "reservation",
    syncable_id: id,
    created_at: new Date().toISOString(),
  });
}

/** pax の内訳から合計を補完 (未指定なら大人+子供+シニア+乳児) */
function totalPax(r) {
  var n = num(r.pax_adult) + num(r.pax_child) + num(r.pax_senior) + num(r.pax_baby);
  return n > 0 ? n : num(r.pax);
}
function num(v) { return v == null || v === "" || isNaN(Number(v)) ? 0 : Number(v); }

/**
 * 予約を作成する。GUI からは本物スキーマ相当の部分オブジェクトが渡ってくる想定。
 * @param {Object} input - { first_name,last_name,start_at,pax_adult,pax_child,orders[],special_request,status? }
 * @returns {Object} 作成された Reservation
 */
function createReservation(input) {
  input = input || {};
  var id = input.id ? String(input.id) : nextRid();
  var rec = {
    id: id,
    status: input.status || "confirmed",
    start_at: input.start_at || today(19, 0),
    first_name: input.first_name != null ? String(input.first_name) : "",
    last_name: input.last_name != null ? String(input.last_name) : "",
    pax_adult: num(input.pax_adult),
    pax_child: num(input.pax_child),
    pax_senior: num(input.pax_senior),
    pax_baby: num(input.pax_baby),
    orders: normalizeOrders(input.orders),
    special_request: input.special_request != null ? String(input.special_request) : null,
    updated_at: new Date().toISOString(),
  };
  rec.pax = totalPax(rec);
  DB[id] = rec;
  pushEvent("created", id);
  return copy(rec);
}

/** orders 配列を本物の ReservationOrder 形へ整える (GUI からは {name,qty} で来ることも許容) */
function normalizeOrders(orders) {
  if (!Array.isArray(orders)) return [];
  return orders.map(function (o, i) {
    o = o || {};
    var tr = o.menu_item_name_translations;
    if (!tr && o.name) tr = { ja: String(o.name) };   // GUI 簡易入力(name) → 本物形へ
    return {
      id: o.id || ("ord-" + (i + 1)),
      menu_item_name_translations: tr || { ja: "(無名)" },
      qty: num(o.qty) || 1,
      price: o.price != null ? num(o.price) : null,
    };
  }).filter(function (o) {
    // 品名が空の行は落とす (席だけ予約 = orders 空 を意図せず作らないため空文字も除外)
    var ja = o.menu_item_name_translations && o.menu_item_name_translations.ja;
    return ja && String(ja).trim() && String(ja).trim() !== "(無名)";
  });
}

/**
 * 予約を更新する (人数変更・メニュー変更など)。存在しなければ null。
 * @param {string} id
 * @param {Object} patch - 上書きしたいフィールドのみ
 */
function updateReservation(id, patch) {
  id = String(id);
  if (!DB[id]) return null;
  patch = patch || {};
  var rec = DB[id];
  ["first_name", "last_name", "start_at", "special_request", "status"].forEach(function (k) {
    if (patch[k] !== undefined) rec[k] = patch[k];
  });
  ["pax_adult", "pax_child", "pax_senior", "pax_baby"].forEach(function (k) {
    if (patch[k] !== undefined) rec[k] = num(patch[k]);
  });
  if (patch.orders !== undefined) rec.orders = normalizeOrders(patch.orders);
  rec.pax = totalPax(rec);
  rec.updated_at = new Date().toISOString();
  pushEvent("updated", id);
  return copy(rec);
}

/**
 * 予約をキャンセルする (status=cancelled)。中継サーバーの purge で
 * ストックから除去され、デシャップから消える。存在しなければ null。
 */
function cancelReservation(id) {
  id = String(id);
  if (!DB[id]) return null;
  DB[id].status = "cancelled";
  DB[id].updated_at = new Date().toISOString();
  pushEvent("updated", id);
  return copy(DB[id]);
}

/** Sync v1: 未配信イベントをドレインして返す (deliver=true 相当) */
function listSyncEvents() {
  var out = queue;
  queue = [];
  return out;
}

/** Booking v1: 予約1件の実データ取得。404 相当は null */
function getReservation(id) {
  return DB[String(id)] ? copy(DB[String(id)]) : null;
}

/** 現在保持している全予約 (デモGUI の一覧表示用。API には無いが操作確認に便利) */
function listReservations() {
  return Object.keys(DB).map(function (k) { return copy(DB[k]); });
}

/** 起動時のシード。開いてすぐパイプラインが動いているのが見えるよう1件だけ入れる */
function seed() {
  if (Object.keys(DB).length) return;
  createReservation({
    last_name: "山田", first_name: "太郎",
    start_at: today(18, 30),
    pax_adult: 2, pax_child: 1,
    orders: [
      { name: "山城牛の焼きすき土鍋御膳", qty: 2 },
      { name: "うなぎの土鍋御膳", qty: 1 },
    ],
    special_request: "アレルギー: えび (1名)",
  });
}

function copy(o) { return JSON.parse(JSON.stringify(o)); }

module.exports = {
  createReservation: createReservation,
  updateReservation: updateReservation,
  cancelReservation: cancelReservation,
  listSyncEvents: listSyncEvents,
  getReservation: getReservation,
  listReservations: listReservations,
  seed: seed,
};
