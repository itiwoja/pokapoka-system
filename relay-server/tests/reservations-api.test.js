"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
var http = require("node:http");
var events = require("node:events");
var createRelay = require("../server").createRelay;
var store = require("../reservation-store");
var buildXlsx = require("./xlsx-fixture").buildXlsx;

function todayAt(hours, minutes) {
  var d = new Date();
  d.setHours(hours, minutes || 0, 0, 0);
  return d;
}

function pad2(n) { return (n < 10 ? "0" : "") + n; }
function dateStr(d) { return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }
function slashDate(d) { return d.getFullYear() + "/" + (d.getMonth() + 1) + "/" + d.getDate(); }

async function startRelay(t, options) {
  var audits = [];
  var relay = createRelay(Object.assign({
    port: 0, env: {}, log: function () {},
    auditLog: { record: function (entry) { audits.push(entry); } },
  }, options));
  relay.start();
  await events.once(relay.server, "listening");
  t.after(function () { return relay.stop(); });
  return { relay: relay, audits: audits };
}

/** body は JSON にするオブジェクト、または そのまま送る Buffer / 文字列 */
function request(relay, method, pathname, body) {
  var payload = body === undefined ? null : (Buffer.isBuffer(body) || typeof body === "string" ? body : JSON.stringify(body));
  return new Promise(function (resolve, reject) {
    var req = http.request({ host: "127.0.0.1", port: relay.server.address().port, path: pathname, method: method }, function (res) {
      var chunks = [];
      res.on("data", function (chunk) { chunks.push(chunk); });
      res.on("end", function () {
        var raw = Buffer.concat(chunks).toString("utf8");
        var parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch (err) { /* HTML などはそのまま */ }
        resolve({ status: res.statusCode, body: parsed, raw: raw });
      });
    });
    req.on("error", reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

test("A. 手入力: 登録した予約が一覧と厨房の予約ストックに出て、変更・取消できる", async function (t) {
  var ctx = await startRelay(t);
  var relay = ctx.relay;

  var created = await request(relay, "POST", "/api/reservations", {
    startAt: todayAt(18, 30).toISOString(), name: "山田", adults: 2, kids: 1,
    menu: [{ name: "土鍋御膳", qty: 2 }], allergies: "えび",
  });
  assert.equal(created.status, 201);
  var rid = created.body.reservation.rid;
  assert.match(rid, /^[0-9a-f-]{36}$/);

  var stock = await request(relay, "GET", "/api/stock");
  assert.equal(stock.body.length, 1);
  assert.equal(stock.body[0].name, "山田");
  assert.equal(stock.body[0].allergies, "えび");

  var updated = await request(relay, "PUT", "/api/reservations/" + rid, {
    startAt: todayAt(19, 0).toISOString(), name: "山田", adults: 3, menu: [{ name: "土鍋御膳", qty: 3 }],
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.reservation.adults, 3);
  assert.equal((await request(relay, "GET", "/api/stock")).body[0].time, "19:00");

  var one = await request(relay, "GET", "/api/reservations/" + rid);
  assert.equal(one.body.reservation.adults, 3);

  var canceled = await request(relay, "DELETE", "/api/reservations/" + rid);
  assert.equal(canceled.status, 200);
  assert.equal(canceled.body.reservation.status, "canceled");
  assert.deepEqual((await request(relay, "GET", "/api/stock")).body, [], "取消した予約は厨房に出ない");

  var list = await request(relay, "GET", "/api/reservations");
  assert.equal(list.body.date, dateStr(new Date()));
  assert.equal(list.body.reservations.length, 1, "取消済みも一覧には残る");
  assert.equal(list.body.reservations[0].status, "canceled");

  assert.deepEqual(ctx.audits.map(function (a) { return a.operation + ":" + a.result; }),
    ["reservation.create:success", "reservation.update:success", "reservation.cancel:success"]);
  assert.equal(JSON.stringify(ctx.audits).indexOf("山田"), -1, "監査ログに名前を残さない");
  assert.equal(JSON.stringify(ctx.audits).indexOf(rid), -1, "監査ログに生のridを残さない");
});

test("A. 手入力: 不正な入力・存在しない予約・未対応のメソッドを断る", async function (t) {
  var relay = (await startRelay(t)).relay;
  var bad = await request(relay, "POST", "/api/reservations", { name: "山田" });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /startAt/);
  assert.equal((await request(relay, "POST", "/api/reservations", "{")).status, 400);
  assert.equal((await request(relay, "PUT", "/api/reservations/none", { startAt: todayAt(18).toISOString() })).status, 404);
  assert.equal((await request(relay, "DELETE", "/api/reservations/none")).status, 404);
  assert.equal((await request(relay, "GET", "/api/reservations/none")).status, 404);
  assert.equal((await request(relay, "GET", "/api/reservations?date=2026-13-40")).status, 400);
  assert.equal((await request(relay, "GET", "/api/reservations?date=tomorrow")).status, 400);
  assert.equal((await request(relay, "PATCH", "/api/reservations")).status, 405);
  assert.equal((await request(relay, "GET", "/api/reservations/import/csv")).status, 405);
});

test("A. 一覧は指定した日の予約だけを時刻順に返す", async function (t) {
  var relay = (await startRelay(t)).relay;
  var tomorrow = todayAt(12, 0); tomorrow.setDate(tomorrow.getDate() + 1);
  await request(relay, "POST", "/api/reservations", { rid: "late", startAt: todayAt(20).toISOString(), menu: [{ name: "茶" }] });
  await request(relay, "POST", "/api/reservations", { rid: "early", startAt: todayAt(11).toISOString(), menu: [{ name: "茶" }] });
  await request(relay, "POST", "/api/reservations", { rid: "next", startAt: tomorrow.toISOString(), menu: [{ name: "茶" }] });

  var today = await request(relay, "GET", "/api/reservations?date=" + dateStr(new Date()));
  assert.deepEqual(today.body.reservations.map(function (r) { return r.rid; }), ["early", "late"]);
  var next = await request(relay, "GET", "/api/reservations?date=" + dateStr(tomorrow));
  assert.deepEqual(next.body.reservations.map(function (r) { return r.rid; }), ["next"]);
  assert.equal((await request(relay, "GET", "/api/stock")).body.length, 2, "翌日の予約は当日の厨房に出ない");
});

test("B. CSV取込: dryRun は保存せず、本取込は読める行だけ保存し、再取込で増えない", async function (t) {
  var relay = (await startRelay(t)).relay;
  var day = slashDate(new Date());
  var csv = "来店日,来店時間,予約者名,大人,メニュー,アレルギー\n" +
    day + ",18:30,山田,2,土鍋御膳 x2,えび\n" +
    day + ",19:00,佐藤,3,うなぎ x3,\n" +
    "いつか,19:00,鈴木,2,茶,\n";

  var dry = await request(relay, "POST", "/api/reservations/import/csv?dryRun=1", csv);
  assert.equal(dry.status, 200);
  assert.equal(dry.body.dryRun, true);
  assert.equal(dry.body.valid, 2);
  assert.equal(dry.body.failed, 1);
  assert.equal(dry.body.saved, 0);
  assert.equal(dry.body.rows[2].ok, false);
  assert.deepEqual((await request(relay, "GET", "/api/stock")).body, [], "dryRun では保存しない");

  var real = await request(relay, "POST", "/api/reservations/import/csv", csv);
  assert.equal(real.body.saved, 2);
  assert.equal(real.body.failed, 1);
  var stock = (await request(relay, "GET", "/api/stock")).body;
  assert.deepEqual(stock.map(function (r) { return r.name; }), ["山田", "佐藤"]);
  assert.equal(stock[0].allergies, "えび");

  await request(relay, "POST", "/api/reservations/import/csv", csv);
  assert.equal((await request(relay, "GET", "/api/stock")).body.length, 2, "同じCSVの再取込で二重にならない");
});

test("B. CSV取込: Shift_JIS のファイルを読み、来店日時の列が無いファイルは断る", async function (t) {
  var relay = (await startRelay(t)).relay;
  var iconv = require("iconv-lite");
  var csv = "来店日時,名前,人数,メニュー\n" + slashDate(new Date()) + " 18:30,山田,2,土鍋御膳 x2\n";
  var out = await request(relay, "POST", "/api/reservations/import/csv", iconv.encode(csv, "shift_jis"));
  assert.equal(out.body.saved, 1);
  assert.equal((await request(relay, "GET", "/api/stock")).body[0].menu[0].name, "土鍋御膳");

  var bad = await request(relay, "POST", "/api/reservations/import/csv", "名前,人数\n山田,2\n");
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /来店日時の列/);
});

test("B. CSV取込: TableCheck の予約一覧 (.xlsx) を同じ入口で受け、人数の内訳を分けて厨房へ渡す", async function (t) {
  var relay = (await startRelay(t)).relay;
  var day = dateStr(new Date());
  var xlsx = buildXlsx([
    ["予約"],
    ["予約ID", "予約時間", "人数:大人", "人数:シニア", "人数:子供", "人数:幼児", "名前", "電話", "注文", "ステータス"],
    ["TEST01", day + " 18:30", "2", "1", "1", "1", "てすと", "090-0000-0000", "1 × 土鍋御膳, 2 × うなぎ土鍋御膳", "確認"],
  ]);
  var out = await request(relay, "POST", "/api/reservations/import/csv", xlsx);
  assert.equal(out.status, 200);
  assert.equal(out.body.saved, 1);
  var stock = (await request(relay, "GET", "/api/stock")).body;
  assert.equal(stock[0].rid, "TEST01");
  assert.deepEqual([stock[0].adults, stock[0].seniors, stock[0].children, stock[0].kids], [2, 1, 1, 1]);
  assert.deepEqual(stock[0].menu.map(function (m) { return m.name + "×" + m.qty; }), ["土鍋御膳×1", "うなぎ土鍋御膳×2"]);
});

test("C. 貼り付け: 下書きを返すだけで保存しない", async function (t) {
  var relay = (await startRelay(t)).relay;
  var out = await request(relay, "POST", "/api/reservations/import/text", {
    text: "来店日時: " + slashDate(new Date()) + " 18:30\nお名前: 山田 様\n人数: 2名\nメニュー: 土鍋御膳 x2",
  });
  assert.equal(out.status, 200);
  assert.equal(out.body.draft.name, "山田");
  assert.deepEqual(out.body.warnings, []);
  assert.deepEqual((await request(relay, "GET", "/api/stock")).body, []);

  // 下書きはそのまま手入力の POST に渡せる
  var saved = await request(relay, "POST", "/api/reservations", out.body.draft);
  assert.equal(saved.status, 201);
  assert.equal((await request(relay, "GET", "/api/stock")).body[0].name, "山田");

  assert.equal((await request(relay, "POST", "/api/reservations/import/text", { text: "  " })).status, 400);
  assert.equal((await request(relay, "POST", "/api/reservations/import/text", {})).status, 400);
});

test("D. メール: 1通の読み取りは下書きを返すだけで保存しない", async function (t) {
  var relay = (await startRelay(t)).relay;
  var eml = "Subject: reservation\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n" +
    "来店日時: " + slashDate(new Date()) + " 18:30\r\nお名前: 山田 様\r\n人数: 2名\r\nメニュー: 土鍋御膳 x2\r\n";
  var out = await request(relay, "POST", "/api/reservations/import/mail", Buffer.from(eml, "utf8"));
  assert.equal(out.status, 200);
  assert.equal(out.body.subject, "reservation");
  assert.equal(out.body.draft.name, "山田");
  var pasted = await request(relay, "POST", "/api/reservations/import/mail?text=1", "来店日時: " + slashDate(new Date()) + " 19:00\nお名前: 佐藤 様\n");
  assert.equal(pasted.body.draft.name, "佐藤");
  assert.deepEqual((await request(relay, "GET", "/api/stock")).body, []);
  assert.equal((await request(relay, "POST", "/api/reservations/import/mail", "")).status, 400);
});

test("D. メール: 取込フォルダの候補を並べ、登録か破棄で processed へ移す", async function (t) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "pokapoka-mail-"));
  t.after(function () { fs.rmSync(dir, { recursive: true, force: true }); });
  function mail(name, who, time) {
    fs.writeFileSync(path.join(dir, name), "Subject: " + who + "\r\n\r\n来店日時: " + slashDate(new Date()) + " " + time +
      "\r\nお名前: " + who + " 様\r\n人数: 2名\r\nメニュー: 土鍋御膳 x2\r\n");
  }
  mail("a.eml", "yamada", "18:30");
  mail("b.eml", "sato", "19:00");
  fs.writeFileSync(path.join(dir, "ignore.pdf"), "x");
  var relay = (await startRelay(t, { mailInboxPath: dir })).relay;

  var inbox = await request(relay, "GET", "/api/reservations/inbox");
  assert.equal(inbox.body.enabled, true);
  assert.deepEqual(inbox.body.items.map(function (i) { return i.id; }).sort(), ["a.eml", "b.eml"]);
  var a = inbox.body.items.filter(function (i) { return i.id === "a.eml"; })[0];
  assert.equal(a.draft.name, "yamada");
  assert.deepEqual((await request(relay, "GET", "/api/stock")).body, [], "候補は自動では保存しない");

  // 登録すると候補から消える
  var saved = await request(relay, "POST", "/api/reservations", Object.assign({ mailId: "a.eml" }, a.draft));
  assert.equal(saved.status, 201);
  assert.equal(saved.body.reservation.mailId, undefined);
  assert.ok(fs.existsSync(path.join(dir, "processed", "a.eml")));

  // 破棄しても削除はせず processed へ移す
  assert.equal((await request(relay, "DELETE", "/api/reservations/inbox/b.eml")).status, 204);
  assert.ok(fs.existsSync(path.join(dir, "processed", "b.eml")));
  assert.deepEqual((await request(relay, "GET", "/api/reservations/inbox")).body.items, []);

  // フォルダの外や対象外のファイルは動かせない
  assert.equal((await request(relay, "DELETE", "/api/reservations/inbox/b.eml")).status, 404);
  assert.equal((await request(relay, "DELETE", "/api/reservations/inbox/ignore.pdf")).status, 404);
  assert.equal((await request(relay, "DELETE", "/api/reservations/inbox/" + encodeURIComponent("..\\processed\\a.eml"))).status, 404);
  assert.equal((await request(relay, "DELETE", "/api/reservations/inbox/" + encodeURIComponent("../processed/a.eml"))).status, 404);
  assert.ok(fs.existsSync(path.join(dir, "ignore.pdf")));
  assert.ok(fs.existsSync(path.join(dir, "processed", "a.eml")));
});

test("D. メール: 取込フォルダが未設定なら無効として空を返す", async function (t) {
  var relay = (await startRelay(t)).relay;
  var inbox = await request(relay, "GET", "/api/reservations/inbox");
  assert.deepEqual(inbox.body, { ok: true, enabled: false, items: [] });
  assert.equal((await request(relay, "DELETE", "/api/reservations/inbox/a.eml")).status, 404);
});

test("予約入力画面を /reservations で配信し、認証が有効ならAPIもトークンを要求する", async function (t) {
  var open = (await startRelay(t)).relay;
  var page = await request(open, "GET", "/reservations");
  assert.equal(page.status, 200);
  assert.match(page.raw, /予約入力/);
  // 人数の区分は KDS・予約入力画面・中継サーバーで共有する1ファイルから読む
  assert.match(page.raw, /<script src="relay-server\/party-size\.js"><\/script>/);
  var shared = await request(open, "GET", "/relay-server/party-size.js");
  assert.equal(shared.status, 200);
  assert.match(shared.raw, /PartySize/);
  assert.match((await request(open, "GET", "/kds")).raw, /<script src="relay-server\/party-size\.js"><\/script>/);

  var locked = (await startRelay(t, { env: { RELAY_TOKEN: "secret-token-1", RELAY_TRUST_LOOPBACK: "0" } })).relay;
  assert.equal((await request(locked, "GET", "/reservations")).status, 401);
  assert.equal((await request(locked, "POST", "/api/reservations", { startAt: todayAt(18).toISOString() })).status, 401);
});

test("予約ストア: list は指定日の予約を取消済みも含めて返し、過ぎた日を消さない", function (t) {
  var now = new Date(2026, 9, 13, 12, 0, 0);
  var s = store.openReservationStore(":memory:", { now: function () { return now; } });
  t.after(function () { s.close(); });
  s.save({ rid: "y", startAt: new Date(2026, 9, 12, 18, 0).toISOString() });
  s.save({ rid: "t1", startAt: new Date(2026, 9, 13, 19, 0).toISOString() });
  s.save({ rid: "t0", startAt: new Date(2026, 9, 13, 11, 0).toISOString(), status: "canceled" });
  assert.deepEqual(s.list().map(function (r) { return r.rid; }), ["t0", "t1"]);
  assert.deepEqual(s.list("2026-10-12").map(function (r) { return r.rid; }), ["y"]);
  assert.deepEqual(s.list("2026-10-20"), []);
  assert.throws(function () { s.list("2026-02-30"); }, /date/);
  assert.equal(s.health().reservations, 3);
});
