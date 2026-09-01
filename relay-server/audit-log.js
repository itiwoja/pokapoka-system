/**
 * audit-log.js — 重要操作向けの、依存ゼロ・上限付き監査ログ。
 *
 * 注文/予約の実データを保存するものではない。操作名、対象ID、結果、端末、
 * 変更の最小要約だけを JSONL で永続化する。全APIは best effort で、監査ログの
 * 障害を業務操作へ例外として伝播させない。
 */
"use strict";

var fs = require("fs");
var path = require("path");

var DEFAULT_FILE = path.resolve(__dirname, "..", "config", "audit-log.jsonl");
var DEFAULT_RETENTION_DAYS = 30;
var DEFAULT_MAX_RECORDS = 3000;
var MAX_TEXT = 160;
var tempSequence = 0;

/* before/after に保存してよい、個人・注文内容を含まない状態語だけを列挙する。 */
var SUMMARY_KEYS = {
  status: 1, state: 1, table: 1, seat: 1, code: 1, reason: 1,
  mode: 1, source: 1, enabled: 1, configured: 1, printer: 1,
  layout: 1, style: 1, count: 1, itemCount: 1,
};

var SENSITIVE_KEY = /(authorization|cookie|token|secret|password|raw.?url|url|order|customer|guest|reservation|items?|menu|name|allerg|note|body|payload|detail)/i;
var SENSITIVE_VALUE = /(https?:\/\/|\bbearer\s+|(?:^|[?;&\s])(?:token|access_token|relay_token)=|\bcookie\s*:|\bauthorization\s*:)/i;

function finitePositive(value, fallback) {
  var n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function report(logger, message, err) {
  try {
    if (logger && typeof logger.error === "function") logger.error(message, err);
  } catch (ignored) {
    // logger 自身の障害も業務操作へ伝播させない。
  }
}

function safeText(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  var text = String(value).replace(/[\r\n\t]+/g, " ").trim();
  if (!text) return fallback;
  if (SENSITIVE_VALUE.test(text)) return "[redacted]";
  return text.slice(0, MAX_TEXT);
}

function safeSummary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  var result = {};
  Object.keys(value).forEach(function (key) {
    if (!SUMMARY_KEYS[key] || SENSITIVE_KEY.test(key)) return;
    var item = value[key];
    if (typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) {
      result[key] = item;
    } else if (typeof item === "string") {
      result[key] = safeText(item, "");
    }
  });
  return Object.keys(result).length ? result : null;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function validStoredRecord(value) {
  return !!value && typeof value === "object" &&
    typeof value.timestamp === "string" && !Number.isNaN(Date.parse(value.timestamp)) &&
    typeof value.operation === "string" && typeof value.target === "string" &&
    typeof value.result === "string" && value.actor && typeof value.actor === "object" &&
    typeof value.actor.authMechanism === "string" &&
    typeof value.actor.device === "string" && typeof value.actor.ip === "string";
}

function sanitizeStoredRecord(value) {
  if (!validStoredRecord(value)) return null;
  return {
    timestamp: new Date(Date.parse(value.timestamp)).toISOString(),
    operation: safeText(value.operation, "unknown"),
    target: safeText(value.target, "unknown"),
    result: safeText(value.result, "unknown"),
    actor: {
      authMechanism: safeText(value.actor.authMechanism, "unknown"),
      device: safeText(value.actor.device, "unknown"),
      ip: safeText(value.actor.ip, "unknown"),
    },
    before: safeSummary(value.before),
    after: safeSummary(value.after),
  };
}

function createAuditLog(options) {
  options = options || {};
  var filePath = options.filePath || DEFAULT_FILE;
  var retentionDays = finitePositive(options.retentionDays, DEFAULT_RETENTION_DAYS);
  var maxRecords = finitePositive(options.maxRecords, DEFAULT_MAX_RECORDS);
  var logger = options.logger || console;
  var now = typeof options.now === "function" ? options.now : Date.now;
  var records = [];

  function nowMs() {
    try {
      var value = Number(now());
      return Number.isFinite(value) ? value : Date.now();
    } catch (err) {
      report(logger, "監査ログの時計を読めないためシステム時刻を使う", err);
      return Date.now();
    }
  }

  function bounded(source, atMs) {
    var cutoff = atMs - retentionDays * 24 * 60 * 60 * 1000;
    return source.filter(function (entry) {
      var time = Date.parse(entry.timestamp);
      return Number.isFinite(time) && time >= cutoff;
    }).slice(-maxRecords);
  }

  function persist(next) {
    // 同一プロセスで複数relayを並行起動するテストや移行作業でも、一時ファイル名を
    // 共有して上書きしない。最終renameは原子的なので、壊れた途中行を公開しない。
    tempSequence += 1;
    var temp = filePath + ".tmp-" + process.pid + "-" + tempSequence;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      var data = next.map(function (entry) { return JSON.stringify(entry); }).join("\n");
      if (data) data += "\n";
      fs.writeFileSync(temp, data, { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temp, filePath);
      return true;
    } catch (err) {
      try { fs.unlinkSync(temp); } catch (ignored) { /* best effort */ }
      report(logger, "監査ログを書き込めない: " + filePath, err);
      return false;
    }
  }

  function load() {
    var raw;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch (err) {
      if (err.code !== "ENOENT") report(logger, "監査ログを読めない: " + filePath, err);
      return;
    }

    var invalid = false;
    raw.split(/\r?\n/).forEach(function (line) {
      if (!line.trim()) return;
      try {
        var parsed = JSON.parse(line);
        var sanitized = sanitizeStoredRecord(parsed);
        if (sanitized) {
          records.push(sanitized);
          if (JSON.stringify(sanitized) !== JSON.stringify(parsed)) invalid = true;
        } else invalid = true;
      } catch (err) {
        invalid = true;
      }
    });
    if (invalid) report(logger, "監査ログ内の不正な行を無視した: " + filePath);

    var next = bounded(records, nowMs());
    if (invalid || next.length !== records.length) persist(next);
    records = next;
  }

  function record(event) {
    try {
      event = event || {};
      var actor = event.actor || {};
      var entry = {
        timestamp: new Date(nowMs()).toISOString(),
        operation: safeText(event.operation, "unknown"),
        target: safeText(event.target, "unknown"),
        result: safeText(event.result, "unknown"),
        actor: {
          authMechanism: safeText(actor.authMechanism, "unknown"),
          device: safeText(actor.device, "unknown"),
          ip: safeText(actor.ip, "unknown"),
        },
        before: safeSummary(event.before),
        after: safeSummary(event.after),
      };
      var next = bounded(records.concat([entry]), nowMs());
      if (!persist(next)) return null;
      records = next;
      return clone(entry);
    } catch (err) {
      report(logger, "監査イベントを記録できない", err);
      return null;
    }
  }

  function query(filters) {
    filters = filters || {};
    try {
      var from = filters.from === undefined ? null : Date.parse(filters.from);
      var to = filters.to === undefined ? null : Date.parse(filters.to);
      var operation = filters.operation === undefined ? null : String(filters.operation);
      var target = filters.target === undefined ? null : String(filters.target);
      var limit = finitePositive(filters.limit, maxRecords);
      var cutoff = nowMs() - retentionDays * 24 * 60 * 60 * 1000;
      return records.filter(function (entry) {
        var time = Date.parse(entry.timestamp);
        if (time < cutoff) return false;
        if (Number.isFinite(from) && time < from) return false;
        if (Number.isFinite(to) && time > to) return false;
        if (operation !== null && entry.operation !== operation) return false;
        if (target !== null && entry.target !== target) return false;
        return true;
      }).slice(-Math.min(limit, maxRecords)).map(clone);
    } catch (err) {
      report(logger, "監査ログを検索できない", err);
      return [];
    }
  }

  function exportJSONL(filters) {
    var selected = query(filters);
    return selected.map(function (entry) { return JSON.stringify(entry); }).join("\n") +
      (selected.length ? "\n" : "");
  }

  function prune() {
    try {
      var next = bounded(records, nowMs());
      var removed = records.length - next.length;
      if (removed && persist(next)) records = next;
      return removed;
    } catch (err) {
      report(logger, "監査ログを削除できない", err);
      return 0;
    }
  }

  load();
  return {
    record: record,
    query: query,
    exportJSONL: exportJSONL,
    prune: prune,
    filePath: filePath,
    retentionDays: retentionDays,
    maxRecords: maxRecords,
  };
}

module.exports = {
  createAuditLog: createAuditLog,
  DEFAULT_FILE: DEFAULT_FILE,
  DEFAULT_RETENTION_DAYS: DEFAULT_RETENTION_DAYS,
  DEFAULT_MAX_RECORDS: DEFAULT_MAX_RECORDS,
};
