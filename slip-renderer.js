/**
 * slip-renderer.js — チビ伝レイアウトの共有描画エンジン
 *
 * フォーマッター(slip-style-designer.html)とKDS(kds-a-grid.html)の両方から読み込み、
 * 「同じテンプレート + 同じ注文 → 同じ絵」を保証する。ここで描いた canvas がそのまま
 * 1bitラスターに変換され、感熱プリンターへ画像として印字される。
 *
 * 画像印字にしている理由: ESC/POS のテキスト印字はプリンター内蔵フォント固定・
 * 文字サイズが等倍/2倍の2段階しかなく、「好きな位置に好きな書体で置く」ができないため。
 *
 * 座標系は 203dpi のドット。80mm紙=576ドット / 58mm紙=384ドット が印字可能幅。
 * (1mm ≒ 8ドット。用紙の物理幅ではなくヘッドの印字可能幅である点に注意)
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SlipRenderer = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var DOTS = { 58: 384, 80: 576 };
  var MAX_HEIGHT = 2400;          // 約30cm。暴走テンプレートでロール紙を使い切らせない
  var MAX_ELEMENTS = 40;

  /* 選べる書体。印字するのは「印刷ボタンを押した端末のブラウザ」なので、
     Windows(店PC)とiPadOS(iPad)の両方に載っている書体を先頭に並べたスタックにする。
     行書・ポップはWindowsのみのため、iPadではゴシックにフォールバックする */
  var FONTS = {
    gothic: { label: "ゴシック", css: '"Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic","Meiryo",sans-serif' },
    mincho: { label: "明朝", css: '"Hiragino Mincho ProN","Yu Mincho","MS PMincho",serif' },
    maru: { label: "丸ゴシック", css: '"Hiragino Maru Gothic ProN","Meiryo",sans-serif' },
    mono: { label: "等幅", css: '"Osaka-Mono","MS Gothic",monospace' },
    pop: { label: "ポップ体", css: '"HGP創英角ポップ体","HGSoeiKakupoptai","Hiragino Maru Gothic ProN",sans-serif' },
    gyosho: { label: "行書体", css: '"HG行書体","HGGyoshotai","Hiragino Mincho ProN",serif' },
  };

  var QTY_FORMATS = {
    x: function (n) { return "x " + n; },
    times: function (n) { return "× " + n; },
    kosuu: function (n) { return n + " 個"; },
    kake: function (n) { return "×" + n; },
  };

  /* テキスト要素で使える差込フィールド。KDSが持っている注文データに対応する */
  var FIELDS = [
    { key: "{店名}", label: "店名" },
    { key: "{卓番}", label: "卓番" },
    { key: "{受付}", label: "受付時刻" },
    { key: "{受付日}", label: "受付日" },
    { key: "{人数}", label: "人数" },
    { key: "{区分}", label: "予約/新規" },
    { key: "{注文番号}", label: "注文番号" },
    { key: "{日付}", label: "印刷日付" },
    { key: "{時刻}", label: "印刷時刻" },
  ];

  /* ワンタップで置ける部品。よく使う要素を「中身と書式が入った状態」で追加する。
     空の要素を足してから差込フィールドを打ち込む手間を無くすためのもの。
     x/w は用紙の印字可能幅(dots)から決めるので、58mm/80mm どちらでも収まる */
  var PARTS = [
    { key: "store", label: "店名",
      make: function (d) { return { type: "text", x: 0, w: d, align: "center", text: "{店名}", size: 26, bold: false }; } },
    { key: "table", label: "卓番",
      make: function (d) { return { type: "text", x: 0, w: d, align: "center", text: "卓 {卓番}", size: 64, bold: true, lineHeight: 1.15 }; } },
    { key: "meta", label: "受付時刻",
      make: function (d) { return { type: "text", x: 12, w: d - 24, align: "left", text: "受付 {受付}", size: 24, bold: false }; } },
    { key: "metaFull", label: "受付日時",
      make: function (d) { return { type: "text", x: 12, w: d - 24, align: "left", text: "受付 {受付日} {受付}", size: 24, bold: false }; } },
    { key: "people", label: "人数",
      make: function (d) { return { type: "text", x: 12, w: d - 24, align: "left", text: "{人数} 名", size: 28, bold: true }; } },
    { key: "kind", label: "予約/新規",
      make: function (d) { return { type: "text", x: 12, w: d - 24, align: "left", text: "{区分}", size: 28, bold: true }; } },
    { key: "orderNo", label: "注文番号",
      make: function (d) { return { type: "text", x: 12, w: d - 24, align: "left", text: "No. {注文番号}", size: 24, bold: false }; } },
    { key: "printedAt", label: "印刷日時",
      make: function (d) { return { type: "text", x: 12, w: d - 24, align: "right", text: "{日付} {時刻}", size: 20, bold: false }; } },
    { key: "free", label: "自由テキスト",
      make: function (d) { return { type: "text", x: 12, w: d - 24, align: "left", text: "文字を入力", size: 28, bold: false }; } },
    { key: "line", label: "罫線",
      make: function (d) { return { type: "line", x: 12, w: d - 24, thickness: 2, style: "dashed" }; } },
    { key: "items", label: "品目リスト",
      make: function (d) {
        return { type: "items", x: 12, w: d - 24, align: "left", size: 32, bold: true,
                 qtyShow: true, qtyFormat: "x", qtyPos: "inline", qtySize: 26,
                 noteShow: true, noteSize: 24, noteIndent: 24, rowGap: 14 };
      } },
  ];

  /** 部品キーから、用紙幅に合わせた新しい要素を作る (id と y は呼び出し側が入れる) */
  function makePart(key, paperWidth) {
    var dots = DOTS[paperWidth === 58 ? 58 : 80];
    for (var i = 0; i < PARTS.length; i++) {
      if (PARTS[i].key === key) return PARTS[i].make(dots);
    }
    return PARTS[PARTS.length - 3].make(dots);   // 未知のキーは自由テキストへ倒す
  }

  function clamp(n, min, max) {
    n = Math.round(Number(n));
    if (isNaN(n)) n = min;
    return Math.min(max, Math.max(min, n));
  }
  function pick(val, allowed, def) {
    return allowed.indexOf(val) !== -1 ? val : def;
  }

  /* ===== テンプレート ===== */

  function defaultTemplate() {
    return {
      version: 3,
      paperWidth: 80,
      feedLines: 5,
      elements: [
        { id: "store", type: "text", x: 0, y: 8, w: 576, anchor: "top", align: "center",
          text: "{店名}", font: "gothic", size: 26, bold: false, lineHeight: 1.3 },
        { id: "table", type: "text", x: 0, y: 46, w: 576, anchor: "top", align: "center",
          text: "卓 {卓番}", font: "gothic", size: 64, bold: true, lineHeight: 1.15 },
        { id: "meta", type: "text", x: 12, y: 128, w: 552, anchor: "top", align: "left",
          text: "受付 {受付}", font: "gothic", size: 24, bold: false, lineHeight: 1.3 },
        { id: "sep", type: "line", x: 12, y: 166, w: 552, anchor: "top",
          thickness: 2, style: "dashed" },
        { id: "items", type: "items", x: 12, y: 182, w: 552, anchor: "top", align: "left",
          font: "gothic", size: 32, bold: true, lineHeight: 1.25,
          qtyShow: true, qtyFormat: "x", qtyPos: "inline", qtySize: 26,
          noteShow: true, noteSize: 24, noteIndent: 24, rowGap: 14 },
      ],
    };
  }

  function normalizeElement(el, dots) {
    if (!el || typeof el !== "object") return null;
    var type = pick(el.type, ["text", "items", "line"], null);
    if (!type) return null;
    var out = {
      id: String(el.id || ("el" + Math.round(Math.random() * 1e9))).slice(0, 40),
      type: type,
      x: clamp(el.x, -dots, dots),
      y: clamp(el.y, -MAX_HEIGHT, MAX_HEIGHT),
      w: clamp(el.w == null ? dots : el.w, 8, dots),
      anchor: pick(el.anchor, ["top", "items"], "top"),
    };
    if (type === "line") {
      out.thickness = clamp(el.thickness == null ? 2 : el.thickness, 1, 12);
      out.style = pick(el.style, ["solid", "dashed", "double"], "solid");
      return out;
    }
    out.align = pick(el.align, ["left", "center", "right"], "left");
    out.font = FONTS[el.font] ? el.font : "gothic";
    out.size = clamp(el.size == null ? 28 : el.size, 10, 120);
    out.bold = !!el.bold;
    out.lineHeight = Math.min(3, Math.max(0.9, Number(el.lineHeight) || 1.25));
    if (type === "text") {
      out.text = String(el.text == null ? "" : el.text).slice(0, 200);
      return out;
    }
    out.qtyShow = el.qtyShow !== false;
    out.qtyFormat = QTY_FORMATS[el.qtyFormat] ? el.qtyFormat : "x";
    out.qtyPos = pick(el.qtyPos, ["inline", "below"], "inline");
    out.qtySize = clamp(el.qtySize == null ? 26 : el.qtySize, 10, 120);
    out.noteShow = el.noteShow !== false;
    out.noteSize = clamp(el.noteSize == null ? 24 : el.noteSize, 10, 120);
    out.noteIndent = clamp(el.noteIndent == null ? 24 : el.noteIndent, 0, 200);
    out.rowGap = clamp(el.rowGap == null ? 14 : el.rowGap, 0, 120);
    return out;
  }

  /** 保存されたJSON(改変・旧形式・破損を含みうる)を必ず描画できるテンプレートへ丸める */
  function normalizeTemplate(raw) {
    if (!raw || typeof raw !== "object") return defaultTemplate();
    if (!Array.isArray(raw.elements)) return defaultTemplate();
    var paperWidth = raw.paperWidth === 58 ? 58 : 80;
    var dots = DOTS[paperWidth];
    var elements = raw.elements
      .slice(0, MAX_ELEMENTS)
      .map(function (el) { return normalizeElement(el, dots); })
      .filter(Boolean);
    if (!elements.length) return defaultTemplate();
    return {
      version: 3,
      paperWidth: paperWidth,
      feedLines: clamp(raw.feedLines == null ? 5 : raw.feedLines, 0, 8),
      elements: elements,
    };
  }

  /** v3テンプレートかどうか (旧テキスト型スタイルとの判別に使う) */
  function isTemplate(raw) {
    return !!(raw && typeof raw === "object" && Array.isArray(raw.elements));
  }

  /* ===== 描画 ===== */

  function fontOf(el, size) {
    return (el.bold ? "700 " : "400 ") + (size || el.size) + "px " + FONTS[el.font].css;
  }
  /** align に応じた fillText の基準X (要素の枠 x..x+w の中で寄せる) */
  function anchorX(el, x, w) {
    if (el.align === "center") return x + w / 2;
    if (el.align === "right") return x + w;
    return x;
  }
  /** 日本語は単語区切りが無いため1文字ずつ幅を測って折り返す */
  function wrapText(ctx, text, maxW) {
    var lines = [], cur = "";
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (ch === "\n") { lines.push(cur); cur = ""; continue; }
      var next = cur + ch;
      if (cur && ctx.measureText(next).width > maxW) { lines.push(cur); cur = ch; }
      else cur = next;
    }
    lines.push(cur);
    return lines;
  }

  /** 差込フィールドを実データへ置換する */
  function fillFields(text, order) {
    var o = order || {};
    return String(text)
      .replace(/\{店名\}/g, o.store == null ? "" : o.store)
      .replace(/\{卓番\}/g, o.table == null ? "" : o.table)
      .replace(/\{受付日\}/g, o.metaDate == null ? "" : o.metaDate)
      .replace(/\{受付\}/g, o.meta == null ? "" : o.meta)
      .replace(/\{人数\}/g, o.people == null ? "" : o.people)
      .replace(/\{区分\}/g, o.kind == null ? "" : o.kind)
      .replace(/\{注文番号\}/g, o.orderNo == null ? "" : o.orderNo)
      .replace(/\{日付\}/g, o.date == null ? "" : o.date)
      .replace(/\{時刻\}/g, o.time == null ? "" : o.time);
  }

  /**
   * テキストを1行ずつ描く。ctx が null なら測定のみ (measure だけを使う)。
   * 戻り値は消費した高さ(ドット)。
   */
  function drawLines(ctx, measure, el, size, text, x, y, w) {
    measure.font = fontOf(el, size);
    var lineH = Math.round(size * el.lineHeight);
    var lines = wrapText(measure, text, w);
    if (ctx) {
      ctx.font = measure.font;
      ctx.textAlign = el.align;
      ctx.textBaseline = "alphabetic";
      lines.forEach(function (line, i) {
        // ベースラインは行の上端から文字サイズの約0.82倍下。
        // textBaseline="top" はフォントごとに内部レディングの扱いが揺れるため使わない
        ctx.fillText(line, anchorX(el, x, w), y + lineH * i + Math.round(size * 0.82));
      });
    }
    return lineH * lines.length;
  }

  /** 品目リスト1つ分を測る/描く。戻り値は高さ(ドット) */
  function drawItems(ctx, measure, el, order, x, y) {
    var items = (order && order.items) || [];
    var total = 0;
    var qtyFmt = QTY_FORMATS[el.qtyFormat];
    items.forEach(function (it, idx) {
      if (idx > 0) total += el.rowGap;
      var name = String((it && it.name) || "");
      var qty = qtyFmt(Math.max(1, Number(it && it.qty) || 1));
      var nameW = el.w;

      if (el.qtyShow && el.qtyPos === "inline") {
        // 数量は右端に固定し、品名はその手前で折り返す
        measure.font = fontOf({ bold: false, font: el.font }, el.qtySize);
        var qw = Math.ceil(measure.measureText(qty).width) + 12;
        nameW = Math.max(40, el.w - qw);
        if (ctx) {
          ctx.font = measure.font;
          ctx.textAlign = "right";
          ctx.textBaseline = "alphabetic";
          ctx.fillText(qty, x + el.w, y + total + Math.round(el.size * 0.82));
        }
      }
      total += drawLines(ctx, measure, el, el.size, name, x, y + total, nameW);

      var sub = { align: el.align, font: el.font, bold: false, lineHeight: el.lineHeight };
      if (el.qtyShow && el.qtyPos === "below") {
        total += drawLines(ctx, measure, sub, el.qtySize, qty, x + el.noteIndent, y + total, el.w - el.noteIndent);
      }
      var note = it && it.note ? String(it.note) : "";
      if (el.noteShow && note) {
        total += drawLines(ctx, measure, sub, el.noteSize, "※ " + note, x + el.noteIndent, y + total, el.w - el.noteIndent);
      }
    });
    return total;
  }

  function drawLine(ctx, el, x, y) {
    ctx.save();
    ctx.strokeStyle = "#000";
    ctx.lineWidth = el.thickness;
    if (el.style === "dashed") ctx.setLineDash([10, 8]);
    var cy = y + el.thickness / 2;
    ctx.beginPath(); ctx.moveTo(x, cy); ctx.lineTo(x + el.w, cy); ctx.stroke();
    if (el.style === "double") {
      var cy2 = cy + el.thickness + 3;
      ctx.beginPath(); ctx.moveTo(x, cy2); ctx.lineTo(x + el.w, cy2); ctx.stroke();
    }
    ctx.restore();
  }

  function elementHeight(el, measure, order) {
    if (el.type === "line") return el.thickness + (el.style === "double" ? el.thickness + 3 : 0);
    if (el.type === "items") return drawItems(null, measure, el, order, el.x, 0);
    return drawLines(null, measure, el, el.size, fillFields(el.text, order), el.x, 0, el.w);
  }

  /**
   * レイアウトを解決する。品目リストは品数で伸縮するため、anchor:"items" の要素は
   * 「リスト下端からの相対位置」として配置し直す (品数が増えても重ならない)。
   * 戻り値: { placed:[{el, x, y, h}], height }
   */
  function layout(tpl, order, measure) {
    var itemsEl = null, itemsH = 0;
    tpl.elements.forEach(function (el) {
      if (el.type === "items" && !itemsEl) {
        itemsEl = el;
        itemsH = elementHeight(el, measure, order);
      }
    });
    var itemsBottom = itemsEl ? itemsEl.y + itemsH : 0;

    var placed = tpl.elements.map(function (el) {
      var y = el.anchor === "items" ? itemsBottom + el.y : el.y;
      var h = el === itemsEl ? itemsH : elementHeight(el, measure, order);
      return { el: el, x: el.x, y: y, h: h };
    });
    var bottom = placed.reduce(function (max, p) { return Math.max(max, p.y + p.h); }, 0);
    return { placed: placed, itemsBottom: itemsBottom, height: Math.min(MAX_HEIGHT, Math.max(1, Math.ceil(bottom + 8))) };
  }

  /**
   * canvas にテンプレートを描画する (canvas のサイズもここで確定させる)。
   * order は { store, table, meta, people, kind, orderNo, date, time, items:[{name,qty,note}] }
   */
  function renderToCanvas(canvas, tpl, order) {
    tpl = normalizeTemplate(tpl);
    var dots = DOTS[tpl.paperWidth];
    // 測定は本番と同じ ctx で行う (フォント指標がずれないように)。
    // canvas.width への代入は内容をクリアするため、高さ確定より先に測り切る
    var lay = layout(tpl, order, canvas.getContext("2d"));

    canvas.width = dots;
    canvas.height = lay.height;
    var ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, dots, lay.height);
    ctx.fillStyle = "#000";

    lay.placed.forEach(function (p) {
      if (p.el.type === "line") { drawLine(ctx, p.el, p.x, p.y); return; }
      if (p.el.type === "items") { drawItems(ctx, ctx, p.el, order, p.x, p.y); return; }
      drawLines(ctx, ctx, p.el, p.el.size, fillFields(p.el.text, order), p.x, p.y, p.el.w);
    });
    return { width: dots, height: lay.height, placed: lay.placed, itemsBottom: lay.itemsBottom };
  }

  /**
   * canvas を1bitラスター(MSB先頭・1=黒)へパックして base64 で返す。
   * サーバーはこれを GS v 0 / Star ラスターコマンドに載せてプリンターへ送る。
   */
  function canvasToRaster(canvas) {
    var w = canvas.width, h = canvas.height;
    var img = canvas.getContext("2d").getImageData(0, 0, w, h).data;
    var widthBytes = Math.ceil(w / 8);
    var out = new Uint8Array(widthBytes * h);
    for (var y = 0; y < h; y++) {
      var rowOut = y * widthBytes;
      var rowIn = y * w * 4;
      for (var x = 0; x < w; x++) {
        var i = rowIn + x * 4;
        // アンチエイリアスの灰色は2値化する。感熱紙は中間調が出ないため閾値で割り切る
        var lum = img[i] * 0.299 + img[i + 1] * 0.587 + img[i + 2] * 0.114;
        if (img[i + 3] > 64 && lum < 160) out[rowOut + (x >> 3)] |= (0x80 >> (x & 7));
      }
    }
    var bin = "";
    for (var j = 0; j < out.length; j += 8192) {
      bin += String.fromCharCode.apply(null, out.subarray(j, j + 8192));
    }
    return { width: w, height: h, data: btoa(bin) };
  }

  return {
    DOTS: DOTS,
    MAX_HEIGHT: MAX_HEIGHT,
    MAX_ELEMENTS: MAX_ELEMENTS,
    FONTS: FONTS,
    FIELDS: FIELDS,
    PARTS: PARTS,
    makePart: makePart,
    QTY_FORMATS: QTY_FORMATS,
    defaultTemplate: defaultTemplate,
    normalizeTemplate: normalizeTemplate,
    isTemplate: isTemplate,
    fillFields: fillFields,
    layout: layout,
    renderToCanvas: renderToCanvas,
    canvasToRaster: canvasToRaster,
  };
});
