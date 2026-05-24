// ============================================================
// 多言語ラベル
// ============================================================
const I18N = {
  ja: {
    new: '新規', reserved: '予約',
    people: '名', received: '受付',
    elapsed: '経過', done: '完了',
    allDone: '✓ 完了',
    noOrders: 'オーダーなし',
    minUnit: '分',
  },
  ne: {
    new: 'नयाँ', reserved: 'आरक्षण',
    people: 'जना', received: 'प्राप्त',
    elapsed: 'बितेको', done: 'पूर्ण',
    allDone: '✓ पूर्ण',
    noOrders: 'अर्डर छैन',
    minUnit: 'मि',
  },
  zh: {
    new: '新訂', reserved: '預約',
    people: '人', received: '接單',
    elapsed: '經過', done: '完成',
    allDone: '✓ 完成',
    noOrders: '目前無訂單',
    minUnit: '分',
  },
};

// ============================================================
// 言語初期化
// ============================================================
let currentLang = localStorage.getItem('kds_lang') || 'ja';

function applyLangButtons() {
  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.lang === currentLang);
  });
}

document.querySelectorAll('.lang-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    currentLang = btn.dataset.lang;
    localStorage.setItem('kds_lang', currentLang);
    applyLangButtons();
    renderCards();
  });
});

applyLangButtons();

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
      { name: '土鍋ご飯（白米）', qty: 2, options: '', done: false },
      { name: '豚角煮トッピング', qty: 1, options: '辛さ控えめ', done: false },
    ],
  },
  {
    id: 'ord-002', table: 'B1', type: 'reserved',
    start: _now - 7 * _min, people: 4,
    items: [
      { name: '土鍋ご飯（白米）', qty: 3, options: '', done: false },
      { name: '土鍋ご飯（玄米）', qty: 1, options: '', done: false },
      { name: 'サイドサラダ', qty: 4, options: 'ドレッシング別添え', done: false },
    ],
  },
  {
    id: 'ord-003', table: 'C2', type: 'new',
    start: _now - 12 * _min, people: 3,
    items: [
      { name: '土鍋ご飯（白米）', qty: 3, options: '', done: false },
      { name: '唐揚げ', qty: 2, options: '', done: false },
    ],
  },
  {
    id: 'ord-004', table: 'A1', type: 'new',
    start: _now - 0.5 * _min, people: 1,
    items: [
      { name: 'ランチセット', qty: 1, options: '卵焼き追加', done: false },
    ],
  },
  {
    id: 'ord-005', table: 'D4', type: 'reserved',
    start: _now - 5 * _min, people: 2,
    items: [
      { name: '土鍋ご飯（白米）', qty: 2, options: '', done: false },
      { name: 'ウーロン茶', qty: 2, options: '', done: false },
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
function renderCards() {
  const L = I18N[currentLang];
  const grid = document.getElementById('card-grid');
  const orders = window.KDS_ORDERS || [];

  const activeCount = orders.filter(o =>
    o.items.some((_, i) => !getItemDone(o.id, i))
  ).length;
  document.getElementById('active-count').textContent = activeCount;

  if (orders.length === 0) {
    grid.innerHTML = '<div class="empty-state">' + L.noOrders + '</div>';
    return;
  }

  grid.innerHTML = orders.map(order => {
    const mins    = elapsedMinutes(order.start);
    const tc      = timerClass(mins);
    const allDone = order.items.every((_, i) => getItemDone(order.id, i));
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
      (isRsv ? ' card--reserved' : '') +
      (allDone ? ' card--done' : '') + '">' +
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

  // タップ／クリックイベント
  grid.querySelectorAll('.item').forEach(el => {
    el.addEventListener('click', () => {
      toggleItemDone(el.dataset.order, parseInt(el.dataset.idx, 10));
      renderCards();
    });
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); }
    });
  });
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
setInterval(renderCards, 1000); // 1秒ポーリング（timer更新 & KDS_ORDERS監視）
