"use strict";

// #292: KDS の「＋」で入れた予約を中継サーバー(POST /api/reservations)にも保存する。
// 単一HTML内の実装をそのまま実行する (既存の KDS テストと同じ流儀)。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "kds-a-grid.html"), "utf8");
const reservationStore = require("../relay-server/reservation-store");
const { mergeStock } = require("../relay-server/kds-bridge");

function source(name) {
  const start = html.indexOf("    function " + name + "(");
  assert.notEqual(start, -1, name);
  const end = html.indexOf("\n    }\n", start);
  return html.slice(start, end + 7);
}

function harness(fetchImpl) {
  const ls = {};
  const toasts = [];
  const calls = [];
  const context = vm.createContext({
    LS_BRIDGE_SEEN: "kds_bridge_seen_v1",
    localStorage: { getItem: k => (k in ls ? ls[k] : null) },
    lsSet: (k, v) => { ls[k] = v; },
    safeParse: (j, f) => { try { return JSON.parse(j); } catch (e) { return f; } },
    pad2: n => (n < 10 ? "0" + n : "" + n),
    showPrintToast: m => toasts.push(m),
    console: { error() {} },
    fetch: fetchImpl && ((url, opt) => { calls.push({ url, opt, body: JSON.parse(opt.body) }); return fetchImpl(url, opt); }),
  });
  vm.runInContext(source("saveResToRelay"), context);
  return { context, ls, toasts, calls };
}

const item = { rid: "r1730000000000_42", time: "18:30", adults: 2, kids: 1, name: "山田",
  menu: [{ name: "ごはんA", qty: 2 }] };
const okRes = body => Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ ok: true, reservation: body }) });

test("登録すると rid を渡して POST され、成功しても取込済み(seen)には載せない", async () => {
  const h = harness(() => okRes({}));
  assert.equal(await h.context.saveResToRelay(item), true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, "/api/reservations");
  assert.equal(h.calls[0].opt.method, "POST");
  assert.equal(h.calls[0].body.rid, item.rid);
  assert.match(h.calls[0].body.startAt, /T18:30:00[+-]\d\d:\d\d$/);
  assert.equal(h.ls.kds_bridge_seen_v1, undefined);
  assert.deepEqual(h.toasts, []);
});

test("送った本文はサーバーの検証を通り、/api/stock 取得後も端末で二重にならない", () => {
  let body;
  const h = harness(b => okRes(b));
  h.context.saveResToRelay(item);
  body = h.calls[0].body;
  const rec = reservationStore.validate(body);
  assert.equal(rec.rid, item.rid);
  const incoming = reservationStore.toKdsStock(new Map([[rec.rid, rec]]), Date.now());
  assert.equal(incoming.length, 1);
  const seen = { [item.rid]: 1 };
  const out = mergeStock([item], seen, incoming);
  assert.equal(out.stock.length, 1);
  assert.equal(out.stock[0].rid, item.rid);
});

for (const [label, impl] of [
  ["503", () => Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({ ok: false, error: "reservation store unavailable" }) })],
  ["通信失敗", () => Promise.reject(new TypeError("Failed to fetch"))],
  ["fetch なし", null],
]) {
  test("中継サーバーに保存できない(" + label + ")ときは失敗を表示し、seen には載せない", async () => {
    const h = harness(impl);
    assert.equal(await h.context.saveResToRelay(item), false);
    assert.equal(h.toasts.length, 1);
    assert.match(h.toasts[0], /中継サーバーに保存できませんでした/);
    assert.equal(h.ls.kds_bridge_seen_v1, undefined);
  });
}

test("submitRes は端末のストックに入れてから中継サーバー保存を呼ぶ", () => {
  const body = source("submitRes");
  assert.ok(body.indexOf("stock.push(item)") < body.indexOf("saveResToRelay(item)"));
  assert.ok(body.indexOf("saveStock()") < body.indexOf("saveResToRelay(item)"));
});

test("POST より前に出た /api/stock の応答が後から届いても、入れたばかりの予約は消えない", async () => {
  const h = harness(() => okRes({}));
  await h.context.saveResToRelay(item);
  const seen = JSON.parse(h.ls.kds_bridge_seen_v1 || "{}");
  const out = mergeStock([item], seen, []);
  assert.equal(out.stock.length, 1);
});

test("片づけた予約は seen に載り、サーバーにまだ残っていても次の取得で復活しない", () => {
  const ls = {};
  const context = vm.createContext({
    LS_BRIDGE_SEEN: "kds_bridge_seen_v1",
    localStorage: { getItem: k => (k in ls ? ls[k] : null) },
    lsSet: (k, v) => { ls[k] = v; },
    safeParse: (j, f) => { try { const v = JSON.parse(j); return v == null ? f : v; } catch (e) { return f; } },
  });
  vm.runInContext(source("markResSeen"), context);
  context.markResSeen(item.rid);
  const seen = JSON.parse(ls.kds_bridge_seen_v1);
  assert.deepEqual(seen, { [item.rid]: 1 });
  const rec = reservationStore.validate({ rid: item.rid, startAt: new Date().toISOString(), adults: 2, kids: 0, name: "", menu: item.menu });
  const incoming = reservationStore.toKdsStock(new Map([[rec.rid, rec]]), Date.now());
  assert.equal(mergeStock([], seen, incoming).stock.length, 0);
});

test("削除と来店移動は、ストックから外す前に markResSeen を呼ぶ", () => {
  for (const name of ["deleteRes", "moveResToMain"]) {
    const body = source(name);
    assert.ok(body.indexOf("markResSeen(") !== -1, name);
    assert.ok(body.indexOf("markResSeen(") < body.indexOf("stock = stock.filter("), name);
  }
});
