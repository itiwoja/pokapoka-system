/**
 * party-size.js — 予約の人数の区分・合計・内訳表示を1か所にまとめる
 *
 * 人数は 大人 (adults)・シニア (seniors)・子供 (children)・幼児 (kids、0〜2歳) を分けて持ち、まとめない。
 * 合計と内訳の表示はここで決め、中継サーバー (reservation-import.js)、予約入力画面 (reservation-entry.html)、
 * KDS (kds-a-grid.html) が共有する。画面からは <script src="relay-server/party-size.js"> で読み、window.PartySize として使う。
 *
 * 区分を足す・名前を変えるときは、ここに加えて次も直す (それぞれ書き方の違う入口のため、ここには寄せていない)。
 *   - reservation-import.js の PEOPLE_PATTERNS・CSV_FIELDS・TEXT_LABELS (取込で読む列名・ラベルの表記ゆれ)
 *   - reservation-store.js の列 (ADDED_COLUMNS・validate・fromRow) と kds-bridge.js の予約の変更判定
 *   - kds-a-grid.html の PEOPLE_FALLBACK (このファイルを読めないときの代わり) と予約入力画面の入力欄
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PartySize = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* key: 予約データの項目名 / label: 画面の表記 / short: KDS カードの略記 */
  var KINDS = [
    { key: "adults", label: "大人", short: "大" },
    { key: "seniors", label: "シニア", short: "シ" },
    { key: "children", label: "子供", short: "子" },
    { key: "kids", label: "幼児", short: "幼" },
  ];
  var KEYS = KINDS.map(function (k) { return k.key; });

  function count(rec, key) {
    var n = Number(rec && rec[key]);
    return isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  /** 4区分がすべて0の人数 */
  function zero() {
    var out = {};
    KEYS.forEach(function (key) { out[key] = 0; });
    return out;
  }

  /** 合計人数 (大人+シニア+子供+幼児) */
  function total(rec) {
    return KEYS.reduce(function (sum, key) { return sum + count(rec, key); }, 0);
  }

  /**
   * 0人でない区分の内訳 ([{key,label,short,n}])。
   * options.onlyMixed が真なら、大人だけのときは空にする (KDS は合計だけで足りるため)
   */
  function breakdown(rec, options) {
    var parts = KINDS.filter(function (k) { return count(rec, k.key) > 0; })
      .map(function (k) { return { key: k.key, label: k.label, short: k.short, n: count(rec, k.key) }; });
    if (options && options.onlyMixed && parts.every(function (p) { return p.key === "adults"; })) return [];
    return parts;
  }

  return {
    KINDS: KINDS,
    KEYS: KEYS,
    zero: zero,
    total: total,
    breakdown: breakdown,
  };
});
