"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var sources = require("./helpers/kds-source").readKdsSources();
var html = sources.html;
var js = sources.js;

test("KDSはrelay同期の全体状態と予約・注文・厨房の経路別表示を持つ", function () {
  assert.match(html, /id="syncStatus"[^>]*data-state="pending"/);
  assert.match(html, /id="syncStatusLabel"/);
  assert.match(html, /id="syncRelayState"/);
  assert.match(html, /id="syncRouteReservations"/);
  assert.match(html, /id="syncRouteOrders"/);
  assert.match(html, /id="syncRouteKitchen"/);
  assert.match(html, /最終成功/);
  assert.match(html, /最終失敗/);
  assert.match(js, /再試行中/);
});

test("KDSの同期表示はブリッジイベントと初期値の両方を購読する", function () {
  assert.match(js, /window\.__KDS_SYNC_STATUS__/);
  assert.match(js, /kds-sync-status/);
  assert.match(js, /function renderSyncStatus\(status\)/);
});
