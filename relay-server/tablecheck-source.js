"use strict";

// TableCheck の取得処理。HTTPサーバーから独立させ、モックと実APIを同じ契約で扱う。
var booking = require("./booking-resync");

function createTableCheckSource(config) {
  if (config.isMock) {
    return {
      listReservations: async function () { return config.mock.listReservations(); },
      listSyncEvents: async function () { return config.mock.listSyncEvents(); },
      getReservation: async function (id) { return config.mock.getReservation(id); },
    };
  }
  if (typeof config.fetch !== "function") throw new Error("fetch is required in LIVE mode");

  async function tcFetchJson(pathname, allow404) {
    var controller = new AbortController();
    var timeout = setTimeout(function () { controller.abort(); }, config.requestTimeoutMs || 15000);
    try {
      var res = await config.fetch(config.base + pathname, {
        headers: { "Authorization": "Bearer " + config.apiKey, "Accept": "application/json" },
        signal: controller.signal,
      });
      if (!res.ok && !(allow404 && res.status === 404)) {
        if (res.status === 429) throw new Error("429 レート制限。POLL_MS を見直す");
        throw new Error("TableCheck " + res.status + " " + pathname);
      }
      if (allow404 && res.status === 404) return { status: 404, body: null };
      return { status: res.status, body: await res.json() };
    } catch (err) {
      if (err && err.name === "AbortError") throw new Error("TableCheck request timed out");
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    listReservations: function (current) {
      return booking.listAllReservations(async function (query) {
        var params = new URLSearchParams();
        Object.keys(query).forEach(function (key) { params.set(key, query[key]); });
        var result = await tcFetchJson("/api/booking/v1/reservations?" + params.toString());
        return result.body;
      }, { now: current, shopId: config.shopId, perPage: booking.DEFAULT_PER_PAGE });
    },
    listSyncEvents: async function () {
      var pathname = "/api/sync/v1/sync_events?deliver=true" +
        (config.shopId ? "&shop_id=" + encodeURIComponent(config.shopId) : "");
      var result = await tcFetchJson(pathname);
      var body = result.body;
      return body && body.sync_events || [];
    },
    getReservation: async function (id) {
      var result = await tcFetchJson("/api/booking/v1/reservations/" + encodeURIComponent(id), true);
      if (result.status === 404) return null;
      var body = result.body;
      return body && (body.reservation || body);
    },
  };
}

module.exports = { createTableCheckSource: createTableCheckSource };
