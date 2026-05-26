// ============================================================
// バイブレーション API
// ============================================================

/** バイブレーションが使えるかどうか */
const canVibrate = typeof navigator.vibrate === 'function';

/**
 * バイブレーションを実行する。
 * 非対応端末では何もしない。
 * @param {number | number[]} pattern - ミリ秒または on/off パターン配列
 */
function vibrate(pattern) {
  if (canVibrate) {
    navigator.vibrate(pattern);
  }
}

// バイブレーションパターン定義
const VIB = {
  tap:        15,                      // 押した瞬間の押下感（極短）
  itemDone:   [30, 20, 60],            // 品目完了（短+長でON感）
  itemUndone: [60, 20, 30],            // 完了取消（長+短でOFF感）
  allDone:    [60, 40, 60, 40, 120],   // 全品目完了（トリプル＋長め）
  dangerAlert:[80, 50, 80, 50, 200],   // 10分超え警告
  test:       [100, 50, 100, 50, 200], // バイブテストボタン
};

// ============================================================
// トースト通知
// ============================================================
let toastTimer = null;

/**
 * 画面下部にトースト通知を表示する。
 * @param {string} msg
 * @param {number} [duration=2000]
 */
function showToast(msg, duration = 2000) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

// ============================================================
// 多言語ラベル
// ============================================================
const I18N = {
  ja: {
    new: '新規', reserved: '予約',
    people: '名', received: '受付',
    allDone: '✓ 完了',
    noOrders: 'オーダーなし',
    minUnit: '分',
    vibNotSupported: '⚠️ このブラウザはバイブレーション非対応',
    vibTest: '📳 バイブレーション動作中…',
  },
  ne: {
    new: 'नयाँ', reserved: 'आरक्षण',
    people: 'जना', received: 'प्राप्त',
    allDone: '✓ पूर्ण',
    noOrders: 'अर्डर छैन',
    minUnit: 'मि',
    vibNotSupported: '⚠️ यो ब्राउजरमा भाइब्रेसन समर्थित छैन',
    vibTest: '📳 भाइब्रेसन चलिरहेको छ…',
  },
  zh: {
    new: '新訂', reserved: '預約',
    people: '人', received: '接單',
    allDone: '✓ 完成',
    noOrders: '目前無訂單',
    minUnit: '分',
    vibNotSupported: '⚠️ 此瀏覽器不支援震動功能',
    vibTest: '📳 震動中…',
  },
};

// ============================================================
// 言語
// ============================================================
let currentLang = localStorage.getItem('kds_lang') || 'ja';

function applyLangButtons() {
  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.lang === currentLang);
  });
}

document.querySelectorAll('.lang-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    vibrate(VIB.tap);
    currentLang = btn.dataset.lang;
    localStorage.setItem('kds_lang', currentLang);
    applyLangButtons();
    renderCards();
  });
});

applyLangButtons();

// ============================================================
// バイブテストボタン
// ============================================================
document.getElementById('vib-test').addEventListener('click', () => {
  const L = I18N[currentLang];
  if (!canVibrate) {
    showToast(L.vibNotSupported, 3000);
    return;
  }
  vibrate(VIB.test);
  showToast(L.vibTest);
});

// ============================================================
// モックデータ
// ============================================================
const _now = Date.now();
const _min = 60_000;

window.KDS_ORDERS = [
  {
    id: 'ord-001', table: 'A3', type: 'new',
    start: _now - 2 * _min, people: 2,
    items: [
      { name: '土鍋ご飯（白米）', qty: 2, options: '' },
      { name: '豚角煮トッピング', qty: 1, options: '辛さ控えめ' },
    ],
  },
  {
    id: 'ord-002', table: 'B1', type: 'reserved',
    start: _now - 7 * _min, people: 4,
    items: [
      { name: '土鍋ご飯（白米）', qty: 3, options: '' },
      { name: '土鍋ご飯（玄米）', qty: 1, options: '' },
      { name: 'サイドサラダ',     qty: 4, options: 'ドレッシング別添え' },
    ],
  },
  {
    id: 'ord-003', table: 'C2', type: 'new',
    start: _now - 12 * _min, people: 3,
    items: [
      { name: '土鍋ご飯（白米）', qty: 3, options: '' },
      { name: '唐揚げ',           qty: 2, options: '' },
    ],
  },
  {
    id: 'ord-004', table: 'A1', type: 'new',
    start: _now - 0.5 * _min, people: 1,
    items: [
      { name: 'ランチセット', qty: 1, options: '卵焼き追加' },
    ],
  },
  {
    id: 'ord-005', table: 'D4', type: 'reserved',
    start: _now - 5 * _min, people: 2,
    items: [
      { name: '土鍋ご飯（白米）', qty: 2, options: '' },
      { name: 'ウーロン茶',       qty: 2, options: '' },
    ],
  },
];

// ============================================================
// 状態管理（LocalStorage）
// ============================================================
function loadDoneState() {
  try { return JSON.parse(localStorage.getItem('kds_done') || '{}'); }
  catch { return {}; }
}
function saveDoneState(state) {
  localStorage.setItem('kds_done', JSON.stringify(state));
}

let doneState = loadDoneState();

function getItemDone(orderId, itemIdx) {
  return doneState[orderId + '_' + itemIdx] ?? false;
}

function toggleItemDone(orderId, itemIdx) {
  const key = orderId + '_' + itemIdx;
  doneState[key] = !doneState[key];
  saveDoneState(doneState);
}

function isOrderAllDone(order) {
  return order.items.every((_, i) => getItemDone(order.id, i));
}

// ============================================================
// 時間ユーティリティ
// ============================================================
function elapsedMinutes(startMs) {
  return Math.floor((Date.now() - startMs) / 60_000);
}
function timerClass(mins) {
  if (mins < 5)  return 'ok';
  if (mins < 10) return 'warn';
  return 'danger';
}
function fmtTime(ms) {
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

// ============================================================
// レンダリング
// ============================================================

/** danger に変わった瞬間だけ一回バイブするためのセット */
const alreadyWarnedDanger = new Set();

/**
 * ユーザーが一度でもタップしたか
 * Chrome は最初のユーザー操作前に navigator.vibrate をブロックする
 */
let userHasInteracted = false;
document.addEventListener('pointerdown', () => { userHasInteracted = true; }, { once: true });

function renderCards() {
  const L      = I18N[currentLang];
  const grid   = document.getElementById('card-grid');
  const orders = window.KDS_ORDERS || [];

  // 対応中カウント更新
  const activeCount = orders.filter(o => !isOrderAllDone(o)).length;
  document.getElementById('active-count').textContent = activeCount;

  if (orders.length === 0) {
    grid.innerHTML = '<div class="empty-state">' + L.noOrders + '</div>';
    return;
  }

  // danger 閾値到達の検知（未完了オーダーのみ・1回だけバイブ）
  // ユーザーが一度タップするまではバイブしない（Chrome の制限に対応）
  if (userHasInteracted) {
    orders.forEach(order => {
      if (isOrderAllDone(order)) return;
      const mins = elapsedMinutes(order.start);
      if (mins >= 10 && !alreadyWarnedDanger.has(order.id)) {
        alreadyWarnedDanger.add(order.id);
        vibrate(VIB.dangerAlert);
      }
    });
  }

  grid.innerHTML = orders.map(order => {
    const mins    = elapsedMinutes(order.start);
    const tc      = timerClass(mins);
    const allDone = isOrderAllDone(order);
    const isRsv   = order.type === 'reserved';

    const itemsHtml = order.items.map((item, idx) => {
      const done    = getItemDone(order.id, idx);
      const optHtml = item.options
        ? '<div class="item__option">' + item.options + '</div>'
        : '';
      return (
        '<div class="item' + (done ? ' item--done' : '') + '"' +
        ' data-order="' + order.id + '" data-idx="' + idx + '"' +
        ' role="button" tabindex="0" aria-pressed="' + done + '">' +
        '<div class="item__row">' +
        '<span class="item__name">' + item.name + '</span>' +
        '<span class="item__qty">× ' + item.qty + '</span>' +
        '</div>' +
        optHtml +
        '</div>'
      );
    }).join('');

    return (
      '<div class="card' +
      (isRsv   ? ' card--reserved' : '') +
      (allDone ? ' card--done'     : '') + '">' +
      '<div class="card__head">' +
      '<div class="card__head-row1">' +
      '<span class="card__badge">' + (isRsv ? L.reserved : L.new) + '</span>' +
      '<span class="card__table">' + order.table + '</span>' +
      '<span class="card__people">' + order.people + L.people + '</span>' +
      '</div>' +
      '<div class="card__head-row2">' +
      '<span class="card__time">' + L.received + ' ' + fmtTime(order.start) + '</span>' +
      '<span class="card__timer card__timer--' + tc + '">⏱ ' + mins + L.minUnit + '</span>' +
      '</div>' +
      '</div>' +
      '<div class="card__items">' + itemsHtml + '</div>' +
      '<div class="card__done-label">' + L.allDone + '</div>' +
      '</div>'
    );
  }).join('');

  // タップ / クリックイベント
  grid.querySelectorAll('.item').forEach(el => {
    let touchMoved = false;

    el.addEventListener('touchstart', () => {
      touchMoved = false;
      vibrate(VIB.tap); // 押した瞬間に即バイブ（押下感）
    }, { passive: true });
    el.addEventListener('touchmove',  () => { touchMoved = true;  }, { passive: true });
    el.addEventListener('touchend', e => {
      if (touchMoved) return; // スクロール中は無視
      e.preventDefault();
      handleItemTap(el);
    });

    el.addEventListener('click', () => handleItemTap(el));
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleItemTap(el); }
    });
  });
}

/**
 * 品目タップ時の処理（バイブ + 状態トグル）
 * @param {HTMLElement} el
 */
function handleItemTap(el) {
  const orderId  = el.dataset.order;
  const itemIdx  = parseInt(el.dataset.idx, 10);
  const willDone = !getItemDone(orderId, itemIdx);

  toggleItemDone(orderId, itemIdx);

  // 全品目完了になった瞬間は特別なバイブ
  const order = (window.KDS_ORDERS || []).find(o => o.id === orderId);
  if (willDone && order && isOrderAllDone(order)) {
    vibrate(VIB.allDone);
  } else {
    vibrate(willDone ? VIB.itemDone : VIB.itemUndone);
  }

  renderCards();
}

// ============================================================
// 時計
// ============================================================
function updateClock() {
  const d = new Date();
  document.getElementById('clock').textContent =
    String(d.getHours()).padStart(2, '0') + ':' +
    String(d.getMinutes()).padStart(2, '0') + ':' +
    String(d.getSeconds()).padStart(2, '0');
}

// ============================================================
// 起動
// ============================================================
updateClock();
renderCards();
setInterval(updateClock, 1000);
setInterval(renderCards, 1000); // 1秒ポーリング（タイマー更新 & danger 検知）
