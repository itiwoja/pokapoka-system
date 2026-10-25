/** RFC 822 / MIME の本文抽出と件名による取消判定。予約項目の解釈は text.js へ委ねる。 */
"use strict";

var { decodeBytes, statusFrom } = require("./common");
var { parseText } = require("./text");

var MAX_MIME_DEPTH = 5;

/**
 * メール1通 (RFC 822 の生データ、または本文だけのテキスト) → 予約の下書き。
 * 件名に「キャンセル」とあれば取消として扱う。
 * @param {Buffer|string} input - .eml のバイト列。文字列で渡した場合は UTF-8 のテキストとして扱う
 * @returns {{draft: Object, warnings: string[], subject: (string|null), from: (string|null), body: string}}
 */
function parseMail(input, options) {
  var isText = typeof input === "string";
  var raw = (isText ? Buffer.from(input, "utf8") : input).toString("latin1");
  var message = splitMessage(raw);
  var subject = null, from = null, body;

  if (message) {
    subject = decodeHeader(message.headers.subject, isText);
    from = decodeHeader(message.headers.from, isText);
    body = extractText(message, isText, 0);
  } else {
    // ヘッダーの無い入力は、メール本文をそのまま貼り付けたものとして読む
    body = isText ? input : decodeBytes(input);
  }

  var parsed = parseText(body || "", { now: options && options.now, ridPrefix: "mail" });
  if (subject && statusFrom(subject) === "canceled" && !/キャンセル待ち/.test(subject)) parsed.draft.status = "canceled";
  return { draft: parsed.draft, warnings: parsed.warnings, subject: subject, from: from, body: body || "" };
}

/** latin1 で読んだメッセージをヘッダーと本文に分ける。先頭がヘッダーの形でなければ null */
function splitMessage(raw) {
  if (!/^[A-Za-z][A-Za-z0-9-]*:/.test(raw)) return null;
  var m = /\r?\n\r?\n/.exec(raw);
  var head = m ? raw.slice(0, m.index) : raw;
  var body = m ? raw.slice(m.index + m[0].length) : "";
  var headers = {};
  head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/).forEach(function (line) {
    var colon = line.indexOf(":");
    if (colon <= 0) return;
    var name = line.slice(0, colon).trim().toLowerCase();
    if (headers[name] === undefined) headers[name] = line.slice(colon + 1).trim();
  });
  return { headers: headers, body: body };
}

/** RFC 2047 の encoded-word (=?charset?B?...?= / =?charset?Q?...?=) を戻す */
function decodeHeader(value, isText) {
  if (value == null) return null;
  var decoded = String(value).replace(/(\?=)\s+(=\?)/g, "$1$2")
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, function (all, charset, encoding, data) {
      var bytes = encoding.toLowerCase() === "b" ? Buffer.from(data, "base64")
        : decodeQuotedPrintable(data.replace(/_/g, " "));
      return decodeBytes(bytes, charset);
    });
  // encoded-word でない8bitのヘッダーは、貼り付けテキストなら UTF-8 として戻す
  if (decoded === value && /[\x80-\xff]/.test(decoded)) decoded = decodeBytes(Buffer.from(decoded, "latin1"), isText ? "utf-8" : null);
  return decoded.trim() || null;
}

function decodeQuotedPrintable(value) {
  var s = String(value).replace(/=\r?\n/g, "");
  var bytes = [];
  for (var i = 0; i < s.length; i++) {
    if (s[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(s.substr(i + 1, 2))) { bytes.push(parseInt(s.substr(i + 1, 2), 16)); i += 2; }
    else bytes.push(s.charCodeAt(i) & 0xff);
  }
  return Buffer.from(bytes);
}

function parseContentType(value) {
  var parts = String(value || "text/plain").split(";");
  var params = {};
  parts.slice(1).forEach(function (part) {
    var eq = part.indexOf("=");
    if (eq > 0) params[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim().replace(/^"|"$/g, "");
  });
  return { type: parts[0].trim().toLowerCase() || "text/plain", params: params };
}

/** メッセージ (またはその一部) から読める本文を取り出す。text/plain を優先し、無ければ text/html のタグを外す */
function extractText(part, isText, depth) {
  var contentType = parseContentType(part.headers["content-type"]);
  if (contentType.type.indexOf("multipart/") === 0) {
    var boundary = contentType.params.boundary;
    if (!boundary || depth >= MAX_MIME_DEPTH) return "";
    var plain = null, html = null;
    part.body.split("--" + boundary).slice(1).forEach(function (chunk) {
      if (chunk.indexOf("--") === 0) return;   // 終端の "--boundary--"
      var child = splitMessage(chunk.replace(/^\r?\n/, ""));
      if (!child) return;
      var childType = parseContentType(child.headers["content-type"]).type;
      var childText = extractText(child, isText, depth + 1);
      if (!childText) return;
      if (childType === "text/html") { if (html === null) html = childText; }
      else if (plain === null) plain = childText;
    });
    return plain !== null ? plain : (html || "");
  }
  if (contentType.type !== "text/plain" && contentType.type !== "text/html") return "";

  var encoding = String(part.headers["content-transfer-encoding"] || "").trim().toLowerCase();
  var bytes, charset = contentType.params.charset;
  if (encoding === "base64") bytes = Buffer.from(part.body.replace(/\s+/g, ""), "base64");
  else if (encoding === "quoted-printable") bytes = decodeQuotedPrintable(part.body);
  else {
    bytes = Buffer.from(part.body, "latin1");
    // 貼り付けたテキストは既に UTF-8 へ変換済みなので、ヘッダーの charset 宣言を信用しない
    if (isText) charset = "utf-8";
  }
  var text = decodeBytes(bytes, charset);
  return contentType.type === "text/html" ? htmlToText(text) : text;
}

function htmlToText(html) {
  return String(html)
    .replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(?:p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

module.exports = { parseMail: parseMail };
