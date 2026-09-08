/* Browser: window.OrderClient; CommonJS: require('./order-client').
 * Each submission is immutable. Reuse its orderId after an uncertain response.
 */
(function (root) {
  "use strict";
  function indexedStore(name) {
    var db = new Promise(function (resolve, reject) {
      var request = root.indexedDB.open(name, 1);
      request.onupgradeneeded = function () { request.result.createObjectStore("orders", { keyPath: "orderId" }); };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
    async function run(mode, action) {
      var connection = await db;
      return new Promise(function (resolve, reject) {
        var tx = connection.transaction("orders", mode);
        var request = action(tx.objectStore("orders"));
        tx.oncomplete = function () { resolve(request.result); };
        tx.onabort = tx.onerror = function () { reject(tx.error || new Error("注文の端末保存に失敗しました")); };
      });
    }
    return {
      list: function () { return run("readonly", function (s) { return s.getAll(); }); },
      add: function (r) { return run("readwrite", function (s) { return s.add(r); }); },
      put: function (r) { return run("readwrite", function (s) { return s.put(r); }); }
    };
  }
  function create(options) {
    options = options || {};
    var endpoint = new URL(options.endpoint || "/api/orders", options.baseURL || root.location.href);
    var store = options.store || indexedStore("pokapoka-orders:" + endpoint.href);
    var fetcher = options.fetch || root.fetch.bind(root);
    var now = options.now || Date.now;
    var running = null, timer = null, stopped = true;
    function emit(record) {
      // UI errors must never turn a received ACK into a network failure.
      try { if (options.onChange) options.onChange(JSON.parse(JSON.stringify(record))); } catch (_) {}
    }
    function schedule(delay) {
      clearTimeout(timer);
      if (!stopped) timer = setTimeout(function () { flush().catch(report); }, delay);
    }
    function report(error) {
      try { if (options.onError) options.onError(error); } catch (_) {}
    }
    async function send(record) {
      // Do not silently send yesterday's abandoned orders when a tablet reopens.
      if (now() - record.createdAt > (options.maxAgeMs || 30 * 60 * 1000)) {
        record.status = "needs_review";
        record.error = "受付結果をスタッフが確認してください（再送期限超過）";
        await store.put(record); emit(record); return;
      }
      record.status = "sending";
      await store.put(record); emit(record);
      var controller = new AbortController();
      var timeout = setTimeout(function () { controller.abort(); }, options.timeoutMs || 10000);
      var outcome;
      try {
        var headers = { "Content-Type": "application/json" };
        if (options.getToken) {
          var token = await options.getToken();
          if (token) headers.Authorization = "Bearer " + token;
        }
        var response = await fetcher(endpoint.href, {
          method: "POST", headers: headers, credentials: "same-origin",
          body: JSON.stringify(record.payload), signal: controller.signal,
          redirect: "error"
        });
        if (response.status === 200 || response.status === 201) {
          var body = await response.json();
          if (!body || body.ok !== true || !body.order || String(body.order.id) !== record.orderId) {
            throw new Error("注文IDの一致する受付確認がありません");
          }
          outcome = { status: "sent", error: null };
        } else if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
          outcome = { status: "failed", error: "HTTP " + response.status };
        } else {
          throw new Error("HTTP " + response.status);
        }
      } catch (error) {
        record.retryCount += 1;
        outcome = { status: "pending", error: error.message,
          nextAttemptAt: now() + Math.min(30000, 1000 * Math.pow(2, Math.min(record.retryCount - 1, 5))) };
      } finally { clearTimeout(timeout); }
      Object.assign(record, outcome);
      // A failed durable ACK write leaves the original payload available for safe retry.
      await store.put(record); emit(record);
    }
    function flush() {
      if (running) return running;
      running = (async function () {
        var records = await store.list();
        records.sort(function (a, b) { return a.createdAt - b.createdAt; });
        for (var record of records) {
          if (record.status !== "pending" && record.status !== "sending") continue;
          if (record.nextAttemptAt > now()) continue;
          await send(record);
        }
      })().finally(function () { running = null; schedule(1000); });
      return running;
    }
    async function submit(payload) {
      var copy = JSON.parse(JSON.stringify(payload));
      if (copy.orderId == null) {
        var bytes = new Uint8Array(16);
        root.crypto.getRandomValues(bytes);
        copy.orderId = Array.from(bytes, function (b) { return b.toString(16).padStart(2, "0"); }).join("");
      }
      copy.orderId = String(copy.orderId);
      if (!copy.orderId.trim() || copy.orderId.length > 64 || typeof copy.table !== "string" || !copy.table.trim() || !Array.isArray(copy.items) || !copy.items.length) {
        throw new Error("orderId・卓番・商品を確認してください");
      }
      if (copy.orderedAt == null) copy.orderedAt = new Date(now()).toISOString();
      var record = { orderId: copy.orderId, payload: copy, status: "pending", retryCount: 0,
        createdAt: now(), nextAttemptAt: 0, error: null };
      // add (not put) rejects a reused ID instead of overwriting an uncertain order.
      await store.add(record); emit(record);
      if (!stopped) schedule(0);
      return record.orderId;
    }
    function online() { schedule(0); }
    return {
      submit: submit, list: function () { return store.list(); }, flush: flush,
      start: function () {
        if (!stopped) return;
        stopped = false;
        if (root.addEventListener) root.addEventListener("online", online);
        schedule(0);
      },
      stop: function () {
        stopped = true; clearTimeout(timer);
        if (root.removeEventListener) root.removeEventListener("online", online);
      },
      retry: async function (id) {
        var record = (await store.list()).find(function (r) { return r.orderId === id; });
        if (!record || record.status !== "failed") throw new Error("設定修正後の failed 注文だけ再送できます");
        record.status = "pending"; record.nextAttemptAt = 0;
        await store.put(record); emit(record); schedule(0);
      }
    };
  }
  var api = { create: create };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.OrderClient = api;
})(globalThis);
