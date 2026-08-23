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
  var LS_STOCK = "kds_stock_v1";
  var LS_BRIDGE_SEEN = "kds_bridge_seen_v1"; // 一度取り込んだ rid (着手/削除後の復活防止)
  var BC_NAME = "kds_sync";
  var POLL_MS = 5000;                        // 店内 LAN なので短くてよい (対 TableCheck の30秒とは別物)

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

  tickOnce();
  setInterval(tickOnce, POLL_MS);
  console.log("[kds-bridge] 予約ストック取込を開始 (" + API + " を " + POLL_MS / 1000 + "秒間隔)");
})();
