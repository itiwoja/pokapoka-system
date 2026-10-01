/**
 * http-util.js — HTTP応答・リクエスト読取の小道具 (依存ゼロ)
 *
 * server.js と routes/ の各ハンドラが共有する。業務ロジックは持たない。
 */
"use strict";

var fs = require("fs");
var path = require("path");

var MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css",
  ".json": "application/json",
  ".md": "text/markdown; charset=utf-8",
  ".ogg": "audio/ogg",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

var MAX_JSON_BODY_BYTES = 1e6;

function contentType(file) {
  return MIME[path.extname(file)] || "application/octet-stream";
}

function json(res, obj, code) {
  res.writeHead(code || 200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(obj));
}

/** ヘッダーを付けない素の応答。本文は人が読む短い英文だけに使う */
function text(res, code, message) {
  res.writeHead(code);
  res.end(message);
}

/** 本文なしの 204。削除の成功応答に使う */
function noContent(res) {
  res.writeHead(204, { "Cache-Control": "no-store" });
  res.end();
}

function serveFile(res, file) {
  fs.readFile(file, function (err, data) {
    if (err) return text(res, 404, "not found");
    res.writeHead(200, { "Content-Type": contentType(file) });
    res.end(data);
  });
}

function readJson(req, res, cb) {
  var chunks = [], size = 0, ended = false;
  req.on("data", function (chunk) {
    if (ended) return;
    size += chunk.length;
    if (size > MAX_JSON_BODY_BYTES) {
      ended = true;
      json(res, { ok: false, error: "payload too large" }, 413);
      return req.destroy();
    }
    chunks.push(chunk);
  });
  req.on("end", function () {
    if (ended) return;
    ended = true;
    var raw = Buffer.concat(chunks).toString("utf8").trim();
    if (!raw) return cb({});
    try { cb(JSON.parse(raw)); }
    catch (err) { json(res, { ok: false, error: "invalid JSON" }, 400); }
  });
  req.on("error", function () {
    if (!ended) { ended = true; json(res, { ok: false, error: "read error" }, 400); }
  });
}

/** prefix に続くパス要素をデコードして返す。不正なパーセントエンコードは null */
function pathParam(pathname, prefix) {
  try { return decodeURIComponent(pathname.slice(prefix.length)); }
  catch (err) { return null; }
}

module.exports = {
  contentType: contentType,
  json: json,
  text: text,
  noContent: noContent,
  serveFile: serveFile,
  readJson: readJson,
  pathParam: pathParam,
};
