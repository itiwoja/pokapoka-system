/**
 * kds-bridge.js — 中継サーバー → KDS 予約ストック取込ブリッジ (ブラウザ側)
 *
 * KDS (kds-a-grid.html) 本体は改修せず、外側から接続する:
 *   GET /api/stock を定期取得 → localStorage "kds_stock_v1" へマージ →
 *   BroadcastChannel "kds_sync" に {type:"stock"} を流して全タブへ反映。
 *
 * 使い方 (どちらか):
 *   A. kds-a-grid.html の </body> 直前に <script src="/relay-server/kds-bridge.js"></script>
 *   B. KDS を開いたブラウザのコンソールに本ファイルを貼り付け
 *
 * マージ規則:
 *   - サーバー側の予約 (rid が "mock-" / TableCheck 由来) はサーバーを正とする
 *     → 変更は上書き・キャンセルは削除として反映
 *   - KDS 上で手動追加された予約 (＋追加ボタン由来) には触らない
 *   - KDS 側で既に「着手」済み (ストックから消えた) 予約は復活させない
 */
(function () {
  "use strict";
  var API = "/api/stock";
  var API_KITCHEN = "/api/kitchen-state";
  var LS_STOCK = "kds_stock_v1";
  var LS_BRIDGE_SEEN = "kds_bridge_seen_v1"; // 一度取り込んだ rid (着手/削除後の復活防止)
  var LS_KONRO = "kds_konro_v1";
  var LS_DONE = "kds_done_v2";
  var LS_LOCKED = "kds_locked_v1";
  var LS_ORDER = "kds_order_v1";
  var LS_DELETED = "kds_deleted_v1";
  var BC_NAME = "kds_sync";
  var POLL_MS = 5000;                        // 店内 LAN なので短くてよい (対 TableCheck の30秒とは別物)
  var KITCHEN_POLL_MS = 1500;                // コンロの取り合いに効くので短め
  var KITCHEN_FLUSH_MS = 200;                // 連打はまとめて送る
  var KITCHEN_EVENTS = { konro: 1, toggle: 1, timerLock: 1, order: 1, deleteOrder: 1 };

  var bc = null;
  try { bc = new BroadcastChannel(BC_NAME); } catch (e) {}

  function load(key, fb) { try { var v = JSON.parse(localStorage.getItem(key)); return v == null ? fb : v; } catch (e) { return fb; } }
  function save(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) {} }

  function isServerRid(rid) { return /^(mock-|tc-)/.test(String(rid)) || String(rid).length >= 12; }

  async function tickOnce() {
    var res, incoming;
    try {
      res = await fetch(API, { cache: "no-store" });
      if (!res.ok) throw new Error(res.status);
      incoming = await res.json();
      if (!Array.isArray(incoming)) return;
    } catch (e) { return; }                  // 通信断: 直前の表示を保持 (6/18 方針)

    var stock = load(LS_STOCK, []);
    var seen = load(LS_BRIDGE_SEEN, {});
    var byRid = {};
    stock.forEach(function (r) { if (r && r.rid != null) byRid[String(r.rid)] = r; });
    var incomingRids = {};
    var changed = false;

    incoming.forEach(function (r) {
      if (!r || r.rid == null) return;
      var rid = String(r.rid);
      incomingRids[rid] = true;
      if (byRid[rid]) {                      // 既存 → 内容が変わっていれば上書き (updated 反映)
        var cur = byRid[rid];
        if (JSON.stringify({ a: cur.time, b: cur.adults, c: cur.kids, d: cur.name, e: cur.menu }) !==
            JSON.stringify({ a: r.time, b: r.adults, c: r.kids, d: r.name, e: r.menu })) {
          r.seenAt = cur.seenAt || r.seenAt; // 30分前通知の再発火を避けるため取込時刻は維持
          byRid[rid] = r; changed = true;
        }
      } else if (!seen[rid]) {               // 新規 (着手/削除済みは seen に載っているので復活させない)
        byRid[rid] = r; seen[rid] = 1; changed = true;
      }
    });

    // サーバー由来なのにサーバー側から消えた予約 = キャンセル/日跨ぎ → ストックから除去
    Object.keys(byRid).forEach(function (rid) {
      if (isServerRid(rid) && !incomingRids[rid]) { delete byRid[rid]; changed = true; }
    });

    if (!changed) return;
    var next = Object.keys(byRid).map(function (k) { return byRid[k]; });
    next.sort(function (a, b) { return String(a.time) < String(b.time) ? -1 : 1; });
    save(LS_STOCK, next);
    save(LS_BRIDGE_SEEN, seen);
    if (bc) { try { bc.postMessage({ type: "stock", stock: next }); } catch (e) {} }
    // 同一タブへの反映: KDS は storage イベント/BC を購読しているが、自タブには BC が届かないため
    // ページ側の再描画フックが無い場合に備え、控えめにリロードは行わず storage 書換のみとする。
    // (kds-a-grid.html に <script src> で読み込ませた場合、別タブ・別端末には即時反映される)
  }

  /* ===================== 厨房状態の端末間同期 (#132) =====================
     KDS は状態変更のたびに BroadcastChannel("kds_sync") へイベントを流しているが、
     BroadcastChannel は同一ブラウザ内にしか届かない。ここでそのイベントを拾って relay へ送り、
     relay が畳み込んだスナップショットを localStorage へ書き戻すことで別端末とも揃える。

     取り込みは localStorage へ書くだけでよい: KDS 本体は 1秒ごとの poll() で
     loadKonro()/loadDone()/loadLocked()/loadOrderSeq()/loadDeleted() を実行しており、
     書き換えた内容がそのまま次の描画に乗る (KDS 本体は無改修のまま)。 */
  var pending = [];          // 未送信のローカルイベント
  var flushTimer = null;
  var sending = false;
  var appliedRev = -1;       // 取り込み済みの relay rev
  var kitchenSession = null; // relay の起動識別子。再起動で rev が戻るのを検出する
  var seeded = false;        // 空の relay へ手元の状態を渡し済みか

  function onLocalKitchenEvent(msg) {
    if (!msg || !KITCHEN_EVENTS[msg.type]) return;
    pending.push(msg);
    if (flushTimer) return;
    flushTimer = setTimeout(function () { flushTimer = null; flushKitchen(); }, KITCHEN_FLUSH_MS);
  }

  async function flushKitchen() {
    if (sending || !pending.length) return;
    var batch = pending.splice(0, 200);   // relay 側の受理上限に合わせて分割する
    sending = true;
    try {
      var res = await fetch(API_KITCHEN, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events: batch }),
      });
      if (!res.ok) throw new Error(res.status);
      var body = await res.json();
      // 自分の変更が relay に載った時点の rev。これより古いスナップショットは取り込まない
      // (取り込むと、送った直後の操作が一瞬巻き戻って見える)
      if (body && typeof body.rev === "number") appliedRev = Math.max(appliedRev, body.rev - 1);
    } catch (e) {
      // 送信失敗: relay が落ちていても手元の KDS は動き続ける。イベントは捨てる
      // (状態は絶対値なので、次の操作で最新値が送られて追いつく)
    } finally {
      sending = false;
      if (pending.length) flushKitchen();
    }
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
    pending = pending.concat(events);
    flushKitchen();
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
    if (sending || pending.length) return;      // 送信中は自分の変更が反映される前なので取り込まない
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

  if (bc) {
    // KDS 本体が同一コンテキストで postMessage したものも、別の BroadcastChannel オブジェクトである
    // こちらには届く。つまり自タブ・他タブ・他端末のどの操作もここで拾える
    bc.onmessage = function (ev) { onLocalKitchenEvent(ev && ev.data); };
  }

  tickOnce();
  setInterval(tickOnce, POLL_MS);
  tickKitchen();
  setInterval(tickKitchen, KITCHEN_POLL_MS);
  console.log("[kds-bridge] 予約ストック取込を開始 (" + API + " を " + POLL_MS / 1000 + "秒間隔) / " +
    "厨房状態の端末間同期 (" + API_KITCHEN + " を " + KITCHEN_POLL_MS / 1000 + "秒間隔)");
})();
