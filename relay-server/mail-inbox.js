/**
 * mail-inbox.js — 予約メールの取込フォルダ
 *
 * 予約の通知メールを保存した .eml / .txt ファイルを1つのフォルダ (既定 data/mail-inbox) に置くと、
 * 予約入力画面に「取込候補」として並ぶ。中継サーバーはメールサーバーへ接続しない。
 * メールの認証情報をミニPCに持たせないためで、フォルダへ置くまで (メールソフトの自動保存・手作業の保存) は
 * この外側の運用に任せる。
 *
 * 候補は自動では保存しない。店員が画面で内容を確かめて登録するか、破棄する。
 * どちらの場合もファイルを processed/ へ移す (削除はしない)。状態はフォルダの中身だけで決まる。
 */
"use strict";

var fs = require("node:fs");
var path = require("node:path");
var parseMail = require("./reservation-import").parseMail;

var MAX_FILES = 100;
var MAX_FILE_BYTES = 1e6;
var PROCESSED_DIR = "processed";

/**
 * @param {string|null} dir - 取込フォルダ。null なら無効 (常に空)
 * @param {{now?: function(): Date}} [options]
 */
function createMailInbox(dir, options) {
  var now = options && typeof options.now === "function" ? options.now : function () { return new Date(); };
  var root = dir ? path.resolve(dir) : null;

  function isMailFile(name) {
    return /\.(?:eml|txt)$/i.test(name) && path.basename(name) === name && name.charAt(0) !== ".";
  }

  /** フォルダ内のメールを古い順に解析して返す。フォルダが無ければ空 */
  function list() {
    if (!root) return [];
    var names;
    try { names = fs.readdirSync(root); }
    catch (err) {
      if (err.code === "ENOENT") return [];
      throw err;
    }
    var items = [];
    names.filter(isMailFile).forEach(function (name) {
      var file = path.join(root, name);
      var stat;
      try { stat = fs.statSync(file); } catch (err) { return; }
      if (!stat.isFile()) return;
      items.push({ id: name, receivedAt: stat.mtime.toISOString(), mtimeMs: stat.mtimeMs, size: stat.size });
    });
    items.sort(function (a, b) { return a.mtimeMs - b.mtimeMs || (a.id < b.id ? -1 : 1); });

    return items.slice(0, MAX_FILES).map(function (item) {
      var out = { id: item.id, receivedAt: item.receivedAt };
      if (item.size > MAX_FILE_BYTES) {
        out.error = "ファイルが大きすぎます";
        return out;
      }
      try {
        var parsed = parseMail(fs.readFileSync(path.join(root, item.id)), { now: new Date(now()) });
        out.subject = parsed.subject;
        out.from = parsed.from;
        out.draft = parsed.draft;
        // 本文そのものは返さない。電話番号など、取り込まないと決めた連絡先を画面へ流さないため
        out.warnings = parsed.warnings;
      } catch (err) {
        out.error = "メールを読めません";
      }
      return out;
    });
  }

  /** 候補のファイルを processed/ へ移す。該当するファイルが無ければ false */
  function archive(id) {
    if (!root || typeof id !== "string" || !isMailFile(id)) return false;
    var from = path.join(root, id);
    if (!fs.existsSync(from)) return false;
    var processed = path.join(root, PROCESSED_DIR);
    fs.mkdirSync(processed, { recursive: true });
    // 同じファイル名を2回処理しても、先に移した方を上書きしない
    var target = path.join(processed, id);
    if (fs.existsSync(target)) target = path.join(processed, Date.now() + "-" + id);
    fs.renameSync(from, target);
    return true;
  }

  return { enabled: !!root, dir: root, list: list, archive: archive };
}

module.exports = { createMailInbox: createMailInbox };
