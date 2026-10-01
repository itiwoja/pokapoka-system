"use strict";

var kitchen = require("../kitchen-state");
var httpUtil = require("../http-util");
var requestAudit = require("../request-audit");

var json = httpUtil.json;

/**
 * 厨房状態の端末間共有 (#132)。
 * 端末は「自分が起こした変更イベント」を POST し、「全体のスナップショット」を GET で取り込む。
 * 差分ではなく畳み込み済みの状態を返すので、遅れて起動した端末も1回の取得で追いつける。
 */
function handleKitchenState(req, res, context) {
  if (req.method === "GET") {
    kitchen.purgeStale(context.state, Date.now(), context.ttlMs);
    return json(res, kitchen.snapshot(context.state));
  }
  if (req.method === "POST") {
    return httpUtil.readJson(req, res, function (body) {
      kitchen.purgeStale(context.state, Date.now(), context.ttlMs);
      var beforeDeleted = Object.assign({}, context.state.deleted);
      var result = kitchen.applyEvents(context.state, body && body.events, Date.now());
      var events = body && Array.isArray(body.events) ? body.events : [];
      events.forEach(function (event) {
        if (!event || event.type !== "deleteOrder") return;
        var applied = !!context.state.deleted[event.id] && !beforeDeleted[event.id];
        requestAudit.recordAudit(context.audit, "order.cancel.kds", requestAudit.auditTarget("order", event.id),
          applied ? (result.error ? "partial" : "success") : (result.error ? "failure" : "success"),
          null, { state: applied ? "deleted" : "unchanged" });
      });
      if (result.error) return json(res, { ok: false, error: result.error }, 400);
      return json(res, { ok: true, rev: result.rev, sessionId: context.state.sessionId });
    });
  }
  return json(res, { ok: false, error: "method not allowed" }, 405);
}

module.exports = { handleKitchenState: handleKitchenState };
