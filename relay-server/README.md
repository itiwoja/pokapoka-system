# relay-server — 店内中継サーバー(TableCheck取込 + Web配信)

TableCheck の予約(メニュー・人数等)を取得し、KDS の予約ストックに流し込むためのサーバー。
6/18 議事録の「ファイルを置くだけの見かけ上のサーバー」役と、TableCheck 取込役の2役を1プロセスで担う。
**依存パッケージはほぼゼロ・Node 18+ で動作**(本体リポジトリの単一HTML主義に合わせた設計)。
唯一の例外は `printer.js` の日本語ESC/POS印字用 `iconv-lite`(Node標準にShift_JIS変換が無いため。#144)。
初回のみ `cd relay-server && npm install` が必要。

```
【クラウド】               【店内ミニPC = このサーバー】          【KDS端末】
TableCheck ◀── 30秒差分pull ─ server.js ── /api/stock(JSON) ──▶ kds-bridge.js
(Booking v1 + Sync v1)       当日分のみメモリ保持                  → kds_stock_v1 へマージ
           ◀── 起動時+15分毎の当日全件リシンク
                            kds-a-grid.html も配信                → BroadcastChannel で全端末反映
```

## 予約が本当にデシャップまで届くかを手で検証する（デモコンソール）

API 契約前でも、**予約SaaS(TableCheck) の操作を模した最小パネル** `tablecheck-demo.html`
から予約を作成/人数変更/キャンセルして、KDS(デシャップ)に反映されるまでを実機で確認できる。

```
【デモコンソール /demo】        【このサーバー(MOCK)】          【KDS /】
予約を作成/変更/キャンセル ──▶ /api/mock/reservations ──▶ 正規化 ──▶ /api/stock
(本物のTableCheckスキーマ形)    → 数秒でポーリング反映         → 注入済みブリッジが取込
                                                            → 予約ストックに出る
```

- 送信する予約は**確定済みの本物 TableCheck Reservation スキーマ**(`first_name`/`last_name`,
  `pax_adult`/`pax_child`, `orders[].menu_item_name_translations`, `special_request`, `status`)で
  組み立てる。本番切替時は供給源(`mock`)を実データに差し替えるだけで、正規化以降は無変更。
- KDS 配信時にブリッジ(`kds-bridge.js`)を**サーバー側で1行注入**するので、`/` を開くだけで
  取込が始まる(KDS 本体ファイルは無改修)。同一タブ内でも反映される。
- 手順: `node relay-server/server.js` → ブラウザで `/demo`(操作) と `/`(デシャップ) を**並べて開く**
  → コンソールで予約を作る → 数秒で予約ストックに出る。

- 通信は**店内→TableCheck の外向き(pull)のみ**。Webhook(push)は店内が NAT 内のため使わない(2026-06-04 検討/裏どり済み)。
- Sync v1 の差分ポーリング間隔は **30秒未満不可**(TableCheck指定。コード側で下限を強制)。
- Booking v1 の当日全件リシンクは**起動時と15分ごと**に実行する。`page=0`、`per_page=200`から
  空ページまで取得し、全ページ成功後だけメモリ上のstoreを一括差し替える。
- 初回全件リシンクが成功するまで `/api/stock` は **503** を返す。KDSブリッジは非200時に
  直前表示を保持するため、再起動直後の空配列による予約一括削除を防げる。
- 予約データは**メモリのみ・当日分のみ**保持(6/18 議事録「サーバに保存しない」を実装で担保)。

## 使い方

### いますぐ試す(API契約前・モックモード)

```sh
node relay-server/server.js        # APIキー未設定なら自動でモック
# または明示的に
MOCK=1 node relay-server/server.js
```

- http://127.0.0.1:8000/demo … **予約デモコンソール**(ここで予約を作成/変更/キャンセル)
- http://127.0.0.1:8000/ … **KDS(デシャップ)**(作った予約がここに出る)

**KDS は空の状態から始まる**(中継サーバー配信時は KDS 内蔵の自動デモを抑止するため)。
コンソールから予約を作れば、数秒後に KDS の予約ストックへ反映され、
「人数変更(updated)」「キャンセル(→ストックから消える)」も手で試せる。
開いてすぐ1件見せたいときは `SEED=1 node relay-server/server.js` で起動する。

> MOCK モードではポーリング間隔の 30秒下限を撤廃し既定 3秒(`POLL_MS` で変更可)。
> `/api/mock/*` の注入エンドポイントは MOCK 時のみ有効(LIVE では 403)。
> KDS の自動デモ抑止は、配信時に注入する `window.__KDS_SUPPRESS_DEMO__` フラグ、
> または URL の `?nodemo=1` で効く(単体で開いた KDS は従来どおり自動デモ)。

### 接続設定(config/config.json)

接続先は**リポジトリ直下の `config/` に置く**。雛形をコピーして店舗の実値へ書き換える:

```sh
cp config/config.example.json config/config.json
```

```json
{
  "server":     { "host": "192.168.1.10", "port": 8000 },
  "tablecheck": { "base": "https://api.tablecheck.com", "shopId": "<shop_id>",
                  "pollMs": 30000, "resyncMs": 900000, "timeoutMs": 15000 },
  "seat":       { "beforeMin": 30, "afterMin": 120 }
}
```

- `config/config.json` は**環境ごとに値が違うため .gitignore 済み**。管理するのは雛形の
  `config.example.json` だけ。
- 優先順位は **既定値 < `config/config.json` < 環境変数**。環境変数は一時的な上書きに使える
  (例: `PORT=8200 node relay-server/server.js`)。
- **APIキーは config.json に書かない**。書いてあると起動時にエラーで止まる。理由は、黙って
  無視すると「キーを書いたのに MOCK のまま予約が流れない」という原因の掴めない失敗になるため。
- キー名を間違えた場合も**黙って既定値に落ちず、起動時に指摘して止まる**。

| config.json | 環境変数 | 既定 | 説明 |
|---|---|---|---|
| `server.host` | `HOST` | 127.0.0.1 | listen先。**デシャップモニターと注文端末はここへ繋ぐ** |
| `server.port` | `PORT` | 8000 | HTTP ポート |
| `tablecheck.pollMs` | `POLL_MS` | 30000 | ポーリング間隔(下限30000) |
| `tablecheck.resyncMs` | `RESYNC_MS` | 900000 | Booking v1 当日全件リシンク間隔(既定15分、LIVE最小1分) |
| `tablecheck.timeoutMs` | `TABLECHECK_TIMEOUT_MS` | 15000 | TableCheck接続+JSON読込のタイムアウト(1〜120秒) |
| `tablecheck.shopId` | `SHOP_ID` | — | 対象店舗。LIVEでは必須 |
| `tablecheck.base` | `TABLECHECK_BASE` | api.tablecheck.com | 旧 tablesolution.com は2026年廃止のため使わない |
| `tablecheck.allowCustomBase` | `TABLECHECK_ALLOW_CUSTOM_BASE` | 0 | 公式以外のHTTPS接続先を明示許可する場合のみ |
| `seat.beforeMin` / `seat.afterMin` | `SEAT_BEFORE_MIN` / `SEAT_AFTER_MIN` | 30 / 120 | 予約時刻の前後どこまでを在席とみなすか |
| **(不可)** | `TABLECHECK_API_KEY` | — | secret_key。**環境変数のみ**。未設定ならモック |
| **(不可)** | `MOCK` | — | `1` でモック強制 |

### 本番(API契約後・店内LANの端末へ配信)

```sh
TABLECHECK_API_KEY=<secret_key> node relay-server/server.js   # host/shopId は config.json
```

`server.host` 未指定時は安全のため `127.0.0.1` のみにbindする。**この既定のままだとミニPC自身
からしか到達できず、デシャップモニターや注文端末からは繋がらない**ので、店内LANの固定IPを
設定すること。`0.0.0.0`（全IF）を避け、信頼できる隔離LAN/VLANとOSファイアウォールで
対象端末だけを許可する。インターネットへのポート開放や、来客用Wi-Fiからの到達は許可しない。

WiFi越しに初めて繋ぐときは、設定以外の次の点も確認する(繋がらない原因の大半がここ):

- **ミニPCのIPが固定されているか** — DHCPだと再起動でアドレスが変わり `config.json` が陳腐化する
- **OSファイアウォールでポート8000の受信が許可されているか** — bindできていても弾かれる
- **WiFiのネットワークプロファイルが「パブリック」でないか** — パブリックは受信が既定でブロック

### エンドポイント

| パス | 内容 |
|---|---|
| `/` , `/kds-a-grid.html` | KDS 本体(配信時にブリッジを1行注入) |
| `/demo` | 予約デモコンソール(`tablecheck-demo.html`) |
| `/api/stock` | KDS 予約ストック形式 `[{rid,time,adults,kids,name,menu[],seenAt}]`。メニュー無し(席だけ)予約は含まない。初回全件リシンク成功までは503 |
| `/api/health` | モード・ready状態・最終差分ポール・最終全件リシンク・保持件数 |
| `GET /api/mock/reservations` | (MOCK限定) 上流の生予約一覧(本物スキーマ) |
| `POST /api/mock/reservations` | (MOCK限定) 予約作成。body は TableCheck Reservation 形 |
| `PATCH /api/mock/reservations/{id}` | (MOCK限定) 予約変更(人数・メニュー等) |
| `DELETE /api/mock/reservations/{id}` | (MOCK限定) 予約キャンセル(status=cancelled) |
| `POST /api/print` | チビ伝を実機プリンターへ印字(#144)。`raster:{width,height,data(base64 1bit)}` があれば画像(GS v 0)で印字(フォント・配置自由のWYSIWYG経路)。無ければ従来のテキスト方式 `{table, meta, store?, style?, items:[...]}`。`ip` 未指定はサーバー保存IP、`style` 未指定はサーバー保存スタイルを使う。`ip` は店内LAN想定のプライベートIPv4のみ許可 |
| `GET /api/slip-style` | サーバー保存の印刷スタイルを返す(未設定は `{}`) |
| `POST /api/slip-style` | 印刷スタイルを保存し `config/slip-style.json` に永続化(git管理外)。ブロック型テンプレート(`blocks[]`)はそのまま、旧テキスト型は許容値へ丸める。どの端末で設定しても全端末のKDS印刷に反映される |
| `GET /qr` | iPad等からKDS/スタイル設定を開くための接続QRを表示するページ。エンコードするURLは待ち受け中のLAN IPから自動生成 |

### チビ伝の印刷スタイル設定(slip-style-designer.html)

`http://<サーバー>:<port>/slip-style-designer.html` で伝票のレイアウトをブロック単位で設計できる
(店名・卓番・受付時刻・品目・罫線・自由テキストをドラッグで並べ替え、フォント6種・px単位のサイズ・
太字・左右中央寄せを指定)。**伝票はブラウザで画像に描画してラスター(GS v 0)で印字する**ため、
プレビュー=印字結果がそのまま一致し、感熱プリンター内蔵フォントの制約(等倍/2倍)を受けない。
設定は **サーバーに保存**(`POST /api/slip-style` → `config/slip-style.json`)され、
**どの端末で設定しても、KDSを開いている全端末(PC/iPad)の伝票プレビューと実機印刷に反映される**。
各端末の localStorage はオフライン用キャッシュで、KDS起動時と伝票を開くたびにサーバーから更新される。
注意: 描画は印刷する端末のブラウザで行うため、端末に無いフォントは近い書体で代替される。

### チビ伝の実機印刷(#144)

KDS 画面の「印刷」ボタンは、プリンターIP未設定時は従来どおり `window.print()`(ブラウザ手動印刷)。
実機で印字するには:

1. KDS ヘッダーの「プリンター設定」ボタンでプリンター(例: Star mC-Print3)のIPアドレスを登録する
   (`localStorage` に端末ごと保存。店舗ネットワーク依存のためコードへの固定埋め込みはしない)
2. 以降は「印刷」ボタン押下で `POST /api/print` → このサーバーが生ソケットでプリンターの
   RAWポート(9100)へESC/POSバイト列を送信する(ブラウザは生TCPソケットを開けないため中継が必要)
3. 実機送信に失敗(未設定・接続不可・タイムアウト)した場合は自動で `window.print()` にフォールバックする

### KDS への接続(kds-bridge.js)

KDS 本体は無改修。**このサーバー経由で `/` を開くと、配信時にブリッジが自動注入される**
(`server.js` が `kds-a-grid.html` の `</body>` 直前へ1行差し込む。ディスク上のファイルは変更しない)。
静的配信は情報露出を避けるため `kds-a-grid.html` と `kds-bridge.js` のallowlistに限定する。
サーバーを介さず単体で使う場合のみ、手動で `</body>` 直前に次を足す:

```html
<script src="/relay-server/kds-bridge.js"></script>
```

ブリッジは 5秒間隔で `/api/stock` を取得し、`kds_stock_v1` へマージして
`BroadcastChannel("kds_sync")` で全タブ・全端末に反映する。マージ規則:

- **サーバーが正**: 変更は上書き、サーバーから消えた予約(キャンセル)は削除
- **手動追加の予約には触らない**(＋追加ボタン由来はそのまま)
- **着手・削除済みの予約は復活させない**(取込済み rid を記録)
- 通信断時は直前の表示を保持(6/18 方針)

## テスト

```sh
node relay-server/tablecheck-sync.test.js
node --test relay-server/booking-resync.test.js relay-server/server.test.js \
  relay-server/seat-occupancy.test.js relay-server/load-config.test.js \
  relay-server/printer.test.js
```

正規化(スキーマ候補キー・pax→adults フォールバック)、memo パーサ、
upsert/404削除/当日パージ/KDS形式変換に加え、全件ページング、原子的なstore差替え、
初回503ゲート、失敗時の直前状態保持、差分との直列実行をカバーする。

設定については、config.json の env 形への変換、環境変数による上書き、ファイル由来の値にも
下限クランプ・HTTPS検証が効くこと、APIキー混入・キー名typo・不正JSONを起動時に弾くことを
カバーする。テストは `configFile` を注入する形なので、各自の `config/config.json` に左右されない。

## ⚠️ スキーマ確定待ちの箇所(Issue #74)

TableCheck 予約オブジェクトの正確なフィールド名は打合せ/APIコンソールで確認後、
**`tablecheck-sync.js` の `normalizeReservation()` / `normalizeMenu()` だけ**直せばよい:

1. 🔴 メニューが構造化フィールドで返るか(`courses` 等)、memo 自由テキストか
   → memo の場合は `parseMenuFromMemo()` の書式と店側の記載ルールを揃える
2. ⚠️ 大人/子供の内訳フィールド名(無ければ pax 合計を adults に寄せる現仕様のまま)
3. ⚠️ 認証ヘッダーの正確な形式(`server.js` の `tcFetch()` に TODO 記載)

関連資料: [knowledge/2026-07-15_テーブルチェックAPI連携_データ定義・裏どり結果.md](../knowledge/2026-07-15_テーブルチェックAPI連携_データ定義・裏どり結果.md)
