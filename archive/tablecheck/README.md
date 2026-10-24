# TableCheck API 連携（退避）

> **現況注記（2026-10-22）**：以下はAPI連携中止・コード退避時点の記録。現在は `/reservations` にCSV／Excelファイル取込・手入力等の入口を試作済みで、TableCheckの書き出しを読み込む処理は現行の `reservation-import.js` にある。旧APIコードの復活とは別である（[現行手順](../../relay-server/README.md#予約の保存reservation-storejs)）。

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
- `config/config.json` の `tablecheck` セクション（旧雛形の値が残っていても読み飛ばす）
- 上記に対応するテスト（LIVEアダプター、Booking v1 ページング、LIVE設定の検証）

### 2回目の退避（予約の SQLite 化、PR #278）

最初の退避では、予約ストック → KDS の経路を手入力でも使う想定で、次のファイルを relay-server に残していた。
予約の正本を SQLite（`relay-server/reservation-store.js`）へ移したときに、これらも退避した。

| 退避先 | 元の場所 | 内容 |
|---|---|---|
| `relay-server/tablecheck-sync.js` | 同じ | TableCheck 予約スキーマの正規化（status 変換・`orders[]`・`questions[]`・memo パーサー） |
| `relay-server/booking-resync.js` | 同じ | 予約ストアの全件同期・差分同期（初回同期までの 503 ゲート） |
| `relay-server/reservation-source.js` | 同じ | 予約の供給源の切替（MOCK／予約ソースなし） |
| `relay-server/mock-tablecheck.js` | 同じ | TableCheck 形式のデモ予約の供給源 |
| `relay-server/tablecheck-demo.html` | 同じ | 予約デモコンソール（`/demo`） |
| `relay-server/routes/mock.js` | 同じ | `/api/mock/reservations` |
| `relay-server/tests/tablecheck-sync.test.js`・`tests/booking-resync.test.js` | 同じ | 上記のテスト |

あわせて、設定の `reservation.pollMs` / `reservation.resyncMs` と環境変数 `MOCK` を廃止し、KDS が予約から引き継いでいた
`questions[]`（TableCheck の設問回答。表示には使っていなかった）を外した。
relay-server に TableCheck 用のコードは残っていない。旧 `config.json` の `tablecheck` セクションと
取込間隔のキーを読み飛ばす処理（`load-config.js`）だけは、店舗の設定ファイルで起動が止まらないように残している。

## 復元する場合

連携コードがすべて動いていた状態は `main` のコミット `d4008b2`（PR #274 のマージ）である。
モック・`/demo` で予約ストックまで動いていた最後の状態は `383d231`（PR #278 の直前）である。

```sh
git show d4008b2:relay-server/server.js
git checkout d4008b2 -- relay-server/tablecheck-source.js
```

ここにあるファイルを元の場所へ戻すだけでは動かない。`server.js`・`relay-config.js`・`load-config.js`・`booking-resync.js` の該当部分も `d4008b2` から戻す必要がある。

## 関連資料

- [テーブルチェックAPI（暫定契約・中止）](docs/テーブルチェックAPI.md)
- [TableCheck API連携：データ定義・裏どり結果 (2026-07-15)](../../knowledge/2026-07-15_テーブルチェックAPI連携_データ定義・裏どり結果.md)
- [relay-server/README.md「TableCheck 連携の中止」](../../relay-server/README.md#tablecheck-連携の中止issue-74)
