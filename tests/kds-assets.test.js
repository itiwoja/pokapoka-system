"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readKdsSources } = require("./helpers/kds-source");
const { html, js, css } = readKdsSources();

test("KDSは同梱CSSとclassic scriptを従来の位置・依存順で読み込む", () => {
  assert.match(html, /<link rel="stylesheet" href="assets\/kds\/kds\.css">\s*<\/head>/);
  assert.doesNotMatch(html, /<style\b/i);
  const tags = html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) || [];
  assert.deepEqual(tags, [
    '<script src="slip-renderer.js"></script>',
    '<script src="relay-server/party-size.js"></script>',
    '<script src="serve-log.js"></script>',
    '<script src="assets/kds/kds.js"></script>',
  ]);
  assert.ok(html.indexOf('id="tableOverrideConfirmAllow"') < html.indexOf(tags[0]));
  assert.match(html, /<script src="assets\/kds\/kds\.js"><\/script>\s*<\/body>/);
});

test("KDSのIIFE・DOMContentLoaded待ち・機能フラグと動的印刷スタイルを維持する", () => {
  assert.match(js, /^  "use strict";\n  \(function \(\) \{/);
  assert.match(js, /if \(document\.readyState === "loading"\) \{\s*document\.addEventListener\("DOMContentLoaded", init\);\s*\} else \{\s*init\(\);\s*\}\s*\}\)\(\);\s*$/);
  assert.match(js, /var FEATURE_TIMER_LOCK\s*= false;/);
  assert.match(js, /var FEATURE_DELETE_ORDER\s*= false;/);
  assert.match(js, /var slipPageStyleEl = document\.createElement\("style"\);/);
  assert.match(js, /document\.head\.appendChild\(slipPageStyleEl\)/);
  assert.match(js, /@media print \{ \.slip \{ width: /);
  assert.match(css, /@media print/);
});
