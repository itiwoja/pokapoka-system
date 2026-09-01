/**
 * auth.js — 店内LAN向けの共有トークン認証 (依存ゼロ)
 *
 * 中継サーバーには認証が無く、到達できる端末なら誰でも書き込み操作ができる (#174)。
 * 飲食店ではゲスト Wi-Fi を客と共用している構成が珍しくないため、その場合は
 * 客のスマホから座席占有の解除やプリンター設定の書き換えができてしまう。
 *
 * ここが狙うのは「店内LANという閉じた場所での、意図しない・いたずら目的の操作を止める」ことだけ。
 * インターネットに晒す前提の認証ではない (そもそも外部公開しない方針)。
 *
 * 判定の順序:
 *   1. トークン未設定 → 全て許可 (従来どおり。開発・検証は無設定のまま何も変わらない)
 *   2. ?token= がある場合は、その値だけを検証 (不正値を他の認証方法で迂回させない)
 *   3. ループバック(ミニPC自身) → 許可。QRページを開いてトークンを配る導線を塞がないため。
 *      ミニPCを他人が触る運用なら auth.trustLoopback:false で無効にできる
 *   4. 除外パス(/api/health) → 許可。疎通診断を認証で詰まらせないため (読み取り専用)
 *   5. Authorization: Bearer / Cookie のいずれかが一致 → 許可
 *
 * `?token=` で来た場合は Cookie を発行する。iPad は QR を1回読めば、以後はURLに
 * トークンを付けなくても操作できる。
 */
"use strict";

var crypto = require("crypto");

var COOKIE_NAME = "relay_token";
var COOKIE_MAX_AGE = 60 * 60 * 24 * 30;   // 30日。営業のたびに読み直させない
var OPEN_PATHS = { "/api/health": 1 };

/* 長さの違いで早期に false を返さないよう、固定長のハッシュで比較する */
function sameToken(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  var ha = crypto.createHash("sha256").update(a).digest();
  var hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function isLoopback(address) {
  if (typeof address !== "string") return false;
  var addr = address.replace(/^::ffff:/, "");
  return addr === "127.0.0.1" || addr === "::1";
}

function readCookie(header, name) {
  if (typeof header !== "string") return "";
  var parts = header.split(";");
  for (var i = 0; i < parts.length; i++) {
    var pair = parts[i].trim();
    var eq = pair.indexOf("=");
    if (eq < 0) continue;
    if (pair.slice(0, eq).trim() !== name) continue;
    var raw = pair.slice(eq + 1).trim();
    try { return decodeURIComponent(raw); }
    catch (e) { return raw; }
  }
  return "";
}

function bearer(header) {
  if (typeof header !== "string") return "";
  var m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : "";
}

/**
 * リクエストを通してよいか判定する。
 * 戻り値 { ok, reason, setCookie? }。setCookie は ?token= で来たときだけ真。
 */
function check(req, url, token, remoteAddress, trustLoopback) {
  if (!token) return { ok: true, reason: "disabled" };

  // クエリに token が明示された場合は先に検証する。無効な query token を
  // 有効な Cookie・Bearer・ループバック免除で迂回するとURLに残留するため許可しない。
  if (url.searchParams.has("token")) {
    var queryTokens = url.searchParams.getAll("token");
    var method = String(req.method || "GET").toUpperCase();
    if ((method === "GET" || method === "HEAD") &&
        queryTokens.length === 1 && sameToken(queryTokens[0], token)) {
      return { ok: true, reason: "query", setCookie: true };
    }
    return { ok: false, reason: "missing or invalid token" };
  }

  if (trustLoopback !== false && isLoopback(remoteAddress)) return { ok: true, reason: "loopback" };
  if (OPEN_PATHS[url.pathname]) return { ok: true, reason: "open" };

  var headers = req.headers || {};
  if (sameToken(bearer(headers.authorization), token)) return { ok: true, reason: "header" };

  if (sameToken(readCookie(headers.cookie, COOKIE_NAME), token)) return { ok: true, reason: "cookie" };

  return { ok: false, reason: "missing or invalid token" };
}

function cookieHeader(token, secure) {
  var header = COOKIE_NAME + "=" + encodeURIComponent(token) +
    "; HttpOnly; Path=/; Max-Age=" + COOKIE_MAX_AGE + "; SameSite=Lax";
  return secure ? header + "; Secure" : header;
}

/* config.json / 環境変数から受け取ったトークンを正規化する。
   短すぎるトークンは総当たりで破られるため、設定ミスとして起動時に止める */
function normalizeToken(value) {
  if (value === undefined || value === null) return "";
  var token = String(value).trim();
  if (!token) return "";
  if (token.length < 8) throw new Error("auth.token は8文字以上にする (環境変数 RELAY_TOKEN も同様)");
  return token;
}

module.exports = {
  COOKIE_NAME: COOKIE_NAME,
  check: check,
  cookieHeader: cookieHeader,
  normalizeToken: normalizeToken,
  isLoopback: isLoopback,
  readCookie: readCookie,
};
