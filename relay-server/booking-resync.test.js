"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var booking = require("./booking-resync");

function rawReservation(id, startAt, status) {
  return {
    id: id,
    start_at: startAt,
    status: status || "confirmed",
    first_name: "太郎",
    last_name: "山田",
    pax_adult: 2,
    pax_child: 0,
    orders: [{ menu_item_name_translations: { ja: "土鍋御膳" }, qty: 1 }],
  };
}

function localTime(now, hour, minute) {
  var value = new Date(now);
  value.setHours(hour, minute || 0, 0, 0);
  return value.toISOString();
}

test("Booking v1 の全ページを0起点・最大200件で取得する", async function () {
  var now = new Date("2026-07-16T12:34:00+09:00");
  var calls = [];
  var pageBodies = [
    { reservations: [{ id: "r1" }, { id: "r2" }], pagination: { page: 0, per_page: 2 } },
    { reservations: [{ id: "r3" }], pagination: { page: 1, per_page: 2 } },
  ];

  var reservations = await booking.listAllReservations(async function (query) {
    calls.push(Object.assign({}, query));
    return pageBodies[query.page];
  }, { now: now, shopId: "shop-1", perPage: 2 });

  assert.deepEqual(reservations.map(function (r) { return r.id; }), ["r1", "r2", "r3"]);
  assert.deepEqual(calls.map(function (q) { return q.page; }), [0, 1]);
  assert.equal(calls[0].per_page, 2);
  assert.equal(calls[0].shop_ids, "shop-1");

  var start = new Date(now);
  start.setHours(0, 0, 0, 0);
  var end = new Date(start);
  end.setDate(end.getDate() + 1);
  assert.equal(calls[0].start_at_min, start.toISOString());
  assert.equal(calls[0].start_at_max, end.toISOString());
  assert.equal(calls[1].start_at_min, calls[0].start_at_min);
  assert.equal(calls[1].start_at_max, calls[0].start_at_max);
});

test("200件ちょうどのページ後は空ページまで取得する", async function () {
  var calls = [];
  var reservations = await booking.listAllReservations(async function (query) {
    calls.push(query.page);
    return { reservations: query.page === 0 ? new Array(200).fill({ id: "r" }) : [] };
  }, { now: new Date(), perPage: 200 });

  assert.equal(reservations.length, 200);
  assert.deepEqual(calls, [0, 1]);
});

test("不正レスポンスや途中ページ失敗を空一覧成功にしない", async function () {
  await assert.rejects(
    booking.listAllReservations(async function () { return {}; }, { now: new Date() }),
    /reservations/
  );

  await assert.rejects(
    booking.listAllReservations(async function (query) {
      if (query.page === 0) return { reservations: new Array(200).fill({ id: "r" }) };
      throw new Error("page 1 failed");
    }, { now: new Date(), perPage: 200 }),
    /page 1 failed/
  );
  await assert.rejects(
    booking.listAllReservations(async function () {
      return { reservations: [{}, {}, {}] };
    }, { now: new Date(), perPage: 2 }),
    /exceeded per_page/
  );
});

test("初回全件リシンク成功までstockを503にし、消費済みイベントでも全件から復元する", async function () {
  var now = new Date();
  var all = [rawReservation("r1", localTime(now, 18, 30))];
  var service = booking.createReservationSync({
    now: function () { return new Date(now); },
    listReservations: async function () { return all; },
    listSyncEvents: async function () { return []; },
    getReservation: async function () { return null; },
  });

  assert.deepEqual(service.stockResponse(), {
    code: 503,
    body: { ok: false, error: "initial reservation sync pending" },
  });

  await service.resyncOnce();
  var response = service.stockResponse(123);
  assert.equal(response.code, 200);
  assert.deepEqual(response.body.map(function (r) { return r.rid; }), ["r1"]);
});

test("全件成功はstale予約を原子的に除去し、後続失敗時は直前stockを保持する", async function () {
  var now = new Date();
  var all = [rawReservation("old", localTime(now, 18, 0))];
  var fail = false;
  var service = booking.createReservationSync({
    now: function () { return new Date(now); },
    listReservations: async function () {
      if (fail) throw new Error("TableCheck unavailable");
      return all;
    },
    listSyncEvents: async function () { return []; },
    getReservation: async function () { return null; },
  });

  await service.resyncOnce();
  all = [rawReservation("new", localTime(now, 19, 0))];
  await service.resyncOnce();
  assert.deepEqual(service.stockResponse(1).body.map(function (r) { return r.rid; }), ["new"]);

  fail = true;
  await service.resyncOnce();
  assert.deepEqual(service.stockResponse(2).body.map(function (r) { return r.rid; }), ["new"]);
  assert.equal(service.health().ready, true);
  assert.equal(service.health().lastResync.ok, false);
});

test("初回失敗後は未readyのまま、再試行成功でreadyになる", async function () {
  var now = new Date();
  var attempts = 0;
  var service = booking.createReservationSync({
    now: function () { return new Date(now); },
    listReservations: async function () {
      attempts++;
      if (attempts === 1) throw new Error("temporary failure");
      return [];
    },
    listSyncEvents: async function () { return []; },
    getReservation: async function () { return null; },
  });

  await service.resyncOnce();
  assert.equal(service.stockResponse().code, 503);
  await service.resyncOnce();
  assert.equal(service.stockResponse().code, 200);
  assert.deepEqual(service.stockResponse().body, []);
});

test("共通キューは全件リシンクと差分ポールを重ねない", async function () {
  var order = [];
  var releaseResync;
  var service = booking.createReservationSync({
    listReservations: function () {
      order.push("resync:start");
      return new Promise(function (resolve) { releaseResync = function () { order.push("resync:end"); resolve([]); }; });
    },
    listSyncEvents: async function () { order.push("poll"); return []; },
    getReservation: async function () { return null; },
  });

  var resyncPromise = service.enqueueResync();
  var pollPromise = service.enqueuePoll();
  await new Promise(function (resolve) { setImmediate(resolve); });
  assert.deepEqual(order, ["resync:start"]);
  releaseResync();
  await Promise.all([resyncPromise, pollPromise]);
  assert.deepEqual(order, ["resync:start", "resync:end", "poll"]);
});

test("差分ポールはupsertと404削除をcopy-on-writeで反映する", async function () {
  var now = new Date();
  var events = [];
  var records = {};
  var service = booking.createReservationSync({
    now: function () { return new Date(now); },
    listReservations: async function () { return [rawReservation("old", localTime(now, 18, 0))]; },
    listSyncEvents: async function () { return events; },
    getReservation: async function (id) { return records[id] || null; },
  });
  await service.resyncOnce();

  records.new = rawReservation("new", localTime(now, 19, 0));
  events = [
    { syncable_type: "Reservation", syncable_id: "old" },
    { syncable_type: "Reservation", syncable_id: "new" },
    { syncable_type: "Reservation", syncable_id: "new" },
    { syncable_type: "Customer", syncable_id: "ignored" },
    null,
  ];
  await service.pollOnce();

  assert.deepEqual(service.stockResponse(1).body.map(function (r) { return r.rid; }), ["new"]);
  assert.deepEqual(service.health().lastPoll, {
    at: now.toISOString(), ok: true, events: 2, error: null,
  });
});

test("差分ポール失敗は直前storeを保持する", async function () {
  var now = new Date();
  var service = booking.createReservationSync({
    now: function () { return new Date(now); },
    listReservations: async function () { return [rawReservation("keep", localTime(now, 18, 0))]; },
    listSyncEvents: async function () { throw new Error("sync unavailable"); },
    getReservation: async function () { return null; },
  });
  await service.resyncOnce();
  await service.pollOnce();

  assert.deepEqual(service.stockResponse(1).body.map(function (r) { return r.rid; }), ["keep"]);
  assert.equal(service.health().lastPoll.ok, false);
  assert.match(service.health().lastPoll.error, /sync unavailable/);
});

test("snapshotは無効・別日・キャンセル予約を除外し、重複ridは後勝ちにする", function () {
  var now = new Date();
  var yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  var first = rawReservation("same", localTime(now, 18, 0));
  first.first_name = "一郎";
  var second = rawReservation("same", localTime(now, 19, 0));
  second.first_name = "二郎";
  var snapshot = booking.buildSnapshot([
    null,
    { id: "missing-start" },
    first,
    second,
    rawReservation("yesterday", localTime(yesterday, 18, 0)),
    rawReservation("cancelled", localTime(now, 20, 0), "cancelled"),
  ], now);

  assert.equal(snapshot.size, 1);
  assert.equal(snapshot.get("same").name, "山田 二郎");
});

test("入力境界を検証する", async function () {
  assert.throws(function () { booking.localDayRange("invalid"); }, /invalid current time/);
  assert.throws(function () { booking.buildSnapshot({}, new Date()); }, /array/);
  await assert.rejects(
    booking.listAllReservations(async function () { return { reservations: [] }; }, { perPage: 201 }),
    /between 1 and 200/
  );
  assert.throws(function () { booking.createReservationSync({}); }, /listReservations/);
  assert.throws(function () {
    booking.createReservationSync({ listReservations: function () {} });
  }, /listSyncEvents/);
  assert.throws(function () {
    booking.createReservationSync({ listReservations: function () {}, listSyncEvents: function () {} });
  }, /getReservation/);
});
