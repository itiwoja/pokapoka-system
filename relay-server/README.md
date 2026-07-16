# relay-server — 店内中継サーバー(TableCheck取込 + Web配信)

TableCheck の予約(メニュー・人数等)を取得し、KDS の予約ストックに流し込むためのサーバー。
6/18 議事録の「ファイルを置くだけの見かけ上のサーバー」役と、TableCheck 取込役の2役を1プロセスで担う。
**依存パッケージゼロ・Node 18+ のみで動作**(本体リポジトリの単一HTML主義に合わせた設計)。

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

### 本番(API契約後・店内LANのKDS端末へ配信)

```sh
HOST=192.168.1.10 TABLECHECK_API_KEY=<secret_key> SHOP_ID=<shop_id> node relay-server/server.js
```

`HOST` 未指定時は安全のため `127.0.0.1` のみにbindする。別端末のKDSへ配信するときは
例の `192.168.1.10` を**ミニPCの店内LAN固定IP**へ置き換える。`0.0.0.0`（全IF）を避け、
信頼できる隔離LAN/VLANとOSファイアウォールでKDS端末だけを許可すること。
インターネットへのポート開放や、来客用Wi-Fiからの到達は許可しない。

| 環境変数 | 既定 | 説明 |
|---|---|---|
| `PORT` | 8000 | HTTP ポート |
| `HOST` | 127.0.0.1 | listen先。店内LAN配信時はミニPCの固定private IPを指定 |
| `POLL_MS` | 30000 | ポーリング間隔(下限30000) |
| `RESYNC_MS` | 900000 | Booking v1 当日全件リシンク間隔(既定15分、LIVE最小1分) |
| `TABLECHECK_TIMEOUT_MS` | 15000 | TableCheck接続+JSON読込のタイムアウト(1〜120秒) |
| `TABLECHECK_API_KEY` | — | 契約後に発行される secret_key。未設定ならモック |
| `SHOP_ID` | — | 対象店舗。LIVEでは必須 |
| `TABLECHECK_BASE` | api.tablecheck.com | 旧 tablesolution.com は2026年廃止のため使わない |
| `TABLECHECK_ALLOW_CUSTOM_BASE` | 0 | 公式以外のHTTPS接続先を明示許可する場合のみ `1` |

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
node --test relay-server/booking-resync.test.js relay-server/server.test.js
```

正規化(スキーマ候補キー・pax→adults フォールバック)、memo パーサ、
upsert/404削除/当日パージ/KDS形式変換に加え、全件ページング、原子的なstore差替え、
初回503ゲート、失敗時の直前状態保持、差分との直列実行をカバーする。

## ⚠️ スキーマ確定待ちの箇所(Issue #74)

TableCheck 予約オブジェクトの正確なフィールド名は打合せ/APIコンソールで確認後、
**`tablecheck-sync.js` の `normalizeReservation()` / `normalizeMenu()` だけ**直せばよい:

1. 🔴 メニューが構造化フィールドで返るか(`courses` 等)、memo 自由テキストか
   → memo の場合は `parseMenuFromMemo()` の書式と店側の記載ルールを揃える
2. ⚠️ 大人/子供の内訳フィールド名(無ければ pax 合計を adults に寄せる現仕様のまま)
3. ⚠️ 認証ヘッダーの正確な形式(`server.js` の `tcFetch()` に TODO 記載)

関連資料: [knowledge/2026-07-15_テーブルチェックAPI連携_データ定義・裏どり結果.md](../knowledge/2026-07-15_テーブルチェックAPI連携_データ定義・裏どり結果.md)
