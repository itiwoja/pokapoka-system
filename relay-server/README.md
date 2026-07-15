# relay-server — 店内中継サーバー(TableCheck取込 + Web配信)

TableCheck の予約(メニュー・人数等)を取得し、KDS の予約ストックに流し込むためのサーバー。
6/18 議事録の「ファイルを置くだけの見かけ上のサーバー」役と、TableCheck 取込役の2役を1プロセスで担う。
**依存パッケージゼロ・Node 18+ のみで動作**(本体リポジトリの単一HTML主義に合わせた設計)。

```
【クラウド】               【店内ミニPC = このサーバー】          【KDS端末】
TableCheck ◀── 30秒pull ──  server.js ── /api/stock(JSON) ──▶ kds-bridge.js
(Booking v1 + Sync v1)      当日分のみメモリ保持                  → kds_stock_v1 へマージ
                            kds-a-grid.html も配信                → BroadcastChannel で全端末反映
```

- 通信は**店内→TableCheck の外向き(pull)のみ**。Webhook(push)は店内が NAT 内のため使わない(2026-06-04 検討/裏どり済み)。
- ポーリング間隔は **30秒未満不可**(TableCheck Sync v1 の指定。コード側で下限を強制)。
- 予約データは**メモリのみ・当日分のみ**保持(6/18 議事録「サーバに保存しない」を実装で担保)。

## 使い方

### いますぐ試す(API契約前・モックモード)

```sh
node relay-server/server.js        # APIキー未設定なら自動でモック
# または明示的に
MOCK=1 node relay-server/server.js
```

→ http://127.0.0.1:8000/ で KDS が開く。デモ予約が流れ、数回のポーリングで
「人数変更(updated)」「キャンセル(→ストックから消える)」まで一通り再現される。

### 本番(API契約後)

```sh
TABLECHECK_API_KEY=<secret_key> SHOP_ID=<shop_id> node relay-server/server.js
```

| 環境変数 | 既定 | 説明 |
|---|---|---|
| `PORT` | 8000 | HTTP ポート |
| `POLL_MS` | 30000 | ポーリング間隔(下限30000) |
| `TABLECHECK_API_KEY` | — | 契約後に発行される secret_key。未設定ならモック |
| `SHOP_ID` | — | 対象店舗 |
| `TABLECHECK_BASE` | api.tablecheck.com | 旧 tablesolution.com は2026年廃止のため使わない |

### エンドポイント

| パス | 内容 |
|---|---|
| `/` , `/kds-a-grid.html` | KDS 本体(リポジトリ直下を静的配信) |
| `/api/stock` | KDS 予約ストック形式 `[{rid,time,adults,kids,name,menu[],seenAt}]`。メニュー無し(席だけ)予約は含まない |
| `/api/health` | モード・最終ポーリング結果・保持件数 |

### KDS への接続(kds-bridge.js)

KDS 本体は無改修。`kds-a-grid.html` の `</body>` 直前に1行追加するだけ:

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
```

正規化(スキーマ候補キー・pax→adults フォールバック)、memo パーサ、
upsert/404削除/当日パージ/KDS形式変換をカバー(16 assertions)。

## ⚠️ スキーマ確定待ちの箇所(Issue #74)

TableCheck 予約オブジェクトの正確なフィールド名は打合せ/APIコンソールで確認後、
**`tablecheck-sync.js` の `normalizeReservation()` / `normalizeMenu()` だけ**直せばよい:

1. 🔴 メニューが構造化フィールドで返るか(`courses` 等)、memo 自由テキストか
   → memo の場合は `parseMenuFromMemo()` の書式と店側の記載ルールを揃える
2. ⚠️ 大人/子供の内訳フィールド名(無ければ pax 合計を adults に寄せる現仕様のまま)
3. ⚠️ 認証ヘッダーの正確な形式(`server.js` の `tcFetch()` に TODO 記載)

関連資料: [knowledge/2026-07-15_テーブルチェックAPI連携_データ定義・裏どり結果.md](../knowledge/2026-07-15_テーブルチェックAPI連携_データ定義・裏どり結果.md)
