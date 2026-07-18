const HOLD_DURATION_MS = 800;
const logic = window.PokapokaLogic;
const ALERT_SOUND_STORAGE_KEY = "pokapoka-alert-sound";

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
  {
    id: "004",
    tableNumber: "D-2",
    items: [
      { id: "9", name: "\u725b\u30bf\u30f3", quantity: 1 },
      { id: "10", name: "\u30bf\u30f3\u5869", quantity: 2 },
      { id: "18", name: "\u30e9\u30a4\u30b9", quantity: 2 },
    ],
    timestamp: minutesAgo(1),
    customerName: "\u9ad8\u6a4b\u69d8",
    adultCount: 2,
    childCount: 2,
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
  {
    id: "R004",
    tableNumber: "\u4e88\u7d04",
    items: [
      { id: "19", name: "\u30ab\u30eb\u30d3", quantity: 1 },
      { id: "20", name: "\u30ed\u30fc\u30b9", quantity: 2 },
    ],
    reserveTime: minutesFromNow(15),
    customerName: "\u5409\u7530\u69d8",
    adultCount: 2,
    childCount: 0,
  },
  {
    id: "R005",
    tableNumber: "\u4e88\u7d04",
    items: [
      { id: "21", name: "\u725b\u30bf\u30f3", quantity: 2 },
      { id: "22", name: "\u30ad\u30e0\u30c1", quantity: 1 },
      { id: "23", name: "\u30e9\u30a4\u30b9", quantity: 3 },
    ],
    reserveTime: minutesFromNow(45),
    customerName: "\u5c0f\u6797\u69d8",
    adultCount: 3,
    childCount: 1,
  },
  {
    id: "R006",
    tableNumber: "\u4e88\u7d04",
    items: [
      { id: "24", name: "\u76db\u308a\u5408\u308f\u305b", quantity: 2 },
      { id: "25", name: "\u30d3\u30fc\u30eb", quantity: 3 },
      { id: "26", name: "\u30cf\u30e9\u30df", quantity: 2 },
    ],
    reserveTime: minutesFromNow(120),
    customerName: "\u6e21\u8fba\u69d8",
    adultCount: 5,
    childCount: 0,
  },
];

const state = {
  activeOrders: [...orders],
  reservations: [...reservations],
  completedOrders: [],
  alertedOrderIds: new Set(),
  tasteTimers: {},
  alertSoundEnabled: loadAlertSoundEnabled(),
};

const clock = document.querySelector("#clock");
const alertToggle = document.querySelector("#alert-toggle");
const ordersGrid = document.querySelector("#orders-grid");
const orderCount = document.querySelector("#order-count");
const ordersEmpty = document.querySelector("#orders-empty");
const reserveList = document.querySelector("#reserve-list");
const reserveEmpty = document.querySelector("#reserve-empty");
const completedCount = document.querySelector("#completed-count");
const averageDuration = document.querySelector("#average-duration");
let audioContext = null;

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
  return logic.elapsedMinutes(timestamp);
}

function timeLevel(minutes) {
  return logic.getTimeLevel(minutes);
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

function loadAlertSoundEnabled() {
  try {
    return window.localStorage.getItem(ALERT_SOUND_STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

function saveAlertSoundEnabled(enabled) {
  try {
    window.localStorage.setItem(ALERT_SOUND_STORAGE_KEY, enabled ? "on" : "off");
  } catch {
    // LocalStorage can be unavailable on some direct file previews.
  }
}

function formatCountdown(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainder = String(seconds % 60).padStart(2, "0");
  return `${minutes}:${remainder}`;
}

function renderTasteTimer(orderId) {
  const timer = state.tasteTimers[orderId];
  const remaining = logic.remainingTasteSeconds(timer);
  const isRunning = timer && remaining > 0;
  const isReady = timer && remaining === 0;
  const status = isReady
    ? "\u98df\u3079\u9803\u3067\u3059"
    : isRunning
      ? "\u84b8\u3089\u3057\u4e2d"
      : "\u63d0\u4f9b\u5f8c\u306b\u958b\u59cb";
  const buttonLabel = isRunning
    ? "\u30bf\u30a4\u30de\u30fc\u4e2d"
    : isReady
      ? "\u3082\u3046\u4e00\u5ea6\u958b\u59cb"
      : "2\u5206\u30bf\u30a4\u30de\u30fc";

  return `
    <div class="taste-timer${isReady ? " taste-ready" : ""}" data-taste-timer="${orderId}">
      <div>
        <span class="taste-label">${status}</span>
        <strong data-taste-countdown>${timer ? formatCountdown(remaining) : "--:--"}</strong>
      </div>
      <button
        class="timer-button"
        type="button"
        data-action="taste-timer"
        data-id="${orderId}"
        ${isRunning ? "disabled" : ""}
      >${buttonLabel}</button>
    </div>
  `;
}

function renderOrders() {
  orderCount.textContent = `${state.activeOrders.length}\u4ef6`;
  ordersEmpty.hidden = state.activeOrders.length > 0;

  ordersGrid.innerHTML = state.activeOrders
    .map((order) => {
      const elapsed = elapsedMinutes(order.timestamp);
      const timer = state.tasteTimers[order.id];
      const timerReady = timer && logic.remainingTasteSeconds(timer) === 0;
      return `
        <article class="order-card ${elapsed > 10 ? "overdue-card" : ""} ${timerReady ? "taste-ready-card" : ""}" data-id="${order.id}">
          <span class="drag-handle" aria-hidden="true">⋮⋮</span>
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
          ${renderTasteTimer(order.id)}
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
  bindTasteTimerButtons();
  bindOrderDrag();
  checkOverdueAlerts();
}

function renderReservations() {
  reserveEmpty.hidden = state.reservations.length > 0;

  reserveList.innerHTML = state.reservations
    .map((reservation) => {
      return `
        <article class="reserve-card">
          <span class="reserve-time">${formatTime(reservation.reserveTime)}</span>
          <div class="items">${itemRows(reservation.items)}</div>
          <div class="divider"></div>
          <button
            class="hold-button reserve-ready"
            data-action="activate"
            data-id="${reservation.id}"
          >
            <span class="fill"></span>
            <span class="label">\u9577\u62bc\u3057\u3067\u7740\u706b\u3078\u79fb\u52d5</span>
          </button>
        </article>
      `;
    })
    .join("");

  bindHoldButtons();
}

function bindTasteTimerButtons() {
  document.querySelectorAll(".timer-button:not([data-bound])").forEach((button) => {
    button.dataset.bound = "true";
    button.addEventListener("click", () => {
      state.tasteTimers = logic.startTasteTimer(state.tasteTimers, button.dataset.id, new Date());
      render();
    });
  });
}

function updateAlertToggle() {
  alertToggle.textContent = state.alertSoundEnabled ? "\u97f3 ON" : "\u97f3 OFF";
  alertToggle.setAttribute("aria-pressed", String(state.alertSoundEnabled));
}

function bindAlertToggle() {
  alertToggle.addEventListener("click", () => {
    state.alertSoundEnabled = !state.alertSoundEnabled;
    saveAlertSoundEnabled(state.alertSoundEnabled);
    updateAlertToggle();

    if (state.alertSoundEnabled) {
      playOverdueAlert();
    }
  });
}

function getAudioContext() {
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) return null;

  if (!audioContext) {
    audioContext = new AudioContextCtor();
  }

  return audioContext;
}

function playOverdueAlert() {
  if (!state.alertSoundEnabled) return;

  const context = getAudioContext();
  if (!context) return;

  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const startAt = context.currentTime;

  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(880, startAt);
  oscillator.frequency.setValueAtTime(660, startAt + 0.12);
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(0.18, startAt + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.28);

  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(startAt);
  oscillator.stop(startAt + 0.3);
}

function checkOverdueAlerts() {
  const alertableIds = logic.getAlertableOrderIds(
    state.activeOrders,
    new Date(),
    state.alertedOrderIds,
  );

  if (alertableIds.length === 0) return;

  state.alertedOrderIds = logic.markAlerted(state.alertedOrderIds, alertableIds);
  playOverdueAlert();
}

function renderSummary() {
  const metrics = logic.getSummaryMetrics(state.completedOrders);
  completedCount.textContent = `${metrics.completedCount}\u4ef6`;
  averageDuration.textContent = `${metrics.averageDurationMinutes}\u5206`;
}

function updateTasteTimerDisplays() {
  document.querySelectorAll("[data-taste-timer]").forEach((element) => {
    const orderId = element.dataset.tasteTimer;
    const timer = state.tasteTimers[orderId];
    const remaining = logic.remainingTasteSeconds(timer);
    const countdown = element.querySelector("[data-taste-countdown]");
    const label = element.querySelector(".taste-label");
    const button = element.querySelector(".timer-button");
    const card = element.closest(".order-card");

    if (!timer) return;

    countdown.textContent = formatCountdown(remaining);
    element.classList.toggle("taste-ready", remaining === 0);
    card.classList.toggle("taste-ready-card", remaining === 0);

    if (remaining === 0) {
      label.textContent = "\u98df\u3079\u9803\u3067\u3059";
      button.disabled = false;
      button.textContent = "\u3082\u3046\u4e00\u5ea6\u958b\u59cb";
      return;
    }

    label.textContent = "\u84b8\u3089\u3057\u4e2d";
    button.disabled = true;
    button.textContent = "\u30bf\u30a4\u30de\u30fc\u4e2d";
  });
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

const DRAG_THRESHOLD_PX = 6;

function moveOrder(fromId, toId) {
  if (fromId === toId) return;

  const fromIndex = state.activeOrders.findIndex((order) => order.id === fromId);
  const toIndex = state.activeOrders.findIndex((order) => order.id === toId);
  if (fromIndex === -1 || toIndex === -1) return;

  const next = [...state.activeOrders];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  state.activeOrders = next;

  render();
}

function bindOrderDrag() {
  document.querySelectorAll(".order-card:not([data-drag-bound])").forEach((card) => {
    card.dataset.dragBound = "true";
    const handle = card.querySelector(".drag-handle");
    if (!handle) return;

    let pointerId = null;
    let startX = 0;
    let startY = 0;
    let dragging = false;
    let currentTarget = null;

    const cardUnderPoint = (x, y) => {
      const element = document.elementFromPoint(x, y);
      return element ? element.closest(".order-card") : null;
    };

    const clearTarget = () => {
      if (currentTarget) currentTarget.classList.remove("drop-target");
      currentTarget = null;
    };

    const finish = () => {
      if (pointerId !== null) {
        try {
          handle.releasePointerCapture(pointerId);
        } catch {
          // capture may already be released
        }
      }
      card.classList.remove("dragging");
      clearTarget();
      pointerId = null;
      dragging = false;
    };

    handle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      pointerId = event.pointerId;
      startX = event.clientX;
      startY = event.clientY;
      dragging = false;
      handle.setPointerCapture(pointerId);
    });

    handle.addEventListener("pointermove", (event) => {
      if (pointerId === null) return;

      if (!dragging) {
        const moved = Math.hypot(event.clientX - startX, event.clientY - startY);
        if (moved < DRAG_THRESHOLD_PX) return;
        dragging = true;
        card.classList.add("dragging");
      }

      const target = cardUnderPoint(event.clientX, event.clientY);
      if (target !== currentTarget) {
        clearTarget();
        if (target && target !== card) {
          currentTarget = target;
          currentTarget.classList.add("drop-target");
        }
      }
    });

    handle.addEventListener("pointerup", (event) => {
      if (pointerId === null) return;

      if (dragging && currentTarget) {
        const toId = currentTarget.dataset.id;
        const fromId = card.dataset.id;
        finish();
        moveOrder(fromId, toId);
        return;
      }

      finish();
    });

    handle.addEventListener("pointercancel", finish);
  });
}

function runAction(action, id) {
  if (action === "complete") {
    const next = logic.completeOrder(state.activeOrders, state.completedOrders, id, new Date());
    const { [id]: removedTimer, ...nextTasteTimers } = state.tasteTimers;
    state.activeOrders = next.activeOrders;
    state.completedOrders = next.completedOrders;
    state.tasteTimers = nextTasteTimers;
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
  updateTasteTimerDisplays();
}

function render() {
  updateClock();
  renderOrders();
  renderReservations();
  renderSummary();
}

bindAlertToggle();
updateAlertToggle();
render();
window.setInterval(render, 30 * 1000);
window.setInterval(updateClock, 1000);
