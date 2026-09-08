/**
 * tablecheck-sync.js — TableCheck 予約取込の純粋ロジック
 *
 * server.js から使う正規化・upsert・パージ処理を、serve-log.js と同様に
 * 依存ゼロの純粋関数として切り出したもの (node tablecheck-sync.test.js で検証)。
 *
 * ⚠️ スキーマ未確定フィールドについて (Issue #74):
 *   TableCheck の予約オブジェクトの正確なフィールド名 (顧客名・大人/子供内訳・
 *   メニュー・アレルギー) は API コンソールでの確認待ち。normalizeReservation()
 *   は「ありそうな候補キー」を広めに受け、確定後にここだけ直せば済む構造にしてある。
 */
"use strict";

/**
 * TableCheck 確定 status enum (2026-07-16, Issue #74 で確定 / #117 で実装) → 内部 status。
 * KDS 仕込み棚に載るのは内部 status が "booked" のものだけ (ACTIVE_STATUSES)。
 *
 *   accepted / confirmed          -> booked      (確定予約: 載る)
 *   attended                      -> booked      (来店済: 暫定で載る。#74打合せで着席扱いに倒す場合は "seated" へ)
 *   cancelled / rejected          -> canceled    (キャンセル・店側拒否: 外す ★rejected 取りこぼし修正)
 *   noshow                        -> no_show     (ノーショー: 外す)
 *   tentative/pending/request/    -> unconfirmed (確定前: 暫定デフォルトで外す。#74打合せで方針確定)
 *     iou_prepay/iou_auth
 */
var STATUS_MAP = {
  accepted: "booked",
  confirmed: "booked",
  attended: "booked",
  cancelled: "canceled",
  rejected: "canceled",
  noshow: "no_show",
  tentative: "unconfirmed",
  pending: "unconfirmed",
  request: "unconfirmed",
  iou_prepay: "unconfirmed",
  iou_auth: "unconfirmed",
};

/** 予約ステータスのうち、KDS 予約ストックに載せてよい内部 status (normalizeStatus の出力値ベース) */
var ACTIVE_STATUSES = ["booked"];

/**
 * TableCheck の予約オブジェクト → 中継サーバー内部レコードへ正規化。
 * @param {Object} r - TableCheck API の予約オブジェクト (スキーマ一部未確定)
 * @returns {Object|null} 内部レコード。必須項目が無ければ null (取り込まない)
 */
function normalizeReservation(r) {
  if (!r || r.id == null) return null;
  var startAt = r.start_at || r.startAt || null;
  if (!startAt) return null;

  var notes = normalizeReservationNotes(r);

  // 人数: 確定スキーマ(2026-07-16)は pax_adult / pax_child。旧推測キーもフォールバックで残す。
  // 無ければ pax 合計を adults に寄せる。シニア/乳児(pax_senior/pax_baby)は当面 KDS に出さない。
  var adults = firstNum(r.adults, r.pax_adult, r.pax_adults, r.adult_pax);
  var kids = firstNum(r.kids, r.pax_child, r.pax_kids, r.child_pax, r.children);
  var pax = firstNum(r.pax, r.party_size);
  if (adults == null && pax != null) { adults = pax - (kids || 0); }

  // 予約者名: 確定スキーマは first_name / last_name (姓+名)。旧単一フィールドもフォールバック。
  var fullName = [r.last_name, r.first_name]
    .filter(function (s) { return typeof s === "string" && s.trim(); })
    .join(" ").trim();

  var record = {
    rid: String(r.id),
    startAt: startAt,                                   // ISO8601 (TZ付き) のまま保持
    adults: adults != null ? adults : 0,
    kids: kids != null ? kids : 0,
    name: firstStr(r.customer_name, r.guest_name, r.name,
      r.customer && (r.customer.last_name || r.customer.name), fullName) || "(名前なし)",
    status: normalizeStatus(r.status),
    // 確定卓番のフィールド名はAPIコンソール確認待ち。seat_typesは希望席種であり卓番には使わない。
    table: firstStr(r.table_number, r.table_no, r.table_name, r.table && (r.table.number || r.table.name)) || null,
    seatTypes: normalizeSeatTypes(r.seat_types),
    menu: normalizeMenu(r),
    // メニューが memo/自由記述経由の場合に備え保持。確定スキーマの special_request も含める
    memo: firstStr(r.memo, r.notes, r.special_request) || null,
    // TableCheck のアレルギー設問と自由記述を、厨房表示用に予約レベルで分離する。
    // orders[] には専用フィールドがないため、ここを予約由来の注記の正本にする。
    updatedAt: r.updated_at || r.updatedAt || null,
  };
  // 注記が無い予約は従来の内部レコード形を保ち、必要なときだけ拡張フィールドを持たせる。
  if (notes.allergies) record.allergies = notes.allergies;
  if (notes.request) record.request = notes.request;
  if (notes.questions.length) record.questions = notes.questions;
  return record;
}

/**
 * TableCheck 側 status → 内部 status。
 * 確定enum (STATUS_MAP) は完全一致で最優先。未知値 (旧データ・表記ゆれ) は
 * 従来の正規表現フォールバックで拾い、既定は booked。
 */
function normalizeStatus(s) {
  s = String(s || "").toLowerCase().trim();
  if (Object.prototype.hasOwnProperty.call(STATUS_MAP, s)) return STATUS_MAP[s];
  if (/cancel|reject/.test(s)) return "canceled";
  if (/no[_ -]?show/.test(s)) return "no_show";
  if (/done|complete|finish/.test(s)) return "done";
  return "booked";
}

/**
 * メニュー明細の正規化。
 * 確定スキーマ(2026-07-16)では事前メニューは `orders[]` (ReservationOrder) で返り、
 * 品名は多言語オブジェクト `menu_item_name_translations`({ja,en})、数量は `qty`。
 * 旧推測フィールド(courses / menu_items 等)もフォールバックで受ける。
 * どちらも無ければ memo の自由テキストから「品名 x数量」形式を試験的にパースする。
 * ※ orders[] にはオプション/アレルギー専用フィールドが無い(special_request/questions 経由)ため
 *   options/allergies は構造化フィールドがある旧形のときだけ拾う。
 */
function normalizeSeatTypes(value) {
  if (Array.isArray(value)) return value.filter(function (v) { return typeof v === "string" && v.trim(); }).map(function (v) { return v.trim(); });
  if (typeof value === "string") return value.split(",").map(function (v) { return v.trim(); }).filter(Boolean);
  return [];
}

function normalizeMenu(r) {
  var src = r.orders || r.courses || r.menu_items || r.dining_experiences || r.items || null;
  if (Array.isArray(src) && src.length) {
    return src.map(function (m) {
      return {
        name: firstStr(m.name, m.title, m.item_name, transName(m.menu_item_name_translations)) || "(不明)",
        qty: firstNum(m.qty, m.quantity, m.count) || 1,
        options: firstStr(m.options, m.options_text, m.option) || null,
        allergies: firstStr(m.allergies, m.allergy, m.allergyInfo, m.allergies_text) || null,
      };
    });
  }
  return parseMenuFromMemo(firstStr(r.memo, r.notes) || "");
}

/**
 * questions[] / special_request を厨房表示用の注記へ正規化する。
 * アレルギーは安全情報なので要望と別欄にし、設問の質問文は一般要望側へ残す。
 * 実際の店舗設定が確定するまでは日本語・英語の表記ゆれを広く受ける。
 */
function normalizeReservationNotes(r) {
  var allergies = [];
  var requests = [];
  var questions = normalizeQuestions(r && r.questions);

  questions.forEach(function (q) {
    if (!q.answer) return;
    if (isAllergyPrompt(q.question)) {
      if (!isNegativeAllergy(q.answer)) allergies.push(q.answer);
    } else {
      requests.push(q.question ? q.question + ": " + q.answer : q.answer);
    }
  });

  var special = firstStr(r && (r.special_request || r.specialRequest || r.memo || r.notes));
  if (special) {
    special.split(/\r?\n/).forEach(function (line) {
      line = line.trim();
      if (!line) return;
      if (isAllergyPrompt(line)) {
        var allergy = line.replace(/^\s*(?:アレルギー|allerg(?:y|ies)|食物アレルギー|dietary\s+restriction(?:s)?)\s*[:：]?\s*/i, "").trim();
        if (!isNegativeAllergy(allergy)) allergies.push(allergy || line);
      } else {
        requests.push(line);
      }
    });
  }

  return {
    allergies: uniqueNotes(allergies).join("、"),
    request: uniqueNotes(requests).join(" / "),
    questions: questions,
  };
}

function normalizeQuestions(value) {
  if (!Array.isArray(value)) return [];
  return value.map(function (q) {
    q = q || {};
    return {
      id: q.id != null ? String(q.id) : null,
      question: noteValue(q.question || q.label || q.title),
      answer: noteValue(q.answer || q.value || q.response),
    };
  }).filter(function (q) { return q.question || q.answer; });
}

function noteValue(value) {
  if (value == null || value === false) return "";
  if (Array.isArray(value)) return value.map(noteValue).filter(Boolean).join("、");
  if (typeof value === "object") return noteValue(value.text || value.label || value.value || value.name);
  return String(value).trim();
}

function isAllergyPrompt(value) {
  return /アレルギ|食物アレルギ|allerg|dietary\s+restriction|food\s+restriction|除去|苦手/i.test(String(value || ""));
}

function isNegativeAllergy(value) {
  return /^(?:なし|無|ない|特になし|なしです|no|none|n\/a)$/i.test(String(value || "").trim());
}

function uniqueNotes(values) {
  var seen = {};
  return (values || []).map(function (v) { return String(v || "").trim(); }).filter(function (v) {
    if (!v || seen[v]) return false;
    seen[v] = true;
    return true;
  });
}

/** menu_item_name_translations({ja,en,...}) から表示名を選ぶ (日本語優先→英語→先頭の値) */
function transName(t) {
  if (!t || typeof t !== "object") return null;
  return firstStr(t.ja, t.en) || firstStr.apply(null, Object.keys(t).map(function (k) { return t[k]; }));
}

/**
 * memo 自由テキストの簡易パーサ (フォールバック)。
 * 「山城牛の焼きすき土鍋御膳 x2」「御膳×2」「御膳 2個」等を1行1品として拾う。
 * 店側で予約メモの記載フォーマットを揃える運用と対になる。
 */
function parseMenuFromMemo(memo) {
  if (!memo) return [];
  var out = [];
  memo.split(/\r?\n|、|,/).forEach(function (line) {
    line = line.trim();
    if (!line) return;
    var m = line.match(/^(.+?)\s*[x×✕]\s*(\d+)\s*$/) || line.match(/^(.+?)\s+(\d+)\s*(?:個|つ|名分)?$/);
    if (m) out.push({ name: m[1].trim(), qty: Number(m[2]), options: null, allergies: null });
  });
  return out;
}

/**
 * SyncEvent 群を内部ストアへ適用する (created/updated = upsert, deleted = 削除)。
 * TableCheck 推奨のイベント処理方針に従う:
 *   - created/updated は区別せず upsert
 *   - 未知 ID の deleted は無視
 *   - フェッチで 404 だった予約は削除扱い (fetchResult に null を渡す)
 * @param {Map<string,Object>} store - rid -> 内部レコード
 * @param {Array<{rid:string, record:(Object|null)}>} fetched - イベントで検知した予約の取得結果
 * @returns {number} 変更件数
 */
function applyFetched(store, fetched) {
  var changed = 0;
  (fetched || []).forEach(function (f) {
    if (!f || !f.rid) return;
    if (f.record == null) {                       // 404 = 削除扱い
      if (store.delete(String(f.rid))) changed++;
      return;
    }
    store.set(String(f.rid), f.record);
    changed++;
  });
  return changed;
}

/**
 * 当日分パージ + 非アクティブ除去。KDS へ渡す直前に呼ぶ。
 * (6/18 議事録「注文・予約データはサーバに保存しない (当日分のみ)」を実装で担保)
 * @param {Map<string,Object>} store
 * @param {Date} now
 */
function purge(store, now) {
  var today = localDateStr(now);
  Array.from(store.entries()).forEach(function (e) {
    var rid = e[0], rec = e[1];
    var d = new Date(rec.startAt);
    var notToday = isNaN(d) || localDateStr(d) !== today;
    var inactive = ACTIVE_STATUSES.indexOf(rec.status) < 0;
    if (notToday || inactive) store.delete(rid);
  });
}

/**
 * 内部レコード → KDS 予約ストック形式 ({rid,time,adults,kids,name,menu,seenAt})。
 * メニューが空の予約 (席だけ予約) は KDS に出さない (db-design §5.1 / deshup-spec 準拠)。
 * @param {Map<string,Object>} store
 * @param {number} seenAt - 取込時刻 (ms)
 */
function toKdsStock(store, seenAt) {
  var out = [];
  store.forEach(function (rec) {
    if (!rec.menu || !rec.menu.length) return;    // 席だけ予約は載せない
    var d = new Date(rec.startAt);
    var item = {
      rid: rec.rid,
      time: isNaN(d) ? String(rec.startAt) : pad2(d.getHours()) + ":" + pad2(d.getMinutes()),
      adults: rec.adults, kids: rec.kids,
      name: rec.name,
      menu: rec.menu,
      seenAt: seenAt,
    };
    // 既存の予約ストック契約を壊さず、注記がある予約だけ追加フィールドを配信する。
    if (rec.allergies) item.allergies = rec.allergies;
    if (rec.request) item.request = rec.request;
    if (rec.memo) item.memo = rec.memo;
    if (Array.isArray(rec.questions) && rec.questions.length) item.questions = rec.questions;
    out.push(item);
  });
  out.sort(function (a, b) { return a.time < b.time ? -1 : a.time > b.time ? 1 : 0; });
  return out;
}

/* ---- 小道具 ---- */
function firstNum() { for (var i = 0; i < arguments.length; i++) { var v = arguments[i]; if (v != null && v !== "" && !isNaN(Number(v))) return Number(v); } return null; }
function firstStr() { for (var i = 0; i < arguments.length; i++) { var v = arguments[i]; if (typeof v === "string" && v.trim()) return v.trim(); } return null; }
function pad2(n) { return (n < 10 ? "0" : "") + n; }
function localDateStr(d) { return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }

module.exports = {
  normalizeReservation: normalizeReservation,
  normalizeReservationNotes: normalizeReservationNotes,
  normalizeStatus: normalizeStatus,
  normalizeMenu: normalizeMenu,
  parseMenuFromMemo: parseMenuFromMemo,
  applyFetched: applyFetched,
  purge: purge,
  toKdsStock: toKdsStock,
  ACTIVE_STATUSES: ACTIVE_STATUSES,
  STATUS_MAP: STATUS_MAP,
};
