# pokapoka-system

沖縄みらいAI＆IT専門学校が土鍋飯ぽかぽか様のオーダーシステムを制作するためのリポジトリ。

> **本リポジトリのスコープは「厨房端末（KDS）画面」のみ**です。客席タブレット・管理画面・予約連携などは対象外です。

## KDS（厨房オーダー表示システム）

**`kds-a-grid.html`** が本線の KDS 画面です。HTML / CSS / JavaScript のみの**単一ファイルで自己完結**（フレームワーク・外部CDN不使用）し、オフライン環境のタブレット（Android / iPad）で動作します。ニューブルータリズム和のデザインで、カードグリッド＋予約ストックの2ペイン構成。

主な機能: 品目タップ完了・全完了カードの自動消去、コンロ番号（1〜10）、タイマーロック、予約ストック→進行中への配膳移動、キッチン/ホール権限モード、自動印刷、経過時間による色アラート、LocalStorage + BroadcastChannel による2タブ同期。

### 動作確認

```sh
# ローカルサーバーで開く（file:// では動作しないブラウザがあるため）
python -m http.server 8000
# → http://127.0.0.1:8000/kds-a-grid.html
```

`window.KDS_ORDERS` に注文データ（`{id, table, type, start, people, items:[{name, qty, options, done}]}`）を投入すると表示されます。空の場合は「デモデータを投入」ボタンでサンプルを表示できます。

## 提供時間の自動計測（Issue #29）

注文受付（`start`）から**全品目完了までの提供時間を自動記録**し、LocalStorage（キー `kds_serve_log_v1`）へ追記保存します。PRD の KPI「平均提供時間 MVP前比20%減」の**導入前ベースラインデータ**として用います（#31 日次レポート・#26 需要予測の前提データにもなります）。

- 全品目をタップ完了した瞬間に、完了時刻・提供時間（`serveMs`）を記録
- `orderId` で重複ガード（2タブ同期・再完了での二重計上を防止）
- ヘッダーの **「📊 提供時間ログ」** ボタンで件数・平均をトースト表示し、CSV をエクスポート

計測ロジックは `kds-a-grid.html` にインライン実装（単一HTML要件のため）していますが、同一ロジックを `serve-log.js` に切り出して Node テストで検証しています。

```sh
node serve-log.test.js
```

コンソールからの参照用アクセサ:

```js
window.KDS_getServeLog()    // 記録レコード配列
window.KDS_getServeStats()  // 件数・平均・最大・最小・10分超件数
window.KDS_exportServeCSV() // CSV ダウンロード
window.KDS_clearServeLog()  // ログ全消去
```

> **注**: `serve-log.js` は Node テスト用の参照実装です。`kds-a-grid.html` 内のインライン版とロジックは同一なので、片方を変更したら両方（と `serve-log.test.js`）を同期してください。
