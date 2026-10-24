# データ設計書 v0.6

> **現行構成（2026-10-22 確認）**: 中継サーバーは**予約を SQLite に保存**する。注文はメモリで扱いつつ、再起動に備えて当日分の控えだけを SQLite に残す（保持時間を過ぎたら削除し、履歴は持たない）。厨房状態・座席占有はメモリで扱う。予約ファイルのバックアップが必要。別チームの注文サーバーは注文を PostgreSQL に保存する。→ **§1**
> **将来構想（未採用）**: 開発中に出た「注文履歴を保存して分析できるようにする」案に備え、永続DBの論理設計を **§2 以降**に保留する。正式採用された場合のみ実装する。
> **出典**: [中継サーバーの現行実装・運用](../relay-server/README.md)、[注文サーバー接続](注文端末_注文サーバー接続.md)、[2026-10-21 予約取込の決定](../knowledge/2026-10-21_決定_予約のCSV取込と変更の反映.md)。6月の非保存方針は予約保存の導入前の経緯であり、現行構成と区別する。§2以降の座席・履歴分析の論理設計は引き続き未採用。

## 1. 現行構成：予約保存と中継注文の一時保持

### 1.1 現行構成と担当範囲

| 系統 | 利用者 | 役割 |
|---|---|---|
| 客席タブレット・注文サーバー | お客様／別チーム | 注文入力・商品マスター・PostgreSQL保存。`order-terminal/`で参照 |
| デシャップ（KDS） | 厨房・ホール | オーダー表示・調理／提供確認。**本リポジトリの対象** |
| 中継サーバー・予約入力画面 | 店員 | 予約保存・取込、注文配信、厨房状態・座席占有の共有。**本リポジトリの対象** |
| 座席管理GUI・席枠DB | ホール（当初構想） | §2以降の論理設計。現行の座席占有API・卓番選択を、席マップや席枠管理の実装完了とは扱わない |

POS 連携は**行わない**。売上・会計は別のレジで管理する（2026-06-18 議事録）。

### 1.2 保存範囲と経緯

- 2026-06-18 の非保存方針から変更し、予約は `relay-server/reservation-store.js` が SQLite へ保存する。再起動しても残り、当日ストックの読み出し時に過去日を削除する。
- 2026-10-11 に中止したのは TableCheck **API** 連携。2026-10-21 に CSV を主な入口とする方針が決まり、現在は `/reservations` に手入力・CSV／Excel・貼り付け・メールの試作がある。TableCheck は元の予約を引き続き管理する。
- 中継サーバーの注文はメモリで扱い、再起動で当日の注文が KDS から消えないよう当日分の控えを SQLite（`data/orders.sqlite`、`relay-server/order-store.js`）に残して起動時に読み戻す（2026-10-17）。保持時間（`order.ttlMin`、既定720分）を過ぎた分は削除し、履歴にはしない。厨房状態・ローカル座席占有はメモリのみ。注文サーバー（`order-terminal/order-system`）の PostgreSQL 保存とは別の層である。
- 予約のバックアップは必要。RAID・UPS の要否は運用・故障対策として別判断であり、「何も保存しないから一律不要」という根拠は使わない。

### 1.3 データ配置

KDS（`kds-a-grid.html`）はブラウザ内の表示状態を保持する。予約の店内保存先は中継サーバーの SQLite、実注文の保存先は別チームの注文サーバーの PostgreSQL であり、中継サーバーの注文フィードと混同しない。

| データ | 正本／置き場 | 保持期間 | 備考 |
|---|---|---|---|
| 予約（メニュー・人数等） | 中継サーバー（ミニPC）**SQLite** `data/reservations.sqlite` | 当日以降（`/api/stock` 取得時に過去日を削除） | `/reservations` から登録・取込。故障に備えて別媒体へバックアップする |
| 実注文 | 別チームの注文サーバー PostgreSQL | 注文サーバーの運用による | 保存成功後に relay へ転送。詳細は [注文サーバー接続](注文端末_注文サーバー接続.md) |
| 中継注文フィード | relay のメモリ＋当日分の控え（SQLite `data/orders.sqlite`）→ KDS `window.KDS_ORDERS` | TTL既定720分（過ぎた分は控えからも削除）。再起動後は控えから読み戻す | `{id, table, type, start, people, items:[{name, qty, options, allergies, done}]}` |
| 品目完了状態 | KDS `LocalStorage` `kds_done_v2` | 端末ローカル | 一時的な表示状態。orderId → doneCount(完了個数) 配列（#153） |
| 予約ストック | KDS `LocalStorage` `kds_stock_v1` | 端末ローカル・当日分のみ | `[{rid, time, adults, seniors, children, kids, name, menu:[{name,qty}], allergies?, request?, memo?, seenAt}]` |
| 提供時間ログ | KDS `LocalStorage` `kds_serve_log_v1` | 直近14日分・最大3000件 | KPI ベースライン（Issue #29）。長期保存はCSVへ退避 |
| 監査ログ | `config/audit-log.jsonl` | 既定30日・最大3000件 | 操作メタデータのみ。[監査ログ仕様](audit-log-spec.md) |
| 印刷設定 | `config/printer-ip.json` / `config/slip-style.json` | ファイル保存 | プリンターIP・伝票レイアウト。Git管理外 |
| メニュー分類 | コード内 `itemCategory()` | — | マスタDBは持たない。品名の正規表現でカテゴリ判定（Issue #13） |

- 中継サーバーは予約を SQLite に保存し、当日の `booked` かつメニューありの予約を `/api/stock` に配信する。ブラウザのストックが消えてもサーバー予約は再取得できる。KDS の「＋追加」で入れた予約も `POST /api/reservations` で保存する（#292。保存に失敗したものだけ端末ローカルに残る）。
- LocalStorage / BroadcastChannel は同一originのブラウザ内で共有する。別端末の厨房状態（コンロ・完了数・ロック・並び順・削除）は relay の `/api/kitchen-state` 経由で同期する。前菜・デザート提供確認等は別端末同期の対象外。
- 通信断時は直前の表示を保持（2026-06-18 方針。relay-server のマージ規則で担保）。

### 1.4 中継サーバーで持たないものと将来構想

relayは注文履歴を永続保持せず、以下の履歴分析機能は未実装である。別チームのPostgreSQLへの注文保存や、KDSの短期提供時間ログがあることと、店舗横断・長期分析の機能が完成していることは別。分析を採用する場合に、既存注文サーバーのデータ活用か§2の将来設計かを決める。

- 日次レポート（Issue #31）・需要予測（Issue #26）などの**履歴分析**。
- 過去の注文・提供時間の**蓄積**と横断集計。

> 開発中に「注文履歴を保存して分析できるようにしたい」という構想が出ている（2026-07）。これは現行スコープ外だが、採用に備えて §2 以降に論理設計を残す。

---

# 【将来構想・未採用】注文履歴を保存して分析する場合のDB設計

> **ここから下は現行では採用しない。** 「注文履歴を保存・分析する」構想が正式採用された場合の論理設計として保留する。採用時は店内サーバーに永続DBとバックアップの仕組みを追加する（＝将来、売上集計や注文履歴の保存が必要になった場合に別途組み込む）。
> DB製品・DDL は未確定。配置は 2026-06-18 議事録の店内ミニPCサーバ構成を前提。この設計は (1) 客席タブレット（注文端末）からの注文データの受け皿、(2) 予約・メニュー・座席のマスタ管理、を対象とする。

## 2. 設計方針

1. **注文受け皿＝「外部ID＋スナップショット」パターン**
   注文端末側の注文IDを `external_id` として冪等に取り込み、品名等は注文時点の文字列をそのまま保存する（マスタ変更の影響を受けない）。マスタとの紐付けは nullable FK とし「照合できたら紐付く」設計にする。予約も同じ形にする（テーブルチェック API 取り込みは2026-10-11に中止・§9）。
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

### データ保持ポリシー（この将来DBを採用した場合）

この将来DBを採用する場合でも、2026-06-18 議事録の「**注文履歴はサーバに保存しない・当日分の表示で十分**」を出発点とし、次の2層で扱う。分析用途で履歴を残すには保持ポリシーを別途拡張する（本節末）。

| 層 | 保持 | 対象 |
|---|---|---|
| マスタ | 永続 | menu_* / seat_types / tables |
| トランザクション | **当日分のみ**（営業日終了時にパージ可） | reservations / orders / 各 items |

日次レポート（#31）・需要予測（#26）を本格運用する（＝注文履歴を保存して分析する構想の本体）場合は「明細はパージし日次集計値のみ残す」等の保持延長が必要になる。これは**保持ポリシーの変更だけで対応でき、テーブル設計は変えない**（§9 保留事項）。

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
| external_id | text | NULL可, UNIQUE | テーブルチェック API 取り込み時の照合キー（手動入力予約なら null） |
| source | text | NOT NULL | `manual` / `tablecheck` |
| customer_name | text | NOT NULL | 来店時の特定に使う（A案: 一覧から選ぶ） |
| expected_at | datetime | NOT NULL | 来店予定時刻。炊飯先行着手（E項）の起点 |
| adults | int | NOT NULL | 「大人1名1膳必須」バリデーションに使う |
| seniors | int | NOT NULL, default 0 | シニア内訳（TableCheck の「人数:シニア」。2026-10-22 追加） |
| children | int | NOT NULL, default 0 | 子供内訳（幼児より上。TableCheck の「人数:子供」。2026-10-22 追加） |
| kids | int | NOT NULL, default 0 | 幼児（0〜2歳）内訳 |
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
| options_text | text | NULL可 | 定型オプション・備考 |
| allergies_text | text | NULL可 | アレルギー情報。着手（orders 生成）時に order_items へ引き継ぐ |

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
| seniors | int | NULL可 | 同上 |
| children | int | NULL可 | 同上 |
| kids | int | NULL可 | 同上（幼児 0〜2歳） |
| people | int | NOT NULL | 合計人数（大人＋シニア＋子供＋幼児） |
| received_at | datetime | NOT NULL | 現 `start`（着手時刻） |
| completed_at | datetime | NULL可 | 全品目 done 時刻 |
| status | text | NOT NULL | `open` / `completed` / `canceled` |

- 客席タブレットはフリーアドレスだが、スタッフが手渡し時に卓番号を入力するため、タブレット由来の注文は卓番号付きで届く（A項）。
- 同一卓の追加注文は**別の orders 行**になる（注文単位＝KDSカード単位）。

### 5.5 order_items — 注文品目（現 `items[]` + `kds_done_v2`）

| 列 | 型 | 制約 | 備考 |
|---|---|---|---|
| id | PK | | |
| order_id | FK → orders | NOT NULL | |
| line_no | int | NOT NULL | 品目順（現行 doneMap の index 依存を排除） |
| menu_item_id | FK → menu_items | NULL可 | 照合できたら紐付け（レーン用カテゴリはここ経由で引く） |
| item_name | text | NOT NULL | スナップショット |
| qty | int | NOT NULL | |
| options_text | text | NULL可 | 定型オプション・備考の自由記述 |
| allergies_text | text | NULL可 | **アレルギー情報（options と分離）**。KDS は品目直下に「アレルギー: …」として常時表示 |
| done_at | datetime | NULL可 | NULL = 未完了。再タップ取消は NULL へ戻す |

制約: `UNIQUE (order_id, line_no)`

### 5.6 注文端末の送信項目とテーブルの対応

注文端末側の入力順は「**卓番（最初に入力）→ 予約 or 新規 → メニュー選択（スライド式・画像タップ）→ 数量（＋/−）→ オプション（アレルギーあり/なし）**」。デシャップ行き必須項目とテーブル列の対応は以下（deshup-spec.md「注文端末→デシャップ送信項目」と対応）。

| 送信項目 | 格納先 | 備考 |
|---|---|---|
| 卓番 | orders.table_label（照合できれば table_id も） | スタッフが手渡し時に入力した値 |
| 予約 or 新規 | orders.type | `reserved` / `new`。カード色の正本 |
| 注文したメニュー名 | order_items.item_name | スナップショット。item_code が来れば menu_item_id も照合 |
| 数量 | order_items.qty | |
| オプション内容 | order_items.options_text | |
| アレルギー情報 | order_items.allergies_text | 端末側キーの表記ゆれ（`allergies` / `allergy` / `allergyInfo`・配列）は**取込時に正規化**して1列に収める |

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

この節の「採用」は**未採用の将来論理設計の中で選んだ案**を指し、現行システムへの実装済みを意味しない。実装済みの人数4区分等はその旨を個別に注記する。

| # | 判断 | 内容 |
|---|---|---|
| 1 | 採用 | 遅延割当モデル（2026-06-03 B項）: 予約時は reservation_slots で枠のみ確保、物理卓は来店時に確定。orders.table_label も null 許容 |
| 2 | 採用 | 事前メニュー有無はフラグでなく reservation_items の有無で表現（C-2項・現行モック挙動と一致） |
| 3 | 採用 | `done_at` を order_items に持たせる ＝ 品目完了が DB 書き込みになる。店内 LAN（ミニPCサーバ + Wi-Fi）での通信断時は「直前の表示を一時保持」（6/18 議事録）で足りるが、書き込みリトライの設計は物理設計で詰める |
| 4 | 採用 | 人数は 大人(adults)・シニア(seniors)・子供(children)・幼児(kids、0〜2歳) の4区分を**まとめずに**持ち、合計は表示時に足す。当初は kids（0〜2歳）1区分のみだったが、2026-10-22 に受け取った TableCheck の予約一覧がこの4区分だったため、ユーザーの指示で列を足した（実装は relay-server/reservation-store.js。既存ファイルには開いたときに列を足し、それまで「子供」として kids に入っていた値を1回だけ children へ移す）。区分・合計・内訳表示は relay-server/party-size.js に1か所でまとめ、KDS・予約入力画面・中継サーバーで共有する。さらに区分が増えたら子テーブル化を検討 |
| 5 | 採用 | options とアレルギーは**別列**（options_text / allergies_text）。アレルギーは安全に関わる情報のため options に混ぜない。定型オプションの形式が確定したら `order_item_options` 子テーブルへの分離を検討 |
| 6 | 前提 | **§2以降の本DBは「注文履歴を保存して分析する」未採用の論理設計**（→ §1.4）。現行の予約 SQLite・注文サーバー PostgreSQL とは別物。採用時の基本保持は当日分で、履歴分析には「明細パージ＋日次集計のみ保持」等の保持ポリシー拡張が必要 |
| 7 | 保留 | menu_items の価格・写真列: 注文端末のメニュー表示（Instagram/EC風・料理写真）には必要になるが、注文端末側の設計時に追加する。KDS スコープでは不要 |
| 8 | API中止・ファイル取込採用 | テーブルチェック API 連携は **2026-10-11 に中止**。2026-10-21 に CSV 取込を主な入口に決定。現行 SQLite の reservations に `source` 列はなく、本将来設計の `source` の値は採用時に決める |
| 9 | 保留 | DB 製品・DDL・同期方式。配置は店内ミニPCサーバ（LAN 接続、タブレットは Wi-Fi 経由）を前提とする（6/18 議事録） |

## 10. 改訂履歴

| 版 | 日付 | 内容 |
|---|---|---|
| v0.1 | 2026-07-08 | 初版（論理設計） |
| v0.2 | 2026-07-08 | POS 前提を撤回し客席タブレット（注文端末）連携へ修正。2026-06-03「予約席・座席DB設計判断」の座席・予約枠テーブルを統合（seat_types / tables 現在状態 / reservation_slots / 遅延割当 / 炊飯先行着手）。データ保持を 6/18 決定（当日分のみ）と整合 |
| v0.3 | 2026-07-08 | codex/db-design ブランチの「注文端末→デシャップ送信項目」設計を統合。アレルギー情報を options から分離（order_items / reservation_items に allergies_text 追加）、送信項目↔テーブル対応表（§5.6）を追加。統合完了に伴い codex/db-design ブランチは削除 |
| v0.4 | 2026-07-16 | **現行方針を「何も保存しない（当日メモリのみ・使い捨て）」に確定（のち2026-10に予約の保存・注文の当日分の控えを追加。冒頭参照）**（打合せ確定・2026-06-18 議事録と整合）。永続DB設計（旧 §1〜§9）は「注文履歴を保存して分析する将来構想」向けの保留設計として §2 以降に位置づけ直し、現行方針を §1 に新設。§9#8 の TableCheck 連携可否を「可能と確定（2026-07-15 裏どり）」へ更新 |
| v0.5 | 2026-10-11 | TableCheck API連携の中止を反映（§1.2・§1.3・§9#8）。予約は店員の手入力で扱う方針 |
| v0.6 | 2026-10-22 | §1を現行の予約SQLite保存・注文の当日分の控え（2026-10-17）・注文サーバーとrelayの保存範囲・人数4区分・バックアップ方針に整合。将来論理設計と現行スキーマを分離 |
