/**
 * load-config.js — config/config.json を読み、環境変数と同じ形に変換する (依存ゼロ)
 *
 * 設定の優先順位は「既定値 < config/config.json < 環境変数」。
 * ファイルの値を env 形のオーバーレイに直してから server.js の createConfig() へ渡すので、
 * 下限クランプ・HTTPS検証といった既存の検証ロジックはファイル経由の値にもそのまま効く。
 *
 * APIキーはこのファイルでは扱わない (環境変数のみ)。理由は KEY_TO_ENV の直下を参照。
 */
"use strict";

var fs = require("fs");
var path = require("path");

var DEFAULT_PATH = path.resolve(__dirname, "..", "config", "config.json");

// config.json の "section.key" -> 対応する環境変数名。
// 許可キーの一覧・型変換・オーバーレイ生成を全てこの1枚から導出する。
var KEY_TO_ENV = {
  "server.host": "HOST",
  "server.port": "PORT",
  "tablecheck.base": "TABLECHECK_BASE",
  "tablecheck.shopId": "SHOP_ID",
  "tablecheck.pollMs": "POLL_MS",
  "tablecheck.resyncMs": "RESYNC_MS",
  "tablecheck.timeoutMs": "TABLECHECK_TIMEOUT_MS",
  "tablecheck.allowCustomBase": "TABLECHECK_ALLOW_CUSTOM_BASE",
  "seat.beforeMin": "SEAT_BEFORE_MIN",
  "seat.afterMin": "SEAT_AFTER_MIN",
};

// 秘密情報は config.json に置かせない。黙って無視すると「キーを書いたのに MOCK のまま」という
// 分かりにくい失敗になるため、見つけたら起動を止めて環境変数へ誘導する。
var SECRET_KEYS = {
  "tablecheck.apiKey": "TABLECHECK_API_KEY",
};

/**
 * 設定ファイルを env 形のオーバーレイへ変換して返す。
 * ファイルが無ければ {} (＝環境変数と既定値だけで動く従来どおりの挙動)。
 */
function load(filePath) {
  var file = filePath === undefined ? DEFAULT_PATH : filePath;
  if (file === null) return {};

  var raw;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch (err) {
    if (err.code === "ENOENT") return {};
    throw new Error("設定ファイルを読めない: " + file + " (" + err.message + ")");
  }

  var json;
  try { json = JSON.parse(raw); }
  catch (err) { throw new Error("設定ファイルが不正なJSON: " + file + " (" + err.message + ")"); }
  if (!isPlainObject(json)) throw new Error("設定ファイルはオブジェクトである必要がある: " + file);

  return toOverlay(json, file);
}

function toOverlay(json, file) {
  var overlay = {};
  Object.keys(json).forEach(function (section) {
    if (isComment(section)) return;
    var body = json[section];
    if (!isPlainObject(body)) throw new Error(reject(file, section, "セクションはオブジェクトである必要がある"));

    Object.keys(body).forEach(function (key) {
      if (isComment(key)) return;
      var dotted = section + "." + key;

      if (SECRET_KEYS[dotted]) {
        throw new Error(reject(file, dotted,
          "秘密情報は設定ファイルに置かない。環境変数 " + SECRET_KEYS[dotted] + " で渡すこと"));
      }
      var envKey = KEY_TO_ENV[dotted];
      if (!envKey) throw new Error(reject(file, dotted, "未知のキー。指定できるのは " + Object.keys(KEY_TO_ENV).join(", ")));

      var value = body[key];
      if (value === null || value === undefined) return;   // 未設定扱い。既定値へ委ねる
      if (typeof value === "boolean") value = value ? "1" : "0";
      if (typeof value === "object") throw new Error(reject(file, dotted, "値は文字列・数値・真偽値のいずれか"));
      overlay[envKey] = String(value);
    });
  });
  return overlay;
}

/**
 * ファイル由来のオーバーレイに環境変数を重ねる (環境変数が勝つ)。
 * 空文字は「未設定」として扱い、ファイル側の値を消さない。
 */
function mergeEnv(overlay, env) {
  var merged = Object.assign({}, overlay);
  Object.keys(env || {}).forEach(function (key) {
    if (env[key] !== undefined && env[key] !== "") merged[key] = env[key];
  });
  return merged;
}

// JSON にコメント構文が無いため、"_" 始まりのキーを注記用に許可する
function isComment(key) { return key.charAt(0) === "_"; }

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function reject(file, at, reason) {
  return "設定ファイルの " + at + " が不正: " + reason + " (" + file + ")";
}

module.exports = {
  load: load,
  mergeEnv: mergeEnv,
  DEFAULT_PATH: DEFAULT_PATH,
};
