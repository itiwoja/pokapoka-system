# TableCheck API モック疎通確認

APIキーがない状態で、既存APIクライアントからローカルHTTPモックへの通信を確認する。
**実TableCheckへの疎通成功や、本番・テスト環境のAPI利用権限を証明するものではない。**

## 実行

リポジトリ直下で、Node.js 18以上を使って実行する。

```powershell
npm --prefix relay-server run check:tablecheck
```

7つの確認項目と親テストの計8テストが成功し、終了コード0ならモック疎通は成功。
テスト用サーバーは `127.0.0.1` の空きポートで起動し、確認後に停止する。
既存サーバーの起動、依存パッケージのインストール、APIキーの準備は不要。
実際の環境変数・店舗設定ファイルを読み込まず、架空の予約をメモリ上で使用する。

## 確認する通信とデータ

`tablecheck-connectivity.test.js` が `server.js` の `createTableCheckSource` を使用する。
通常の `MOCK=1` による関数呼び出しの省略経路ではなく、実クライアントのHTTP・JSON処理を通す。
接続先はテスト内で固定するため、本番設定のHTTPS制限を変更する必要はない。

| 対象 | 現在のクライアントが使用するパス・確認内容 |
|---|---|
| Booking v1 当日予約一覧 | `GET /api/booking/v1/reservations`。`shop_ids`、`start_at_min` / `start_at_max`、0始まりのページング。200件境界で次ページを取得し、前日・別店舗の予約を除外 |
| Booking v1 予約詳細 | `GET /api/booking/v1/reservations/{id}`。必要データの一致、存在しないIDの404処理 |
| Sync v1 | `GET /api/sync/v1/sync_events?deliver=true&shop_id=...`。新規・更新のIDから詳細を再取得し、キャンセルは詳細の `status=cancelled` で検知 |
| 予約ストック | 全件同期で初期化、新規追加、人数・メニュー変更、キャンセル除去。ブラウザ画面の操作はこのコマンドには含まない |
| エラー | 模擬401・403・429・500。同期エラーで直前ストックを保持し、復旧後に全件取得できること |

| 必要なデータ | モックのフィールド |
|---|---|
| 予約ID / 店舗ID | `id` / `shop_id` |
| 来店予定日時 | `start_at`（タイムゾーンを含むISO日時） |
| 予約者の姓 / 名 | `last_name` / `first_name` |
| 合計 / 大人 / 子供人数 | `pax` / `pax_adult` / `pax_child` |
| 予約ステータス / 更新日時 | `status` / `updated_at` |
| 事前注文一覧 | `orders[]` |
| メニュー名 / 数量 / メニュー明細ID | `orders[].menu_item_name_translations.ja` / `qty` / `id` |
| カスタム設問と回答 | `questions[]` の `id` / `question` / `answer` |
| その他の要望 | `special_request` |

データ形はリポジトリ内の既存実装と
[既存のAPI調査記録](../knowledge/2026-07-15_テーブルチェックAPI連携_データ定義・裏どり結果.md)
に基づくモック契約。店舗ごとの実応答との一致は未確認。
注文明細IDとメニューマスターIDは別の可能性があり、ここでは注文明細の `orders[].id` を検査する。
当日の範囲は既存実装と同じ実行端末のローカル日付で計算する。店舗での実行時は端末のタイムゾーンも確認する。

**全項目の検査対象はAPIクライアントが取得した生予約データ。** 既存のKDS向け変換は
姓名を結合し、店舗ID・合計人数・メニュー明細ID・設問回答などをストックに渡していない。
`special_request` は内部の `memo` に保持されるが、現在の予約ストックには出ない。
この疎通成功はアレルギー・要望の厨房画面表示完了を意味しない。

## APIキー準備後に確認する事項

| 設定・権限 | 現状 / 実接続前の確認 |
|---|---|
| APIキー | 今回は固定のダミー文字列。実キーは `TABLECHECK_API_KEY` 環境変数に設定し、コミットしない |
| Shop ID | 今回は `mock-shop`。実値は `SHOP_ID` または `config/config.json` の `tablecheck.shopId` |
| 本番API利用権限 | 未確認。Booking v1 / Sync v1と対象店舗へのアクセス権を提供元に確認 |
| テスト環境API利用権限 | 未確認。利用可否・URL・テスト店舗ID・キーが本番と別かを確認 |
| 認証方法・ヘッダー | 既存クライアントの `Authorization: Bearer <key>` と `Accept: application/json` をモックが検査。実環境での正しさは提供元に確認 |
| 応答・同期契約 | 必要フィールドの有無、空値・型、設問設定、一覧/詳細のレスポンス包み、ページング、配信済みイベントの再取得・リトライ条件を実応答で確認 |

## 画面で試す場合

PowerShellでモックを明示して起動する。

```powershell
$env:MOCK = '1'
node relay-server/server.js
```

既定設定では [予約デモ](http://127.0.0.1:8000/demo) から予約作成・変更・キャンセルを行い、
[KDS](http://127.0.0.1:8000/) で反映を確認できる。設定でhost/portを変えている場合はその接続先を使う。
既存デモフォームには設問回答の入力欄はないため、設問回答の取得検査には上記の自動確認を使う。
