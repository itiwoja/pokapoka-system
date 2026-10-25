/** 予約入力画面。DOM・通信・時計を受け取るため、Nodeから読み込んでも起動しない。 */
(function (root, createReservationEntry) {
  "use strict";
  if (typeof module === "object" && module.exports) module.exports = createReservationEntry;
  else createReservationEntry({
    document: root.document,
    fetch: root.fetch.bind(root),
    PartySize: root.PartySize,
    Blob: root.Blob,
    setTimeout: root.setTimeout.bind(root),
  });
})(typeof window !== "undefined" ? window : null, function createReservationEntry(deps) {
  "use strict";

  var document = deps.document;
  var fetch = deps.fetch;
  var PartySize = deps.PartySize;
  var Blob = deps.Blob;
  var setTimeout = deps.setTimeout;
  var now = deps.now || function () { return new Date(); };
  var API = "/api/reservations";
  var $ = function (id) { return document.getElementById(id); };
  var editing = { rid: null, mailId: null, status: "booked" };

  /* ---------- 小道具 ---------- */
  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function dateStr(d) { return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }
  function timeStr(d) { return pad2(d.getHours()) + ":" + pad2(d.getMinutes()); }
  /** 端末のローカル時刻をオフセット付きの ISO8601 にする */
  function localIso(date, time) {
    var p = date.split("-"), t = time.split(":");
    var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), Number(t[0]), Number(t[1]));
    var offset = -d.getTimezoneOffset(), abs = Math.abs(offset);
    return date + "T" + pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":00" +
      (offset < 0 ? "-" : "+") + pad2(Math.floor(abs / 60)) + ":" + pad2(abs % 60);
  }
  function el(tag, text, className) {
    var node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function setMsg(node, text, kind) { node.textContent = text || ""; node.className = "msg" + (kind ? " " + kind : ""); }

  /* ---------- API ---------- */
  function api(method, path, body, headers) {
    var init = { method: method, headers: headers || {}, credentials: "same-origin" };
    if (body !== undefined) {
      if (typeof body === "string" || body instanceof Blob) init.body = body;
      else { init.body = JSON.stringify(body); init.headers["Content-Type"] = "application/json"; }
    }
    return fetch(path, init).then(function (res) {
      if (res.status === 204) return { status: 204, body: null };
      return res.json().then(function (json) { return { status: res.status, body: json }; },
        function () { return { status: res.status, body: null }; });
    });
  }
  function errorText(result) {
    if (result.status === 413) return "ファイルが大きすぎます (5MBまで)。期間を区切って書き出してください";
    return result.body && result.body.error ? result.body.error : "サーバーから応答がありません (" + result.status + ")";
  }

  /* ---------- タブ ---------- */
  var tabs = Array.prototype.slice.call(document.querySelectorAll("[data-tab]"));
  function showTab(name) {
    tabs.forEach(function (t) { t.setAttribute("aria-selected", t.dataset.tab === name ? "true" : "false"); });
    Array.prototype.forEach.call(document.querySelectorAll("[data-pane]"), function (p) { p.hidden = p.dataset.pane !== name; });
    if (name === "mail") loadInbox();
  }

  /* ---------- A. 手入力フォーム ---------- */
  function addMenuRow(item) {
    var row = el("div", null, "menu-row");
    var name = el("input"); name.type = "text"; name.placeholder = "品名"; name.maxLength = 500; name.value = item && item.name || "";
    var qty = el("input"); qty.type = "number"; qty.min = "1"; qty.value = item && item.qty || 1; qty.setAttribute("aria-label", "数量");
    var remove = el("button", "×", "plain"); remove.type = "button"; remove.setAttribute("aria-label", "この品目を削除");
    remove.addEventListener("click", function () { row.remove(); });
    // 入力欄のない品目情報も、変更保存で失わない。
    row._extra = { options: item && item.options || null, allergies: item && item.allergies || null };
    row.appendChild(name); row.appendChild(qty); row.appendChild(remove);
    $("menuRows").appendChild(row);
  }

  function resetForm() {
    editing = { rid: null, mailId: null, status: "booked" };
    $("form").reset();
    $("fDate").value = $("listDate").value || dateStr(now());
    $("menuRows").textContent = "";
    addMenuRow();
    $("formTitle").textContent = "予約を登録";
    $("formSubmit").textContent = "登録する";
    setMsg($("formWarn"), "", "warn");
    updateTotal();
  }

  /** 保存済み予約・下書きを同じフォームへ入れ、ID・取消状態・メールIDを保持する。 */
  function fillForm(rec, options) {
    options = options || {};
    resetForm();
    editing = { rid: rec.rid || null, mailId: options.mailId || null, status: rec.status || "booked" };
    if (rec.startAt && !isNaN(Date.parse(rec.startAt))) {
      var d = new Date(rec.startAt);
      $("fDate").value = dateStr(d); $("fTime").value = timeStr(d);
    } else { $("fDate").value = ""; $("fTime").value = ""; }
    $("fName").value = rec.name && rec.name !== "(名前なし)" ? rec.name : "";
    $("fAdults").value = rec.adults != null ? rec.adults : 0;
    $("fSeniors").value = rec.seniors != null ? rec.seniors : 0;
    $("fChildren").value = rec.children != null ? rec.children : 0;
    $("fKids").value = rec.kids != null ? rec.kids : 0;
    updateTotal();
    $("fTable").value = rec.table || "";
    $("fAllergies").value = rec.allergies || "";
    $("fRequest").value = rec.request || "";
    $("fMemo").value = rec.memo || "";
    $("menuRows").textContent = "";
    (rec.menu && rec.menu.length ? rec.menu : [null]).forEach(addMenuRow);
    if (options.existing) { $("formTitle").textContent = "予約を変更"; $("formSubmit").textContent = "変更を保存する"; }
    var warnings = (options.warnings || []).slice();
    if (editing.status === "canceled") warnings.push("この内容は「取消」として登録されます");
    setMsg($("formWarn"), warnings.join("\n"), "warn");
    setMsg($("formMsg"), "");
    showTab("form");
  }

  function readForm() {
    var menu = [];
    Array.prototype.forEach.call($("menuRows").children, function (row) {
      var inputs = row.querySelectorAll("input");
      var name = inputs[0].value.trim();
      if (!name) return;
      menu.push({ name: name, qty: Math.max(1, parseInt(inputs[1].value, 10) || 1), options: row._extra.options, allergies: row._extra.allergies });
    });
    var body = {
      startAt: localIso($("fDate").value, $("fTime").value),
      name: $("fName").value, adults: parseInt($("fAdults").value, 10) || 0, seniors: parseInt($("fSeniors").value, 10) || 0,
      children: parseInt($("fChildren").value, 10) || 0, kids: parseInt($("fKids").value, 10) || 0,
      table: $("fTable").value, menu: menu,
      allergies: $("fAllergies").value, request: $("fRequest").value, memo: $("fMemo").value,
      status: editing.status,
    };
    if (editing.rid) body.rid = editing.rid;
    if (editing.mailId) body.mailId = editing.mailId;
    return body;
  }

  function submitForm(event) {
    event.preventDefault();
    if (!$("fDate").value || !$("fTime").value) return setMsg($("formMsg"), "来店日と来店時間を入れてください", "err");
    var body = readForm();
    $("formSubmit").disabled = true;
    return api("POST", API, body).then(function (result) {
      if (result.status !== 200 && result.status !== 201) return setMsg($("formMsg"), errorText(result), "err");
      var saved = result.body.reservation;
      var hadMail = !!editing.mailId;
      $("listDate").value = dateStr(new Date(saved.startAt));
      resetForm();
      setMsg($("formMsg"), (result.status === 201 ? "登録しました: " : "保存しました: ") + saved.name +
        (saved.menu.length ? "" : "\nメニューが無いため、厨房画面には出ません"), "ok");
      loadList();
      if (hadMail) loadInbox();
    }).catch(function () { setMsg($("formMsg"), "サーバーに接続できません", "err"); })
      .then(function () { $("formSubmit").disabled = false; });
  }

  /* ---------- 登録済みの一覧 ---------- */
  /** 合計と内訳。0人の区分は表示せず、prefixで先頭の「計」を変える。 */
  function peopleText(rec, prefix) {
    var parts = PartySize.breakdown(rec).map(function (p) { return p.label + p.n; });
    return (prefix == null ? "計" : prefix) + PartySize.total(rec) + "名" + (parts.length ? " (" + parts.join("・") + ")" : "");
  }
  function updateTotal() {
    $("fTotal").textContent = peopleText({
      adults: $("fAdults").value, seniors: $("fSeniors").value, children: $("fChildren").value, kids: $("fKids").value,
    }, "合計 ");
  }
  function summary(rec) {
    var parts = [(rec.menu || []).map(function (m) { return m.name + " ×" + m.qty; }).join("、") || "(メニューなし)"];
    if (rec.allergies) parts.push("アレルギー: " + rec.allergies);
    if (rec.request) parts.push("要望: " + rec.request);
    if (rec.table) parts.push("卓: " + rec.table);
    return parts.join(" / ");
  }
  var STATUS_LABEL = { canceled: "取消", no_show: "来店なし", done: "完了" };

  function loadList() {
    var date = $("listDate").value;
    return api("GET", API + "?date=" + encodeURIComponent(date)).then(function (result) {
      var body = $("listBody");
      body.textContent = "";
      if (result.status !== 200) return setMsg($("listMsg"), errorText(result), "err");
      var list = result.body.reservations;
      setMsg($("listMsg"), list.length ? "" : "この日の予約はありません");
      list.forEach(function (rec) {
        var tr = el("tr", null, rec.status === "booked" ? "" : "off");
        tr.appendChild(el("td", timeStr(new Date(rec.startAt))));
        tr.appendChild(el("td", rec.name + (STATUS_LABEL[rec.status] ? " (" + STATUS_LABEL[rec.status] + ")" : "")));
        tr.appendChild(el("td", peopleText(rec)));
        tr.appendChild(el("td", summary(rec)));
        var ops = el("td"); ops.style.textDecoration = "none"; ops.style.whiteSpace = "nowrap";
        var edit = el("button", "変更", "plain"); edit.type = "button";
        edit.addEventListener("click", function () { fillForm(rec, { existing: true }); });
        ops.appendChild(edit);
        if (rec.status === "booked") {
          var cancel = el("button", "取消", "plain"); cancel.type = "button"; cancel.style.marginLeft = "4px";
          // 誤タップ防止の二度押し。confirmダイアログは使わない。
          cancel.addEventListener("click", function () {
            if (cancel.dataset.armed !== "1") {
              cancel.dataset.armed = "1"; cancel.textContent = "もう一度押すと取消";
              return setTimeout(function () { cancel.dataset.armed = ""; cancel.textContent = "取消"; }, 4000);
            }
            return api("DELETE", API + "/" + encodeURIComponent(rec.rid)).then(function (r) {
              if (r.status !== 200) return setMsg($("listMsg"), errorText(r), "err");
              return loadList();
            }).catch(function () { setMsg($("listMsg"), "サーバーに接続できません", "err"); });
          });
          ops.appendChild(cancel);
        }
        tr.appendChild(ops);
        body.appendChild(tr);
      });
    }).catch(function () { setMsg($("listMsg"), "サーバーに接続できません", "err"); });
  }

  /* ---------- B. CSV取込 ---------- */
  var FIELD_LABEL = { rid: "予約ID", datetime: "来店日時", date: "来店日", time: "来店時間", name: "名前", adults: "大人", seniors: "シニア", children: "子供", kids: "幼児", pax: "人数", menu: "メニュー", allergies: "アレルギー", request: "要望", memo: "メモ", table: "卓番", status: "状態" };
  var csvGeneration = 0;
  var confirmedCsvFile = null;
  function isCurrentCsv(generation, file) {
    return generation === csvGeneration && $("csvFile").files[0] === file;
  }
  function renderCsv(body) {
    var box = $("csvPreview");
    box.textContent = "";
    var mapping = Object.keys(body.columns || {}).map(function (field) { return (FIELD_LABEL[field] || field) + " ← 「" + body.columns[field] + "」"; });
    if (mapping.length) box.appendChild(el("p", "読み取った列: " + mapping.join("、"), "small"));
    if (body.unmapped && body.unmapped.length) box.appendChild(el("p", "使わない列: " + body.unmapped.join("、"), "small"));
    if (!body.rows) return;
    var table = el("table"), tbody = el("tbody");
    var head = el("tr");
    ["行", "来店日時", "名前", "人数", "メニュー・注記", "結果"].forEach(function (h) { head.appendChild(el("th", h)); });
    table.appendChild(head);
    body.rows.forEach(function (row) {
      var rec = row.reservation || {};
      var tr = el("tr", null, row.ok ? "" : "bad");
      var when = rec.startAt && !isNaN(Date.parse(rec.startAt)) ? dateStr(new Date(rec.startAt)) + " " + timeStr(new Date(rec.startAt)) : "—";
      tr.appendChild(el("td", String(row.line)));
      tr.appendChild(el("td", when));
      tr.appendChild(el("td", rec.name || "(名前なし)"));
      tr.appendChild(el("td", peopleText(rec)));
      tr.appendChild(el("td", summary(rec)));
      tr.appendChild(el("td", row.ok ? (rec.status === "canceled" ? "取消として取込" : "OK") : row.errors.join(" / ")));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    box.appendChild(table);
  }
  function sendCsv(dryRun) {
    var file = $("csvFile").files[0];
    if (!file || (!dryRun && confirmedCsvFile !== file)) return;
    var generation = ++csvGeneration;
    confirmedCsvFile = null;
    $("csvCheck").disabled = $("csvImport").disabled = true;
    // CSV/Excelの判別はサーバーが内容から行う。Content-Typeは目安のみ。
    return api("POST", API + "/import/csv" + (dryRun ? "?dryRun=1" : ""), file, { "Content-Type": file.type || "application/octet-stream" }).then(function (result) {
      // 本取込は送信後に選択を変えても保存されるため、成功時の一覧更新は必ず行う。
      if (!dryRun && result.status === 200) loadList();
      // 確認待ちの間に別ファイルへ変わった場合、古いプレビューで取込を許可しない。
      if (!isCurrentCsv(generation, file)) return;
      var body = result.body || {};
      if (result.status !== 200) { setMsg($("csvMsg"), errorText(result), "err"); renderCsv(body); return; }
      renderCsv(body);
      if (dryRun) {
        confirmedCsvFile = body.valid ? file : null;
        setMsg($("csvMsg"), "取り込める予約: " + body.valid + "件" + (body.failed ? " / 取り込めない行: " + body.failed + "件" : "") +
          "\n内容を確かめてから「取り込む」を押してください。", body.failed ? "warn" : "ok");
        $("csvImport").disabled = !body.valid;
        $("csvImport").textContent = body.valid ? body.valid + "件を取り込む" : "取り込む";
      } else {
        setMsg($("csvMsg"), body.saved + "件を取り込みました" + (body.failed ? " (取り込めなかった行: " + body.failed + "件)" : ""), body.failed ? "warn" : "ok");
      }
    }).catch(function () {
      if (isCurrentCsv(generation, file)) setMsg($("csvMsg"), "サーバーに接続できません", "err");
    }).then(function () {
      if (isCurrentCsv(generation, file)) $("csvCheck").disabled = !$("csvFile").files[0];
    });
  }
  function resetCsv() {
    csvGeneration++;
    confirmedCsvFile = null;
    $("csvCheck").disabled = !$("csvFile").files[0];
    $("csvImport").disabled = true; $("csvImport").textContent = "取り込む";
    $("csvPreview").textContent = ""; setMsg($("csvMsg"), "");
  }

  /* ---------- C. 貼り付け ---------- */
  function parsePaste() {
    var text = $("pasteText").value;
    if (!text.trim()) return setMsg($("pasteMsg"), "予約詳細を貼り付けてください", "err");
    return api("POST", API + "/import/text", { text: text }).then(function (result) {
      if (result.status !== 200) return setMsg($("pasteMsg"), errorText(result), "err");
      setMsg($("pasteMsg"), "");
      fillForm(result.body.draft, { warnings: ["貼り付けから読み取りました。内容を確かめてから登録してください。"].concat(result.body.warnings) });
    }).catch(function () { setMsg($("pasteMsg"), "サーバーに接続できません", "err"); });
  }

  /* ---------- D. メール ---------- */
  function loadInbox() {
    return api("GET", API + "/inbox").then(function (result) {
      var box = $("inboxList");
      box.textContent = "";
      if (result.status !== 200) { $("inboxHint").textContent = errorText(result); return; }
      if (!result.body.enabled) { $("inboxHint").textContent = "取込フォルダは無効です。下の欄からメールを1通ずつ読み取れます。"; return; }
      var items = result.body.items;
      $("inboxHint").textContent = items.length
        ? "取込フォルダに " + items.length + " 通あります。内容を確かめて登録するか、不要なら片づけてください。"
        : "取込フォルダ(data/mail-inbox)に予約メール(.eml / .txt)を保存すると、ここに並びます。いまは空です。";
      items.forEach(function (item) {
        var card = el("div", null, "card");
        card.appendChild(el("h3", item.subject || item.id));
        card.appendChild(el("div", "受信: " + new Date(item.receivedAt).toLocaleString("ja-JP") + " / " + item.id, "small"));
        if (item.error) { card.appendChild(el("div", item.error, "msg err")); }
        else {
          var d = item.draft;
          var when = d.startAt ? dateStr(new Date(d.startAt)) + " " + timeStr(new Date(d.startAt)) : "(日時不明)";
          card.appendChild(el("div", (d.status === "canceled" ? "【取消】" : "") + when + " / " + (d.name || "(名前不明)") +
            " / " + peopleText(d) + " / " + summary(d)));
          if (item.warnings.length) card.appendChild(el("div", item.warnings.join("\n"), "msg warn"));
        }
        var actions = el("div", null, "actions"); actions.style.marginTop = "8px";
        if (!item.error) {
          var use = el("button", "フォームに入れる", "primary"); use.type = "button";
          use.addEventListener("click", function () {
            fillForm(item.draft, { mailId: item.id, warnings: ["メールから読み取りました。内容を確かめてから登録してください。"].concat(item.warnings) });
          });
          actions.appendChild(use);
        }
        var dismiss = el("button", "登録せず片づける", "plain"); dismiss.type = "button";
        dismiss.addEventListener("click", function () { api("DELETE", API + "/inbox/" + encodeURIComponent(item.id)).then(loadInbox); });
        actions.appendChild(dismiss);
        card.appendChild(actions);
        box.appendChild(card);
      });
    }).catch(function () { $("inboxHint").textContent = "サーバーに接続できません"; });
  }
  function parseMail() {
    var file = $("mailFile").files[0];
    var text = $("mailText").value;
    if (!file && !text.trim()) return setMsg($("mailMsg"), "メールを選ぶか、本文を貼り付けてください", "err");
    var request = file
      ? api("POST", API + "/import/mail", file, { "Content-Type": "message/rfc822" })
      : api("POST", API + "/import/mail?text=1", text, { "Content-Type": "text/plain; charset=utf-8" });
    return request.then(function (result) {
      if (result.status !== 200) return setMsg($("mailMsg"), errorText(result), "err");
      setMsg($("mailMsg"), "");
      fillForm(result.body.draft, { warnings: ["メールから読み取りました。内容を確かめてから登録してください。"].concat(result.body.warnings) });
    }).catch(function () { setMsg($("mailMsg"), "サーバーに接続できません", "err"); });
  }

  /* ---------- イベント配線・起動 ---------- */
  tabs.forEach(function (t) { t.addEventListener("click", function () { showTab(t.dataset.tab); }); });
  $("form").addEventListener("submit", submitForm);
  $("formReset").addEventListener("click", function () { resetForm(); setMsg($("formMsg"), ""); });
  $("menuAdd").addEventListener("click", function () { addMenuRow(); });
  ["fAdults", "fSeniors", "fChildren", "fKids"].forEach(function (id) { $(id).addEventListener("input", updateTotal); });
  $("listDate").addEventListener("change", loadList);
  $("listReload").addEventListener("click", loadList);
  $("listToday").addEventListener("click", function () { $("listDate").value = dateStr(now()); loadList(); });
  $("csvFile").addEventListener("change", resetCsv);
  $("csvCheck").addEventListener("click", function () { return sendCsv(true); });
  $("csvImport").addEventListener("click", function () { return sendCsv(false); });
  $("pasteParse").addEventListener("click", parsePaste);
  $("inboxReload").addEventListener("click", loadInbox);
  $("mailParse").addEventListener("click", parseMail);
  $("listDate").value = dateStr(now());
  resetForm();
  loadList();

  return { fillForm: fillForm, readForm: readForm, resetForm: resetForm, loadList: loadList, showTab: showTab };
});
