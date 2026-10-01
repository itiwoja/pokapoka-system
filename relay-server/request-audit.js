/**
 * request-audit.js — HTTPリクエストから監査ログ (audit-log.js) へ渡す値を作る
 *
 * 監査ログには個人情報・注文内容・生のIDを残さない。ここで主体 (actor) と対象 (target) を
 * 不透明な形へ変換してから記録する (#210)。
 */
"use strict";

var crypto = require("crypto");

/** 共有トークンは個人を識別しないため、認証方式・任意の端末名・接続元だけを主体とする。 */
function requestActor(req, authMechanism) {
  var headers = req.headers || {};
  var address = req.socket && req.socket.remoteAddress;
  if (typeof address === "string") address = address.replace(/^::ffff:/, "");
  return {
    authMechanism: authMechanism || "unknown",
    device: authMechanism !== "invalid" && typeof headers["x-relay-device"] === "string" ?
      auditTarget("device", headers["x-relay-device"]) : "unknown",
    ip: address || "unknown",
  };
}

function auditRoute(pathname) {
  if (typeof pathname !== "string" || pathname.indexOf("/api/") !== 0) return "page";
  var parts = pathname.split("/").filter(Boolean);
  return "/" + parts.slice(0, 2).join("/");
}

/** 外部入力のIDや端末ラベルを平文保存せず、同じ値を後から照合できる不透明IDにする。 */
function auditTarget(kind, value) {
  if (value === undefined || value === null || value === "" || value === "unknown") return kind + ":unknown";
  var digest = crypto.createHash("sha256").update(String(value), "utf8").digest("hex").slice(0, 16);
  return kind + ":" + digest;
}

function recordAudit(context, operation, target, result, before, after) {
  if (!context || !context.auditLog || typeof context.auditLog.record !== "function") return;
  context.auditLog.record({
    operation: operation,
    target: target,
    result: result,
    actor: context.actor,
    before: before,
    after: after,
  });
}

module.exports = {
  requestActor: requestActor,
  auditRoute: auditRoute,
  auditTarget: auditTarget,
  recordAudit: recordAudit,
};
