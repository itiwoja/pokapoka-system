"use strict";

// 退避時に relay-server/booking-resync.js から切り出した TableCheck Booking v1 のページング取得。
// 退避前の tablecheck-source.js は booking.listAllReservations / booking.DEFAULT_PER_PAGE として参照していた。

var DEFAULT_PER_PAGE = 200;
var MAX_PAGES = 1000;

function localDayRange(now) {
  var start = new Date(now);
  if (isNaN(start)) throw new Error("invalid current time");
  start.setHours(0, 0, 0, 0);
  var end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { startAtMin: start.toISOString(), startAtMax: end.toISOString() };
}

async function listAllReservations(fetchPage, options) {
  options = options || {};
  if (typeof fetchPage !== "function") throw new Error("fetchPage is required");
  var perPage = Number(options.perPage) || DEFAULT_PER_PAGE;
  if (perPage < 1 || perPage > DEFAULT_PER_PAGE) throw new Error("perPage must be between 1 and 200");
  var range = localDayRange(options.now || new Date());
  var reservations = [];

  for (var page = 0; page < MAX_PAGES; page++) {
    var query = {
      start_at_min: range.startAtMin,
      start_at_max: range.startAtMax,
      page: page,
      per_page: perPage,
      sort: "start_at",
      sort_order: "asc",
    };
    if (options.shopId) query.shop_ids = String(options.shopId);

    var body = await fetchPage(query);
    if (!body || !Array.isArray(body.reservations)) {
      throw new Error("Booking v1 response must contain reservations array");
    }
    if (body.reservations.length > perPage) {
      throw new Error("Booking v1 response exceeded per_page");
    }
    reservations = reservations.concat(body.reservations);
    if (body.reservations.length < perPage) return reservations;
  }

  throw new Error("Booking v1 pagination exceeded " + MAX_PAGES + " pages");
}

module.exports = {
  DEFAULT_PER_PAGE: DEFAULT_PER_PAGE,
  localDayRange: localDayRange,
  listAllReservations: listAllReservations,
};
