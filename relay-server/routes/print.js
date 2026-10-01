"use strict";

var httpUtil = require("../http-util");
var requestAudit = require("../request-audit");

var json = httpUtil.json;
var recordAudit = requestAudit.recordAudit;

var PRINTER_TARGET = "printer:main";

/** 印字に必要な依存が揃っているか。checkDependencies を持たない差し替え実装は揃っている扱いにする */
function printerDependencies(printerModule) {
  return printerModule.checkDependencies ? printerModule.checkDependencies() : { ok: true };
}

/** POST /api/print — チビ伝を実機プリンターへ送る (#144)。IPは店内LANのプライベートアドレスのみ許可 */
function handlePrint(req, res, context) {
  var printerModule = context.printer;

  function fail(reason, error, code) {
    recordAudit(context.audit, "print.execute", PRINTER_TARGET, "failure", null, { reason: reason });
    return json(res, { ok: false, error: error }, code);
  }

  // 依存(iconv-lite)が入っていなければ、原因の分かる 503 で返す (#173)。
  // KDS 側は非200で window.print() にフォールバックするので、印刷操作自体は止まらない
  var deps = printerDependencies(printerModule);
  if (!deps.ok) return fail("dependency-unavailable", deps.error, 503);

  httpUtil.readJson(req, res, function (body) {
    // ip未指定はサーバー保存のプリンターIP(/api/printer)を使う。端末ごとの再登録を不要にする
    var ip = (body && body.ip) || (context.printerIp && context.printerIp.get());
    if (!printerModule.isPrivateIPv4(ip)) {
      return fail("invalid-ip", "printer ip must be a private LAN IPv4 address", 400);
    }
    var buffer;
    // ラスター(画像)が付いていれば画像として印字する。自由配置レイアウトの経路で、
    // プリンター内蔵フォントを使わないぶん書体・位置の制限が無い
    var raster = printerModule.normalizeRaster(body);
    if (raster) {
      try {
        buffer = printerModule.buildRaster(raster, {
          feedLines: body && body.feedLines,
          emulation: body && body.emulation,
        });
      } catch (err) {
        return fail("build-raster", "failed to build raster job: " + err.message, 500);
      }
    } else {
      if (body && body.raster) {
        // 寸法とデータ長が食い違うラスターは、黙ってテキスト印字に落ちると
        // 「何か出たが別物」になって原因が分かりにくい。ここで明示的に弾く
        return fail("invalid-raster", "invalid raster (width/height and data length do not match)", 400);
      }
      // style未指定はサーバー保存のスタイル(/api/slip-style)を使う。どの端末から印刷しても同じ見た目になる。
      // ただし保存されているのが自由配置レイアウトの場合、テキスト印字では解釈できないので使わない
      var saved = context.slipStyle ? context.slipStyle.get() : null;
      if (body && body.style == null && saved && !Array.isArray(saved.elements)) body.style = saved;
      var job = printerModule.normalizeJob(body);
      try { buffer = printerModule.buildEscPos(job); }
      catch (err) {
        return fail("build-job", "failed to build print job: " + err.message, 500);
      }
    }
    printerModule.sendToPrinter(ip, buffer).then(function () {
      recordAudit(context.audit, "print.execute", PRINTER_TARGET, "success", null, { configured: true });
      json(res, { ok: true });
    }).catch(function (err) {
      fail("send-failed", String(err && err.message || err), 502);
    });
  });
}

/* /api/printer — プリンターIP (#144追補)。スタイル同様サーバー保存にして、どの端末のKDSからでも
   登録なしで実機印刷できるようにする(iPadで再入力不要) */
function handlePrinterIp(req, res, context) {
  var printerIp = context.printerIp;
  if (req.method === "GET") return json(res, { ip: printerIp.get() });
  if (req.method === "POST") {
    return httpUtil.readJson(req, res, function (body) {
      var ip = body && body.ip != null ? String(body.ip).trim() : "";
      if (ip && !context.printer.isPrivateIPv4(ip)) {
        recordAudit(context.audit, "printer.update", PRINTER_TARGET, "failure", null,
          { configured: !!ip, reason: "invalid-ip" });
        return json(res, { ok: false, error: "printer ip must be a private LAN IPv4 address" }, 400);
      }
      var wasConfigured = !!printerIp.get();
      printerIp.set(ip);   // 空文字は「未設定に戻す」
      recordAudit(context.audit, "printer.update", PRINTER_TARGET, "success",
        { configured: wasConfigured }, { configured: !!ip });
      return json(res, { ok: true, ip: ip });
    });
  }
  return httpUtil.text(res, 405, "method not allowed");
}

/* /api/slip-style — 印刷スタイル (#144追補)。サーバー保存にすることで、設定した端末に関係なく
   KDSを開いた全端末(PC/iPad)が同じスタイルで印刷できる */
function handleSlipStyle(req, res, context) {
  var slipStyle = context.slipStyle;
  if (req.method === "GET") return json(res, slipStyle.get());
  if (req.method === "POST") {
    return httpUtil.readJson(req, res, function (body) {
      var beforeStyle = styleSummary(slipStyle.get());
      var savedStyle = slipStyle.set(body);
      recordAudit(context.audit, "slip-style.update", "slip-style:default", "success",
        beforeStyle, styleSummary(savedStyle));
      json(res, { ok: true, style: savedStyle });
    });
  }
  return httpUtil.text(res, 405, "method not allowed");
}

/** 監査ログ用。スタイルの中身は残さず、設定の有無・種類・要素数だけを要約する */
function styleSummary(style) {
  style = style || {};
  return {
    configured: !!Object.keys(style).length,
    layout: Array.isArray(style.elements) ? "free-layout" : "text",
    count: Array.isArray(style.elements) ? style.elements.length : 0,
  };
}

module.exports = {
  printerDependencies: printerDependencies,
  handlePrint: handlePrint,
  handlePrinterIp: handlePrinterIp,
  handleSlipStyle: handleSlipStyle,
};
