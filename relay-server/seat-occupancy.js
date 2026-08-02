/**
 * seat-occupancy.js — 当日の座席占有ビュー (#123)
 *
 * 新規客(ウォークイン)が、この後来店する予約の席を先に埋める「座席バッティング」は
 * TableCheck 側では防げない。新規客の卓番は店内で発生するローカルデータで、
 * クラウドは「新規客が5番卓に座った」ことを知り得ないため。店内で塞ぐしかない。
 *
 * 占有は2つの源から作る:
 *   - ローカル登録: 注文端末/KDSからの明示的な登録 (walk-in と、予約の着席)
 *   - 予約由来: store の予約から時間窓で導出 (予約の変更・キャンセルに自動追随)
 */
"use strict";

var MAX_TABLE_LENGTH = 6;
var MAX_RID_LENGTH = 64;
var MAX_NAME_LENGTH = 40;

function validateTable(value) {
  if (typeof value !== "string") return null;
  var table = value.trim();
  if (!table || table.length > MAX_TABLE_LENGTH) return null;
  return table;
}

function trimTo(value, max) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  var text = String(value).trim();
  return text ? text.slice(0, max) : "";
}

/**
 * ローカルで発生した占有を登録する。
 * meta に rid があれば「予約の着席」として扱う (誰が座っているかを画面に出せる)。
 * 無ければ従来どおり walk-in。
 */
function registerWalkin(walkins, value, now, meta) {
  var table = validateTable(value);
  if (!table) return null;
  var rid = trimTo(meta && meta.rid, MAX_RID_LENGTH);
  var name = trimTo(meta && meta.name, MAX_NAME_LENGTH);
  var occupancy = { table: table, source: rid ? "reservation" : "walkin", since: now };
  if (rid) occupancy.rid = rid;
  if (name) occupancy.name = name;
  walkins.set(table, occupancy);
  return occupancy;
}

function releaseWalkin(walkins, value) {
  var table = validateTable(value);
  return table ? walkins.delete(table) : false;
}

/**
 * 登録から ttlMs を過ぎた占有を落とす。
 * POS 連携が無いため「退店した」というイベントが存在しない。手で解除し忘れた席が
 * 永久に埋まったままになると、実態と合わない表示を誰も信じなくなるので時間で諦める。
 */
function purgeExpired(walkins, now, ttlMs) {
  if (!ttlMs) return 0;
  var removed = 0;
  walkins.forEach(function (item, table) {
    if (now - item.since > ttlMs) { walkins.delete(table); removed++; }
  });
  return removed;
}

function toOccupiedSeats(reservations, walkins, now, beforeMinutes, afterMinutes, ttlMs) {
  purgeExpired(walkins, now, ttlMs);
  var byTable = new Map();
  walkins.forEach(function (item) {
    byTable.set(item.table, Object.assign({}, item));
  });
  var reservationByTable = new Map();
  reservations.forEach(function (rec) {
    var table = validateTable(rec.table);
    var start = Date.parse(rec.startAt);
    var deltaMinutes = (start - now) / 60000;
    if (!table || rec.status !== "booked" || isNaN(start)) return;
    if (deltaMinutes > beforeMinutes || deltaMinutes < -afterMinutes) return;
    var candidate = { table: table, source: "reservation", rid: rec.rid, name: rec.name, since: start };
    var current = reservationByTable.get(table);
    var isCloser = !current || Math.abs(start - now) < Math.abs(current.since - now);
    var isStableTie = current && Math.abs(start - now) === Math.abs(current.since - now) && String(rec.rid) < String(current.rid);
    if (isCloser || isStableTie) reservationByTable.set(table, candidate);
  });
  reservationByTable.forEach(function (item, table) { byTable.set(table, item); });
  return Array.from(byTable.values()).sort(function (a, b) {
    return a.table.localeCompare(b.table, "ja", { numeric: true });
  });
}

module.exports = {
  validateTable: validateTable,
  registerWalkin: registerWalkin,
  releaseWalkin: releaseWalkin,
  purgeExpired: purgeExpired,
  toOccupiedSeats: toOccupiedSeats,
};
