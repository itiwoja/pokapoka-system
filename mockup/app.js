const HOLD_DURATION_MS = 800;

const orders = [
  {
    id: "001",
    tableNumber: "A-1",
    items: [
      { id: "1", name: "\u725b\u30bf\u30f3", quantity: 2 },
      { id: "2", name: "\u30ab\u30eb\u30d3", quantity: 1 },
      { id: "3", name: "\u30cf\u30e9\u30df", quantity: 3 },
    ],
    timestamp: minutesAgo(3),
    customerName: "\u7530\u4e2d\u69d8",
    adultCount: 2,
    childCount: 1,
  },
  {
    id: "002",
    tableNumber: "B-3",
    items: [
      { id: "4", name: "\u30ed\u30fc\u30b9", quantity: 2 },
      { id: "5", name: "\u30e9\u30a4\u30b9", quantity: 2 },
    ],
    timestamp: minutesAgo(7),
    customerName: "\u4f50\u85e4\u69d8",
    adultCount: 2,
    childCount: 0,
  },
  {
    id: "003",
    tableNumber: "C-5",
    items: [
      { id: "6", name: "\u76db\u308a\u5408\u308f\u305b", quantity: 1 },
      { id: "7", name: "\u30d3\u30fc\u30eb", quantity: 2 },
      { id: "8", name: "\u30ad\u30e0\u30c1", quantity: 1 },
    ],
    timestamp: minutesAgo(12),
    customerName: "\u9234\u6728\u69d8",
    adultCount: 3,
    childCount: 0,
  },
];

const reservations = [
  {
    id: "R001",
    tableNumber: "\u4e88\u7d04",
    items: [
      { id: "11", name: "\u30ab\u30eb\u30d3", quantity: 2 },
      { id: "12", name: "\u30ed\u30fc\u30b9", quantity: 1 },
      { id: "13", name: "\u30e9\u30a4\u30b9", quantity: 2 },
    ],
    reserveTime: minutesFromNow(30),
    customerName: "\u5c71\u7530\u69d8",
    adultCount: 4,
    childCount: 0,
  },
  {
    id: "R003",
    tableNumber: "\u4e88\u7d04",
    items: [
      { id: "14", name: "\u30bf\u30f3\u5869", quantity: 3 },
      { id: "15", name: "\u30cf\u30e9\u30df", quantity: 2 },
      { id: "16", name: "\u76db\u308a\u5408\u308f\u305b", quantity: 1 },
      { id: "17", name: "\u30d3\u30fc\u30eb", quantity: 4 },
    ],
    reserveTime: minutesFromNow(90),
    customerName: "\u4e2d\u6751\u69d8",
    adultCount: 4,
    childCount: 1,
  },
];

const state = {
  activeOrders: [...orders],
  reservations: [...reservations],
};

// ============================================================
// #29 提供時間ログ（注文受付→完了の自動計測）
//
// オーダーを「長押しで完了」した瞬間に、受付(timestamp)からの提供時間を
// localStorage(kds_serve_log) へ追記保存する。PRD KPI「平均提供時間20%減」の
// 導入前ベースライン兼、#31 日次レポート / #26 需要予測の前提データ。
// 計測ロジック本体は serve-log.js（純粋関数）に分離。
// ============================================================
const SERVE_LOG_KEY = "kds_serve_log";

function loadServeLog() {
  try {
    return JSON.parse(localStorage.getItem(SERVE_LOG_KEY) || "[]");
  } catch {
    return [];
  }
}
function saveServeLog(log) {
  try {
    localStorage.setItem(SERVE_LOG_KEY, JSON.stringify(log));
  } catch {
    /* localStorage 不可環境では保存をスキップ */
  }
}

let serveLog = loadServeLog();

/** この画面のオーダー形状を serve-log.js が扱う形へ正規化する */
function toServeOrder(order) {
  return {
    id: order.id,
    table: order.tableNumber,
    type: order.type || "new",
    people: (order.adultCount || 0) + (order.childCount || 0),
    start:
      order.timestamp instanceof Date
        ? order.timestamp.getTime()
        : Number(order.timestamp),
    items: (order.items || []).map((it) => ({ qty: it.quantity })),
  };
}

/** 完了したオーダーの提供時間を記録する */
function recordCompletion(order) {
  serveLog = serveLog.concat([
    ServeLog.buildServeRecord(toServeOrder(order), Date.now()),
  ]);
  saveServeLog(serveLog);
}

/** CSVをブラウザからダウンロードさせる（Excel向けBOM付与） */
function downloadServeLogCSV() {
  const csv = "﻿" + ServeLog.toCSV(serveLog);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "kds-serve-log.csv";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** トースト用の要約テキスト */
function serveLogSummaryText() {
  const s = ServeLog.computeServeStats(serveLog);
  if (s.count === 0) return "\u{1F4CA} 計測データはまだありません";
  return `\u{1F4CA} 提供時間 ${s.count}件 / 平均 ${ServeLog.formatDuration(
    s.avgServeMs,
  )}（CSV出力しました）`;
}

let toastTimer = 0;
/** 画面下部にトーストを表示する */
function showToast(message, duration = 3200) {
  const el = document.querySelector("#toast");
  if (!el) return;
  el.textContent = message;
  el.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove("show"), duration);
}

// 検証・バックアップ用アクセサ（コンソールから利用可能）
window.KDS_getServeLog = () => serveLog.slice();
window.KDS_getServeStats = () => ServeLog.computeServeStats(serveLog);
window.KDS_exportServeCSV = downloadServeLogCSV;
window.KDS_clearServeLog = () => {
  serveLog = [];
  saveServeLog(serveLog);
};

const clock = document.querySelector("#clock");
const ordersGrid = document.querySelector("#orders-grid");
const orderCount = document.querySelector("#order-count");
const ordersEmpty = document.querySelector("#orders-empty");
const reserveList = document.querySelector("#reserve-list");
const reserveEmpty = document.querySelector("#reserve-empty");

function minutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60 * 1000);
}

function minutesFromNow(minutes) {
  return new Date(Date.now() + minutes * 60 * 1000);
}

function formatTime(date, withSeconds = false) {
  const parts = [
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
  ];

  if (withSeconds) {
    parts.push(String(date.getSeconds()).padStart(2, "0"));
  }

  return parts.join(":");
}

function elapsedMinutes(timestamp) {
  return Math.max(0, Math.floor((Date.now() - timestamp.getTime()) / 60000));
}

function timeLevel(minutes) {
  if (minutes <= 5) return "time-ok";
  if (minutes <= 10) return "time-warn";
  return "time-alert";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function itemRows(items) {
  return items
    .map(
      (item) => `
        <div class="item-row">
          <span class="item-name">${escapeHtml(item.name)}</span>
          <span class="qty">x${item.quantity}</span>
        </div>
      `,
    )
    .join("");
}

function renderOrders() {
  orderCount.textContent = `${state.activeOrders.length}\u4ef6`;
  ordersEmpty.hidden = state.activeOrders.length > 0;

  ordersGrid.innerHTML = state.activeOrders
    .map((order) => {
      const elapsed = elapsedMinutes(order.timestamp);
      return `
        <article class="order-card">
          <div class="card-header">
            <div>
              <span class="table-number">${escapeHtml(order.tableNumber)}</span>
              <span class="received-time">\u53d7\u4ed8 ${formatTime(order.timestamp)}</span>
            </div>
            <span class="time-badge ${timeLevel(elapsed)}">${elapsed}\u5206</span>
          </div>
          <div class="divider"></div>
          <div class="items">${itemRows(order.items)}</div>
          <div class="divider"></div>
          <button class="hold-button" data-action="complete" data-id="${order.id}">
            <span class="fill"></span>
            <span class="label">\u9577\u62bc\u3057\u3067\u5b8c\u4e86</span>
          </button>
        </article>
      `;
    })
    .join("");

  bindHoldButtons();
}

function renderReservations() {
  reserveEmpty.hidden = state.reservations.length > 0;

  reserveList.innerHTML = state.reservations
    .map((reservation) => {
      const minutesUntil = Math.floor((reservation.reserveTime.getTime() - Date.now()) / 60000);
      const canActivate = minutesUntil <= 30 && minutesUntil >= 0;
      return `
        <article class="reserve-card">
          <span class="reserve-time">${formatTime(reservation.reserveTime)}</span>
          <div class="items">${itemRows(reservation.items)}</div>
          <div class="divider"></div>
          <button
            class="hold-button ${canActivate ? "reserve-ready" : ""}"
            data-action="activate"
            data-id="${reservation.id}"
            ${canActivate ? "" : "disabled"}
          >
            <span class="fill"></span>
            <span class="label">${canActivate ? "\u9577\u62bc\u3057\u3067\u7740\u706b\u3078\u79fb\u52d5" : "\u958b\u59cb\u6642\u9593\u524d"}</span>
          </button>
        </article>
      `;
    })
    .join("");

  bindHoldButtons();
}

function bindHoldButtons() {
  document.querySelectorAll(".hold-button:not([data-bound])").forEach((button) => {
    button.dataset.bound = "true";
    let frameId = 0;
    let timeoutId = 0;
    let startedAt = 0;

    const fill = button.querySelector(".fill");

    const reset = () => {
      window.cancelAnimationFrame(frameId);
      window.clearTimeout(timeoutId);
      startedAt = 0;
      fill.style.width = "0%";
    };

    const tick = () => {
      if (!startedAt) return;
      const progress = Math.min(((Date.now() - startedAt) / HOLD_DURATION_MS) * 100, 100);
      fill.style.width = `${progress}%`;
      frameId = window.requestAnimationFrame(tick);
    };

    const start = (event) => {
      if (button.disabled) return;
      event.preventDefault();
      reset();
      startedAt = Date.now();
      tick();
      timeoutId = window.setTimeout(() => {
        runAction(button.dataset.action, button.dataset.id);
        reset();
      }, HOLD_DURATION_MS);
    };

    button.addEventListener("pointerdown", start);
    button.addEventListener("pointerup", reset);
    button.addEventListener("pointerleave", reset);
    button.addEventListener("pointercancel", reset);
  });
}

function runAction(action, id) {
  if (action === "complete") {
    // #29: 完了時に提供時間を記録してから除去する
    const completed = state.activeOrders.find((order) => order.id === id);
    if (completed) recordCompletion(completed);
    state.activeOrders = state.activeOrders.filter((order) => order.id !== id);
  }

  if (action === "activate") {
    const reservation = state.reservations.find((item) => item.id === id);
    if (reservation) {
      state.activeOrders = [
        ...state.activeOrders,
        {
          ...reservation,
          id: String(state.activeOrders.length + 1).padStart(3, "0"),
          tableNumber: `A-${state.activeOrders.length + 1}`,
          timestamp: new Date(),
        },
      ];
      state.reservations = state.reservations.filter((item) => item.id !== id);
    }
  }

  render();
}

function updateClock() {
  const now = new Date();
  clock.textContent = formatTime(now, true);
  clock.dateTime = now.toISOString();
}

function render() {
  updateClock();
  renderOrders();
  renderReservations();
}

const logButton = document.querySelector("#log-export");
if (logButton) {
  logButton.addEventListener("click", () => {
    showToast(serveLogSummaryText());
    if (serveLog.length > 0) downloadServeLogCSV();
  });
}

render();
window.setInterval(render, 30 * 1000);
window.setInterval(updateClock, 1000);
