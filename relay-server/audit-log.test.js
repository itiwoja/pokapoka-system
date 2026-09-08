"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var audit = require("./audit-log");

function fixture(options) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "pokapoka-audit-"));
  var errors = [];
  var clock = options && options.clock || { value: Date.parse("2026-09-01T00:00:00.000Z") };
  var log = audit.createAuditLog(Object.assign({
    filePath: path.join(dir, "audit.jsonl"),
    now: function () { return clock.value; },
    logger: { error: function (message) { errors.push(message); } },
  }, options || {}));
  return { dir: dir, log: log, errors: errors, clock: clock };
}

function event(overrides) {
  return Object.assign({
    operation: "seat.release",
    target: "seat:5",
    result: "success",
    actor: { authMechanism: "cookie", device: "kds-a", ip: "192.168.1.20" },
    before: { state: "occupied", table: "5" },
    after: { state: "available", table: "5" },
  }, overrides || {});
}

test("必須項目と最小の変更前後をJSONLへ永続化し、再起動後も読める", function (t) {
  var f = fixture();
  t.after(function () { fs.rmSync(f.dir, { recursive: true, force: true }); });

  var saved = f.log.record(event());
  assert.equal(saved.operation, "seat.release");
  assert.deepEqual(saved.actor, {
    authMechanism: "cookie", device: "kds-a", ip: "192.168.1.20",
  });

  var reopened = audit.createAuditLog({
    filePath: f.log.filePath,
    now: function () { return f.clock.value; },
    logger: { error: function () {} },
  });
  assert.deepEqual(reopened.query(), [saved]);
  assert.equal(fs.readFileSync(f.log.filePath, "utf8").trim(), JSON.stringify(saved));
});

test("日付・操作・対象で検索しJSONLをエクスポートできる", function (t) {
  var f = fixture();
  t.after(function () { fs.rmSync(f.dir, { recursive: true, force: true }); });
  f.log.record(event({ operation: "seat.release", target: "seat:1" }));
  f.clock.value += 60 * 60 * 1000;
  f.log.record(event({ operation: "printer.update", target: "printer:main" }));
  f.clock.value += 60 * 60 * 1000;
  f.log.record(event({ operation: "seat.release", target: "seat:2" }));

  assert.deepEqual(f.log.query({ operation: "seat.release" }).map(function (x) { return x.target; }), ["seat:1", "seat:2"]);
  assert.equal(f.log.query({ target: "printer:main" }).length, 1);
  assert.equal(f.log.query({ from: "2026-09-01T00:30:00Z", to: "2026-09-01T01:30:00Z" })[0].operation, "printer.update");
  var lines = f.log.exportJSONL({ operation: "seat.release" }).trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[1]).target, "seat:2");
});

test("トークン・Cookie・Authorization・生URL・注文/顧客詳細を保存しない", function (t) {
  var f = fixture();
  t.after(function () { fs.rmSync(f.dir, { recursive: true, force: true }); });
  f.log.record(event({
    target: "https://relay.local/api/seats?token=super-secret",
    actor: {
      authMechanism: "Authorization: Bearer super-secret",
      device: "Cookie: relay_token=super-secret",
      ip: "192.168.1.20",
    },
    before: {
      state: "occupied", token: "super-secret", authorization: "Bearer super-secret",
      rawUrl: "https://relay.local/?token=super-secret", order: { items: ["刺身"] },
      customerName: "山田", items: ["刺身"], note: "アレルギー",
    },
  }));

  var raw = fs.readFileSync(f.log.filePath, "utf8");
  assert.doesNotMatch(raw, /super-secret|relay_token|刺身|山田|アレルギー|https:\/\//);
  var saved = f.log.query()[0];
  assert.equal(saved.target, "[redacted]");
  assert.deepEqual(saved.before, { state: "occupied" });
});

test("保持日数と最大件数を常に適用する", function (t) {
  var f = fixture({ retentionDays: 2, maxRecords: 2 });
  t.after(function () { fs.rmSync(f.dir, { recursive: true, force: true }); });
  f.log.record(event({ target: "seat:old" }));
  f.clock.value += 3 * 24 * 60 * 60 * 1000;
  f.log.record(event({ target: "seat:1" }));
  f.log.record(event({ target: "seat:2" }));
  f.log.record(event({ target: "seat:3" }));
  assert.deepEqual(f.log.query().map(function (x) { return x.target; }), ["seat:2", "seat:3"]);
  assert.equal(fs.readFileSync(f.log.filePath, "utf8").trim().split("\n").length, 2);
});

test("書き込み失敗をloggerへ出し、業務処理へ例外を投げない", function (t) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "pokapoka-audit-fail-"));
  t.after(function () { fs.rmSync(dir, { recursive: true, force: true }); });
  var blocker = path.join(dir, "not-a-directory");
  fs.writeFileSync(blocker, "x");
  var errors = [];
  var log = audit.createAuditLog({
    filePath: path.join(blocker, "audit.jsonl"),
    logger: { error: function (message) { errors.push(message); } },
  });
  assert.doesNotThrow(function () { assert.equal(log.record(event()), null); });
  assert.equal(log.query().length, 0, "永続化できなかったイベントを保存済みとして見せない");
  assert.ok(errors.some(function (message) { return /書き込めない/.test(message); }),
    "OSごとの先行read errorに関係なく、write errorも報告する");
});

test("壊れた行は読み飛ばして正常行を利用し続ける", function (t) {
  var f = fixture();
  t.after(function () { fs.rmSync(f.dir, { recursive: true, force: true }); });
  var saved = f.log.record(event());
  fs.appendFileSync(f.log.filePath, "{broken\n");
  var errors = [];
  var reopened = audit.createAuditLog({
    filePath: f.log.filePath,
    now: function () { return f.clock.value; },
    logger: { error: function (message) { errors.push(message); } },
  });
  assert.deepEqual(reopened.query(), [saved]);
  assert.match(errors[0], /不正な行/);
  assert.doesNotMatch(fs.readFileSync(f.log.filePath, "utf8"), /broken/);
});

test("外部から追記された余分な秘密フィールドも再読込時に除去する", function (t) {
  var f = fixture();
  t.after(function () { fs.rmSync(f.dir, { recursive: true, force: true }); });
  var saved = f.log.record(event());
  saved.token = "must-not-survive";
  saved.before.customerName = "顧客名";
  fs.writeFileSync(f.log.filePath, JSON.stringify(saved) + "\n");

  var reopened = audit.createAuditLog({ filePath: f.log.filePath, now: function () { return f.clock.value; } });
  assert.equal(reopened.query()[0].token, undefined);
  assert.deepEqual(reopened.query()[0].before, { state: "occupied", table: "5" });
  assert.doesNotMatch(fs.readFileSync(f.log.filePath, "utf8"), /must-not-survive|顧客名/);
});

test("時刻だけ進んだ場合も検索結果から保持期限切れを除く", function (t) {
  var f = fixture({ retentionDays: 1 });
  t.after(function () { fs.rmSync(f.dir, { recursive: true, force: true }); });
  f.log.record(event());
  f.clock.value += 2 * 24 * 60 * 60 * 1000;
  assert.deepEqual(f.log.query(), []);
  assert.equal(f.log.prune(), 1);
});
