# 注文通信ブラウザ検証ハーネス (検証専用)

`order-client.js` を実ブラウザ (headless Chromium・実IndexedDB) と実relay (MOCK・127.0.0.1) で動かす検証一式。製品コードは変更しない。結果は `docs/注文通信ブラウザ検証記録_2026-10-03.md`。

- `harness-proxy.js`: 同一origin前段サーバー。`/harness` と `/order-client.js` を配信し、他は実relayへ中継する。`POST /api/orders` にだけ通信障害 (切断・応答喪失・遅延・任意HTTPステータス・不正ACK) を注入する。relayの静的配信は許可リスト制のため、検証画面はrelayからではなくこの前段から配信する。
- `harness.html`: 最小の検証画面 (カート・二重タップ防止・状態表示・IndexedDB障害の注入点)。
- `run.js`: Playwrightのシナリオ実行。
- `evidence-2026-10-03/`: 2026-10-03 の実行結果JSONとスクリーンショット。

## 再実行

検証対象のコミットを使い捨てのcloneに用意する (リポジトリ内では動かさない)。

```bash
git clone <repo> /tmp/oc/main && (cd /tmp/oc/main && npm --prefix relay-server ci)
mkdir -p /tmp/oc/pw && (cd /tmp/oc/pw && npm init -y && npm i playwright-core)
export PW_MODULE=/tmp/oc/pw/node_modules/playwright-core
export CHROME_PATH=<playwrightのchromium実行ファイル>   # 例: ~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome
node tests/browser/order-comm/run.js --root /tmp/oc/main --label main --out /tmp/oc/out
```

- `BASE_PORT` (既定 4410) から2ポートずつ、シナリオごとに使う。使用中でないことを確認する。
- `ONLY=<正規表現>` で一部のシナリオだけ実行できる。
- WSLでChromiumが `libnss3` `libnspr4` `libasound.so.2` 不足で起動しない場合は、`apt-get download` と `dpkg-deb -x` で取り出して `LD_LIBRARY_PATH` に加える。
- 終了時にrelayプロセスは自動で止まる。TableCheck LIVEには接続しない (`TABLECHECK_API_KEY` を空にしてMOCKで起動)。
