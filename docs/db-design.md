# DB 論理設計書 v0.1

> **ステータス**: 論理設計のみ（DB 製品・配置は未決定）。物理設計（DB選定・同期方式・DDL確定）は別途。
> **目的**: (1) 将来の POS / テーブルチェック連携の受け皿、(2) 予約・メニューのマスタ管理。
> **前提の変更**: 2026-06-18 議事録の「データ保存は当日分のみ・永続DB無し」の決定を改訂し、永続DBを導入する方向の設計である。

## 1. 背景と現状

現在の KDS（`kds-a-grid.html`）は永続DBを持たず、以下で構成される。

| データ | 現在の置き場 | 中身 |
|---|---|---|
| 注文 | `window.KDS_ORDERS`（メモリ） | `{id, table, type, start, people, items:[{name, qty, options, done}]}` |
| 品目完了状態 | LocalStorage `kds_done_v1` | orderId → bool 配列 |
| コンロ状態 | LocalStorage `kds_konro_v1` | cardId → {番号: white/red} |
| 予約ストック | LocalStorage `kds_stock_v1` | `[{rid, time, adults, kids, name, menu:[{name,qty}], seenAt}]`（当日分のみ） |
| 提供時間ログ | LocalStorage `kds_serve_log_v1` | KPI ベースライン（Issue #29） |
| メニュー分類 | コード内 `itemCategory()` | 品名の正規表現でカテゴリ判定（Issue #13 レーン表示） |
| 各種設定 | LocalStorage 複数キー | 権限モード・自動印刷・音・表示モード等 |

課題:

- LocalStorage は消失リスクがあり、日次レポート（#31）・需要予測（#26）の基盤にならない
- メニュー・分類がコードに埋まっており、メニュー改定のたびにコード修正が必要
- POS / テーブルチェック連携（deshup-spec.md「検討中」）が来たとき、注文データの正規化された保存先が無い

## 2. 設計方針

1. **POS 受け皿＝「外部ID＋スナップショット」パターン**
   POS 側のデータ形式が未確定のため、`external_id` で冪等に取り込み、品名等は注文時点の文字列をそのまま保存する（マスタ変更の影響を受けない）。マスタとの紐付けは nullable FK とし「照合できたら紐付く」設計にする。
2. **マスタとトランザクションの分離**
   コードに埋まっている分類ロジック（`itemCategory` の正規表現）とメニュー一覧をマスタテーブルに昇格させる。
3. **KDS の操作状態は DB に入れない**
   コンロ番号・カード並び順・タイマーロック・各トグルは端末ローカルの一時状態であり、現行の LocalStorage + BroadcastChannel のまま。DB は「事実の記録」（注文・予約・完了時刻）に限定する。
4. **bool ではなく時刻で記録する**
   `done` フラグは `done_at`（時刻）として持ち、完了の事実がそのまま分析データになる形にする。

## 3. ER 概観

```
menu_categories 1──n menu_items
menu_items      1──n menu_item_options（menu_item_id NULL = 全品共通）

tables 1──n orders
tables 1──n reservations（来店時に席番確定）

reservations 1──n reservation_items ──(n..1 任意)── menu_items
reservations 1──1 orders（来店→配膳移動で注文化）

orders 1──n order_items ──(n..1 任意)── menu_items
```

## 4. マスタ（4テーブル）

### 4.1 menu_categories — レーン分類の正本

現行 `itemCategory()` の正規表現判定を置き換える。

| 列 | 型 | 制約 | 備考 |
|---|---|---|---|
| id | PK | | |
| code | text | UNIQUE, NOT NULL | `rice` / `side` / `drink` |
| name | text | NOT NULL | ご飯類・サイド・ドリンク |
| display_order | int | NOT NULL | レーン表示順 |

### 4.2 menu_items — メニュー正本

| 列 | 型 | 制約 | 備考 |
|---|---|---|---|
| id | PK | | |
| category_id | FK → menu_categories | NOT NULL | |
| name | text | NOT NULL | 例: 山城牛の焼きすき土鍋御膳 |
| short_name | text | NULL可 | 略称（KDS 表示用。deshup-spec 記載） |
| pos_code | text | NULL可, UNIQUE | **POS 連携の照合キー（受け皿）** |
| is_active | bool | NOT NULL, default true | 販売終了は削除せず無効化 |
| display_order | int | NOT NULL | 予約フォームの並び順 |

### 4.3 menu_item_options — 定型オプション

大盛り・肉増し・ロック等、予約フォーム・注文入力で選択肢として出す定型オプション。

| 列 | 型 | 制約 | 備考 |
|---|---|---|---|
| id | PK | | |
| menu_item_id | FK → menu_items | NULL可 | NULL = 全品共通オプション |
| name | text | NOT NULL | |

### 4.4 tables — 座席マスタ

2026-06-03 議事録「座席DB」に対応。

| 列 | 型 | 制約 | 備考 |
|---|---|---|---|
| id | PK | | |
| label | text | UNIQUE, NOT NULL | A1〜C3 等 |
| capacity | int | NULL可 | |
| is_active | bool | NOT NULL, default true | |

## 5. トランザクション（4テーブル）

### 5.1 reservations — 予約ストックの永続化

現行 LocalStorage `kds_stock_v1` を置き換える。「当日分のみ」の縛りを外し、営業日をまたぐ事前入力を可能にする。

| 列 | 型 | 制約 | 備考 |
|---|---|---|---|
| id | PK | | |
| external_id | text | NULL可, UNIQUE | 予約連携（メール/API）が来たときの照合キー |
| source | text | NOT NULL | `manual` / `api` / `mail` |
| reserved_at | datetime | NOT NULL | 予約日時 |
| customer_name | text | NOT NULL | |
| adults | int | NOT NULL | 大人人数 |
| kids | int | NOT NULL, default 0 | 0〜2歳内訳（deshup-spec 準拠） |
| status | text | NOT NULL | `stocked` → `seated` / `canceled` / `no_show` |
| table_id | FK → tables | NULL可 | 来店時の席番入力で確定 |
| notified_30min_at | datetime | NULL可 | 30分前通知の発火記録（再通知防止） |
| seated_at | datetime | NULL可 | 来店（メイン移動）時刻 |

### 5.2 reservation_items

| 列 | 型 | 制約 | 備考 |
|---|---|---|---|
| id | PK | | |
| reservation_id | FK → reservations | NOT NULL | |
| menu_item_id | FK → menu_items | NULL可 | マスタ照合できたら紐付け |
| item_name | text | NOT NULL | スナップショット |
| qty | int | NOT NULL | |

### 5.3 orders — 注文（現 `window.KDS_ORDERS`）

| 列 | 型 | 制約 | 備考 |
|---|---|---|---|
| id | PK | | |
| external_id | text | NULL可, UNIQUE | **POS 側の注文 ID（冪等取込の要）** |
| source | text | NOT NULL | `pos` / `manual` / `demo` |
| business_date | date | NOT NULL | 営業日（日次レポート #31 の集計キー） |
| table_id | FK → tables | NULL可 | |
| table_label | text | NOT NULL | スナップショット（座席マスタ未整備でも動く） |
| type | text | NOT NULL | `new` / `reserved`（カード色の正本） |
| reservation_id | FK → reservations | NULL可 | 予約→配膳移動の由来リンク |
| adults | int | NULL可 | 内訳（POS 由来で無ければ NULL、合計のみ） |
| kids | int | NULL可 | 同上 |
| people | int | NOT NULL | 合計人数 |
| received_at | datetime | NOT NULL | 現 `start` |
| completed_at | datetime | NULL可 | 全品目 done 時刻 |
| status | text | NOT NULL | `open` / `completed` / `canceled` |

### 5.4 order_items — 注文品目（現 `items[]` + `kds_done_v1`）

| 列 | 型 | 制約 | 備考 |
|---|---|---|---|
| id | PK | | |
| order_id | FK → orders | NOT NULL | |
| line_no | int | NOT NULL | 品目順（現行 doneMap の index 依存を排除） |
| menu_item_id | FK → menu_items | NULL可 | 照合できたら紐付け（レーン用カテゴリはここ経由で引く） |
| item_name | text | NOT NULL | スナップショット |
| qty | int | NOT NULL | |
| options_text | text | NULL可 | 自由記述（オプション・アレルギー・備考含む） |
| done_at | datetime | NULL可 | NULL = 未完了。再タップ取消は NULL へ戻す |

制約: `UNIQUE (order_id, line_no)`

## 6. 提供時間ログ（#29）は導出ビューにする

`orders.received_at` と `completed_at` が揃うため、serve_log は独立テーブルにせずビューで導出する。

```sql
CREATE VIEW serve_log AS
SELECT id, business_date, table_label,
       received_at, completed_at,
       completed_at - received_at AS serve_duration
FROM orders
WHERE status = 'completed';
```

- 現行 LocalStorage ログの「orderId 重複ガード」は orders の主キーで構造的に解決する
- 日次レポート（#31）は `business_date` で GROUP BY、需要予測（#26）は order_items × menu_items を時系列集計する

## 7. 状態遷移

### 予約（reservations.status）

```
stocked ──(席番入力・配膳へ)──→ seated（orders を生成、orders.reservation_id で紐付け）
stocked ──→ canceled / no_show
```

### 注文（orders.status）

```
open ──(全品目 done_at 記録)──→ completed（completed_at を記録）
open ──(削除ボタン)──→ canceled
completed ──(完了取り消し)──→ open（completed_at を NULL に戻す）
```

## 8. DB に入れないもの（現行 LocalStorage のまま）

| データ | 理由 |
|---|---|
| コンロ番号状態（`kds_konro_v1`） | 厨房内の一時的な作業状態。分析価値なし |
| カード並び順（`kds_order_v1`） | 表示上の都合。端末間で異なってよい |
| タイマーロック（`kds_locked_v1`） | 同上 |
| 権限モード・印刷・音・表示トグル | 端末ごとの設定 |

## 9. 設計上の判断と保留事項

| # | 判断 | 内容 |
|---|---|---|
| 1 | 採用 | `done_at` を order_items に持たせる ＝ 品目完了が DB 書き込みになる。完全オフライン端末からの書き込み経路（ローカル正本＋後同期 or オンライン前提）は**物理設計時の最大論点**として保留 |
| 2 | 採用 | kids は「0〜2歳」1区分のみ（spec 準拠）。年齢区分が増えたら子テーブル化を検討（YAGNI） |
| 3 | 採用 | options は自由記述 1 列。POS のオプションデータ形式が判明したら `order_item_options` 子テーブルへの分離を検討 |
| 4 | 保留 | DB 製品・配置（クラウド / 店内ローカルサーバー / 端末内）は未決定。本書は論理設計のみ |
| 5 | 保留 | 価格（金額）列は全テーブルに置いていない。KDS スコープ（厨房表示）に会計は含まれないため。POS 連携仕様が確定したら再検討 |

## 10. 改訂履歴

| 版 | 日付 | 内容 |
|---|---|---|
| v0.1 | 2026-07-08 | 初版（論理設計） |
