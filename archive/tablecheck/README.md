# TableCheck API 連携（退避）

2026-10-11、TableCheck API連携は行わないことになった。予約情報は店員の手入力で扱う方針とする（入力方法は未設計）。
ここには、連携のためだけに作ったコード・テスト・文書を退避している。

**このディレクトリのファイルは実行・テストの対象外である。** `npm test` は `relay-server/tests/` と `tests/` だけを実行し、ここは読み込まない。
退避後の relay-server から参照されていないため、そのままでは動かない。

## 退避したもの

| 退避先 | 元の場所 | 内容 |
|---|---|---|
| `relay-server/tablecheck-source.js` | `relay-server/tablecheck-source.js` | TableCheck 実API（Booking v1 / Sync v1）の取得処理とモック切替 |
| `relay-server/booking-v1-pagination.js` | `relay-server/booking-resync.js` の一部 | Booking v1 当日全件のページング取得（`listAllReservations` など）。退避時に切り出した |
| `relay-server/tests/tablecheck-connectivity.test.js` | `relay-server/tests/tablecheck-connectivity.test.js` | ローカルHTTPモックへの疎通確認（`npm run check:tablecheck`） |
| `relay-server/tablecheck-connectivity.md` | `relay-server/tablecheck-connectivity.md` | 上の疎通確認の手順書 |
| `docs/テーブルチェックAPI.md` | `docs/テーブルチェックAPI.md` | 暫定データ契約（使用API、認証・設定、取り込むデータ、未確定事項） |

あわせて、relay-server から次の部分を取り除いた。

- `TABLECHECK_API_KEY` の有無で選んでいた LIVE モードと、`TABLECHECK_BASE` / `SHOP_ID` / `TABLECHECK_TIMEOUT_MS` / `TABLECHECK_ALLOW_CUSTOM_BASE` の設定、接続先のHTTPS検証、30秒のポーリング下限
- `config/config.json` の `tablecheck` セクション（旧雛形の値が残っていても読み飛ばす）。差分取込・全件再構築の間隔は `reservation.pollMs` / `reservation.resyncMs` へ移した
- 上記に対応するテスト（LIVEアダプター、Booking v1 ページング、LIVE設定の検証）

## relay-server に残したもの

予約ストック → KDS（`/api/stock`）と座席占有（`/api/seats`）は、予約の手入力でも使う想定のため残している。

- `booking-resync.js`: 予約ストアの全件同期・差分同期の状態管理
- `tablecheck-sync.js`: 予約データの正規化（TableCheck の予約スキーマ形を受ける）
- `mock-tablecheck.js`・`tablecheck-demo.html`（`/demo`）・`routes/mock.js`: デモ予約の供給源と操作コンソール
- `reservation-source.js`: 予約の供給源の切替（既定は MOCK、`MOCK=0` で予約ソースなし）

ファイル名に `tablecheck` が残っているものは、手入力の設計にあわせて改名・整理する。

## 復元する場合

退避直前の、連携コードがすべて動いていた状態は `main` のコミット `d4008b2`（PR #274 のマージ）である。

```sh
git show d4008b2:relay-server/server.js
git checkout d4008b2 -- relay-server/tablecheck-source.js
```

ここにあるファイルを元の場所へ戻すだけでは動かない。`server.js`・`relay-config.js`・`load-config.js`・`booking-resync.js` の該当部分も `d4008b2` から戻す必要がある。

## 関連資料

- [テーブルチェックAPI（暫定契約・中止）](docs/テーブルチェックAPI.md)
- [TableCheck API連携：データ定義・裏どり結果 (2026-07-15)](../../knowledge/2026-07-15_テーブルチェックAPI連携_データ定義・裏どり結果.md)
- [relay-server/README.md「TableCheck 連携の中止」](../../relay-server/README.md#tablecheck-連携の中止issue-74)
