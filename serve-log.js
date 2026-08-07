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

  function pad2(n) { return String(n).padStart(2, '0'); }

  /**
   * epoch ms を営業日キー "YYYY-MM-DD"（ローカル時刻）に変換する。
   * kds-a-grid.html の todayStr() と同じ規則。日付が読めない場合は空文字。
   * @param {number} ms
   * @returns {string}
   */
  function dayKey(ms) {
    var d = new Date(Number(ms));
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /**
   * レコードの営業日を取り出す。day を持たない旧レコードは completedAt から導く。
   * @param {Object} record
   * @returns {string}
   */
  function recordDay(record) {
    if (record && typeof record.day === 'string' && record.day) return record.day;
    return dayKey(record && record.completedAt);
  }

  /** "YYYY-MM-DD" を n 日戻した日付キー。読めない入力には空文字を返す */
  function shiftDayKey(dayStr, minusDays) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayStr));
    if (!m) return '';
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    d.setDate(d.getDate() - (Number(minusDays) || 0));
    return dayKey(d.getTime());
  }

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
      day: dayKey(completedAt), // 営業日 "YYYY-MM-DD"。ローテーションと重複判定の軸 (#179)
    };
  }

  /**
   * ログを「直近 keepDays 営業日ぶん」かつ「maxRecords 件以内」に切り詰める (#179)。
   *
   * このログは追記されるだけで減る契機が無く、放置すると localStorage の 5MB 上限に
   * 到達する。上限に達した時点で KDS の保存関数が軒並み黙って失敗するため、
   * 長期保管は CSV 書き出し(toCSV)に任せて、ブラウザ側は直近ぶんだけ持つ。
   *
   * @param {Array} log
   * @param {string} today - 今日の営業日キー "YYYY-MM-DD"
   * @param {number} keepDays - 今日を含めて何日ぶん残すか（1以上）
   * @param {number} [maxRecords] - 件数上限（0/未指定なら無制限）。超過分は古い順に捨てる
   * @returns {Array} 切り詰めた新しい配列（入力は変更しない）
   */
  function pruneServeLog(log, today, keepDays, maxRecords) {
    var records = Array.isArray(log) ? log : [];
    var days = Math.max(1, Number(keepDays) || 1);
    var cutoff = shiftDayKey(today, days - 1);
    var kept = records;
    if (cutoff) {
      kept = records.filter(function (r) {
        var d = recordDay(r);
        return d ? d >= cutoff : false; // 日付が読めないレコードは壊れているので落とす
      });
    }
    var cap = Number(maxRecords) || 0;
    if (cap > 0 && kept.length > cap) kept = kept.slice(kept.length - cap);
    return kept === records ? records.slice() : kept;
  }

  /**
   * 指定 orderId が既に記録済みか。day を渡すとその営業日のぶんだけを見る (#179)。
   *
   * 重複ガードを永続ログ全体に掛けると、POS の注文IDが日次リセットの連番だった場合に
   * 2日目以降の記録が丸ごと落ちる。当日分に限定すればその取りこぼしが起きない。
   *
   * @param {Array} log
   * @param {string|number} orderId
   * @param {string} [day] - "YYYY-MM-DD"。省略時は全期間を対象にする
   * @returns {boolean}
   */
  function hasServeRecord(log, orderId, day) {
    var records = Array.isArray(log) ? log : [];
    var id = String(orderId);
    for (var i = records.length - 1; i >= 0; i--) { // 直近から見る方が早く当たる
      var r = records[i];
      if (!r || String(r.orderId) !== id) continue;
      if (day && recordDay(r) !== day) continue;
      return true;
    }
    return false;
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
    dayKey: dayKey,
    recordDay: recordDay,
    pruneServeLog: pruneServeLog,
    hasServeRecord: hasServeRecord,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api; // Node（テスト）
  } else {
    root.ServeLog = api; // ブラウザ（window.ServeLog）
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
