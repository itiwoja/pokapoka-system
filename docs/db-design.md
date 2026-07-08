# DB 論理設計書 v0.2

> **ステータス**: 論理設計（DB 製品・DDL は未確定。配置は 2026-06-18 議事録の店内ミニPCサーバ構成を前提）。
> **目的**: (1) 客席タブレット（注文端末）からの注文データの受け皿、(2) 予約・メニュー・座席のマスタ管理。
> **出典**: 2026-06-03「予約席・座席DB設計判断」（座席・予約枠テーブルのドラフト）を正として統合。2026-06-04 / 2026-06-18 議事録の確定事項に準拠。

## 1. 背景と現状

### 1.1 システム全体像（Phase 1 = 3系統）

| 系統 | 利用者 | 役割 |
|---|---|---|
| 客席タブレット（注文端末） | お客様 | 注文入力。**フリーアドレス運用**（席固定なし）。卓番号はスタッフが手渡し時に入力 |
| デシャップ（KDS） | 厨房 | オーダー表示・品目完了。**本リポジトリのスコープ** |
| 座席管理GUI | ホール | 席ロック・空き状況・予約の卓割当・席の付け替え |

POS 連携は**行わない**。売上・会計は別のレジで管理する（2026-06-18 議事録）。

### 1.2 KDS の現状データ

現在の KDS（`kds-a-grid.html`）は永続DBを持たず、以下で構成される。

| データ | 現在の置き場 | 中身 |
|---|---|---|
| 注文 | `window.KDS_ORDERS`（メモリ） | `{id, table, type, start, people, items:[{name, qty, options, done}]}` |
| 品目完了状態 | LocalStorage `kds_done_v1` | orderId → bool 配列 |
| 予約ストック | LocalStorage `kds_stock_v1` | `[{rid, time, adults, kids, name, menu:[{name,qty}], seenAt}]`（当日分のみ） |
| 提供時間ログ | LocalStorage `kds_serve_log_v1` | KPI ベースライン（Issue #29） |
| メニュー分類 | コード内 `itemCategory()` | 品名の正規表現でカテゴリ判定（Issue #13 レーン表示） |

### 1.3 本設計で解決すること

- 注文端末 → KDS 間で注文データを受け渡す正規化された保存先が無い
- メニュー・分類がコードに埋まっており、メニュー改定（常時8品＋うなぎ2種＋季節スポット枠）のたびにコード修正が必要
- 座席DB設計判断（2026-06-03）で確定した「遅延割当モデル」「席ロック」「炊飯先行着手」を保持するデータ構造が未実装
- LocalStorage は消失リスクがあり、日次レポート（#31）・需要予測（#26）の基盤にならない

## 2. 設計方針

1. **注文受け皿＝「外部ID＋スナップショット」パターン**
   注文端末側の注文IDを `external_id` として冪等に取り込み、品名等は注文時点の文字列をそのまま保存する（マスタ変更の影響を受けない）。マスタとの紐付けは nullable FK とし「照合できたら紐付く」設計にする。予約もテーブルチェック API 取り込み（可否確認中、不可なら手動入力）に備えて同じ形にする。
2. **遅延割当モデルの採用（2026-06-03 B項・確定）**
   予約時は「席タイプ×個数の枠」のみ確保し、**物理卓番号は来店時にホールが割当てる**（それまで null）。予約ストックカードの「卓: —」表示を許容する。
3. **端末ID ↔ 席の対応は持たない（2026-06-03 A項・確定）**
   客席タブレットはフリーアドレスのため、卓番号は手渡し時にスタッフが端末へ入力する。座席DBに端末IDは登場しない。
4. **マスタとトランザクションの分離**
   メニュー・カテゴリ・座席・席タイプをマスタに昇格。マスタは注文端末（メニュー表示）と KDS（レーン分類）の共通正本になる。
5. **KDS の操作状態は DB に入れない**
   コンロ番号・カード並び順・タイマーロック・各トグルは端末ローカルの一時状態であり、現行の LocalStorage + BroadcastChannel のまま。
6. **bool ではなく時刻で記録する**
   `done` フラグは `done_at`（時刻）として持ち、完了の事実がそのまま分析データになる形にする。

### データ保持ポリシー（2026-06-18 議事録との整合）

6/18 議事録の確定事項「**注文履歴はサーバに保存しない・当日分の表示で十分**」を尊重し、次の2層で扱う。

| 層 | 保持 | 対象 |
|---|---|---|
| マスタ | 永続 | menu_* / seat_types / tables |
| トランザクション | **当日分のみ**（営業日終了時にパージ可） | reservations / orders / 各 items |

日次レポート（#31）・需要予測（#26）を本格運用する場合は「明細はパージし日次集計値のみ残す」等の保持延長が必要になる。これは**保持ポリシーの変更だけで対応でき、テーブル設計は変えない**（§9 保留事項）。

## 3. ER 概観

```
menu_categories 1──n menu_items
menu_items      1──n menu_item_options（menu_item_id NULL = 全品共通）

seat_types 1──n tables
seat_types 1──n reservation_slots

reservations 1──n reservation_slots（予約時に確保する枠）
reservations 1──n reservation_items ──(n..1 任意)── menu_items
reservations 1──1 tables.current_reservation_id（来店時の卓割当・可動）
reservations 1──n orders（炊飯先行着手で注文化）

tables 1──n orders（卓割当後）
orders 1──n order_items ──(n..1 任意)── menu_items
```

## 4. マスタ（5テーブル）

### 4.1 menu_categories — レーン分類の正本

現行 `itemCategory()` の正規表現判定を置き換える。

| 列 | 型 | 制約 | 備考 |
|---|---|---|---|
| id | PK | | |
| code | text | UNIQUE, NOT NULL | `rice` / `side` / `drink` |
| name | text | NOT NULL | ご飯類・サイド・ドリンク |
| display_order | int | NOT NULL | レーン表示順 |

### 4.2 menu_items — メニュー正本（注文端末と共有）

注文端末のメニュー表示と KDS のレーン分類の共通正本。常時8品＋うなぎ2種＋季節スポット枠（6/18 議事録）の改定をコード修正なしで行えるようにする。

| 列 | 型 | 制約 | 備考 |
|---|---|---|---|
| id | PK | | |
| category_id | FK → menu_categories | NOT NULL | |
| name | text | NOT NULL | 例: 山城牛の焼きすき土鍋御膳 |
| short_name | text | NULL可 | 略称（KDS 表示用。deshup-spec 記載） |
| item_code | text | NULL可, UNIQUE | 注文端末との照合キー |
| is_active | bool | NOT NULL, default true | 販売終了・季節メニュー入替は削除せず無効化 |
| display_order | int | NOT NULL | 注文端末・予約フォームの並び順 |

### 4.3 menu_item_options — 定型オプション

大盛り・肉増し・ロック等、注文端末・予約フォームで選択肢として出す定型オプション。

| 列 | 型 | 制約 | 備考 |
|---|---|---|---|
| id | PK | | |
| menu_item_id | FK → menu_items | NULL可 | NULL = 全品共通オプション |
| name | text | NOT NULL | |

### 4.4 seat_types — 席タイプ

遅延割当モデルの「枠」の単位。席構成: カウンター8 / 2名席3卓 / 4名席3卓（要件定義（仮）座席マスタ）。

| 列 | 型 | 制約 | 備考 |
|---|---|---|---|
| code | PK (text) | | `counter` / `table2` / `table4` |
| name | text | NOT NULL | カウンター・2名席・4名席 |
| capacity | int | NOT NULL | 1 / 2 / 4 |

### 4.5 tables — 座席（物理席の定義＋現在状態）

2026-06-03 ドラフト「座席テーブル」を継承。端末IDは持たない（A項）。

| 列 | 型 | 制約 | 備考 |
|---|---|---|---|
| id | PK | | |
| label | text | UNIQUE, NOT NULL | 卓番号（A4 等）。画面表示ラベル兼用 |
| seat_type_code | FK → seat_types | NOT NULL | |
| is_active | bool | NOT NULL, default true | |
| status | text | NOT NULL, default `empty` | `empty`(空き) / `reserved`(予約ロック中) / `occupied`(着席中) |
| current_reservation_id | FK → reservations | NULL可 | この席に割当てた予約。null＝空き。**来店時に書き込み・更新可能**（席の付け替え＝C項） |
| locked_at | datetime | NULL可 | 予約ロックの開始時刻 |

- 「予約席の移動」（C項・可動ロック）は ①移動元を `empty` に戻す ②移動先を `reserved`/`occupied` にする、を**1トランザクション**で行う。
- status / current_reservation_id / locked_at は現在状態（ホール座席GUIが操作主体）。マスタ定義列（label / seat_type_code / is_active）と同居させるのは 2026-06-03 ドラフト踏襲の実用判断。

## 5. トランザクション（5テーブル）

### 5.1 reservations — 予約（現 LocalStorage `kds_stock_v1` を置換）

2026-06-03 ドラフト「予約枠テーブル」を継承。

| 列 | 型 | 制約 | 備考 |
|---|---|---|---|
| id | PK | | |
| external_id | text | NULL可, UNIQUE | テーブルチェック API 取り込み時の照合キー（連携不可なら常に null） |
| source | text | NOT NULL | `manual` / `tablecheck` |
| customer_name | text | NOT NULL | 来店時の特定に使う（A案: 一覧から選ぶ） |
| expected_at | datetime | NOT NULL | 来店予定時刻。炊飯先行着手（E項）の起点 |
| adults | int | NOT NULL | 「大人1名1膳必須」バリデーションに使う |
| kids | int | NOT NULL, default 0 | 0〜2歳内訳 |
| status | text | NOT NULL | `booked`(枠確保) / `seated`(着席=卓確定) / `done`(完了) / `no_show` / `canceled` |
| assigned_table_id | FK → tables | NULL可 | **予約時は null → 来店時にホールが入力**（遅延割当）。更新可能（席の付け替え） |
| seated_at | datetime | NULL可 | 来店・卓確定時刻 |
| rice_lead_time_min | int | NOT NULL, default 30 | 炊飯リードタイム。`expected_at − rice_lead_time_min` が炊き始め推奨時刻 |
| cook_prompted_at | datetime | NULL可 | 「そろそろ炊く」プロンプト（30分前通知）の発火記録（再通知防止） |

- **事前メニュー有無は `reservation_items` の有無で表現する**（フラグ列は持たない）。メニュー有り予約のみ KDS 予約ストックに表示（C-2項。現行モックの `r.items.length > 0` フィルタと同じ）。席だけの予約は席ロックのみで KDS には出さない。
- 来店時: ホール座席GUIで予約を選び卓番号入力 → `assigned_table_id` を埋め `status=seated`、tables 側を `occupied` + `current_reservation_id` セット。**この瞬間に予約⇔卓が一致**（オーナー要望）。

### 5.2 reservation_slots — 予約時に確保する席枠

「席タイプ×個数」の枠（例: `table4 × 1`）。物理卓番号ではない。大人数（例: 6名 = table4×1 + table2×1）に備え子テーブルにする。

| 列 | 型 | 制約 | 備考 |
|---|---|---|---|
| id | PK | | |
| reservation_id | FK → reservations | NOT NULL | |
| seat_type_code | FK → seat_types | NOT NULL | |
| count | int | NOT NULL | |

制約: `UNIQUE (reservation_id, seat_type_code)`

### 5.3 reservation_items — 事前メニュー

| 列 | 型 | 制約 | 備考 |
|---|---|---|---|
| id | PK | | |
| reservation_id | FK → reservations | NOT NULL | |
| menu_item_id | FK → menu_items | NULL可 | マスタ照合できたら紐付け |
| item_name | text | NOT NULL | スナップショット |
| qty | int | NOT NULL | |

### 5.4 orders — 注文（現 `window.KDS_ORDERS`）

発生源は (a) 客席タブレットの注文、(b) 予約の炊飯先行着手（着手ボタンでストック→進行中）、(c) KDS/ホールでの手動入力。

| 列 | 型 | 制約 | 備考 |
|---|---|---|---|
| id | PK | | |
| external_id | text | NULL可, UNIQUE | **注文端末側の注文ID（冪等取込の要）** |
| source | text | NOT NULL | `tablet` / `reservation` / `manual` / `demo` |
| business_date | date | NOT NULL | 営業日（当日分パージ・集計のキー） |
| table_id | FK → tables | NULL可 | |
| table_label | text | **NULL可** | スナップショット。**予約由来の先行着手では来店前のため null（「卓: —」表示）**、来店時の卓割当で埋める |
| type | text | NOT NULL | `new` / `reserved`（カード色の正本） |
| reservation_id | FK → reservations | NULL可 | 予約→進行中移動の由来リンク |
| adults | int | NULL可 | 内訳（無ければ null、合計のみ） |
| kids | int | NULL可 | 同上 |
| people | int | NOT NULL | 合計人数 |
| received_at | datetime | NOT NULL | 現 `start`（着手時刻） |
| completed_at | datetime | NULL可 | 全品目 done 時刻 |
| status | text | NOT NULL | `open` / `completed` / `canceled` |

- 客席タブレットはフリーアドレスだが、スタッフが手渡し時に卓番号を入力するため、タブレット由来の注文は卓番号付きで届く（A項）。
- 同一卓の追加注文は**別の orders 行**になる（注文単位＝KDSカード単位）。

### 5.5 order_items — 注文品目（現 `items[]` + `kds_done_v1`）

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
- 当日分パージ運用の場合、KPI 継続記録には「パージ前に日次集計値を書き出す」保持ポリシーが必要（§2 / §9）

## 7. 状態遷移

### 予約（reservations.status）× 座席（tables.status）

```
予約成立            : reservations INSERT (status=booked, assigned_table_id=null)
                      reservation_slots INSERT（席タイプ×個数の枠確保）
                      ※物理卓は触らない（遅延割当）

炊き始め推奨時刻超過 : expected_at − rice_lead_time_min を過ぎたら
                      「そろそろ炊く」プロンプト表示（cook_prompted_at 記録）
                      ※自動では進行中に乗せない（方式C・確定）

着手ボタン（厨房前） : orders INSERT (source=reservation, type=reserved,
                      table_label=null ← 卓未定「卓: —」)
                      ※事前メニュー有り予約のみ。予約 status は booked のまま

来店・卓割当        : ホール座席GUIで予約を選択 → 卓番号入力（A案・1トランザクション）
                      reservations.assigned_table_id = 卓, status=seated, seated_at 記録
                      tables.status=occupied, current_reservation_id=予約ID
                      orders.table_id / table_label を同じ卓で更新（予約⇔卓が一致）

席の付け替え（C項）  : 移動元 tables を empty に戻し、移動先を reserved/occupied に
                      （1トランザクション。ロックは可動）

booked → canceled / no_show（キャンセル・不来店）
seated → done（食事完了・退店。tables を empty に戻す）
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
| 端末ID ↔ 席の対応 | フリーアドレス運用のため成立しない（2026-06-03 A項・確定） |

## 9. 設計上の判断と保留事項

| # | 判断 | 内容 |
|---|---|---|
| 1 | 採用 | 遅延割当モデル（2026-06-03 B項）: 予約時は reservation_slots で枠のみ確保、物理卓は来店時に確定。orders.table_label も null 許容 |
| 2 | 採用 | 事前メニュー有無はフラグでなく reservation_items の有無で表現（C-2項・現行モック挙動と一致） |
| 3 | 採用 | `done_at` を order_items に持たせる ＝ 品目完了が DB 書き込みになる。店内 LAN（ミニPCサーバ + Wi-Fi）での通信断時は「直前の表示を一時保持」（6/18 議事録）で足りるが、書き込みリトライの設計は物理設計で詰める |
| 4 | 採用 | kids は「0〜2歳」1区分のみ（spec 準拠）。区分が増えたら子テーブル化を検討（YAGNI） |
| 5 | 採用 | options は自由記述 1 列。注文端末側のオプションデータ形式が確定したら `order_item_options` 子テーブルへの分離を検討 |
| 6 | 保留 | データ保持: 6/18 決定は「当日分のみ」。#31 日次レポート・#26 需要予測を本格運用する場合、「明細パージ＋日次集計のみ保持」等への変更が必要（テーブル設計は不変） |
| 7 | 保留 | menu_items の価格・写真列: 注文端末のメニュー表示（Instagram/EC風・料理写真）には必要になるが、注文端末側の設計時に追加する。KDS スコープでは不要 |
| 8 | 保留 | テーブルチェック API 連携の可否・データ形式（6/19 打合せで確認予定だった件）。不可なら reservations.source は `manual` のみで運用 |
| 9 | 保留 | DB 製品・DDL・同期方式。配置は店内ミニPCサーバ（LAN 接続、タブレットは Wi-Fi 経由）を前提とする（6/18 議事録） |

## 10. 改訂履歴

| 版 | 日付 | 内容 |
|---|---|---|
| v0.1 | 2026-07-08 | 初版（論理設計） |
| v0.2 | 2026-07-08 | POS 前提を撤回し客席タブレット（注文端末）連携へ修正。2026-06-03「予約席・座席DB設計判断」の座席・予約枠テーブルを統合（seat_types / tables 現在状態 / reservation_slots / 遅延割当 / 炊飯先行着手）。データ保持を 6/18 決定（当日分のみ）と整合 |
