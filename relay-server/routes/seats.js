"use strict";

var seats = require("../seat-occupancy");
var httpUtil = require("../http-util");
var requestAudit = require("../request-audit");

var json = httpUtil.json;
var auditTarget = requestAudit.auditTarget;
var recordAudit = requestAudit.recordAudit;

var SEAT_PREFIX = "/api/seats/";

/** /api/seats — 当日の座席占有の取得・登録・解除 (#123) */
function handleSeats(req, res, url, context) {
  if (url.pathname === "/api/seats" && req.method === "GET") {
    if (!context.reservationSync.health().ready) {
      return json(res, { ok: false, error: "initial reservation sync pending" }, 503);
    }
    return json(res, seats.toOccupiedSeats(
      context.reservationSync.storeSnapshot(),
      context.walkins,
      Date.now(),
      context.beforeMin,
      context.afterMin,
      context.walkinTtlMs
    ));
  }
  if (url.pathname === "/api/seats" && req.method === "POST") {
    return httpUtil.readJson(req, res, function (body) {
      // rid があれば「予約の着席」。卓番はスタッフが KDS で割り当てるローカルデータで、
      // TableCheck 側には無い(あっても希望席種まで)ため、ここが唯一の正本になる
      var requestedTable = body && body.table != null ? String(body.table).trim() : "unknown";
      var previous = context.walkins.get(requestedTable);
      var occupancy = seats.registerWalkin(context.walkins, body && body.table, Date.now(), body);
      if (!occupancy) {
        recordAudit(context.audit, "seat.update", auditTarget("seat", requestedTable), "failure", null,
          { reason: "invalid-table" });
        return json(res, { ok: false, error: "table must be a non-empty string of at most 6 characters" }, 400);
      }
      recordAudit(context.audit, previous ? "seat.update" : "seat.create", auditTarget("seat", occupancy.table),
        "success", previous ? { state: "occupied" } : null,
        { state: "occupied", source: occupancy.rid ? "reservation" : "walkin" });
      json(res, occupancy, 201);
    });
  }
  if (url.pathname.indexOf(SEAT_PREFIX) === 0 && req.method === "DELETE") {
    return releaseSeat(res, httpUtil.pathParam(url.pathname, SEAT_PREFIX), context);
  }
  return json(res, { ok: false, error: "method not allowed" }, 405);
}

/** table は URL から取り出した卓番。デコードできなかった場合は null */
function releaseSeat(res, table, context) {
  function fail(target, reason, error, code) {
    recordAudit(context.audit, "seat.release", target, "failure", null, { reason: reason });
    return json(res, { ok: false, error: error }, code);
  }
  if (table === null) return fail("seat:invalid", "invalid-table", "invalid table", 400);
  var target = auditTarget("seat", table);
  if (!seats.validateTable(table)) return fail(target, "invalid-table", "invalid table", 400);
  if (!seats.releaseWalkin(context.walkins, table)) return fail(target, "not-found", "seat not found", 404);
  recordAudit(context.audit, "seat.release", target, "success", { state: "occupied" }, { state: "released" });
  return httpUtil.noContent(res);
}

module.exports = { handleSeats: handleSeats };
