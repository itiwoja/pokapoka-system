# 状態管理の棚卸し（localStorage / BroadcastChannel）

作成: 2026-07-30 / 対象: `main` (c13cb83)

## なぜ作ったか

既知のバグ issue が、狙ったように同じ場所へ集中している。

| Issue | 内容 |
|---|---|
| #129 | kds-bridge の由来判定（localStorage の `seen`） |
| #132 | 複数実機で厨房状態が同期されない |
| #133 | 未接続タブの prune が他タブの状態を全消去 |
| #145 | コンロ番号とタイマー番号のロック競合 |
| #172 | 日次パージが `kds_bridge_seen_v1` を残す |
| #178 | 日次パージが暦日ベースで進行中の状態を全消去（0時をまたがない運用のためクローズ） |
| #179 | 提供時間ログが無制限に増え localStorage 上限に達する |

共通しているのは **「localStorage を正本にした状態管理 × 複数タブ/複数端末 × テストなし」**。`kds-a-grid.html` は 3519 行あってテストが 1 行もなく、localStorage キー 12 個を正本に、BroadcastChannel 7 種のメッセージで同期している。

この表は、そのキーごとに「誰が書く / 誰が読む / いつ消える / 同期経路」を一覧にしたもの。新しく状態を足すときや、prune・パージを触るときに参照する。

## 棚卸し表

凡例: **書** = 書き込む契機 / **読** = 読み込む契機 / **消** = 消える契機

| # | キー | 用途 | 書 | 読 | 消 | 同期 |
|---|---|---|---|---|---|---|
| 1 | `kds_done_v2` | 品目完了状態<br>`id -> [doneCount,…]` | 品目タップ / BC受信 / `undoComplete` / `pruneDone` | `init` / **`poll` 毎秒** | 日次パージ ✓<br>`pruneDone(feedIds)` | BC `toggle` |
| 2 | `kds_done_v1` | 旧 bool 配列（#153 移行元） | なし（読み専用） | `loadDone` のフォールバック | 日次パージ ✓ | — |
| 3 | `kds_konro_v1` | コンロ番号占有<br>`cardId -> {num: state}` | コンロタップ / BC受信 / `pruneKonro` | `init` / **`poll` 毎秒** | 日次パージ ✓<br>`pruneKonro(seen)` | BC `konro` |
| 4 | `kds_order_v1` | 配膳カードの並び順 | 並べ替え / BC受信 / `render` | `init` / `poll`（`isReordering` 中は除く） | 日次パージ ✓<br>`render` で消えた id 除去 | BC `order` |
| 5 | `kds_stock_v1` | 予約ストック | 予約操作 / BC受信 / **`kds-bridge.js`（別ファイル）** | **`init` のみ** | 日次パージ ✓<br>`mergeStock` の削除判定 | BC `stock` / `moveToMain` |
| 6 | `kds_locked_v1` | タイマーロック | ロック操作 / BC受信 / `pruneLocked` | `init` / `poll` 毎秒 | 日次パージ ✓<br>`pruneLocked(feedIds)` | BC `timerLock` |
| 7 | `kds_deleted_v1` | 削除済み注文のトゥームストーン (#67) | 削除操作 / BC受信 / `pruneDeleted` | `init` / `poll` 毎秒 | 日次パージ ✓<br>`pruneDeleted()` | BC `deleteOrder` |
| 8 | `kds_day_v1` | 最終利用日 | `purgeStaleDay` | `purgeStaleDay` | — | — |
| 9 | `kds_mode_v1` | 権限モード（kitchen/hall） | モード切替 | `init` | **対象外（設定）** | なし |
| 10 | `kds_view_v1` | 表示モード（grid/lane） | 表示切替 | `init` | **対象外（設定）** | なし |
| 11 | `kds_serve_log_v1` | 提供時間ログ (#29) | 全品目完了ごとに追記 | CSV 出力 / 統計 | **対象外・上限なし** → #179 | なし |
| 12 | `kds_bridge_seen_v1` | 取込済み rid（`kds-bridge.js` が所有） | `mergeStock` の新規取込 | `tickOnce` | **対象外** → #172 | なし |

### 日次パージ（`purgeStaleDay`）の線引き

破棄する 7 個: 1, 2, 3, 4, 5, 6, 7 — いずれも「当日の運用データ」

破棄しない 5 個:

- 8 `kds_day_v1` — パージ自体の判定に使う
- 9, 10 — 端末の設定。日をまたいでも保つのが正しい
- 11 `kds_serve_log_v1` — **意図的に永続**（#29 の KPI ベースライン用）。ただし上限がなく #179 の原因
- 12 `kds_bridge_seen_v1` — **漏れ**。#172

## 見えてくる穴の形

表を眺めると、既知バグがどのマスの問題かがはっきりする。今後も同じ形が出るはず。

### A. ライフサイクルの非対称（#172 / #179）

`kds_stock_v1` は毎日消えるのに `kds_bridge_seen_v1` は永久に残る。両者は「取り込むかどうか」の判定で組になっているのに、消える契機が違う。

**新しいキーを足すときは、この表の「消」列を必ず埋める。** 埋まらないキーは永続する理由を書く。

### B. 「空 = 全部消えた」と「未接続 = まだ知らない」の混同（#133）

`prune*` は 4 つある。

| 関数 | 生存 ID の取得元 | 呼ばれる場所 |
|---|---|---|
| `pruneKonro(liveIds)` | `render()` の `seen` | `render` 内 |
| `pruneDone(feedIds)` | `render()` の `orders` | `render` 内 |
| `pruneLocked(feedIds)` | `render()` の `orders` | `render` 内 |
| `pruneDeleted()` | **`window.KDS_ORDERS` を自分で直接読む** | `poll` の先頭（`getOrders()` より前） |

前 3 つは `getOrders()` を経由するが、`pruneDeleted()` だけ経由しない。**`getOrders()` 側にガードを足す修正では 4 つ目が直らない。** 判定を共通関数へ切り出したい（#133 のコメント参照）。

### C. 暦日と営業日の取り違え（#177 / #178 — 現時点では実害なし）

`purgeStaleDay()`（KDS 側）と `tablecheck-sync.js` の `purge()`（サーバー側）が、どちらも `getFullYear/getMonth/getDate` の暦日で判定している。深夜 0 時をまたぐ営業なら両方が誤動作する。

**確認結果: 店の営業は深夜 0 時をまたがない**（2026-07-30）。`2026-07-16_打合せ質問リスト.md` に持ち越しだった「日付を跨ぐ営業があるか」への回答。暦日と営業日が一致するため現行実装のままで正しく動き、#177 / #178 はクローズした。

ただし**コードは暦日前提のまま**なので、営業時間が 0 時以降へ延びた時点で両方とも再発する。深夜営業・年末年始の特別営業などを検討する際は、先にこの 2 箇所を営業日ベースへ直すこと。

なお #172（`kds_bridge_seen_v1` がパージ対象から漏れている）は 0 時をまたぐかとは無関係で、**引き続き有効**。あちらは「客が予約日を変更すると、変更後の日に KDS へ二度と取り込まれない」という別経路。

### D. 保存失敗が全部無言（#175 / #179）

`save*()` はすべて `try { … } catch (e) {}`。localStorage の quota に達しても、キーが壊れても、**画面上は何も起きない**。メモリ上の状態は正しいので正常に見え、リロードや `poll()` の読み直しで初めて巻き戻る。

`localStorage.setItem` の呼び出しは全 12 箇所あり、すべてこの形。

### E. 読む頻度のばらつき

`poll()` は毎秒 `loadDone` / `loadKonro` / `loadLocked` / `loadOrderSeq` / `loadDeleted` を実行して LS を読み直す（BroadcastChannel 非対応時のフォールバック同期）。

一方 **`kds_stock_v1` だけは `init()` でしか読まない。** 予約ストックの更新は BC `stock` メッセージに依存している。`kds-bridge.js` は BC へ post しているので通常は届くが、この 1 つだけ経路が違うことは意識しておきたい。

## 使い方

- **状態を足すとき** — 表に行を足し、「消」列を必ず埋める
- **prune を足すとき** — B の表に足し、生存 ID の取得元が `getOrders()` 経由かを確認する
- **日付を扱うとき** — 暦日でよいか、営業日であるべきかを C に照らす
- **保存を足すとき** — D の空 catch を踏襲しない

---

Refs #129 / #132 / #133 / #145 / #172 / #175 / #177 / #178 / #179

🤖 Generated with [Claude Code](https://claude.com/claude-code)
