"use strict";

var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

var loadConfig = require("../load-config");
var serverModule = require("../server");

var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pokapoka-config-"));
var seq = 0;

function writeConfig(contents) {
  var file = path.join(tmpDir, "config-" + (seq++) + ".json");
  fs.writeFileSync(file, typeof contents === "string" ? contents : JSON.stringify(contents));
  return file;
}

test("config.json を環境変数形のオーバーレイへ変換する", function () {
  var file = writeConfig({
    server: { host: "192.168.1.10", port: 8000 },
    reservation: { dbFile: "data/reservations.sqlite" },
    seat: { beforeMin: 30, afterMin: 120 },
    order: { mockScenario: false },
  });

  assert.deepEqual(loadConfig.load(file), {
    HOST: "192.168.1.10",
    PORT: "8000",
    RESERVATION_DB_FILE: "data/reservations.sqlite",
    MOCK_ORDER_SCENARIO: "0",
    SEAT_BEFORE_MIN: "30",
    SEAT_AFTER_MIN: "120",
  });
});

test("auth.cookieSecureを環境変数形へ変換し、環境変数で上書きできる", function () {
  var overlay = loadConfig.load(writeConfig({ auth: { cookieSecure: true } }));
  assert.deepEqual(overlay, { RELAY_COOKIE_SECURE: "1" });
  assert.deepEqual(loadConfig.mergeEnv(overlay, { RELAY_COOKIE_SECURE: "0" }), { RELAY_COOKIE_SECURE: "0" });

  var relay = serverModule.createRelay({
    configFile: overlay,
    env: {},
  });
  assert.equal(relay.config.authCookieSecure, "1");
  assert.throws(function () {
    serverModule.createRelay({ env: { RELAY_COOKIE_SECURE: "yes" } });
  }, /auto \/ 1 \/ 0/);
});

test("ファイルが無ければ空オーバーレイ(環境変数だけで従来どおり動く)", function () {
  assert.deepEqual(loadConfig.load(path.join(tmpDir, "does-not-exist.json")), {});
  assert.deepEqual(loadConfig.load(null), {});
});

test('"_" 始まりのキーは注記として無視する', function () {
  var file = writeConfig({
    _readme: "コピーして使う",
    server: { _host: "ミニPCの固定IP", host: "192.168.1.10" },
  });
  assert.deepEqual(loadConfig.load(file), { HOST: "192.168.1.10" });
});

test("null は未設定扱いで既定値へ委ねる", function () {
  var file = writeConfig({ server: { host: null, port: 8000 } });
  assert.deepEqual(loadConfig.load(file), { PORT: "8000" });
});

test("連携中止した tablecheck セクションと取込間隔のキーは旧雛形の値ごと読み飛ばす", function () {
  var file = writeConfig({
    server: { host: "192.168.1.10" },
    reservation: { pollMs: 3000, resyncMs: 900000 },
    tablecheck: { base: "https://api.tablecheck.com", shopId: "shop-1", pollMs: 30000, apiKey: "secret_key" },
  });
  assert.deepEqual(loadConfig.load(file), { HOST: "192.168.1.10" });
});

test("未知のキー・不正な形は原因を示して弾く", function () {
  assert.throws(function () { loadConfig.load(writeConfig({ server: { hosts: "192.168.1.10" } })); },
    /server\.hosts .*未知のキー/);
  assert.throws(function () { loadConfig.load(writeConfig({ server: "192.168.1.10" })); },
    /server .*オブジェクト/);
  assert.throws(function () { loadConfig.load(writeConfig({ server: { host: ["a"] } })); },
    /server\.host .*文字列・数値・真偽値/);
  assert.throws(function () { loadConfig.load(writeConfig("{ not json")); }, /不正なJSON/);
  assert.throws(function () { loadConfig.load(writeConfig("[]")); }, /オブジェクトである必要/);
});

test("環境変数が config.json より優先される(空文字は未設定扱い)", function () {
  var overlay = { HOST: "192.168.1.10", PORT: "8000" };
  assert.deepEqual(loadConfig.mergeEnv(overlay, { HOST: "192.168.1.99" }),
    { HOST: "192.168.1.99", PORT: "8000" });
  assert.deepEqual(loadConfig.mergeEnv(overlay, { HOST: "" }),
    { HOST: "192.168.1.10", PORT: "8000" });
});

test("config.json の値が relay の設定として実際に効き、環境変数で上書きできる", function () {
  var configFile = loadConfig.load(writeConfig({
    server: { host: "192.168.1.10", port: 8123 },
    reservation: { dbFile: "data/store-a.sqlite" },
    seat: { beforeMin: 15, afterMin: 90 },
  }));

  var fromFile = serverModule.createRelay({
    configFile: configFile,
    env: {},
    reservations: { close: function () {} },
  });
  assert.equal(fromFile.config.host, "192.168.1.10");
  assert.equal(fromFile.config.port, 8123);
  assert.equal(fromFile.config.reservationDbFile, "data/store-a.sqlite");
  assert.equal(fromFile.config.seatBeforeMin, 15);
  assert.equal(fromFile.config.seatAfterMin, 90);

  var overridden = serverModule.createRelay({
    configFile: configFile,
    env: { HOST: "192.168.1.99", RESERVATION_DB_FILE: "data/store-b.sqlite" },
    reservations: { close: function () {} },
  });
  assert.equal(overridden.config.host, "192.168.1.99");
  assert.equal(overridden.config.reservationDbFile, "data/store-b.sqlite");
  assert.equal(overridden.config.port, 8123, "上書きしていない値はファイルのまま残る");
});

test("ファイル由来の値にも下限クランプが効く", function () {
  // 下限は env 経由と同じくファイル経由の値にも適用される
  var clamped = serverModule.createRelay({
    configFile: loadConfig.load(writeConfig({ seat: { walkinTtlMin: 0 }, kitchen: { ttlMin: 99999 } })),
    env: {},
  });
  assert.equal(clamped.config.seatWalkinTtlMs, 120 * 60000, "0以下は既定値");
  assert.equal(clamped.config.kitchenTtlMs, 1440 * 60000, "上限で頭打ち");
});

test("同梱の config.example.json は雛形として読み込める", function () {
  var example = path.resolve(__dirname, "..", "..", "config", "config.example.json");
  var overlay = loadConfig.load(example);
  assert.equal(overlay.HOST, "auto");   // 起動時にLAN IPv4を自動検出 (#144追補)
  assert.equal(overlay.PORT, "8000");
  assert.equal(overlay.POLL_MS, undefined, "取込間隔は廃止");
  assert.equal(overlay.RELAY_COOKIE_SECURE, "auto");
});

test.after(function () { fs.rmSync(tmpDir, { recursive: true, force: true }); });
