"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { functionSource: source } = require("./helpers/kds-source");

// 手で進める setTimeout
function fakeClock() {
  let now = 0, seq = 0;
  const timers = new Map();
  return {
    setTimeout(fn, ms) { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) {
      now += ms;
      for (const [id, t] of Array.from(timers)) {
        if (t.at <= now) { timers.delete(id); t.fn(); }
      }
    },
  };
}

function order(id, table, done) {
  return { id, table, items: [{ name: "鯛めし土鍋御膳", qty: 1, doneCount: done ? 1 : 0, done: !!done }] };
}
const plain = v => JSON.parse(JSON.stringify(v));

// #298: 全品完了した卓のコンロ・タイマーを「戻す」の猶予の後に外し、読み飛ばしで外れたら知らせる
function harness(konroMap, orders) {
  const calls = [];
  const clock = fakeClock();
  const cards = {};
  (orders || []).forEach(o => {
    cards[o.id] = { order: o, el: { classList: { add() {} }, querySelectorAll() { return []; } } };
  });
  const context = vm.createContext({
    mode: "kitchen", view: "grid",
    konroMap, cards, doneMap: {},
    KONRO_CYCLE: { skeleton: "white", white: "red", red: "skeleton" }, KONRO_DEFAULT: "skeleton",
    UNDO_TOAST_MS: 6000, undoInfo: null, undoTimer: null, konroReleaseTimers: {},
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    t: k => ({ konroHudKonro: "コンロ", konroHudTimer: "タイマー" }[k] || k),
    effectiveTable: o => o.table,
    ownerTable(cid) { const e = cards[cid]; return e && e.order ? e.order.table : ""; },
    saveKonro() { calls.push(["saveKonro"]); },
    broadcastKonro(id, num, state) { calls.push(["broadcastKonro", id, num, state]); },
    refreshKonroNum() {}, refreshAllKonro() {}, updateKonroHud() { calls.push(["hud"]); },
    showPrintToast(msg) { calls.push(["toast", msg]); },
    // onToggle / undoComplete が呼ぶもの
    saveDone() {}, broadcastToggle() {}, updateItemButtonDone() {}, renderLanes() {},
    ensureHallReadySnapshot() {}, recordServe() {}, removeLatestServeRecord() {},
    showUndoToast(o, idx) { context.undoInfo = { id: String(o.id), index: idx }; },
    hideUndoToast() { context.undoInfo = null; },
    poll() { calls.push(["poll"]); },
  });
  vm.runInContext([
    "konroState", "konroOwnerId", "nextKonroState", "setKonroState",
    "isOrderAllDone", "isAllDone",
    "scheduleKonroRelease", "cancelKonroRelease", "releaseKonroOfCompleted", "konroKindName",
    "onKonroTap", "onToggle", "undoComplete",
  ].map(source).join("\n"), context);
  return { context, calls, clock };
}

test("全品完了にしてから「戻す」の猶予 (6秒) が過ぎたら、その卓のコンロ・タイマーをすべて外して伝える", () => {
  const h = harness({ o3: { "4": "red", "2": "white" } }, [order("o3", "3", false)]);
  h.context.onToggle("o3", 0);                       // 最後の品目を押して全品完了
  h.clock.advance(5999);
  assert.deepEqual(plain(h.context.konroMap), { o3: { "4": "red", "2": "white" } }, "猶予中は外さない");
  h.clock.advance(1);
  assert.deepEqual(plain(h.context.konroMap), {});
  const sent = h.calls.filter(c => c[0] === "broadcastKonro").map(c => c.slice(1));
  assert.deepEqual(sent.sort(), [["o3", 2, "skeleton"], ["o3", 4, "skeleton"]]);
  assert.ok(h.calls.some(c => c[0] === "saveKonro"));
  assert.ok(h.calls.some(c => c[0] === "hud"));
});

test("猶予中に「戻す」を押したら、コンロ・タイマーは外さない", () => {
  const h = harness({ o3: { "4": "red" } }, [order("o3", "3", false)]);
  h.context.onToggle("o3", 0);
  h.clock.advance(3000);
  h.context.undoComplete();
  h.clock.advance(10000);
  assert.deepEqual(plain(h.context.konroMap), { o3: { "4": "red" } });
  assert.equal(h.calls.some(c => c[0] === "broadcastKonro"), false);
});

test("猶予中に他タブで未完了へ戻された卓 (時刻が来た時点で全品完了でない) は外さない", () => {
  const o = order("o3", "3", false);
  const h = harness({ o3: { "4": "red" } }, [o]);
  h.context.onToggle("o3", 0);
  o.items[0].done = false; o.items[0].doneCount = 0;   // 他タブの undo が届いた
  h.clock.advance(6000);
  assert.deepEqual(plain(h.context.konroMap), { o3: { "4": "red" } });
});

test("別の卓が続けて完了しても、先に完了した卓のコンロも外れる (トーストの上書きに引きずられない)", () => {
  const h = harness({ o3: { "4": "red" }, o5: { "1": "white" } }, [order("o3", "3", false), order("o5", "5", false)]);
  h.context.onToggle("o3", 0);
  h.clock.advance(2000);
  h.context.onToggle("o5", 0);
  h.clock.advance(6000);
  assert.deepEqual(plain(h.context.konroMap), {});
});

test("完了していない卓のコンロ・タイマーには触れない", () => {
  const h = harness({ o3: { "4": "red" }, o6: { "4": "white" } }, [order("o3", "3", false), order("o6", "6", false)]);
  h.context.onToggle("o3", 0);
  h.clock.advance(6000);
  assert.deepEqual(plain(h.context.konroMap), { o6: { "4": "white" } });
});

test("読み飛ばしで自分の割り当てが外れるときは、どの卓が埋めているかを知らせる", () => {
  // 卓3がタイマー4、卓6がコンロ4。卓6でもう一度押すと、タイマー4は埋まっているので「未使用」へ
  const h = harness({ o3: { "4": "red" }, o6: { "4": "white" } }, [order("o3", "3", false), order("o6", "6", false)]);
  h.context.onKonroTap("o6", 4);
  assert.equal(h.context.konroState("o6", 4), "skeleton");
  assert.deepEqual(h.calls.filter(c => c[0] === "toast"), [["toast", "タイマー4は卓3が使用中のため、コンロ4を外しました"]]);
});

test("ふつうの進み方 (空いている枠へ進む・タイマーから未使用へ戻す) では知らせない", () => {
  const h = harness({ o6: { "4": "white" } }, [order("o6", "6", false)]);
  h.context.onKonroTap("o6", 4);                       // 使用中 → タイマー管理中
  assert.equal(h.context.konroState("o6", 4), "red");
  h.context.onKonroTap("o6", 4);                       // タイマー管理中 → 未使用
  assert.equal(h.context.konroState("o6", 4), "skeleton");
  // 未使用から押して、コンロ枠が埋まっているのでタイマーへ進む (割り当ては外れない)
  const h2 = harness({ o3: { "4": "white" } }, [order("o3", "3", false), order("o6", "6", false)]);
  h2.context.onKonroTap("o6", 4);
  assert.equal(h2.context.konroState("o6", 4), "red");
  assert.equal(h.calls.concat(h2.calls).some(c => c[0] === "toast"), false);
});
