"use strict";

var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

var loadConfig = require("./load-config");
var serverModule = require("./server");

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
    tablecheck: {
      base: "https://api.tablecheck.com",
      shopId: "shop-1",
      pollMs: 30000,
      resyncMs: 900000,
      timeoutMs: 15000,
      allowCustomBase: false,
    },
    seat: { beforeMin: 30, afterMin: 120 },
  });

  assert.deepEqual(loadConfig.load(file), {
    HOST: "192.168.1.10",
    PORT: "8000",
    TABLECHECK_BASE: "https://api.tablecheck.com",
    SHOP_ID: "shop-1",
    POLL_MS: "30000",
    RESYNC_MS: "900000",
    TABLECHECK_TIMEOUT_MS: "15000",
    TABLECHECK_ALLOW_CUSTOM_BASE: "0",
    SEAT_BEFORE_MIN: "30",
    SEAT_AFTER_MIN: "120",
  });
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

test("APIキーを書いたら起動を止めて環境変数へ誘導する", function () {
  var file = writeConfig({ tablecheck: { apiKey: "secret_key" } });
  assert.throws(function () { loadConfig.load(file); }, /TABLECHECK_API_KEY/);
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
  var source = {
    listReservations: async function () { return []; },
    listSyncEvents: async function () { return []; },
    getReservation: async function () { return null; },
  };
  var configFile = loadConfig.load(writeConfig({
    server: { host: "192.168.1.10", port: 8123 },
    tablecheck: { shopId: "shop-1", pollMs: 60000 },
    seat: { beforeMin: 15, afterMin: 90 },
  }));

  var fromFile = serverModule.createRelay({
    configFile: configFile,
    env: { TABLECHECK_API_KEY: "secret" },
    source: source, mockSource: {},
  });
  assert.equal(fromFile.config.host, "192.168.1.10");
  assert.equal(fromFile.config.port, 8123);
  assert.equal(fromFile.config.shopId, "shop-1");
  assert.equal(fromFile.config.pollMs, 60000);
  assert.equal(fromFile.config.seatBeforeMin, 15);
  assert.equal(fromFile.config.seatAfterMin, 90);
  assert.equal(fromFile.config.isMock, false);

  var overridden = serverModule.createRelay({
    configFile: configFile,
    env: { TABLECHECK_API_KEY: "secret", HOST: "192.168.1.99", SHOP_ID: "shop-2" },
    source: source, mockSource: {},
  });
  assert.equal(overridden.config.host, "192.168.1.99");
  assert.equal(overridden.config.shopId, "shop-2");
  assert.equal(overridden.config.port, 8123, "上書きしていない値はファイルのまま残る");
});

test("ファイル由来の値にも下限クランプとHTTPS検証が効く", function () {
  var source = {
    listReservations: async function () { return []; },
    listSyncEvents: async function () { return []; },
    getReservation: async function () { return null; },
  };
  // LIVE の 30秒下限は、env 経由と同じくファイル経由の値にも適用される
  var clamped = serverModule.createRelay({
    configFile: loadConfig.load(writeConfig({ tablecheck: { shopId: "shop-1", pollMs: 1 } })),
    env: { TABLECHECK_API_KEY: "secret" },
    source: source, mockSource: {},
  });
  assert.equal(clamped.config.pollMs, 30000);

  assert.throws(function () {
    serverModule.createRelay({
      configFile: loadConfig.load(writeConfig({ tablecheck: { shopId: "shop-1", base: "http://evil.test" } })),
      env: { TABLECHECK_API_KEY: "secret" },
      source: source, mockSource: {},
    });
  }, /HTTPS/);
});

test("同梱の config.example.json は雛形として読み込める", function () {
  var example = path.resolve(__dirname, "..", "config", "config.example.json");
  var overlay = loadConfig.load(example);
  assert.equal(overlay.HOST, "auto");   // 起動時にLAN IPv4を自動検出 (#144追補)
  assert.equal(overlay.PORT, "8000");
  assert.equal(overlay.TABLECHECK_BASE, "https://api.tablecheck.com");
});

test.after(function () { fs.rmSync(tmpDir, { recursive: true, force: true }); });
