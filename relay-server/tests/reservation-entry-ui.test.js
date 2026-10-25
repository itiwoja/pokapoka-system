"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const createEntry = require("../../assets/reservations/entry");
const PartySize = require("../party-size");
const html = fs.readFileSync(path.join(__dirname, "../../reservation-entry.html"), "utf8");

// フォームの値とイベントのみを扱う小さなDOM。レイアウトは実ブラウザで別途確認する。
class Node {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.attributes = {};
    this.listeners = {};
    this.files = [];
    this.value = "";
    this.textContent = "";
  }
  set value(value) { this._value = String(value); }
  get value() { return this._value; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  appendChild(node) { node.parent = this; this.children.push(node); return node; }
  remove() { this.parent.children = this.parent.children.filter((n) => n !== this); }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  emit(type) { return this.listeners[type]({ preventDefault() {} }); }
  querySelectorAll(tag) {
    return this.children.flatMap((c) => (c.tag === tag ? [c] : []).concat(c.querySelectorAll(tag)));
  }
}

const reservation = {
  rid: "test/予約", startAt: new Date(2026, 9, 25, 12, 30).toISOString(), name: "テスト予約",
  adults: 2, seniors: 1, children: 1, kids: 1, table: "A1", status: "booked",
  allergies: "えび", request: "窓側", memo: "メモ",
  menu: [{ name: "土鍋御膳", qty: 2, options: "ねぎ抜き", allergies: "卵" }],
};
const response = (status, body) => ({ status, json: () => Promise.resolve(body) });
const settle = () => new Promise(setImmediate);

async function setup(handle) {
  const nodes = {};
  const defaults = {};
  for (const match of html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const node = nodes[match[2]] = new Node(match[1]);
    node.value = defaults[match[2]] = /\bvalue="([^"]*)"/.exec(match[0])?.[1] || "";
    node.disabled = /\sdisabled(?:\s|>)/.test(match[0]);
  }
  nodes.form.reset = () => {
    Object.keys(nodes).filter((id) => /^f[A-Z]/.test(id)).forEach((id) => { nodes[id].value = defaults[id]; });
  };
  const tabs = ["form", "csv", "paste", "mail"].map((name) => {
    const node = new Node("button"); node.dataset.tab = name; return node;
  });
  const panes = tabs.map((t) => { const n = new Node("div"); n.dataset.pane = t.dataset.tab; return n; });
  const calls = [], timers = [];
  const document = {
    getElementById: (id) => nodes[id],
    createElement: (tag) => new Node(tag),
    querySelectorAll: (selector) => selector === "[data-tab]" ? tabs : panes,
  };
  const controller = createEntry({
    document, PartySize, Blob,
    now: () => new Date(2026, 9, 25, 8, 5),
    setTimeout: (fn, delay) => timers.push({ fn, delay }),
    fetch: (url, init) => {
      calls.push({ url, ...init });
      return Promise.resolve().then(() => handle?.(url, init) || response(200, { reservations: [] }));
    },
  });
  await settle();
  return { nodes, calls, timers, tabs, panes, controller };
}

test("予約画面はrequireで起動せず、HTMLの共有依存の後に読み込まれる", () => {
  assert.equal(typeof createEntry, "function");
  assert.match(html, /<link rel="stylesheet" href="assets\/reservations\/entry\.css">/);
  assert.ok(html.indexOf('src="relay-server/party-size.js"') < html.indexOf('src="assets/reservations/entry.js"'));
});

test("ブラウザのclassic script経路も同じファクトリーを自動起動する", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../../assets/reservations/entry.js"), "utf8");
  const { nodes } = await setup();
  const doc = {
    getElementById: (id) => nodes[id], createElement: (tag) => new Node(tag), querySelectorAll: () => [],
  };
  vm.runInNewContext(source, { window: {
    document: doc, PartySize, Blob, setTimeout() {},
    fetch() { return Promise.resolve(response(200, { reservations: [] })); },
  } });
  await settle();
  assert.equal(nodes.formSubmit.textContent, "登録する");
  assert.equal(nodes.menuRows.children.length, 1);
});

test("初期化・リセットは表示日を使い、4区分の合計を表示する", async () => {
  const { nodes, controller, calls } = await setup();
  assert.equal(nodes.listDate.value, "2026-10-25");
  assert.equal(nodes.fDate.value, "2026-10-25");
  assert.match(nodes.fTotal.textContent, /合計 2名/);
  assert.equal(nodes.menuRows.children.length, 1);
  assert.equal(calls.length, 1);
  nodes.listDate.value = "2026-11-04";
  controller.resetForm();
  assert.equal(nodes.fDate.value, "2026-11-04");
});

test("フォーム往復でID・メールID・取消・人数・見えない品目情報を失わない", async () => {
  const { nodes, controller, calls } = await setup();
  const rec = { ...reservation, status: "canceled" };
  const warnings = ["読み取り内容を確認"];
  controller.fillForm(rec, { mailId: "sample.eml", existing: true, warnings });
  const body = controller.readForm();
  assert.deepEqual(body, { ...rec, startAt: body.startAt, mailId: "sample.eml" });
  assert.equal(Date.parse(body.startAt), Date.parse(rec.startAt));
  assert.match(body.startAt, /[+-]\d{2}:\d{2}$/);
  assert.equal(nodes.formSubmit.textContent, "変更を保存する");
  assert.match(nodes.fTotal.textContent, /合計 5名.*大人2・シニア1・子供1・幼児1/);
  assert.match(nodes.formWarn.textContent, /取消/);
  assert.deepEqual(warnings, ["読み取り内容を確認"]);
  assert.equal(calls.length, 1, "下書きをフォームに入れるだけでは送信しない");
  controller.resetForm();
  assert.equal(controller.readForm().rid, undefined);
  assert.equal(controller.readForm().mailId, undefined);
  assert.equal(controller.readForm().status, "booked");
});

test("新規と既存の保存はPOSTのままで、成功後はフォームと一覧を更新する", async () => {
  const { nodes, controller, calls } = await setup((url, init) => {
    if (init.method === "POST") return response(200, { reservation: JSON.parse(init.body) });
  });
  controller.fillForm(reservation, { existing: true });
  const saving = nodes.form.emit("submit");
  assert.equal(nodes.formSubmit.disabled, true);
  await saving;
  await settle();
  const post = calls.find((call) => call.method === "POST");
  assert.equal(post.url, "/api/reservations");
  assert.equal(post.credentials, "same-origin");
  assert.equal(post.headers["Content-Type"], "application/json");
  assert.equal(JSON.parse(post.body).rid, reservation.rid);
  assert.equal(nodes.formSubmit.disabled, false);
  assert.equal(nodes.formTitle.textContent, "予約を登録");
  assert.match(nodes.formMsg.textContent, /保存しました/);
  assert.equal(calls.filter((call) => call.method === "GET").length, 2);
});

test("保存時のHTTP・通信エラーは表示し、入力を維持してボタンを再有効化する", async () => {
  for (const failure of [() => response(400, { error: "入力を確認" }), () => { throw new Error("offline"); }]) {
    const { nodes, controller } = await setup((url, init) => init.method === "POST" ? failure() : undefined);
    controller.fillForm(reservation);
    await nodes.form.emit("submit");
    assert.equal(nodes.formSubmit.disabled, false);
    assert.match(nodes.formMsg.textContent, /入力を確認|サーバーに接続できません/);
    assert.equal(nodes.fName.value, reservation.name);
  }
});

test("CSV確認はdryRunで、本取込後は再確認が必要。ファイル変更も確認状態を解除する", async () => {
  const { nodes, calls } = await setup((url) => url.includes("/import/csv")
    ? response(200, { valid: 2, failed: 0, saved: 2, rows: [], columns: {} }) : undefined);
  const file = new Blob(["来店日,名前"], { type: "text/csv" });
  nodes.csvFile.files = [file];
  nodes.csvFile.emit("change");
  assert.equal(nodes.csvCheck.disabled, false);
  assert.equal(nodes.csvImport.disabled, true);
  await nodes.csvCheck.emit("click");
  assert.equal(nodes.csvImport.disabled, false);
  assert.equal(nodes.csvImport.textContent, "2件を取り込む");
  let request = calls.find((c) => c.url.includes("dryRun"));
  assert.equal(request.url, "/api/reservations/import/csv?dryRun=1");
  assert.equal(request.body, file);
  await nodes.csvImport.emit("click");
  assert.equal(nodes.csvImport.disabled, true);
  assert.equal(calls.filter((c) => c.url.endsWith("/import/csv")).length, 1);
  await nodes.csvCheck.emit("click");
  nodes.csvFile.files = [];
  nodes.csvFile.emit("change");
  assert.equal(nodes.csvCheck.disabled, true);
  assert.equal(nodes.csvImport.disabled, true);
  assert.equal(nodes.csvPreview.textContent, "");
});

test("貼り付け・メール解析は下書きだけを入れ、登録を自動実行しない", async () => {
  const { nodes, calls, controller } = await setup((url) => url.includes("/import/")
    ? response(200, { draft: reservation, warnings: ["要確認"] }) : undefined);
  nodes.pasteText.value = "予約詳細";
  await nodes.pasteParse.emit("click");
  assert.equal(nodes.fName.value, reservation.name);
  assert.match(nodes.formWarn.textContent, /要確認/);
  nodes.mailText.value = "メール本文";
  await nodes.mailParse.emit("click");
  assert.equal(controller.readForm().rid, reservation.rid);
  assert.equal(calls.filter((c) => c.method === "POST" && c.url === "/api/reservations").length, 0);
  assert.equal(calls.find((c) => c.url.includes("/import/mail")).body, "メール本文");
});

test("取消は4秒以内の二度押しでのみ送信し、予約IDをURLエンコードする", async () => {
  const { nodes, calls, timers } = await setup((url, init) => {
    if (init.method === "GET") return response(200, { reservations: [reservation] });
    return response(200, {});
  });
  const cancel = nodes.listBody.querySelectorAll("button").find((n) => n.textContent === "取消");
  cancel.emit("click");
  assert.equal(calls.filter((c) => c.method === "DELETE").length, 0);
  assert.equal(timers[0].delay, 4000);
  timers[0].fn();
  assert.equal(cancel.textContent, "取消");
  cancel.emit("click");
  await cancel.emit("click");
  assert.equal(calls.find((c) => c.method === "DELETE").url, "/api/reservations/" + encodeURIComponent(reservation.rid));
});

test("メール候補選択は非保存で、登録時だけmailIdを送り候補を再読込する", async () => {
  const { nodes, calls, controller } = await setup((url, init) => {
    if (url.endsWith("/inbox")) return response(200, { enabled: true, items: [{
      id: "sample.eml", subject: "予約", receivedAt: reservation.startAt, draft: reservation, warnings: [],
    }] });
    if (init.method === "POST") return response(201, { reservation: JSON.parse(init.body) });
  });
  controller.showTab("mail");
  await settle();
  const use = nodes.inboxList.querySelectorAll("button").find((node) => node.textContent === "フォームに入れる");
  use.emit("click");
  assert.equal(calls.filter((call) => call.method === "POST").length, 0);
  await nodes.form.emit("submit");
  await settle();
  assert.equal(JSON.parse(calls.find((call) => call.method === "POST").body).mailId, "sample.eml");
  assert.equal(calls.filter((call) => call.url.endsWith("/inbox")).length, 2);
});

test("CSV確認中の差替えでは古い成功応答を無視し、確認したファイルだけを保存する", async () => {
  for (const oldFirst of [true, false]) {
    const fileA = new Blob(["A"]), fileB = new Blob(["B"]);
    let resolveA, resolveB;
    const { nodes, calls } = await setup((url, init) => {
      if (url.includes("dryRun")) return new Promise((resolve) => {
        if (init.body === fileA) resolveA = resolve;
        else resolveB = resolve;
      });
      if (url.endsWith("/import/csv")) return response(200, { saved: 3, rows: [] });
    });
    nodes.csvFile.files = [fileA];
    nodes.csvFile.emit("change");
    const checkingA = nodes.csvCheck.emit("click");
    await settle();
    nodes.csvFile.files = [fileB];
    nodes.csvFile.emit("change");
    await nodes.csvImport.emit("click");
    assert.equal(calls.filter((c) => c.url.endsWith("/import/csv")).length, 0, "Bは未確認なので保存しない");
    const checkingB = nodes.csvCheck.emit("click");
    await settle();
    if (oldFirst) {
      resolveA(response(200, { valid: 99, rows: [] }));
      await checkingA;
      assert.equal(nodes.csvImport.disabled, true);
      assert.equal(nodes.csvCheck.disabled, true, "Bの確認中にAの完了でボタンを戻さない");
      assert.equal(nodes.csvPreview.textContent, "");
    }
    resolveB(response(200, { valid: 3, rows: [] }));
    await checkingB;
    if (!oldFirst) {
      resolveA(response(200, { valid: 99, rows: [] }));
      await checkingA;
    }
    assert.equal(nodes.csvImport.textContent, "3件を取り込む");
    assert.match(nodes.csvMsg.textContent, /予約: 3件/);
    await nodes.csvImport.emit("click");
    assert.equal(calls.find((c) => c.url.endsWith("/import/csv")).body, fileB);
  }
});

test("CSV確認中の選択解除は、古い成功・失敗どちらでも取込を再有効化しない", async () => {
  for (const fail of [false, true]) {
    let resolve, reject;
    const { nodes } = await setup((url) => url.includes("dryRun")
      ? new Promise((ok, bad) => { resolve = ok; reject = bad; }) : undefined);
    nodes.csvFile.files = [new Blob(["A"])];
    nodes.csvFile.emit("change");
    const checking = nodes.csvCheck.emit("click");
    await settle();
    nodes.csvFile.files = [];
    nodes.csvFile.emit("change");
    if (fail) reject(new Error("old request failed"));
    else resolve(response(200, { valid: 1, rows: [] }));
    await checking;
    assert.equal(nodes.csvCheck.disabled, true);
    assert.equal(nodes.csvImport.disabled, true);
    assert.equal(nodes.csvPreview.textContent, "");
    assert.equal(nodes.csvMsg.textContent, "");
  }
});

test("取消のHTTP・通信失敗は表示を残し、成功したかのように一覧を再読込しない", async () => {
  for (const failure of [() => response(503, { error: "取消を保存できません" }), () => { throw new Error("offline"); }]) {
    const { nodes, calls } = await setup((url, init) => {
      if (init.method === "DELETE") return failure();
      return response(200, { reservations: [reservation] });
    });
    const cancel = nodes.listBody.querySelectorAll("button").find((n) => n.textContent === "取消");
    cancel.emit("click");
    await cancel.emit("click");
    await settle();
    assert.match(nodes.listMsg.textContent, /取消を保存できません|サーバーに接続できません/);
    assert.equal(calls.filter((c) => c.method === "GET").length, 1);
    assert.equal(nodes.listBody.children.length, 1);
  }
});

test("本取込待機中の差替え・選択解除でも、成功した保存を一覧へ反映する", async () => {
  for (const replace of [false, true]) {
    let resolveImport;
    const { nodes, calls } = await setup((url) => {
      if (url.includes("dryRun")) return response(200, { valid: 1, rows: [] });
      if (url.endsWith("/import/csv")) return new Promise((resolve) => { resolveImport = resolve; });
    });
    nodes.csvFile.files = [new Blob(["A"])];
    nodes.csvFile.emit("change");
    await nodes.csvCheck.emit("click");
    const importing = nodes.csvImport.emit("click");
    await settle();
    nodes.csvFile.files = replace ? [new Blob(["B"])] : [];
    nodes.csvFile.emit("change");
    if (replace) await nodes.csvCheck.emit("click");
    const message = nodes.csvMsg.textContent;
    const preview = nodes.csvPreview.textContent;
    resolveImport(response(200, { saved: 1, rows: [] }));
    await importing;
    await settle();
    assert.equal(calls.filter((call) => call.method === "GET").length, 2, "Aの保存成功後も一覧を更新する");
    assert.equal(nodes.csvMsg.textContent, message, "新しい選択のメッセージを上書きしない");
    assert.equal(nodes.csvPreview.textContent, preview);
    assert.equal(nodes.csvImport.disabled, !replace);
    assert.equal(nodes.csvCheck.disabled, !replace);
  }
});
