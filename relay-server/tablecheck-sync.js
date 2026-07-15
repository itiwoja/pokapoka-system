/**
 * tablecheck-sync.js — TableCheck 予約取込の純粋ロジック
 *
 * server.js から使う正規化・upsert・パージ処理を、serve-log.js と同様に
 * 依存ゼロの純粋関数として切り出したもの (node tablecheck-sync.test.js で検証)。
 *
 * ⚠️ スキーマ未確定フィールドについて (Issue #74):
 *   TableCheck の予約オブジェクトの正確なフィールド名 (顧客名・大人/子供内訳・
 *   メニュー・アレルギー) は API コンソールでの確認待ち。normalizeReservation()
 *   は「ありそうな候補キー」を広めに受け、確定後にここだけ直せば済む構造にしてある。
 */
"use strict";

/** 予約ステータスのうち、KDS 予約ストックに載せてよいもの */
var ACTIVE_STATUSES = ["booked", "confirmed", "reserved", "pending"];

/**
 * TableCheck の予約オブジェクト → 中継サーバー内部レコードへ正規化。
 * @param {Object} r - TableCheck API の予約オブジェクト (スキーマ一部未確定)
 * @returns {Object|null} 内部レコード。必須項目が無ければ null (取り込まない)
 */
function normalizeReservation(r) {
  if (!r || r.id == null) return null;
  var startAt = r.start_at || r.startAt || null;
  if (!startAt) return null;

  // 人数: 内訳フィールドの有無が未確定。候補キーを順に探し、無ければ pax 合計を adults に寄せる
  var adults = firstNum(r.adults, r.pax_adults, r.adult_pax);
  var kids = firstNum(r.kids, r.pax_kids, r.child_pax, r.children);
  var pax = firstNum(r.pax, r.party_size);
  if (adults == null && pax != null) { adults = pax - (kids || 0); }

  return {
    rid: String(r.id),
    startAt: startAt,                                   // ISO8601 (TZ付き) のまま保持
    adults: adults != null ? adults : 0,
    kids: kids != null ? kids : 0,
    name: firstStr(r.customer_name, r.guest_name, r.name,
      r.customer && (r.customer.last_name || r.customer.name)) || "(名前なし)",
    status: normalizeStatus(r.status),
    menu: normalizeMenu(r),
    memo: firstStr(r.memo, r.notes) || null,            // メニューが memo 経由の場合に備え保持
    updatedAt: r.updated_at || r.updatedAt || null,
  };
}

/** TableCheck 側 status → 内部 status */
function normalizeStatus(s) {
  s = String(s || "").toLowerCase();
  if (/cancel/.test(s)) return "canceled";
  if (/no[_ -]?show/.test(s)) return "no_show";
  if (/seat|arriv/.test(s)) return "seated";
  if (/done|complete|finish/.test(s)) return "done";
  return "booked";
}

/**
 * メニュー明細の正規化。
 * 構造化フィールド (courses / menu_items 等 — 名称は要確認) があれば優先。
 * 無ければ memo の自由テキストから「品名 x数量」形式を試験的にパースする。
 */
function normalizeMenu(r) {
  var src = r.courses || r.menu_items || r.dining_experiences || r.items || null;
  if (Array.isArray(src) && src.length) {
    return src.map(function (m) {
      return {
        name: firstStr(m.name, m.title, m.item_name) || "(不明)",
        qty: firstNum(m.qty, m.quantity, m.count) || 1,
        options: firstStr(m.options, m.options_text, m.option) || null,
        allergies: firstStr(m.allergies, m.allergy, m.allergyInfo, m.allergies_text) || null,
      };
    });
  }
  return parseMenuFromMemo(firstStr(r.memo, r.notes) || "");
}

/**
 * memo 自由テキストの簡易パーサ (フォールバック)。
 * 「山城牛の焼きすき土鍋御膳 x2」「御膳×2」「御膳 2個」等を1行1品として拾う。
 * 店側で予約メモの記載フォーマットを揃える運用と対になる。
 */
function parseMenuFromMemo(memo) {
  if (!memo) return [];
  var out = [];
  memo.split(/\r?\n|、|,/).forEach(function (line) {
    line = line.trim();
    if (!line) return;
    var m = line.match(/^(.+?)\s*[x×✕]\s*(\d+)\s*$/) || line.match(/^(.+?)\s+(\d+)\s*(?:個|つ|名分)?$/);
    if (m) out.push({ name: m[1].trim(), qty: Number(m[2]), options: null, allergies: null });
  });
  return out;
}

/**
 * SyncEvent 群を内部ストアへ適用する (created/updated = upsert, deleted = 削除)。
 * TableCheck 推奨のイベント処理方針に従う:
 *   - created/updated は区別せず upsert
 *   - 未知 ID の deleted は無視
 *   - フェッチで 404 だった予約は削除扱い (fetchResult に null を渡す)
 * @param {Map<string,Object>} store - rid -> 内部レコード
 * @param {Array<{rid:string, record:(Object|null)}>} fetched - イベントで検知した予約の取得結果
 * @returns {number} 変更件数
 */
function applyFetched(store, fetched) {
  var changed = 0;
  (fetched || []).forEach(function (f) {
    if (!f || !f.rid) return;
    if (f.record == null) {                       // 404 = 削除扱い
      if (store.delete(String(f.rid))) changed++;
      return;
    }
    store.set(String(f.rid), f.record);
    changed++;
  });
  return changed;
}

/**
 * 当日分パージ + 非アクティブ除去。KDS へ渡す直前に呼ぶ。
 * (6/18 議事録「注文・予約データはサーバに保存しない (当日分のみ)」を実装で担保)
 * @param {Map<string,Object>} store
 * @param {Date} now
 */
function purge(store, now) {
  var today = localDateStr(now);
  Array.from(store.entries()).forEach(function (e) {
    var rid = e[0], rec = e[1];
    var d = new Date(rec.startAt);
    var notToday = isNaN(d) || localDateStr(d) !== today;
    var inactive = ACTIVE_STATUSES.indexOf(rec.status) < 0;
    if (notToday || inactive) store.delete(rid);
  });
}

/**
 * 内部レコード → KDS 予約ストック形式 ({rid,time,adults,kids,name,menu,seenAt})。
 * メニューが空の予約 (席だけ予約) は KDS に出さない (db-design §5.1 / deshup-spec 準拠)。
 * @param {Map<string,Object>} store
 * @param {number} seenAt - 取込時刻 (ms)
 */
function toKdsStock(store, seenAt) {
  var out = [];
  store.forEach(function (rec) {
    if (!rec.menu || !rec.menu.length) return;    // 席だけ予約は載せない
    var d = new Date(rec.startAt);
    out.push({
      rid: rec.rid,
      time: isNaN(d) ? String(rec.startAt) : pad2(d.getHours()) + ":" + pad2(d.getMinutes()),
      adults: rec.adults, kids: rec.kids,
      name: rec.name,
      menu: rec.menu,
      seenAt: seenAt,
    });
  });
  out.sort(function (a, b) { return a.time < b.time ? -1 : a.time > b.time ? 1 : 0; });
  return out;
}

/* ---- 小道具 ---- */
function firstNum() { for (var i = 0; i < arguments.length; i++) { var v = arguments[i]; if (v != null && v !== "" && !isNaN(Number(v))) return Number(v); } return null; }
function firstStr() { for (var i = 0; i < arguments.length; i++) { var v = arguments[i]; if (typeof v === "string" && v.trim()) return v.trim(); } return null; }
function pad2(n) { return (n < 10 ? "0" : "") + n; }
function localDateStr(d) { return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }

module.exports = {
  normalizeReservation: normalizeReservation,
  normalizeStatus: normalizeStatus,
  normalizeMenu: normalizeMenu,
  parseMenuFromMemo: parseMenuFromMemo,
  applyFetched: applyFetched,
  purge: purge,
  toKdsStock: toKdsStock,
  ACTIVE_STATUSES: ACTIVE_STATUSES,
};
