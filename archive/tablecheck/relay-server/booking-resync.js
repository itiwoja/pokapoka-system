/**
 * booking-resync.js — 予約の全件同期と差分同期の状態管理
 *
 * 全件を取得し終えるまで公開中の store には触れず、成功時だけ新しい Map へ
 * 差し替える。これにより取得途中の失敗やプロセス起動直後の空配信を防ぐ。
 * 取得の契約 (全件・差分イベント・個別取得) は TableCheck の Booking v1 / Sync v1 に
 * 合わせて作ったもの。TableCheck 連携は 2026-10-11 に中止し、今の供給源はモックだけ。
 */
"use strict";

var sync = require("./tablecheck-sync");

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
  buildSnapshot: buildSnapshot,
  createReservationSync: createReservationSync,
};
