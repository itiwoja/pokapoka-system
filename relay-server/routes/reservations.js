"use strict";

var httpUtil = require("../http-util");
var requestAudit = require("../request-audit");
var reservationStore = require("../reservation-store");
var reservationImport = require("../reservation-import");

var json = httpUtil.json;
var auditTarget = requestAudit.auditTarget;
var recordAudit = requestAudit.recordAudit;

var BASE = "/api/reservations";
var PREFIX = BASE + "/";
var INBOX_PREFIX = BASE + "/inbox/";

/**
 * /api/reservations — 予約の入口。TableCheck 連携の中止 (2026-10-11) を受けた店員の持ち込み用。
 *
 *   A. 手入力      GET・POST /api/reservations、GET・PUT・DELETE /api/reservations/{rid}
 *   B. CSV・Excel  POST /api/reservations/import/csv (?dryRun=1 で保存せず確認だけ)
 *   C. 貼り付け    POST /api/reservations/import/text (下書きを返すだけ。保存は A の POST)
 *   D. メール      POST /api/reservations/import/mail (同上)、
 *                  GET /api/reservations/inbox、DELETE /api/reservations/inbox/{id} (取込フォルダ)
 */
function handleReservations(req, res, url, context) {
  var pathname = url.pathname;
  var method = req.method;

  if (pathname === BASE) {
    if (method === "GET") return listReservations(res, url, context);
    if (method === "POST") return httpUtil.readJson(req, res, function (body) { saveReservation(res, body, null, context); });
    return methodNotAllowed(res);
  }
  if (pathname === BASE + "/import/csv") return method === "POST" ? importCsv(req, res, url, context) : methodNotAllowed(res);
  if (pathname === BASE + "/import/text") return method === "POST" ? importText(req, res, context) : methodNotAllowed(res);
  if (pathname === BASE + "/import/mail") return method === "POST" ? importMail(req, res, url, context) : methodNotAllowed(res);
  if (pathname === BASE + "/inbox") return method === "GET" ? listInbox(res, context) : methodNotAllowed(res);
  if (pathname.indexOf(INBOX_PREFIX) === 0) {
    return method === "DELETE" ? dismissMail(res, httpUtil.pathParam(pathname, INBOX_PREFIX), context) : methodNotAllowed(res);
  }

  var rid = httpUtil.pathParam(pathname, PREFIX);
  if (!rid) return json(res, { ok: false, error: "invalid rid" }, 400);
  if (method === "GET") return getReservation(res, rid, context);
  if (method === "PUT") return httpUtil.readJson(req, res, function (body) { saveReservation(res, body, rid, context); });
  if (method === "DELETE") return cancelReservation(res, rid, context);
  return methodNotAllowed(res);
}

function methodNotAllowed(res) {
  return json(res, { ok: false, error: "method not allowed" }, 405);
}

function unavailable(res, context, err) {
  if (context.log) context.log("予約を読み書きできない: " + (err && err.message || err));
  return json(res, { ok: false, error: "reservation store unavailable" }, 503);
}

/* ---- A. 手入力 ---- */

function listReservations(res, url, context) {
  var date = url.searchParams.get("date") || localDateStr(context.now());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(res, { ok: false, error: "date は YYYY-MM-DD" }, 400);
  var list;
  try { list = context.reservations.list(date); }
  catch (err) {
    if (/^date /.test(err && err.message || "")) return json(res, { ok: false, error: err.message }, 400);
    return unavailable(res, context, err);
  }
  return json(res, { ok: true, date: date, reservations: list });
}

function getReservation(res, rid, context) {
  var record;
  try { record = context.reservations.get(rid); }
  catch (err) { return unavailable(res, context, err); }
  if (!record) return json(res, { ok: false, error: "reservation not found" }, 404);
  return json(res, { ok: true, reservation: record });
}

/** pathRid があれば既存の予約の更新 (PUT)。無ければ作成で、body.rid が既にあれば上書きになる */
function saveReservation(res, body, pathRid, context) {
  var input = Object.assign({}, body);
  var mailId = typeof input.mailId === "string" ? input.mailId : null;
  delete input.mailId;
  if (pathRid) input.rid = pathRid;

  var record;
  try { record = reservationStore.validate(input); }
  catch (err) {
    recordAudit(context.audit, pathRid ? "reservation.update" : "reservation.create",
      auditTarget("reservation", pathRid || "unknown"), "failure", null, { reason: "invalid" });
    return json(res, { ok: false, error: err.message }, 400);
  }

  var existing, saved;
  try {
    existing = context.reservations.get(record.rid);
    if (pathRid && !existing) return json(res, { ok: false, error: "reservation not found" }, 404);
    saved = context.reservations.save(record);
  } catch (err) { return unavailable(res, context, err); }

  // 個人情報は監査ログに残さない。件の特定に使う rid も不透明IDにする
  recordAudit(context.audit, existing ? "reservation.update" : "reservation.create",
    auditTarget("reservation", saved.rid), "success",
    existing ? { status: existing.status } : null, { status: saved.status, source: mailId ? "mail" : "manual" });

  // メールの取込候補から登録したときは、同じメールが候補に残り続けないよう片づける
  if (mailId && context.mailInbox) {
    try { context.mailInbox.archive(mailId); }
    catch (err) { if (context.log) context.log("取込済みメールを移動できない: " + (err && err.message || err)); }
  }
  return json(res, { ok: true, reservation: saved }, existing ? 200 : 201);
}

/** 取消。行は残して status を canceled にする (厨房画面の予約ストックからは次の取込で消える) */
function cancelReservation(res, rid, context) {
  var canceled;
  try { canceled = context.reservations.cancel(rid); }
  catch (err) { return unavailable(res, context, err); }
  if (!canceled) {
    recordAudit(context.audit, "reservation.cancel", auditTarget("reservation", rid), "failure", null, { reason: "not-found" });
    return json(res, { ok: false, error: "reservation not found" }, 404);
  }
  recordAudit(context.audit, "reservation.cancel", auditTarget("reservation", rid), "success", null, { status: "canceled" });
  return json(res, { ok: true, reservation: canceled });
}

/* ---- B. CSV取込 ---- */

function importCsv(req, res, url, context) {
  var dryRun = url.searchParams.get("dryRun") === "1";
  httpUtil.readBuffer(req, res, function (buffer) {
    // TableCheck の予約一覧は .xlsx で受け取るため、CSV と同じ入口で Excel も読む
    var parsed = reservationImport.parseSpreadsheet(buffer, { now: context.now() });
    if (parsed.error) {
      return json(res, { ok: false, error: parsed.error, columns: parsed.columns, unmapped: parsed.unmapped }, 400);
    }

    var saved = 0, failed = 0;
    var rows = parsed.rows.map(function (row) {
      var out = { line: row.line, ok: false, errors: row.errors.slice(), reservation: row.draft };
      if (!out.errors.length) {
        try { out.reservation = reservationStore.validate(row.draft); out.ok = true; }
        catch (err) { out.errors.push(err.message); }
      }
      if (out.ok && !dryRun) {
        try { out.reservation = context.reservations.save(out.reservation); }
        catch (err) {
          if (context.log) context.log("予約を保存できない: " + (err && err.message || err));
          out.ok = false;
          out.errors.push("保存に失敗しました");
        }
      }
      if (out.ok) saved++; else failed++;
      return out;
    });

    if (!dryRun) {
      recordAudit(context.audit, "reservation.import", "reservation:csv", failed ? "partial" : "success",
        null, { saved: saved, failed: failed });
    }
    json(res, {
      ok: true, dryRun: dryRun, columns: parsed.columns, unmapped: parsed.unmapped,
      rows: rows, saved: dryRun ? 0 : saved, valid: saved, failed: failed,
    });
  });
}

/* ---- C. 貼り付け ---- */

function importText(req, res, context) {
  httpUtil.readJson(req, res, function (body) {
    if (!body || typeof body.text !== "string" || !body.text.trim()) {
      return json(res, { ok: false, error: "text は空でない文字列" }, 400);
    }
    var parsed = reservationImport.parseText(body.text, { now: context.now() });
    json(res, { ok: true, draft: parsed.draft, warnings: parsed.warnings });
  });
}

/* ---- D. メール ---- */

/** 本文は .eml のバイト列。?text=1 なら画面に貼り付けた UTF-8 のテキストとして読む */
function importMail(req, res, url, context) {
  var asText = url.searchParams.get("text") === "1";
  httpUtil.readBuffer(req, res, function (buffer) {
    if (!buffer.length) return json(res, { ok: false, error: "メールが空です" }, 400);
    var parsed = reservationImport.parseMail(asText ? buffer.toString("utf8") : buffer, { now: context.now() });
    json(res, { ok: true, draft: parsed.draft, warnings: parsed.warnings, subject: parsed.subject, from: parsed.from });
  });
}

function listInbox(res, context) {
  var inbox = context.mailInbox;
  if (!inbox || !inbox.enabled) return json(res, { ok: true, enabled: false, items: [] });
  try { return json(res, { ok: true, enabled: true, items: inbox.list() }); }
  catch (err) {
    if (context.log) context.log("メールの取込フォルダを読めない: " + (err && err.message || err));
    return json(res, { ok: false, error: "mail inbox unavailable" }, 503);
  }
}

/** 取込候補を登録せずに片づける (processed/ へ移すだけで、削除はしない) */
function dismissMail(res, id, context) {
  var inbox = context.mailInbox;
  var moved = false;
  try { moved = !!(inbox && inbox.enabled && id && inbox.archive(id)); }
  catch (err) {
    if (context.log) context.log("メールを移動できない: " + (err && err.message || err));
    return json(res, { ok: false, error: "mail inbox unavailable" }, 503);
  }
  if (!moved) return json(res, { ok: false, error: "mail not found" }, 404);
  recordAudit(context.audit, "reservation.mail-dismiss", auditTarget("mail", id), "success", null, null);
  return httpUtil.noContent(res);
}

function localDateStr(d) {
  d = new Date(d);
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}

function pad2(n) { return (n < 10 ? "0" : "") + n; }

module.exports = { handleReservations: handleReservations };
