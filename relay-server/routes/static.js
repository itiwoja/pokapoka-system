"use strict";

var fs = require("fs");
var path = require("path");
var httpUtil = require("../http-util");

var KDS_PAGE = "kds-a-grid.html";

/* リポジトリ直下から配信してよいファイル。ここに無いパスは存在しても 404 にする */
var ALLOWED_STATIC_FILES = [
  KDS_PAGE,
  "slip-style-designer.html",   // 印刷スタイル設定ツール。KDSと同一オリジンで配信しlocalStorageを共有する
  "slip-renderer.js",           // 伝票レイアウトの描画エンジン。フォーマッターとKDSで同じ絵を出すため共有する
  path.join("assets", "sounds", "shishiodoshi.ogg"), // 新規注文通知音。出典は assets/sounds/README.md
  path.join("relay-server", "kds-bridge.js"),
];

/** root (リポジトリ直下) 配下の許可済みファイルを配信する。"/" と "/kds" は KDS 画面 */
function serveStatic(res, url, root) {
  var rel;
  try { rel = (url.pathname === "/" || url.pathname === "/kds") ? "/" + KDS_PAGE : decodeURIComponent(url.pathname); }
  catch (err) { return httpUtil.text(res, 400, "bad request"); }
  // URL内のWindows/POSIX両方の区切りを同じものとして扱い、実行OSに関係なく
  // エンコードされたパストラバーサルをallowlist判定より先に拒否する。
  rel = rel.replace(/[\\/]/g, path.sep);
  var file = path.normalize(path.join(root, rel));
  var relativePath = path.relative(root, file);
  if (relativePath === ".." || relativePath.indexOf(".." + path.sep) === 0 || path.isAbsolute(relativePath)) {
    return httpUtil.text(res, 403, "forbidden");
  }
  if (ALLOWED_STATIC_FILES.indexOf(relativePath) < 0) return httpUtil.text(res, 404, "not found");

  fs.readFile(file, function (err, data) {
    if (err) return httpUtil.text(res, 404, "not found");
    if (path.basename(file) === KDS_PAGE) data = injectBridge(data);
    res.writeHead(200, { "Content-Type": httpUtil.contentType(file) });
    res.end(data);
  });
}

/** KDS 画面へ取込ブリッジの script 要素を差し込む。ディスク上のファイルは変更しない */
function injectBridge(data) {
  var html = data.toString("utf8");
  // 説明コメント中のファイル名ではなく、実際のscript要素だけを注入済みと判定する。
  // KDS本体には接続方法のコメントにも "kds-bridge.js" が現れるため、単純な文字列検索は使わない。
  var hasBridgeScript = /<script\b[^>]*\bsrc=["']\/relay-server\/kds-bridge\.js["'][^>]*><\/script>/i.test(html);
  if (hasBridgeScript || html.indexOf("</body>") < 0) return data;
  return Buffer.from(html.replace("</body>",
    '  <script>window.__KDS_SUPPRESS_DEMO__=true;</script>\n' +
    '  <script src="/relay-server/kds-bridge.js"></script>\n</body>'), "utf8");
}

module.exports = { serveStatic: serveStatic };
