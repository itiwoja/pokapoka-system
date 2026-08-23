/**
 * booking-resync.js — Booking v1 全件同期と Sync v1 差分同期の状態管理
 *
 * 全ページを取得し終えるまで公開中の store には触れず、成功時だけ新しい Map へ
 * 差し替える。これにより途中ページの失敗やプロセス起動直後の空配信を防ぐ。
 */
"use strict";

var sync = require("./tablecheck-sync");

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

function buildSnapshot(rawReservations, now) {
  if (!Array.isArray(rawReservations)) throw new Error("reservations must be an array");
  var snapshot = new Map();
  rawReservations.forEach(function (raw) {
    var record = sync.normalizeReservation(raw);
    if (record) snapshot.set(record.rid, record);
  });
  sync.purge(snapshot, now);
  return snapshot;
}

function createReservationSync(deps) {
  deps = deps || {};
  if (typeof deps.listReservations !== "function") throw new Error("listReservations is required");
  if (typeof deps.listSyncEvents !== "function") throw new Error("listSyncEvents is required");
  if (typeof deps.getReservation !== "function") throw new Error("getReservation is required");

  var now = typeof deps.now === "function" ? deps.now : function () { return new Date(); };
  var log = typeof deps.log === "function" ? deps.log : function () {};
  var store = new Map();
  var ready = false;
  var lastPoll = { at: null, ok: null, events: 0, error: null };
  var lastResync = { at: null, ok: null, reservations: 0, error: null };
  var tail = Promise.resolve();
  var pendingPoll = null;
  var pendingResync = null;

  async function resyncOnce() {
    var current = new Date(now());
    try {
      var rawReservations = await deps.listReservations(current);
      var snapshot = buildSnapshot(rawReservations, current);
      store = snapshot;
      ready = true;
      lastResync = {
        at: new Date(now()).toISOString(),
        ok: true,
        reservations: snapshot.size,
        error: null,
      };
      log("resync: 当日予約 " + snapshot.size + " 件でstoreを再構築");
    } catch (err) {
      lastResync = {
        at: new Date(now()).toISOString(),
        ok: false,
        reservations: 0,
        error: errorMessage(err),
      };
      log("resync ERROR: " + lastResync.error + " (直前状態を保持)");
    }
    return copyObject(lastResync);
  }

  async function pollOnce() {
    try {
      var events = await deps.listSyncEvents();
      if (!Array.isArray(events)) throw new Error("Sync v1 response must be an array");
      var seenIds = new Set();
      var reservationEvents = events.filter(function (event) {
        if (!event || !/reservation/i.test(event.syncable_type || "") || !event.syncable_id) return false;
        var id = String(event.syncable_id);
        if (seenIds.has(id)) return false;
        seenIds.add(id);
        return true;
      });
      var fetched = [];
      for (var i = 0; i < reservationEvents.length; i++) {
        var id = String(reservationEvents[i].syncable_id);
        var raw = await deps.getReservation(id);
        fetched.push({ rid: id, record: raw == null ? null : sync.normalizeReservation(raw) });
      }

      var nextStore = new Map(store);
      sync.applyFetched(nextStore, fetched);
      sync.purge(nextStore, new Date(now()));
      store = nextStore;
      lastPoll = {
        at: new Date(now()).toISOString(),
        ok: true,
        events: reservationEvents.length,
        error: null,
      };
      if (reservationEvents.length) log("poll: " + reservationEvents.length + " 件のイベントを反映 (store=" + store.size + ")");
    } catch (err) {
      lastPoll = {
        at: new Date(now()).toISOString(),
        ok: false,
        events: 0,
        error: errorMessage(err),
      };
      log("poll ERROR: " + lastPoll.error + " (直前状態を保持)");
    }
    return copyObject(lastPoll);
  }

  function enqueue(kind, task) {
    var pending = kind === "resync" ? pendingResync : pendingPoll;
    if (pending) return pending;

    var run = tail.then(task, task);
    tail = run.then(function () {}, function () {});
    var tracked = run.finally(function () {
      if (kind === "resync" && pendingResync === tracked) pendingResync = null;
      if (kind === "poll" && pendingPoll === tracked) pendingPoll = null;
    });
    if (kind === "resync") pendingResync = tracked;
    else pendingPoll = tracked;
    return tracked;
  }

  function stockResponse(seenAt) {
    if (!ready) {
      return { code: 503, body: { ok: false, error: "initial reservation sync pending" } };
    }
    return { code: 200, body: sync.toKdsStock(store, seenAt == null ? Date.now() : seenAt) };
  }

  function health() {
    return {
      ready: ready,
      store: store.size,
      lastPoll: copyObject(lastPoll),
      lastResync: copyObject(lastResync),
    };
  }

  return {
    resyncOnce: resyncOnce,
    pollOnce: pollOnce,
    enqueueResync: function () { return enqueue("resync", resyncOnce); },
    enqueuePoll: function () { return enqueue("poll", pollOnce); },
    stockResponse: stockResponse,
    health: health,
    storeSnapshot: function () { return new Map(store); },
  };
}

function copyObject(value) { return Object.assign({}, value); }
function errorMessage(err) { return String(err && err.message || err); }

module.exports = {
  DEFAULT_PER_PAGE: DEFAULT_PER_PAGE,
  localDayRange: localDayRange,
  listAllReservations: listAllReservations,
  buildSnapshot: buildSnapshot,
  createReservationSync: createReservationSync,
};
