"use strict";

var orderIntake = require("../order-intake");
var httpUtil = require("../http-util");
var requestAudit = require("../request-audit");

var json = httpUtil.json;
var auditTarget = requestAudit.auditTarget;
var recordAudit = requestAudit.recordAudit;

var ORDER_PREFIX = "/api/orders/";

/**
 * 注文端末 → relay → KDS の受け口 (#139)。
 * 卓番はペイロードで受け取る (送信元IPからは引かない)。
 * 同じ orderId の同一内容は冪等再送、内容差分は既存注文の更新として扱う。
 */
function handleOrders(req, res, url, context) {
  if (url.pathname === "/api/orders" && req.method === "GET") {
    return json(res, orderIntake.toFeed(context.orders, Date.now(), context.ttlMs));
  }
  if (url.pathname === "/api/orders" && req.method === "POST") {
    return httpUtil.readJson(req, res, function (body) {
      var result = orderIntake.normalizeOrder(body, Date.now());
      var requestedOrderId = body && body.orderId != null ? String(body.orderId) : "unknown";
      if (result.error) {
        recordAudit(context.audit, "order.upsert", auditTarget("order", requestedOrderId), "failure", null,
          { reason: "validation" });
        return json(res, { ok: false, error: result.error }, 400);
      }
      var put = orderIntake.putOrder(context.orders, result.order);
      context.stream.refresh();
      var operation = put.created ? "order.create" : (put.updated ? "order.update" : "order.duplicate");
      recordAudit(context.audit, operation, auditTarget("order", result.order.id), "success", null, {
        itemCount: Array.isArray(result.order.items) ? result.order.items.length : 0,
      });
      // 冪等再送も更新も成功として返す。注文端末は duplicate / updated で結果を識別できる。
      return json(res, {
        ok: true,
        duplicate: put.duplicate,
        updated: put.updated,
        order: put.order,
      }, put.created ? 201 : 200);
    });
  }
  if (url.pathname.indexOf(ORDER_PREFIX) === 0 && req.method === "DELETE") {
    return cancelOrder(res, httpUtil.pathParam(url.pathname, ORDER_PREFIX), context);
  }
  return json(res, { ok: false, error: "method not allowed" }, 405);
}

/** orderId は URL から取り出した注文ID。デコードできなかった場合は null */
function cancelOrder(res, orderId, context) {
  function fail(target, reason, error, code) {
    recordAudit(context.audit, "order.cancel", target, "failure", null, { reason: reason });
    return json(res, { ok: false, error: error }, code);
  }
  if (orderId === null) return fail("order:invalid", "invalid-id", "invalid orderId", 400);
  var target = auditTarget("order", orderId);
  if (!orderIntake.validateOrderId(orderId)) return fail(target, "invalid-id", "invalid orderId", 400);
  if (!orderIntake.removeOrder(context.orders, orderId)) return fail(target, "not-found", "order not found", 404);
  context.stream.refresh();
  recordAudit(context.audit, "order.cancel", target, "success", { state: "active" }, { state: "deleted" });
  return httpUtil.noContent(res);
}

module.exports = { handleOrders: handleOrders };
