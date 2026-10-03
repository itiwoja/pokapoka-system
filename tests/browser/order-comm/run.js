"use strict";
/* 注文通信のブラウザ検証ランナー (検証専用。製品コードは変更しない)。
 *   node run.js --root <order-client.js と relay-server を含むcloneのパス> --label main --out <出力dir>
 * 環境変数: PW_MODULE (playwright-core のパス), CHROME_PATH (chromiumの実行ファイル), BASE_PORT (既定 4410)
 * 外部通信なし: relay は MOCK モード・127.0.0.1 限定。 */
var cp = require("child_process");
var fs = require("fs");
var path = require("path");
var http = require("http");
var assert = require("assert");
var proxyLib = require("./harness-proxy");

var args = {};
for (var i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
var ROOT = path.resolve(args.root), LABEL = args.label || "run", OUT = path.resolve(args.out || ".");
var BASE = +(process.env.BASE_PORT || 4410);
var pw = require(process.env.PW_MODULE || "playwright-core");
fs.mkdirSync(OUT, { recursive: true });

var portSeq = 0, lastWait = null;
var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

function httpJson(port, p, headers) {
  return new Promise(function (resolve, reject) {
    http.get({ host: "127.0.0.1", port: port, path: p, headers: headers || {} }, function (res) {
      var c = []; res.on("data", function (d) { c.push(d); });
      res.on("end", function () { try { resolve(JSON.parse(Buffer.concat(c).toString("utf8"))); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}

async function startEnv(opts) {
  opts = opts || {};
  var proxyPort = BASE + 2 * (portSeq++), relayPort = proxyPort + 1;  // シナリオごとに別ポート (4410〜)
  var env = Object.assign({}, process.env, { HOST: "127.0.0.1", PORT: String(relayPort), MOCK: "1", TABLECHECK_API_KEY: "" });
  delete env.TABLECHECK_API_KEY; delete env.MOCK_ORDER_SCENARIO;
  if (opts.token) { env.RELAY_TOKEN = opts.token; env.RELAY_TRUST_LOOPBACK = "0"; }
  var relay = cp.spawn(process.execPath, ["relay-server/server.js"], { cwd: ROOT, env: env, stdio: "ignore" });
  var up = false;
  for (var n = 0; n < 60 && !up; n++) {
    try { await httpJson(relayPort, "/api/health"); up = true; } catch (e) { await sleep(250); }
  }
  if (!up) { relay.kill(); throw new Error("relay did not start"); }
  var proxy = await proxyLib.startProxy({ port: proxyPort, relayPort: relayPort, root: ROOT });
  var e = {
    origin: "http://127.0.0.1:" + proxyPort, relayPort: relayPort, proxy: proxy, token: opts.token || null,
    ctl: function (cfg) {
      return new Promise(function (resolve) {
        var r = http.request({ host: "127.0.0.1", port: proxyPort, path: "/__ctl", method: "POST" }, function (res) { res.resume(); res.on("end", resolve); });
        r.end(JSON.stringify(cfg));
      });
    },
    feed: function () { return httpJson(relayPort, "/api/orders", e.token ? { Authorization: "Bearer " + e.token } : {}); },
    posts: function () { return proxy.getStats().posts; },
    stop: async function () { await proxy.close(); relay.kill("SIGKILL"); await sleep(200); }
  };
  return e;
}

var IDB_FAULT_INIT = function () {
  window.__idbFault = { open: false, op: null, skip: 0, how: null };
  var open = IDBFactory.prototype.open;
  IDBFactory.prototype.open = function () {
    if (window.__idbFault.open) {
      var fake = { error: new DOMException("simulated storage unavailable", "UnknownError") };
      setTimeout(function () { if (fake.onerror) fake.onerror(new Event("error")); }, 0);
      return fake;
    }
    return open.apply(this, arguments);
  };
  ["add", "put"].forEach(function (op) {
    var orig = IDBObjectStore.prototype[op];
    IDBObjectStore.prototype[op] = function () {
      var f = window.__idbFault;
      if (f.op === op && f.how) {
        if (f.skip > 0) { f.skip--; return orig.apply(this, arguments); }
        if (f.how === "throw") throw new DOMException("simulated quota exceeded", "QuotaExceededError");
        var r = orig.apply(this, arguments); this.transaction.abort(); return r;
      }
      return orig.apply(this, arguments);
    };
  });
};

var results = [];
async function scenario(id, title, fn, browser, envOpts) {
  if (process.env.ONLY && !new RegExp(process.env.ONLY).test(id)) return;
  lastWait = null;
  var sc = { id: id, title: title, checks: [], notes: [], pass: true };
  var env, ctx;
  try {
    env = await startEnv(envOpts);
    ctx = await browser.newContext();
    await ctx.addInitScript(IDB_FAULT_INIT);
    var page = await ctx.newPage();
    env.clientPosts = 0;  // ブラウザ(fetch)が発行したPOST数。Chromium内部の再試行は数えない
    page.on("request", function (r) { if (r.method() === "POST" && /\/api\/orders$/.test(r.url())) env.clientPosts++; });
    var consoleLog = []; page.on("console", function (m) { consoleLog.push(m.type() + ": " + m.text()); });
    page.on("pageerror", function (e) { consoleLog.push("pageerror: " + e.message); });
    sc.check = function (name, cond, actual) { sc.checks.push({ name: name, ok: !!cond, actual: actual === undefined ? null : actual }); if (!cond) sc.pass = false; };
    sc.note = function (t) { sc.notes.push(t); };
    await fn(sc, env, ctx, page);
    sc.console = consoleLog.slice(0, 20);
    if (!sc.pass && lastWait) sc.notes.push("最後の待機失敗の状態: " + JSON.stringify(lastWait));
  } catch (e) {
    sc.pass = false; sc.checks.push({ name: "exception", ok: false, actual: String(e && e.stack || e).split("\n").slice(0, 3).join(" | ") });
  } finally {
    try { if (ctx) await ctx.close(); } catch (e) {}
    try { if (env) await env.stop(); } catch (e) {}
  }
  results.push(sc);
  console.log((sc.pass ? "PASS " : "FAIL ") + id + " " + title);
  sc.checks.filter(function (c) { return !c.ok; }).forEach(function (c) { console.log("   x " + c.name + " => " + JSON.stringify(c.actual)); });
}

async function open(env, page, query, init) {
  await page.goto(env.origin + "/harness" + (query || ""));
  if (init !== false) await page.evaluate(function () { window.initClient(); });
}
var list = function (page) { return page.evaluate(function () { return window.client.list(); }); };
async function waitStatus(page, id, statuses, ms) {
  statuses = [].concat(statuses); var end = Date.now() + (ms || 8000), last = null;
  while (Date.now() < end) {
    var l = await list(page); last = l.find(function (r) { return !id || r.orderId === id; });
    // "pending+error" は再送待ち(送信失敗後)。error の無い pending は送信前の初期状態なので区別する
    if (last && statuses.indexOf(last.status) >= 0) return last;
    if (last && statuses.indexOf("retrying") >= 0 && last.status === "pending" && last.error) return last;
    await sleep(100);
  }
  lastWait = { want: statuses, last: last, changes: await page.evaluate(function () { return window.__changes; }) };
  return null;
}
var statusNow = async function (page, id) { var l = await list(page); var r = l.find(function (x) { return x.orderId === id; }); return r ? r.status : null; };
var submitCart = async function (page) { await page.click("#confirm"); await page.waitForFunction(function () { return window.__lastId || document.getElementById("err").textContent; }); return page.evaluate(function () { return window.__lastId || null; }); };
var P = function (id, extra) { return Object.assign({ orderId: id, table: "T1", people: 2, items: [{ name: "土鍋御膳", qty: 2, note: "辛さ控えめ", allergies: "えび" }] }, extra || {}); };

(async function () {
  var launch = { headless: true, args: ["--no-sandbox"] };
  if (process.env.CHROME_PATH) launch.executablePath = process.env.CHROME_PATH;
  var browser = await pw.chromium.launch(launch);
  var meta = { label: LABEL, root: ROOT, commit: cp.execSync("git rev-parse HEAD", { cwd: ROOT }).toString().trim(),
    clientSha256: require("crypto").createHash("sha256").update(fs.readFileSync(path.join(ROOT, "order-client.js"))).digest("hex"),
    browser: browser.version(), node: process.version, playwright: require((process.env.PW_MODULE || "playwright-core") + "/package.json").version,
    startedAt: new Date().toISOString() };

  /* ---------- #249 ---------- */
  await scenario("A249-1", "保存完了後に送信される (リクエスト時点でIndexedDBにsending記録がある)", async function (sc, env, ctx, page) {
    await open(env, page);
    var atRequest = null;
    await page.route("**/api/orders", async function (route) {
      if (route.request().method() === "POST") {
        var raw = await page.evaluate(function () { return window.rawRecords(); });
        atRequest = { raw: raw, body: route.request().postData() };
      }
      await route.continue();
    });
    var id = (await page.evaluate(function (p) { return window.directSubmit(p); }, P("k249-1"))).id;
    await sleep(500);
    var raw0 = await page.evaluate(function () { return window.rawRecords(); });
    sc.check("submit直後・start前は送信0件でIDB記録はpending", env.posts().length === 0 && raw0.length === 1 && raw0[0].status === "pending", { posts: env.posts().length, raw: raw0.map(function (r) { return r.status; }) });
    await page.evaluate(function () { return window.client.flush(); });
    sc.check("リクエスト時点でIDBに同IDのsending記録が存在", atRequest && atRequest.raw.length === 1 && atRequest.raw[0].orderId === id && atRequest.raw[0].status === "sending", atRequest && atRequest.raw.map(function (r) { return r.status; }));
    sc.check("送信本文 = IDB保存済みpayload", atRequest && JSON.stringify(JSON.parse(atRequest.body)) === JSON.stringify(atRequest.raw[0].payload), null);
    sc.check("ACK後 sent・relay 1件", (await statusNow(page, id)) === "sent" && (await env.feed()).length === 1, null);
  }, browser);

  await scenario("A249-2", "未送信注文を保存して再読込 → 同じID・内容・時刻が復元され、同内容で送信される", async function (sc, env, ctx, page) {
    await open(env, page);
    await env.ctl({ mode: "drop-before" });
    var id = (await page.evaluate(function (p) { return window.directSubmit(p); }, P("k249-2", { items: [{ name: "土鍋御膳", qty: 2, note: "辛さ控えめ・ねぎ抜き", allergies: "えび" }, { name: "出汁巻き", qty: 1 }] }))).id;
    var before = (await page.evaluate(function () { return window.rawRecords(); }))[0];
    await page.reload(); await page.evaluate(function () { window.initClient(); });
    var after = (await list(page))[0];
    sc.check("再読込後も1件・同じorderId", after && after.orderId === id, after && after.orderId);
    sc.check("payload(内容)が一致", JSON.stringify(before.payload) === JSON.stringify(after.payload), after && after.payload);
    sc.check("createdAt・orderedAt(時刻)が一致", before.createdAt === after.createdAt && before.payload.orderedAt === after.payload.orderedAt, { createdAt: after && after.createdAt, orderedAt: after && after.payload.orderedAt });
    sc.check("再読込直後はまだ未送信(pending)でrelay 0件", after.status === "pending" && (await env.feed()).length === 0, after && after.status);
    await env.ctl({ mode: "pass" });
    await page.evaluate(function () { window.client.start(); });
    var sent = await waitStatus(page, id, "sent");
    sc.check("復旧後に送信されsent", !!sent, null);
    var posts = env.posts().filter(function (p) { return p.relayStatus; });
    sc.check("relayへ届いた本文 = 保存済みpayload", posts.length === 1 && JSON.stringify(JSON.parse(posts[0].body)) === JSON.stringify(before.payload), posts.length);
    var feed = await env.feed();
    sc.check("relayの受付は1件・商品内容一致", feed.length === 1 && feed[0].id === id && feed[0].items.length === 2 && feed[0].items[0].options === "辛さ控えめ・ねぎ抜き", feed.map(function (o) { return o.id; }));
  }, browser);

  var failCases = [
    { id: "A249-3a", title: "保存失敗(add の transaction abort): 送信されず・エラー通知・カート保持", fault: { op: "add", skip: 0, how: "abort" } },
    { id: "A249-3b", title: "保存失敗(add が QuotaExceededError を送出): 送信されず・エラー通知・カート保持", fault: { op: "add", skip: 0, how: "throw" } }
  ];
  for (var fc of failCases) {
    await (function (fc) { return scenario(fc.id, fc.title, async function (sc, env, ctx, page) {
      await open(env, page);
      await page.evaluate(function () { window.client.start(); });
      await page.evaluate(function (f) { window.__idbFault = Object.assign({ open: false }, f); }, fc.fault);
      await page.click("#confirm");
      await page.waitForFunction(function () { return document.getElementById("err").textContent; });
      await sleep(2500);
      var err = await page.textContent("#err");
      sc.check("画面にエラー表示", /保存できませんでした/.test(err), err);
      sc.check("relayへ1件も送信されない", env.posts().length === 0 && (await env.feed()).length === 0, env.posts().length);
      sc.check("IDBに記録が残らない", (await page.evaluate(function () { return window.rawRecords(); })).length === 0, null);
      sc.check("カートが保持され確定ボタンが再度有効", (await page.locator("#cart li").count()) === 2 && !(await page.locator("#confirm").isDisabled()), null);
      sc.check("sent扱いの記録が無い", !(await page.evaluate(function () { return window.__changes; })).some(function (c) { return c.status === "sent"; }), null);
      await page.evaluate(function () { window.__idbFault = { open: false, op: null, skip: 0, how: null }; });
      await page.click("#confirm");
      var ok = await waitStatus(page, null, "sent");
      sc.check("保存が回復すれば同じカートを再確定でき1件だけ受付", !!ok && (await env.feed()).length === 1, null);
    }, browser); })(fc);
  }

  await scenario("A249-3c", "sending への状態保存に失敗 → 送信されない (保存完了前に送信しない)", async function (sc, env, ctx, page) {
    await open(env, page);
    var id = (await page.evaluate(function (p) { return window.directSubmit(p); }, P("k249-3c"))).id;
    await page.evaluate(function () { window.__idbFault = { open: false, op: "put", skip: 0, how: "abort" }; });
    var threw = await page.evaluate(function () { return window.client.flush().then(function () { return null; }, function (e) { return e.message; }); });
    sc.check("flushがエラーで終わる", !!threw, threw);
    sc.check("送信0件・relay 0件", env.posts().length === 0 && (await env.feed()).length === 0, env.posts().length);
    var raw = (await page.evaluate(function () { return window.rawRecords(); }))[0];
    sc.check("IDB記録はpendingのまま(sentではない)", raw.status === "pending", raw.status);
    await page.evaluate(function () { window.__idbFault = { open: false, op: null, skip: 0, how: null }; });
    await page.evaluate(function () { return window.client.flush(); });
    sc.check("保存が回復すれば送信されsent", (await statusNow(page, id)) === "sent", null);
  }, browser);

  await scenario("A249-3d", "ACK受信後に sent の保存が失敗 → 端末はsentにせず、再読込後に同IDで再送しrelayは重複受付しない", async function (sc, env, ctx, page) {
    await open(env, page);
    var id = (await page.evaluate(function (p) { return window.directSubmit(p); }, P("k249-3d"))).id;
    await page.evaluate(function () { window.__idbFault = { open: false, op: "put", skip: 1, how: "abort" }; });
    var threw = await page.evaluate(function () { return window.client.flush().then(function () { return null; }, function (e) { return e.message; }); });
    sc.check("sent保存失敗でflushがエラー", !!threw, threw);
    var raw = (await page.evaluate(function () { return window.rawRecords(); }))[0];
    sc.check("relayは1件受付済みだがIDB記録はsendingのまま(sentにならない)", (await env.feed()).length === 1 && raw.status === "sending", { status: raw.status, feed: (await env.feed()).length });
    await page.reload(); await page.evaluate(function () { window.initClient(); });
    await page.evaluate(function () { return window.client.flush(); });
    sc.check("再読込後に同IDで再送→sent", (await statusNow(page, id)) === "sent", null);
    var posts = env.posts();
    sc.check("POSTは2回・同一本文・2回目はrelayがduplicate判定・受付は1件のまま", posts.length === 2 && posts[0].body === posts[1].body && posts[1].duplicate === true && (await env.feed()).length === 1, posts.map(function (p) { return { created: p.created, duplicate: p.duplicate }; }));
  }, browser);

  /* ---------- #263 / #249 ---------- */
  await scenario("P263-1", "既存IDへのsubmit拒否の理由が分かる (#263-1) / 元の記録は上書きされない", async function (sc, env, ctx, page) {
    await open(env, page);
    var first = await page.evaluate(function (p) { return window.directSubmit(p); }, P("k263-1"));
    var rawBefore = (await page.evaluate(function () { return window.rawRecords(); }))[0];
    var second = await page.evaluate(function (p) { return window.directSubmit(p); }, P("k263-1", { items: [{ name: "別の品", qty: 9 }] }));
    sc.check("2回目のsubmitは拒否される", first.ok && !second.ok, second);
    sc.note("拒否時のメッセージ: " + second.message);
    sc.check("メッセージが重複IDを示す (保存失敗と区別できる)", /既に|重複|既存/.test(second.message || "") && !/保存に失敗/.test(second.message || ""), second.message);
    var rawAfter = (await page.evaluate(function () { return window.rawRecords(); }));
    sc.check("元の注文は1件のまま内容不変", rawAfter.length === 1 && JSON.stringify(rawAfter[0]) === JSON.stringify(rawBefore), null);
  }, browser);

  await scenario("P263-2", "sendingへ遷移したらエラー文言が消える (#263-2)", async function (sc, env, ctx, page) {
    await open(env, page);
    await env.ctl({ mode: "drop-before", times: 2 });  // Chromium の内部再試行1回ぶんを含めて落とす
    var id = (await page.evaluate(function (p) { return window.directSubmit(p); }, P("k263-2"))).id;
    await page.evaluate(function () { return window.client.flush(); });
    var pending = await waitStatus(page, id, "retrying", 2000);
    if (process.env.DEBUG_RUN) console.log(JSON.stringify(await list(page)), JSON.stringify(env.posts().map(function (p) { return p.mode; })));
    sc.check("1回目の失敗でpending+エラー文言", pending && pending.error, pending);
    await sleep(1100);
    await page.evaluate(function () { return window.client.flush(); });
    var ch = await page.evaluate(function () { return window.__changes; });
    var sendingAfterRetry = ch.filter(function (c) { return c.status === "sending" && c.retryCount >= 1; });
    sc.note("再送時のsending通知: " + JSON.stringify(sendingAfterRetry));
    sc.check("再送のsending通知で error が null", sendingAfterRetry.length >= 1 && sendingAfterRetry.every(function (c) { return c.error === null; }), sendingAfterRetry);
    sc.check("最終的にsent", (await statusNow(page, id)) === "sent", null);
  }, browser);

  await scenario("P263-3", "IndexedDB open失敗からの回復 (#263-3)", async function (sc, env, ctx, page) {
    await page.goto(env.origin + "/harness");
    await page.evaluate(function () { window.__idbFault.open = true; window.initClient(); });
    var r1 = await page.evaluate(function (p) { return window.directSubmit(p); }, P("k263-3a"));
    sc.check("open失敗中のsubmitは拒否される(送信なし)", !r1.ok && env.posts().length === 0, r1);
    await page.evaluate(function () { window.__idbFault.open = false; });
    var r2 = await page.evaluate(function (p) { return window.directSubmit(p); }, P("k263-3b"));
    sc.note("open回復後(再読込なし)のsubmit: " + JSON.stringify(r2));
    sc.check("open障害が解消した後、再読込せずにsubmitできる", r2.ok === true, r2);
    if (r2.ok) {
      await page.evaluate(function () { return window.client.flush(); });
      sc.check("その注文が送信されsent・relay 1件", (await statusNow(page, "k263-3b")) === "sent" && (await env.feed()).length === 1, null);
    }
    await page.reload(); await page.evaluate(function () { window.initClient(); });
    var r3 = await page.evaluate(function (p) { return window.directSubmit(p); }, P("k263-3c"));
    sc.check("(参考) 再読込すれば両版とも回復する", r3.ok === true, r3);
  }, browser);

  /* ---------- #250 ---------- */
  await scenario("A250-1", "通信断(ブラウザoffline)→復帰: onlineイベントで同IDを再送し1件受付", async function (sc, env, ctx, page) {
    await open(env, page);
    await page.evaluate(function () { window.client.start(); });
    await ctx.setOffline(true);
    var id = (await page.evaluate(function (p) { return window.directSubmit(p); }, P("k250-1"))).id;
    var pend = await waitStatus(page, id, "retrying", 5000);
    sc.check("offline中はpending・エラー文言あり・relay 0件", pend && pend.error && (await env.feed()).length === 0 && env.posts().length === 0, pend && pend.error);
    await ctx.setOffline(false);
    var sent = await waitStatus(page, id, "sent", 10000);
    sc.check("復帰後sent", !!sent, null);
    sc.check("relay受付1件・POST1回", (await env.feed()).length === 1 && env.posts().length === 1, env.posts().length);
  }, browser);

  await scenario("A250-2", "サーバー受付後に応答だけ失う(ACK喪失): 同IDで再送、relayは重複受付しない", async function (sc, env, ctx, page) {
    await open(env, page);
    // Chromium は切断された接続でのPOSTを1回だけ内部再試行するため、client に失敗が見えるよう2回続けて応答を落とす
    await env.ctl({ mode: "drop-after", times: 2 });
    await page.evaluate(function () { window.client.start(); });
    var id = (await page.evaluate(function (p) { return window.directSubmit(p); }, P("k250-2"))).id;
    var sent = await waitStatus(page, id, "sent", 10000);
    sc.check("最終的にsent", !!sent, null);
    var posts = env.posts();
    sc.note("relay手前のPOST=" + posts.length + " / ブラウザのfetch発行=" + env.clientPosts + " / 最終retryCount=" + (sent && sent.retryCount));
    sc.check("clientは応答喪失を失敗として扱い再送した (retryCount>=1, fetch>=2)", sent && sent.retryCount >= 1 && env.clientPosts >= 2, { retry: sent && sent.retryCount, fetch: env.clientPosts });
    sc.check("全POSTが同一本文(同じ注文ID・内容)", posts.length >= 3 && posts.every(function (p) { return p.body === posts[0].body; }), posts.length);
    sc.check("relayでcreatedは1回だけ・残りはduplicate・受付は1件", posts.filter(function (p) { return p.created; }).length === 1 && posts.slice(1).every(function (p) { return p.duplicate === true; }) && (await env.feed()).length === 1, posts.map(function (p) { return { created: p.created, duplicate: p.duplicate }; }));
  }, browser);

  await scenario("A250-3", "タイムアウト(応答遅延): abort→同IDで再送、relayは重複受付しない", async function (sc, env, ctx, page) {
    await open(env, page, "?timeoutMs=1500");
    await env.ctl({ mode: "delay", times: 1, delayMs: 4000 });
    await page.evaluate(function () { window.client.start(); });
    var id = (await page.evaluate(function (p) { return window.directSubmit(p); }, P("k250-3"))).id;
    var sent = await waitStatus(page, id, "sent", 12000);
    sc.check("最終的にsent", !!sent, null);
    await sleep(4000);
    var posts = env.posts();
    sc.check("POST2回(同一本文)・relayの受付は1件", env.clientPosts === 2 && posts.length === 2 && posts[0].body === posts[1].body && (await env.feed()).length === 1, posts.length);
    sc.note("relay判定: " + JSON.stringify(posts.map(function (p) { return { created: p.created, duplicate: p.duplicate }; })));
    sc.check("created 1回 + duplicate 1回", posts.filter(function (p) { return p.created; }).length === 1 && posts.filter(function (p) { return p.duplicate; }).length === 1, null);
    sc.check("遅延応答のabortにより最初の試行はretryCount増加", sent && sent.retryCount >= 1, sent && sent.retryCount);
  }, browser);

  for (var code of [408, 429, 500, 503]) {
    await (function (code) { return scenario("A250-4-" + code, "HTTP " + code + " は再送対象(pending)で、復帰後に1件受付", async function (sc, env, ctx, page) {
      await open(env, page);
      await env.ctl({ mode: "status", status: code });   // 復帰を指示するまで返し続ける
      await page.evaluate(function () { window.client.start(); });
      var id = (await page.evaluate(function (p) { return window.directSubmit(p); }, P("k250-4-" + code))).id;
      var pend = await waitStatus(page, id, "retrying", 4000);
      sc.check(code + " でpending (failedにならない)", pend && pend.error === "HTTP " + code, pend && pend.error);
      await sleep(3500);
      var mid = (await list(page))[0];
      sc.check("障害中は再送が続く (retryCount>=2) が、relayには入らない", mid.retryCount >= 2 && (await env.feed()).length === 0 && mid.status !== "failed", { retry: mid.retryCount, status: mid.status });
      await env.ctl({ mode: "pass" });
      var sent = await waitStatus(page, id, "sent", 12000);
      sc.check("復帰後sent・relay 1件", !!sent && (await env.feed()).length === 1, null);
      sc.note("ブラウザのfetch発行=" + env.clientPosts + " / relay手前のPOST=" + env.posts().length + " / 最終retryCount=" + (sent && sent.retryCount));
    }, browser); })(code);
  }

  var weak = [
    { m: "ack-wrong-id", d: "200 だが別の注文ID" }, { m: "ack-no-ok", d: "200 だが ok:true が無い" },
    { m: "ack-html", d: "200 だがJSONでない(キャプティブポータル相当)" }, { m: "status", s: 204, d: "204 (200/201以外の2xx)" }
  ];
  for (var w of weak) {
    await (function (w) { return scenario("A250-5-" + w.m + (w.s || ""), "受付確認が揃わない応答(" + w.d + ")ではsentにならない", async function (sc, env, ctx, page) {
      await open(env, page);
      await env.ctl({ mode: w.m, status: w.s });
      await page.evaluate(function () { window.client.start(); });
      var id = (await page.evaluate(function (p) { return window.directSubmit(p); }, P("k250-5"))).id;
      await sleep(3500);
      var l = (await list(page))[0];
      sc.check("sentにならずpending/sending・再送が続く", l.status !== "sent" && l.status !== "failed" && l.retryCount >= 1, { status: l.status, retry: l.retryCount, error: l.error });
      sc.check("変更履歴にsentが一度も無い", !(await page.evaluate(function () { return window.__changes; })).some(function (c) { return c.status === "sent"; }), null);
      await env.ctl({ mode: "pass" });
      var sent = await waitStatus(page, id, "sent", 12000);
      sc.check("正しいACKが来れば sent・relay 1件", !!sent && (await env.feed()).length === 1, null);
    }, browser); })(w);
  }

  await scenario("A250-6a", "再送対象外4xx(relayの400: allergiesが配列)はfailedで停止し自動再送しない", async function (sc, env, ctx, page) {
    await open(env, page);
    await page.evaluate(function () { window.client.start(); });
    var bad = P("k250-6a", { items: [{ name: "土鍋御膳", qty: 1, allergies: ["えび"] }] });
    var id = (await page.evaluate(function (p) { return window.directSubmit(p); }, bad)).id;
    var f = await waitStatus(page, id, "failed", 6000);
    sc.check("failed・HTTP 400", f && f.error === "HTTP 400", f && f.error);
    await sleep(3500);
    sc.check("以後POSTは1回のまま(自動再送なし)・relay 0件", env.posts().length === 1 && (await env.feed()).length === 0, env.posts().length);
    var threw = await page.evaluate(function (id) { return window.client.retry(id).then(function () { return null; }, function (e) { return e.message; }); }, "nonexistent");
    sc.check("存在しないIDのretryは拒否", !!threw, threw);
  }, browser);

  await scenario("A250-6b", "認証エラー(401): failedで停止 → 認証修正後のretryで復帰", async function (sc, env, ctx, page) {
    await open(env, page);
    await page.evaluate(function () { window.client.start(); });
    var id = (await page.evaluate(function (p) { return window.directSubmit(p); }, P("k250-6b"))).id;
    var f = await waitStatus(page, id, "failed", 6000);
    sc.check("トークン無し → failed・HTTP 401", f && f.error === "HTTP 401", f && f.error);
    await sleep(2500);
    sc.check("自動再送されない(POST1回)", env.posts().length === 1 && env.posts()[0].auth === "absent", env.posts().length);
    await page.evaluate(function () { window.__token = "wrong-token"; });
    await page.evaluate(function (id) { return window.client.retry(id); }, id);
    f = await waitStatus(page, id, "failed", 6000); await sleep(1200);
    sc.check("誤ったトークンでretry → 再びfailed(HTTP 401)", f && f.error === "HTTP 401" && env.posts().length === 2 && env.posts()[1].auth === "present", { posts: env.posts().length });
    sc.check("認証失敗中にrelayへ注文は入らない", (await env.feed()).length === 0, null);
    await page.evaluate(function (t) { window.__token = t; }, env.token);
    await page.evaluate(function (id) { return window.client.retry(id); }, id);
    var sent = await waitStatus(page, id, "sent", 8000);
    sc.check("正しいトークンでretry → sent・relay 1件", !!sent && (await env.feed()).length === 1, null);
    var raw = JSON.stringify(await page.evaluate(function () { return window.rawRecords(); }));
    sc.check("トークンがIndexedDBに保存されていない", raw.indexOf(env.token) < 0 && raw.indexOf("wrong-token") < 0, null);
  }, browser, { token: "local-test-token-0001" });

  await scenario("A250-7", "作成から30分超の未確認注文は needs_review になり自動投入されない (時計はブラウザ側でモック)", async function (sc, env, ctx, page) {
    await open(env, page);
    await env.ctl({ mode: "drop-before" });
    var a = (await page.evaluate(function (p) { return window.directSubmit(p); }, P("k250-7a"))).id;
    await page.evaluate(function () { return window.client.flush(); });
    sc.check("初回はpending", (await statusNow(page, a)) === "pending", null);
    await env.ctl({ mode: "pass" }); env.proxy.getStats().posts.length = 0;
    await page.evaluate(function () { window.__skew = 30 * 60 * 1000 + 1000 - 5000; });
    var b = (await page.evaluate(function (p) { return window.directSubmit(p); }, P("k250-7b"))).id;  // createdAt は skew 後。a だけが古い
    await page.evaluate(function () { window.__skew = 30 * 60 * 1000 + 1000; });
    await page.evaluate(function () { return window.client.flush(); });
    var la = (await list(page)).find(function (r) { return r.orderId === a; });
    sc.check("30分+1秒経過した注文aはneeds_review・理由文言あり", la.status === "needs_review" && /スタッフ/.test(la.error || ""), { status: la.status, error: la.error });
    sc.check("aはrelayへ送られていない", !env.posts().some(function (p) { return p.orderId === a; }) && !(await env.feed()).some(function (o) { return o.id === a; }), env.posts().map(function (p) { return p.orderId; }));
    sc.check("新しい注文bは通常どおりsent", (await statusNow(page, b)) === "sent", null);
    await page.evaluate(function () { window.client.start(); }); await sleep(3000);
    sc.check("start後・時間経過後もaは自動投入されない(needs_reviewのまま)", (await statusNow(page, a)) === "needs_review" && !env.posts().some(function (p) { return p.orderId === a; }), null);
    await page.reload(); await page.evaluate(function () { window.initClient(); window.client.start(); }); await sleep(2500);
    sc.check("再読込後もneeds_reviewのまま・送られない", (await statusNow(page, a)) === "needs_review" && !env.posts().some(function (p) { return p.orderId === a; }), null);
    var threw = await page.evaluate(function (id) { return window.client.retry(id).then(function () { return null; }, function (e) { return e.message; }); }, a);
    sc.check("needs_reviewはretry()でも再送できない(スタッフ照合が前提)", !!threw, threw);
  }, browser);

  await scenario("A250-7b", "期限の境界: 29分59秒の未確認注文はまだ再送される", async function (sc, env, ctx, page) {
    await open(env, page);
    await env.ctl({ mode: "drop-before" });
    var a = (await page.evaluate(function (p) { return window.directSubmit(p); }, P("k250-7c"))).id;
    await page.evaluate(function () { return window.client.flush(); });
    await env.ctl({ mode: "pass" });
    await page.evaluate(function () { window.__skew = 30 * 60 * 1000 - 1000; });
    await page.evaluate(function () { return window.client.flush(); });
    sc.check("29:59 ではsent", (await statusNow(page, a)) === "sent", await statusNow(page, a));
  }, browser);

  await scenario("A250-8", "検証画面: 二重タップでも1件・状態表示・KDSへ1件反映", async function (sc, env, ctx, page) {
    await open(env, page);
    await page.evaluate(function () { window.client.start(); });
    await page.dblclick("#confirm");
    await page.waitForFunction(function () { return window.__lastId; });
    var id = await page.evaluate(function () { return window.__lastId; });
    await page.click("#confirm", { force: true }).catch(function () {});
    var sent = await waitStatus(page, null, "sent", 8000);
    sc.check("client.submit は1回だけ呼ばれる", (await page.evaluate(function () { return window.__submitCalls; })) === 1, await page.evaluate(function () { return window.__submitCalls; }));
    sc.check("IDB記録1件・relay受付1件・POST1回", (await page.evaluate(function () { return window.rawRecords(); })).length === 1 && (await env.feed()).length === 1 && env.posts().length === 1, env.posts().length);
    var line = await page.textContent('#orders li[data-id="' + id + '"]');
    sc.check("画面に状態表示 (sent)", /sent/.test(line), line);
    var kds = await ctx.newPage();
    await kds.goto(env.origin + "/kds");
    var shown = await kds.waitForFunction(function () { return document.body.innerText.indexOf("土鍋御膳") >= 0; }, null, { timeout: 15000 }).then(function () { return true; }, function () { return false; });
    sc.check("KDS画面(/kds)に注文の品目が表示される", shown, null);
    if (shown) {
      var count = await kds.evaluate(function () { return (document.body.innerText.match(/土鍋御膳/g) || []).length; });
      sc.note("KDS本文中の「土鍋御膳」出現数: " + count);
      sc.check("KDSへの反映は1件(出現数1)", count === 1, count);
    }
    await page.screenshot({ path: path.join(OUT, LABEL + "-A250-8-harness.png") });
    await kds.screenshot({ path: path.join(OUT, LABEL + "-A250-8-kds.png") });
  }, browser);

  await browser.close();
  meta.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(OUT, LABEL + ".json"), JSON.stringify({ meta: meta, results: results }, null, 1));
  var failed = results.filter(function (r) { return !r.pass; });
  console.log("\n" + LABEL + ": " + (results.length - failed.length) + "/" + results.length + " scenarios passed");
  process.exit(0);
})().catch(function (e) { console.error(e); process.exit(2); });
