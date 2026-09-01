# relay-server — 店内中継サーバー(TableCheck取込 + Web配信)

TableCheck の予約(メニュー・人数等)を取得し、KDS の予約ストックに流し込むためのサーバー。
6/18 議事録の「ファイルを置くだけの見かけ上のサーバー」役と、TableCheck 取込役の2役を1プロセスで担う。
**依存パッケージはほぼゼロ・Node 18+ で動作**(本体リポジトリの単一HTML主義に合わせた設計)。
例外は**印刷まわりの2つだけ**:

| パッケージ | 使う場所 | 無いとどうなるか |
|---|---|---|
| `iconv-lite` | `printer.js` の日本語ESC/POS印字(Node標準にShift_JIS変換が無いため #144) | `POST /api/print` が 503。KDS は `window.print()` にフォールバック |
| `qrcode` | `/qr` の接続QRページ(#144追補) | `/qr` が 503(接続先URLは本文に出る) |

印刷を使うなら初回に `cd relay-server && npm install` を実行する。

**どちらも遅延読込(lazy require)なので、未インストールでもサーバーは起動する**(#173)。
`npm install` 漏れやオフラインのミニPCでも、**予約取込・`/api/stock`・KDS配信は通常どおり動く**。
欠けている場合は起動ログに理由と対処が出る。

```
【クラウド】               【店内ミニPC = このサーバー】          【KDS端末】
TableCheck ◀── 30秒差分pull ─ server.js ── /api/stock(JSON) ──▶ kds-bridge.js
(Booking v1 + Sync v1)       当日分のみメモリ保持                  → kds_stock_v1 へマージ
           ◀── 起動時+15分毎の当日全件リシンク
                            kds-a-grid.html も配信                → BroadcastChannel で全端末反映

【注文端末(各卓16台)】── POST /api/orders ──▶ 注文(当日メモリ) ── /api/orders ──▶ window.KDS_ORDERS
 別チームが実装                卓番はペイロードで受け取る                        → 新規オーダーのカード
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
| `seat.walkinTtlMin` | `SEAT_WALKIN_TTL_MIN` | 120 | ローカル登録した占有をいつ諦めるか(1〜1440分)。退店イベントが無いため時間で切る #123 |
| `kitchen.ttlMin` | `KITCHEN_TTL_MIN` | 720 | 厨房状態(#132)を最後の更新から何分保持するか(1〜1440分) |
| `order.ttlMin` | `ORDER_TTL_MIN` | 720 | 注文(`/api/orders`)の保持時間(1〜1440分)。日跨ぎで前日分が残らないための上限 |
| `auth.token` | `RELAY_TOKEN` | — | **共有トークン**(8文字以上)。設定すると他端末はトークン必須になる。未設定なら認証なし(従来どおり) #174 |
| `auth.trustLoopback` | `RELAY_TRUST_LOOPBACK` | 1 | ミニPC自身(127.0.0.1)をトークン無しで通すか。`0` で無効 |
| `auth.cookieSecure` | `RELAY_COOKIE_SECURE` | `auto` | 認証Cookieの`Secure`属性。`auto` / `true` / `false` (環境変数は`auto` / `1` / `0`) |
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

### 疎通診断(繋がらないときはまずこれ) — #140

上の点をまとめて自動判定するスクリプトがある。**読み取りしかしない**ので現地で何度実行してもよい。

```sh
node relay-server/preflight.js
# または
cd relay-server && npm run preflight
```

見るもの:

| # | 判定 |
|---|---|
| 1 | `config/config.json` の有無と `server.host` / `server.port`(`"auto"` の解決結果も) |
| 2 | 待ち受けアドレスが他端末から届くか(`127.0.0.1` / 実在しないIP / `0.0.0.0` を指摘) |
| 3 | IPが静的かDHCPか(`PrefixOrigin`) |
| 4 | ネットワークプロファイルが「パブリック」でないか |
| 5 | ポートの受信を許可するファイアウォール規則があるか |
| 6 | サーバーがLAN側アドレスで実際に応答するか(`/api/health` と KDS 画面) |
| 7 | 人の目で確認する項目(別端末での表示・予約反映・2台同期・注文投入・来客用WiFiから届かないこと) |

`❌` が出たら上から順に潰す。3〜5 は Windows のみ自動判定で、取得できなかった場合は
「確認できなかった」と明示して手順を出す(黙って通ったことにはしない)。

### 店内Wi-Fiを客と共用している場合の認証(#174)

中継サーバーには元々認証が無く、**到達できる端末なら誰でも書き込み操作ができる**。
飲食店ではゲスト Wi-Fi を解放している構成が珍しくないため、スタッフ用と客用の
セグメントが分かれていない場合、客のスマホから次の操作ができてしまう。

| 操作 | 実害 |
|---|---|
| `DELETE /api/seats/{table}` | 予約席が空席扱いになり二重着席が起きる |
| `POST /api/printer` | プリンターIPを空にされ、印刷が黙って止まる |
| `POST /api/slip-style` | 全端末の伝票レイアウトが書き換わる |

**まず店のWi-Fiがスタッフ用と客用で分かれているかを確認する**。分かれていて客から到達できないなら、
ネットワーク側で塞がっているので設定は不要(この節は読み飛ばしてよい)。

共用の場合は `config/config.json` に共有トークンを置く:

```json
{ "auth": { "token": "店ごとの合言葉を8文字以上で" } }
```

- **未設定なら従来どおり認証なし**。開発・検証の手順は何も変わらない
- 設定すると、**ページもAPIもトークンが必要**になる(ページだけ素通しにすると、
  そのページからトークンを読み出されて意味がない)
- 端末は次のいずれかで通る: `Authorization: Bearer <token>` / GET・HEADのQR導線`?token=<token>` / Cookie `relay_token`
- `?token=`を受け取ったGET/HEADは、`HttpOnly; Path=/; Max-Age=...; SameSite=Lax`のCookieを発行し、
  `token`パラメータだけを除いた同じパスへ`303`リダイレクトする。他のクエリは保持し、token付きの
  リクエストではページ本文を配信しないため、表示URL・履歴・Refererへ残りにくい
- Cookieの`Secure`は`auth.cookieSecure`で制御する。既定の`auto`は、relayが**実際にTLSソケットで
  受信した場合だけ**付与するため、通常の店内HTTPではログイン不能にならない。HTTPSリバースプロキシで
  TLS終端する構成は`true`を明示する。この場合`/qr`も`https://`の接続先を生成する。偽装可能な
  `X-Forwarded-Proto`等の転送ヘッダは自動判定に使わない
- APIのPOST/DELETEではtoken付きURLを受理しない。Cookieまたは`Authorization: Bearer`を使う
- **ミニPC自身(127.0.0.1)はトークン無しで通る**。QRでトークンを配る導線がミニPC上の
  `/qr` から始まるため。ミニPCを他人が触る運用なら `auth.trustLoopback` を `false` にする
- **`/api/health` だけは認証なしで読める**。疎通確認を詰まらせないため(読み取り専用)
- `/qr` のQRには自動でトークンが載る。**iPadは1回読めばCookieが入り、以後はURLにトークンが要らない**

これはインターネットに晒す前提の認証ではなく、**店内LANという閉じた場所での
意図しない操作・いたずらを止めるためのもの**。外部公開しない方針は変わらない。

### エンドポイント

| パス | 内容 |
|---|---|
| `/` , `/kds-a-grid.html` | KDS 本体(配信時にブリッジを1行注入) |
| `/demo` | 予約デモコンソール(`tablecheck-demo.html`) |
| `/api/stock` | KDS 予約ストック形式 `[{rid,time,adults,kids,name,menu[],seenAt}]`。メニュー無し(席だけ)予約は含まない。初回全件リシンク成功までは503 |
| `/api/health` | モード・ready状態・最終差分ポール・最終全件リシンク・保持件数 |
| `GET /api/kitchen-state` | 厨房状態の共有スナップショット `{sessionId,rev,updatedAt,konro,done,locked,seq,deleted}`。→「厨房状態の端末間同期」 |
| `POST /api/kitchen-state` | 厨房状態の変更イベント投入 `{events:[...]}`。応答は `{ok,rev,sessionId}` |
| `GET /api/orders` | KDS 注文フィード(注文端末由来)。→「注文端末との契約」 |
| `POST /api/orders` | 注文の投入。`orderId` で冪等 |
| `DELETE /api/orders/{orderId}` | 注文の取消 |
| `GET /api/seats` | 当日の座席占有 `[{table,source:"walkin"\|"reservation",rid?,name?,since}]`。初回全件リシンク成功までは503。→「座席占有」 |
| `POST /api/seats` | 占有の登録 `{table:"5"}`。`{table:"3",rid:"r-1",name:"山田様"}` なら予約の着席として扱う |
| `DELETE /api/seats/{table}` | 占有の解除 |
| `GET /api/mock/reservations` | (MOCK限定) 上流の生予約一覧(本物スキーマ) |
| `POST /api/mock/reservations` | (MOCK限定) 予約作成。body は TableCheck Reservation 形 |
| `PATCH /api/mock/reservations/{id}` | (MOCK限定) 予約変更(人数・メニュー等) |
| `DELETE /api/mock/reservations/{id}` | (MOCK限定) 予約キャンセル(status=cancelled) |
| `POST /api/print` | チビ伝を実機プリンターへ印字(#144)。**画像印字**は `{ip, raster:{width,height,data(base64)}, feedLines?, emulation?}`(自由配置レイアウトの本線)。**テキスト印字**は `{ip, table, meta, store?, style?, items:[{name,qty,note}]}`。`raster` が付いていれば画像経路を使う(寸法とデータ長が食い違う `raster` は400で拒否し、黙って別物を印字しない)。`ip` は店内LAN想定のプライベートIPv4のみ許可(10/8・172.16-31/12・192.168/16)。ポート9100固定のRAWポートへ生ソケットで送信 |
| `GET /api/slip-style` | サーバー保存のレイアウト/スタイルを返す(未設定は `{}`) |
| `POST /api/slip-style` | レイアウト/スタイルを保存し `config/slip-style.json` へ永続化(git管理外)。自由配置レイアウト(`elements[]`)は描画がブラウザ側のため中身を解釈せずそのまま預かる(50KB上限)。旧テキスト型スタイルは従来どおり許容値へ丸める。どの端末で設定しても全端末のKDSに反映される |
| `GET /qr` | iPad等からKDS/スタイル設定を開くための接続QRを表示するページ。エンコードするURLは待ち受け中のLAN IPから自動生成 |

### チビ伝のレイアウト設定(slip-style-designer.html)

`http://<サーバー>:<port>/slip-style-designer.html` で、伝票の要素(文字・罫線・品目リスト)を
**用紙の上へドラッグして自由に配置**できる。要素ごとに書体・大きさ・太字・寄せ・幅を設定でき、
文字には `{卓番}` `{受付}` `{人数}` などの差込フィールドを入れられる。
設定は **サーバーに保存**(`POST /api/slip-style` → `config/slip-style.json`)され、
**どの端末で設定しても、KDSを開いている全端末(PC/iPad)の伝票プレビューと実機印刷に反映される**。
各端末の localStorage はオフライン用キャッシュで、KDS起動時と伝票を開くたびにサーバーから更新される。

描画は `slip-renderer.js`(フォーマッターとKDSが共有)が canvas に対して行い、
**その canvas をそのまま1bit画像にしてプリンターへ送る**。したがって
「フォーマッターの見た目 = KDSのプレビュー = 実際の紙」が必ず一致する。
プリンター内蔵フォントを使わないため、書体・大きさ・位置に制約が無い。

品目リストは品数で伸縮する。要素の「Yの基準」を **品目リストの下から** にすると、
品数が増えたぶんだけ自動で下へずれる(合計欄やフッターを重ならせないため)。

#### 印字方式(emulation)

画像印字のコマンドは**プリンターのコマンド体系ごとに互換性が無い**。素のテキストはどの体系でも
印字できてしまうので、テキスト印字が通っていても体系の判別にはならない。体系が合っていない状態で
画像を送ると、画像データがそのまま文字として解釈され「文字化け + データ中の `0x0A` による
行送りだけが延々続く」壊れ方をする。

| 値 | コマンド | 対象 |
|---|---|---|
| `starprnt`(既定) | `ESC GS S` | **Star mC-Print3**(本番機)。StarPRNT専用機でESC/POSモードは持たない |
| `starline` | `ESC * r A` … `b` … `ESC * r B` | Star Line Mode 機(TSP650II/TSP700II 等) |
| `escpos` | `GS v 0` | ESC/POS 系 |

本番機は `starprnt` のままでよい。機種を入れ替えたときだけフォーマッターの「印字方式」で切り替える。

### チビ伝の実機印刷(#144)

KDS 画面の「印刷」ボタンは、プリンターIP未設定時は従来どおり `window.print()`(ブラウザ手動印刷)。
実機で印字するには:

1. KDS ヘッダーの「プリンター設定」ボタンでプリンター(例: Star mC-Print3)のIPアドレスを登録する
   (`localStorage` に端末ごと保存。店舗ネットワーク依存のためコードへの固定埋め込みはしない)
2. 以降は「印刷」ボタン押下で `POST /api/print` → このサーバーが生ソケットでプリンターの
   RAWポート(9100)へコマンドバイト列を送信する(ブラウザは生TCPソケットを開けないため中継が必要)
3. 実機送信に失敗(未設定・接続不可・タイムアウト)した場合は自動で `window.print()` にフォールバックする

### 座席占有(#123)

運用上の本題は**座席バッティング** — 新規客(ウォークイン)が、この後来店する予約の席を
先に埋めてしまう問題。**TableCheck では防げない**: 新規客の卓番は店内で発生するローカルデータで、
クラウドは「新規客が5番卓に座った」ことを知り得ない。店内で塞ぐしかない。

```
TableCheck ──pull──▶ relay(store) ─┬─ /api/stock ──▶ KDS 予約ストック
                                   └─ /api/seats ──▶ 卓番選択UI(#118)・注文端末
KDS(着席操作) ── POST /api/seats ──▶ relay(ローカル占有: メモリMap)
```

占有は2つの源をマージして返す:

| source | どこから | 備考 |
|---|---|---|
| `walkin` | `POST /api/seats {table}` | 新規客。注文端末/KDSから登録 |
| `reservation` | `POST /api/seats {table,rid,name}` | **予約の着席**。卓番はKDSでスタッフが決めるので、ここが唯一の正本 |
| `reservation` | store から時間窓で導出 | 予約に確定卓番が乗る場合のみ(`seat.beforeMin`〜`seat.afterMin`)。予約の変更・キャンセルに自動追随する |

- **着席の登録は KDS 本体を改修せずに行う**。KDS は着席時に `BroadcastChannel` へ
  `{type:"moveToMain", order}` を流しており、ブリッジがそれを拾って `POST /api/seats` する
  (`order.id` が `res-<rid>`、`order.table` が案内した卓番)
- **解除は手動 + TTL**(`seat.walkinTtlMin`、既定120分)。POS連携が無く「退店した」という
  イベントが存在しないため、解除し忘れた席が永久に埋まったままにならないよう時間で諦める
- 保存はしない(#115)。当日メモリのみ

**未決**: TableCheck の予約に確定卓番が乗るかは未確認(#74)。乗らない場合でも、
着席時のローカル登録があるので占有ビュー自体は成立する(予約の「事前」占有だけが作れない)。

### 厨房状態の端末間同期(#132)

KDS の厨房状態(**コンロ番号・品目完了・タイマーロック・カード並び順・削除済みID**)は
localStorage + BroadcastChannel で同期しているが、**どちらも同一ブラウザ内にしか届かない**。
厨房用とホール用に2台並べると一切共有されず、#114 のコンロのダブルアサイン防止も端末をまたぐと効かない。

そこで、KDS が状態変更のたびに `BroadcastChannel("kds_sync")` へ流しているイベントを
ブリッジが拾って relay へ送り、relay 側で当日の状態へ畳み込む。

```
端末A ── BroadcastChannel ──▶ kds-bridge ──POST /api/kitchen-state──▶ relay(当日メモリ)
                                                                        │ 畳み込み(rev++)
端末B ◀── localStorage 書換 ── kds-bridge ◀──GET /api/kitchen-state─────┘
                               (KDSは1秒ごとにLSを読み直すので自動で画面に乗る)
```

**KDS 本体(`kds-a-grid.html`)は無改修**。取り込みは localStorage を書き換えるだけでよい
(KDS の `poll()` が毎秒 `loadKonro()`/`loadDone()`/`loadLocked()`/`loadOrderSeq()`/`loadDeleted()` を実行するため)。

受け取るイベントは KDS の `broadcast*()` が流す形そのまま:

| type | body | 意味 |
|---|---|---|
| `konro` | `{id, num, state}` | コンロ番号の状態。`state:"skeleton"` で解除 |
| `toggle` | `{id, index, doneCount}` | 品目の完了個数 |
| `timerLock` | `{id, locked}` | タイマーロック |
| `order` | `{seq:[cardId,...]}` | カードの並び順 |
| `deleteOrder` | `{id}` | 注文の削除(関連するコンロ・完了・ロック・並び順も解放) |

設計上の判断:

- **差分ではなく畳み込み済みのスナップショットを配る**。遅れて起動した端末も1回の取得で追いつける
- **全イベントが絶対値の代入**なので、再送・重複適用しても結果が変わらない(複数タブが同じイベントを送っても壊れない)
- **relay が空(`rev:0`)のときは端末が手元の状態を種として送る**。これが無いと「最初の1操作だけが載ったスナップショット」を取り込んだ瞬間に手元の状態が消える
- **`sessionId` で relay の再起動を検出する**。再起動で `rev` が 0 に戻るため、これが無いと端末が「取込済み」と誤認して同期が止まる
- **送信中・未送信のイベントがある間は取り込まない**。取り込むと直前の操作が一瞬巻き戻って見える
- 通信断のときは手元の状態を保持する(relay が落ちても KDS は単独で動き続ける)
- 保存はしない(#115)。`kitchen.ttlMin`(既定720分)を過ぎたら当日分を捨てる

**同期の対象外**: 予約ストック(`/api/stock` が正本)と、予約→着手の移動。後者は着手した端末の
ストックからのみ消える(別端末では残る)ため、必要になったら別途対応する。

### 注文端末との契約(POST /api/orders)

注文端末(各卓16台)のシステムは別チームが作る。**受け口の形はこちらが定義し、別チームがそれに
合わせて送る**(2026-07-16 確定)。送信先は `config.json` の `server.host`/`port` に伝えるだけでよい。

```sh
curl -X POST http://<ミニPCのIP>:8000/api/orders \
  -H "Content-Type: application/json" \
  -d '{
    "orderId": "t12-20260802-0001",
    "table": "12",
    "people": 4,
    "orderedAt": "2026-08-02T18:05:00+09:00",
    "items": [
      { "name": "山城牛の肉たく土鍋御膳", "qty": 2, "note": "塩少なめ" },
      { "name": "ウーロン茶", "qty": 4 }
    ]
  }'
```

| フィールド | 必須 | 内容 |
|---|---|---|
| `orderId` | ✅ | 注文端末が振る一意ID(64文字以内)。**冪等キー**: 同じID・同じ内容の再送は二重注文にならず、内容差分は同じ注文の更新になる |
| `table` | ✅ | 卓番(6文字以内)。**ペイロードで受け取る**(送信元IPからは引かない) |
| `items[].name` | ✅ | 品名(80文字以内)。KDS の表示名がそのまま |
| `items[].qty` | | 個数(1〜99。既定1) |
| `items[].note` / `items[].options` | | 品目の注記・オプション(200文字以内)。`note` を優先し、KDS の注記欄に出る |
| `items[].allergies` | | アレルギー注記(200文字以内)。KDS では注記と並べて表示 |
| `people` | | 人数(0〜99)。カードの人数表示に使う |
| `orderedAt` | | ISO 8601。省略時はサーバー受信時刻。**未来時刻はサーバー時刻に丸める**(端末の時計ズレで経過時間が止まって見えるのを防ぐ) |

応答:

| 状況 | ステータス | body |
|---|---|---|
| 新規受付 | `201` | `{ok:true, duplicate:false, updated:false, order:{...}}` |
| 同一内容の再送 | `200` | `{ok:true, duplicate:true, updated:false, order:{...}}` — 無変更 |
| 内容が異なる更新 | `200` | `{ok:true, duplicate:false, updated:true, order:{...}}` — 同じ `orderId` の既存注文を置換 |
| 検証エラー | `400` | `{ok:false, error:"table must be ..."}` — どこを直せばよいか分かる文言 |
| 取消 | `204` / `404` | `DELETE /api/orders/{orderId}` |

**卓番をIPから引かない理由**: WiFi + DHCP でIPが入れ替わると、注文が黙って別の卓に付き、
ログ上は正常に見える。飲食店では「違う卓に料理が出る」形でしか表面化せず原因究明が困難。
この方針により**16台の固定IP運用は不要**になる。

保持は**当日メモリのみ**(#115)。`order.ttlMin`(既定720分)を過ぎた注文は配信から落ちる。
再起動すると受付済みの注文は消えるので、注文端末側は未反映を検知したら再送してよい(冪等)。

更新対象は `table`、`people` と、`items[]` の配列全体（並び順、`name`、`qty`、
`note` / `options`、`allergies`）。`orderId` は識別子、初回の受付時刻 `start` は KDS の
タイマー・受付順の基準なので更新しない。`orderedAt` を変えて再送しても初回の `start` を維持する。

更新後の内容をもう一度送った場合は同一内容の再送として `duplicate:true` になる。取消との競合は
**relay に最後に到着した操作を正**とする。`DELETE` 後に同じ `orderId` の有効な `POST` が届けば
新規受付 (`201`) として再作成し、反対に更新後に `DELETE` が届けば配信から取り除く。

**まだ決めていないこと**(別チームと詰める):

- 商品の識別を名前の文字列で通すか、商品IDにしてマスタを持つか(現状は**名前が正**)
- 同じ注文の追加・訂正は同じ `orderId` で全内容を再送する。別会計・別注文としてカードを分ける場合のみ別 `orderId` を使う
- KDS 側で完了・削除した注文は relay からは消えない(TTL 満了まで配信される)。
  KDS は完了状態(`kds_done_v2`)と削除済みID(`kds_deleted_v1`)を持っており再表示はされないが、
  完了を relay へ返す経路は未実装(#132 の厨房状態同期と合わせて設計するのが自然)

### KDS への接続(kds-bridge.js)

KDS 本体は無改修。**このサーバー経由で `/` を開くと、配信時にブリッジが自動注入される**
(`server.js` が `kds-a-grid.html` の `</body>` 直前へ1行差し込む。ディスク上のファイルは変更しない)。
静的配信は情報露出を避けるため allowlist に限定する
(`kds-a-grid.html` / `slip-style-designer.html` / `slip-renderer.js` / `relay-server/kds-bridge.js`)。
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

同じブリッジが 2秒間隔で `/api/orders` も取得し、`window.KDS_ORDERS` へ反映する(#139)。
こちらのマージ規則:

- **サーバー由来の注文は毎回サーバーの内容で置き換える**
- 同じ `orderId` の更新でも、受付時刻を基準にする**タイマー**、`orderId` に紐づく**コンロ割当・タイマーロック・カード並び順・手動削除状態**は維持する
- 品目完了数は `name` + `options` + `allergies` が同じ行へ追従する。数量減では新数量を上限とし、数量増では既に完了した個数だけを維持する。新規行または品名・注記・アレルギーが訂正された行は未完了にする。同内容の行が複数ある場合は出現順で対応づける
- **KDS 内で生まれた注文(予約→着手の `res-*` カード)は残す** — 上書きするとホールが着手した
  予約カードが次のポーリングで消えるため
- 通信断時は `window.KDS_ORDERS` に触らない(直前の表示を保持)

## テスト

```sh
cd relay-server
npm ci
npm test
```

Node.js 22 を使用する GitHub Actions と同じく、`npm ci` は lockfile に固定された依存関係を
導入し、`npm test` はこのディレクトリの全 `*.test.js` を実行する。テストは店舗の設定ファイル、
認証情報、TableCheck などの実 API を必要とせず、失敗時は非ゼロ終了する。

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
