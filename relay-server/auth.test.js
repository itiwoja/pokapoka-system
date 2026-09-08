"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var auth = require("./auth");

var TOKEN = "pokapoka-kitchen-2026";
var LAN = "192.168.1.77";

function req(headers) {
  return { method: "GET", headers: headers || {} };
}
function at(pathname, query) {
  return new URL("http://localhost" + pathname + (query ? "?" + query : ""));
}

test("トークン未設定なら全て素通し (開発・検証は従来どおり)", function () {
  var result = auth.check(req(), at("/api/seats"), "", LAN);
  assert.equal(result.ok, true);
  assert.equal(result.reason, "disabled");
});

test("ループバック(ミニPC自身)は認証なしで通る", function () {
  assert.equal(auth.check(req(), at("/"), TOKEN, "127.0.0.1").ok, true);
  assert.equal(auth.check(req(), at("/"), TOKEN, "::1").ok, true);
  assert.equal(auth.check(req(), at("/"), TOKEN, "::ffff:127.0.0.1").ok, true);
  // QRページを開いてトークンを配る導線を塞がないため
  assert.equal(auth.check(req(), at("/qr"), TOKEN, "127.0.0.1").reason, "loopback");
});

test("トークンが無い他端末は弾く (ページもAPIも)", function () {
  assert.equal(auth.check(req(), at("/"), TOKEN, LAN).ok, false);
  assert.equal(auth.check(req(), at("/api/seats"), TOKEN, LAN).ok, false);
  assert.equal(auth.check(req(), at("/api/stock"), TOKEN, LAN).ok, false);
  assert.equal(auth.check(req(), at("/relay-server/kds-bridge.js"), TOKEN, LAN).ok, false);
});

test("/api/health だけは認証なしで読める (疎通診断を詰まらせない)", function () {
  assert.equal(auth.check(req(), at("/api/health"), TOKEN, LAN).ok, true);
});

test("Authorization ヘッダ / ?token= / Cookie のいずれでも通る", function () {
  assert.equal(auth.check(req({ authorization: "Bearer " + TOKEN }), at("/api/seats"), TOKEN, LAN).reason, "header");
  assert.equal(auth.check(req({ authorization: "bearer " + TOKEN }), at("/api/seats"), TOKEN, LAN).ok, true);

  var byQuery = auth.check(req(), at("/", "token=" + encodeURIComponent(TOKEN)), TOKEN, LAN);
  assert.equal(byQuery.ok, true);
  assert.equal(byQuery.setCookie, true, "QR経由の端末には Cookie を渡す");

  var byCookie = auth.check(req({ cookie: "foo=1; relay_token=" + encodeURIComponent(TOKEN) }), at("/"), TOKEN, LAN);
  assert.equal(byCookie.reason, "cookie");
  assert.ok(!byCookie.setCookie);
});

test("違うトークンは通さない", function () {
  assert.equal(auth.check(req({ authorization: "Bearer wrong-token" }), at("/api/seats"), TOKEN, LAN).ok, false);
  assert.equal(auth.check(req({ cookie: "relay_token=wrong-token" }), at("/"), TOKEN, LAN).ok, false);
  assert.equal(auth.check(req(), at("/", "token=wrong"), TOKEN, LAN).ok, false);
  // 前方一致で通ってしまわないこと
  assert.equal(auth.check(req(), at("/", "token=" + TOKEN.slice(0, 10)), TOKEN, LAN).ok, false);
  assert.equal(auth.check(req({ cookie: "relay_token=" + TOKEN }), at("/", "token=wrong"), TOKEN, LAN).ok, false,
    "無効なquery tokenを有効なCookieで迂回させない");
  assert.equal(auth.check(req(), at("/", "token=" + TOKEN + "&token=wrong"), TOKEN, "127.0.0.1").ok, false,
    "重複tokenやループバック免除で曖昧なquery tokenを許可しない");
  var post = req();
  post.method = "POST";
  assert.equal(auth.check(post, at("/api/orders", "token=" + TOKEN), TOKEN, LAN).ok, false,
    "本文を持つAPIでtoken付きURLを使わせない");
});

test("Cookie の切り出しは他のキーに引きずられない", function () {
  assert.equal(auth.readCookie("a=1; relay_token=x; b=2", "relay_token"), "x");
  assert.equal(auth.readCookie("my_relay_token=x", "relay_token"), "");
  assert.equal(auth.readCookie("", "relay_token"), "");
  assert.equal(auth.readCookie(undefined, "relay_token"), "");
});

test("短すぎるトークンは設定ミスとして起動時に止める", function () {
  assert.equal(auth.normalizeToken(""), "");
  assert.equal(auth.normalizeToken(undefined), "");
  assert.equal(auth.normalizeToken("  " + TOKEN + "  "), TOKEN);
  assert.throws(function () { auth.normalizeToken("short"); }, /8文字以上/);
});

test("ループバックの信頼は明示的に切れる (ミニPCを他人が触る運用向け)", function () {
  assert.equal(auth.check(req(), at("/"), TOKEN, "127.0.0.1", false).ok, false);
  assert.equal(auth.check(req(), at("/", "token=" + TOKEN), TOKEN, "127.0.0.1", false).ok, true);
});

test("Cookie ヘッダはHttpOnly・Path・ライフタイム・SameSiteを持つ", function () {
  var header = auth.cookieHeader(TOKEN);
  assert.match(header, /^relay_token=/);
  assert.match(header, /Path=\//);
  assert.match(header, /Max-Age=\d+/);
  assert.match(header, /SameSite=Lax/);
  assert.match(header, /HttpOnly/);
  assert.doesNotMatch(header, /; Secure/);
  assert.match(auth.cookieHeader(TOKEN, true), /; Secure$/);
});
