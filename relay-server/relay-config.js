/**
 * relay-config.js — 中継サーバーの実行時設定を組み立てる
 *
 * 優先順位は「既定値 < config/config.json < 環境変数」。ファイルの読込は load-config.js が担い、
 * ここは env 形のオーバーレイを受け取って、検証・既定値・下限クランプを適用した設定へ変換する。
 */
"use strict";

var os = require("os");
var auth = require("./auth");
var loadConfig = require("./load-config");

function createConfig(env, options) {
  // 既定値 < config/config.json < 環境変数。ファイル由来の値も env と同じ経路を通るので、
  // 下限クランプや HTTPS 検証はどちらから来た値にも等しく効く。
  var src = loadConfig.mergeEnv(options.configFile || {}, env);
  var apiKey = src.TABLECHECK_API_KEY || "";
  var isMock = src.MOCK === "1" || !apiKey;
  var shopId = src.SHOP_ID || "";
  var base = src.TABLECHECK_BASE || "https://api.tablecheck.com";
  if (!isMock && !shopId) throw new Error("SHOP_ID is required in LIVE mode");
  if (!isMock) validateTableCheckBase(base, src.TABLECHECK_ALLOW_CUSTOM_BASE === "1");
  var pollMs = normalizeInterval(src.POLL_MS, isMock ? 3000 : 30000, isMock ? 100 : 30000);
  var resyncMs = normalizeInterval(src.RESYNC_MS, 900000, isMock ? 1000 : 60000);
  return {
    port: options.port !== undefined ? options.port : (Number(src.PORT) || 8000),
    host: resolveHost(src.HOST),
    apiKey: apiKey,
    shopId: shopId,
    base: base,
    isMock: isMock,
    pollMs: pollMs,
    resyncMs: resyncMs,
    requestTimeoutMs: normalizeInterval(src.TABLECHECK_TIMEOUT_MS, 15000, 1000, 120000),
    seatBeforeMin: Math.max(Number(src.SEAT_BEFORE_MIN) || 30, 0),
    seatAfterMin: Math.max(Number(src.SEAT_AFTER_MIN) || 120, 0),
    // ローカル登録した占有をいつ諦めるか。POS連携が無く「退店した」というイベントが
    // 存在しないため、解除し忘れた席が永久に埋まったままにならないよう時間で切る (#123)
    seatWalkinTtlMs: normalizeInterval(src.SEAT_WALKIN_TTL_MIN, 120, 1, 1440) * 60000,
    // 厨房状態(#132)を最後の更新から何分保持するか。常駐プロセスなので、
    // 掃除しないと前日の完了・コンロ状態が翌日へ持ち越される (#115)
    kitchenTtlMs: normalizeInterval(src.KITCHEN_TTL_MIN, 720, 1, 1440) * 60000,
    // 注文の保持上限。常駐プロセスなので、掃除しないと日跨ぎで前日の注文が残る (#115)
    orderTtlMs: normalizeInterval(src.ORDER_TTL_MIN, 720, 1, 1440) * 60000,
    // 未設定なら認証なし (従来どおり)。店内Wi-Fiを客と共用する場合に設定する (#174)
    authToken: auth.normalizeToken(src.RELAY_TOKEN),
    // ミニPC自身(ループバック)を信頼するか。既定は信頼する — QRでトークンを配る導線が
    // ミニPC上の /qr から始まるため。ミニPCを他人が触る運用なら 0 にする
    authTrustLoopback: src.RELAY_TRUST_LOOPBACK !== "0",
    // autoは実際のTLSソケットだけを信頼する。X-Forwarded-Protoは任意クライアントが
    // 偽装できるため参照しない。TLS終端プロキシ利用時は明示的に1へ設定する (#209)
    authCookieSecure: normalizeCookieSecure(src.RELAY_COOKIE_SECURE),
  };
}

function normalizeCookieSecure(value) {
  if (value === undefined || value === null || value === "") return "auto";
  var normalized = String(value).toLowerCase();
  if (normalized === "auto" || normalized === "1" || normalized === "0") return normalized;
  throw new Error("auth.cookieSecure は auto / true / false (環境変数は auto / 1 / 0) のいずれかにする");
}

/**
 * 待ち受けホストの解決。"auto" なら今のLAN IPv4を検出して使う (#144追補)。
 * 店/自宅などWi-Fiが変わるとIPも変わるため、config.json に実IPを書くと陳腐化する。
 * "auto" にしておけば起動のたびに正しいIPで待ち受け、iPad等の他端末から届く。
 * 0.0.0.0(全IF)は使わない方針のまま(検出できないときは従来どおり 127.0.0.1)。
 */
function resolveHost(value) {
  if (!value) return "127.0.0.1";
  if (value !== "auto") return value;
  return detectLanIp() || "127.0.0.1";
}

/** 今のLAN IPv4 (ループバック・リンクローカル除外。Wi-Fi優先) */
function detectLanIp() {
  var ifaces = os.networkInterfaces();
  var candidates = [];
  Object.keys(ifaces).forEach(function (name) {
    (ifaces[name] || []).forEach(function (addr) {
      if (addr.family !== "IPv4" || addr.internal) return;
      if (addr.address.indexOf("169.254.") === 0) return;
      candidates.push({ name: name, address: addr.address });
    });
  });
  var wifi = candidates.filter(function (c) { return /wi-?fi|wlan|無線/i.test(c.name); });
  var hit = wifi[0] || candidates[0];
  return hit ? hit.address : null;
}

function normalizeInterval(value, fallback, minimum, maximum) {
  var number = Number(value);
  if (!Number.isFinite(number) || number <= 0) number = fallback;
  number = Math.round(number);
  return Math.min(Math.max(number, minimum), maximum || 2147483647);
}

function validateTableCheckBase(base, allowCustom) {
  var url;
  try { url = new URL(base); }
  catch (err) { throw new Error("TABLECHECK_BASE must be a valid HTTPS URL"); }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("TABLECHECK_BASE must be a valid HTTPS URL without credentials");
  }
  if (url.hostname !== "api.tablecheck.com" && !allowCustom) {
    throw new Error("custom TABLECHECK_BASE requires TABLECHECK_ALLOW_CUSTOM_BASE=1");
  }
}

module.exports = {
  createConfig: createConfig,
  detectLanIp: detectLanIp,
};
