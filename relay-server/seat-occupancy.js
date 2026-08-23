"use strict";

var MAX_TABLE_LENGTH = 6;

function validateTable(value) {
  if (typeof value !== "string") return null;
  var table = value.trim();
  if (!table || table.length > MAX_TABLE_LENGTH) return null;
  return table;
}

function registerWalkin(walkins, value, now) {
  var table = validateTable(value);
  if (!table) return null;
  var occupancy = { table: table, source: "walkin", since: now };
  walkins.set(table, occupancy);
  return occupancy;
}

function releaseWalkin(walkins, value) {
  var table = validateTable(value);
  return table ? walkins.delete(table) : false;
}

function toOccupiedSeats(reservations, walkins, now, beforeMinutes, afterMinutes) {
  var byTable = new Map();
  walkins.forEach(function (item) {
    byTable.set(item.table, { table: item.table, source: "walkin", since: item.since });
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
  toOccupiedSeats: toOccupiedSeats,
};
