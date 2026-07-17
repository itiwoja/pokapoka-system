/**
 * ipad-qr.js — iPadでKDSを開くためのQRコードを作る
 *
 * やること:
 *   1. このPCの今のWi-Fi/LANのIPアドレスを自動検出
 *   2. config/config.json の server.host をそのIPに書き換え
 *      (これでサーバーがiPad等の他端末から見えるようになる)
 *   3. KDSと印刷スタイル設定ツールのURLをQRコード画像(docs/qr-kds.png,
 *      docs/qr-style.png)にして保存 + ターミナルにも表示
 *
 * 使い方:  node tools\ipad-qr.js
 * その後:  node relay-server\server.js でサーバーを起動(既に起動中なら再起動)
 *
 * 店のWi-Fiに繋ぎ直す等でIPが変わったら、もう一度これを実行するだけでよい。
 */
"use strict";

var os = require("os");
var fs = require("fs");
var path = require("path");
var QRCode = require("qrcode");

var PORT = 8000;
var root = path.resolve(__dirname, "..");
var configPath = path.join(root, "config", "config.json");

/* 1. LANのIPv4を検出 (内部ループバックとリンクローカルを除く) */
function findLanIp() {
  var ifaces = os.networkInterfaces();
  var candidates = [];
  Object.keys(ifaces).forEach(function (name) {
    (ifaces[name] || []).forEach(function (addr) {
      if (addr.family !== "IPv4" || addr.internal) return;
      if (addr.address.indexOf("169.254.") === 0) return; // リンクローカルは除外
      candidates.push({ name: name, address: addr.address });
    });
  });
  if (candidates.length === 0) {
    console.error("LANのIPが見つかりません。Wi-Fiに接続してから再実行してください。");
    process.exit(1);
  }
  // Wi-Fiを優先、なければ最初のもの
  var wifi = candidates.filter(function (c) { return /wi-?fi|wlan|無線/i.test(c.name); });
  return (wifi[0] || candidates[0]).address;
}

/* 2. config.json の server.host を更新 (無ければ最小構成で作る) */
function updateConfig(ip) {
  var config = {};
  try { config = JSON.parse(fs.readFileSync(configPath, "utf8")); } catch (e) {}
  config.server = config.server || {};
  config.server.host = ip;
  config.server.port = config.server.port || PORT;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  return config.server.port;
}

var ip = findLanIp();
var port = updateConfig(ip);
var kdsUrl = "http://" + ip + ":" + port + "/";
var styleUrl = "http://" + ip + ":" + port + "/slip-style-designer.html";

var docsDir = path.join(root, "docs");
if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir);

Promise.all([
  QRCode.toFile(path.join(docsDir, "qr-kds.png"), kdsUrl, { width: 480, margin: 2 }),
  QRCode.toFile(path.join(docsDir, "qr-style.png"), styleUrl, { width: 480, margin: 2 }),
  QRCode.toString(kdsUrl, { type: "terminal", small: true }),
]).then(function (results) {
  console.log("");
  console.log("========================================");
  console.log(" iPadで下のQRを読むとKDSが開きます");
  console.log(" URL: " + kdsUrl);
  console.log("========================================");
  console.log(results[2]);
  console.log("スタイル設定ツール: " + styleUrl);
  console.log("");
  console.log("QR画像も保存しました:");
  console.log("  docs\\qr-kds.png   (KDS)");
  console.log("  docs\\qr-style.png (スタイル設定)");
  console.log("");
  console.log("次にやること: サーバーを起動(既に動いていたら一度 Ctrl+C で止めてから)");
  console.log("  node relay-server\\server.js");
}).catch(function (err) {
  console.error("QR生成に失敗しました: " + err.message);
  process.exit(1);
});
