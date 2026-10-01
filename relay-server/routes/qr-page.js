"use strict";

var relayConfig = require("../relay-config");

/* qrcode は /qr ページ専用なので、トップレベルでは読み込まない (#173)。
   npm install が済んでいない店内ミニPCで、QRページのためにサーバー全体
   (予約取込・KDS配信) を起動不能にしないため */
var qrcodeModule = null;
function loadQRCode() {
  if (!qrcodeModule) qrcodeModule = require("qrcode");
  return qrcodeModule;
}

/**
 * GET /qr — iPadでKDS/スタイル設定を開くQRコードのページ (#144追補)。
 * エンコードするURLは「今この端末が実際に他端末から見えるアドレス」を使う:
 * LAN IPで待ち受けていればそのIP、127.0.0.1待ち受けならLAN IPを検出して案内する
 */
function handleQrPage(res, config, hostHeader) {
  // このページを開いた端末が実際に到達したアドレス(Hostヘッダ)を最優先で使う。
  // PCが有線とWi-Fiの両方に繋がっていると、待ち受けアドレス(config.host)を埋めた場合に
  // 「iPadからは届かない側のIP」が載ったQRになる。0.0.0.0待ち受けではURLごと壊れる
  var fromHeader = typeof hostHeader === "string" ? hostHeader.trim() : "";
  var usable = fromHeader &&
    !/^(0\.0\.0\.0|\[?::\]?)(:\d+)?$/.test(fromHeader) &&
    !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(fromHeader);

  var base, reachable;
  if (usable) {
    base = (config.authCookieSecure === "1" || config.tlsCertFile ? "https://" : "http://") + fromHeader;
    reachable = true;
  } else {
    var isLoopback = config.host === "127.0.0.1" || config.host === "localhost";
    var lanIp = isLoopback ? relayConfig.detectLanIp() : config.host;
    if (lanIp === "0.0.0.0" || lanIp === "::") lanIp = relayConfig.detectLanIp();
    reachable = !!lanIp && lanIp !== "127.0.0.1";   // 127.0.0.1待ち受けでは他端末から届かない
    base = (config.authCookieSecure === "1" || config.tlsCertFile ? "https://" : "http://") +
      (lanIp || "127.0.0.1") + ":" + config.port;
  }
  // 認証有効時は QR にトークンを載せる。iPad は1回読めば Cookie が入り、以後は不要 (#174)
  var tokenQuery = config.authToken ? "?token=" + encodeURIComponent(config.authToken) : "";
  var kdsUrl = base + "/" + tokenQuery;
  var styleUrl = base + "/slip-style-designer.html" + tokenQuery;
  var QRCode;
  try { QRCode = loadQRCode(); }
  catch (err) {
    // 依存が入っていないだけ。原因が現地で分かるよう理由を返す (サーバー本体は動き続ける #173)。
    // QRが出せなくても、トークン付きURLを本文に出せば手入力で繋げる (#174)
    res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("QRページは qrcode パッケージが必要です。relay-server で npm install を実行してください。\n" +
      "接続先URL: " + kdsUrl + "\n");
  }
  Promise.all([
    QRCode.toDataURL(kdsUrl, { width: 420, margin: 2 }),
    QRCode.toDataURL(styleUrl, { width: 420, margin: 2 }),
  ]).then(function (imgs) {
    var html = renderQrPage({
      reachable: reachable,
      kdsUrl: kdsUrl,
      kdsImage: imgs[0],
      styleUrl: styleUrl,
      styleImage: imgs[1],
    });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  }).catch(function (err) {
    res.writeHead(500);
    res.end("QR生成に失敗しました: " + err.message);
  });
}

function renderQrPage(page) {
  var warn = page.reachable ? "" :
    '<p class="warn">⚠ いまサーバーは 127.0.0.1(このPC専用)で待ち受けているため、iPadからは届きません。' +
    'config/config.json の server.host を "auto" にして再起動してください。</p>';
  return '<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>iPad接続用QR</title><style>' +
    'body{font-family:sans-serif;background:#f4f1ec;color:#1a1612;text-align:center;padding:24px;margin:0}' +
    'h1{font-size:20px}h2{font-size:15px;margin:8px 0 4px}' +
    '.qr{display:inline-block;background:#fff;border:1px solid #ddd6cc;border-radius:8px;padding:16px;margin:12px}' +
    '.qr img{display:block;width:280px;height:280px}' +
    '.url{font-size:13px;color:#6b6258;word-break:break-all}' +
    '.warn{background:#fbeaea;color:#7a1f1f;border:1px solid #e3b8b8;border-radius:6px;padding:10px;max-width:560px;margin:12px auto}' +
    '</style></head><body>' +
    '<h1>iPadのカメラでQRを読むと開きます</h1>' + warn +
    '<div class="qr"><h2>KDS(厨房画面)</h2><img src="' + page.kdsImage + '" alt="KDSを開くQR"><div class="url">' + page.kdsUrl + '</div></div>' +
    '<div class="qr"><h2>印刷スタイル設定</h2><img src="' + page.styleImage + '" alt="スタイル設定を開くQR"><div class="url">' + page.styleUrl + '</div></div>' +
    '<p class="url">iPadはこのPCと同じWi-Fiにつないでください</p>' +
    '</body></html>';
}

module.exports = { handleQrPage: handleQrPage };
