/**
 * reservation-store.js — 予約の正本を中継サーバーの SQLite に持つ
 *
 * TableCheck API 連携は 2026-10-11 に中止し、予約は店員の手入力で扱う方針になった。
 * 予約を持っているのはこのシステムだけになるため、再起動で消えるメモリではなく
 * SQLite のファイル (既定 data/reservations.sqlite) に保存する。
 *
 * 手入力の入口 (画面・API) は未設計。ここは保存・取消・当日分の読み出しだけを持ち、
 * KDS へは従来の予約ストック形式 (GET /api/stock) で渡す。
 * 過ぎた日の予約は読み出しのたびに削除する (履歴は持たない)。
 */
"use strict";

var fs = require("node:fs");
var path = require("node:path");
var crypto = require("node:crypto");

/** 内部 status。KDS の予約ストックと座席占有に載るのは booked だけ */
var STATUSES = ["booked", "canceled", "no_show", "done"];
var MAX_TEXT_LENGTH = 500;
var MAX_RID_LENGTH = 64;
var MAX_MENU_ITEMS = 50;

var SCHEMA = [
  "CREATE TABLE IF NOT EXISTS reservations (",
  "  rid TEXT PRIMARY KEY CHECK(length(rid) BETWEEN 1 AND " + MAX_RID_LENGTH + "),",
  "  start_at TEXT NOT NULL,",
  "  start_ms INTEGER NOT NULL,",
  "  adults INTEGER NOT NULL CHECK(adults >= 0),",
  "  kids INTEGER NOT NULL CHECK(kids >= 0),",
  "  seniors INTEGER NOT NULL DEFAULT 0 CHECK(seniors >= 0),",
  "  children INTEGER NOT NULL DEFAULT 0 CHECK(children >= 0),",
  "  name TEXT NOT NULL,",
  "  status TEXT NOT NULL CHECK(status IN ('" + STATUSES.join("','") + "')),",
  "  table_no TEXT,",
  "  menu TEXT NOT NULL,",
  "  allergies TEXT,",
  "  request TEXT,",
  "  memo TEXT,",
  "  updated_at TEXT NOT NULL",
  ") STRICT;",
  "CREATE INDEX IF NOT EXISTS reservations_start_ms ON reservations(start_ms);",
].join("\n");

// 人数の内訳を足す前 (2026-10-22 より前) に作ったファイルへ後から足す列。
// kids は従来どおり幼児 (0〜2歳)。TableCheck の予約一覧に合わせ、シニアと子供 (幼児より上) を別に持つ
var ADDED_COLUMNS = [
  ["seniors", "seniors INTEGER NOT NULL DEFAULT 0 CHECK(seniors >= 0)"],
  ["children", "children INTEGER NOT NULL DEFAULT 0 CHECK(children >= 0)"],
];

/**
 * @param {string} filename - SQLite ファイルのパス。":memory:" ならメモリ上 (テスト用)
 * @param {{now?: function(): Date}} [options]
 */
function openReservationStore(filename, options) {
  options = options || {};
  var now = typeof options.now === "function" ? options.now : function () { return new Date(); };
  var DatabaseSync = require("node:sqlite").DatabaseSync;
  if (filename !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
  var db = new DatabaseSync(filename);
  try {
    // 書き込み中の電源断でファイルを壊さないため WAL にする (ミニPCの電源断を想定)
    if (filename !== ":memory:") db.exec("PRAGMA journal_mode=WAL");
    db.exec(SCHEMA);
    var existing = db.prepare("PRAGMA table_info(reservations)").all().map(function (c) { return c.name; });
    ADDED_COLUMNS.forEach(function (column) {
      if (existing.indexOf(column[0]) < 0) db.exec("ALTER TABLE reservations ADD COLUMN " + column[1]);
    });
  } catch (err) { db.close(); throw err; }

  var upsert = db.prepare(
    "INSERT INTO reservations(rid,start_at,start_ms,adults,kids,seniors,children,name,status,table_no,menu,allergies,request,memo,updated_at)" +
    " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)" +
    " ON CONFLICT(rid) DO UPDATE SET start_at=excluded.start_at, start_ms=excluded.start_ms," +
    " adults=excluded.adults, kids=excluded.kids, seniors=excluded.seniors, children=excluded.children," +
    " name=excluded.name, status=excluded.status," +
    " table_no=excluded.table_no, menu=excluded.menu, allergies=excluded.allergies," +
    " request=excluded.request, memo=excluded.memo, updated_at=excluded.updated_at");
  var selectOne = db.prepare("SELECT * FROM reservations WHERE rid=?");
  var selectRange = db.prepare("SELECT * FROM reservations WHERE start_ms >= ? AND start_ms < ? ORDER BY start_ms, rid");
  var setStatus = db.prepare("UPDATE reservations SET status=?, updated_at=? WHERE rid=?");
  var deleteBefore = db.prepare("DELETE FROM reservations WHERE start_ms < ?");
  var countAll = db.prepare("SELECT count(*) AS n FROM reservations");

  /** 予約を作成・更新する。rid が無ければ採番する。入力が不正なら Error を投げる */
  function save(input) {
    var record = validate(input);
    upsert.run(record.rid, record.startAt, Date.parse(record.startAt), record.adults, record.kids,
      record.seniors, record.children, record.name, record.status, record.table, JSON.stringify(record.menu),
      record.allergies, record.request, record.memo, new Date(now()).toISOString());
    return get(record.rid);
  }

  /** 予約を取り消す (行は残し status を canceled にする)。無ければ null */
  function cancel(rid) {
    var result = setStatus.run("canceled", new Date(now()).toISOString(), String(rid));
    return result.changes ? get(rid) : null;
  }

  function get(rid) {
    var row = selectOne.get(String(rid));
    return row ? fromRow(row) : null;
  }

  /** 過ぎた日の予約を消してから、当日分の予約を rid → レコードの Map で返す */
  function todaySnapshot() {
    var range = dayRange(new Date(now()));
    deleteBefore.run(range.start);
    var snapshot = new Map();
    selectRange.all(range.start, range.end).forEach(function (row) {
      var rec = fromRow(row);
      snapshot.set(rec.rid, rec);
    });
    return snapshot;
  }

  /**
   * 指定日 (サーバーのローカル時刻の "YYYY-MM-DD"。省略時は当日) の予約を、取消済みも含めて時刻順に返す。
   * 予約入力画面の一覧用。読み出すだけで、過ぎた日の削除はしない
   */
  function list(dateStr) {
    var day = dateStr == null || dateStr === "" ? new Date(now()) : parseLocalDate(dateStr);
    if (!day) throw new Error("date は YYYY-MM-DD");
    var range = dayRange(day);
    return selectRange.all(range.start, range.end).map(fromRow);
  }

  /** GET /api/stock の本体。当日の booked かつメニューありの予約を KDS 予約ストック形式で返す */
  function stock(seenAt) {
    return toKdsStock(todaySnapshot(), seenAt == null ? Date.now() : seenAt);
  }

  // /api/health は認証なしで開いているため、ファイルの場所は返さず起動ログにだけ出す
  function health() {
    return { store: "sqlite", reservations: countAll.get().n };
  }

  return {
    save: save,
    cancel: cancel,
    get: get,
    todaySnapshot: todaySnapshot,
    list: list,
    stock: stock,
    health: health,
    file: filename === ":memory:" ? ":memory:" : path.resolve(filename),
    close: function () { if (db.isOpen) db.close(); },
  };
}

/** 入力を内部レコードへ検証・正規化する */
function validate(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("予約はオブジェクトで渡す");
  var rid = input.rid == null || input.rid === "" ? crypto.randomUUID() : String(input.rid).trim();
  if (!rid || rid.length > MAX_RID_LENGTH) throw new Error("rid は1〜" + MAX_RID_LENGTH + "文字");
  if (typeof input.startAt !== "string" || isNaN(Date.parse(input.startAt))) {
    throw new Error("startAt は日時文字列 (例: 2026-10-11T18:30:00+09:00)");
  }
  var adults = count(input.adults, "adults");
  var seniors = count(input.seniors, "seniors");
  var children = count(input.children, "children");
  var kids = count(input.kids, "kids");
  var status = input.status == null ? "booked" : String(input.status);
  if (STATUSES.indexOf(status) < 0) throw new Error("status は " + STATUSES.join(" / ") + " のいずれか");
  var menu = input.menu == null ? [] : input.menu;
  if (!Array.isArray(menu) || menu.length > MAX_MENU_ITEMS) throw new Error("menu は" + MAX_MENU_ITEMS + "件以下の配列");
  return {
    rid: rid,
    startAt: input.startAt,
    adults: adults,
    seniors: seniors,
    children: children,
    kids: kids,
    name: text(input.name, "name") || "(名前なし)",
    status: status,
    table: text(input.table, "table"),
    menu: menu.map(function (m, i) {
      if (!m || typeof m !== "object") throw new Error("menu[" + i + "] はオブジェクト");
      var name = text(m.name, "menu[" + i + "].name");
      if (!name) throw new Error("menu[" + i + "].name は必須");
      var qty = m.qty == null ? 1 : m.qty;
      if (!Number.isInteger(qty) || qty < 1) throw new Error("menu[" + i + "].qty は1以上の整数");
      return {
        name: name,
        qty: qty,
        options: text(m.options, "menu[" + i + "].options"),
        allergies: text(m.allergies, "menu[" + i + "].allergies"),
      };
    }),
    allergies: text(input.allergies, "allergies"),
    request: text(input.request, "request"),
    memo: text(input.memo, "memo"),
  };
}

function count(value, field) {
  if (value == null) return 0;
  if (!Number.isInteger(value) || value < 0) throw new Error(field + " は0以上の整数");
  return value;
}

function text(value, field) {
  if (value == null) return null;
  if (typeof value !== "string") throw new Error(field + " は文字列");
  var trimmed = value.trim();
  if (trimmed.length > MAX_TEXT_LENGTH) throw new Error(field + " は" + MAX_TEXT_LENGTH + "文字以内");
  return trimmed || null;
}

function fromRow(row) {
  var rec = {
    rid: row.rid,
    startAt: row.start_at,
    adults: row.adults,
    seniors: row.seniors,
    children: row.children,
    kids: row.kids,
    name: row.name,
    status: row.status,
    table: row.table_no,
    menu: JSON.parse(row.menu),
    memo: row.memo,
    updatedAt: row.updated_at,
  };
  // 注記が無い予約は従来の内部レコード形を保ち、必要なときだけ拡張フィールドを持たせる
  if (row.allergies) rec.allergies = row.allergies;
  if (row.request) rec.request = row.request;
  return rec;
}

/**
 * 内部レコード → KDS 予約ストック形式 ({rid,time,adults,seniors,children,kids,name,menu,seenAt})。
 * kids は幼児 (0〜2歳)。合計人数は KDS 側で4つを足して出す。
 * booked 以外と、メニューが空の予約 (席だけ予約) は KDS に出さない (db-design §5.1 / deshup-spec 準拠)。
 * @param {Map<string,Object>} store
 * @param {number} seenAt - 取込時刻 (ms)
 */
function toKdsStock(store, seenAt) {
  var out = [];
  store.forEach(function (rec) {
    if (rec.status !== "booked" || !rec.menu || !rec.menu.length) return;
    var d = new Date(rec.startAt);
    var item = {
      rid: rec.rid,
      time: isNaN(d) ? String(rec.startAt) : pad2(d.getHours()) + ":" + pad2(d.getMinutes()),
      adults: rec.adults, seniors: rec.seniors || 0, children: rec.children || 0, kids: rec.kids,
      name: rec.name,
      menu: rec.menu,
      seenAt: seenAt,
    };
    // 既存の予約ストック契約を壊さず、注記がある予約だけ追加フィールドを配信する
    if (rec.allergies) item.allergies = rec.allergies;
    if (rec.request) item.request = rec.request;
    if (rec.memo) item.memo = rec.memo;
    out.push(item);
  });
  out.sort(function (a, b) { return a.time < b.time ? -1 : a.time > b.time ? 1 : 0; });
  return out;
}

/** now を含む日 (サーバーのローカル時刻) の [0時, 翌0時) をミリ秒で返す */
function dayRange(now) {
  var start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  var end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return { start: start.getTime(), end: end.getTime() };
}

/** "YYYY-MM-DD" → その日の0時 (ローカル時刻) の Date。実在しない日付は null */
function parseLocalDate(value) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  if (!m) return null;
  var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) ? d : null;
}

function pad2(n) { return (n < 10 ? "0" : "") + n; }

module.exports = {
  STATUSES: STATUSES,
  openReservationStore: openReservationStore,
  validate: validate,
  toKdsStock: toKdsStock,
};
