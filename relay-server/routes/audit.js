"use strict";

var httpUtil = require("../http-util");

var json = httpUtil.json;

/** GET /api/audit — 監査ログの閲覧・JSONLエクスポート (#210) */
function handleAudit(req, res, url, context) {
  // 認証無効モードでは誰でも閲覧できてしまうためHTTP公開しない。必要ならOS上の
  // config/audit-log.jsonlを確認し、閲覧APIを使う運用では共有トークンを必須にする。
  if (!context.authToken) return json(res, { ok: false, error: "audit API requires auth.token" }, 403);
  if (req.method !== "GET") return json(res, { ok: false, error: "method not allowed" }, 405);
  var filters = {
    from: url.searchParams.get("from") || undefined,
    to: url.searchParams.get("to") || undefined,
    operation: url.searchParams.get("operation") || undefined,
    target: url.searchParams.get("target") || undefined,
    limit: url.searchParams.get("limit") || undefined,
  };
  if (url.searchParams.get("format") === "jsonl") {
    res.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Content-Disposition": "attachment; filename=relay-audit-log.jsonl",
      "Cache-Control": "no-store",
    });
    return res.end(context.auditLog.exportJSONL(filters));
  }
  return json(res, context.auditLog.query(filters));
}

module.exports = { handleAudit: handleAudit };
