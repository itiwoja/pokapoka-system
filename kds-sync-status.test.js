"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

var html = fs.readFileSync(path.join(__dirname, "kds-a-grid.html"), "utf8");

test("KDSはrelay同期の全体状態と予約・注文・厨房の経路別表示を持つ", function () {
  assert.match(html, /id="syncStatus"[^>]*data-state="pending"/);
  assert.match(html, /id="syncStatusLabel"/);
  assert.match(html, /id="syncRelayState"/);
  assert.match(html, /id="syncRouteReservations"/);
  assert.match(html, /id="syncRouteOrders"/);
  assert.match(html, /id="syncRouteKitchen"/);
  assert.match(html, /最終成功/);
  assert.match(html, /最終失敗/);
  assert.match(html, /再試行中/);
});

test("KDSの同期表示はブリッジイベントと初期値の両方を購読する", function () {
  assert.match(html, /window\.__KDS_SYNC_STATUS__/);
  assert.match(html, /kds-sync-status/);
  assert.match(html, /function renderSyncStatus\(status\)/);
});
