/**
 * preflight.js — 「他端末から中継サーバーに繋がるか」を現地で切り分ける診断 (#140)
 *
 * デシャップモニターも注文端末も、ミニPCのアドレスへWiFi経由で接続する。
 * ここが通らないと予約表示も注文連携も机上の実装のままになるが、繋がらない原因は
 * だいたい設定以外のところにある: bind先・固定IP・ファイアウォール・ネットワークプロファイル。
 *
 * このスクリプトは**読み取りしかしない**。設定もファイアウォールも書き換えないので、
 * 現地で何度実行しても安全。
 *
 * 使い方:
 *   node relay-server/preflight.js          (サーバーは起動していてもいなくてもよい)
 *   cd relay-server && npm run preflight
 */
"use strict";

var os = require("os");
var net = require("net");
var http = require("http");
var childProcess = require("child_process");
var loadConfig = require("./load-config");

/* server.js の resolveHost()/detectLanIp() と同じ規則。
   診断ツールはサーバー本体が読み込めない状況でこそ使うので、あえて依存しない */
function detectLanIp() {
  var candidates = lanAddresses().filter(function (a) { return !a.linkLocal; });
  var wifi = candidates.filter(function (c) { return /wi-?fi|wlan|無線/i.test(c.name); });
  var hit = wifi[0] || candidates[0];
  return hit ? hit.address : null;
}
function resolveHost(value) {
  if (!value) return "127.0.0.1";
  if (value !== "auto") return value;
  return detectLanIp() || "127.0.0.1";
}

var OK = "✅", WARN = "⚠️", NG = "❌";
var problems = 0;
var warnings = 0;

function say(line) { console.log(line); }
function ok(line) { say(OK + " " + line); }
function warn(line) { warnings++; say(WARN + " " + line); }
function ng(line) { problems++; say(NG + " " + line); }
function note(line) { say("     " + line); }
function heading(line) { say("\n" + line + "\n" + "-".repeat(line.length)); }

/* --- Windows のネットワーク情報。読み取り専用のコマンドだけを使う --- */
function powershell(command) {
  if (process.platform !== "win32") return undefined;
  try {
    // 既定の出力コードページ(日本語環境はCP932)だとインターフェース名が化けるのでUTF-8に固定する。
    // stderr は握って表示しない(権限不足の生エラーより、こちらの日本語メッセージの方が役に立つ)
    var out = childProcess.execFileSync("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command",
        "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; " + command],
      { encoding: "utf8", timeout: 15000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    var text = String(out).trim();
    return text ? JSON.parse(text) : null;
  } catch (err) {
    return undefined;   // 取得できなかった (null = 該当なし と区別する)
  }
}

/* PowerShell の列挙型は ConvertTo-Json で数値になる。Select-Object 側で文字列化しておく */
function asText(name) {
  return "@{n='" + name + "';e={[string]$_." + name + "}}";
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function lanAddresses() {
  var ifaces = os.networkInterfaces();
  var list = [];
  Object.keys(ifaces).forEach(function (name) {
    (ifaces[name] || []).forEach(function (addr) {
      if (addr.family !== "IPv4" || addr.internal) return;
      list.push({ name: name, address: addr.address, linkLocal: addr.address.indexOf("169.254.") === 0 });
    });
  });
  return list;
}

function tcpReachable(host, port, timeoutMs) {
  return new Promise(function (resolve) {
    var socket = net.connect({ host: host, port: port });
    var done = false;
    function finish(result) {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(result);
    }
    socket.setTimeout(timeoutMs || 2000);
    socket.on("connect", function () { finish(true); });
    socket.on("timeout", function () { finish(false); });
    socket.on("error", function () { finish(false); });
  });
}

function httpGet(host, port, pathname, timeoutMs) {
  return new Promise(function (resolve) {
    var req = http.get({ host: host, port: port, path: pathname, timeout: timeoutMs || 3000 }, function (res) {
      var chunks = [];
      res.on("data", function (c) { chunks.push(c); });
      res.on("end", function () {
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") });
      });
    });
    req.on("timeout", function () { req.destroy(); resolve({ status: 0, body: "timeout" }); });
    req.on("error", function (err) { resolve({ status: 0, body: err.message }); });
  });
}

/* ===================== 1. 設定 ===================== */
function checkConfig() {
  heading("1. 設定 (config/config.json)");
  var file;
  try { file = loadConfig.load(); }
  catch (err) {
    ng("設定ファイルを読めない: " + err.message);
    note("雛形: config/config.example.json をコピーして config/config.json を作る");
    return null;
  }
  if (!Object.keys(file).length) {
    warn("config/config.json が無い (既定値で動く = host は 127.0.0.1)");
    note("cp config/config.example.json config/config.json");
  } else {
    ok("設定を読み込んだ: " + loadConfig.DEFAULT_PATH);
  }

  var merged = loadConfig.mergeEnv(file, process.env);
  var rawHost = merged.HOST || "(未設定)";
  var port = Number(merged.PORT) || 8000;
  var host = resolveHost(merged.HOST);
  note("server.host: " + rawHost + (rawHost !== host ? "  →  実際の待ち受け: " + host : ""));
  note("server.port: " + port);
  return { rawHost: rawHost, host: host, port: port };
}

/* ===================== 2. 待ち受けアドレス ===================== */
function checkBind(config) {
  heading("2. 待ち受けアドレスは他端末から届くか");
  var addresses = lanAddresses();
  var usable = addresses.filter(function (a) { return !a.linkLocal; });

  if (!usable.length) {
    ng("LANのIPv4アドレスが1つも見つからない (WiFi/有線に繋がっていない可能性)");
    return addresses;
  }
  usable.forEach(function (a) { note("このPCのIP: " + a.address + "  (" + a.name + ")"); });
  addresses.filter(function (a) { return a.linkLocal; }).forEach(function (a) {
    warn("リンクローカルアドレス " + a.address + " (" + a.name + ") — DHCPからIPを取得できていない");
  });

  if (config.host === "127.0.0.1" || config.host === "localhost") {
    ng("127.0.0.1 で待ち受ける設定 — ミニPC自身からしか到達できない");
    note('config/config.json の server.host を "auto" か上記のLAN固定IPにする');
  } else if (config.host === "0.0.0.0" || config.host === "::") {
    warn("0.0.0.0 (全インターフェース) で待ち受ける設定 — 到達範囲が広すぎる");
    note('隔離LAN/VLAN側のIPを指定するか "auto" にする');
  } else if (!usable.some(function (a) { return a.address === config.host; })) {
    ng("待ち受け設定 " + config.host + " は、このPCのどのIPとも一致しない");
    note('IPが変わった可能性がある (DHCP)。上記のIPに合わせるか "auto" にする');
  } else {
    ok("待ち受け " + config.host + " はこのPCのLAN IPと一致している");
  }
  return addresses;
}

/* ===================== 3. IPが固定されているか ===================== */
function checkStaticIp(config) {
  heading("3. IPが固定されているか (DHCPだと再起動でアドレスが変わる)");
  var rows = powershell(
    "Get-NetIPAddress -AddressFamily IPv4 | " +
    "Where-Object { $_.IPAddress -ne '127.0.0.1' } | " +
    "Select-Object IPAddress, " + asText("PrefixOrigin") + ", InterfaceAlias | ConvertTo-Json -Compress");
  if (rows === undefined) {
    warn("IPの割り当て方法を確認できなかった (手動で確認する)");
    return;
  }
  var list = asArray(rows);
  if (!list.length) { warn("IPv4アドレスの情報を取得できなかった"); return; }

  list.forEach(function (row) {
    var origin = String(row.PrefixOrigin);
    var label = row.IPAddress + " (" + row.InterfaceAlias + "): " + origin;
    if (origin === "Manual") {
      ok(label + " — 静的IP");
    } else if (row.IPAddress === config.host) {
      warn(label + " — DHCP。再起動でアドレスが変わると config.json が陳腐化する");
      note('ルーターでDHCP予約するか静的IPにする (server.host を "auto" にする手もある)');
    } else {
      note(label);
    }
  });
}

/* ===================== 4. ネットワークプロファイル ===================== */
function checkNetworkProfile() {
  heading("4. ネットワークプロファイル (パブリックは受信が既定でブロック)");
  var rows = powershell("Get-NetConnectionProfile | Select-Object Name, " +
    asText("NetworkCategory") + ", InterfaceAlias | ConvertTo-Json -Compress");
  if (rows === undefined) { warn("プロファイルを確認できなかった (手動で確認する)"); return; }
  var list = asArray(rows);
  if (!list.length) { warn("接続中のネットワークが見つからない"); return; }

  list.forEach(function (row) {
    var category = String(row.NetworkCategory);
    var label = row.Name + " (" + row.InterfaceAlias + "): " + category;
    if (category === "Public") {
      ng(label + " — パブリックでは受信が既定でブロックされる");
      note("設定 > ネットワーク > プロパティ から「プライベート ネットワーク」に変更する");
    } else {
      ok(label);
    }
  });
}

/* ===================== 5. ファイアウォール ===================== */
function checkFirewall(config) {
  heading("5. ファイアウォール (ポート " + config.port + " の受信許可)");
  var rows = powershell(
    "Get-NetFirewallPortFilter | Where-Object { $_.Protocol -eq 'TCP' -and $_.LocalPort -eq '" + config.port + "' } | " +
    "ForEach-Object { $_ | Get-NetFirewallRule } | " +
    "Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' } | " +
    "Select-Object DisplayName, " + asText("Action") + ", " + asText("Profile") + " | ConvertTo-Json -Compress");
  if (rows === undefined) {
    warn("ファイアウォール規則を確認できなかった (規則の照会には管理者権限が要ることがある)");
    note("管理者のPowerShellで確認する:");
    note("  Get-NetFirewallPortFilter | ? { $_.Protocol -eq 'TCP' -and $_.LocalPort -eq '" + config.port + "' } |" +
      " % { $_ | Get-NetFirewallRule } | ? { $_.Direction -eq 'Inbound' } | ft DisplayName, Enabled, Action");
    return;
  }

  var list = asArray(rows);
  var allow = list.filter(function (r) { return String(r.Action) === "Allow"; });
  var block = list.filter(function (r) { return String(r.Action) === "Block"; });

  if (block.length) {
    ng("ポート " + config.port + " をブロックする受信規則がある: " +
      block.map(function (r) { return r.DisplayName; }).join(", "));
  }
  if (allow.length) {
    ok("受信を許可する規則がある: " + allow.map(function (r) {
      return r.DisplayName + " [" + r.Profile + "]";
    }).join(", "));
  } else if (!block.length) {
    warn("ポート " + config.port + " の受信を明示的に許可する規則が見つからない");
    note("初回起動時のダイアログで許可していれば規則名が違うことがある。塞がっていたら管理者権限で:");
    note('  netsh advfirewall firewall add rule name="pokapoka relay ' + config.port +
      '" dir=in action=allow protocol=TCP localport=' + config.port);
  }
}

/* ===================== 6. サーバーが応答するか ===================== */
async function checkServer(config) {
  heading("6. サーバーの応答");
  // 127.0.0.1/0.0.0.0 待ち受けのときは「他端末から見えるはずのIP」を推定して試す (Wi-Fi優先)
  var target = (config.host !== "127.0.0.1" && config.host !== "localhost" &&
    config.host !== "0.0.0.0" && config.host !== "::")
    ? config.host
    : detectLanIp();

  // LAN IP で待ち受けていると 127.0.0.1 には繋がらない。両方を見てから「起動していない」と言う
  var loopback = await tcpReachable("127.0.0.1", config.port, 1500);
  var reachable = target ? await tcpReachable(target, config.port, 2500) : false;

  if (!loopback && !reachable) {
    warn("ポート " + config.port + " で待ち受けているものが無い — サーバーが起動していない");
    note("別のターミナルで: node relay-server/server.js");
    return target;
  }
  if (loopback) ok("127.0.0.1:" + config.port + " で待ち受けている");

  if (!target) { warn("LAN側のアドレスが特定できないため、他端末からの到達性は確認できない"); return target; }
  if (!reachable) {
    ng(target + ":" + config.port + " に接続できない — 他端末からも繋がらない");
    note("上の 2〜5 の指摘を先に潰す (待ち受けアドレス / ファイアウォール / プロファイル)");
    return target;
  }
  ok(target + ":" + config.port + " に接続できた");

  var health = await httpGet(target, config.port, "/api/health", 3000);
  if (health.status === 200) {
    ok("GET http://" + target + ":" + config.port + "/api/health → 200");
    try {
      var body = JSON.parse(health.body);
      note("モード: " + body.mode + " / 予約の初回同期: " + (body.ready ? "完了" : "未完了") +
        (body.count !== undefined ? " / 保持件数: " + body.count : ""));
      if (!body.ready) note("初回同期が終わるまで /api/stock は 503 (KDSは直前の表示を保持する)");
    } catch (e) { /* 本文の形は本質ではないので流す */ }
  } else {
    ng("GET /api/health が " + (health.status || "失敗") + " (" + health.body + ")");
  }

  var kds = await httpGet(target, config.port, "/", 3000);
  if (kds.status === 200) ok("KDS 画面を配信できている: http://" + target + ":" + config.port + "/");
  else if (kds.status === 401) warn("KDS 画面が 401 — 共有トークン認証が有効。他端末は /qr のQRから開く");
  else ng("KDS 画面が " + (kds.status || "失敗") + " (" + String(kds.body).slice(0, 80) + ")");

  return target;
}

/* ===================== 人が確認する部分 ===================== */
function manualChecklist(config, target) {
  heading("7. ここから先は人の目で確認する");
  var base = "http://" + (target || "<ミニPCのIP>") + ":" + config.port;
  note("1. 別端末のブラウザで " + base + "/ を開き、KDS が表示されるか");
  note("2. 予約が KDS の予約ストックに出るか (MOCKなら " + base + "/demo から作れる)");
  note("3. 実機2台で厨房状態 (コンロ・完了) が同期するか — #132");
  note("4. 注文端末から POST /api/orders が通るか — #139");
  note("5. 来客用WiFiからは到達しないこと (客のスマホで開いて繋がらないのを確認) — #174");
}

(async function main() {
  say("ぽかぽか 中継サーバー 疎通診断 (#140)");
  say("読み取りのみ。設定もファイアウォールも変更しません。");

  var config = checkConfig();
  if (!config) { process.exit(1); return; }
  checkBind(config);
  checkStaticIp(config);
  checkNetworkProfile();
  checkFirewall(config);
  var target = await checkServer(config);
  manualChecklist(config, target);

  heading("結果");
  if (problems) {
    say(NG + " 要対処 " + problems + " 件 / 注意 " + warnings + " 件 — 上の " + NG + " から順に潰す");
  } else if (warnings) {
    say(WARN + " 注意 " + warnings + " 件 — 致命的な問題は無し");
  } else {
    say(OK + " 問題なし");
  }
  process.exit(problems ? 1 : 0);
})();
