# テーブルチェックAPI

## 必要なAPI

- Booking v1
  - 当日の予約一覧取得
  - 予約詳細取得
- Sync v1
  - 予約の新規・変更・キャンセル検知

## 必要な認証・設定情報

- APIキー（`secret_key`）
- Shop ID
- 本番環境のAPI利用権限
- テスト環境のAPI利用権限
- 正確な認証ヘッダー形式

## 必要な予約データ

| 項目 | APIフィールド |
| --- | --- |
| 予約ID | `id` |
| 店舗ID | `shop_id` |
| 来店予定日時 | `start_at` |
| 予約者の姓 | `last_name` |
| 予約者の名 | `first_name` |
| 合計人数 | `pax` |
| 大人人数 | `pax_adult` |
| 子供人数 | `pax_child` |
| 予約ステータス | `status` |
| 更新日時 | `updated_at` |

## 必要な事前メニューデータ

| 項目 | APIフィールド |
| --- | --- |
| 事前注文一覧 | `orders[]` |
| メニュー名 | `orders[].menu_item_name_translations` |
| 数量 | `orders[].qty` |
| メニュー明細ID | `orders[].id` |

## 必要なアレルギー・要望データ

| 項目 | APIフィールド |
| --- | --- |
| カスタム設問と回答 | `questions[]` |
| 設問 | `questions[].question` |
| 回答 | `questions[].answer` |
| その他の要望 | `special_request` |
