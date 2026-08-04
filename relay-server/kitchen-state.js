/**
 * kitchen-state.js — 厨房状態の端末間共有 (当日メモリのみ・依存ゼロ)
 *
 * KDS の厨房状態 (コンロ番号・品目完了・タイマーロック・カード並び順・削除済みID) は
 * localStorage + BroadcastChannel で同期しているが、どちらも同一ブラウザ内でしか届かない。
 * 物理的に別の端末 (厨房用 + ホール用) を並べると一切共有されない (#132)。
 *
 * ここでは KDS が既に BroadcastChannel("kds_sync") へ流している**変更イベントをそのまま
 * 受け取り**、relay 側で当日の状態へ畳み込む。各端末はスナップショットを取り込むだけでよい。
 *
 * 受け取るイベント (kds-a-grid.html の broadcast* と同じ形):
 *   { type:"konro",       id, num, state }    state は "skeleton" で解除
 *   { type:"toggle",      id, index, doneCount }
 *   { type:"timerLock",   id, locked }
 *   { type:"order",       seq:[cardId,...] }
 *   { type:"deleteOrder", id }
 *
 * 全イベントが「絶対値の代入」なので、再送・重複適用しても結果が変わらない (冪等)。
 * 端末が複数タブを開いていて同じイベントが二重に届いても壊れない。
 */
"use strict";

var KONRO_DEFAULT = "skeleton";   // kds-a-grid.html の KONRO_DEFAULT と同値 (これは保存しない)
var MAX_ID_LENGTH = 64;
var MAX_STATE_LENGTH = 16;
var MAX_KONRO_NUM = 99;
var MAX_ITEM_INDEX = 999;
var MAX_DONE_COUNT = 999;
var MAX_SEQ = 500;
var MAX_CARDS = 500;              // 1日の注文数として十分に余裕のある上限 (無制限肥大の防止)

function createState(sessionId) {
  return {
    sessionId: String(sessionId || ""),
    rev: 0,
    updatedAt: 0,
    konro: {},
    done: {},
    locked: {},
    seq: [],
    deleted: {},
  };
}

function validId(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  var id = String(value).trim();
  if (!id || id.length > MAX_ID_LENGTH) return null;
  return id;
}

function validInt(value, min, max) {
  var n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

/* 上限を超えた分は最も古いキーから落とす。掃除の正本は各端末側 (prune) にあるが、
   端末が落ちたまま戻らないケースで relay 側が無制限に太らないようにする */
function capKeys(map, max) {
  var keys = Object.keys(map);
  for (var i = 0; i < keys.length - max; i++) delete map[keys[i]];
}

function forgetCard(state, id) {
  delete state.konro[id];
  delete state.done[id];
  delete state.locked[id];
  state.seq = state.seq.filter(function (x) { return x !== id; });
}

/**
 * イベント1件を状態へ畳み込む。戻り値は { ok:true } か { error }。
 * 未知の type は「この relay が知らないだけ」なので受理して無視する (KDS 側の拡張を止めない)。
 */
function applyEvent(state, event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return { error: "event must be an object" };

  if (event.type === "konro") {
    var konroId = validId(event.id);
    if (!konroId) return { error: "konro.id is invalid" };
    var num = validInt(event.num, 1, MAX_KONRO_NUM);
    if (num === null) return { error: "konro.num is invalid" };
    var konroState = typeof event.state === "string" ? event.state.trim() : "";
    if (!konroState || konroState.length > MAX_STATE_LENGTH) return { error: "konro.state is invalid" };
    if (konroState === KONRO_DEFAULT) {
      if (state.konro[konroId]) {
        delete state.konro[konroId][String(num)];
        if (!Object.keys(state.konro[konroId]).length) delete state.konro[konroId];
      }
    } else {
      if (!state.konro[konroId]) state.konro[konroId] = {};
      state.konro[konroId][String(num)] = konroState;
      capKeys(state.konro, MAX_CARDS);
    }
    return { ok: true };
  }

  if (event.type === "toggle") {
    var doneId = validId(event.id);
    if (!doneId) return { error: "toggle.id is invalid" };
    var index = validInt(event.index, 0, MAX_ITEM_INDEX);
    if (index === null) return { error: "toggle.index is invalid" };
    var count = validInt(event.doneCount, 0, MAX_DONE_COUNT);
    if (count === null) return { error: "toggle.doneCount is invalid" };
    // KDS 側と同じく「id -> 個数の配列」。歯抜けは JSON 化で null になるが、
    // 取り込み側の normalizeDoneCount() が null を 0 として吸収する
    if (!Array.isArray(state.done[doneId])) state.done[doneId] = [];
    state.done[doneId][index] = count;
    capKeys(state.done, MAX_CARDS);
    return { ok: true };
  }

  if (event.type === "timerLock") {
    var lockId = validId(event.id);
    if (!lockId) return { error: "timerLock.id is invalid" };
    if (event.locked) state.locked[lockId] = true;
    else delete state.locked[lockId];
    capKeys(state.locked, MAX_CARDS);
    return { ok: true };
  }

  if (event.type === "order") {
    if (!Array.isArray(event.seq)) return { error: "order.seq must be an array" };
    if (event.seq.length > MAX_SEQ) return { error: "order.seq is too long" };
    var seq = [];
    for (var i = 0; i < event.seq.length; i++) {
      var seqId = validId(event.seq[i]);
      if (!seqId) return { error: "order.seq[" + i + "] is invalid" };
      if (seq.indexOf(seqId) < 0) seq.push(seqId);
    }
    state.seq = seq;
    return { ok: true };
  }

  if (event.type === "deleteOrder") {
    var delId = validId(event.id);
    if (!delId) return { error: "deleteOrder.id is invalid" };
    state.deleted[delId] = true;
    capKeys(state.deleted, MAX_CARDS);
    forgetCard(state, delId);
    return { ok: true };
  }

  return { ok: true, ignored: true };
}

/**
 * イベント列をまとめて適用する。1件でも受理されれば rev を進める。
 * 不正なイベントは受理せずエラーを返す (送信側のバグを黙って飲み込まない)。
 */
function applyEvents(state, events, now) {
  if (!Array.isArray(events)) return { error: "events must be an array" };
  if (!events.length) return { error: "events must not be empty" };
  if (events.length > 200) return { error: "events must contain at most 200 entries" };

  var applied = 0;
  for (var i = 0; i < events.length; i++) {
    var result = applyEvent(state, events[i]);
    if (result.error) return { error: "events[" + i + "]: " + result.error };
    if (!result.ignored) applied++;
  }
  if (applied) {
    state.rev++;
    state.updatedAt = now;
  }
  return { ok: true, applied: applied, rev: state.rev };
}

/* 前日の状態を持ち越さない (#115 当日メモリのみ)。最後の更新から ttl を過ぎたら捨てる。
   rev は戻さず進める: 端末側は rev の後退を「別セッション」と見なすため */
function purgeStale(state, now, ttlMs) {
  if (!state.updatedAt || now - state.updatedAt <= ttlMs) return false;
  state.konro = {};
  state.done = {};
  state.locked = {};
  state.seq = [];
  state.deleted = {};
  state.rev++;
  state.updatedAt = now;
  return true;
}

function snapshot(state) {
  return {
    sessionId: state.sessionId,
    rev: state.rev,
    updatedAt: state.updatedAt,
    konro: state.konro,
    done: state.done,
    locked: state.locked,
    seq: state.seq,
    deleted: state.deleted,
  };
}

module.exports = {
  KONRO_DEFAULT: KONRO_DEFAULT,
  createState: createState,
  applyEvent: applyEvent,
  applyEvents: applyEvents,
  purgeStale: purgeStale,
  snapshot: snapshot,
};
