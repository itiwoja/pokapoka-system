  "use strict";
  (function () {
    /* ========================================================================
       土鍋飯ぽかぽか KDS — バリエーションA: カードグリッド
       Vanilla JS ES2020 / 同梱アセットでオフライン動作
       データ契約 (注文入力画面が吐く形式):
         window.KDS_ORDERS = [{ id, table, type:"new"|"reserved",
           start, people, items:[{name, qty, options(無ければnull), allergies(無ければnull), done}] }]
       ======================================================================== */

    /* ---- 定数 ---- */
    var POLL_MS = 1000;            // window.KDS_ORDERS ポーリング間隔
    var TICK_MS = 1000;            // 経過時間 / 時計 更新間隔
    var FADE_MS = 300;             // 全完了カードのフェードアウト
    var LS_DONE = "kds_done_v2";   // 品目完了状態 (id -> [doneCount,...]) #153: 個数カウントダウン方式
    var LS_DONE_V1 = "kds_done_v1"; // 旧版 (id -> [bool,...])。初回のみ読み込み移行 (#153)
    var LS_KONRO = "kds_konro_v1"; // コンロ番号状態 (cardId -> { "1":"white", "3":"red", ... })
    var LS_ORDER = "kds_order_v1"; // 配膳カードの並び順 (orderId 配列)
    var LS_STOCK = "kds_stock_v1"; // 予約ストック (当日分のみ。永続DB無し)
    var LS_MODE  = "kds_mode_v1";  // 権限モード (kitchen / hall)
    var LS_LOCKED = "kds_locked_v1"; // タイマーロック状態
    var LS_SERVE  = "kds_serve_log_v1"; // #29 提供時間ログ (KPIベースライン)
    var LS_VIEW   = "kds_view_v1"; // #13 表示モード (grid / lane)
    var LS_DAY = "kds_day_v1";     // 最終利用日 (YYYY-MM-DD)。日付が変わったら当日データを破棄 (#63)
    var LS_DELETED = "kds_deleted_v1"; // 削除済み注文ID (POS再送で復活させないトゥームストーン #67)
    var LS_HALL_PROTO = "kds_hall_proto_v1"; // ホールA/B/C比較prototype (#155)
    var LS_RICE_CUE = "kds_rice_cue_v1"; // 米料理予約cue (rid -> state, 当日分)
    var LS_TABLE_OVERRIDE = "kds_table_override_v1"; // 厨房限定卓番上書き (order id -> table)
    var LS_HALL_READY = "kds_hall_ready_v1"; // 全品完了ホールcue (order id -> snapshot)
    var LS_SLIP_PRINTED = "kds_slip_printed_v1"; // 伝票を印刷した注文 (order id -> {day, at}) #224
    var LS_SERVE_CUE = "kds_serve_cue_v1"; // 前菜/デザートの提供cue (order id -> state, 当日分) #222
    // relay-server/kds-bridge.js が所有する取込済みrid記録。書くのは向こうだが、
    // 日次パージの対象に入れる必要があるためキー名だけここでも持つ (#172)
    var LS_BRIDGE_SEEN = "kds_bridge_seen_v1";
    var LS_PRINTER_IP = "kds_printer_ip_v1"; // チビ伝 実機プリンターIP (店舗LAN依存のため固定埋め込み不可 #144)
    var LS_SLIP_STYLE = "slip_style_designer_v1"; // チビ伝 印刷スタイル (slip-style-designer.html が書く。同一オリジン配信で共有)
    var BC_NAME = "kds_sync";      // BroadcastChannel 名
    var PRINTER_IP_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;   // オクテット範囲は isPrivateLanIPv4() で検査 (#176)
    // #59 仕様未決定の先行実装は既定OFF (フィーチャーフラグ)。会議決定が出たら true にして仕様追記。
    var FEATURE_TIMER_LOCK   = false; // タイマーロック (停/再) ボタン
    var FEATURE_DELETE_ORDER = false; // 注文削除 (×) ボタン
    var WARN_MIN = 5, ALERT_MIN = 10;
    var SOON_MIN = 30;             // 予約30分前通知
    var HALL_LAYOUTS = ["A", "B", "C"];
    var HALL_READY_UNDO_MS = 6000;

    var LONGPRESS_MS = 800;        // 並べ替え長押し (0.8〜2秒の下限)
    /* 伝票印刷の長押し。プレビューを挟まず直接紙が出るため、通常タップでは成立させない。
       並べ替え(0.8s)より長く、提供cueの取消より短い中間の重さ (#224) */
    var SLIP_PRINT_MS = 1200;
    /* 提供cueの取消だけは 2秒。提供実績を誤タップで消すと「出したのに出していない」
       ことになり、出し直しでロスが出るため、他の長押しより明確に長くする (#222) */
    var SERVE_REVERT_MS = 2000;
    var UNDO_TOAST_MS = 6000;      // 全完了カードの取り消し猶予
    var PRINT_TOAST_MS = 4000;     // チビ伝の印刷結果通知を出しておく時間 (#176)
    var DELETE_ARM_MS = 3000;      // 削除ボタン2段階確認の猶予 (#68)
    var ORDER_SOUND_EVENT = "kds:order-added";
    var KONRO_COUNT = 10;          // コンロ番号 1〜10
    /* コンロ状態サイクル: スケルトン(未使用) → 白(使用中) → 赤(タイマー管理中) → スケルトン */
    var KONRO_CYCLE = { "skeleton": "white", "white": "red", "red": "skeleton" };
    var KONRO_DEFAULT = "skeleton";

    /* ---- ラベル (日本語固定) ---- */
    var LABELS = {
      new:"新規", reserved:"予約", people:"名", recv:"受付", elapsed:"経過", done:"完了",
      min:"分", emptyTitle:"オーダー待機中", emptyHint:"POS からの注文がここに表示されます",
      demo:"デモデータを投入",
      konro:"コンロ", konroSkeleton:"未使用", konroWhite:"使用中", konroRed:"タイマー管理中",
      konroLocked:"他卓使用中",
      konroHudKonro:"コンロ", konroHudTimer:"タイマー",   // HUD の列見出し (#145)
      modeKitchen:"キッチン", modeHall:"ホール",
      stockTitle:"予約ストック", stockEmpty:"本日の予約はありません",
      addReservation:"予約を追加", fldTime:"予約時間", fldAdults:"大人", fldKids:"0-2歳",
      fldName:"名前", fldMenu:"メニュー（個数）", cancel:"キャンセル", save:"登録",
      print:"印刷", close:"閉じる", soon:"まもなく", seatPh:"卓番", go:"調理開始", del:"削除",
      reorderMsg:"並べ替え中（離して確定 / 取消で戻す）", undo:"取消", reorderDone:"確定",
      reorderCommitted:"並べ替えを確定しました", restore:"戻す",
      errTime:"予約時間を入力してください", errMenu:"メニューを1つ以上選択してください",
      errSeat:"卓番を入力してください", slipMeta:"受付"
    };
    /* 予約フォームのメニュー候補 (POS未接続のため静的。略称表示) */
    var MENU_OPTIONS = [
      // 土鍋御膳（ご飯類）
      "山城牛の焼きすき土鍋御膳", "山城牛の肉たく土鍋御膳", "山城牛のカニクラ土鍋御膳",
      "山城牛と海老天つゆしゃぶ土鍋御膳", "島黒ヒレカツ出汁とろろ土鍋御膳",
      "マース煮アーサバター土鍋御膳", "うなぎ土鍋御膳", "今月のスポット土鍋御膳",
      // 単品（サイド）
      "島黒西京焼き", "海老天ぷら", "焼きすきセット", "山城牛のとろ煮",
      // ご飯単品
      "卵かけご飯セット", "白米1合", "出汁米1合",
      // ドリンク
      "オリオンビール（小瓶）", "ハイボール（角）", "レモンサワー", "ウーロンハイ",
      "ウーロン茶", "オレンジ", "コーラ", "サイダー"
    ];
    /* ---- 状態 ---- */
    var doneMap = {};              // { orderId: [doneCount, ...] }  完了個数(LocalStorage正本 #153)
    var konroMap = {};             // { cardId: { "1":"white", "3":"red", ... } } コンロ状態(LocalStorage正本)
    var cards = {};                // { orderId: { el, order, level } } DOM キャッシュ
    var orderSeq = [];             // 配膳カードの表示順 (orderId 文字列の配列。LS正本)
    var stock = [];                // 予約ストック (当日分。LS正本) [{rid,time,adults,kids,name,menu:[{name,qty}],seenAt}]
    var seatDrafts = {};            // { rid: "A3" } 卓番ダイヤルの下書き (再描画をまたいで保持・非LS・タブ限定 #118)
    var seatDialRid = null;         // 卓番ダイヤルモーダルが編集中の予約rid (null=非表示)
    var seatDialBuf = "";           // 卓番ダイヤルで入力中の値 (「A1」形式 = ゾーン英字+番号)
    var SEAT_MAX_LEN = 6;           // 旧 res-seat の maxLength を踏襲
    var seatDialReplaceNext = false; // 卓番上書き: 次の数字キーで今の卓番を置き換える (追記しない #295)
    var mode = "kitchen";          // 権限モード
    var view = "grid";             // #13 表示モード (grid / lane)
    var lockedTimers = {};         // タイマーロック状態 { orderId: true }
    var deletedIds = {};           // 削除済み注文ID { orderId: true } (LS正本 #67)
    var riceCueMap = {};           // { rid: { status:"active"|"acknowledged", day } }
    var tableOverrideMap = {};      // { orderId: "卓番" }。公開orderは決して変更しない
    var hallReadyMap = {};         // { orderId: { orderId, table, people, completedAt, items, status, day } }
    /* ホール比較prototype (#155 phase1) の有効フラグ。
       false の間はA/B/Cスイッチも試作ビューも出さず、ホールは a818051 マージ前と同じ
       「グリッドを表示したまま操作だけ止めた読取専用」に戻る。試作を再開するときは
       true にするだけでよい（HTML・CSS・JSの構造はそのまま残してある）。 */
    var HALL_PROTO_ENABLED = false;
    /* 伝票を印刷済みの注文 (#224)。プレビューを挟まず長押しで刷るようになったぶん、
       「もう刷ったか」を画面で分かるようにするための記録。 */
    var slipPrintedMap = {};
    var slipPrintTargetId = null;  // いま印刷を投げている注文 (成否の確定後に印刷済みにする)
    /* 前菜/デザートの提供cue (#222)。前菜・デザートは注文データに存在しない提供フローの
       一部なので、注文品目としては持たず「その卓に出したか」だけをここで持つ。
       { orderId: { starter: bool, dessert: bool, day } } */
    var serveCueMap = {};
    /* 長押しで戻した直後、指を離した時点で click が発火する。その間に cue が作り直されると
       click が新しい「出した」ボタンに当たり、戻したはずが即座に提供済みへ戻ってしまう。
       次の click を1回だけ捨てる。新しい操作が始まったら (pointerdown) 取り下げる。 */
    var serveCueSuppressClick = false;

    /* 長押し中はホールのカードを作り直さない (#229)。
       ホールビューはポーリングのたびに丸ごと組み直されるため、長押しの最中にボタンのDOMが
       差し替わる。差し替わると進捗バーが0に戻って「反応していない」ように見えるうえ、
       外れた古いノードには pointerup が届かないので、指を離しても長押しが成立してしまう。
       押している間だけ再描画を保留し、離してからまとめて描き直す。 */
    var holdGuard = 0;
    var hallRenderPending = false;
    function beginHold() { holdGuard++; }
    function endHold() {
      if (holdGuard > 0) holdGuard--;
      if (holdGuard === 0 && hallRenderPending) { hallRenderPending = false; renderHallViews(); }
    }
    var hallLayout = "A";          // ホール比較prototypeの表示案
    var tableOverridePending = null; // { id, candidate }。重複警告の2段階確認
    var hallReadyUndoId = null;
    var hallReadyUndoTimer = null;
    var starterUndoId = null;      // ホールで前菜を「出した」直後の取り消し対象 (#295)
    var starterUndoTimer = null;
    var seatDialContext = "reservation"; // reservation / tableOverride
    var bc = null;
    var undoInfo = null;           // { id, index } 全完了直後の取り消し対象
    var undoTimer = null;
    var konroReleaseTimers = {};   // { orderId: timeoutId } 全完了後、「戻す」の猶予が過ぎたらコンロ・タイマーを外す (#298)
    var khRows = [];               // HUD の列 [{kind:"white"|"red", label, cells:[DOM]}] (#145)
    var printerIp = "";            // チビ伝 実機プリンターIP (未設定ならブラウザ印刷のまま #144)
    var currentSlipOrder = null;   // チビ伝プレビュー表示中の注文 (印刷ボタン押下時に参照)
    var printBusy = false;         // チビ伝を送信中か。連打による重複印字を防ぐ (#176)
    var printToastTimer = null;
    var orderSoundUnlocked = false;

    /* ---- DOM ---- */
    var boardEl = document.getElementById("board");
    var emptyEl = document.getElementById("empty");
    var clockEl = document.getElementById("clock");
    var demoBtn = document.getElementById("demoBtn");
    /* グリッド/レーンのボタンも見た目のために .mode-btn を共有しているため、
       クラスではなく data-mode の有無で権限モードのボタンだけを拾う (viewBtns の [data-view] と対称)。
       クラスで拾うと表示切替ボタンにも setMode が配線され、押すたびに setMode(null) =
       キッチンへ戻ってしまう。 */
    var modeBtns = Array.prototype.slice.call(document.querySelectorAll("[data-mode]"));
    var printerSettingsBtn = document.getElementById("printerSettingsBtn");
    var orderSoundBtn = document.getElementById("orderSoundBtn");
    var orderSoundAudio = document.getElementById("orderSoundAudio");
    var viewBtns = Array.prototype.slice.call(document.querySelectorAll("[data-view]"));
    var laneBodies = {
      rice:  document.getElementById("lane-rice"),
      side:  document.getElementById("lane-side"),
      drink: document.getElementById("lane-drink")
    };
    var laneCounts = {
      rice:  document.getElementById("lane-count-rice"),
      side:  document.getElementById("lane-count-side"),
      drink: document.getElementById("lane-count-drink")
    };
    var stockListEl = document.getElementById("stockList");
    var stockCountEl = document.getElementById("stockCount");
    var stockAddBtn = document.getElementById("stockAddBtn");
    var modalBackdrop = document.getElementById("modalBackdrop");
    var resForm = document.getElementById("resForm");
    var menuPickEl = document.getElementById("menuPick");
    var formErrorEl = document.getElementById("formError");
    var resCancelBtn = document.getElementById("resCancel");
    var slipBackdrop = document.getElementById("slipBackdrop");
    var slipTableEl = document.getElementById("slipTable");
    var slipMetaEl = document.getElementById("slipMeta");
    var slipItemsEl = document.getElementById("slipItems");
    var slipStoreEl = document.getElementById("slipStore");
    var slipCanvasEl = document.getElementById("slipCanvas");   // 自由配置レイアウトの印字イメージ
    var slipPageStyleEl = document.createElement("style");   // 用紙幅に応じた @page 上書き (スタイル設定 #144追補)
    document.head.appendChild(slipPageStyleEl);
    var seatBackdrop = document.getElementById("seatBackdrop");
    var seatDialDisplayEl = document.getElementById("seatDialDisplay");
    var seatDialDigitBtns = Array.prototype.slice.call(document.querySelectorAll(".seat-dial-btn[data-digit]"));
    var seatDialZoneBtns = Array.prototype.slice.call(document.querySelectorAll(".seat-dial-zone[data-zone]"));
    var seatDialClearBtn = document.getElementById("seatDialClear");
    var seatDialBackBtn = document.getElementById("seatDialBack");
    var seatDialOkBtn = document.getElementById("seatDialOk");
    var seatDialCancelBtn = document.getElementById("seatDialCancel");
    var reorderBarEl = document.getElementById("reorderBar");
    var reorderBarMsg = reorderBarEl ? reorderBarEl.querySelector(".msg") : null;
    var reorderUndoBtn = document.getElementById("reorderUndo");
    var reorderDoneBtn = document.getElementById("reorderDone");
    var hudActiveEl = document.getElementById("hudActive");
    var hudAlertEl = document.getElementById("hudAlert");
    var hudAlertWrap = document.getElementById("hudAlertWrap");
    var hudSoonEl = document.getElementById("hudSoon");
    var hudSoonWrap = document.getElementById("hudSoonWrap");
    var konroHudEl = document.getElementById("konroHud");
    var syncStatusEl = document.getElementById("syncStatus");
    var syncStatusLabelEl = document.getElementById("syncStatusLabel");
    var syncRelayStateEl = document.getElementById("syncRelayState");
    var syncRouteEls = {
      reservations: {
        root: document.getElementById("syncRouteReservations"),
        state: document.getElementById("syncReservationsState"),
        meta: document.getElementById("syncReservationsMeta")
      },
      orders: {
        root: document.getElementById("syncRouteOrders"),
        state: document.getElementById("syncOrdersState"),
        meta: document.getElementById("syncOrdersMeta")
      },
      kitchen: {
        root: document.getElementById("syncRouteKitchen"),
        state: document.getElementById("syncKitchenState"),
        meta: document.getElementById("syncKitchenMeta")
      }
    };
    var undoToastEl = document.getElementById("undoToast");
    var undoToastMsgEl = document.getElementById("undoToastMsg");
    var undoToastBtn = document.getElementById("undoToastBtn");
    var printToastEl = document.getElementById("printToast");
    var storageWarnEl = document.getElementById("storageWarn");   // 保存失敗の警告バナー (#179)
    var hallProtoBtns = Array.prototype.slice.call(document.querySelectorAll("[data-hall-layout]"));
    var hallStockAddBtns = Array.prototype.slice.call(document.querySelectorAll("[data-hall-stock-add]"));
    var hallProtoViewEl = document.getElementById("hallProtoView");
    var hallReadyUndoToastEl = document.getElementById("hallReadyUndoToast");
    var hallReadyUndoMsgEl = document.getElementById("hallReadyUndoMsg");
    var starterUndoToastEl = document.getElementById("starterUndoToast");   // 前菜「出した」の取り消し (#295)
    var starterUndoMsgEl = document.getElementById("starterUndoMsg");
    var starterUndoBtn = document.getElementById("starterUndoBtn");
    var hallReadyUndoBtn = document.getElementById("hallReadyUndoBtn");
    var tableOverrideConfirmBackdrop = document.getElementById("tableOverrideConfirmBackdrop");
    var tableOverrideConfirmMessage = document.getElementById("tableOverrideConfirmMessage");
    var tableOverrideConfirmCancel = document.getElementById("tableOverrideConfirmCancel");
    var tableOverrideConfirmAllow = document.getElementById("tableOverrideConfirmAllow");

    /* ===================== ユーティリティ ===================== */
    function t(key) { return LABELS[key] || key; }

    /* 予約の人数。合計 (大人+シニア+子供+幼児) と、大人以外がいるときの内訳 ("大2 シ1 子1 幼1")。
       区分と略記は relay-server/party-size.js (予約入力画面・中継サーバーと共有) に従う。
       KDS は HTML 単体でも動く前提のため、読めなかったとき (file:// で単体で開いた等) は同じ4区分で数える */
    var PEOPLE_FALLBACK = [["adults", "大"], ["seniors", "シ"], ["children", "子"], ["kids", "幼"]];
    function peopleCount(r, key) { var n = Number(r && r[key]); return isFinite(n) && n > 0 ? Math.floor(n) : 0; }
    function peopleTotal(r) {
      if (window.PartySize) return window.PartySize.total(r);
      return PEOPLE_FALLBACK.reduce(function (sum, p) { return sum + peopleCount(r, p[0]); }, 0);
    }
    function peopleBreakdown(r) {
      var parts = window.PartySize
        ? window.PartySize.breakdown(r, { onlyMixed: true }).map(function (p) { return p.short + p.n; })
        : PEOPLE_FALLBACK.slice(1).some(function (p) { return peopleCount(r, p[0]) > 0; })
          ? PEOPLE_FALLBACK.filter(function (p) { return peopleCount(r, p[0]) > 0; }).map(function (p) { return p[1] + peopleCount(r, p[0]); })
          : [];
      return parts.join(" ");
    }

    /* ===================== relay同期状態 (#207) =====================
       ブリッジからのイベントとwindow初期値の両方を受け取れるようにする。
       最終失敗の本文は表示せず、時刻だけを出す (認証情報を含む例外の漏えい防止)。 */
    var SYNC_STATE_LABELS = {
      pending: "接続待ち", normal: "正常", delayed: "同期遅延", offline: "オフライン"
    };
    function syncStateLabel(state) { return SYNC_STATE_LABELS[state] || SYNC_STATE_LABELS.pending; }
    function syncTimeLabel(value) {
      var n = Number(value);
      if (!isFinite(n) || n <= 0) return "--";
      var d = new Date(n);
      if (isNaN(d.getTime())) return "--";
      return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
    }
    function renderSyncStatus(status) {
      if (!syncStatusEl || !status || !status.channels) return;
      var state = SYNC_STATE_LABELS[status.state] ? status.state : "pending";
      syncStatusEl.hidden = false;
      syncStatusEl.setAttribute("data-state", state);
      if (syncStatusLabelEl) syncStatusLabelEl.textContent = "relay同期: " + syncStateLabel(state);
      if (syncRelayStateEl) {
        var relay = status.relay || {};
        syncRelayStateEl.textContent = "中継: " + syncStateLabel(relay.state);
      }

      Object.keys(syncRouteEls).forEach(function (name) {
        var els = syncRouteEls[name];
        var channel = status.channels[name] || {};
        var channelState = SYNC_STATE_LABELS[channel.state] ? channel.state : "pending";
        if (els.root) els.root.setAttribute("data-state", channelState);
        if (els.state) els.state.textContent = syncStateLabel(channelState);
        if (els.meta) {
          var meta = "最終成功 " + syncTimeLabel(channel.lastSuccessAt) +
            " / 最終失敗 " + syncTimeLabel(channel.lastFailureAt);
          if (channel.retrying && Number(channel.failureCount) > 0) meta += " / 再試行中";
          els.meta.textContent = meta;
        }
      });
    }
    function listenSyncStatus() {
      if (typeof window === "undefined") return;
      if (window.__KDS_SYNC_STATUS__) renderSyncStatus(window.__KDS_SYNC_STATUS__);
      window.addEventListener("kds-sync-status", function (ev) {
        renderSyncStatus(ev && ev.detail);
      });
    }

    function pad2(n) { return n < 10 ? "0" + n : "" + n; }

    function hhmm(ts) {
      var d = new Date(ts);
      return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
    }

    function safeParse(json, fallback) {
      try { var v = JSON.parse(json); return v == null ? fallback : v; }
      catch (e) { return fallback; }
    }

    function elapsedMin(startTs) {
      var ms = Date.now() - Number(startTs);
      if (!isFinite(ms) || ms < 0) ms = 0;
      return Math.floor(ms / 60000);
    }

    function levelOf(min) {
      if (min >= ALERT_MIN) return "alert";
      if (min >= WARN_MIN)  return "warn";
      return "ok";
    }

    /* ===================== #13 レーン表示（カテゴリ別） =====================
       注文＝カードのグリッドとは別に、未完了品目をカテゴリ別3レーン（ご飯類/サイド/ドリンク）へ
       横断表示する。コンロ側・中間スタッフ側での作業分担が目的。完了状態・同期はグリッドと共通
       （onToggle / doneMap を流用）。品名→カテゴリはPOSデータに無いため KDS 内で自動分類する。 */
    var LANE_CATS = ["rice", "side", "drink"];
    var lastLaneSig = "";

    /* 品名からカテゴリを推定する（実メニュー基準・未知はサイドへ寄せる） */
    function itemCategory(name) {
      var s = String(name == null ? "" : name);
      if (/ビール|オリオン|焼酎|豊の国|黒霧島|ハイボール|サワー|ウーロンハイ|泡盛|薫長|純米|吟醸|辛口|ウーロン茶|オレンジ|コーラ|サイダー|ジュース|水割り|ソーダ|ロック|茶|酒/.test(s)) return "drink";
      if (/御膳|ご飯|ごはん|丼|白米|出汁米|卵かけ|ライス|そば|うどん|麺|米/.test(s)) return "rice";
      return "side";
    }

    /* 予約メニューのうち rice 品目を1つ以上含むものだけを炊飯cue対象にする (#159)。 */
    function isRiceReservation(reservation) {
      return !!(reservation && Array.isArray(reservation.menu) && reservation.menu.some(function (menu) {
        return menu && itemCategory(menu.name) === "rice";
      }));
    }

    /* 公開注文の table は正本。表示だけを厨房ローカル上書きへ切り替える (#160)。 */
    function effectiveTable(order) {
      if (!order) return "";
      var id = String(order.id);
      var override = tableOverrideMap[id];
      return override != null && String(override).trim() !== ""
        ? String(override) : (order.table != null ? String(order.table) : "");
    }

    /* レーン表示を描画する（未完了品目のみ・orderSeq 順）。
       構造シグネチャが不変なら再描画しない（スクロール位置を保つ）。 */
    function renderLanes(force) {
      var buckets = { rice: [], side: [], drink: [] };
      var ids = orderSeq.filter(function (id) { return cards[id]; });
      Object.keys(cards).forEach(function (id) { if (ids.indexOf(id) === -1) ids.push(id); });
      var sig = [];
      ids.forEach(function (id) {
        var entry = cards[id];
        if (!entry || !entry.order) return;
        var order = entry.order;
        var lvl = lockedTimers[id] ? "ok" : levelOf(elapsedMin(order.start));
        (order.items || []).forEach(function (it, idx) {
          if (it.done) return;   // 完了品目はレーンに出さない
          var qty = Number(it.qty) || 1;
          var count = Number(it.doneCount) || 0;
          var remain = Math.max(qty - count, 0);
          buckets[itemCategory(it.name)].push({ order: order, item: it, idx: idx, lvl: lvl, remain: remain });
          sig.push(id + ":" + idx + ":" + lvl + ":" + count);   // #153: 残数変化でも再描画させる
        });
      });
      var sigStr = sig.join("|");
      if (!force && sigStr === lastLaneSig) return;
      lastLaneSig = sigStr;

      LANE_CATS.forEach(function (cat) {
        var body = laneBodies[cat];
        if (!body) return;
        body.innerHTML = "";
        var rows = buckets[cat];
        if (laneCounts[cat]) laneCounts[cat].textContent = String(rows.length);
        if (!rows.length) {
          var em = document.createElement("div");
          em.className = "lane-empty";
          em.textContent = "なし";
          body.appendChild(em);
          return;
        }
        rows.forEach(function (r) { body.appendChild(buildLaneItem(r)); });
      });
    }

    /* 注文端末からの options / allergies を1本の注記テキストに正規化する。
       アレルギーはキー表記ゆれ (allergies / allergy / allergyInfo)・配列を許容する。 */
    function normalizeNoteValue(value) {
      if (value == null || value === false) return "";
      if (Array.isArray(value)) {
        return value.filter(function (v) { return v != null && String(v).trim() !== ""; })
          .map(function (v) { return String(v).trim(); }).join("、");
      }
      return String(value).trim();
    }

    function itemNotesText(item) {
      var notes = [];
      var optionText = normalizeNoteValue(item.options);
      var allergyText = normalizeNoteValue(item.allergies || item.allergy || item.allergyInfo);
      if (optionText) notes.push(optionText);
      if (allergyText) notes.push("アレルギー: " + allergyText);
      return notes.join(" / ");
    }

    /* 予約のアレルギー・要望を中継サーバーが分離した形と、
       旧形式の memo/specialRequest の両方を受け、厨房カードへ安全に表示する。 */
    function reservationNotesSignature(record) {
      if (!record) return "";
      var allergyText = normalizeNoteValue(record.allergies || record.allergy || record.allergyInfo);
      return [
        allergyText,
        normalizeNoteValue(reservationRequestValue(record, allergyText))
      ].join("\u0001");
    }

    function reservationRequestValue(record, allergyText) {
      if (record.request != null) return record.request;
      if (record.specialRequest != null) return record.specialRequest;
      // memo は旧形式の自由記述だけに残るため、既に分離済みのアレルギーがある場合は
      // 同じ special_request を「要望」として二重表示しない。
      return allergyText ? "" : record.memo;
    }

    function buildReservationNotes(record, className) {
      if (!record) return null;
      var allergyText = normalizeNoteValue(record.allergies || record.allergy || record.allergyInfo);
      var requestText = normalizeNoteValue(reservationRequestValue(record, allergyText));

      // relay-server v1 の memo だけが残る場合でも、アレルギーを要望扱いにしない。
      if (!allergyText && requestText && /アレルギ|allerg|食物アレルギ|dietary\s+restriction/i.test(requestText)) {
        var parsedAllergy = requestText.replace(/^\s*(?:アレルギー|allerg(?:y|ies)|食物アレルギー|dietary\s+restriction(?:s)?)\s*[:：]?\s*/i, "").trim() || requestText;
        allergyText = /^(?:なし|無|ない|特になし|なしです|no|none|n\/a)$/i.test(parsedAllergy) ? "" : parsedAllergy;
        requestText = "";
      }
      if (!allergyText && /^(?:アレルギー|allerg(?:y|ies))\s*[:：]?\s*(?:なし|無|ない|特になし|なしです|no|none|n\/a)$/i.test(requestText)) {
        requestText = "";
      }
      if (!allergyText && !requestText) return null;

      var wrap = document.createElement("div");
      wrap.className = className || "order-notes";
      function addNote(kind, label, value) {
        if (!value) return;
        var row = document.createElement("div");
        row.className = (className === "reservation-notes" ? "reservation-note " : "order-note ") + kind;
        var labelEl = document.createElement("span");
        labelEl.className = "label";
        labelEl.textContent = label;
        var valueEl = document.createElement("span");
        valueEl.className = "value";
        valueEl.textContent = value;
        row.appendChild(labelEl);
        row.appendChild(valueEl);
        wrap.appendChild(row);
      }
      addNote("allergy", "アレルギー", allergyText);
      addNote("request", "要望", requestText);
      return wrap;
    }

    function buildLaneItem(r) {
      var order = r.order, it = r.item;
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "lane-item" + (order.type === "reserved" ? " reserved" : "") +
        (r.lvl === "warn" ? " lvl-warn" : (r.lvl === "alert" ? " lvl-alert" : ""));

      var tbl = document.createElement("span");
      tbl.className = "lane-table";
      tbl.textContent = effectiveTable(order) || "-";

      var mid = document.createElement("span");
      var nm = document.createElement("span");
      nm.className = "lane-name";
      nm.textContent = it.name != null ? String(it.name) : "";
      mid.appendChild(nm);
      var laneNotes = itemNotesText(it);
      if (laneNotes) {
        var op = document.createElement("span");
        op.className = "lane-opt";
        op.textContent = laneNotes;
        mid.appendChild(op);
      }

      var qty = document.createElement("span");
      qty.className = "lane-qty";
      qty.textContent = "×" + r.remain;   // #153: 残数を表示

      btn.appendChild(tbl);
      btn.appendChild(mid);
      btn.appendChild(qty);
      btn.addEventListener("click", function () { onToggle(order.id, r.idx); });
      return btn;
    }

    /* 表示モード (grid / lane) */
    function loadView() {
      try { var v = localStorage.getItem(LS_VIEW); view = (v === "lane") ? "lane" : "grid"; }
      catch (e) { view = "grid"; }
    }
    function applyView() {
      document.body.classList.toggle("view-lane", view === "lane");
      viewBtns.forEach(function (b) {
        b.setAttribute("aria-pressed", b.getAttribute("data-view") === view ? "true" : "false");
      });
      if (view === "lane") renderLanes(true);
    }
    function setView(next) {
      view = (next === "lane") ? "lane" : "grid";
      lsSet(LS_VIEW, view);
      applyView();
    }

    /* ===================== 当日分のみ運用 (#63) =====================
       「データ保存は当日分のみ・永続DB無し」(deshup-spec / 議事録6/18)。
       日付が変わって起動したら前日の運用データを破棄する。
       設定 (権限モード/トグル類) は対象外。

       提供時間ログ (#29 KPIベースライン) だけは当日で消さず複数日ぶん残すが、
       無期限に貯めると LS 上限に達して保存が全部止まるため、ここで直近
       SERVE_KEEP_DAYS 日ぶんへローテーションする (#179)。 */
    function todayStr() {
      var d = new Date();
      return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
    }
    function purgeStaleDay() {
      var today = todayStr();
      try {
        var last = localStorage.getItem(LS_DAY);
        if (last && last !== today) {
          // LS_BRIDGE_SEEN も破棄する。予約ストック(LS_STOCK)だけ消して取込済み記録を残すと、
          // 日程変更された予約 (予約IDは不変) が「取込済み」と判定されて
          // 変更後の日に二度と取り込まれない (#172)
          [LS_STOCK, LS_DONE, LS_DONE_V1, LS_ORDER, LS_KONRO, LS_LOCKED, LS_DELETED,
           LS_BRIDGE_SEEN, LS_RICE_CUE, LS_TABLE_OVERRIDE, LS_HALL_READY, LS_SLIP_PRINTED, LS_SERVE_CUE].forEach(function (key) {
            localStorage.removeItem(key);
          });
        }
        lsSet(LS_DAY, today);
      } catch (e) {}
      // 起動のたびに保持期間を掛ける。日跨ぎ以外 (連続稼働からのリロード等) でも
      // 件数上限には掛かるので、ここに置いておけば取りこぼしがない (#179)
      pruneStoredServeLog();
    }

    /* ===================== LocalStorage の書き込み口 (#179) =====================
       以前は各 save 関数が setItem を空 catch で囲んでいた。容量が尽きると
       完了状態・コンロ・並び順・予約ストックの保存が「全部まとめて黙って」止まり、
       画面はメモリ上の状態を描き続けるので、リロードするまで誰も気づけなかった。

       ここに一本化して (1) 失敗を必ず console.error に出す (2) 一番先に肥大する
       提供時間ログを削って1回だけ再試行する (3) それでも駄目ならヘッダーに警告を出す。 */
    var storageFailed = false;      // 警告バナーを出したか (出しっぱなしにする)
    var storageReclaiming = false;  // 再試行の再入防止

    function lsSet(key, value) {
      try { localStorage.setItem(key, value); return true; }
      catch (err) {
        if (reclaimStorage(key)) {
          try { localStorage.setItem(key, value); return true; }
          catch (err2) { reportStorageFailure(key, err2); return false; }
        }
        reportStorageFailure(key, err);
        return false;
      }
    }

    /* 容量不足時の最後の手段: 提供時間ログを当日分まで削る。
       消えて一番困らないのがこれ (CSV に書き出せば残せる) */
    function reclaimStorage(triggerKey) {
      if (storageReclaiming || triggerKey === LS_SERVE) return false;
      storageReclaiming = true;
      try {
        var log = loadServeLog();
        var trimmed = pruneServeLog(log, todayStr(), 1, SERVE_MAX_RECORDS);
        if (trimmed.length >= log.length) return false;
        localStorage.setItem(LS_SERVE, JSON.stringify(trimmed));
        console.warn("[KDS] 保存領域が不足したため提供時間ログを当日分へ切り詰めました (" +
          log.length + " → " + trimmed.length + " 件)。CSV書き出しで退避してください");
        return true;
      } catch (e) { return false; }
      finally { storageReclaiming = false; }
    }

    function reportStorageFailure(key, err) {
      console.error("[KDS] localStorage への保存に失敗しました (" + key + ")。" +
        "この端末では状態が保存されず、リロードで巻き戻ります:", err);
      if (storageFailed) return;
      storageFailed = true;
      if (storageWarnEl) storageWarnEl.hidden = false;
    }

    /* ===================== LocalStorage (完了状態) ===================== */
    /* v2 (kds_done_v2) が無ければ旧v1 (bool配列) を読み込む。bool→個数の確定は
       qty が判明する applyDoneToOrders() 側で行う (#153) */
    function loadDone() {
      var v2 = safeParse(localStorage.getItem(LS_DONE), null);
      doneMap = (v2 && typeof v2 === "object") ? v2 :
        (safeParse(localStorage.getItem(LS_DONE_V1), {}) || {});
    }

    function saveDone() {
      lsSet(LS_DONE, JSON.stringify(doneMap));
    }

    /* ----- コンロ番号状態 (カードidに紐付け / 注文配列とは別管理) ----- */
    function loadKonro() {
      var v = safeParse(localStorage.getItem(LS_KONRO), {}) || {};
      konroMap = (v && typeof v === "object") ? v : {};
    }

    function saveKonro() {
      lsSet(LS_KONRO, JSON.stringify(konroMap));
    }

    /* ----- 配膳カードの並び順 (LS正本 / BC同期) ----- */
    function loadOrderSeq() {
      var v = safeParse(localStorage.getItem(LS_ORDER), []);
      orderSeq = Array.isArray(v) ? v.map(String) : [];
    }
    function saveOrderSeq() {
      lsSet(LS_ORDER, JSON.stringify(orderSeq));
    }

    /* ----- 予約ストック (当日分のみ・永続DB無し) ----- */
    function loadStock() {
      var v = safeParse(localStorage.getItem(LS_STOCK), []);
      stock = Array.isArray(v) ? v.filter(function (r) { return r && r.rid != null; }) : [];
    }
    function saveStock() {
      lsSet(LS_STOCK, JSON.stringify(stock));
    }

    /* ----- 米料理予約cue (#159) ----- */
    function loadRiceCues() {
      var v = safeParse(localStorage.getItem(LS_RICE_CUE), {}) || {};
      riceCueMap = (v && typeof v === "object" && !Array.isArray(v)) ? v : {};
    }
    function saveRiceCues() {
      lsSet(LS_RICE_CUE, JSON.stringify(riceCueMap));
    }
    function pruneRiceCues() {
      var live = {};
      stock.forEach(function (r) { if (r && r.rid != null) live[String(r.rid)] = true; });
      var changed = false;
      Object.keys(riceCueMap).forEach(function (rid) {
        var reservation = findRes(rid);
        if (!live[rid] || (reservation && !isRiceReservation(reservation))) {
          delete riceCueMap[rid]; changed = true;
        }
      });
      if (changed) saveRiceCues();
    }

    /* ----- 厨房限定卓番override (#160)。表示専用で公開注文を変更しない ----- */
    function loadTableOverrides() {
      var v = safeParse(localStorage.getItem(LS_TABLE_OVERRIDE), {}) || {};
      tableOverrideMap = (v && typeof v === "object" && !Array.isArray(v)) ? v : {};
    }
    function saveTableOverrides() {
      lsSet(LS_TABLE_OVERRIDE, JSON.stringify(tableOverrideMap));
    }
    function pruneTableOverrides(liveIds) {
      if (!liveIds) return;
      var changed = false;
      Object.keys(tableOverrideMap).forEach(function (id) {
        if (!liveIds[id]) { delete tableOverrideMap[id]; changed = true; }
      });
      if (changed) saveTableOverrides();
    }

    /* ----- 全品完了時のホールcue snapshot (#152 phase1) ----- */
    function loadHallReady() {
      var v = safeParse(localStorage.getItem(LS_HALL_READY), {}) || {};
      hallReadyMap = (v && typeof v === "object" && !Array.isArray(v)) ? v : {};
    }
    function saveHallReady() {
      lsSet(LS_HALL_READY, JSON.stringify(hallReadyMap));
    }

    /* ----- 伝票の印刷済み記録 (#224) ----- */
    function loadSlipPrinted() {
      var v = safeParse(localStorage.getItem(LS_SLIP_PRINTED), {}) || {};
      slipPrintedMap = (v && typeof v === "object" && !Array.isArray(v)) ? v : {};
    }
    function saveSlipPrinted() {
      lsSet(LS_SLIP_PRINTED, JSON.stringify(slipPrintedMap));
    }
    function isSlipPrinted(orderId) {
      return !!slipPrintedMap[String(orderId)];
    }
    /* 印刷を実行した時点で記録する。「紙が確実に出た」ではなく「もう刷りに行った」の意。
       ブラウザ印刷にフォールバックした場合もダイアログまで到達しているので記録する。 */
    function markSlipPrinted(orderId, shouldBroadcast) {
      if (orderId == null) return;
      var id = String(orderId);
      slipPrintedMap[id] = { day: todayStr(), at: Date.now() };
      saveSlipPrinted();
      if (shouldBroadcast !== false) broadcastSlipPrinted(id);
      applySlipButton(id);
      renderHallViews();   // ホールのカードにも「再伝」を反映する (#226)
    }
    /* 伝ボタンの文言を印刷済みかどうかで切り替える。カードを作り直さずその場で更新する。 */
    function applySlipButton(orderId) {
      var entry = cards[String(orderId)];
      if (!entry || !entry.el) return;
      var btn = entry.el.querySelector(".js-slip-btn");
      if (!btn) return;
      var printed = isSlipPrinted(orderId);
      // textContent で置き換えると進捗バーの span まで消えるので、退避して戻す
      var progress = btn.querySelector(".slip-btn-progress");
      btn.textContent = printed ? "再伝" : "伝";
      if (progress) btn.appendChild(progress);
      btn.classList.toggle("printed", printed);
      btn.setAttribute("aria-label", (printed ? "伝票を再印刷 (1.2秒長押し)" : "伝票を印刷 (1.2秒長押し)"));
    }

    /* ----- 前菜/デザートの提供cue (#222) ----- */
    function loadServeCues() {
      var v = safeParse(localStorage.getItem(LS_SERVE_CUE), {}) || {};
      serveCueMap = (v && typeof v === "object" && !Array.isArray(v)) ? v : {};
    }
    function saveServeCues() {
      lsSet(LS_SERVE_CUE, JSON.stringify(serveCueMap));
    }
    function serveCueState(orderId) {
      var st = serveCueMap[String(orderId)];
      if (!st || typeof st !== "object") return { starter: false, dessert: false };
      return { starter: !!st.starter, dessert: !!st.dessert };
    }
    /* kind は "starter"(前菜) / "dessert"(デザート)。
       前菜・デザートの提供はホールの担当なので、チビ伝と同じくホール専用にする (#228)。
       キッチンの盤面には出さない。厨房が見るのは調理する品目であって提供の進行ではない。 */
    function setServeCue(orderId, kind, served, shouldBroadcast) {
      if (mode !== "hall") return;
      if (orderId == null || (kind !== "starter" && kind !== "dessert")) return;
      var id = String(orderId);
      var st = serveCueMap[id];
      if (!st || typeof st !== "object") st = { starter: false, dessert: false };
      st[kind] = !!served;
      st[kind + "At"] = served ? Date.now() : null;
      st.day = todayStr();
      serveCueMap[id] = st;
      saveServeCues();
      if (shouldBroadcast !== false) broadcastServeCue(id, st);
      applyServeCueToCard(id);
      renderHallViews();
    }

    /* ----- 権限モード ----- */
    function loadPrefs() {
      try {
        var m = localStorage.getItem(LS_MODE);
        mode = (m === "hall") ? "hall" : "kitchen";
      } catch (e) { mode = "kitchen"; }
    }

    function konroState(cardId, num) {
      var m = konroMap[String(cardId)];
      var s = m && m[String(num)];
      return (s === "white" || s === "red") ? s : KONRO_DEFAULT;
    }

    /* コンロ num を種別 kind で占有している別カードid を返す。
       exceptCardId は判定から除外 (＝自分)。占有カードが無ければ null。

       kind は "white"(コンロ使用中) / "red"(タイマー管理中)。**コンロ枠とタイマー枠は
       別資源として独立に数える** (#145)。以前は white/red のどちらでも「占有」とみなして
       同番号を丸ごとロックしていたため、卓Aがコンロ1番を使っているだけで他卓がタイマー1番を
       使えなくなっていた。店舗運用ではコンロとタイマーは別物なので連動させない。

       kind 省略時は従来どおり「どちらかで占有中」を見る (集計用)。 */
    function konroOwnerId(num, exceptCardId, kind) {
      var nk = String(num), ex = String(exceptCardId);
      var ids = Object.keys(konroMap);
      for (var i = 0; i < ids.length; i++) {
        if (ids[i] === ex) continue;
        var s = konroMap[ids[i]] && konroMap[ids[i]][nk];
        if (kind ? (s === kind) : (s === "white" || s === "red")) return ids[i];
      }
      return null;
    }

    /* タップで進む先の状態。埋まっている種別の枠は飛ばす (#145)。
       例) コンロ1が他卓で使用中でも、タイマー1が空いていればタイマーとして使える。
       進める先が無い (両方の枠が他卓で埋まっている) 場合は現状のまま返す。 */
    function nextKonroState(cardId, num, cur) {
      var next = KONRO_CYCLE[cur] || KONRO_DEFAULT;
      for (var step = 0; step < 3; step++) {
        if (next === KONRO_DEFAULT) return next;             // 解除は常に可能
        if (!konroOwnerId(num, cardId, next)) return next;   // その種別の枠が空いている
        next = KONRO_CYCLE[next] || KONRO_DEFAULT;           // 埋まっている枠は飛ばす
      }
      return KONRO_DEFAULT;
    }

    /* スケルトン(初期値)は保存しない = LS を肥大化させない。注文消去時の掃除も簡潔に */
    function setKonroState(cardId, num, state) {
      var key = String(cardId);
      if (state === KONRO_DEFAULT) {
        if (konroMap[key]) {
          delete konroMap[key][String(num)];
          if (!Object.keys(konroMap[key]).length) delete konroMap[key];
        }
      } else {
        if (!konroMap[key]) konroMap[key] = {};
        konroMap[key][String(num)] = state;
      }
    }

    /* 注文が消えた (POS取下げ / 全完了消去) cardId の konro 状態を掃除 */
    function pruneKonro(liveIds) {
      var changed = false;
      Object.keys(konroMap).forEach(function (id) {
        if (!liveIds[id]) { delete konroMap[id]; changed = true; }
      });
      if (changed) saveKonro();
    }

    /* フィードから消えた注文の doneMap / lockedTimers を掃除 (#64)。
       全完了で非表示だがフィードに残る注文の doneMap は保持する
       (掃除すると次ポーリングで完了状態が失われカードが復活するため、カードではなくフィード基準で判定) */
    function pruneDone(liveIds) {
      var changed = false;
      Object.keys(doneMap).forEach(function (id) {
        if (!liveIds[id]) { delete doneMap[id]; changed = true; }
      });
      if (changed) saveDone();
    }
    function pruneLocked(liveIds) {
      var changed = false;
      Object.keys(lockedTimers).forEach(function (id) {
        if (!liveIds[id]) { delete lockedTimers[id]; changed = true; }
      });
      if (changed) saveLocked();
    }

    /* doneMap の1件を doneCount(0..qty) へ正規化する。v1(bool)/v2(number)/未登録すべてを
       ここで吸収する単一の入口 (#153) */
    function normalizeDoneCount(v, qty) {
      var q = Number(qty) || 0;
      if (v === true) return q;                 // 旧v1: 完了 -> 全数
      if (v === false || v == null) return 0;    // 旧v1: 未完了 / 未登録
      var n = Number(v);
      if (!isFinite(n) || n < 0) return 0;
      return q > 0 ? Math.min(n, q) : n;
    }

    /* 注文配列に対して doneMap を「正本」として上書き適用 (リロード復元 / ポーリング時)。
       bool/number混在のdoneMapをここで doneCount(数値)へ正規化して書き戻す (#153) */
    function applyDoneToOrders(orders) {
      orders.forEach(function (o) {
        var saved = doneMap[o.id];
        var counts = [];
        (o.items || []).forEach(function (it, i) {
          var qty = Number(it.qty) || 1;
          var count = saved ? normalizeDoneCount(saved[i], qty) : (it.done ? qty : 0);
          counts[i] = count;
          it.doneCount = count;
          it.done = count >= qty;              // 全数完了フラグ (外部契約 / isAllDone 等が参照)
        });
        doneMap[o.id] = counts;
      });
    }

    /* ===================== BroadcastChannel (2台同期) ===================== */
    function initSync() {
      if (typeof BroadcastChannel === "undefined") return;   // 非対応時は LS ポーリングでフォールバック
      try {
        bc = new BroadcastChannel(BC_NAME);
        bc.onmessage = function (ev) {
          var msg = ev && ev.data;
          if (!msg) return;
          if (msg.type === "toggle") {
            if (!doneMap[msg.id]) doneMap[msg.id] = [];
            doneMap[msg.id][msg.index] = msg.doneCount;
            saveDone();
            // 該当カードへ即時反映
            var c = cards[msg.id];
            if (c) applyDoneToCard(c, /*animateRemoval*/ true, /*broadcastHallReady*/ false);
            else {
              // ホール専用タブには厨房カードがないため、同じ正規化経路でcueだけを撤回する。
              var syncedOrders = getOrders();
              applyDoneToOrders(syncedOrders);
              if (reconcileHallReadySnapshots(syncedOrders, /*broadcast*/ false)) renderHallViews();
            }
          } else if (msg.type === "konro") {
            setKonroState(msg.id, msg.num, msg.state);
            saveKonro();
            refreshKonroNum(msg.num);   // 該当番号を全カードで再描画 (占有カード + 他カードのロック) (#114)
            updateKonroHud();
          } else if (msg.type === "stock") {
            // 予約ストック全体を受信側へ反映 (当日分・小規模なので全置換でシンプルに)
            if (Array.isArray(msg.stock)) { stock = msg.stock; saveStock(); renderStock(); }
          } else if (msg.type === "order") {
            if (Array.isArray(msg.seq)) { orderSeq = msg.seq.map(String); saveOrderSeq(); applyOrderSeq(); }
          } else if (msg.type === "moveToMain" && Array.isArray(msg.stock)) {
            // 予約→進行中の移動を両台で反映 (注文は window.KDS_ORDERS 経由で次ポーリングに乗る)
            stock = msg.stock; saveStock(); renderStock();
            if (msg.order) ensureOrderInBus(msg.order);
          } else if (msg.type === "deleteOrder" && msg.id) {
            // 注文削除の同期 (キッチン側の削除を他タブへ反映)。受信側もトゥームストーンを保持 (#67)
            deletedIds[String(msg.id)] = true;
            saveDeleted();
            if (Array.isArray(window.KDS_ORDERS)) {
              window.KDS_ORDERS = window.KDS_ORDERS.filter(function(o) { return String(o.id) !== String(msg.id); });
            }
            removeCard(String(msg.id), true);
            clearDeletedOrderTimers(msg.id);
            orderSeq = orderSeq.filter(function(x) { return String(x) !== String(msg.id); });
            saveOrderSeq();
            reflectEmpty();
          } else if (msg.type === "timerLock" && msg.id) {
            lockedTimers[String(msg.id)] = !!msg.locked;
            saveLocked();
            applyTimerLockToCard(String(msg.id));
          } else if (msg.type === "riceCue" && msg.rid != null) {
            var riceRid = String(msg.rid);
            if (msg.state && typeof msg.state === "object") riceCueMap[riceRid] = msg.state;
            else riceCueMap[riceRid] = { status: msg.status === "acknowledged" ? "acknowledged" : "active", day: todayStr() };
            saveRiceCues();
            renderStock();
            renderHallViews();
          } else if (msg.type === "slipPrinted" && msg.id != null) {
            // 別端末で刷ったぶんも「再伝」にする。二重印字を防ぐのが目的 (#224)
            slipPrintedMap[String(msg.id)] = { day: todayStr(), at: Date.now() };
            saveSlipPrinted();
            applySlipButton(String(msg.id));
            renderHallViews();
          } else if (msg.type === "serveCue" && msg.id != null) {
            var serveId = String(msg.id);
            if (msg.state && typeof msg.state === "object") serveCueMap[serveId] = msg.state;
            saveServeCues();
            applyServeCueToCard(serveId);
            // 他タブでデザートを出した卓はこのタブでもカードを消す (#260)
            if (serveCueState(serveId).dessert && cards[serveId]) removeCard(serveId, /*fade*/ true);
            renderHallViews();
          } else if (msg.type === "tableOverride" && msg.id != null) {
            var overrideId = String(msg.id);
            if (msg.removed || msg.table == null || String(msg.table).trim() === "") delete tableOverrideMap[overrideId];
            else tableOverrideMap[overrideId] = String(msg.table);
            saveTableOverrides();
            applyTableOverrideToCard(overrideId);
            refreshAllKonro();
            renderHallViews();
          } else if (msg.type === "hallReady" && msg.id != null) {
            var readyId = String(msg.id);
            var incoming = msg.snapshot && typeof msg.snapshot === "object" ? msg.snapshot : null;
            var current = hallReadyMap[readyId];
            var incomingStatus = incoming && incoming.status ? incoming.status : msg.status;
            var staleAfterRetraction = current && current.status === "retracted" &&
              incomingStatus !== "retracted" &&
              Number(incoming && incoming.completedAt || 0) <= Number(current.retractedAt || 0);
            if (!staleAfterRetraction) {
              if (incoming) hallReadyMap[readyId] = incoming;
              else if (msg.status === "dismissed" && current && current.status !== "retracted") current.status = "dismissed";
              if (incomingStatus === "retracted" && hallReadyUndoId === readyId) hideHallReadyUndo();
              saveHallReady();
              renderHallViews();
            }
          }
        };
      } catch (e) { bc = null; }
    }

    function broadcastStock() {
      if (!bc) return;
      try { bc.postMessage({ type: "stock", stock: stock }); } catch (e) {}
    }
    function broadcastOrderSeq() {
      if (!bc) return;
      try { bc.postMessage({ type: "order", seq: orderSeq }); } catch (e) {}
    }
    function broadcastMoveToMain(order) {
      if (!bc) return;
      try { bc.postMessage({ type: "moveToMain", stock: stock, order: order }); } catch (e) {}
    }

    function broadcastToggle(id, index, doneCount) {
      if (!bc) return;
      try { bc.postMessage({ type: "toggle", id: id, index: index, doneCount: doneCount }); } catch (e) {}
    }

    function broadcastKonro(id, num, state) {
      if (!bc) return;
      try { bc.postMessage({ type: "konro", id: id, num: num, state: state }); } catch (e) {}
    }

    function broadcastDeleteOrder(id) {
      if (!bc) return;
      try { bc.postMessage({ type: "deleteOrder", id: String(id) }); } catch (e) {}
    }

    function broadcastTimerLock(id, locked) {
      if (!bc) return;
      try { bc.postMessage({ type: "timerLock", id: String(id), locked: !!locked }); } catch (e) {}
    }

    function broadcastRiceCue(rid, state) {
      if (!bc) return;
      try { bc.postMessage({ type: "riceCue", rid: String(rid), state: state }); } catch (e) {}
    }
    function broadcastTableOverride(id, table, removed) {
      if (!bc) return;
      try { bc.postMessage({ type: "tableOverride", id: String(id), table: table == null ? null : String(table), removed: !!removed }); } catch (e) {}
    }
    function broadcastHallReady(id, snapshot) {
      if (!bc) return;
      try { bc.postMessage({ type: "hallReady", id: String(id), snapshot: snapshot }); } catch (e) {}
    }
    function broadcastSlipPrinted(id) {
      if (!bc) return;
      try { bc.postMessage({ type: "slipPrinted", id: String(id) }); } catch (e) {}
    }
    function broadcastServeCue(id, state) {
      if (!bc) return;
      try { bc.postMessage({ type: "serveCue", id: String(id), state: state }); } catch (e) {}
    }

    /* ===================== レンダリング ===================== */
    /* 注文フィードが一度でも届いたタブか (#133)。
       「未接続 (undefined) = まだ知らない」と「接続済みで空配列 = 全部消えた」は意味が違う。
       未接続のまま掃除 (prune) を走らせると、他タブが保持しているコンロ/完了/並び順を
       LS 越しに全消去してしまうため、掃除系はこの関数が true のタブだけが行う。 */
    function hasOrderFeed() {
      return Array.isArray(window.KDS_ORDERS);
    }

    function getOrders() {
      var src = window.KDS_ORDERS;
      if (!Array.isArray(src)) return [];
      // データ契約に最低限合致するものだけ通す (システム境界の入力検証)。削除済みは除外 (#67)
      return src.filter(function (o) {
        return o && (o.id !== undefined && o.id !== null) && Array.isArray(o.items) &&
          !deletedIds[String(o.id)];
      });
    }

    /* 品目の構造シグネチャ (done は含めない = 完了トグルで再構築しない) */
    function itemsSignature(items) {
      return (items || []).map(function (it) {
        return String(it.name) + "" + Number(it.qty || 1) + "" + itemNotesText(it);
      }).join("");
    }

    /* 品目ボタンへ doneCount を反映 (打ち消し線/破線下線/進捗表示の切替)。
       tap(+1)・長押し(-1)・他タブ同期のすべてがこの単一経路を通る (#153) */
    function updateItemButtonDone(btn, count, qty) {
      var total = Number(qty) || 1;
      var c = Math.max(0, Math.min(total, Number(count) || 0));
      var done = c >= total;
      var partial = !done && c > 0;
      btn.classList.toggle("done", done);
      btn.classList.toggle("partial", partial);
      btn.setAttribute("aria-pressed", done ? "true" : "false");
      var numEl = btn.querySelector(".qty-num");
      // 複数個品目は 0/n から数え上げ、完了したら打ち消し線の全数表示に切替 (#153)
      if (numEl) numEl.textContent = String(done ? total : c);
    }

    /* 品目ボタンのタップ(+1)/長押し(-1・誤タップの戻し)を配線する (#153)。
       長押し成立時はその後の click を1回だけ抑止し、+1 との二重発火を防ぐ。
       並べ替え長押し(attachReorderHandlers)と同じ LONGPRESS_MS / 12px キャンセル閾値を踏襲。 */
    function attachItemHandlers(btn, order, idx) {
      var pressTimer = null;
      var startX = 0, startY = 0;
      var suppressClick = false;

      function clearPressTimer() {
        if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
        btn.classList.remove("pressing");
      }
      btn.addEventListener("pointerdown", function (ev) {
        if (ev.button != null && ev.button !== 0) return;
        startX = ev.clientX; startY = ev.clientY;
        btn.classList.add("pressing");
        pressTimer = setTimeout(function () {
          pressTimer = null;
          btn.classList.remove("pressing");
          suppressClick = true;
          onItemDecrement(order.id, idx);
        }, LONGPRESS_MS);
      });
      btn.addEventListener("pointermove", function (ev) {
        if (!pressTimer) return;
        if (Math.abs(ev.clientX - startX) > 12 || Math.abs(ev.clientY - startY) > 12) clearPressTimer();
      });
      btn.addEventListener("pointerup", clearPressTimer);
      btn.addEventListener("pointercancel", clearPressTimer);
      btn.addEventListener("click", function (ev) {
        if (suppressClick) { suppressClick = false; ev.preventDefault(); return; }
        // タップが効いたことを行の明滅で返す (数字が変わるだけでは厨房の距離から判りにくい)
        btn.classList.remove("flash");
        void btn.offsetWidth;   // 連続タップでもアニメーションを頭から再生する
        btn.classList.add("flash");
        onToggle(order.id, idx);
      });
      btn.addEventListener("animationend", function () { btn.classList.remove("flash"); });
    }

    /* 品目リスト <ul.items> を生成 (buildCard 初回 / ポーリングでの品目変更時の再構築で共用) */
    function buildItemsList(order) {
      var ul = document.createElement("ul");
      ul.className = "items";
      (order.items || []).forEach(function (it, idx) {
        var li = document.createElement("li");
        var btn = document.createElement("button");
        btn.type = "button";
        // qty>1 の品目だけ「0/n」の分数表示を出す (#153)。qty=1 は従来通り単純な数字のみ
        btn.className = (Number(it.qty) || 1) > 1 ? "item multi" : "item";
        btn.setAttribute("data-index", String(idx));

        var chk = document.createElement("span");
        chk.className = "check";
        chk.setAttribute("aria-hidden", "true");

        var main = document.createElement("span");
        main.className = "item-main";
        var nm = document.createElement("span");
        nm.className = "item-name";
        nm.textContent = it.name != null ? String(it.name) : "";
        main.appendChild(nm);
        var notesText = itemNotesText(it);
        if (notesText) {
          var op = document.createElement("span");
          op.className = "item-opt";
          op.textContent = notesText;
          main.appendChild(op);
        }

        var totalQty = Number(it.qty || 1);
        var qty = document.createElement("span");
        qty.className = "item-qty";
        var qtyNum = document.createElement("span");
        qtyNum.className = "qty-num";
        var qtyTotal = document.createElement("span");
        qtyTotal.className = "qty-total";
        qtyTotal.textContent = "/" + totalQty;
        qty.appendChild(qtyNum);
        qty.appendChild(qtyTotal);

        btn.appendChild(chk);
        btn.appendChild(main);
        btn.appendChild(qty);
        attachItemHandlers(btn, order, idx);
        updateItemButtonDone(btn, Number(it.doneCount) || 0, totalQty);
        li.appendChild(btn);
        ul.appendChild(li);
      });
      return ul;
    }

    function buildCard(order) {
      var card = document.createElement("article");
      card.className = "card " + (order.type === "reserved" ? "reserved" : "new") +
        " lvl-" + (lockedTimers[order.id] ? "ok" : levelOf(elapsedMin(order.start)));
      card.setAttribute("data-id", String(order.id));
      card.setAttribute("aria-label",
        "卓 " + (effectiveTable(order) || "") + " " + (order.type === "reserved" ? t("reserved") : t("new")));

      /* banner (帯) = 緊急度で塗る上段 */
      var head = document.createElement("div");
      head.className = "card-banner";
      var badge = document.createElement("span");
      badge.className = "badge-type js-badge";
      badge.textContent = order.type === "reserved" ? t("reserved") : t("new");
      var people = document.createElement("span");
      people.className = "people";
      // 予約→配膳では合計に添えて大人/シニア/子供/幼児の内訳を表示 (POS由来で内訳が無ければ合計のみ)
      if (order.adults != null) {
        var breakdown = peopleBreakdown(order);
        people.innerHTML = '<span class="n">' + peopleTotal(order) +
          '</span><span class="unit">' + t("people") + '</span>' +
          (breakdown ? '<span class="kids-inline">' + breakdown + '</span>' : '');
      } else {
        people.innerHTML = '<span class="n">' + Number(order.people || 0) +
          '</span><span class="unit js-unit">' + t("people") + '</span>';
      }
      var table = document.createElement("div");
      table.className = "table-no";
      table.textContent = effectiveTable(order) || "--";
      // 削除ボタン (キッチンモード専用)。ネイティブ confirm() はメインスレッドを塞ぎ
      // ポーリング・経過時間更新まで止めるため、2段階タップのインライン確認にする (#68)
      var delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "delete-btn";
      delBtn.setAttribute("aria-label", "注文削除");
      delBtn.textContent = "×";
      var delArmTimer = null;
      function disarmDelete() {
        if (delArmTimer) { clearTimeout(delArmTimer); delArmTimer = null; }
        delBtn.classList.remove("armed");
        delBtn.textContent = "×";
        delBtn.setAttribute("aria-label", "注文削除");
      }
      delBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        if (delBtn.classList.contains("armed")) {
          disarmDelete();
          deleteOrder(order.id);
          return;
        }
        delBtn.classList.add("armed");
        delBtn.textContent = "削除?";
        delBtn.setAttribute("aria-label", "もう一度タップで注文削除");
        if (delArmTimer) clearTimeout(delArmTimer);
        delArmTimer = setTimeout(disarmDelete, DELETE_ARM_MS);
      });
      /* sub 行 = 種別チップ + 受付 + 操作 */
      var timeRow = document.createElement("div");
      timeRow.className = "card-sub";
      var recv = document.createElement("span");
      recv.className = "recv";
      recv.innerHTML = '<span class="label js-recv">' + t("recv") + '</span> <span class="hhmm">' +
        hhmm(order.start) + '</span>';
      var elapsed = document.createElement("span");
      elapsed.className = "elapsed js-elapsed";
      elapsed.innerHTML = '<span class="label js-elapsed-label">' + t("elapsed") + '</span>' +
        '<span class="val js-elapsed-val">0</span>' +
        '<span class="label js-min">' + t("min") + '</span>';
      // チビ伝プレビュー (印刷はキッチン専用操作。ホールモードでは CSS で非表示)
      var slipBtn = document.createElement("button");
      slipBtn.type = "button";
      slipBtn.className = "slip-btn js-slip-btn";
      decorateSlipButton(slipBtn, order);
      // 卓番overrideは厨房だけの表示上書き。元order.tableや上流APIは変更しない (#160)
      var tableOverrideBtn = document.createElement("button");
      tableOverrideBtn.type = "button";
      tableOverrideBtn.className = "table-override-btn";
      tableOverrideBtn.textContent = "卓番";
      tableOverrideBtn.setAttribute("aria-label", "卓番を変更");
      tableOverrideBtn.setAttribute("data-overridden", tableOverrideMap[String(order.id)] ? "true" : "false");
      tableOverrideBtn.addEventListener("click", function (ev) {
        ev.stopPropagation();
        openTableOverride(order.id);
      });
      // タイマーロックボタン
      var lockBtn = document.createElement("button");
      lockBtn.type = "button";
      lockBtn.className = "lock-btn js-lock-btn";
      lockBtn.setAttribute("aria-label", "タイマー停止");
      lockBtn.setAttribute("aria-pressed", "false");
      lockBtn.textContent = "停";
      lockBtn.addEventListener("click", function () { toggleTimerLock(order.id); });
      // バナー(帯): 卓番(特大) + 経過(特大) + 人数 + 削除
      head.appendChild(table);
      head.appendChild(elapsed);
      head.appendChild(people);
      if (FEATURE_DELETE_ORDER) head.appendChild(delBtn); // #59 既定OFF
      /* konro: コンロ番号 1〜10 (既定=使用中のみ細帯 / 「コンロ割当」で全1-10を展開)。
         展開ボタンはサブ行に置き、カード下部の帯は使用中の番号 (または展開した1〜10) だけにする。
         未使用のカードでは帯そのものを出さず、カードの高さを品目分に抑える。 */
      var konro = document.createElement("div");
      konro.className = "konro";
      var kLabel = document.createElement("div");
      kLabel.className = "konro-label js-konro-label";
      kLabel.textContent = t("konro");
      var kToggle = document.createElement("button");
      kToggle.type = "button";
      kToggle.className = "konro-toggle";
      kToggle.textContent = "コンロ割当";
      kToggle.setAttribute("aria-expanded", "false");
      kToggle.setAttribute("aria-label", "コンロ番号を割り当て");
      kToggle.addEventListener("click", function () {
        var open = konro.classList.toggle("expanded");
        kToggle.setAttribute("aria-expanded", open ? "true" : "false");
        // 文言を変えたら CSS の .card-sub .konro-toggle::after も合わせる (幅を固定するため #295)
        kToggle.textContent = open ? "閉じる" : "コンロ割当";
      });
      // サブ行: 種別チップ + 受付 + 卓番 + 停 + コンロ割当 + 伝
      timeRow.appendChild(badge);
      timeRow.appendChild(recv);
      timeRow.appendChild(tableOverrideBtn);
      if (FEATURE_TIMER_LOCK) timeRow.appendChild(lockBtn); // #59 既定OFF
      timeRow.appendChild(kToggle);
      timeRow.appendChild(slipBtn);

      /* items */
      var ul = buildItemsList(order);

      var kGrid = document.createElement("div");
      kGrid.className = "konro-grid";
      kGrid.setAttribute("role", "group");
      for (var kn = 1; kn <= KONRO_COUNT; kn++) {
        (function (num) {
          var kbtn = document.createElement("button");
          kbtn.type = "button";
          kbtn.className = "konro-btn";
          kbtn.setAttribute("data-num", String(num));
          kbtn.textContent = String(num);
          kbtn.addEventListener("click", function () { onKonroTap(order.id, num); });
          applyKonroBtn(kbtn, order.id, num);   // 初期状態 + 他カード占有によるロックを反映 (#114)
          kGrid.appendChild(kbtn);
        })(kn);
      }
      konro.appendChild(kLabel);
      konro.appendChild(kGrid);

      /* 種別アンダーライン (緊急度バンドの直下・新規=藍/予約=金) */
      var typeUnderline = document.createElement("div");
      typeUnderline.className = "type-underline";

      /* 長押し進捗リング (誤操作防止の可視フィードバック) */
      var prog = document.createElement("div");
      prog.className = "grab-progress";

      card.appendChild(prog);
      card.appendChild(head);
      card.appendChild(typeUnderline);
      card.appendChild(timeRow);
      // 前菜は膳より先、デザートは膳の後。提供順を並び順で示す (#228)
      card.appendChild(buildServeCue(order.id, "starter", order.people));
      card.appendChild(ul);
      var orderNotes = buildReservationNotes(order, "order-notes");
      if (orderNotes) card.appendChild(orderNotes);
      card.appendChild(buildServeCue(order.id, "dessert", order.people));
      card.appendChild(konro);

      // 並べ替え: ヘッダ(卓番周辺)を長押しで掴む (品目/コンロのタップと衝突しない)
      attachReorderHandlers(card, head, String(order.id));
      return card;
    }

    /* 全品完了済みでも、デザートを出すまでホールにカードを残す卓か (#228 / #260)。
       提供準備完了snapshotがあり、デザート未提供なら待ち。リロード後のカード再生成に使う。 */
    function isDessertWaiting(order) {
      if (!order || order.id == null || !isOrderAllDone(order)) return false;
      var snapshot = hallReadyMap[String(order.id)];
      if (!snapshot || snapshot.status === "retracted") return false;
      return !serveCueState(order.id).dessert;
    }

    /* 注文配列を DOM に同期 (新規追加 / 削除 / 既存はキャッシュ流用) */
    function render(orders) {
      var seen = {};
      var added = [];
      // 完了状態を正規化した後、live orderの未完了化をhall-readyへ反映する。
      reconcileHallReadySnapshots(orders, /*broadcast*/ true);
      orders.forEach(function (order) {
      var entry = cards[order.id];
        // 全品目完了済みの注文は再表示しない (完了消去したカードがポーリングで復活しないように)
        var allDone = isOrderAllDone(order);
        // ただしホールでデザート待ちの卓はカードを残す。リロードで失わない (#260)
        if (!entry && allDone && !isDessertWaiting(order)) return;
        seen[order.id] = true;
        if (!entry) {
          var el = buildCard(order);
          boardEl.appendChild(el);
          entry = cards[order.id] = { el: el, order: order, level: null, items: order.items,
          itemsSig: itemsSignature(order.items), notesSig: reservationNotesSignature(order) };
          added.push(String(order.id));
        } else {
          entry.order = order;
          entry.items = order.items;
          // POS 側で品目が追加・変更・削除されたら品目リスト DOM を再構築 (#60)
          var sig = itemsSignature(order.items);
          if (sig !== entry.itemsSig) {
            entry.itemsSig = sig;
            var oldUl = entry.el.querySelector(".items");
            if (oldUl) entry.el.replaceChild(buildItemsList(order), oldUl);
          }
          var notesSig = reservationNotesSignature(order);
          if (notesSig !== entry.notesSig) {
            entry.notesSig = notesSig;
            var oldNotes = entry.el.querySelector(".order-notes");
            var newNotes = buildReservationNotes(order, "order-notes");
            if (oldNotes && newNotes) oldNotes.parentNode.replaceChild(newNotes, oldNotes);
            else if (oldNotes) oldNotes.parentNode.removeChild(oldNotes);
            else if (newNotes) {
              var itemList = entry.el.querySelector(".items");
              if (itemList && itemList.parentNode) itemList.parentNode.insertBefore(newNotes, itemList.nextSibling);
            }
          }
        }
        applyTableOverrideToCard(String(order.id));
        applyDoneToCard(entry, /*animateRemoval*/ false);
        applyKonroToCard(order.id);   // LS のコンロ状態を DOM へ反映 (他タブ更新の取り込み)
      });

      // 消えた注文 (POS 側で取り下げ等 / 全完了消去) を除去
      Object.keys(cards).forEach(function (id) {
        if (!seen[id]) removeCard(id, /*fade*/ false);
      });

      // 掃除系は注文フィードが届いているタブだけが実行する。未接続タブが走らせると
      // 他タブのコンロ/完了/ロック状態を LS 越しに全消去してしまう (#133)
      if (hasOrderFeed()) {
        // 生存している注文 id を集め、消えた注文のコンロ状態を掃除
        // (完了取り消しの猶予中はその注文のコンロ状態を残す)
        if (undoInfo && !seen[undoInfo.id]) {
          var keep = {};
          Object.keys(seen).forEach(function (k) { keep[k] = true; });
          keep[undoInfo.id] = true;
          pruneKonro(keep);
        } else {
          pruneKonro(seen);
        }

        // doneMap / lockedTimers はフィード全体を生存基準に掃除 (#64)
        var feedIds = {};
        orders.forEach(function (o) { feedIds[String(o.id)] = true; });
        if (undoInfo) feedIds[undoInfo.id] = true;
        pruneDone(feedIds);
        pruneLocked(feedIds);
        pruneTableOverrides(feedIds);
      }

      // コンロ掃除後に全カードのロックを再計算 (占有カードが消えた番号を解錠する) (#114)
      refreshAllKonro();

      // 並び順の整合: 消えた id を除去し、新着を末尾に追加 (時系列。手動並べ替えは保持)
      reconcileOrderSeq(seen, added);
      applyOrderSeq();

      updateTimers();
      reflectEmpty();
      updateKonroHud();
      if (view === "lane") renderLanes();   // #13 レーン表示も同期
      renderHallViews();
    }

    /* ===================== 新着オーダー通知音 =====================
       Android Chromeの自動再生制限に合わせ、「通知音ON」押下をユーザー操作として使う。
       通知音はrelay bridgeが発火する新規サーバー注文イベントだけで鳴らす。 */
    function setOrderSoundButtonState(state) {
      if (!orderSoundBtn) return;
      var label = orderSoundBtn.querySelector("span");
      var enabled = state === "on";
      var unsupported = state === "unsupported";
      if (label) label.textContent = unsupported ? "通知音非対応" : (enabled ? "通知音ON" : "通知音OFF");
      orderSoundBtn.setAttribute("aria-pressed", enabled ? "true" : "false");
      orderSoundBtn.setAttribute("aria-label", unsupported ? "このブラウザは通知音に対応していません" :
        (enabled ? "通知音をテスト再生" : "通知音を有効化"));
      orderSoundBtn.disabled = unsupported;
    }

    function unlockOrderSound() {
      if (!orderSoundAudio || typeof orderSoundAudio.play !== "function") {
        setOrderSoundButtonState("unsupported");
        return false;
      }
      try {
        orderSoundUnlocked = true;
        setOrderSoundButtonState("on");
        return true;
      } catch (e) {
        orderSoundUnlocked = false;
        setOrderSoundButtonState("off");
        return false;
      }
    }

    function playOrderSoundNow() {
      var audio = orderSoundAudio;
      if (!audio || !orderSoundUnlocked) return;
      try {
        audio.currentTime = 0;
        var playback = audio.play();
        if (playback && typeof playback.catch === "function") {
          playback.catch(function () {
            orderSoundUnlocked = false;
            setOrderSoundButtonState("off");
          });
        }
      } catch (e) {
        orderSoundUnlocked = false;
        setOrderSoundButtonState("off");
      }
    }

    function enableOrderSound() {
      if (unlockOrderSound()) playOrderSoundNow();
    }

    function onOrderAdded(event) {
      var detail = event && event.detail;
      if (!detail || !Array.isArray(detail.orders) || !detail.orders.length) return;
      playOrderSoundNow();
    }

    /* orderSeq を生存注文に同期。新着は末尾へ。並べ替え中は触らない */
    function reconcileOrderSeq(seen, added) {
      if (isReordering) return;
      var canPrune = hasOrderFeed();   // 未接続タブは他タブの並び順を削らない (#133)
      var changed = false;
      var next = orderSeq.filter(function (id) {
        if (seen[id] || !canPrune) return true;
        changed = true; return false;
      });
      added.forEach(function (id) {
        if (next.indexOf(id) === -1) { next.push(id); changed = true; }
      });
      // orderSeq に無い生存カードを補完 (LS破損 / 初回)
      Object.keys(cards).forEach(function (id) {
        if (next.indexOf(id) === -1) { next.push(id); changed = true; }
      });
      if (changed) { orderSeq = next; saveOrderSeq(); }
    }

    /* DOM の並びを orderSeq に合わせる (掴み中は除外 / 既に正しい順なら触らない) */
    function applyOrderSeq() {
      if (isReordering) return;
      // 生存カードの期待順を作成
      var seqEls = [];
      orderSeq.forEach(function (id) {
        var entry = cards[id];
        if (entry && entry.el && entry.el.parentNode === boardEl) seqEls.push(entry.el);
      });
      // 現在の DOM 順と比較して変化がなければスキップ (毎秒のリフロー防止)
      var domChildren = Array.prototype.slice.call(boardEl.children);
      var liveChildren = domChildren.filter(function (el) { return seqEls.indexOf(el) !== -1; });
      var alreadySorted = seqEls.length === liveChildren.length &&
        seqEls.every(function (el, i) { return el === liveChildren[i]; });
      if (alreadySorted) return;
      seqEls.forEach(function (el) { boardEl.appendChild(el); });
    }

    function isOrderAllDone(order) {
      var items = order && Array.isArray(order.items) ? order.items : [];
      if (!items.length) return false;
      return items.every(function (item) { return !!item.done; });
    }

    function isAllDone(entry) {
      return isOrderAllDone(entry && entry.order ? entry.order : { items: entry && entry.items });
    }

    /* ===================== #29 提供時間ログ (注文受付→全完了の自動計測) =====================
       注文受付(order.start)から全品目完了までの提供時間を記録し LocalStorage(LS_SERVE) へ追記する。
       PRD KPI「平均提供時間20%減」の導入前ベースライン。#31(日次レポート)/#26(需要予測)の前提データ。
       純粋関数は serve-log.js を共有し、保存・UI連携と卓番上書きだけをここで扱う。 */
    /* ログの保持方針 (#179)。追記されるだけで減らないと 5MB の LS 上限に到達し、
       その時点で KDS の保存が全機能まとめて黙って止まる。長期のKPIデータは CSV 書き出しに
       任せ、ブラウザ側は直近ぶんだけ持つ。日次パージと読み込み時に切り詰める。 */
    var SERVE_KEEP_DAYS = 14;        // 今日を含めて何日ぶん残すか
    var SERVE_MAX_RECORDS = 3000;    // 件数上限 (1日100件でも上の14日に収まる安全弁)

    /* epoch ms → 営業日キー "YYYY-MM-DD"。todayStr() と同じ規則 (#179) */
    function serveDayKey(ms) {
      return window.ServeLog.dayKey(ms);
    }
    /* day を持たない旧レコードは completedAt から導く */
    function serveRecordDay(r) {
      return window.ServeLog.recordDay(r);
    }
    /* 直近 keepDays 営業日ぶん かつ maxRecords 件以内へ切り詰める (#179) */
    function pruneServeLog(log, today, keepDays, maxRecords) {
      return window.ServeLog.pruneServeLog(log, today, keepDays, maxRecords);
    }
    /* 重複判定。day を渡すとその営業日ぶんだけ見る (POSの日次連番IDで取りこぼさないため #179) */
    function hasServeRecord(log, orderId, day) {
      return window.ServeLog.hasServeRecord(log, orderId, day);
    }

    function buildServeRecord(order, completedAt) {
      var record = window.ServeLog.buildServeRecord(order, completedAt);
      // 厨房の卓番上書きはログにも反映するが、取込元の注文は変更しない。
      record.table = effectiveTable(order);
      return record;
    }
    function computeServeStats(log) {
      return window.ServeLog.computeServeStats(log);
    }
    function formatServeDuration(ms) {
      return window.ServeLog.formatDuration(ms);
    }
    function serveToCSV(log) {
      return window.ServeLog.toCSV(log);
    }

    function loadServeLog() { return safeParse(localStorage.getItem(LS_SERVE), []) || []; }
    function saveServeLog(log) { return lsSet(LS_SERVE, JSON.stringify(log)); }

    /* 完了を取り消した注文の当日ログを戻す。recordServe は当日1件だけ記録するので、
       取り除くのも当日分の1件に限る。undo・poll・他タブ同期から重ねて呼ばれても、
       POSの日次連番IDで同じIDを持つ前日以前の記録は消さない (#179 / #204)。 */
    function removeLatestServeRecord(orderId) {
      var log = loadServeLog();
      var today = serveDayKey(Date.now());
      for (var i = log.length - 1; i >= 0; i--) {
        if (!log[i] || String(log[i].orderId) !== String(orderId)) continue;
        if (serveRecordDay(log[i]) !== today) continue;
        log.splice(i, 1);
        saveServeLog(log);
        return true;
      }
      return false;
    }

    /* 保存済みログを保持方針まで切り詰める。減った場合だけ書き戻す (#179) */
    function pruneStoredServeLog() {
      var log = loadServeLog();
      if (!log.length) return log;
      var kept = pruneServeLog(log, todayStr(), SERVE_KEEP_DAYS, SERVE_MAX_RECORDS);
      if (kept.length !== log.length) {
        saveServeLog(kept);
        console.info("[KDS] 提供時間ログを保持期間 " + SERVE_KEEP_DAYS + "日ぶんへ整理しました (" +
          log.length + " → " + kept.length + " 件)");
      }
      return kept;
    }

    /* 全品目完了時に提供時間を記録。
       重複ガードは当日分に限定する — 永続ログ全体を見ると、POS の注文IDが日次リセットの
       連番だった場合に2日目以降の記録が丸ごと落ちる (#179) */
    function recordServe(entry) {
      var order = entry && entry.order;
      if (!order) return;
      var now = Date.now();
      var today = serveDayKey(now);
      var log = pruneServeLog(loadServeLog(), todayStr(), SERVE_KEEP_DAYS, SERVE_MAX_RECORDS);
      if (hasServeRecord(log, order.id, today)) return;
      log.push(buildServeRecord(order, now));
      saveServeLog(log);
    }

    function downloadServeCSV() {
      var csv = "﻿" + serveToCSV(loadServeLog());
      var blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url; a.download = "kds-serve-log.csv";
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }

    /* 検証・バックアップ用アクセサ (コンソールから利用可能) */
    window.KDS_getServeLog = function () { return loadServeLog(); };
    window.KDS_getServeStats = function () { return computeServeStats(loadServeLog()); };
    window.KDS_exportServeCSV = downloadServeCSV;
    window.KDS_clearServeLog = function () { saveServeLog([]); };

    /* ===================== #152 hall-ready cue (phase1) =====================
       完了カードの消去前に、表示用snapshotをidempotentに保存する。dismissedも
       当日中はtombstoneとして残し、poll/BC再通知を防ぐ。 */
    function reconcileHallReadySnapshot(order, shouldBroadcast) {
      if (!order || order.id == null || isOrderAllDone(order)) return false;
      var id = String(order.id), snapshot = hallReadyMap[id];
      if (!snapshot || snapshot.status === "retracted") return false;
      snapshot.status = "retracted";
      snapshot.retractedAt = Date.now();
      delete snapshot.dismissedAt;
      if (hallReadyUndoId === id) hideHallReadyUndo();
      saveHallReady();
      if (shouldBroadcast !== false) broadcastHallReady(id, snapshot);
      return true;
    }

    function reconcileHallReadySnapshots(orders, shouldBroadcast) {
      var changed = false;
      (orders || []).forEach(function (order) {
        if (reconcileHallReadySnapshot(order, shouldBroadcast)) changed = true;
      });
      return changed;
    }

    function ensureHallReadySnapshot(order) {
      if (!order || order.id == null || !Array.isArray(order.items) || !order.items.length) return null;
      var id = String(order.id);
      if (hallReadyMap[id] && hallReadyMap[id].status !== "retracted") return hallReadyMap[id];
      var snapshot = {
        orderId: id,
        id: id,
        table: effectiveTable(order),
        people: Number(order.people) || 0,   // デザートを人数分出すため (#222)
        completedAt: Date.now(),
        day: todayStr(),
        status: "active",
        items: order.items.map(function (item) {
          return { name: item.name, qty: Number(item.qty) || 1, note: itemNotesText(item) };
        })
      };
      hallReadyMap[id] = snapshot;
      saveHallReady();
      broadcastHallReady(id, snapshot);
      renderHallViews();
      return snapshot;
    }

    function showHallReadyUndo(id, table) {
      hallReadyUndoId = String(id);
      if (hallReadyUndoMsgEl) hallReadyUndoMsgEl.textContent = "卓 " + (table || "--") + " の提供準備完了";
      if (hallReadyUndoToastEl) hallReadyUndoToastEl.classList.add("show");
      if (hallReadyUndoTimer) clearTimeout(hallReadyUndoTimer);
      hallReadyUndoTimer = setTimeout(hideHallReadyUndo, HALL_READY_UNDO_MS);
    }
    function hideHallReadyUndo() {
      if (hallReadyUndoTimer) { clearTimeout(hallReadyUndoTimer); hallReadyUndoTimer = null; }
      hallReadyUndoId = null;
      if (hallReadyUndoToastEl) hallReadyUndoToastEl.classList.remove("show");
    }
    /* ホールで前菜を「出した」直後の取り消し (#295)。提供済みの前菜の帯はホールで畳む (#230) ため、
       別の卓を押し間違えても帯の「長押しで戻す」に届かなかった。デザートと同じ形の「戻す」を
       HALL_READY_UNDO_MS (6秒) 出し、押されたら前菜を未提供に戻す。 */
    function showStarterUndo(id) {
      starterUndoId = String(id);
      var entry = cards[starterUndoId];
      var table = entry && entry.order ? effectiveTable(entry.order) : "";
      if (starterUndoMsgEl) starterUndoMsgEl.textContent = "卓 " + (table || "--") + " の前菜を出しました";
      if (starterUndoToastEl) starterUndoToastEl.classList.add("show");
      if (starterUndoTimer) clearTimeout(starterUndoTimer);
      starterUndoTimer = setTimeout(hideStarterUndo, HALL_READY_UNDO_MS);
    }
    function hideStarterUndo() {
      if (starterUndoTimer) { clearTimeout(starterUndoTimer); starterUndoTimer = null; }
      starterUndoId = null;
      if (starterUndoToastEl) starterUndoToastEl.classList.remove("show");
    }
    function undoStarter() {
      if (!starterUndoId) return;
      var id = starterUndoId;
      hideStarterUndo();
      if (mode !== "hall") return;   // 前菜の記録はホールだけ (#228)
      if (serveCueState(id).starter) setServeCue(id, "starter", false);
    }
    function dismissHallReady(id) {
      if (mode !== "hall") return;
      var key = String(id), snapshot = hallReadyMap[key];
      if (!snapshot || snapshot.status === "dismissed") return;
      snapshot.status = "dismissed";
      snapshot.dismissedAt = Date.now();
      saveHallReady();
      broadcastHallReady(key, snapshot);
      showHallReadyUndo(key, snapshot.table);
      renderHallViews();
    }
    function undoHallReady() {
      if (!hallReadyUndoId) return;
      if (mode !== "hall") { hideHallReadyUndo(); return; }   // 厨房側のトーストと取り違えない (#261)
      var key = hallReadyUndoId, snapshot = hallReadyMap[key];
      hideHallReadyUndo();
      if (!snapshot || snapshot.status !== "dismissed") return;
      snapshot.status = "active";
      delete snapshot.dismissedAt;
      saveHallReady();
      broadcastHallReady(key, snapshot);
      // デザート提供で消したカードも戻す。提供済みを外せば次のrenderでカードが再生成される (#260)
      if (serveCueState(key).dessert) setServeCue(key, "dessert", false);
      renderHallViews();
      poll();
    }

    /* 完了状態をカード DOM へ反映。全完了なら必要に応じてフェードアウト */
    function applyDoneToCard(entry, animateRemoval, broadcastHallReady) {
      if (!entry || !entry.el) return;
      var order = entry.order;
      var wasAllDone = isAllDone(entry);
      var saved = doneMap[order.id] || [];
      var btns = entry.el.querySelectorAll(".item");
      for (var i = 0; i < btns.length; i++) {
        var qty = Number(order.items[i].qty) || 1;
        var count = normalizeDoneCount(saved[i], qty);
        order.items[i].doneCount = count;
        order.items[i].done = count >= qty;
        updateItemButtonDone(btns[i], count, qty);
      }
      if (!isAllDone(entry)) {
        if (wasAllDone) removeLatestServeRecord(order.id);
        entry.el.classList.remove("all-done");   // 戻したら通常表示へ (#228)
        if (reconcileHallReadySnapshot(order, broadcastHallReady !== false)) renderHallViews();
        return;
      }
      /* 全品完了してもカードは消さない。ホールがデザートを出すまで残す必要があるため
         (#228)。キッチンからは CSS (body:not(.mode-hall) .card.all-done) で隠れるので、
         厨房から見た「完了したら消える」挙動は変わらない。実際に消えるのは
         デザートを出した時点 (buildServeCue の長押し)。 */
      entry.el.classList.add("all-done");
      if (animateRemoval) {
        ensureHallReadySnapshot(order);
        recordServe(entry);
      }
    }

    function removeCard(id, fade) {
      var entry = cards[id];
      if (!entry || !entry.el) { delete cards[id]; return; }
      var el = entry.el;
      delete cards[id];
      if (fade && !prefersReducedMotion()) {
        el.classList.add("removing");
        setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); reflectEmpty(); }, FADE_MS);
      } else {
        if (el.parentNode) el.parentNode.removeChild(el);
      }
    }

    function prefersReducedMotion() {
      return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    }

    /* ===================== 操作: 品目タップ ===================== */
    /* 未完了行タップ = +1。完了行タップ = qty-1 に戻す(現行「done行タップで未完了に戻る」の後継)。
       ×3→×2→×1→完了 のカウントダウンは doneCount(0..qty) で表現する (#153) */
    function onToggle(id, index) {
      if (mode === "hall") return;   // ホールは読取専用 (#259): キーボード・レーン経路もここで止める
      var entry = cards[id];
      if (!entry) return;
      var wasAllDone = isAllDone(entry);
      if (!doneMap[id]) doneMap[id] = entry.order.items.map(function (it) { return Number(it.doneCount) || 0; });
      var qty = Number(entry.order.items[index].qty) || 1;
      var cur = Number(doneMap[id][index]) || 0;
      var next = cur >= qty ? qty - 1 : cur + 1;
      next = Math.max(0, Math.min(qty, next));
      doneMap[id][index] = next;
      saveDone();                                   // LS 即時保存 (正本)
      broadcastToggle(id, index, next);             // 他タブへ同期

      entry.order.items[index].doneCount = next;
      entry.order.items[index].done = next >= qty;
      var btn = entry.el.querySelectorAll(".item")[index];
      if (btn) updateItemButtonDone(btn, next, qty);
      if (isAllDone(entry)) {
        ensureHallReadySnapshot(entry.order);
        recordServe(entry);              // #29 提供時間ログ
        // カードは消さない。ホールがデザートを出すまで残す (#228)。
        // キッチンからは CSS で隠れるので、厨房から見た挙動は従来どおり。
        entry.el.classList.add("all-done");
        showUndoToast(entry.order, index);
        scheduleKonroRelease(id);        // 「戻す」の猶予が過ぎたらコンロ・タイマーを外す (#298)
      } else if (wasAllDone) {
        removeLatestServeRecord(id);
      }
      if (view === "lane") renderLanes();   // #13 レーンから完了品目を除く
    }

    /* 長押し(0.8s)= 誤タップの戻し。doneCount -1 (0未満にはしない) (#153) */
    function onItemDecrement(id, index) {
      if (mode === "hall") return;   // ホールは読取専用 (#259): キーボード・レーン経路もここで止める
      var entry = cards[id];
      if (!entry) return;
      var wasAllDone = isAllDone(entry);
      var order = entry.order;
      var qty = Number(order.items[index].qty) || 1;
      if (!doneMap[id]) doneMap[id] = order.items.map(function (it) { return Number(it.doneCount) || 0; });
      var cur = Number(doneMap[id][index]) || 0;
      var next = Math.max(0, cur - 1);
      if (next === cur) return;   // 既に0なら何もしない
      doneMap[id][index] = next;
      saveDone();
      broadcastToggle(id, index, next);

      order.items[index].doneCount = next;
      order.items[index].done = next >= qty;
      if (wasAllDone && !isAllDone(entry)) removeLatestServeRecord(id);
      var btn = entry.el.querySelectorAll(".item")[index];
      if (btn) updateItemButtonDone(btn, next, qty);
      if (view === "lane") renderLanes();
    }

    /* ===================== 全完了の取り消しトースト ===================== */
    function showUndoToast(order, lastIndex) {
      undoInfo = { id: String(order.id), index: lastIndex };
      undoToastMsgEl.textContent = "卓 " + (effectiveTable(order) || "--") + " " + t("done");
      undoToastEl.classList.add("show");
      if (undoTimer) clearTimeout(undoTimer);
      undoTimer = setTimeout(hideUndoToast, UNDO_TOAST_MS);
    }
    function hideUndoToast() {
      undoToastEl.classList.remove("show");
      undoInfo = null;
      if (undoTimer) { clearTimeout(undoTimer); undoTimer = null; }
    }
    function undoComplete() {
      if (!undoInfo) return;
      if (mode !== "kitchen") { hideUndoToast(); return; }   // ホールでは厨房の完了undoを実行しない (#261)
      var id = undoInfo.id, idx = undoInfo.index;
      hideUndoToast();
      cancelKonroRelease(id);            // 戻した卓のコンロ・タイマーは外さない (#298)
      if (!doneMap[id]) doneMap[id] = [];
      var cur = Number(doneMap[id][idx]) || 0;
      doneMap[id][idx] = Math.max(0, cur - 1);   // 最後の1個分だけ未完了へ戻す (#153)
      saveDone();
      removeLatestServeRecord(id);
      broadcastToggle(id, idx, doneMap[id][idx]);
      poll();                            // 配膳カードを復帰させる
    }

    /* ===================== 全完了した卓のコンロ・タイマーを外す (#298) ===================== */
    /* 全完了のカードはホールでデザートを出すまで残る (#228) ため、カードの消去を待つと
       コンロ・タイマーがヘッダーに残り、別の卓の割り当てを塞いでいた。厨房で全品完了に
       してから「戻す」の猶予 (UNDO_TOAST_MS) が過ぎた時点で外す。猶予中に「戻す」されたら
       (他タブで未完了に戻された場合も) 外さない。外すのは完了操作をしたタブだけで、
       broadcastKonro (skeleton) で他タブ・中継サーバー (kds-bridge) へ伝える。
       蒸らしでタイマーを残す運用 (#161) は未決のため、ここでは扱わない。 */
    function scheduleKonroRelease(id) {
      var key = String(id);
      cancelKonroRelease(key);
      konroReleaseTimers[key] = setTimeout(function () {
        delete konroReleaseTimers[key];
        releaseKonroOfCompleted(key);
      }, UNDO_TOAST_MS);
    }
    function cancelKonroRelease(id) {
      var key = String(id);
      if (!konroReleaseTimers[key]) return;
      clearTimeout(konroReleaseTimers[key]);
      delete konroReleaseTimers[key];
    }
    function releaseKonroOfCompleted(id) {
      var key = String(id);
      var entry = cards[key];
      if (entry && !isAllDone(entry)) return;   // 未完了に戻った卓は外さない
      var nums = konroMap[key] ? Object.keys(konroMap[key]) : [];
      if (!nums.length) return;
      nums.forEach(function (num) {
        setKonroState(key, num, KONRO_DEFAULT);
        broadcastKonro(key, Number(num), KONRO_DEFAULT);
      });
      saveKonro();
      refreshAllKonro();
      updateKonroHud();
    }
    /* 知らせに使う種別の名前。HUD の列見出しと同じ (white=コンロ / red=タイマー) */
    function konroKindName(kind) {
      return kind === "red" ? t("konroHudTimer") : t("konroHudKonro");
    }

    /* ===================== 操作: コンロ番号タップ ===================== */
    function onKonroTap(id, num) {
      var cur = konroState(id, num);
      // 他卓が埋めている種別の枠は飛ばして、空いている状態へ進む (#145)。
      // ボタン自体も両方埋まっていれば disabled にしているが、同期タイミングの隙間対策で
      // ここでも判定する (#114)。進める先が無ければ何もしない。
      var next = nextKonroState(id, num, cur);
      if (next === cur) return;
      // 読み飛ばしの結果この卓の割り当てが外れるときは、どの卓が埋めているかを知らせる (#298)。
      // 例) 卓6のコンロ4を押す → タイマー4は卓3が使用中なので飛ばして「未使用」になる
      var natural = KONRO_CYCLE[cur] || KONRO_DEFAULT;
      if (cur !== KONRO_DEFAULT && next === KONRO_DEFAULT && natural !== KONRO_DEFAULT) {
        var blocker = konroOwnerId(num, id, natural);
        if (blocker) {
          showPrintToast(konroKindName(natural) + num + "は卓" + (ownerTable(blocker) || "?") +
            "が使用中のため、" + konroKindName(cur) + num + "を外しました");
        }
      }
      setKonroState(id, num, next);
      saveKonro();                                  // LS 即時保存 (正本)
      broadcastKonro(id, num, next);                // 他タブへ同期
      // この番号を全カードで再描画: 自カードの状態遷移 + 占有/解錠に伴う他カードのロック更新 (#114)
      refreshKonroNum(num);
      updateKonroHud();
    }

    /* 1つのコンロボタンへ「自カードの状態」+「他カード占有によるロック」を反映する単一の描画経路 (#114)。
       コンロ枠とタイマー枠は独立なので、**両方が他卓に埋まっている時だけ**押下不可にする。
       片方だけ埋まっている場合は押せる (タップで空いている種別へ進む) が、
       何が埋まっているかはバッジで示す (#145)。 */
    function applyKonroBtn(btn, cardId, num) {
      var st = konroState(cardId, num);                       // このカード自身の状態
      // 自分が使用中/管理中ならオーナー = ロックされない。skeleton の時だけ他カード占有を見る。
      var mine = (st === "white" || st === "red");
      var konroOwner = mine ? null : konroOwnerId(num, cardId, "white");
      var timerOwner = mine ? null : konroOwnerId(num, cardId, "red");
      btn.setAttribute("data-state", st);
      if (konroOwner && timerOwner) {                         // 進める先が無い = 従来どおりロック
        var tbl = ownerTable(konroOwner) || ownerTable(timerOwner);
        btn.setAttribute("data-locked", "true");
        btn.setAttribute("data-owner", tbl || "占");
        if (btn.hasAttribute("data-taken")) btn.removeAttribute("data-taken");
        btn.disabled = true;
        btn.setAttribute("aria-label",
          t("konro") + " " + num + " " + t("konroLocked") + (tbl ? "（卓" + tbl + "）" : ""));
      } else {
        if (btn.hasAttribute("data-locked")) btn.removeAttribute("data-locked");
        var takenOwner = konroOwner || timerOwner;
        if (takenOwner) {
          btn.setAttribute("data-taken", konroOwner ? "konro" : "timer");
          btn.setAttribute("data-owner", ownerTable(takenOwner) || "占");
        } else {
          if (btn.hasAttribute("data-taken")) btn.removeAttribute("data-taken");
          if (btn.hasAttribute("data-owner")) btn.removeAttribute("data-owner");
        }
        btn.disabled = false;
        setKonroBtnAria(btn, num, st, konroOwner, timerOwner);
      }
    }

    /* LS / BroadcastChannel から来た状態をカード全体へ反映 */
    function applyTableOverrideToCard(id) {
      var entry = cards[String(id)];
      if (!entry || !entry.el || !entry.order) return;
      var table = effectiveTable(entry.order) || "--";
      var tableEl = entry.el.querySelector(".table-no");
      if (tableEl) tableEl.textContent = table;
      entry.el.setAttribute("aria-label",
        "卓 " + table + " " + (entry.order.type === "reserved" ? t("reserved") : t("new")));
      var button = entry.el.querySelector(".table-override-btn");
      if (button) {
        var overridden = tableOverrideMap[String(id)] != null && String(tableOverrideMap[String(id)]).trim() !== "";
        button.setAttribute("data-overridden", overridden ? "true" : "false");
        button.textContent = overridden ? "卓番変更*" : "卓番";
        button.setAttribute("aria-label", overridden ? "卓番を変更（表示上書き中）" : "卓番を変更");
      }
    }

    function applyKonroToCard(id) {
      var entry = cards[id];
      if (!entry || !entry.el) return;
      var btns = entry.el.querySelectorAll(".konro-btn");
      for (var i = 0; i < btns.length; i++) {
        applyKonroBtn(btns[i], id, btns[i].getAttribute("data-num"));
      }
    }

    /* 指定番号のボタンを全カードで再描画 (占有/解錠の伝播用)。タップ・BC受信時に使う (#114) */
    function refreshKonroNum(num) {
      Object.keys(cards).forEach(function (cid) {
        var e = cards[cid];
        if (!e || !e.el) return;
        var btn = e.el.querySelector('.konro-btn[data-num="' + num + '"]');
        if (btn) applyKonroBtn(btn, cid, num);
      });
    }

    /* 全カードのコンロボタンを再描画 (掃除でオーナーが消えた後の解錠反映など) (#114) */
    function refreshAllKonro() {
      Object.keys(cards).forEach(function (cid) { applyKonroToCard(cid); });
    }

    function setKonroBtnAria(btn, num, state, konroOwner, timerOwner) {
      var stateLabel = state === "white" ? t("konroWhite")
                     : state === "red"   ? t("konroRed")
                     : t("konroSkeleton");
      // 片方の枠だけ他卓に埋まっている場合は、押せることと何が埋まっているかを読み上げる (#145)
      var taken = "";
      if (konroOwner) taken = "、" + t("konroWhite") + "は他卓（卓" + (ownerTable(konroOwner) || "?") + "）";
      else if (timerOwner) taken = "、" + t("konroRed") + "は他卓（卓" + (ownerTable(timerOwner) || "?") + "）";
      btn.setAttribute("aria-label", t("konro") + " " + num + " " + stateLabel + taken);
    }

    /* ===================== 並べ替え (長押し 0.8s で掴む → ドラッグ → 離して確定 / 取消) ===================== */
    var isReordering = false;
    var grab = null;       // { id, el, startX, startY, timer, seqBefore }
    function setReorderingClass(on) {
      isReordering = on;
      document.body.classList.toggle("is-reordering", on);
    }

    function attachReorderHandlers(card, handle, id) {
      handle.addEventListener("pointerdown", function (ev) {
        if (mode === "hall") return;                    // ホールは読取専用
        if (ev.button != null && ev.button !== 0) return;
        if (grab) return;
        var prog = card.querySelector(".grab-progress");
        var startedAt = Date.now();
        card.classList.add("grabbing-pending");
        // 進捗リングを 0.8s かけて満たす (reduced-motion でも長押し判定は機能)
        var raf = null;
        function tickProg() {
          var p = Math.min(1, (Date.now() - startedAt) / LONGPRESS_MS);
          if (prog) prog.style.width = (p * 100) + "%";
          if (p < 1 && grabPending) raf = requestAnimationFrame(tickProg);
        }
        var grabPending = true;
        if (!prefersReducedMotion()) raf = requestAnimationFrame(tickProg);

        var timer = setTimeout(function () {
          grabPending = false;
          beginGrab(id, card, ev);
        }, LONGPRESS_MS);

        function cancelPending() {
          grabPending = false;
          if (timer) clearTimeout(timer);
          if (raf) cancelAnimationFrame(raf);
          card.classList.remove("grabbing-pending");
          if (prog) prog.style.width = "0%";
          handle.removeEventListener("pointerup", cancelPending);
          handle.removeEventListener("pointermove", onMaybeMove);
          handle.removeEventListener("pointercancel", cancelPending);
        }
        function onMaybeMove(mv) {
          // 掴む前に大きく動いたらスクロール意図 -> キャンセル
          if (Math.abs(mv.clientX - ev.clientX) > 12 || Math.abs(mv.clientY - ev.clientY) > 12) cancelPending();
        }
        handle.addEventListener("pointerup", cancelPending);
        handle.addEventListener("pointermove", onMaybeMove);
        handle.addEventListener("pointercancel", cancelPending);
      });
    }

    function beginGrab(id, card, ev) {
      card.classList.remove("grabbing-pending");
      var prog = card.querySelector(".grab-progress");
      if (prog) prog.style.width = "0%";
      grab = { id: id, el: card, seqBefore: orderSeq.slice() };
      setReorderingClass(true);
      card.classList.add("grabbed");

      function onMove(mv) {
        // ポインタ直下のカードを探し、その前へ自分を差し込む (列グリッドでも DOM順=表示順)
        var target = document.elementFromPoint(mv.clientX, mv.clientY);
        if (!target) return;
        var tcard = target.closest ? target.closest(".card") : null;
        if (!tcard || tcard === card || tcard.parentNode !== boardEl) return;
        var rect = tcard.getBoundingClientRect();
        // 折り返し2D グリッド (行優先): まず行(縦)で判定、同一行なら左右の中点で前後を判定。
        var before;
        if (mv.clientY < rect.top)        before = true;     // 対象カードより上の行 -> 前
        else if (mv.clientY > rect.bottom) before = false;   // 対象カードより下の行 -> 後
        else before = mv.clientX < rect.left + rect.width / 2; // 同一行内 -> 左右の中点
        boardEl.querySelectorAll(".card.drop-target").forEach(function (n) { n.classList.remove("drop-target"); });
        tcard.classList.add("drop-target");
        if (before) boardEl.insertBefore(card, tcard);
        else boardEl.insertBefore(card, tcard.nextSibling);
      }
      function onUp() {
        document.removeEventListener("touchmove", blockScrollWhileGrabbing, { passive: false });
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        // 文言通り「離して確定」(#62)。誤操作防止として確定後数秒間「戻す」を提示する
        var snapshot = grab ? grab.seqBefore.slice() : null;
        commitReorder();
        if (snapshot) offerReorderUndo(snapshot);
      }
      // 掴み中はブラウザのスクロールを抑止する。これが無いと指を十数px動かした時点で
      // ブラウザがスクロールを引き取り pointercancel が飛び、掴んだカードが即座に外れる
      // (タッチ端末でのみ発生し、マウス操作では再現しない)。
      // .card への touch-action:none ではなく touchmove の打ち消しで行うのは、
      // カードが盤面のほぼ全面を占めるため、前者だと一覧の縦スクロール自体ができなくなるため。
      document.addEventListener("touchmove", blockScrollWhileGrabbing, { passive: false });
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    }

    /* 掴み中(grab が立っている間)のみタッチスクロールを打ち消す */
    function blockScrollWhileGrabbing(ev) {
      if (grab && ev.cancelable) ev.preventDefault();
    }

    function commitReorder() {
      if (!grab) return;
      boardEl.querySelectorAll(".card.drop-target").forEach(function (n) { n.classList.remove("drop-target"); });
      if (grab.el) grab.el.classList.remove("grabbed");
      // 現在の DOM 順を orderSeq に反映
      var next = [];
      Array.prototype.slice.call(boardEl.children).forEach(function (el) {
        var did = el.getAttribute("data-id");
        if (did != null) next.push(String(did));
      });
      orderSeq = next;
      saveOrderSeq();
      broadcastOrderSeq();
      grab = null;
      setReorderingClass(false);
    }

    function cancelReorder() {
      if (!grab) return;
      boardEl.querySelectorAll(".card.drop-target").forEach(function (n) { n.classList.remove("drop-target"); });
      if (grab.el) grab.el.classList.remove("grabbed");
      orderSeq = grab.seqBefore.slice();
      grab = null;
      setReorderingClass(false);
      saveOrderSeq();
      applyOrderSeq();      // 元の並びへ戻す
    }

    /* 確定直後の「戻す」猶予 (#62)。誤操作防止 (仕様: 長押し必須＋取消/戻る) */
    var reorderUndoSnapshot = null;
    var reorderUndoTimer = null;
    var REORDER_UNDO_MS = 6000;
    function offerReorderUndo(snapshot) {
      if (!reorderBarEl) return;
      reorderUndoSnapshot = snapshot;
      if (reorderBarMsg) reorderBarMsg.textContent = t("reorderCommitted");
      if (reorderDoneBtn) reorderDoneBtn.style.display = "none";
      if (reorderUndoBtn) reorderUndoBtn.textContent = t("restore");
      reorderBarEl.classList.add("show");
      if (reorderUndoTimer) clearTimeout(reorderUndoTimer);
      reorderUndoTimer = setTimeout(hideReorderUndoBar, REORDER_UNDO_MS);
    }
    function hideReorderUndoBar() {
      if (reorderUndoTimer) { clearTimeout(reorderUndoTimer); reorderUndoTimer = null; }
      reorderUndoSnapshot = null;
      if (reorderBarEl) reorderBarEl.classList.remove("show");
      if (reorderBarMsg) reorderBarMsg.textContent = t("reorderMsg");
      if (reorderDoneBtn) reorderDoneBtn.style.display = "";
      if (reorderUndoBtn) reorderUndoBtn.textContent = t("undo");
    }
    function undoReorderCommit() {
      if (!reorderUndoSnapshot) return;
      orderSeq = reorderUndoSnapshot.slice();
      hideReorderUndoBar();
      saveOrderSeq();
      broadcastOrderSeq();
      applyOrderSeq();
    }

    /* ===================== 予約ストック ===================== */
    function sortStock() {
      stock.sort(function (a, b) { return String(a.time).localeCompare(String(b.time)); });
    }

    function minutesUntil(timeStr) {
      // "HH:MM" を本日その時刻として、現在からの差(分)を返す
      var parts = String(timeStr || "").split(":");
      if (parts.length < 2) return Infinity;
      var d = new Date();
      d.setHours(Number(parts[0]) || 0, Number(parts[1]) || 0, 0, 0);
      var delta = (d.getTime() - Date.now()) / 60000;
      // Math.round() だと 30分00秒より少し前の予約まで「30分以内」に入り、
      // 境界の直前に炊飯cueが出る。未来は切り上げ、過去は切り下げる (#204)。
      return delta >= 0 ? Math.ceil(delta) : Math.floor(delta);
    }

    function ensureRiceCue(reservation) {
      if (!reservation || reservation.rid == null || !isRiceReservation(reservation) || minutesUntil(reservation.time) > SOON_MIN) return null;
      var rid = String(reservation.rid), state = riceCueMap[rid];
      if (!state || typeof state !== "object") {
        state = { rid: rid, status: "active", day: todayStr(), createdAt: Date.now() };
        riceCueMap[rid] = state;
        saveRiceCues();
      }
      return state;
    }
    function acknowledgeRiceCue(rid) {
      if (mode !== "kitchen") return;
      var reservation = findRes(rid), state = ensureRiceCue(reservation);
      if (!state) return;
      state.status = "acknowledged";
      state.acknowledgedAt = Date.now();
      riceCueMap[String(rid)] = state;
      saveRiceCues();
      broadcastRiceCue(rid, state);
      renderStock();
      renderHallViews();
    }
    /* 前菜/デザートcueの帯を作る (#222)。
       人数は order.people (= 大人+シニア+子供+幼児の合計。子供にも前菜を出す運用のため全員分)。 */
    function buildServeCue(orderId, kind, people) {
      var state = serveCueState(orderId);
      var served = kind === "starter" ? state.starter : state.dessert;
      var name = kind === "starter" ? "前菜" : "デザート";
      var n = Number(people) || 0;
      var cue = document.createElement("div");
      cue.className = "serve-cue" + (served ? " served" : "");
      cue.setAttribute("data-serve-kind", kind);
      cue.setAttribute("data-serve-id", String(orderId));
      var label = document.createElement("span");
      label.className = "serve-cue-label";
      label.textContent = served ? (name + " 提供済み") : (name + (n > 0 ? " ×" + n + t("people") : ""));
      /* デザートを出すと、その卓は提供完了なのでカードごと消える。取り消せないので
         前菜の「出した」(通常タップ) と違い、2秒の長押しでのみ成立させる (#229)。
         消した直後は既存の「戻す」トーストで戻せる。 */
      /* キッチンは閲覧専用 (#228 の権限分けは維持)。押せないボタンを置くより、
         帯だけ出して操作要素を作らないほうが誤解がない。 */
      if (mode !== "hall") {
        cue.classList.add("readonly");
        cue.appendChild(label);
        return cue;
      }
      var dessertServe = (kind === "dessert" && !served);
      var button = document.createElement("button");
      button.type = "button";
      button.textContent = served ? "長押しで戻す" : (dessertServe ? "長押しで出した" : "出した");
      button.setAttribute("aria-label",
        (served ? name + "の提供済みを取り消す（2秒長押し）"
                : (dessertServe ? name + "を出して卓を完了する（2秒長押し）" : name + "を出したことを記録する")));
      cue.appendChild(label);
      cue.appendChild(button);
      if (served || dessertServe) {
        var progress = document.createElement("div");
        progress.className = "serve-cue-progress";
        cue.appendChild(progress);
        attachServeHoldHandlers(cue, button, progress, SERVE_REVERT_MS, served
          ? function () { setServeCue(orderId, kind, false); }
          : function () {
              setServeCue(orderId, "dessert", true);
              dismissHallReady(orderId);   // 提供準備完了パネル側のcueも閉じる
              removeCard(orderId, /*fade*/ true);   // 卓の提供が終わったのでカードを消す
            });
      } else {
        button.addEventListener("click", function () {
          if (serveCueSuppressClick) { serveCueSuppressClick = false; return; }
          setServeCue(orderId, kind, true);
          if (kind === "starter") showStarterUndo(orderId);   // 押し間違いを6秒だけ戻せるようにする (#295)
        });
      }
      return cue;
    }

    /* 提供済みの取消を SERVE_REVERT_MS の長押しでのみ成立させる (#222)。
       閾値12pxで動かしたら取消 = スクロール意図とみなす点は attachItemHandlers と揃える。
       キーボード操作では長押しできないため、Enter/Space は confirm で代替する。 */
    /* cue の長押し。ms 経過で onHold を呼ぶ。取消とデザートの提供で共用する (#229)。 */
    function attachServeHoldHandlers(cue, button, progress, ms, onHold) {
      var timer = null, raf = null, startX = 0, startY = 0, pressing = false;
      function stop() {
        if (!pressing) return;   // 二重解除で guard を余分に戻さない
        pressing = false;
        endHold();
        document.removeEventListener("pointerup", stop, true);
        document.removeEventListener("pointercancel", stop, true);
        if (timer) { clearTimeout(timer); timer = null; }
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        cue.classList.remove("reverting");
        progress.style.width = "0%";
      }
      button.addEventListener("pointerdown", function (ev) {
        if (ev.button != null && ev.button !== 0) return;
        startX = ev.clientX; startY = ev.clientY;
        pressing = true;
        beginHold();
        // ボタンの外で離しても確実に止める
        document.addEventListener("pointerup", stop, true);
        document.addEventListener("pointercancel", stop, true);
        var startedAt = Date.now();
        cue.classList.add("reverting");
        function tick() {
          if (!pressing) return;
          var p = Math.min(1, (Date.now() - startedAt) / ms);
          progress.style.width = (p * 100) + "%";
          if (p < 1) raf = requestAnimationFrame(tick);
        }
        if (!prefersReducedMotion()) raf = requestAnimationFrame(tick);
        timer = setTimeout(function () {
          stop();
          serveCueSuppressClick = true;   // 指を離したときの click を捨てる
          onHold();
        }, ms);
      });
      button.addEventListener("pointermove", function (ev) {
        if (!pressing) return;
        if (Math.abs(ev.clientX - startX) > 12 || Math.abs(ev.clientY - startY) > 12) stop();
      });
      button.addEventListener("pointerup", stop);
      button.addEventListener("pointercancel", stop);
      button.addEventListener("pointerleave", stop);
      // 短いタップでは成立させない。click は長押し成立時にも発火するので常に潰す
      button.addEventListener("click", function (ev) { ev.preventDefault(); });
      /* キーボードでは長押しを判定できない (キーリピートに依存する) ため、削除ボタン (#68) と
         同じ2段階確認にする。ネイティブ confirm() はメインスレッドを塞いでポーリングと
         経過時間更新まで止めるので使わない。 */
      var armTimer = null;
      var restLabel = button.textContent;
      function disarm() {
        if (armTimer) { clearTimeout(armTimer); armTimer = null; }
        button.classList.remove("armed");
        button.textContent = restLabel;
      }
      button.addEventListener("keydown", function (ev) {
        if (ev.key !== "Enter" && ev.key !== " ") return;
        ev.preventDefault();
        if (button.classList.contains("armed")) { disarm(); onHold(); return; }
        button.classList.add("armed");
        button.textContent = "もう一度で確定";
        if (armTimer) clearTimeout(armTimer);
        armTimer = setTimeout(disarm, DELETE_ARM_MS);
      });
      button.addEventListener("blur", disarm);
    }


    function buildRiceCue(reservation) {
      var state = ensureRiceCue(reservation);
      if (!state) return null;
      var cue = document.createElement("div");
      cue.className = "hall-cue rice-cue" + (state.status === "acknowledged" ? " acknowledged" : "");
      cue.setAttribute("data-rid", String(reservation.rid));
      var label = document.createElement("span");
      label.textContent = state.status === "acknowledged" ? "炊飯準備（確認済み）" : "炊飯準備";
      cue.appendChild(label);
      if (mode === "kitchen" && state.status !== "acknowledged") {
        var button = document.createElement("button");
        button.type = "button";
        button.textContent = "確認";
        button.setAttribute("aria-label", "炊飯準備を確認");
        button.addEventListener("click", function (ev) {
          ev.stopPropagation();
          acknowledgeRiceCue(reservation.rid);
        });
        cue.appendChild(button);
      }
      return cue;
    }

    function renderStock() {
      sortStock();
      pruneRiceCues();
      // 卓番の下書きは seatDrafts (非DOM) が正本なので、全再描画してもボタン表示に自動で反映される (#118)
      stockCountEl.textContent = String(stock.length);
      stockListEl.innerHTML = "";
      if (!stock.length) {
        var em = document.createElement("div");
        em.className = "stock-empty";
        em.textContent = t("stockEmpty");
        stockListEl.appendChild(em);
        updateHud();
        return;
      }
      stock.forEach(function (r) {
        stockListEl.appendChild(buildResCard(r));
      });
      updateStockSoon();
    }

    function buildResCard(r) {
      var el = document.createElement("article");
      el.className = "res-card";
      el.setAttribute("data-rid", String(r.rid));

      var soon = document.createElement("span");
      soon.className = "res-soon-badge";
      soon.textContent = t("soon");

      var top = document.createElement("div");
      top.className = "res-top";
      var time = document.createElement("span");
      time.className = "res-time";
      time.textContent = r.time || "--:--";
      var people = document.createElement("span");
      people.className = "res-people";
      var breakdown = peopleBreakdown(r);
      var kidsStr = breakdown ? '<span class="kids">' + breakdown + "</span>" : "";
      people.innerHTML = '<span class="n">' + peopleTotal(r) + "</span>" + t("people") + kidsStr;
      top.appendChild(time);
      top.appendChild(people);

      var name = document.createElement("div");
      name.className = "res-name";
      name.textContent = r.name || "—";

      var menu = document.createElement("ul");
      menu.className = "res-menu";
      (r.menu || []).forEach(function (m) {
        var li = document.createElement("li");
        li.textContent = m.name;
        var q = document.createElement("span");
        q.className = "q";
        q.textContent = "×" + (Number(m.qty) || 1);
        li.appendChild(q);
        menu.appendChild(li);
      });
      var reservationNotes = buildReservationNotes(r, "reservation-notes");

      var riceCue = buildRiceCue(r);

      var actions = document.createElement("div");
      actions.className = "res-actions";
      // 卓番はフリーテキスト入力ではなくダイヤルモーダルで選択 (誤入力防止 #118)
      var seat = document.createElement("button");
      seat.type = "button";
      seat.className = "res-seat";
      var seatDraft = seatDrafts[String(r.rid)];
      if (seatDraft) { seat.textContent = seatDraft; }
      else { seat.textContent = t("seatPh"); seat.classList.add("placeholder"); }
      seat.setAttribute("aria-label", t("seatPh"));
      seat.addEventListener("click", function () { openSeatDial(r.rid); });
      var go = document.createElement("button");
      go.type = "button";
      go.className = "res-go";
      go.textContent = t("go");
      go.addEventListener("click", function () { moveResToMain(r.rid, seatDrafts[String(r.rid)]); });
      var del = document.createElement("button");
      del.type = "button";
      del.className = "res-del";
      del.setAttribute("aria-label", t("del"));
      del.textContent = "×";
      /* 予約の「×」は「調理開始」の隣にあり、1回押すだけで消えていた (#295)。
         注文削除 (#68) と同じ2段階にする: 1回目で「削除?」、DELETE_ARM_MS 内にもう一度で消す。 */
      var delArmTimer = null;
      function disarmResDelete() {
        if (delArmTimer) { clearTimeout(delArmTimer); delArmTimer = null; }
        del.classList.remove("armed");
        del.textContent = "×";
        del.setAttribute("aria-label", t("del"));
      }
      del.addEventListener("click", function () {
        if (del.classList.contains("armed")) {
          disarmResDelete();
          deleteRes(r.rid);
          return;
        }
        del.classList.add("armed");
        del.textContent = "削除?";
        del.setAttribute("aria-label", "もう一度タップで予約を削除");
        if (delArmTimer) clearTimeout(delArmTimer);
        delArmTimer = setTimeout(disarmResDelete, DELETE_ARM_MS);
      });
      actions.appendChild(seat);
      actions.appendChild(go);
      actions.appendChild(del);

      el.appendChild(soon);
      el.appendChild(top);
      el.appendChild(name);
      if ((r.menu || []).length) el.appendChild(menu);
      if (reservationNotes) el.appendChild(reservationNotes);
      if (riceCue) el.appendChild(riceCue);
      el.appendChild(actions);
      return el;
    }

    /* 30分前通知: 該当カードに .soon を付ける (毎分更新)。
       予約時刻を過ぎたら .late に切り替え「超過 +N分」を表示 (黙って消さない) */
    function updateStockSoon() {
      var nodes = stockListEl.querySelectorAll(".res-card");
      for (var i = 0; i < nodes.length; i++) {
        var rid = nodes[i].getAttribute("data-rid");
        var r = findRes(rid);
        if (!r) continue;
        var mu = minutesUntil(r.time);
        var isLate = mu < 0;
        nodes[i].classList.toggle("soon", !isLate && mu <= SOON_MIN);
        nodes[i].classList.toggle("late", isLate);
        var badge = nodes[i].querySelector(".res-soon-badge");
        if (badge) badge.textContent = isLate ? ("超過 +" + (-mu) + t("min")) : t("soon");
      }
      updateHud();
    }

    function findRes(rid) {
      rid = String(rid);
      for (var i = 0; i < stock.length; i++) if (String(stock[i].rid) === rid) return stock[i];
      return null;
    }

    /* ===================== #155 ホールA/B/C prototype ===================== */
    function validHallLayout(value) {
      return HALL_LAYOUTS.indexOf(String(value)) !== -1;
    }
    function replaceHallHash(value) {
      try {
        if (window.history && typeof window.history.replaceState === "function") {
          window.history.replaceState(window.history.state, "", "#hall=" + value);
        } else if (window.location) {
          window.location.hash = "hall=" + value;
        }
      } catch (e) {}
    }
    function loadHallLayout() {
      var hash = "";
      try { hash = String(window.location && window.location.hash || ""); } catch (e) {}
      var hashMatch = /^#hall=([^#&]+)$/.exec(hash);
      if (hashMatch) {
        hallLayout = validHallLayout(hashMatch[1]) ? hashMatch[1] : "A";
        if (!validHallLayout(hashMatch[1])) replaceHallHash(hallLayout); // 無効hashはAへ正規化
      } else {
        var stored = null;
        try { stored = localStorage.getItem(LS_HALL_PROTO); } catch (e2) {}
        hallLayout = validHallLayout(stored) ? stored : "A";
      }
      lsSet(LS_HALL_PROTO, hallLayout);
      applyHallLayout();
    }
    function applyHallLayout() {
      /* 無効時は hall-proto-on を外すだけでよい。A/B/Cのクラス付与も含め以降の処理は
         そのまま走らせておく（フラグを true に戻せば即座に元の挙動へ戻せるようにする）。 */
      document.body.classList.toggle("hall-proto-on", HALL_PROTO_ENABLED);
      HALL_LAYOUTS.forEach(function (layout) {
        document.body.classList.toggle("hall-proto-" + layout.toLowerCase(), hallLayout === layout);
      });
      hallProtoBtns.forEach(function (button) {
        button.setAttribute("aria-pressed", button.getAttribute("data-hall-layout") === hallLayout ? "true" : "false");
      });
    }
    function setHallLayout(next) {
      if (!validHallLayout(next)) next = "A";
      hallLayout = String(next);
      lsSet(LS_HALL_PROTO, hallLayout);
      replaceHallHash(hallLayout);
      applyHallLayout();
      renderHallViews();
    }
    function hallLiveOrders() {
      var ids = orderSeq.filter(function (id) { return !!cards[id]; });
      Object.keys(cards).forEach(function (id) { if (ids.indexOf(id) === -1) ids.push(id); });
      return ids.map(function (id) { return cards[id] && cards[id].order; }).filter(Boolean);
    }
    function hallEmptyNode(message) {
      var empty = document.createElement("div");
      empty.className = "hall-empty";
      empty.textContent = message || "該当なし";
      return empty;
    }
    function buildHallOrderCard(order, compact) {
      var card = document.createElement("article");
      card.className = "hall-order-card" + (order.type === "reserved" ? " reserved" : "") + (compact ? " compact" : "");
      var top = document.createElement("div");
      top.className = "hall-order-top";
      var table = document.createElement("span");
      table.className = "hall-order-table";
      table.textContent = effectiveTable(order) || "--";
      var kind = document.createElement("span");
      kind.className = "hall-order-kind";
      kind.textContent = order.type === "reserved" ? t("reserved") : t("new");
      var elapsed = document.createElement("span");
      elapsed.className = "hall-order-elapsed";
      elapsed.textContent = elapsedMin(order.start) + t("min");
      // チビ伝はホールが出す (#226)。ホールモードでは進行中カードごと
      // ホール専用ビューへ差し替わるため、伝ボタンもこちらに持たせる
      var hallSlipBtn = document.createElement("button");
      hallSlipBtn.type = "button";
      hallSlipBtn.className = "slip-btn js-slip-btn";
      decorateSlipButton(hallSlipBtn, order);
      top.appendChild(table); top.appendChild(kind); top.appendChild(elapsed);
      top.appendChild(hallSlipBtn);
      card.appendChild(top);
      var list = document.createElement("ul");
      list.className = "hall-order-items";
      (order.items || []).forEach(function (item) {
        var li = document.createElement("li");
        var remaining = Math.max((Number(item.qty) || 1) - (Number(item.doneCount) || 0), 0);
        li.textContent = String(item.name || "") + (compact ? " ×" + remaining : "");
        if (!compact && item.done) li.textContent += "（完了）";
        list.appendChild(li);
      });
      var orderNotes = buildReservationNotes(order, "order-notes");
      // 前菜はホールが出すので、ホールの進行中カードにも同じcueを出す (#222)
      card.appendChild(buildServeCue(order.id, "starter", order.people));
      card.appendChild(list);
      if (orderNotes) card.appendChild(orderNotes);
      return card;
    }
    function buildHallStockCard(reservation) {
      var card = document.createElement("article");
      card.className = "hall-stock-card reserved";
      var top = document.createElement("div");
      top.className = "hall-stock-top";
      var time = document.createElement("span");
      time.className = "hall-stock-time";
      time.textContent = reservation.time || "--:--";
      var people = document.createElement("span");
      people.className = "hall-stock-name";
      people.textContent = (reservation.name || "—") + " " + peopleTotal(reservation) + t("people");
      top.appendChild(time); top.appendChild(people); card.appendChild(top);
      var list = document.createElement("ul");
      list.className = "hall-stock-menu";
      (reservation.menu || []).forEach(function (item) {
        var li = document.createElement("li");
        li.textContent = String(item.name || "") + " ×" + (Number(item.qty) || 1);
        list.appendChild(li);
      });
      card.appendChild(list);
      var reservationNotes = buildReservationNotes(reservation, "reservation-notes");
      if (reservationNotes) card.appendChild(reservationNotes);
      var cue = buildRiceCue(reservation);
      if (cue) card.appendChild(cue);
      return card;
    }
    function buildHallReadyCard(snapshot) {
      var card = document.createElement("article");
      card.className = "hall-ready-card" + (snapshot.status === "dismissed" ? " dismissed" : "");
      var top = document.createElement("div");
      top.className = "hall-ready-top";
      var table = document.createElement("span");
      table.className = "hall-ready-table";
      table.textContent = snapshot.table || "--";
      var time = document.createElement("span");
      time.className = "hall-ready-time";
      time.textContent = snapshot.status === "dismissed" ? "対応済み" : "提供準備完了";
      top.appendChild(table); top.appendChild(time); card.appendChild(top);
      var list = document.createElement("ul");
      list.className = "hall-ready-items";
      (snapshot.items || []).forEach(function (item) {
        var li = document.createElement("li");
        li.textContent = String(item.name || "") + " ×" + (Number(item.qty) || 1);
        list.appendChild(li);
      });
      card.appendChild(list);
      // 膳を出し終えた直後がデザートのタイミング (#222)
      card.appendChild(buildServeCue(snapshot.orderId || snapshot.id, "dessert", snapshot.people));
      var actions = document.createElement("div");
      actions.className = "hall-ready-actions";
      var dismiss = document.createElement("button");
      dismiss.type = "button";
      dismiss.textContent = "確認して消す";
      dismiss.setAttribute("aria-label", "卓 " + (snapshot.table || "--") + " の提供準備完了を確認");
      dismiss.addEventListener("click", function () { dismissHallReady(snapshot.orderId || snapshot.id); });
      actions.appendChild(dismiss); card.appendChild(actions);
      return card;
    }
    function renderHallStockPanel(panel, countEl) {
      if (!panel) return;
      panel.innerHTML = "";
      if (countEl) countEl.textContent = String(stock.length);
      if (!stock.length) { panel.appendChild(hallEmptyNode(t("stockEmpty"))); return; }
      sortStock();
      stock.forEach(function (reservation) { panel.appendChild(buildHallStockCard(reservation)); });
    }
    function renderHallOrderPanel(panel, countEl, compact) {
      if (!panel) return;
      panel.innerHTML = "";
      var orders = hallLiveOrders();
      if (countEl) countEl.textContent = String(orders.length);
      if (!orders.length) panel.appendChild(hallEmptyNode("進行中オーダーはありません"));
      else orders.forEach(function (order) { panel.appendChild(buildHallOrderCard(order, compact)); });
      // A/Bでは2ペイン構成を保ちながら、hall-ready cueを常時ホールへ提示する。
      if (panel.id === "hallAOrders" || panel.id === "hallBOrders") {
        var readyWrap = document.createElement("div");
        readyWrap.className = "hall-ready-inline";
        Object.keys(hallReadyMap).map(function (id) { return hallReadyMap[id]; }).filter(function (snapshot) {
          return snapshot && snapshot.orderId != null && snapshot.status === "active";
        }).forEach(function (snapshot) { readyWrap.appendChild(buildHallReadyCard(snapshot)); });
        if (readyWrap.children.length) panel.appendChild(readyWrap);
      }
    }
    function renderHallReadyPanel() {
      var panel = document.getElementById("hallCReady");
      var countEl = document.getElementById("hallCReadyCount");
      if (!panel) return;
      panel.innerHTML = "";
      // dismissed は当日中の再通知を止めるtombstoneとして保存するが、cue面からは消す。
      var snapshots = Object.keys(hallReadyMap).map(function (id) { return hallReadyMap[id]; }).filter(function (x) {
        return x && x.orderId != null && x.status === "active";
      });
      snapshots.sort(function (a, b) { return Number(b.completedAt) - Number(a.completedAt); });
      if (countEl) countEl.textContent = String(snapshots.length);
      if (!snapshots.length) { panel.appendChild(hallEmptyNode("提供準備完了はありません")); return; }
      snapshots.forEach(function (snapshot) { panel.appendChild(buildHallReadyCard(snapshot)); });
    }
    function renderHallViews() {
      if (!hallProtoViewEl) return;
      // 長押し中は作り直さない。離した時点で endHold がここを呼び直す (#229)
      if (holdGuard > 0) { hallRenderPending = true; return; }
      applyHallLayout();
      /* 試作が無効な間は非表示DOMを組み直すだけ無駄になるため描画を打ち切る。
         呼び出し側は変更していないので、フラグを true に戻せばそのまま再開する。 */
      if (!HALL_PROTO_ENABLED) return;
      renderHallOrderPanel(document.getElementById("hallAOrders"), document.getElementById("hallACount"), false);
      renderHallStockPanel(document.getElementById("hallAStock"), document.getElementById("hallAStockCount"));
      renderHallStockPanel(document.getElementById("hallBStock"), document.getElementById("hallBStockCount"));
      renderHallOrderPanel(document.getElementById("hallBOrders"), document.getElementById("hallBCount"), true);
      renderHallReadyPanel();
      renderHallStockPanel(document.getElementById("hallCStock"), document.getElementById("hallCStockCount"));
      renderHallOrderPanel(document.getElementById("hallCOrders"), document.getElementById("hallCCount"), true);
    }

    /* 端末で片づけた予約を bridge の取込済み(seen)に載せ、サーバーにまだ残っていても復活させない。
       「＋」で入れて中継サーバーへ送った予約が、次の /api/stock 取得より前に片づけられた場合に効く (#292)。
       サーバーに無い予約を載せても、mergeStock は端末に無い rid を消しも足しもしないので害はない */
    function markResSeen(rid) {
      var seen = safeParse(localStorage.getItem(LS_BRIDGE_SEEN), {});
      if (!seen || typeof seen !== "object" || Array.isArray(seen)) seen = {};
      if (seen[rid]) return;
      seen[rid] = 1;
      lsSet(LS_BRIDGE_SEEN, JSON.stringify(seen));
    }

    function deleteRes(rid) {
      rid = String(rid);
      markResSeen(rid);
      stock = stock.filter(function (r) { return String(r.rid) !== rid; });
      delete seatDrafts[rid];
      saveStock();
      broadcastStock();
      renderStock();
    }

    /* 来店 → メイン配膳へ (予約→進行中)。席番(卓番)入力必須 */
    function moveResToMain(rid, seat) {
      var r = findRes(rid);
      if (!r) return;
      seat = String(seat || "").trim();
      if (!seat) {
        // 卓番未入力ならダイヤルモーダルを開いて入力を促す (#118)
        openSeatDial(rid);
        return;
      }
      // 予約 → 進行中オーダー (type:"reserved" として配膳カード化)
      var order = {
        id: "res-" + r.rid,
        table: seat,
        type: "reserved",
        start: Date.now(),
        people: peopleTotal(r),
        adults: Number(r.adults) || 0,   // 内訳を保持 (配膳カードで「N名 大a シs 子c 幼k」表示)
        seniors: Number(r.seniors) || 0,
        children: Number(r.children) || 0,
        kids: Number(r.kids) || 0,
        // 予約由来の安全情報・要望を、進行中カードにも引き継ぐ。
        allergies: r.allergies || null,
        request: r.request || null,
        memo: r.memo || null,
        items: (r.menu || []).map(function (m) {
          return {
            name: m.name,
            qty: Number(m.qty) || 1,
            options: m.options || null,
            allergies: m.allergies || m.allergy || m.allergyInfo || null,
            done: false
          };
        })
      };
      ensureOrderInBus(order);
      // ストックから除去
      markResSeen(String(rid));
      stock = stock.filter(function (x) { return String(x.rid) !== String(rid); });
      delete seatDrafts[String(rid)];
      saveStock();
      renderStock();
      broadcastMoveToMain(order);
      poll();   // 即時に配膳カードを出す
    }

    /* window.KDS_ORDERS に order を投入 (データ契約維持。重複は上書き) */
    function ensureOrderInBus(order) {
      if (!Array.isArray(window.KDS_ORDERS)) window.KDS_ORDERS = [];
      var idx = -1;
      for (var i = 0; i < window.KDS_ORDERS.length; i++) {
        if (String(window.KDS_ORDERS[i].id) === String(order.id)) { idx = i; break; }
      }
      if (idx >= 0) window.KDS_ORDERS[idx] = order;
      else window.KDS_ORDERS.push(order);
    }

    /* ===================== 予約追加フォーム (モーダル) ===================== */
    function buildMenuPick() {
      menuPickEl.innerHTML = "";
      MENU_OPTIONS.forEach(function (name, i) {
        var row = document.createElement("div");
        row.className = "row";
        var label = document.createElement("label");
        var cb = document.createElement("input");
        cb.type = "checkbox";
        cb.setAttribute("data-menu", name);
        cb.id = "menu_" + i;
        var span = document.createElement("span");
        span.textContent = name;
        label.htmlFor = cb.id;
        label.appendChild(cb);
        label.appendChild(span);
        var qty = document.createElement("input");
        qty.type = "number";
        qty.min = "1"; qty.max = "20"; qty.value = "1";
        qty.disabled = true;
        qty.setAttribute("aria-label", name + " 個数");
        cb.addEventListener("change", function () { qty.disabled = !cb.checked; });
        row.appendChild(label);
        row.appendChild(qty);
        menuPickEl.appendChild(row);
      });
    }

    function openModal() {
      formErrorEl.textContent = "";
      resForm.reset();
      buildMenuPick();
      // デフォルト時刻 = 現在+30分
      var d = new Date(Date.now() + 30 * 60000);
      document.getElementById("resTime").value = pad2(d.getHours()) + ":" + pad2(d.getMinutes());
      document.getElementById("resAdults").value = "2";
      document.getElementById("resKids").value = "0";
      document.body.classList.add("modal-open");
      var ti = document.getElementById("resTime");
      if (ti && ti.focus) ti.focus();
    }
    function closeModal() { document.body.classList.remove("modal-open"); }

    /* フォーカストラップ (#69): aria-modal はマークアップだけではフォーカスを閉じ込めないため、
       Tab/Shift+Tab をダイアログ内で循環させる。予約追加モーダル・チビ伝プレビュー・卓番ダイヤルに適用 */
    function trapModalFocus(e) {
      if (e.key !== "Tab") return;
      var container = document.body.classList.contains("seat-dial-open") ? seatBackdrop
                    : document.body.classList.contains("table-override-confirm-open") ? tableOverrideConfirmBackdrop
                    : document.body.classList.contains("modal-open") ? modalBackdrop
                    : null;
      if (!container) return;
      var nodes = container.querySelectorAll(
        'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])');
      var list = [];
      for (var i = 0; i < nodes.length; i++) {
        if (!nodes[i].disabled && nodes[i].offsetParent !== null) list.push(nodes[i]);
      }
      if (!list.length) return;
      var first = list[0], last = list[list.length - 1];
      var active = document.activeElement;
      if (!container.contains(active)) { e.preventDefault(); first.focus(); return; }
      if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    }

    function submitRes(ev) {
      ev.preventDefault();
      var time = document.getElementById("resTime").value;
      var adults = Number(document.getElementById("resAdults").value) || 0;
      var kids = Number(document.getElementById("resKids").value) || 0;
      var name = String(document.getElementById("resName").value || "").trim();
      if (!time) { formErrorEl.textContent = t("errTime"); return; }
      var menu = [];
      var rows = menuPickEl.querySelectorAll(".row");
      for (var i = 0; i < rows.length; i++) {
        var cb = rows[i].querySelector('input[type="checkbox"]');
        var qn = rows[i].querySelector('input[type="number"]');
        if (cb && cb.checked) menu.push({ name: cb.getAttribute("data-menu"), qty: Math.max(1, Number(qn.value) || 1) });
      }
      if (!menu.length) { formErrorEl.textContent = t("errMenu"); return; }
      var item = {
        rid: "r" + Date.now() + "_" + Math.floor(Math.random() * 1000),
        time: time, adults: adults, kids: kids, name: name, menu: menu
      };
      stock.push(item);
      saveStock();
      broadcastStock();
      renderStock();
      closeModal();
      saveResToRelay(item);
    }

    /* 「＋」の予約を中継サーバー(POST /api/reservations)にも保存し、厨房の他の端末へ /api/stock 経由で出す (#292)。
       端末で振った rid をそのままサーバーへ渡すので、次の /api/stock 取得でも同じ rid になり二重に並ばない。
       保存に失敗(file://・503・通信断)しても端末ローカルには残す。ただし他の端末には出ないので、その旨を必ず表示する。 */
    function saveResToRelay(item) {
      var failMsg = "中継サーバーに保存できませんでした。この端末だけの予約です(他の端末には出ません)";
      if (typeof fetch !== "function") { showPrintToast(failMsg); return Promise.resolve(false); }
      var d = new Date();
      var hm = String(item.time).split(":");
      d.setHours(Number(hm[0]) || 0, Number(hm[1]) || 0, 0, 0);   // フォームに日付欄は無いので当日扱い
      var off = -d.getTimezoneOffset(), sign = off < 0 ? "-" : "+";
      off = Math.abs(off);
      var startAt = d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + "T" +
        pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":00" + sign + pad2(Math.floor(off / 60)) + ":" + pad2(off % 60);
      return fetch("/api/reservations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rid: item.rid, startAt: startAt, adults: item.adults, kids: item.kids,
          name: item.name, menu: item.menu
        })
      }).then(function (res) {
        return res.json().catch(function () { return null; }).then(function (data) {
          if (!res.ok || !data || !data.ok) throw new Error((data && data.error) || ("HTTP " + res.status));
        });
      }).then(function () {
        /* ここでは seen に載せない。POST より前に出た /api/stock の応答が後から届くと、
           「取込済みなのにサーバーから消えた」と見なされて入れたばかりの予約が消えるため。
           次の取得より前の来店・削除で復活しないようにする印は markResSeen が付ける */
        return true;
      }).catch(function (err) {
        console.error("[予約ストック] 中継サーバーへの保存に失敗:", err);
        showPrintToast(failMsg);
        return false;
      });
    }

    /* ===================== チビ伝印刷 (簡易プレビュー + 実機印刷/window.printフォールバック #144) ===================== */

    /* 印刷スタイル (slip-style-designer.html で設定した JSON) を読む。
       設定が無い・壊れている場合は null を返し、従来の見た目のまま表示する */
    function loadSlipStyle() {
      try {
        var raw = localStorage.getItem(LS_SLIP_STYLE);
        if (!raw) return null;
        var st = JSON.parse(raw);
        return (st && typeof st === "object") ? st : null;
      } catch (e) { return null; }
    }

    /* スタイルはサーバー保存(/api/slip-style)が正。どの端末で設定してもKDS全端末に反映される。
       取得できたら localStorage キャッシュを更新し、伝票を開いていれば即座に再適用する */
    /* 呼び出し側が完了を待てるよう Promise を返す。印刷は最新の書式で行いたいが、
       投げっぱなしにすると localStorage の古い書式のまま組んでしまう (#230)。 */
    function refreshSlipStyleFromServer() {
      if (typeof fetch !== "function") return Promise.resolve();
      return fetch("/api/slip-style").then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      }).then(function (st) {
        if (!st || typeof st !== "object" || Object.keys(st).length === 0) return;
        var next = JSON.stringify(st);
        var prev = null;
        try { prev = localStorage.getItem(LS_SLIP_STYLE); } catch (e) {}
        if (next === prev) return;   // 変化なし
        lsSet(LS_SLIP_STYLE, next);
      }).catch(function () { /* サーバー未経由(file://等)ではlocalStorageのまま動く */ });
    }

    /* 数量表記 (設定ツールの qtyFormat に対応。未設定は従来の「×N」) */
    function slipQtyText(st, qty) {
      if (!st) return "×" + qty;
      if (st.qtyFormat === "kosuu") return qty + " 個";
      if (st.qtyFormat === "x") return "x " + qty;
      return "× " + qty;
    }

    /* 設定JSONをプレビューDOM/印刷CSSへ反映する (実機ESC/POSと違いブラウザ側はpx指定をそのまま使える) */
    function applySlipStyle(st) {
      slipStoreEl.style.display = (!st || st.storeShow !== false) ? "" : "none";
      slipMetaEl.style.display = (!st || st.metaShow !== false) ? "" : "none";
      if (!st) {
        slipStoreEl.style.fontSize = slipStoreEl.style.letterSpacing = "";
        slipTableEl.style.fontSize = slipTableEl.style.fontWeight = "";
        slipMetaEl.style.fontSize = "";
        slipItemsEl.style.borderTopStyle = slipItemsEl.style.borderBottomStyle = "";
        slipPageStyleEl.textContent = "";
        return;
      }
      if (st.storeSize) slipStoreEl.style.fontSize = st.storeSize + "px";
      slipStoreEl.style.letterSpacing = st.storeWide === false ? "normal" : "";
      if (st.tableSize) slipTableEl.style.fontSize = st.tableSize + "px";
      slipTableEl.style.fontWeight = st.tableBold === false ? "400" : "900";
      if (st.metaSize) slipMetaEl.style.fontSize = st.metaSize + "px";
      slipItemsEl.style.borderTopStyle = st.sepTop === "none" ? "hidden" : (st.sepTop || "dashed");
      slipItemsEl.style.borderBottomStyle = st.sepBottom === "none" ? "hidden" : (st.sepBottom || "dashed");
      var w = st.paperWidth === 58 ? 58 : 80;
      slipPageStyleEl.textContent =
        "@page { size: " + w + "mm auto; margin: 0; }\n" +
        "@media print { .slip { width: " + w + "mm !important; } }";
    }

    /* 自由配置レイアウトの描画エンジンが使えるか (slip-renderer.js を読めていて、
       かつ保存されている設定が v3 レイアウトのとき)。旧設定・単体起動では null */
    function slipTemplate() {
      if (!window.SlipRenderer) return null;
      var st = loadSlipStyle();
      return window.SlipRenderer.isTemplate(st) ? window.SlipRenderer.normalizeTemplate(st) : null;
    }

    /* KDSの注文 → 描画エンジンが受け取る注文オブジェクト (差込フィールドの実データ) */
    function slipOrderData(order) {
      var now = new Date();
      var pad = function (n) { return (n < 10 ? "0" : "") + n; };
      return {
        store: slipStoreEl.textContent,
        table: effectiveTable(order) || "--",
        meta: hhmm(order.start),
        metaDate: (function () {                       // 受付「日」。日を跨いだ卓かどうかが伝票で分かるように
          var d = new Date(order.start);
          return isNaN(d.getTime()) ? "" : (d.getMonth() + 1) + "/" + d.getDate();
        })(),
        people: order.people != null ? String(order.people) : "",
        kind: order.type === "reserved" ? t("reserved") : t("new"),
        orderNo: order.id != null ? String(order.id) : "",
        date: now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate()),
        time: pad(now.getHours()) + ":" + pad(now.getMinutes()),
        items: (order.items || []).map(function (it) {
          return { name: it.name, qty: Number(it.qty) || 1, note: itemNotesText(it) };
        }),
      };
    }

    /* 印字用の .slip DOM を組み立てる。画面には出さない。
       伝票はプレビューを持たず長押し印刷だけなので、常にここだけを使う (#224)。 */
    function populateSlip(order) {
      currentSlipOrder = order;
      refreshSlipStyleFromServer();   // 最新のサーバー保存スタイルを取得(到着したら開いたまま再適用)

      // 自由配置レイアウトがあるときは、印字画像そのものをプレビューする
      // (フォーマッターの見た目・KDSのプレビュー・実際の紙の3つが必ず一致する)
      var tpl = slipTemplate();
      document.body.classList.toggle("slip-tpl", !!tpl);
      if (tpl) {
        var w = tpl.paperWidth === 58 ? 58 : 80;
        slipPageStyleEl.textContent =
          "@page { size: " + w + "mm auto; margin: 0; }\n" +
          "@media print { .slip { width: " + w + "mm !important; } }";
        window.SlipRenderer.renderToCanvas(slipCanvasEl, tpl, slipOrderData(order));
        return;
      }

      var st = loadSlipStyle();
      applySlipStyle(st);
      slipTableEl.textContent = effectiveTable(order) || "--";
      slipMetaEl.textContent = t("slipMeta") + " " + hhmm(order.start);
      slipItemsEl.innerHTML = "";
      (order.items || []).forEach(function (it) {
        var li = document.createElement("li");
        var nm = document.createElement("span");
        var slipNotes = itemNotesText(it);
        nm.textContent = it.name;
        if (st && st.itemSize) nm.style.fontSize = st.itemSize + "px";
        if (st) nm.style.fontWeight = st.itemBold === false ? "400" : "700";
        if (slipNotes && (!st || st.noteShow !== false)) {
          var o = document.createElement("span");
          o.className = "o";
          o.textContent = " (" + slipNotes + ")";
          nm.appendChild(o);
        }
        var q = document.createElement("span");
        q.className = "q";
        q.textContent = slipQtyText(st, Number(it.qty) || 1);
        li.appendChild(nm);
        li.appendChild(q);
        if (st && st.itemGap != null) li.style.paddingTop = li.style.paddingBottom = (st.itemGap / 2) + "px";
        slipItemsEl.appendChild(li);
      });
    }

    /* 長押し印刷 (#224)。実機印刷は job をテキスト/canvas から組むので .slip の描画を
       必要とせず、画面には何も出さずに終わる。実機に送れずブラウザ印刷へ落ちるときだけ
       fallbackToBrowserPrint が body.slip-printing で .slip を描画させる
       (.slip-backdrop の display:none 配下のままだと描画されず白紙になるため)。 */
    function printSlipNow(order) {
      if (printBusy) return;
      /* フォーマッターで直した書式を「次の1枚」から反映させるため、サーバー保存の
         スタイル取得を待ってから組む (#230)。待たないと localStorage の古い値で
         組んでしまい、変更が1枚遅れる (初回はスタイル無しで出る)。
         取得中に押し直されないよう printBusy を先に立てる。 */
      printBusy = true;
      refreshSlipStyleFromServer().then(function () {
        printBusy = false;
        populateSlip(order);
        printSlip();
      });
    }

    /* 画像印字のコマンド体系。機種と合っていないと文字化け+行送りだけが延々出る。
       本番機の Star mC-Print3 は StarPRNT 専用。フォーマッターの「印字方式」で切り替える */
    function loadPrinterEmulation() {
      try {
        var saved = localStorage.getItem("kds_printer_emulation_v1");
        return ["starprnt", "starline", "escpos"].indexOf(saved) !== -1 ? saved : "starprnt";
      } catch (e) { return "starprnt"; }
    }

    function loadPrinterIp() {
      try { printerIp = localStorage.getItem(LS_PRINTER_IP) || ""; }
      catch (e) { printerIp = ""; }
      // サーバー保存のIPが正 (#144追補)。どの端末で登録しても全端末から実機印刷できる
      if (typeof fetch === "function") {
        fetch("/api/printer").then(function (res) {
          if (!res.ok) throw new Error("HTTP " + res.status);
          return res.json();
        }).then(function (data) {
          if (data && data.ip) { printerIp = data.ip; savePrinterIp(); }
        }).catch(function () { /* サーバー未経由ではlocalStorageのまま */ });
      }
    }
    function savePrinterIp() {
      lsSet(LS_PRINTER_IP, printerIp);
      // サーバーにも保存して他端末(iPad等)と共有する
      if (typeof fetch === "function") {
        fetch("/api/printer", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ip: printerIp }),
        }).catch(function () {});
      }
    }
    /* サーバー側 printer.js の isPrivateIPv4() と同じ判定をブラウザでも行う (#176)。
       送信して初めて 400 で弾かれるのではなく、入力した時点でその場で気づけるようにする。
       店内LANのプライベートIPv4のみ許可 (10/8・172.16-31/12・192.168/16) */
    function isPrivateLanIPv4(value) {
      var m = PRINTER_IP_RE.exec(String(value == null ? "" : value).trim());
      if (!m) return false;
      var a = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
      if (a.some(function (n) { return n < 0 || n > 255; })) return false;
      if (a[0] === 10) return true;
      if (a[0] === 172 && a[1] >= 16 && a[1] <= 31) return true;
      if (a[0] === 192 && a[1] === 168) return true;
      return false;
    }

    /* プリンターIPは店舗ネットワーク依存のため固定埋め込みせず、設定画面から登録する (#144) */
    function configurePrinterIp() {
      var next = window.prompt("レシートプリンターのIPアドレス(店内LAN 例: 192.168.1.50)\n空欄で保存するとブラウザ印刷に戻ります。", printerIp);
      if (next === null) return;   // キャンセル
      next = next.trim();
      if (!next) { printerIp = ""; savePrinterIp(); showPrintToast("プリンターIPを未設定に戻しました(ブラウザ印刷になります)"); return; }
      if (!PRINTER_IP_RE.test(next)) {
        window.alert("IPv4アドレスの形式で入力してください (例: 192.168.1.50)");
        return;
      }
      if (!isPrivateLanIPv4(next)) {
        window.alert("店内LANのアドレスを入力してください。\n使えるのは 192.168.x.x / 10.x.x.x / 172.16〜31.x.x の範囲です。\n\nプリンターのIPが分からないときは、プリンターのFEEDボタンを長押しすると設定情報が印字されます。");
        return;
      }
      printerIp = next;
      savePrinterIp();
      showPrintToast("プリンターIPを " + next + " に設定しました");
    }

    /* 印刷の結果を必ず画面に返す (#176)。押しても無反応だと連打され、その回数だけ紙が出てしまう */
    function showPrintToast(message) {
      if (!printToastEl) return;
      printToastEl.textContent = message;
      printToastEl.classList.add("show");
      if (printToastTimer) clearTimeout(printToastTimer);
      printToastTimer = setTimeout(function () {
        printToastEl.classList.remove("show");
        printToastTimer = null;
      }, PRINT_TOAST_MS);
    }

    /* 送信中は次の印刷を受け付けない。二重送信=重複印字の直接の防止線 (#176)。
       プレビューを廃止して印刷ボタンが無くなったため、フラグだけで抑える (#224)。
       長押し側は printSlipNow の先頭で printBusy を見ている。 */
    function setPrintBusy(busy) {
      printBusy = busy;
    }

    /* 実機に送れなかったときのブラウザ印刷。なぜダイアログが出たのかを先に伝えてから開く。
       (印刷ダイアログは同期的に画面を止めるので、トーストを描画させる猶予を挟む) */
    function fallbackToBrowserPrint(message) {
      showPrintToast(message);
      /* 印刷対象の .slip を描画させるだけで、画面には見せない (#224)。
         印刷ダイアログは同期的に画面を止めるので、解除はその後に行う。 */
      document.body.classList.add("slip-printing");
      setTimeout(function () {
        window.print();
        document.body.classList.remove("slip-printing");
      }, 600);
    }

    /** 印刷ボタン押下時の実処理。この端末がIPを知らなくてもサーバー保存IPで印字を試み、
        実機に送れない場合のみブラウザ印刷にフォールバックする */
    function printSlip() {
      if (printBusy) return;   // 連打ガード (#176)
      var order = currentSlipOrder;
      if (!order) { window.print(); return; }
      var tpl = slipTemplate();
      var job;
      if (tpl) {
        // 自由配置レイアウト: 画面に出ているのと同じ絵を1bit画像にして送る。
        // プリンター内蔵フォントを使わないため、書体・大きさ・位置が紙にそのまま出る
        window.SlipRenderer.renderToCanvas(slipCanvasEl, tpl, slipOrderData(order));
        job = {
          ip: printerIp || undefined,
          raster: window.SlipRenderer.canvasToRaster(slipCanvasEl),
          feedLines: tpl.feedLines,
          emulation: loadPrinterEmulation(),
        };
      } else {
        job = {
          ip: printerIp || undefined,   // 未設定ならサーバー保存のIPに委ねる
          table: slipTableEl.textContent,
          meta: slipMetaEl.textContent,
          store: slipStoreEl.textContent,
          style: loadSlipStyle() || undefined,   // 設定ツールのスタイルを実機印字にも反映 (relay側で許容値へ丸める)
          items: (order.items || []).map(function (it) {
            return { name: it.name, qty: Number(it.qty) || 1, note: itemNotesText(it) };
          }),
        };
      }
      setPrintBusy(true);
      fetch("/api/print", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(job),
      }).then(function (res) {
        // 失敗時もサーバーの理由(未設定なのか届かないのか)を読みたいので本文を必ず見る
        return res.json().catch(function () { return null; }).then(function (data) {
          if (!res.ok || !data || !data.ok) {
            var err = new Error((data && data.error) || ("HTTP " + res.status));
            err.status = res.status;
            throw err;
          }
        });
      }).then(function () {
        setPrintBusy(false);
        markSlipPrinted(order.id);         // 伝 -> 再伝 (#224)
        showPrintToast("卓 " + (effectiveTable(order) || "--") + " の伝票を印刷しました");
      }).catch(function (err) {
        setPrintBusy(false);
        markSlipPrinted(order.id);         // ブラウザ印刷まで到達したぶんも記録する (#224)
        console.error("[チビ伝] 実機印刷に失敗。ブラウザ印刷にフォールバック:", err);
        // 400 = IP未設定/不正(まだ実機を登録していない通常の状態)。それ以外は届かない・プリンター側の異常
        fallbackToBrowserPrint(err && err.status === 400
          ? "プリンター未設定のためブラウザ印刷にします"
          : "プリンターに繋がりません。ブラウザ印刷にします");
      });
    }

    /* ===================== 卓番ダイヤル (フリーテキスト入力の誤入力防止 #118) ===================== */
    /* 卓番号は要件定義書の「A1」形式(ゾーン英字+番号)。ゾーンタップで新規入力を開始し、
       以降の番号タップは末尾に追記する。
       厨房の卓番上書きは今の卓番を表示したまま開き、最初の番号タップでその値を置き換える
       (卓11で「1」を押すと「1」。追記して「111」にしない #295)。⌫・全消・ゾーンを先に押したら
       以降は通常の追記に戻る。予約の「調理開始」は下書きの続きを打つため従来どおり追記する。 */
    function renderSeatDialDisplay() {
      if (seatDialBuf) {
        seatDialDisplayEl.textContent = seatDialBuf;
        seatDialDisplayEl.classList.remove("placeholder");
      } else {
        seatDialDisplayEl.textContent = t("seatPh");
        seatDialDisplayEl.classList.add("placeholder");
      }
      var zone = seatDialBuf.charAt(0).toUpperCase();
      seatDialZoneBtns.forEach(function (b) {
        b.classList.toggle("active", b.getAttribute("data-zone") === zone);
      });
    }

    function openSeatDial(rid) {
      seatDialContext = "reservation";
      seatDialRid = String(rid);
      seatDialBuf = seatDrafts[seatDialRid] || "";
      seatDialReplaceNext = false;
      renderSeatDialDisplay();
      document.body.classList.add("seat-dial-open");
    }

    function openTableOverride(orderId) {
      if (mode !== "kitchen") return;
      closeTableOverrideConfirm();
      seatDialContext = "tableOverride";
      seatDialRid = String(orderId);
      var entry = cards[seatDialRid];
      seatDialBuf = entry && entry.order ? effectiveTable(entry.order) : (tableOverrideMap[seatDialRid] || "");
      seatDialReplaceNext = seatDialBuf !== "";   // 今の卓番は見せたまま、最初の番号タップで置き換える (#295)
      renderSeatDialDisplay();
      document.body.classList.add("seat-dial-open");
    }

    function closeSeatDial() {
      document.body.classList.remove("seat-dial-open");
      seatDialRid = null;
      seatDialBuf = "";
      seatDialReplaceNext = false;
      seatDialContext = "reservation";
    }

    /* 伝ボタンの中身を組み立てて長押しを配線する。キッチンのカードとホールのカードで共用する。
       表示されるのはホールだけだが (#226)、DOMは両方に持たせて印刷済み表示を揃える。 */
    function decorateSlipButton(btn, order) {
      var printed = isSlipPrinted(order.id);
      btn.textContent = printed ? "再伝" : "伝";
      btn.classList.toggle("printed", printed);
      btn.setAttribute("aria-label", (printed ? "伝票を再印刷 (1.2秒長押し)" : "伝票を印刷 (1.2秒長押し)"));
      var progress = document.createElement("span");
      progress.className = "slip-btn-progress";
      btn.appendChild(progress);
      attachSlipPrintHandlers(btn, progress, order);
      return btn;
    }

    /* カード上のcueを、他タブからの同期でも作り直さずその場で差し替える。 */
    function applyServeCueToCard(orderId) {
      var entry = cards[String(orderId)];
      if (!entry || !entry.el) return;
      ["starter", "dessert"].forEach(function (kind) {
        var old = entry.el.querySelector('.serve-cue[data-serve-kind="' + kind + '"]');
        if (!old) return;
        var people = entry.order ? entry.order.people : 0;
        old.parentNode.replaceChild(buildServeCue(orderId, kind, people), old);
      });
    }

    /* 伝票を 1.2秒の長押しで刷る (#224)。
       従来はタップでプレビューを開き、その中の「印刷」を押す2手だった。厨房では手が塞がって
       いる場面が多く、確認ダイアログを挟むぶん遅い。一方でプレビュー無しの通常タップだと
       誤タップがそのまま紙になるため、長押しを印刷そのものの操作にしている。
       短タップは従来どおりプレビュー (紙は出ない) を開く。
       12px動かしたら取消。スクロール意図とみなす点は attachItemHandlers と揃える。 */
    function attachSlipPrintHandlers(btn, progress, order) {
      var timer = null, raf = null, startX = 0, startY = 0, pressing = false, printedByHold = false;
      function stop() {
        if (!pressing) return;   // 二重解除で guard を余分に戻さない
        pressing = false;
        endHold();
        document.removeEventListener("pointerup", stop, true);
        document.removeEventListener("pointercancel", stop, true);
        if (timer) { clearTimeout(timer); timer = null; }
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        btn.classList.remove("printing");
        progress.style.width = "0%";
      }
      btn.addEventListener("pointerdown", function (ev) {
        if (ev.button != null && ev.button !== 0) return;
        if (mode !== "hall") return;   // 印刷はホール専用 (#226)
        startX = ev.clientX; startY = ev.clientY;
        pressing = true; printedByHold = false;
        beginHold();
        document.addEventListener("pointerup", stop, true);
        document.addEventListener("pointercancel", stop, true);
        var startedAt = Date.now();
        btn.classList.add("printing");
        function tick() {
          if (!pressing) return;
          var p = Math.min(1, (Date.now() - startedAt) / SLIP_PRINT_MS);
          progress.style.width = (p * 100) + "%";
          if (p < 1) raf = requestAnimationFrame(tick);
        }
        if (!prefersReducedMotion()) raf = requestAnimationFrame(tick);
        timer = setTimeout(function () {
          stop();
          printedByHold = true;
          printSlipNow(order);
        }, SLIP_PRINT_MS);
      });
      btn.addEventListener("pointermove", function (ev) {
        if (!pressing) return;
        if (Math.abs(ev.clientX - startX) > 12 || Math.abs(ev.clientY - startY) > 12) stop();
      });
      btn.addEventListener("pointerup", stop);
      btn.addEventListener("pointercancel", stop);
      btn.addEventListener("pointerleave", stop);
      // 伝票はプレビューを持たない。短いタップでは何も起きず、長押しだけが印刷になる (#224)
      btn.addEventListener("click", function (ev) { printedByHold = false; ev.preventDefault(); });
    }

    /* 卓番ボタンの表示をダイヤルの下書きへ同期 (カードが再描画されず残っている場合のみ) */
    function refreshSeatButton(rid) {
      var card = stockListEl.querySelector('.res-card[data-rid="' + rid + '"]');
      var btn = card ? card.querySelector(".res-seat") : null;
      if (!btn) return;
      var draft = seatDrafts[String(rid)];
      if (draft) { btn.textContent = draft; btn.classList.remove("placeholder"); }
      else { btn.textContent = t("seatPh"); btn.classList.add("placeholder"); }
    }

    function commitSeatDial() {
      if (!seatDialRid) { closeSeatDial(); return; }
      var rid = seatDialRid;
      var val = seatDialBuf.trim();
      if (seatDialContext === "tableOverride") {
        closeSeatDial();
        commitTableOverride(rid, val);
        return;
      }
      if (val) seatDrafts[rid] = val; else delete seatDrafts[rid];
      closeSeatDial();
      refreshSeatButton(rid);
    }

    function hasTableConflict(orderId, candidate) {
      if (!candidate) return false;
      var id = String(orderId), orders = getOrders();
      return orders.some(function (order) {
        return String(order.id) !== id && !isOrderAllDone(order) && effectiveTable(order) === candidate;
      });
    }
    function showTableOverrideConfirm(id, candidate) {
      tableOverridePending = { id: String(id), candidate: String(candidate) };
      if (tableOverrideConfirmMessage) {
        tableOverrideConfirmMessage.textContent = "卓 " + candidate + " は別の進行中オーダーで使用中です。" +
          "同じ卓番へ変更する場合は、下のボタンをもう一度押してください。";
      }
      document.body.classList.add("table-override-confirm-open");
    }
    function closeTableOverrideConfirm() {
      tableOverridePending = null;
      document.body.classList.remove("table-override-confirm-open");
    }
    function saveTableOverride(id, candidate) {
      var key = String(id), value = String(candidate || "").trim();
      if (value) tableOverrideMap[key] = value;
      else delete tableOverrideMap[key];
      saveTableOverrides();
      broadcastTableOverride(key, value || null, !value);
      applyTableOverrideToCard(key);
      refreshAllKonro();
      renderHallViews();
    }
    function commitTableOverride(id, candidate) {
      if (mode !== "kitchen") return;
      var key = String(id), value = String(candidate || "").trim();
      if (hasTableConflict(key, value)) {
        showTableOverrideConfirm(key, value);
        return;
      }
      closeTableOverrideConfirm();
      saveTableOverride(key, value);
    }
    function allowTableOverride() {
      if (mode !== "kitchen" || !tableOverridePending) return;
      var pending = tableOverridePending;
      closeTableOverrideConfirm();
      // 同じ候補を明示許可した2回目だけ保存する。候補が変わったら再度警告へ戻る。
      saveTableOverride(pending.id, pending.candidate);
    }

    /* ゾーンタップ = 新規入力開始 (「A1」の英字部分をセットし、番号部分はリセット) */
    function onSeatZoneTap(zone) {
      seatDialReplaceNext = false;
      seatDialBuf = zone;
      renderSeatDialDisplay();
    }
    function onSeatDigitTap(digit) {
      // 卓番上書きの最初の番号は今の卓番を置き換える。長さの上限より先に判定し、
      // 6桁の卓番でも1回目のタップで打ち直せるようにする (#295)
      if (seatDialReplaceNext) {
        seatDialReplaceNext = false;
        seatDialBuf = "";
      }
      if (seatDialBuf.length >= SEAT_MAX_LEN) return;
      seatDialBuf += digit;
      renderSeatDialDisplay();
    }
    function onSeatBackspace() {
      seatDialReplaceNext = false;   // ⌫ は今の卓番を手直しする操作。以降の番号は追記する
      seatDialBuf = seatDialBuf.slice(0, -1);
      renderSeatDialDisplay();
    }
    function onSeatClear() {
      seatDialReplaceNext = false;
      seatDialBuf = "";
      renderSeatDialDisplay();
    }

    /* ===================== 注文削除 ===================== */
    /* カードの有無・次回のフィード掃除に依存せず、削除時点で資源を解放する (#234)。
       removeCard は表示更新にも使うため、明示削除とその同期受信だけから呼ぶ。 */
    function clearDeletedOrderTimers(id) {
      var key = String(id);
      delete konroMap[key];
      delete lockedTimers[key];
      saveKonro();
      saveLocked();
      refreshAllKonro();
      updateKonroHud();
    }
    /* 確認は削除ボタン側の2段階タップで済ませている (#68)。ここでは即実行する */
    function deleteOrder(id) {
      deletedIds[String(id)] = true;   // トゥームストーン: POSが再送しても復活させない (#67)
      saveDeleted();
      if (Array.isArray(window.KDS_ORDERS)) {
        window.KDS_ORDERS = window.KDS_ORDERS.filter(function (o) { return String(o.id) !== String(id); });
      }
      broadcastDeleteOrder(id);
      removeCard(String(id), true);
      clearDeletedOrderTimers(id);
      orderSeq = orderSeq.filter(function (x) { return String(x) !== String(id); });
      saveOrderSeq();
      broadcastOrderSeq();
      reflectEmpty();
    }

    /* ===================== タイマーロック ===================== */
    function loadLocked() {
      try {
        var v = localStorage.getItem(LS_LOCKED);
        lockedTimers = (v ? JSON.parse(v) : {}) || {};
        if (typeof lockedTimers !== "object" || Array.isArray(lockedTimers)) lockedTimers = {};
      } catch (e) { lockedTimers = {}; }
    }
    function saveLocked() {
      lsSet(LS_LOCKED, JSON.stringify(lockedTimers));
    }
    /* ----- 削除済み注文ID (トゥームストーン #67) -----
       POS接続後は window.KDS_ORDERS が毎秒上書きされるため、配列から除くだけでは
       次のポーリングで削除した注文が復活する。削除済みIDを保持し getOrders() で除外し続ける。
       POS側APIへの削除伝播は未設計 (テーブルチェック連携は 2026-10-11 に中止 #74)。 */
    function loadDeleted() {
      var v = safeParse(localStorage.getItem(LS_DELETED), {}) || {};
      deletedIds = (v && typeof v === "object" && !Array.isArray(v)) ? v : {};
    }
    function saveDeleted() {
      lsSet(LS_DELETED, JSON.stringify(deletedIds));
    }
    /* フィード(生データ)から居なくなった削除済みIDは掃除する (POSが再送し続ける間だけ保持) */
    function pruneDeleted() {
      if (!hasOrderFeed()) return;   // 未接続タブが他タブのトゥームストーンを消さない (#133)
      var src = window.KDS_ORDERS;
      var live = {};
      src.forEach(function (o) { if (o && o.id != null) live[String(o.id)] = true; });
      var changed = false;
      Object.keys(deletedIds).forEach(function (id) {
        if (!live[id]) { delete deletedIds[id]; changed = true; }
      });
      if (changed) saveDeleted();
    }

    function toggleTimerLock(id) {
      lockedTimers[String(id)] = !lockedTimers[String(id)];
      saveLocked();
      broadcastTimerLock(id, lockedTimers[String(id)]);
      applyTimerLockToCard(String(id));
    }
    function applyTimerLockToCard(id) {
      var entry = cards[id];
      if (!entry || !entry.el) return;
      var locked = !!lockedTimers[id];
      entry.el.classList.toggle("timer-locked", locked);
      var lockBtn = entry.el.querySelector(".js-lock-btn");
      if (lockBtn) {
        lockBtn.setAttribute("aria-pressed", locked ? "true" : "false");
        lockBtn.setAttribute("aria-label", locked ? "タイマー再開" : "タイマー停止");
        lockBtn.textContent = locked ? "再" : "停";
      }
    }

    /* ===================== 権限モード ===================== */
    function applyMode() {
      document.body.classList.toggle("mode-hall", mode === "hall");
      modeBtns.forEach(function (b) {
        b.setAttribute("aria-pressed", b.getAttribute("data-mode") === mode ? "true" : "false");
      });
      if (mode === "hall") renderHallViews();
      // 提供cueはモードで操作可否が変わるため、切り替えたら貼り直す
      Object.keys(cards).forEach(function (id) { applyServeCueToCard(id); });
    }
    function setMode(next) {
      mode = (next === "hall") ? "hall" : "kitchen";
      lsSet(LS_MODE, mode);
      if (mode === "hall" && grab) cancelReorder();
      // 相手モード用のundoトーストは閉じる。重なって別操作のundoが実行されるのを防ぐ (#261)
      if (mode !== "kitchen") hideUndoToast();
      else { hideHallReadyUndo(); hideStarterUndo(); }
      if (mode !== "kitchen") closeTableOverrideConfirm();
      if (mode !== "kitchen" && seatDialContext === "tableOverride") closeSeatDial();
      applyMode();
      // 炊飯準備cueの確認ボタンはモードで出し分けるため、切替時に予約ストックを再描画する (#262)
      renderStock();
    }
    /* ===================== タイマー (経過時間 / 時計) ===================== */
    function updateTimers() {
      Object.keys(cards).forEach(function (id) {
        if (lockedTimers[id]) return;   // タイマーロック中は更新しない (＝確認済み扱い)
        var entry = cards[id];
        if (!entry || !entry.el) return;
        var min = elapsedMin(entry.order.start);
        var lvl = levelOf(min);
        var badge = entry.el.querySelector(".js-elapsed");
        var val = entry.el.querySelector(".js-elapsed-val");
        if (val) val.textContent = String(min);
        if (badge && entry.level !== lvl) {
          badge.classList.remove("warn", "alert");
          if (lvl === "warn") badge.classList.add("warn");
          else if (lvl === "alert") badge.classList.add("alert");
          entry.el.classList.remove("lvl-ok", "lvl-warn", "lvl-alert");
          entry.el.classList.add("lvl-" + lvl);
          entry.level = lvl;
        }
      });
      updateHud();
    }

    /* ===================== HUD (状況サマリー / コンロ全体ビュー) ===================== */
    function updateHud() {
      // 全品完了したカードはDOMに残るが「進行中」ではない (#228)
      var ids = Object.keys(cards).filter(function (id) { return !isAllDone(cards[id]); });
      var alertN = 0;
      ids.forEach(function (id) {
        var e = cards[id];
        if (e && !lockedTimers[id] && levelOf(elapsedMin(e.order.start)) === "alert") alertN++;
      });
      var soonN = 0;
      stock.forEach(function (r) {
        if (minutesUntil(r.time) <= SOON_MIN) soonN++;   // 30分前〜時間超過を含む
      });
      hudActiveEl.textContent = String(ids.length);
      hudAlertEl.textContent = String(alertN);
      hudSoonEl.textContent = String(soonN);
      hudAlertWrap.classList.toggle("alert-on", alertN > 0);
      hudSoonWrap.classList.toggle("warn-on", soonN > 0);
    }

    /* コンロ 1〜10 を全カード横断で集約表示 (赤 > 白 > 未使用の優先で1状態に潰す) */
    /* コンロ列とタイマー列を別々に並べる (#145)。
       以前は1列で、同じ番号のコンロとタイマーを1セルに畳んで赤優先で表示していたため、
       「コンロ3は空いているがタイマー3は稼働中」といった状態が読み取れなかった。 */
    function buildKonroHud() {
      khRows = [
        { kind: "white", label: t("konroHudKonro"), cells: [] },
        { kind: "red",   label: t("konroHudTimer"), cells: [] }
      ];
      khRows.forEach(function (row) {
        var group = document.createElement("span");
        group.className = "kh-row";
        var label = document.createElement("span");
        label.className = "kh-label";
        label.setAttribute("aria-hidden", "true");
        label.textContent = row.label;
        group.appendChild(label);
        for (var n = 1; n <= KONRO_COUNT; n++) {
          var cell = document.createElement("span");
          cell.className = "kh-cell";
          cell.setAttribute("data-state", "skeleton");
          cell.textContent = String(n);
          group.appendChild(cell);
          row.cells.push(cell);
        }
        konroHudEl.appendChild(group);
      });
    }
    function updateKonroHud() {
      khRows.forEach(function (row) {
        for (var n = 1; n <= KONRO_COUNT; n++) {
          var cell = row.cells[n - 1];
          if (!cell) continue;
          var used = false, owner = "";
          Object.keys(konroMap).forEach(function (cid) {
            if (!konroMap[cid] || konroMap[cid][String(n)] !== row.kind) return;
            used = true;
            if (!owner) owner = ownerTable(cid);
          });
          var state = used ? row.kind : "skeleton";
          if (cell.getAttribute("data-state") !== state) cell.setAttribute("data-state", state);
          // 占有卓を数字バッジで出す。番号だけでは「誰が使っているか」が分からない (#145)
          if (used && owner) cell.setAttribute("data-owner", owner);
          else if (cell.hasAttribute("data-owner")) cell.removeAttribute("data-owner");
          var stateLabel = used
            ? (row.kind === "white" ? t("konroWhite") : t("konroRed"))
            : t("konroSkeleton");
          cell.setAttribute("aria-label", row.label + n + " " + stateLabel + (owner ? "（卓" + owner + "）" : ""));
          cell.title = row.label + n + " " + stateLabel + (owner ? " 卓" + owner : "");
        }
      });
    }
    function ownerTable(cardId) {
      var e = cards[cardId];
      return e && e.order ? effectiveTable(e.order) : "";
    }

    function updateClock() {
      var d = new Date();
      clockEl.innerHTML = pad2(d.getHours()) + ":" + pad2(d.getMinutes()) +
        '<span class="sec">:' + pad2(d.getSeconds()) + '</span>';
    }

    /* ===================== 空状態 ===================== */
    function reflectEmpty() {
      var has = boardEl.children.length > 0;
      document.body.classList.toggle("is-empty", !has);
    }

    /* ===================== デモ / シードデータ ===================== */
    function makeDemo() {
      var now = Date.now();
      var m = 60000;
      return [
        { id: now - 1,  table:"A1", type:"new",      start: now - 1*m,  people:2,
          items:[ {name:"山城牛の焼きすき土鍋御膳", qty:2, options:"大盛り", allergies:"卵", done:false},
                  {name:"海老天ぷら", qty:1, options:null, done:false},
                  {name:"オリオンビール（小瓶）", qty:2, options:null, done:false} ] },
        { id: now - 2,  table:"B2", type:"reserved", start: now - 3*m,  people:4,
          items:[ {name:"山城牛の肉たく土鍋御膳", qty:2, options:"肉増し", done:false},
                  {name:"島黒ヒレカツ出汁とろろ土鍋御膳", qty:1, options:null, done:false},
                  {name:"ウーロン茶", qty:4, options:null, done:false} ] },
        { id: now - 3,  table:"A3", type:"new",      start: now - 6*m,  people:1,
          items:[ {name:"うなぎ土鍋御膳", qty:1, options:null, done:false},
                  {name:"山城牛のとろ煮", qty:1, options:null, done:false} ] },
        { id: now - 4,  table:"C1", type:"reserved", start: now - 8*m,  people:3,
          items:[ {name:"山城牛のカニクラ土鍋御膳", qty:1, options:null, allergies:["乳", "小麦"], done:true},
                  {name:"焼きすきセット", qty:2, options:null, done:false},
                  {name:"レモンサワー", qty:2, options:null, done:false} ] },
        { id: now - 5,  table:"A2", type:"new",      start: now - 11*m, people:2,
          items:[ {name:"マース煮アーサバター土鍋御膳", qty:2, options:null, done:false},
                  {name:"ハイボール（角）", qty:2, options:null, done:false} ] },
        { id: now - 6,  table:"B1", type:"new",      start: now - 2*m,  people:2,
          items:[ {name:"島黒ヒレカツ出汁とろろ土鍋御膳", qty:1, options:"大盛り", done:false} ] },
        { id: now - 7,  table:"C3", type:"reserved", start: now - 13*m, people:4,
          items:[ {name:"山城牛の焼きすき土鍋御膳", qty:4, options:"山城牛追加", done:false},
                  {name:"島黒西京焼き", qty:2, options:null, allergyInfo:"卵", done:true},
                  {name:"黒霧島", qty:3, options:"ロック", done:false} ] },
        { id: now - 8,  table:"A4", type:"new",      start: now - 4*m,  people:1,
          items:[ {name:"今月のスポット土鍋御膳", qty:1, options:null, done:false} ] },
        { id: now - 9,  table:"B3", type:"reserved", start: now - 7*m,  people:2,
          items:[ {name:"焼きすきセット", qty:1, options:null, done:false},
                  {name:"薫長（特別純米）", qty:2, options:null, done:false} ] },
        { id: now - 10, table:"C2", type:"new",      start: now - 9*m,  people:3,
          items:[ {name:"山城牛の肉たく土鍋御膳", qty:2, options:"肉増し", done:false},
                  {name:"白米1合", qty:3, options:null, done:false} ] },
        { id: now - 11, table:"A5", type:"new",      start: now - 30*1000, people:2,
          items:[ {name:"卵かけご飯セット", qty:1, options:null, done:false},
                  {name:"オレンジ", qty:2, options:null, done:false} ] },
        { id: now - 12, table:"B4", type:"reserved", start: now - 5*m,  people:4,
          items:[ {name:"山城牛と海老天つゆしゃぶ土鍋御膳", qty:2, options:null, done:false},
                  {name:"海老天ぷら", qty:1, options:null, done:false},
                  {name:"出汁米1合", qty:2, options:null, done:false} ] },
        { id: now - 13, table:"C4", type:"new",      start: now - 15*m, people:1,
          items:[ {name:"山城牛のカニクラ土鍋御膳", qty:1, options:null, done:false} ] },
        { id: now - 14, table:"A6", type:"new",      start: now - 10*m, people:2,
          items:[ {name:"うなぎ土鍋御膳", qty:2, options:null, done:false},
                  {name:"ウーロンハイ", qty:2, options:null, done:false} ] },
        { id: now - 15, table:"B5", type:"reserved", start: now - 6*m,  people:3,
          items:[ {name:"山城牛のとろ煮", qty:1, options:null, done:false},
                  {name:"豊の国", qty:2, options:"水割り", done:false},
                  {name:"サイダー", qty:1, options:null, done:false} ] }
      ];
    }

    /* 予約ストックのデモ (30分前通知が出るものを含む。当日分のみ) */
    function makeStockDemo() {
      function tStr(offsetMin) {
        var d = new Date(Date.now() + offsetMin * 60000);
        return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
      }
      return [
        { rid:"d1", time:tStr(20),  adults:2, kids:1, name:"比嘉様",
          menu:[{name:"山城牛の焼きすき土鍋御膳",qty:2},{name:"オリオンビール（小瓶）",qty:2}] },   // 30分以内 -> 通知
        { rid:"d2", time:tStr(25),  adults:4, kids:0, name:"大城様",
          menu:[{name:"山城牛の肉たく土鍋御膳",qty:2},{name:"焼きすきセット",qty:1},{name:"ウーロン茶",qty:4}] }, // 通知
        { rid:"d3", time:tStr(75),  adults:3, kids:2, name:"宮城様",
          menu:[{name:"うなぎ土鍋御膳",qty:1},{name:"山城牛のとろ煮",qty:2}] },
        { rid:"d4", time:tStr(140), adults:6, kids:0, name:"金城様",
          menu:[{name:"マース煮アーサバター土鍋御膳",qty:2},{name:"島黒西京焼き",qty:4},{name:"レモンサワー",qty:3}] }
      ];
    }

    function injectDemo() {
      window.KDS_ORDERS = makeDemo();
      // 既存の完了状態 / コンロ状態 / 並び順キャッシュをクリアしてデモを素直に出す
      doneMap = {};
      konroMap = {}; saveKonro();
      orderSeq = []; saveOrderSeq();
      // 予約ストックが空ならデモ予約も投入 (既存の手入力は壊さない)
      if (!stock.length) { stock = makeStockDemo(); saveStock(); }
      Object.keys(cards).forEach(function (id) { removeCard(id, false); });
      poll();
      renderStock();
    }

    /* ===================== ポーリング ===================== */
    function poll() {
      renderSyncStatus(window.__KDS_SYNC_STATUS__);
      loadDeleted();              // 削除済みIDを LS から取り込み (#67)
      pruneDeleted();             // フィードから消えた削除済みIDは掃除
      loadRiceCues();             // BC非対応時の同一ブラウザLSフォールバック
      loadTableOverrides();
      loadHallReady();
      var orders = getOrders();
      loadDone();                 // 他タブ/リロードで更新された LS を取り込む (フォールバック同期)
      loadKonro();                // コンロ状態も LS から取り込む (BroadcastChannel 非対応時のフォールバック同期)
      loadLocked();               // タイマーロック状態も同期
      if (!isReordering) loadOrderSeq();   // 並び順も LS から取り込む (掴み中は触らない)
      applyDoneToOrders(orders);
      render(orders);
    }

    /* ===================== 初期化 ===================== */
    function init() {
      purgeStaleDay();   // 日付が変わっていたら前日の運用データを破棄 (#63)
      loadDeleted();
      loadDone();
      loadKonro();
      loadOrderSeq();
      loadLocked();
      loadStock();
      loadRiceCues();
      loadTableOverrides();
      loadHallReady();
      loadSlipPrinted();
      loadServeCues();
      // 抑止フラグが取り残されて次の正当なタップを食べないよう、新しい操作の開始で必ず落とす
      document.addEventListener("pointerdown", function () { serveCueSuppressClick = false; }, true);
      loadPrefs();
      loadPrinterIp();
      refreshSlipStyleFromServer();   // 印刷スタイルをサーバーから取得しておく (#144追補)
      loadView();
      loadHallLayout();
      applyMode();
      applyView();
      buildKonroHud();
      listenSyncStatus();
      initSync();
      window.addEventListener(ORDER_SOUND_EVENT, onOrderAdded);
      document.addEventListener("pointerdown", unlockOrderSound, { passive: true });
      document.addEventListener("keydown", unlockOrderSound, { passive: true });
      if (orderSoundBtn) orderSoundBtn.addEventListener("click", enableOrderSound);

      modeBtns.forEach(function (b) {
        b.addEventListener("click", function () { setMode(b.getAttribute("data-mode")); });
      });
      hallProtoBtns.forEach(function (b) {
        b.addEventListener("click", function () { setHallLayout(b.getAttribute("data-hall-layout")); });
      });
      hallStockAddBtns.forEach(function (b) {
        b.addEventListener("click", function () { if (mode === "hall") openModal(); });
      });
      viewBtns.forEach(function (b) {
        b.addEventListener("click", function () { setView(b.getAttribute("data-view")); });
      });
      if (undoToastBtn) undoToastBtn.addEventListener("click", undoComplete);
      if (hallReadyUndoBtn) hallReadyUndoBtn.addEventListener("click", undoHallReady);
      if (starterUndoBtn) starterUndoBtn.addEventListener("click", undoStarter);
      if (tableOverrideConfirmCancel) tableOverrideConfirmCancel.addEventListener("click", closeTableOverrideConfirm);
      if (tableOverrideConfirmAllow) tableOverrideConfirmAllow.addEventListener("click", allowTableOverride);
      if (tableOverrideConfirmBackdrop) tableOverrideConfirmBackdrop.addEventListener("click", function (e) {
        if (e.target === tableOverrideConfirmBackdrop) closeTableOverrideConfirm();
      });
      if (demoBtn) demoBtn.addEventListener("click", injectDemo);

      // 予約ストック操作
      if (stockAddBtn) stockAddBtn.addEventListener("click", openModal);
      if (resCancelBtn) resCancelBtn.addEventListener("click", closeModal);
      if (resForm) resForm.addEventListener("submit", submitRes);
      if (modalBackdrop) modalBackdrop.addEventListener("click", function (e) { if (e.target === modalBackdrop) closeModal(); });

      // チビ伝

      if (printerSettingsBtn) printerSettingsBtn.addEventListener("click", configurePrinterIp);


      // 卓番ダイヤル (#118)
      seatDialZoneBtns.forEach(function (b) {
        b.addEventListener("click", function () { onSeatZoneTap(b.getAttribute("data-zone")); });
      });
      seatDialDigitBtns.forEach(function (b) {
        b.addEventListener("click", function () { onSeatDigitTap(b.getAttribute("data-digit")); });
      });
      if (seatDialClearBtn) seatDialClearBtn.addEventListener("click", onSeatClear);
      if (seatDialBackBtn) seatDialBackBtn.addEventListener("click", onSeatBackspace);
      if (seatDialOkBtn) seatDialOkBtn.addEventListener("click", commitSeatDial);
      if (seatDialCancelBtn) seatDialCancelBtn.addEventListener("click", closeSeatDial);
      if (seatBackdrop) seatBackdrop.addEventListener("click", function (e) { if (e.target === seatBackdrop) closeSeatDial(); });

      // 並べ替え取消/確定 (取消ボタンは掴み中=取消 / 確定直後=戻す の2役 #62)
      if (reorderUndoBtn) reorderUndoBtn.addEventListener("click", function () {
        if (grab) cancelReorder();
        else undoReorderCommit();
      });
      if (reorderDoneBtn) reorderDoneBtn.addEventListener("click", commitReorder);

      // ESC でモーダル/伝票/卓番ダイヤルを閉じる / 並べ替え取消
      document.addEventListener("keydown", function (e) {
        if (e.key !== "Escape") return;
        if (document.body.classList.contains("seat-dial-open")) closeSeatDial();
        else if (document.body.classList.contains("table-override-confirm-open")) closeTableOverrideConfirm();
        else if (document.body.classList.contains("modal-open")) closeModal();
        else if (isReordering) cancelReorder();
        else if (reorderUndoSnapshot) hideReorderUndoBar();
      });

      // モーダル表示中は Tab フォーカスをダイアログ内で循環させる (#69)
      document.addEventListener("keydown", trapModalFocus);

      updateClock();
      renderStock();
      poll();

      // 起動時 POS 未接続 (空) ならデモを自動シード (本番で POS が入れば上書きされ邪魔しない)
      // ただし中継サーバー配信時 (window.__KDS_SUPPRESS_DEMO__) や ?nodemo=1 のときは
      // 外部(予約中継/POS)がデータ源なので自動デモを抑止し、空の状態から始める。
      var suppressDemo = window.__KDS_SUPPRESS_DEMO__ === true || /[?&]nodemo=1(\b|&|$)/.test(location.search);
      if (getOrders().length === 0 && !suppressDemo) {
        injectDemo();
      }

      setInterval(poll, POLL_MS);
      setInterval(function () { updateTimers(); updateClock(); }, TICK_MS);
      // 予約30分前通知は毎分判定 (秒更新は不要)
      setInterval(function () {
        updateStockSoon();
        // 30分境界を跨いだときも炊飯cueの表示を更新する
        renderStock();
        renderHallViews();
      }, 30000);
    }

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init);
    } else {
      init();
    }
  })();
