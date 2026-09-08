"use strict";

// Local HTTP fixture for the existing client contract, not an official API emulator.
// No environment variables, config files, real keys or external requests are used.
var test = require("node:test");
var assert = require("node:assert/strict");
var http = require("node:http");
var events = require("node:events");
var mock = require("./mock-tablecheck");
var serverModule = require("./server");
var booking = require("./booking-resync");

test("TableCheck モックHTTP疎通（実APIの認証・権限・仕様は未検証）", { timeout: 20000 }, async function (t) {
  var shopId = "mock-shop";
  var key = "mock-only-not-a-secret";
  var now = new Date();
  now.setHours(12, 0, 0, 0);
  var requests = [];
  var fault = 0;
  var upstream = http.createServer(function (req, res) {
    var url = new URL(req.url, "http://127.0.0.1");
    function reply(code, body) {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    }
    requests.push(url);
    if (req.headers.authorization !== "Bearer " + key) return reply(401, { error: "mock unauthorized" });
    if (req.headers.accept !== "application/json") return reply(406, {});
    if (fault) return reply(fault, { error: "mock failure" });
    if (url.pathname === "/api/booking/v1/reservations") {
      var q = url.searchParams;
      if (q.get("shop_ids") !== shopId || !q.has("start_at_min") || !q.has("start_at_max") ||
          q.get("sort") !== "start_at" || q.get("sort_order") !== "asc") return reply(400, {});
      var rows = mock.listReservations().filter(function (r) {
        return r.shop_id === q.get("shop_ids") && new Date(r.start_at) >= new Date(q.get("start_at_min")) &&
          new Date(r.start_at) < new Date(q.get("start_at_max"));
      }).sort(function (a, b) { return Date.parse(a.start_at) - Date.parse(b.start_at); });
      var offset = Number(q.get("page")) * Number(q.get("per_page"));
      return reply(200, { reservations: rows.slice(offset, offset + Number(q.get("per_page"))) });
    }
    if (url.pathname === "/api/sync/v1/sync_events") {
      if (url.searchParams.get("deliver") !== "true" || url.searchParams.get("shop_id") !== shopId) return reply(400, {});
      return reply(200, { sync_events: mock.listSyncEvents() });
    }
    var match = /^\/api\/booking\/v1\/reservations\/([^/]+)$/.exec(url.pathname);
    if (match) {
      var r = mock.getReservation(decodeURIComponent(match[1]));
      return reply(r ? 200 : 404, r ? { reservation: r } : {});
    }
    reply(404, {});
  });
  t.after(function () {
    upstream.closeAllConnections();
    return new Promise(function (resolve) { upstream.close(resolve); });
  });
  upstream.listen(0, "127.0.0.1");
  await events.once(upstream, "listening");
  var base = "http://127.0.0.1:" + upstream.address().port;
  function sourceWithKey(apiKey) {
    return serverModule.createTableCheckSource({
      isMock: false, base: base, shopId: shopId, apiKey: apiKey,
      fetch: globalThis.fetch, requestTimeoutMs: 2000,
    });
  }
  var source = sourceWithKey(key);
  var reservation = mock.createReservation({
    id: "mock-connectivity", shop_id: shopId, start_at: now.toISOString(),
    last_name: "疎通", first_name: "テスト", pax_adult: 2, pax_child: 1,
    orders: [{ id: "mock-order-1", name: "土鍋御膳", qty: 3 }],
    questions: [{ id: "mock-question-1", question: "アレルギーはありますか？", answer: "子供1名に卵アレルギー" }],
    special_request: "子供用の椅子を1脚希望",
  });
  var yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  mock.createReservation({ id: "mock-yesterday", start_at: yesterday.toISOString() });
  mock.createReservation({ id: "mock-other-shop", shop_id: "other-shop", start_at: now.toISOString() });
  // Fill one page exactly so that the client's next-page request is exercised.
  for (var i = 0; i < 199; i++) {
    mock.createReservation({ id: "mock-seat-" + i, start_at: now.toISOString() });
  }
  mock.listSyncEvents();

  await t.test("Booking v1: 当日・店舗絞り込みと200件境界のページング", async function () {
    var rows = await source.listReservations(now);
    assert.equal(rows.length, 200);
    assert.deepEqual(rows.find(function (r) { return r.id === reservation.id; }), reservation);
    assert.ok(rows.every(function (r) { return r.shop_id === shopId && r.id !== "mock-yesterday"; }));
    var pages = requests.filter(function (u) { return u.pathname === "/api/booking/v1/reservations"; });
    assert.deepEqual(pages.map(function (u) { return u.searchParams.get("page"); }), ["0", "1"]);
    var range = booking.localDayRange(now);
    assert.equal(pages[0].searchParams.get("start_at_min"), range.startAtMin);
    assert.equal(pages[0].searchParams.get("start_at_max"), range.startAtMax);
  });
  await t.test("Booking v1: 予約詳細の必要項目・メニュー明細・設問回答・要望", async function () {
    var detail = await source.getReservation(reservation.id);
    assert.deepEqual(detail, reservation);
    assert.equal(detail.shop_id, shopId);
    assert.equal(detail.last_name, "疎通");
    assert.equal(detail.first_name, "テスト");
    assert.equal(detail.pax, 3);
    assert.equal(detail.pax_adult, 2);
    assert.equal(detail.pax_child, 1);
    assert.equal(detail.status, "confirmed");
    assert.equal(detail.start_at, now.toISOString());
    assert.ok(Number.isFinite(Date.parse(detail.updated_at)));
    assert.equal(detail.orders[0].id, "mock-order-1");
    assert.equal(detail.orders[0].menu_item_name_translations.ja, "土鍋御膳");
    assert.equal(detail.orders[0].qty, 3);
    assert.deepEqual(detail.questions, [{ id: "mock-question-1", question: "アレルギーはありますか？", answer: "子供1名に卵アレルギー" }]);
    assert.equal(detail.special_request, "子供用の椅子を1脚希望");
    assert.equal(await source.getReservation("missing"), null);
  });

  var sync = booking.createReservationSync(Object.assign({ now: function () { return now; } }, source));
  await t.test("Booking 全件取得から予約ストックへ反映", async function () {
    assert.equal((await sync.resyncOnce()).ok, true);
    var stock = sync.stockResponse().body;
    assert.deepEqual(stock.map(function (r) { return r.rid; }), [reservation.id]);
    assert.equal(stock[0].allergies, "子供1名に卵アレルギー");
    assert.equal(stock[0].request, "子供用の椅子を1脚希望");
  });
  await t.test("Sync v1: 新規イベント→詳細再取得→ストック追加", async function () {
    mock.createReservation({ id: "mock-new", start_at: now.toISOString(), pax_adult: 1, orders: [{ name: "追加御膳", qty: 1 }] });
    assert.equal((await sync.pollOnce()).events, 1);
    assert.ok(sync.stockResponse().body.some(function (r) { return r.rid === "mock-new"; }));
    assert.deepEqual(await source.listSyncEvents(), []);
  });
  await t.test("Sync v1: 人数・メニュー・設問回答・要望の変更", async function () {
    var updated = mock.updateReservation(reservation.id, {
      pax_adult: 3, orders: [{ id: "mock-order-1", name: "土鍋御膳", qty: 4 }],
      questions: [{ id: "mock-question-1", question: "アレルギーはありますか？", answer: "卵・乳" }],
      special_request: "椅子2脚を希望",
    });
    assert.equal((await sync.pollOnce()).events, 1);
    assert.deepEqual(await source.getReservation(reservation.id), updated);
    var stock = sync.stockResponse().body.find(function (r) { return r.rid === reservation.id; });
    assert.equal(stock.adults, 3);
    assert.equal(stock.menu[0].qty, 4);
    assert.equal(stock.allergies, "卵・乳");
    assert.equal(stock.request, "椅子2脚を希望");
    assert.equal((await source.getReservation(reservation.id)).questions[0].answer, "卵・乳");
  });
  await t.test("Sync v1: キャンセルの更新検知→ストック除去", async function () {
    mock.cancelReservation(reservation.id);
    assert.equal((await sync.pollOnce()).events, 1);
    assert.equal((await source.getReservation(reservation.id)).status, "cancelled");
    assert.ok(!sync.stockResponse().body.some(function (r) { return r.rid === reservation.id; }));
  });
  await t.test("模擬401・403・429・500はエラー、同期失敗時は直前状態を保持", async function () {
    await assert.rejects(sourceWithKey("wrong-mock-key").listReservations(now), /401/);
    for (var status of [403, 429, 500]) {
      fault = status;
      await assert.rejects(source.listReservations(now), new RegExp(String(status)));
    }
    var before = sync.stockResponse(0);
    assert.equal((await sync.resyncOnce()).ok, false);
    assert.equal((await sync.pollOnce()).ok, false);
    assert.deepEqual(sync.stockResponse(0), before);
    fault = 0;
    assert.equal((await sync.resyncOnce()).ok, true);
  });
});
