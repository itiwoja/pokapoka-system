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

console.log('\n' + passed + ' 件のテストが通過しました。');
