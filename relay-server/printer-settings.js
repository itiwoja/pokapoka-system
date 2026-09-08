"use strict";

var fs = require("fs");

/**
 * 印刷スタイルの保存領域 (#144追補)。printer.normalizeStyle で許容値へ丸めてから
 * メモリ+ファイル(config/slip-style.json)に保持する。ファイルは再起動しても設定が
 * 残るようにするためで、環境ごとに値が違うので git 管理しない。
 */
function createSlipStyleStore(filePath, printerModule, log) {
  var MAX_TEMPLATE_BYTES = 50000;

  /* 自由配置レイアウト(elements[])は描画がブラウザ側なので、サーバーは中身を解釈しない。
     形(配列であること)とサイズだけ検査してそのまま預かる。旧テキスト型は従来どおり丸める */
  function accept(raw) {
    if (raw && typeof raw === "object" && Array.isArray(raw.elements)) {
      var json = JSON.stringify(raw);
      if (json.length > MAX_TEMPLATE_BYTES) {
        log("slip-style: レイアウトが大きすぎるため保存しません (" + json.length + " bytes)");
        return null;
      }
      return JSON.parse(json);
    }
    return printerModule.normalizeStyle(raw);
  }

  var current = null;
  try {
    current = accept(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch (e) { current = null; }  // 無い・壊れているときは未設定扱い
  return {
    get: function () { return current || {}; },
    set: function (body) {
      var next = accept(body);
      if (!next) return current || {};   // 上限超過。既存の設定は壊さない
      current = next;
      try { fs.writeFileSync(filePath, JSON.stringify(current, null, 2) + "\n", "utf8"); }
      catch (err) { log("slip-style の保存に失敗(メモリ上は反映済み): " + err.message); }
      return current;
    },
  };
}

/** プリンターIPの保存領域 (#144追補)。空文字=未設定。ファイルはgit管理外 */
function createPrinterIpStore(filePath, printerModule, log) {
  var current = "";
  try {
    var loaded = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (loaded && printerModule.isPrivateIPv4(loaded.ip)) current = loaded.ip;
  } catch (e) {}
  return {
    get: function () { return current; },
    set: function (ip) {
      current = ip || "";
      try { fs.writeFileSync(filePath, JSON.stringify({ ip: current }, null, 2) + "\n", "utf8"); }
      catch (err) { log("printer-ip の保存に失敗(メモリ上は反映済み): " + err.message); }
    },
  };
}

module.exports = {
  createSlipStyleStore: createSlipStyleStore,
  createPrinterIpStore: createPrinterIpStore,
};
