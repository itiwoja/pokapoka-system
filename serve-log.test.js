// ============================================================
// serve-log.test.js — 依存ゼロの素の Node テスト
// 実行: node mockup/serve-log.test.js
//
// serve-log.js の純粋関数を検証する。フレームワーク・外部パッケージ不要。
// ============================================================
var assert = require('assert');
var SL = require('./serve-log.js');

var passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log('  ✓ ' + name);
}

// ---- buildServeRecord ----
test('buildServeRecord は serveMs を completedAt - start で算出する', function () {
  var order = { id: 'ord-1', table: 'A1', type: 'new', people: 2, start: 1000, items: [{ qty: 2 }, { qty: 1 }] };
  var rec = SL.buildServeRecord(order, 61000);
  assert.strictEqual(rec.serveMs, 60000);
  assert.strictEqual(rec.itemCount, 2);
  assert.strictEqual(rec.totalQty, 3);
  assert.strictEqual(rec.table, 'A1');
  assert.strictEqual(rec.type, 'new');
});

test('buildServeRecord は items 未定義でも壊れない', function () {
  var rec = SL.buildServeRecord({ id: 'x', start: 0 }, 5000);
  assert.strictEqual(rec.itemCount, 0);
  assert.strictEqual(rec.totalQty, 0);
  assert.strictEqual(rec.serveMs, 5000);
});

// ---- computeServeStats ----
test('computeServeStats は空ログで count 0 を返す', function () {
  var s = SL.computeServeStats([]);
  assert.strictEqual(s.count, 0);
  assert.strictEqual(s.avgServeMs, 0);
});

test('computeServeStats は平均・最大・最小・10分超件数を算出する', function () {
  var log = [{ serveMs: 2 * 60000 }, { serveMs: 8 * 60000 }, { serveMs: 11 * 60000 }];
  var s = SL.computeServeStats(log);
  assert.strictEqual(s.count, 3);
  assert.strictEqual(s.avgServeMs, 7 * 60000);
  assert.strictEqual(s.maxServeMs, 11 * 60000);
  assert.strictEqual(s.minServeMs, 2 * 60000);
  assert.strictEqual(s.over10minCount, 1);
});

// ---- formatDuration ----
test('formatDuration は M分SS秒 形式で返す', function () {
  assert.strictEqual(SL.formatDuration(0), '0分' + '00秒');
  assert.strictEqual(SL.formatDuration(65000), '1分' + '05秒');
  assert.strictEqual(SL.formatDuration(600000), '10分' + '00秒');
});

// ---- toCSV / csvCell ----
test('toCSV はヘッダ + データ行を CRLF 区切りで返す', function () {
  var log = [{
    orderId: 'o1', table: 'A1', type: 'new', people: 2,
    itemCount: 2, totalQty: 3, start: 0, completedAt: 60000, serveMs: 60000,
  }];
  var csv = SL.toCSV(log);
  var lines = csv.split('\r\n');
  assert.strictEqual(lines.length, 2);
  assert.ok(lines[0].indexOf('orderId,table,type') === 0);
  assert.ok(lines[1].indexOf('o1') !== -1);
  assert.ok(lines[1].indexOf(',60') !== -1); // serveSeconds = 60
});

test('csvCell はカンマ/引用符を含む値をエスケープする', function () {
  assert.strictEqual(SL.csvCell('a,b'), '"a,b"');
  assert.strictEqual(SL.csvCell('he said "hi"'), '"he said ""hi"""');
  assert.strictEqual(SL.csvCell('plain'), 'plain');
});

// ---- dayKey / recordDay (#179) ----
test('dayKey は epoch ms をローカル日の YYYY-MM-DD にする', function () {
  var ms = new Date(2026, 7, 7, 13, 45, 0).getTime(); // 2026-08-07 13:45 ローカル
  assert.strictEqual(SL.dayKey(ms), '2026-08-07');
});

test('dayKey は月日を2桁ゼロ埋めする', function () {
  assert.strictEqual(SL.dayKey(new Date(2026, 0, 3, 9, 0, 0).getTime()), '2026-01-03');
});

test('dayKey は読めない入力に空文字を返す', function () {
  assert.strictEqual(SL.dayKey(NaN), '');
  assert.strictEqual(SL.dayKey('あ'), '');
});

test('buildServeRecord は completedAt から day を付ける', function () {
  var done = new Date(2026, 7, 7, 20, 0, 0).getTime();
  var rec = SL.buildServeRecord({ id: 'o1', start: done - 60000, items: [] }, done);
  assert.strictEqual(rec.day, '2026-08-07');
});

test('recordDay は day を持たない旧レコードを completedAt から導く', function () {
  var done = new Date(2026, 7, 5, 12, 0, 0).getTime();
  assert.strictEqual(SL.recordDay({ orderId: 'old', completedAt: done }), '2026-08-05');
  assert.strictEqual(SL.recordDay({ orderId: 'new', completedAt: done, day: '2026-08-06' }), '2026-08-06');
});

// ---- pruneServeLog (#179) ----
function rec(id, day) { return { orderId: id, day: day, completedAt: 0, serveMs: 1000 }; }

test('pruneServeLog は keepDays より古いレコードを落とす', function () {
  var log = [rec('a', '2026-08-01'), rec('b', '2026-08-05'), rec('c', '2026-08-07')];
  var kept = SL.pruneServeLog(log, '2026-08-07', 3);
  assert.deepStrictEqual(kept.map(function (r) { return r.orderId; }), ['b', 'c']);
});

test('pruneServeLog は keepDays=1 なら当日分だけ残す', function () {
  var log = [rec('a', '2026-08-06'), rec('b', '2026-08-07')];
  assert.deepStrictEqual(SL.pruneServeLog(log, '2026-08-07', 1).map(function (r) { return r.orderId; }), ['b']);
});

test('pruneServeLog は月をまたぐ境界でも正しく数える', function () {
  var log = [rec('jul30', '2026-07-30'), rec('jul31', '2026-07-31'), rec('aug01', '2026-08-01')];
  // 2026-08-01 から3日ぶん = 07-30 以降
  assert.strictEqual(SL.pruneServeLog(log, '2026-08-01', 3).length, 3);
  assert.deepStrictEqual(SL.pruneServeLog(log, '2026-08-01', 2).map(function (r) { return r.orderId; }),
    ['jul31', 'aug01']);
});

test('pruneServeLog は maxRecords 超過分を古い順に捨てる', function () {
  var log = [rec('a', '2026-08-07'), rec('b', '2026-08-07'), rec('c', '2026-08-07')];
  assert.deepStrictEqual(SL.pruneServeLog(log, '2026-08-07', 14, 2).map(function (r) { return r.orderId; }),
    ['b', 'c']);
});

test('pruneServeLog は day も completedAt も読めないレコードを落とす', function () {
  var log = [{ orderId: 'broken', completedAt: NaN }, rec('ok', '2026-08-07')];
  assert.deepStrictEqual(SL.pruneServeLog(log, '2026-08-07', 14).map(function (r) { return r.orderId; }), ['ok']);
});

test('pruneServeLog は入力配列を変更しない', function () {
  var log = [rec('a', '2026-08-01'), rec('b', '2026-08-07')];
  SL.pruneServeLog(log, '2026-08-07', 1);
  assert.strictEqual(log.length, 2);
});

test('pruneServeLog は配列以外や空を渡されても壊れない', function () {
  assert.deepStrictEqual(SL.pruneServeLog(null, '2026-08-07', 14), []);
  assert.deepStrictEqual(SL.pruneServeLog([], '2026-08-07', 14), []);
});

// ---- hasServeRecord (#179) ----
test('hasServeRecord は当日分に限定して重複を判定する', function () {
  var log = [rec('1', '2026-08-06'), rec('2', '2026-08-07')];
  // POS が日次リセットの連番を吐く想定: 昨日の "1" は今日の "1" を弾いてはいけない
  assert.strictEqual(SL.hasServeRecord(log, '1', '2026-08-07'), false);
  assert.strictEqual(SL.hasServeRecord(log, '2', '2026-08-07'), true);
});

test('hasServeRecord は day 省略時に全期間を見る', function () {
  var log = [rec('1', '2026-08-06')];
  assert.strictEqual(SL.hasServeRecord(log, '1'), true);
});

test('hasServeRecord は数値/文字列の orderId を同一視する', function () {
  var log = [{ orderId: 7, day: '2026-08-07', completedAt: 0 }];
  assert.strictEqual(SL.hasServeRecord(log, '7', '2026-08-07'), true);
});

console.log('\n' + passed + ' 件のテストが通過しました。');
