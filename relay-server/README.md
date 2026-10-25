# relay-server — 店内中継サーバー(Web配信・予約ストック・注文配信)

> **2026-10-11: TableCheck API連携は中止。2026-10-21: 予約の主な入口はCSV取込、変更時は再取込に決定。** 朝に1回当日分を確認・取り込む。手入力も必要だが、電話の当日予約の扱い等は確認中（[決定記録](../knowledge/2026-10-21_決定_予約のCSV取込と変更の反映.md)）。
> TableCheck の実API取得処理・疎通確認・暫定契約の文書は [`archive/tablecheck/`](../archive/tablecheck/README.md) へ退避した。
> 店内へ取り込んだ予約・手入力予約は SQLite(`data/reservations.sqlite`)に保存する。元の予約は引き続き TableCheck が管理する。
> 旧API取得・同期・モック・デモコンソール(`/demo`)は `archive/tablecheck/` へ退避した。現在は `/reservations` と予約APIに、手入力・CSV／Excel取込・貼り付け・メールの入口を試作済み。ファイル取込は旧API連携とは別の現行機能。
> Linux サーバー運用・Next.js 移行の方針も決まったが、導入手順・移行範囲・時期は確認中。本文は現行 Node.js サーバーの手順（[最新議事録](../knowledge/2026-10-21_議事録_予約の取り込み.md)）。

予約(メニュー・人数等)を保存し、当日分を KDS の予約ストックに流し込むサーバー。
6/18 議事録の「ファイルを置くだけの見かけ上のサーバー」役と、予約ストック役の2役を1プロセスで担う。
**依存パッケージはほぼゼロ・Node 22.13+ で動作**(本体リポジトリの単一HTML主義に合わせた設計)。
予約の保存に Node 標準の `node:sqlite` を使うため、これより古い Node では起動しない。
追加依存は注文配信の `ws` と、以下の印刷まわりの2つです:

| パッケージ | 使う場所 | 無いとどうなるか |
|---|---|---|
| `iconv-lite` | `printer.js` の日本語ESC/POS印字(Node標準にShift_JIS変換が無いため #144) | `POST /api/print` が 503。KDS は `window.print()` にフォールバック |
| `qrcode` | `/qr` の接続QRページ(#144追補) | `/qr` が 503(接続先URLは本文に出る) |

印刷を使うなら初回に `cd relay-server && npm install` を実行する。

**どちらも遅延読込(lazy require)なので、未インストールでもサーバーは起動する**(#173)。
`npm install` 漏れやオフラインのミニPCでも、**`/api/stock`・KDS配信は通常どおり動く**。
欠けている場合は起動ログに理由と対処が出る。

```
【予約の入力】             【店内ミニPC = このサーバー】          【KDS端末】
CSV／Excel・手入力等 ──▶ /reservations ──▶ data/reservations.sqlite
                            server.js ── /api/stock(当日分) ──▶ kds-bridge.js
                                                                  → kds_stock_v1 へマージ
                            kds-a-grid.html も配信                → 各端末が取得し、同一originタブへ通知

【注文端末】→【注文サーバー order-system(3001)】── 転送 POST /api/orders ──▶ 注文(当日分。控えは data/orders.sqlite) ── /api/orders ──▶ window.KDS_ORDERS
                 注文サーバーが転送                卓番はペイロードで受け取る                        → 新規オーダーのカード
```

## 予約の保存(reservation-store.js)

- 予約は SQLite に保存する。既定のファイルは `data/reservations.sqlite`(`data/` は .gitignore 済み)で、
  `reservation.dbFile`(環境変数 `RESERVATION_DB_FILE`)で変えられる。再起動しても予約は残る。
- 書き込みは WAL モードで行い、ミニPCの電源断でファイルが壊れにくいようにしている。
- `/api/stock` は**当日**の予約のうち、status が `booked` でメニューがあるものだけを返す。
  先の日付の予約は保存したまま、その日になったら配信する。
- 過ぎた日の予約は `/api/stock` 用の当日スナップショットを読む際に削除する(履歴は持たない)。予約一覧・1件取得だけでは削除しない。
- 起動直後から `/api/stock` は 200 を返す(TableCheck の初回取得を待つための 503 は不要になった)。
- 予約は予約入力画面 `/reservations` から入れる(→「予約の入口」)。KDS の「＋追加」ボタンで入れた予約も、
  端末に残すと同時に `POST /api/reservations` でここへ保存し、`/api/stock` 経由で他の端末にも出す
  (rid は端末で振ったものをそのまま渡すので二重にならない)。保存に失敗したときは端末だけに残り、
  画面に「中継サーバーに保存できませんでした」と表示する。

## 注文の控え(order-store.js)

- 受け付けた注文は、メモリで扱うのと同時に SQLite の控えへ書く。既定のファイルは `data/orders.sqlite`
  (`order.dbFile` / 環境変数 `ORDER_DB_FILE` で変えられる)。起動時に保持期間内の注文を読み戻すので、
  営業中に中継サーバーを再起動しても KDS から当日の注文が消えない(2026-10-17 の一気通貫確認で、
  再起動前の注文が消える問題を確認して追加した)。
- 履歴は持たない。`order.ttlMin`(既定720分)を過ぎた行は読み戻し時と書込み時に削除し、取消した注文は
  控えからも消す。保存するのは配信形式の注文そのもの(JSON)で、KDS 側の完了・コンロ状態は含まない。
- 控えの書込みに失敗しても注文の受付と配信は止めない。起動ログに「注文の控えを保存できない」と出る。
- `GET /api/health` の `orders` に件数が出る(`{store:"sqlite", orders:N}`)。
- 当日限りのデータなので、予約と違ってバックアップは不要。

### 予約の入口(試作・4方式)

TableCheck API を使わず予約を持ち込むため、4つの入口を `/reservations` に試作している。主な運用入口は B のファイル取込に決定したが、C・D は比較用試作であり採用確定ではない。
どれも最後は同じ `reservation-store.js` の `save` に入る。取り込むのは来店日時・人数・予約者名・事前メニュー・
アレルギー・要望・メモ・卓番だけで、電話番号などの連絡先は取り込まない。

| 方式 | 使い方 | 保存のタイミング |
|---|---|---|
| A. 手入力 | フォームから1件ずつ入れる | 登録ボタンを押したとき |
| B. CSV・Excel取込 | 管理画面から出した CSV、または TableCheck の予約一覧(.xlsx)を選ぶ。見出しの行(先頭5行のうち、来店日時か来店時間の列がある行)の列名から項目を判別する | 「内容を確認する」(保存しない)で確かめてから「取り込む」を押したとき |
| C. 貼り付け | 予約詳細の文面を貼る。「項目名: 値」の行を読んでフォームへ入れる | フォームを確かめて登録ボタンを押したとき |
| D. メール | 取込フォルダ(既定 `data/mail-inbox`、`reservation.mailDir` で変更)に置いた `.eml` / `.txt` が候補に並ぶ。1通ずつ選ぶ・貼ることもできる | 候補をフォームへ入れ、確かめて登録ボタンを押したとき |

**取り込みの運用**: 予約は**朝に1回**当日分を確認・取り込み、変更があったときはファイルを出し直して取り込む。朝の担当者・時刻・端末、電話の当日予約の扱いは未決。CSV から消えた予約の取消や手修正値の保護など、再取込には未解決の制約がある（[決定記録](../knowledge/2026-10-21_決定_予約のCSV取込と変更の反映.md)）。

**手入力も必要**: 取り込みとは別に、手入力フォームも試作済み。運用で必要な項目は次のとおり。

- 時間
- 人数
- 名前
- メニュー(あれば)
- メモ

**管理用画面**: `/reservations` には一覧・変更・取消の試作がある。正式な管理用画面の内容・運用は未設計で、試作が最終仕様として承認されたわけではない。

#### 試し方

Node.js 22.13 以上が必要。リポジトリ直下で次を実行する(`order-terminal` サブモジュールは不要)。

```sh
npm --prefix relay-server ci
npm run reservation:samples     # 当日の日付で架空のサンプルを data/ に作る
npm start
```

ブラウザで `http://127.0.0.1:8000/reservations` を開く(`config/config.json` を作っていない場合の既定)。
`config.json` で `server.host` を変えている場合は、起動ログに出る「予約入力:」のURLを開く。

| 方式 | 試す手順 |
|---|---|
| A. 手入力 | 「手入力」タブで日時・名前・メニューを入れて「登録する」。右の一覧の「変更」「取消」も試せる |
| B. CSV・Excel取込 | 「予約取り込み」タブで `data/samples/sample.csv` を選び、「内容を確認する」→「取り込む」。4行のうち1行は日付が読めず取り込めない例、1行は取消の例。`data/samples/sample-tablecheck.csv` は TableCheck の予約一覧と同じ並び(タイトル行・「予約時間」・人数4区分・「1 × 品名」)の例 |
| C. 貼り付け | 「貼り付け」タブに `data/samples/sample-paste.txt` の中身を貼り、「読み取ってフォームに入れる」→ 確かめて「登録する」 |
| D. メール | 「メール」タブに取込フォルダの2通が並ぶ(1通は取消の例)。「フォームに入れる」→「登録する」。`data/samples/sample-mail.eml` を選んで1通だけ読むこともできる |

登録した予約は、厨房画面 `http://127.0.0.1:8000/` の予約ストックに5秒ほどで出る(当日・メニューありの予約だけ)。
やり直すときはサーバーを止めて `data/reservations.sqlite*` を消し、`npm run reservation:samples` をもう一度実行する。

- **B は、2026-10-22 に店から受け取った TableCheck の予約一覧(.xlsx)で読めることを確かめた。** この形式は
  1行目がタイトル「予約」、2行目が見出しで、日時は「予約時間」に `2026-10-20 11:00` の形で入る。人数は
  「人数:大人」「人数:シニア」「人数:子供」「人数:幼児」の4列で、まとめずにそれぞれ `adults`・`seniors`・
  `children`・`kids`(幼児、0〜2歳)へ入れる。区分・合計・内訳表示は `party-size.js` にまとめ、KDS と予約入力画面も
  `/relay-server/party-size.js` を読んで同じ計算を使う。この変更より前のファイルは、開いたときに `kids` に入っていた
  値(当時の「子供」)を1回だけ `children` へ移す。注文は `1 × 品名, 1 × 品名` の形。アレルギーは
  「食事制限・アレルギー」の列、「予約メモ」の `質問N: …アレルギー… 回答N: …` の回答(複数行も読む)、「苦手なもの」の列を
  全部つなぐ(「なし」「特にありません」などは拾わない)。取り込めるファイルは 5MB まで。
  実物は個人情報を含むためリポジトリには入れず、テストは架空の値で同じ形を組み立てている。
- **C・D の読み取りは、TableCheck の実物の画面・メールで確かめていない。** ラベルの表記ゆれを
  広く受けるように作ってあるが、実物で読めるかは未確認。読み取れなかった項目は画面に警告を出す。
- .xlsx は依存を増やさず `xlsx-reader.js`(node:zlib で展開)で最初のシートの文字列だけを読む。
  数式・書式は扱わない。日付の書式が付いた数値(Excel で保存し直した日時)は日時の文字列に戻す。
- C と D は自動では保存しない。読み違えたアレルギーが厨房へ出ないよう、必ず人が確かめてから登録する。
- D はメールサーバーへ接続しない(メールの認証情報をミニPCに置かないため)。取込フォルダへ保存するまでは
  メールソフト側の自動保存か手作業で行う。登録または破棄した候補は `processed/` へ移す(削除はしない)。
- CSVでは予約番号が無ければ来店日時と名前から、貼り付け・メールでは来店日時と名前を読めた場合に rid を作る。**同じ取込方式・日時・名前の場合だけ**同じ予約として上書きでき、変更や取込方式の混在で別予約になり得る。手入力の番号省略時は UUID を採番する。
- 再取込は同じ rid の行全体を上書きする。CSV から消えただけの予約は取り消さず、卓番・メモ等を消したり手動取消を復活させたりする可能性がある。予約番号の必須化・消えた予約の扱い・手修正値の保護は未対応。
- 件名に「キャンセル」とあるメールは取消の下書きになるが、同じ予約へ反映するには rid が一致する必要がある。C・D は自動保存しない。
- 解析の公開APIは `reservation-import.js`。内部は `reservation-import/` の共通値解析・表形式・テキスト・メール解析に分かれる。API は `routes/reservations.js`、取込フォルダは `mail-inbox.js`。
- 予約画面は `reservation-entry.html` が画面構造、`assets/reservations/entry.css` がスタイル、`assets/reservations/entry.js` がフォーム・一覧・各入口の制御を担当する。コントローラーはDOM・通信・時計を注入でき、`tests/reservation-entry-ui.test.js` でフォームの往復、非保存の下書き、CSV確認、エラー後の復帰等を検証する。

**バックアップ**: 取り込んだ予約と店内で手入力・変更した内容を失わないよう、ミニPCの故障に備えて
`data/reservations.sqlite` を定期的に別媒体へコピーする(方法と頻度は運用で決める)。
コピーはサーバー停止中に行うか、`sqlite3 data/reservations.sqlite ".backup <コピー先>"` を使う
(稼働中にファイルを単純コピーすると、WAL に残った直近の書き込みが欠けることがある)。

## 使い方

### いますぐ試す

```sh
node relay-server/server.js
```

- http://127.0.0.1:8000/ … **KDS(デシャップ)**

**KDS は空の状態から始まる**(中継サーバー配信時は KDS 内蔵の自動デモを抑止するため)。

> KDS の自動デモ抑止は、配信時に注入する `window.__KDS_SUPPRESS_DEMO__` フラグ、
> または URL の `?nodemo=1` で効く(単体で開いた KDS は従来どおり自動デモ)。

### 通信フロー・シミュレーター(/sim)

注文端末・中継サーバー・デシャップの間を流れる通信を、1画面で見ながら操作するための開発用ツール。
本物の中継サーバー・本物の KDS 画面・本物の注文通信モジュール(`order-client.js`)をそのまま動かし、
サーバー側で通信を記録(`sim-tap.js`)して画面へ流す。

```sh
npm --prefix relay-server ci   # WebSocket 配信に ws が要る
npm run sim                    # = SIMULATOR=1 node relay-server/server.js (WSL / Linux / macOS)
```

WSL で起動した場合も、Windows のブラウザで `http://localhost:8000/sim` を開けばよい(WSL の localhost 転送)。

| 列 | 中身 |
|---|---|
| 左: 注文端末 | 本物の注文端末アプリ(React 版)と同じ見た目・画面遷移を再現した `sim-order-terminal.html`(基準 1280×832 を縮小表示)。「予約/新規」→ 卓・人数 → メニュー一覧(カテゴリ・カート)→ 詳細(数量・オプション)→ 確定 → 注文後の閲覧画面、の順に進む。予約フローとスクリーンセーバーは省略(予約ボタンは案内表示のみ。注文後画面の「次のお客様(最初に戻る)」で最初に戻る)。メニューは固定データ。送信は `order-client.js`。画面右上の「開発」ボタンで、送信済み注文の更新・取消とわざと不正な注文(400)を試すドロワーが開き、下端の細い帯に直近の通信が出る |
| 中央: 中継サーバー | 当日の注文・厨房状態(rev・コンロ・完了)・WS 接続数と配信 sequence・予約ストックと、通信ログ。行をクリックすると要求・応答の JSON が見える |
| 右: デシャップ KDS | 本物の `kds-a-grid.html`。「2台目KDSを追加」で別オリジン(`localhost` ⇔ `127.0.0.1`)の2台目を並べ、端末間の同期がサーバー経由で起きる様子を見られる |

- 通信が起きるたびに、端末とサーバーの間を色付きのラベルが飛ぶ(青=注文 / 橙=厨房操作 / 金=予約 / 灰=その他)。
- 内容の変わらない定期ポーリング(`/api/orders` 2秒・`/api/kitchen-state` 1.5秒など)は既定で隠す。「ポーリングを表示」で出せる。
- `SIMULATOR=1` を付けないと `/sim*` は 404 で、通信の記録も一切しない。**店舗では有効にしない**(記録した注文内容をブラウザから読めるため)。
- 記録はメモリ上の直近200件だけで、ファイルには残さない。
- サーバー無しで画面だけ確かめるときは `/sim?mock=1` を開く (擬似イベントを流す。iframe は読み込まない)。

### 接続設定(config/config.json)

接続先は**リポジトリ直下の `config/` に置く**。雛形をコピーして店舗の実値へ書き換える:

```sh
cp config/config.example.json config/config.json
```

```json
{
  "server":      { "host": "192.168.1.10", "port": 8000 },
  "reservation": { "dbFile": "" },
  "seat":        { "beforeMin": 30, "afterMin": 120 }
}
```

- `config/config.json` は**環境ごとに値が違うため .gitignore 済み**。管理するのは雛形の
  `config.example.json` だけ。
- 優先順位は **既定値 < `config/config.json` < 環境変数**。環境変数は一時的な上書きに使える
  (例: `PORT=8200 node relay-server/server.js`)。
- 連携中止で使わなくなった `tablecheck` セクションと `reservation.pollMs` / `reservation.resyncMs` は、
  旧雛形からコピーした値が残っていても読み飛ばす。環境変数の `MOCK` / `POLL_MS` / `RESYNC_MS` も使わない。
- キー名を間違えた場合も**黙って既定値に落ちず、起動時に指摘して止まる**。

| config.json | 環境変数 | 既定 | 説明 |
|---|---|---|---|
| `server.host` | `HOST` | 127.0.0.1 | listen先。**デシャップモニターと注文端末はここへ繋ぐ** |
| `server.port` | `PORT` | 8000 | HTTP ポート |
| `reservation.dbFile` | `RESERVATION_DB_FILE` | `data/reservations.sqlite` | 予約を保存する SQLite ファイル(リポジトリ直下からの相対可) |
| `seat.beforeMin` / `seat.afterMin` | `SEAT_BEFORE_MIN` / `SEAT_AFTER_MIN` | 30 / 120 | 予約時刻の前後どこまでを在席とみなすか |
| `seat.walkinTtlMin` | `SEAT_WALKIN_TTL_MIN` | 120 | ローカル登録した占有をいつ諦めるか(1〜1440分)。退店イベントが無いため時間で切る #123 |
| `kitchen.ttlMin` | `KITCHEN_TTL_MIN` | 720 | 厨房状態(#132)を最後の更新から何分保持するか(1〜1440分) |
| `order.ttlMin` | `ORDER_TTL_MIN` | 720 | 注文(`/api/orders`)の保持時間(1〜1440分)。日跨ぎで前日分が残らないための上限 |
| `order.dbFile` | `ORDER_DB_FILE` | `data/orders.sqlite` | 注文の控えを置く SQLite ファイル(リポジトリ直下からの相対可)。再起動後に当日分を読み戻す |
| `auth.token` | `RELAY_TOKEN` | — | **共有トークン**(8文字以上)。設定すると他端末はトークン必須になる。未設定なら認証なし(従来どおり) #174 |
| `auth.trustLoopback` | `RELAY_TRUST_LOOPBACK` | 1 | ミニPC自身(127.0.0.1)をトークン無しで通すか。`0` で無効 |
| `auth.cookieSecure` | `RELAY_COOKIE_SECURE` | `auto` | 認証Cookieの`Secure`属性。`auto` / `true` / `false` (環境変数は`auto` / `1` / `0`) |

### 本番(店内LANの端末へ配信)

起動方法は同じ `node relay-server/server.js`。予約を `/reservations` で登録・取り込むと、
当日の `booked` かつメニューありの予約が `/api/stock` に出る。未登録なら空である。

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
| `/` , `/kds` , `/kds-a-grid.html` | KDS 本体(配信時にブリッジを注入) |
| `/kds-next` | React 版 KDS(`kds-next.html`。ブリッジは自身で読むため注入しない)。`kds-app/` のビルドで生成。現行 `/kds` は受け入れまで残す |
| `/api/stock` | KDS 予約ストック形式 `[{rid,time,adults,seniors,children,kids,name,menu[],allergies?,request?,seenAt}]`。人数は大人・シニア・子供・幼児(`kids`、0〜2歳)を分けて持ち、合計は KDS が4つを足して出す。`allergies` はアレルギー、`request` は要望の注記。当日の `booked` だけで、メニュー無し(席だけ)予約は含まない |
| `/reservations` | 予約入力画面(`reservation-entry.html`)。→「予約の入口」 |
| `GET /api/reservations?date=YYYY-MM-DD` | 指定日(省略時は当日)の予約一覧 `{date,reservations[]}`。取消済みも含む |
| `POST /api/reservations` | 予約の登録 `{startAt,name,adults,seniors?,children?,kids,table?,menu:[{name,qty}],allergies?,request?,memo?,rid?,status?}`。`rid` が既にあれば上書き。`mailId` を付けると、登録後に取込フォルダのそのメールを片づける |
| `GET` / `PUT` / `DELETE /api/reservations/{rid}` | 1件の取得・変更・取消(取消は行を残して status を `canceled` にする) |
| `POST /api/reservations/import/csv` | CSV(本文にファイルの中身。UTF-8 か Shift_JIS)または .xlsx(先頭のバイトで見分ける)の取込。`?dryRun=1` なら保存せず読み取り結果だけ返す |
| `POST /api/reservations/import/text` | `{text}` を読み取り、下書き `{draft,warnings}` を返す(保存しない) |
| `POST /api/reservations/import/mail` | メール1通(本文に `.eml` の中身。`?text=1` なら貼り付けたテキスト)を読み取り、下書きを返す(保存しない) |
| `GET /api/reservations/inbox` | メールの取込フォルダの候補 `{enabled,items:[{id,receivedAt,subject,draft,warnings}]}` |
| `DELETE /api/reservations/inbox/{id}` | 候補を登録せず片づける(`processed/` へ移す) |
| `/api/health` | ready状態・予約の保存件数(`reservations`)・注文配信の状況(`ordersStream`) |
| `GET /api/kitchen-state` | 厨房状態の共有スナップショット `{sessionId,rev,updatedAt,konro,done,locked,seq,deleted,serveCue,hallReady,tableOverride}`。→「厨房状態の端末間同期」 |
| `POST /api/kitchen-state` | 厨房状態の変更イベント投入 `{events:[...]}`。応答は `{ok,rev,sessionId}` |
| `GET /api/orders` | KDS 注文フィード(注文端末由来)。→「注文端末との契約」 |
| `POST /api/orders` | 注文の投入。`orderId` で冪等 |
| `DELETE /api/orders/{orderId}` | 注文の取消 |
| `GET /api/seats` | 当日の座席占有 `[{table,source:"walkin"\|"reservation",rid?,name?,since}]`。→「座席占有」 |
| `POST /api/seats` | 占有の登録 `{table:"5"}`。`{table:"3",rid:"r-1",name:"山田様"}` なら予約の着席として扱う |
| `DELETE /api/seats/{table}` | 占有の解除 |
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

KDS ホールモードの伝票ボタンから印刷する（キッチンには表示しない）。プリンターIP未設定時は `window.print()`(ブラウザ手動印刷)。
実機で印字するには:

1. KDS の「プリンター設定」でプリンター(例: Star mC-Print3)のIPアドレスを登録する。
   端末の `localStorage` に加え、relay接続時は `POST /api/printer` で `config/printer-ip.json` に保存し他端末へ共有する。店舗の実IPをコードへ固定しない。
2. 以降は「印刷」ボタン押下で `POST /api/print` → このサーバーが生ソケットでプリンターの
   RAWポート(9100)へコマンドバイト列を送信する(ブラウザは生TCPソケットを開けないため中継が必要)
3. 実機送信に失敗(未設定・接続不可・タイムアウト)した場合は自動で `window.print()` にフォールバックする

### 座席占有(#123)

運用上の本題は**座席バッティング** — 新規客(ウォークイン)が、この後来店する予約の席を
先に埋めてしまう問題。新規客の卓番は注文端末/KDSで発生するローカルデータで、予約ストアには載らない。
店内で塞ぐ。

```
予約(SQLite) ──▶ relay(store) ─┬─ /api/stock ──▶ KDS 予約ストック
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
- ローカル登録した占有は保存しない(#115)。当日メモリのみ

**実装と未決**: 手入力フォーム・API・ファイル取込には卓番欄がある。事前に卓番を確定する運用や、TableCheck の卓表記との対応、再取込時に店内で変更した卓番を保護する方法は未決。卓番が無い予約でも着席時のローカル登録で占有ビューは成立する(予約の「事前」占有だけが作れない)。

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

前菜/デザート(`serveCue`)と提供準備完了(`hallReady`)だけは、localStorage へ書いたうえで、
変わった卓をブリッジが `BroadcastChannel("kds_sync")` で KDS へ知らせる(`fromRelay:true` 付き)。
前菜/デザートは `poll()` が読み直さず、カードの帯も作り直されないため。知らせは他タブの操作と同じ
受信処理を通るので、別端末でデザートを出した卓はこの端末でもカードが消える。`fromRelay` 付きの
メッセージは他タブのブリッジが relay へ送り返さない(#288)。

卓番の上書き(`tableOverride`)も同じく、変わった卓(解除を含む)を KDS へ知らせる。`poll()` が
読み直すので書くだけでも1秒以内に画面へ乗るが、その間にホールでチビ伝を刷ると元の卓番で出るため(#293)。

受け取るイベントは KDS の `broadcast*()` が流す形そのまま:

| type | body | 意味 |
|---|---|---|
| `konro` | `{id, num, state}` | コンロ番号の状態。`state:"skeleton"` で解除 |
| `toggle` | `{id, index, doneCount}` | 品目の完了個数 |
| `timerLock` | `{id, locked}` | タイマーロック |
| `order` | `{seq:[cardId,...]}` | カードの並び順 |
| `deleteOrder` | `{id}` | 注文の削除(関連するコンロ・完了・ロック・並び順・前菜/デザート・提供準備完了・卓番の上書きも解放) |
| `serveCue` | `{id, state:{starter, dessert, starterAt, dessertAt, day}}` | 前菜/デザートを出したか(#288) |
| `hallReady` | `{id, snapshot:{orderId, table, people, completedAt, day, status, items, dismissedAt?, retractedAt?}}` | 提供準備完了。ホールのデザート待ちカードの根拠。取り下げ(`retracted`)より前の完了が遅れて届いても戻さない(#288) |
| `tableOverride` | `{id, table, removed}` | 厨房の卓番の上書き(#160)。`removed:true` か空の `table` で解除。ホールのチビ伝もこの卓番で刷る。注文の `table` は変えない(#293) |

`serveCue` と `hallReady` は、KDS が使う項目だけを残して保存する(文字列は長さを切り、品目は100件まで)。
`tableOverride` は卓番を文字列にそろえて保存する。32文字を超えるものは、切ると別の卓番になるため受理しない。

設計上の判断:

- **差分ではなく畳み込み済みのスナップショットを配る**。遅れて起動した端末も1回の取得で追いつける
- **全イベントが絶対値の代入**なので、再送・重複適用しても結果が変わらない(複数タブが同じイベントを送っても壊れない)
- **relay が空(`rev:0`)のときは端末が手元の状態を種として送る**。これが無いと「最初の1操作だけが載ったスナップショット」を取り込んだ瞬間に手元の状態が消える
- **`sessionId` で relay の再起動を検出する**。再起動で `rev` が 0 に戻るため、これが無いと端末が「取込済み」と誤認して同期が止まる
- **送信中・未送信のイベントがある間は取り込まない**。取り込むと直前の操作が一瞬巻き戻って見える
- **誤りのある一束は丸ごと受け付けず(400)、端末は送り直さずに捨てる**。relay は全件を検査してから書くので、状態も `rev` も変わらない。送り直し続けると列が空にならず、他の端末の操作を取り込めなくなる(#297)。捨てた件数と時刻は同期状態(厨房同期の「最終失敗」、`rejectedCount`・`lastRejectedAt`)とコンソールに残す。通信断・5xx・408・429 は今までどおり送り直す
- 通信断のときは手元の状態を保持する(relay が落ちても KDS は単独で動き続ける)
- 保存はしない(#115)。`kitchen.ttlMin`(既定720分)を過ぎたら当日分を捨てる

**同期の対象外**: 予約ストック(`/api/stock` が正本)と、予約→着手の移動。後者は着手した端末の
ストックからのみ消える(別端末では残る)ため、必要になったら別途対応する。

### 注文端末との契約(POST /api/orders)

注文端末(各卓16台)のシステムは別チームが作る。**受け口の形はこちらが定義し、別チームがそれに
合わせて送る**(2026-07-16 確定)。送信先は `config.json` の `server.host`/`port` に伝えるだけでよい。
2026-10-17 からは、注文端末が直接送るのではなく、注文を保存した**注文サーバー(order-system)がこの受け口へ転送する**(後述)。

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
| `table` | ✅(`tables` が無いとき) | 卓番(6文字以内)。**ペイロードで受け取る**(送信元IPからは引かない) |
| `tables` | | 卓番の配列(1〜15件、各 1〜2147483647 の整数、重複なし)。指定時は昇順に並べて `,` で連結した文字列を `table` にし、body の `table` は無視する。複数卓にまたがる注文のため(注文サーバーからの転送で使う) |
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

保持は**当日分だけ**。`order.ttlMin`(既定720分)を過ぎた注文は配信から落ちる。メモリで扱うと同時に
SQLite の控え(`data/orders.sqlite`)へ書き、再起動後は保持期間内の注文を読み戻す(→「注文の控え」)。
控えの書込みに失敗していた場合に備えて、注文端末側は未反映を検知したら再送してよい(冪等。同じ内容の再送でも控えへ書き直す)。

更新対象は `table`、`tables`、`people` と、`items[]` の配列全体（並び順、`name`、`qty`、
`note` / `options`、`allergies`）。`orderId` は識別子、初回の受付時刻 `start` は KDS の
タイマー・受付順の基準なので更新しない。`orderedAt` を変えて再送しても初回の `start` を維持する。

更新後の内容をもう一度送った場合は同一内容の再送として `duplicate:true` になる。取消との競合は
**relay に最後に到着した操作を正**とする。`DELETE` 後に同じ `orderId` の有効な `POST` が届けば
新規受付 (`201`) として再作成し、反対に更新後に `DELETE` が届けば配信から取り除く。

商品の識別は**名前が正**で確定した(2026-10-17): 注文サーバーからの転送では商品名スナップショット(`OrderItem.name`)を `name` として送る。マスタ照合は注文サーバー側で済んでいる。

**まだ決めていないこと**(別チームと詰める):

- 同じ注文の追加・訂正は同じ `orderId` で全内容を再送する。別会計・別注文としてカードを分ける場合のみ別 `orderId` を使う
- KDS 側で完了・削除した注文は relay からは消えない(TTL 満了まで配信される)。
  KDS は完了状態(`kds_done_v2`)と削除済みID(`kds_deleted_v1`)を持っており再表示はされないが、
  完了を relay へ返す経路は未実装(#132 の厨房状態同期と合わせて設計するのが自然)

#### 注文サーバー(order-system)からの転送

注文端末(React 画面)は、注文サーバー(別リポジトリ `restaurant-order-system`、サブモジュール `order-terminal/`、既定3001番)へ注文を送る。注文サーバーは注文を保存できたとき、同じ注文をこの `POST /api/orders` へ転送する。注文端末がここへ直接送ることはない。

転送される JSON の例:

```json
{
  "orderId": "9daa53b5-a7e7-43b5-8e9c-139f521dc79d",
  "table": "3,4",
  "tables": [3, 4],
  "people": 4,
  "orderedAt": "2026-10-17T09:05:00.000Z",
  "items": [
    { "name": "山城牛の肉たく土鍋御膳", "qty": 2, "note": "サイズ: 大盛り / 辛さ: 中辛" },
    { "name": "ウーロン茶", "qty": 4 }
  ]
}
```

- `orderId` は注文サーバーの `Order.id`(サーバーが発行するUUID)。端末が発行する `requestId` とは別物なので取り違えない。`requestId` は中継サーバーへ送らない。
- `tables` と `table` が両方届くが、`tables` があれば中継サーバーは `table` を見ずに組み立て直す。
- `people` が無い注文は項目ごと省略される(省略時は 0 扱い)。オプションの無い品目は `note` を省略する。
- 注文サーバーの環境変数:
  - `RELAY_ORDERS_URL`: 送信先(例 `http://192.168.1.50:8000/api/orders`)。空なら転送しない
  - `RELAY_TOKEN`: 中継サーバーの `auth.token` を設定している店舗では、同じ値を入れる(`Authorization: Bearer` で送る)
  - `RELAY_TIMEOUT_MS`: 1回の転送のタイムアウト(ミリ秒。既定 5000)
- 注文サーバーが別のPCで動く場合は、中継サーバー側の `config.json` の `server.host` を LAN の IP(`auto` か固定IP)にして、別PCから届くようにする。
- 再送: ネットワークエラー、タイムアウト、5xx、408、429 は 1秒・2秒・4秒と間隔を延ばして再送し、以降は30秒間隔とする。同じ `orderId` なので中継サーバーで二重にならない。400、401、403 など、それ以外の4xx は再送せず注文サーバーのログに残す。転送キューに入れてから30分を超えた注文は再送をやめ、`error` ログに `orderId` を残す。
- 転送キューは注文サーバーのメモリにあるため、注文サーバーを再起動すると未送信分は消える。中継サーバーは受付済みの注文を SQLite の控えに残し、再起動後に読み戻す(→「注文の控え」)ので、注文サーバーからの再送は要らない。KDS に出ない注文は `error` ログの `orderId` で見つけ、店で手当てする。

### KDS への接続(kds-bridge.js)

**このサーバー経由で `/` を開くと、配信時にブリッジが自動注入される**
(`routes/static.js` が `kds-a-grid.html` の `</body>` 直前へデモ抑止フラグとブリッジのscriptを差し込む。ディスク上のファイルは変更しない)。
静的配信は情報露出を避けるため `routes/static.js` の allowlist に限定する
(`kds-a-grid.html` / `reservation-entry.html` / `slip-style-designer.html` / `slip-renderer.js` / `assets/sounds/shishiodoshi.ogg` / `relay-server/kds-bridge.js` / `relay-server/party-size.js`)。シミュレーター有効時の追加ページは別途設定する。
サーバーを介さず単体で使う場合のみ、手動で `</body>` 直前に次を足す:

```html
<script src="/relay-server/kds-bridge.js"></script>
```

各端末のブリッジが 5秒間隔で `/api/stock` を取得し、`kds_stock_v1` へマージする。
`BroadcastChannel("kds_sync")` は同一originのタブ間に通知するだけで、別端末には届かない。別端末は各自のHTTP取得で追随する。マージ規則:

- **サーバーが正**: 変更は上書き、サーバーから消えた予約(キャンセル)は削除
- **保存に失敗した「＋追加」の予約(サーバーに無いもの)には触らない**。保存できたものはサーバー由来として扱う
- **着手・削除済みの予約は復活させない**(取込済み rid を記録)
- 通信断時は直前の表示を保持(6/18 方針)

同じブリッジが通常は `/ws/orders` で注文を即時受信し、切断中は2秒間隔の `/api/orders` 取得で復旧し、`window.KDS_ORDERS` へ反映する(#139)。
こちらのマージ規則:

- **サーバー由来の注文は毎回サーバーの内容で置き換える**
- 同じ `orderId` の更新でも、受付時刻を基準にする**タイマー**、`orderId` に紐づく**コンロ割当・タイマーロック・カード並び順・手動削除状態**は維持する
- 品目完了数は `name` + `options` + `allergies` が同じ行へ追従する。数量減では新数量を上限とし、数量増では既に完了した個数だけを維持する。新規行または品名・注記・アレルギーが訂正された行は未完了にする。同内容の行が複数ある場合は出現順で対応づける
- **KDS 内で生まれた注文(予約→着手の `res-*` カード)は残す** — 上書きするとホールが着手した
  予約カードが次のポーリングで消えるため
- 通信断時は `window.KDS_ORDERS` に触らない(直前の表示を保持)

## 内部構成

- `server.js`: 部品の組み立て、共有トークン認証、URLの振り分け、サーバーの起動・停止
- `relay-config.js`: 既定値・`config/config.json`・環境変数から実行時設定を組み立てて検証する
- `routes/`: 各APIの処理（`seats.js` 座席占有、`kitchen.js` 厨房状態、`orders.js` 注文、`print.js` 印刷・プリンターIP・印刷スタイル、`audit.js` 監査ログ閲覧、`qr-page.js` 接続用QR、`static.js` 静的ファイルとKDSへのブリッジ注入）
- `http-util.js`: JSON応答・リクエスト本文の読取などHTTPの小道具
- `request-audit.js`: リクエストから監査ログ用の主体・対象（不透明ID）を作る
- `reservation-store.js`: 予約の保存(SQLite)・取消・当日分の読み出しと KDS 予約ストック形式への変換
- `order-store.js`: 注文の控え(SQLite)。再起動後に保持期間内の注文をメモリへ読み戻す
- `printer-settings.js`: 印刷スタイル・プリンターIPの読込と保存
- `tests/`: 各モジュールとHTTP経由の回帰テスト

## テスト

```sh
cd relay-server
npm ci
npm test
```

Node.js 22 を使用する GitHub Actions と同じく、`npm ci` は lockfile に固定された依存関係を
導入し、`npm test` は`tests/` 内の全 `*.test.js` を実行する。テストは店舗の設定ファイル、
認証情報、外部 API を必要とせず、失敗時は非ゼロ終了する。

予約ストアは、入力の検証、上書き保存・取消、当日分の抽出と過去日の削除、KDS形式への変換、
ファイルに保存した予約が再起動後も残ることをカバーする。

設定については、config.json の env 形への変換、環境変数による上書き、ファイル由来の値にも
下限クランプが効くこと、旧 `tablecheck` セクションと取込間隔キーの読み飛ばし、キー名typo・不正JSONを起動時に弾くことを
カバーする。テストは `configFile` を注入する形なので、各自の `config/config.json` に左右されない。

## TableCheck 連携の中止(Issue #74)

2026-10-11、TableCheck API連携は行わないことになった。以下は中止時点の実装と、確定させずに終わった事項の記録である。

実APIの取得処理(`tablecheck-source.js`・Booking v1 ページング)、モックHTTP疎通確認とその手順書、
暫定契約の文書は [`archive/tablecheck/`](../archive/tablecheck/README.md) へ退避した。
その後、予約の正本を SQLite へ移す際に、TableCheck 形式の正規化(`tablecheck-sync.js`)、
差分取込・全件再構築(`booking-resync.js`)、供給源の切替(`reservation-source.js`)、
モック(`mock-tablecheck.js`)とデモコンソール(`tablecheck-demo.html`・`/api/mock/*`)も
[`archive/tablecheck/`](../archive/tablecheck/README.md) へ退避した。relay-server に旧 TableCheck API 接続・モックのコードは残っていない。
ただし現行の `reservation-import.js` / `xlsx-reader.js` は TableCheck の書き出しファイルを読む。また旧 `config.json` の `tablecheck` セクションを読み飛ばす処理も残している。

実環境で確認する予定だったもの（連携中止により確認不要）:

1. APIキー・Shop IDの発行と、本番／テスト環境の利用権限
2. 認証方法・認証ヘッダーの最終仕様（現実装は Bearer）
3. API連携の料金と、予約通知メール（Messaging v1）の契約可否

関連資料: [archive/tablecheck/docs/テーブルチェックAPI.md](../archive/tablecheck/docs/テーブルチェックAPI.md) ／
[knowledge/2026-07-15_テーブルチェックAPI連携_データ定義・裏どり結果.md](../knowledge/2026-07-15_テーブルチェックAPI連携_データ定義・裏どり結果.md)


## 注文のWebSocket配信

`npm ci` 後に通常どおり起動し、`/kds` または `/` を開くと自動接続する。
`ws` は配信用の依存。未インストールなら警告を出しHTTP取得で動作する。
予約・厨房操作の同期方式は従来どおり。

- `/ws/orders`: 初回・再接続で `orders.snapshot`、変更で `order.created` / `order.updated` / `order.cancelled`。
- 共通フィールドは `sessionId`（起動ごとのUUID）、`sequence`、`sentAt`。同内容の再送とheartbeatでは連番を増やさない。
- 注文は仕様書の `orderId` / `orderedAt` / `status` / `items[].note` 形式。ブリッジ内で既存KDS形式へ変換する。
- 欠番、別セッション、不正メッセージは再接続して全件復旧。再試行は1秒から最大30秒。切断中も直前表示を保持する。
- 5秒ごとのPing/PongとJSON heartbeat（画面の同期遅延判定10秒に余裕を確保）、画面側25秒の受信監視。スリープ復帰・オンライン復帰でも再接続する。
- Originのホスト・ポートがHostヘッダーと一致するHTTP(S)画面のみ許可。既存Cookie/Bearer認証を適用し、WebSocket URLのクエリは拒否する。
- 最大64接続、受信4KiB、送信待ち1MiB超で切断。TTL切れも1秒以内を目安に取消配信する。
- 取消は現行画面に合わせ即時除去。完了数の引継ぎ、ローカル注文、コンロ割当等は既存のマージ処理で維持する。

HTTPSでは自動的にWSSを使う。TLSはリバースプロキシで終端し、元のHostと
Upgrade/Connectionヘッダーを転送する。Node側はループバックで待ち受け、
`RELAY_TRUST_LOOPBACK=0` と共有トークンを設定してプロキシ経由でも認証する。
プロキシのアイドルタイムアウトはheartbeat間隔より長くする。

### WSS とモック注文シナリオでの検証

実機でWSSを試すときは、証明書と秘密鍵のPEMを渡すとNode自身がHTTPS/WSSで待ち受ける
（`config.json` の `server.tlsCert` / `server.tlsKey`、または環境変数 `TLS_CERT_FILE` / `TLS_KEY_FILE`。
片方だけだと起動エラー）。本番の推奨構成はリバースプロキシでのTLS終端のまま。

```sh
openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj /CN=<中継サーバーのIP> \
  -addext "subjectAltName=IP:<中継サーバーのIP>" -keyout key.pem -out cert.pem
MOCK_ORDER_SCENARIO=1 HOST=auto PORT=8443 TLS_CERT_FILE=/path/to/cert.pem TLS_KEY_FILE=/path/to/key.pem node relay-server/server.js
```

- 秘密鍵はリポジトリへ置かない。自己署名証明書はタブレット側で警告を承認するか、証明書をインストールして使う。
- `MOCK_ORDER_SCENARIO=1`（`order.mockScenario: true`）は配信仕様書 §17 の時間差シナリオ。起動直後に `mock-001` / `mock-002` を保持し、5秒後に `mock-003` 追加、10秒後に `mock-001` 数量更新、15秒後に `mock-002` 取消。実注文に模擬注文が混ざるため、店舗運用では有効にしない。
- KDSは差分・スナップショットを適用するたびに `orders.ack` を返す。サーバーは再送には使わず、`GET /api/health` の `ordersStream`（`clients` / `sequence` / `upToDate` / `lowestAck`）で端末の追従状況を確認できる。

検証は既存の `POST /api/orders` で同じorderIdの新規・数量変更を送り、
`DELETE /api/orders/{orderId}` で取消する。ブラウザーを複数開いて即時反映、
Wi-Fi切断後の再接続を確認できる。実機のWi-Fi・スリープ・TLS試験は別途実施する。
