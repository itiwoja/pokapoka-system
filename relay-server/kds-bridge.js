/**
 * kds-bridge.js — 中継サーバー → KDS 取込ブリッジ (ブラウザ側)
 *
 * KDS (kds-a-grid.html) 本体は改修せず、外側から接続する:
 *   1. GET /api/stock を定期取得 → localStorage "kds_stock_v1" へマージ →
 *      BroadcastChannel "kds_sync" に {type:"stock"} を流して全タブへ反映。
 *   2. GET /api/orders を定期取得 → window.KDS_ORDERS へ反映 (注文端末由来の注文 #139)。
 *
 * 使い方 (どちらか):
 *   A. kds-a-grid.html の </body> 直前に <script src="/relay-server/kds-bridge.js"></script>
 *   B. KDS を開いたブラウザのコンソールに本ファイルを貼り付け
 *
 * マージ規則 (予約ストック):
 *   - 本ブリッジが一度取り込んだ予約 (rid を kds_bridge_seen_v1 に記録) はサーバーを正とする
 *     → 変更は上書き・サーバー側から消えたら (キャンセル/日跨ぎ) 削除として反映
 *   - KDS 上で手動追加された予約 (＋追加ボタン由来) はブリッジを通らず seen に載らないので触らない
 *     (rid の形式では判定しない — 本番 TableCheck の ID 形式は未確定のため。Issue #129)
 *   - KDS 側で既に「着手」済み (ストックから消えた) 予約は復活させない
 *
 * マージ規則 (注文フィード):
 *   - サーバー由来の注文は毎回サーバーの内容で置き換える
 *   - 同じ id の更新では、コンロ・タイマーロック・並び順は id に紐づくためそのまま維持する
 *   - 品目完了数は「品名・オプション・アレルギー」が同じ行へ追従し、数量減では新数量を上限にする
 *     (新規行または内容が訂正された行は未完了から開始する)
 *   - KDS 内で発生した注文 (予約→着手の "res-*" カード) は残す。消してしまうと
 *     ホールが着手した予約カードが次のポーリングで消える
 *   - 取得に失敗したときは window.KDS_ORDERS に触らない (直前の表示を保持)
 */
(function () {
  "use strict";
  var API = "/api/stock";
  var API_SEATS = "/api/seats";
  var API_ORDERS = "/api/orders";
  var API_KITCHEN = "/api/kitchen-state";
  var LS_STOCK = "kds_stock_v1";
  var LS_BRIDGE_SEEN = "kds_bridge_seen_v1"; // 一度取り込んだ rid (サーバー由来の印 + 着手/削除後の復活防止)
  var LS_KONRO = "kds_konro_v1";
  var LS_DONE = "kds_done_v2";
  var LS_LOCKED = "kds_locked_v1";
  var LS_ORDER = "kds_order_v1";
  var LS_DELETED = "kds_deleted_v1";
  var LS_SERVER_ORDERS = "kds_server_orders_v1"; // 前回フィード。再読込・通信断をまたぐ品目状態移行に使う
  var BC_NAME = "kds_sync";
  var POLL_MS = 5000;                        // 店内 LAN なので短くてよい (対 TableCheck の30秒とは別物)
  var ORDER_POLL_MS = 2000;                  // 注文は厨房の着手速度に効くので予約より短く
  var KITCHEN_POLL_MS = 1500;                // コンロの取り合いに効くので短め
  var KITCHEN_FLUSH_MS = 200;                // 連打はまとめて送る
  var KITCHEN_RETRY_MS = 1000;               // 通信断中の高速ループを避けつつ、復旧後は速やかに追いつく
  var KITCHEN_EVENTS = { konro: 1, toggle: 1, timerLock: 1, order: 1, deleteOrder: 1 };

  var bc = null; // ブラウザで動く時だけ末尾で生成 (Node にも BroadcastChannel があり、生成するとテストプロセスが終了しなくなる)

  function load(key, fb) { try { var v = JSON.parse(localStorage.getItem(key)); return v == null ? fb : v; } catch (e) { return fb; } }
  function save(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) {} }

  /**
   * サーバー取得分 (incoming) を既存ストックへマージする純粋関数。
   * seen (取込済み rid の記録) は incoming に載った rid をこの場で書き足す。
   * @param {Array}  stock    - 現在の kds_stock_v1 の中身
   * @param {Object} seen     - kds_bridge_seen_v1 の中身 (rid -> 1)。破壊的に更新される
   * @param {Array}  incoming - /api/stock のレスポンス
   * @returns {{stock: Array, changed: boolean, seenChanged: boolean}}
   *          stock: マージ後のストック (time 昇順) / changed: stock を保存すべきか /
   *          seenChanged: seen を保存すべきか (changed とは独立 #175)
   */
  function mergeStock(stock, seen, incoming) {
    var byRid = {};
    stock.forEach(function (r) { if (r && r.rid != null) byRid[String(r.rid)] = r; });
    var incomingRids = {};
    var changed = false;
    var seenChanged = false;

    incoming.forEach(function (r) {
      if (!r || r.rid == null) return;
      var rid = String(r.rid);
      incomingRids[rid] = true;
      // incoming に載っている = サーバー由来が確定。新規取込かどうかに関わらず seen へ記録する。
      // 上書きだけして seen に載せずにいると、その後キャンセルされても下の削除判定を通らない (Issue #175)
      var wasSeen = !!seen[rid];
      if (!wasSeen) { seen[rid] = 1; seenChanged = true; }
      if (byRid[rid]) {                      // 既存 → 内容が変わっていれば上書き (updated 反映)
        var cur = byRid[rid];
        if (JSON.stringify({ a: cur.time, b: cur.adults, c: cur.kids, d: cur.name, e: cur.menu }) !==
            JSON.stringify({ a: r.time, b: r.adults, c: r.kids, d: r.name, e: r.menu })) {
          r.seenAt = cur.seenAt || r.seenAt; // 30分前通知の再発火を避けるため取込時刻は維持
          byRid[rid] = r; changed = true;
        }
      } else if (!wasSeen) {                 // 新規 (着手/削除済みは seen に載っているので復活させない)
        byRid[rid] = r; changed = true;
      }
    });

    // 取込済み (seen) なのにサーバー側から消えた予約 = キャンセル/日跨ぎ → ストックから除去。
    // 手動追加の予約はブリッジを通らず seen に載らないため、ここで消えることはない (Issue #129)
    Object.keys(byRid).forEach(function (rid) {
      if (seen[rid] && !incomingRids[rid]) { delete byRid[rid]; changed = true; }
    });

    var next = Object.keys(byRid).map(function (k) { return byRid[k]; });
    next.sort(function (a, b) { return String(a.time) < String(b.time) ? -1 : 1; });
    return { stock: next, changed: changed, seenChanged: seenChanged };
  }

  async function tickOnce() {
    var res, incoming;
    try {
      res = await fetch(API, { cache: "no-store" });
      if (!res.ok) throw new Error(res.status);
      incoming = await res.json();
      if (!Array.isArray(incoming)) return;
    } catch (e) { return; }                  // 通信断: 直前の表示を保持 (6/18 方針)

    // 着席時に「誰が座っているか」を座席占有へ載せるため、rid → 予約者名を控えておく。
    // 着席の合図(BroadcastChannel)にはストックから消えた後の配列しか乗らないので、ここで拾う (#123)
    incoming.forEach(function (r) {
      if (r && r.rid != null && r.name) nameByRid[String(r.rid)] = String(r.name);
    });

    var seen = load(LS_BRIDGE_SEEN, {});
    var merged = mergeStock(load(LS_STOCK, []), seen, incoming);
    // 取込実績は stock が変わっていない tick でも保存する。
    // changed 側にぶら下げると「上書きのみ」「変化なし」の tick で seen を取りこぼす (Issue #175)
    if (merged.seenChanged) save(LS_BRIDGE_SEEN, seen);
    if (!merged.changed) return;
    save(LS_STOCK, merged.stock);
    if (bc) { try { bc.postMessage({ type: "stock", stock: merged.stock }); } catch (e) {} }
    // 同一タブへの反映: KDS は storage イベント/BC を購読しているが、自タブには BC が届かないため
    // ページ側の再描画フックが無い場合に備え、控えめにリロードは行わず storage 書換のみとする。
    // (kds-a-grid.html に <script src> で読み込ませた場合、別タブ・別端末には即時反映される)
  }

  /* ===================== 座席占有の登録 (#123) =====================
     卓番は「予約をどの席に案内したか」をスタッフが KDS で決めるローカルデータで、
     TableCheck 側には無い(あっても希望席種まで)。ここが唯一の正本になるので、
     着席の操作をそのまま relay の座席占有ビューへ流す。

     KDS 本体は着席時に BroadcastChannel へ {type:"moveToMain", order} を流している。
     order.id は "res-<rid>"、order.table が案内した卓番。KDS 本体は無改修のまま拾える。 */
  var nameByRid = {};   // rid → 予約者名 (/api/stock の取込時に控える)

  async function registerSeat(table, rid) {
    if (!table) return;
    var payload = { table: String(table) };
    if (rid) {
      payload.rid = String(rid);
      if (nameByRid[String(rid)]) payload.name = nameByRid[String(rid)];
    }
    try {
      await fetch(API_SEATS, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      // 登録できなくても着席の操作自体は成立している。座席占有は補助情報なので黙って諦める
    }
  }

  /* 着席の合図を拾って座席占有へ載せる (#123)。
     BroadcastChannel のハンドラは #132 の厨房状態同期と共用するため、
     ここでは代入せず関数として置き、末尾のハンドラから両方を呼ぶ */
  function onSeatBroadcast(msg) {
    if (!msg || msg.type !== "moveToMain" || !msg.order) return;
    var id = String(msg.order.id || "");
    registerSeat(msg.order.table, id.indexOf("res-") === 0 ? id.slice(4) : "");
  }

  /* ===================== 厨房状態の端末間同期 (#132) =====================
     KDS は状態変更のたびに BroadcastChannel("kds_sync") へイベントを流しているが、
     BroadcastChannel は同一ブラウザ内にしか届かない。ここでそのイベントを拾って relay へ送り、
     relay が畳み込んだスナップショットを localStorage へ書き戻すことで別端末とも揃える。

     取り込みは localStorage へ書くだけでよい: KDS 本体は 1秒ごとの poll() で
     loadKonro()/loadDone()/loadLocked()/loadOrderSeq()/loadDeleted() を実行しており、
     書き換えた内容がそのまま次の描画に乗る (KDS 本体は無改修のまま)。 */
  var appliedRev = -1;       // 取り込み済みの relay rev
  var kitchenSession = null; // relay の起動識別子。再起動で rev が戻るのを検出する
  var seeded = false;        // 空の relay へ手元の状態を渡し済みか

  /**
   * 厨房イベントを順序どおりに送るキュー。
   * 失敗した batch は、その送信中に追加されたイベントより前へ戻して retryMs 後に再送する。
   * イベントは絶対状態を表すため、応答喪失による同一 batch の再送も relay 側で安全に再適用できる。
   */
  function createKitchenQueue(sendBatch, options) {
    options = options || {};
    var flushMs = options.flushMs == null ? KITCHEN_FLUSH_MS : options.flushMs;
    var retryMs = options.retryMs == null ? KITCHEN_RETRY_MS : options.retryMs;
    var batchSize = options.batchSize || 200;
    var queue = [];
    var timer = null;
    var inFlight = false;

    function schedule(delay) {
      if (timer || inFlight || !queue.length) return;
      timer = setTimeout(function () {
        timer = null;
        flush();
      }, delay);
    }

    async function flush() {
      if (inFlight || !queue.length) return;
      var batch = queue.splice(0, batchSize);
      var succeeded = false;
      inFlight = true;
      try {
        await sendBatch(batch);
        succeeded = true;
      } catch (e) {
        // 後続イベントの前へ戻すことで、失敗前後の操作順を維持する。
        queue = batch.concat(queue);
      } finally {
        inFlight = false;
        if (queue.length) schedule(succeeded ? 0 : retryMs);
      }
    }

    function enqueue(event) {
      queue.push(event);
      schedule(flushMs);
    }

    function enqueueAll(events) {
      if (!events || !events.length) return;
      queue = queue.concat(events);
      schedule(flushMs);
    }

    function flushNow() {
      if (timer) { clearTimeout(timer); timer = null; }
      return flush();
    }

    return {
      enqueue: enqueue,
      enqueueAll: enqueueAll,
      flushNow: flushNow,
      isBusy: function () { return inFlight || queue.length > 0; },
      pending: function () { return queue.slice(); },
    };
  }

  async function postKitchenBatch(fetchFn, batch) {
    var res = await fetchFn(API_KITCHEN, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: batch }),
    });
    if (!res.ok) throw new Error(res.status);
    return res.json();
  }

  var kitchenQueue = createKitchenQueue(async function (batch) {
    var body = await postKitchenBatch(fetch, batch);
    // 自分の変更が relay に載った時点の rev。これより古いスナップショットは取り込まない
    // (取り込むと、送った直後の操作が一瞬巻き戻って見える)
    if (body && typeof body.rev === "number") appliedRev = Math.max(appliedRev, body.rev - 1);
  });

  function onLocalKitchenEvent(msg) {
    if (!msg || !KITCHEN_EVENTS[msg.type]) return;
    kitchenQueue.enqueue(msg);
  }

  /* relay がまだ空のときに、この端末の手元の状態をイベント列にして送る。
     これをしないと「最初の1操作だけが載ったスナップショット」を取り込んだ瞬間に、
     それ以外の手元の状態(他のコンロ・完了済み品目)が消える。 */
  function seedKitchenFromLocal() {
    var events = [];
    var deleted = load(LS_DELETED, {}) || {};
    Object.keys(deleted).forEach(function (id) {
      if (deleted[id]) events.push({ type: "deleteOrder", id: id });
    });
    var konro = load(LS_KONRO, {}) || {};
    Object.keys(konro).forEach(function (id) {
      var nums = konro[id] || {};
      Object.keys(nums).forEach(function (num) {
        events.push({ type: "konro", id: id, num: Number(num), state: nums[num] });
      });
    });
    var done = load(LS_DONE, {}) || {};
    Object.keys(done).forEach(function (id) {
      var counts = done[id] || [];
      for (var i = 0; i < counts.length; i++) {
        if (counts[i] != null) events.push({ type: "toggle", id: id, index: i, doneCount: Number(counts[i]) || 0 });
      }
    });
    var locked = load(LS_LOCKED, {}) || {};
    Object.keys(locked).forEach(function (id) {
      if (locked[id]) events.push({ type: "timerLock", id: id, locked: true });
    });
    var seq = load(LS_ORDER, []);
    if (Array.isArray(seq) && seq.length) events.push({ type: "order", seq: seq.map(String) });

    if (!events.length) return false;
    kitchenQueue.enqueueAll(events);
    kitchenQueue.flushNow();
    return true;
  }

  function adoptKitchenState(snap) {
    save(LS_KONRO, snap.konro || {});
    save(LS_DONE, snap.done || {});
    save(LS_LOCKED, snap.locked || {});
    save(LS_ORDER, Array.isArray(snap.seq) ? snap.seq : []);
    save(LS_DELETED, snap.deleted || {});
  }

  async function tickKitchen() {
    if (kitchenQueue.isBusy()) return;          // 未送信分がある間は古い relay 状態を取り込まない
    var snap;
    try {
      var res = await fetch(API_KITCHEN, { cache: "no-store" });
      if (!res.ok) throw new Error(res.status);
      snap = await res.json();
      if (!snap || typeof snap.rev !== "number") return;
    } catch (e) { return; }                     // 通信断: 手元の状態を保持

    if (snap.sessionId !== kitchenSession) {    // relay 再起動 (rev が 0 に戻る) を検出
      kitchenSession = snap.sessionId;
      appliedRev = -1;
      seeded = false;
    }
    if (snap.rev === 0) {
      // relay 側が空 = まだ誰も操作していない。手元の状態を種として渡す
      if (!seeded) { seeded = true; seedKitchenFromLocal(); }
      return;
    }
    seeded = true;
    if (snap.rev <= appliedRev) return;
    appliedRev = snap.rev;
    adoptKitchenState(snap);
  }

  /* ---- 注文フィード (#139) ---- */
  var serverOrderIds = {};   // 直近のサーバー由来 id。KDS 内で生まれた注文と区別するために持つ

  function itemStateKey(item) {
    item = item || {};
    return JSON.stringify([
      String(item.name || ""),
      item.options == null ? null : String(item.options),
      item.allergies == null ? null : String(item.allergies),
    ]);
  }

  function normalizedDoneCount(value, qty) {
    var q = Math.max(0, Number(qty) || 0);
    if (value === true) return q;
    if (value === false || value == null) return 0;
    var count = Number(value);
    if (!Number.isFinite(count) || count < 0) return 0;
    return Math.min(count, q);
  }

  /**
   * 更新前の品目完了数を更新後の行へ移す。
   * 行番号ではなく内容で対応づけるため、途中への品目追加や並べ替えで別品目の完了が移らない。
   * 同じ内容の行が複数ある場合は出現順で対応づける。
   */
  function reconcileDoneCounts(previousOrder, nextOrder, savedCounts) {
    var queues = {};
    var previousItems = previousOrder && Array.isArray(previousOrder.items) ? previousOrder.items : [];
    var counts = Array.isArray(savedCounts) ? savedCounts : [];
    previousItems.forEach(function (item, index) {
      var key = itemStateKey(item);
      if (!queues[key]) queues[key] = [];
      queues[key].push(normalizedDoneCount(counts[index], item && item.qty));
    });

    var nextItems = nextOrder && Array.isArray(nextOrder.items) ? nextOrder.items : [];
    return nextItems.map(function (item) {
      var queue = queues[itemStateKey(item)];
      var carried = queue && queue.length ? queue.shift() : 0;
      return normalizedDoneCount(carried, item && item.qty);
    });
  }

  function itemsStateSignature(order) {
    return JSON.stringify((order && order.items || []).map(function (item) {
      return [itemStateKey(item), Number(item && item.qty) || 0];
    }));
  }

  function applyOrders(incoming) {
    var current = Array.isArray(window.KDS_ORDERS) ? window.KDS_ORDERS : [];
    var previousFeed = load(LS_SERVER_ORDERS, []);
    if (!Array.isArray(previousFeed)) previousFeed = [];
    var previousById = {};
    previousFeed.forEach(function (order) {
      if (order && order.id != null) previousById[String(order.id)] = order;
    });

    var done = load(LS_DONE, {});
    if (!done || typeof done !== "object" || Array.isArray(done)) done = {};
    var reconciledEvents = [];
    incoming.forEach(function (order) {
      if (!order || order.id == null) return;
      var id = String(order.id);
      var previous = previousById[id];
      if (!previous || itemsStateSignature(previous) === itemsStateSignature(order)) return;
      var nextCounts = reconcileDoneCounts(previous, order, done[id]);
      done[id] = nextCounts;
      nextCounts.forEach(function (count, index) {
        reconciledEvents.push({ type: "toggle", id: id, index: index, doneCount: count });
      });
    });
    if (reconciledEvents.length) {
      save(LS_DONE, done);
      // relay の厨房状態にも絶対値を送り、次の同期で古い行番号へ巻き戻されないようにする。
      // 通信断中も #205 の再送キューに残し、復旧後に順序どおり反映する。
      kitchenQueue.enqueueAll(reconciledEvents);
    }
    if (JSON.stringify(previousFeed) !== JSON.stringify(incoming)) save(LS_SERVER_ORDERS, incoming);

    var nextIds = {};
    incoming.forEach(function (o) { if (o && o.id != null) nextIds[String(o.id)] = 1; });
    // KDS 内で発生した注文 (予約→着手カード等) を先頭に残す。
    // サーバー側にも同じ id があればサーバーを正とする
    var local = current.filter(function (o) {
      if (!o || o.id == null) return false;
      var id = String(o.id);
      return !serverOrderIds[id] && !nextIds[id];
    });
    serverOrderIds = nextIds;
    window.KDS_ORDERS = local.concat(incoming);
  }

  async function tickOrders() {
    var res, incoming;
    try {
      res = await fetch(API_ORDERS, { cache: "no-store" });
      if (!res.ok) throw new Error(res.status);
      incoming = await res.json();
      if (!Array.isArray(incoming)) return;
    } catch (e) { return; }        // 通信断: 直前の表示を保持 (window.KDS_ORDERS に触らない)
    applyOrders(incoming);
  }

  if (typeof module !== "undefined" && module.exports) {
    // Node (テスト) から require された場合はポーリングしない
    module.exports = {
      mergeStock: mergeStock,
      itemStateKey: itemStateKey,
      reconcileDoneCounts: reconcileDoneCounts,
      createKitchenQueue: createKitchenQueue,
      postKitchenBatch: postKitchenBatch,
    };
  } else {
    try { bc = new BroadcastChannel(BC_NAME); } catch (e) {}
    if (bc) {
      // KDS 本体が同一コンテキストで postMessage したものも、別の BroadcastChannel オブジェクトである
      // こちらには届く。つまり自タブ・他タブ・他端末のどの操作もここで拾える (#132)
      bc.onmessage = function (ev) {
        var msg = ev && ev.data;
        onLocalKitchenEvent(msg);   // 厨房状態を relay へ送る (#132)
        onSeatBroadcast(msg);       // 着席なら座席占有へ登録する (#123)
      };
    }
    tickOnce();
    setInterval(tickOnce, POLL_MS);
    tickOrders();
    setInterval(tickOrders, ORDER_POLL_MS);
    tickKitchen();
    setInterval(tickKitchen, KITCHEN_POLL_MS);
    console.log("[kds-bridge] 予約ストック取込を開始 (" + API + " を " + POLL_MS / 1000 + "秒間隔) / " +
      "注文取込 (" + API_ORDERS + " を " + ORDER_POLL_MS / 1000 + "秒間隔) / " +
      "厨房状態の端末間同期 (" + API_KITCHEN + " を " + KITCHEN_POLL_MS / 1000 + "秒間隔) / " +
      "着席時に座席占有を登録 (" + API_SEATS + ")");
  }
})();
