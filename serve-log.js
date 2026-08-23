// ============================================================
// serve-log.js — 提供時間の計測ロジック（純粋関数）
//
// 「注文受付(start) → 全品目完了(completedAt)」までの提供時間を
// 記録・集計・CSV化するための純粋関数群。
// DOM・localStorage に一切依存しないため、ブラウザと Node（テスト）の
// 両方でそのまま動く。永続化とUI連携は app.js 側が担当する。
//
// 関連: GitHub Issue #29 [自動化] 提供時間の自動計測
//        PRD KPI「平均提供時間 MVP前比20%減」の導入前ベースライン計測基盤。
// ============================================================
(function (root) {
  'use strict';

  var TEN_MIN_MS = 10 * 60000;

  /**
   * 1注文から提供完了レコードを組み立てる。
   * @param {Object} order - KDS_ORDERS の1注文（id/table/type/people/start/items）
   * @param {number} completedAt - 全品目完了時刻（ms, Date.now()）
   * @returns {Object} 提供完了レコード
   */
  function buildServeRecord(order, completedAt) {
    var items = Array.isArray(order.items) ? order.items : [];
    var totalQty = items.reduce(function (sum, it) {
      return sum + (Number(it && it.qty) || 0);
    }, 0);
    return {
      orderId: order.id,
      table: order.table,
      type: order.type, // 'new' | 'reserved'
      people: order.people,
      itemCount: items.length,
      totalQty: totalQty,
      start: order.start, // 注文受付時刻(ms)
      completedAt: completedAt, // 全品目完了時刻(ms)
      serveMs: completedAt - order.start, // 提供時間(ms)
    };
  }

  /**
   * 提供時間ログから統計を算出する。
   * @param {Array} log - buildServeRecord のレコード配列
   * @returns {{count:number, avgServeMs:number, maxServeMs:number, minServeMs:number, over10minCount:number}}
   */
  function computeServeStats(log) {
    var records = Array.isArray(log) ? log : [];
    var count = records.length;
    if (count === 0) {
      return { count: 0, avgServeMs: 0, maxServeMs: 0, minServeMs: 0, over10minCount: 0 };
    }
    var total = 0;
    var max = -Infinity;
    var min = Infinity;
    var over10 = 0;
    for (var i = 0; i < records.length; i++) {
      var ms = Number(records[i].serveMs) || 0;
      total += ms;
      if (ms > max) max = ms;
      if (ms < min) min = ms;
      if (ms >= TEN_MIN_MS) over10 += 1;
    }
    return {
      count: count,
      avgServeMs: Math.round(total / count),
      maxServeMs: max,
      minServeMs: min,
      over10minCount: over10,
    };
  }

  /**
   * ミリ秒を "M分SS秒" に整形する。
   * @param {number} ms
   * @returns {string}
   */
  function formatDuration(ms) {
    var totalSec = Math.max(0, Math.round(Number(ms) / 1000));
    var m = Math.floor(totalSec / 60);
    var s = totalSec % 60;
    return m + '分' + String(s).padStart(2, '0') + '秒';
  }

  /**
   * CSVセルのエスケープ（カンマ・引用符・改行を含む値を安全化）。
   * @param {*} value
   * @returns {string}
   */
  function csvCell(value) {
    var s = String(value == null ? '' : value);
    if (/[",\r\n]/.test(s)) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  /**
   * ログを CSV 文字列に変換する（Excel/スプレッドシート取込用）。
   * 時刻は ISO8601、提供時間は秒で出力する。
   * @param {Array} log
   * @returns {string}
   */
  function toCSV(log) {
    var records = Array.isArray(log) ? log : [];
    var header = [
      'orderId', 'table', 'type', 'people', 'itemCount', 'totalQty',
      'start_iso', 'completedAt_iso', 'serveSeconds',
    ];
    var rows = records.map(function (r) {
      var startIso = new Date(r.start).toISOString();
      var doneIso = new Date(r.completedAt).toISOString();
      var serveSec = Math.round((Number(r.serveMs) || 0) / 1000);
      return [
        r.orderId, r.table, r.type, r.people, r.itemCount, r.totalQty,
        startIso, doneIso, serveSec,
      ].map(csvCell).join(',');
    });
    return [header.join(',')].concat(rows).join('\r\n');
  }

  var api = {
    buildServeRecord: buildServeRecord,
    computeServeStats: computeServeStats,
    formatDuration: formatDuration,
    csvCell: csvCell,
    toCSV: toCSV,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api; // Node（テスト）
  } else {
    root.ServeLog = api; // ブラウザ（window.ServeLog）
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
