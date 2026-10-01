"use strict";

var httpUtil = require("../http-util");

var json = httpUtil.json;

/** /api/mock/reservations — デモ操作コンソール (/demo) 用の予約作成・変更・取消。MOCK モード専用 */
function handleMock(req, res, url, mock, reservationSync) {
  var parts = url.pathname.replace(/^\/api\/mock\//, "").split("/");
  if (parts[0] !== "reservations") return httpUtil.text(res, 404, "not found");
  var id = null;
  if (parts[1]) {
    try { id = decodeURIComponent(parts[1]); }
    catch (err) { return json(res, { ok: false, error: "invalid reservation id" }, 400); }
  }

  if (req.method === "GET" && !id) return json(res, mock.listReservations());
  if (req.method === "POST" && !id) {
    return httpUtil.readJson(req, res, function (body) {
      afterMutation(res, { ok: true, reservation: mock.createReservation(body || {}) }, reservationSync);
    });
  }
  if (req.method === "PATCH" && id) {
    return httpUtil.readJson(req, res, function (body) {
      var rec = mock.updateReservation(id, body || {});
      if (!rec) return json(res, { ok: false, error: "no such reservation" }, 404);
      afterMutation(res, { ok: true, reservation: rec }, reservationSync);
    });
  }
  if (req.method === "DELETE" && id) {
    var rec = mock.cancelReservation(id);
    if (!rec) return json(res, { ok: false, error: "no such reservation" }, 404);
    return afterMutation(res, { ok: true, reservation: rec }, reservationSync);
  }
  return json(res, { ok: false, error: "method not allowed" }, 405);
}

/* モック側の変更を差分取込で store へ反映してから、最新の予約ストックを添えて応答する */
function afterMutation(res, payload, reservationSync) {
  reservationSync.enqueuePoll().then(function () {
    var stock = reservationSync.stockResponse(Date.now());
    payload.stock = stock.code === 200 ? stock.body : [];
    json(res, payload);
  });
}

module.exports = { handleMock: handleMock };
