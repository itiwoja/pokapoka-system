# pokapoka-system

沖縄みらいAI＆IT専門学校が土鍋飯ぽかぽか様のオーダーシステムを制作するためのリポジトリ。

> **本リポジトリのスコープは「厨房端末（KDS）画面」のみ**です。客席タブレット・管理画面・予約連携などは対象外です。

## KDS（厨房オーダー表示システム）

`mockup/` に KDS 画面を実装しています。HTML / CSS / JavaScript のみ（フレームワーク・外部CDN不使用）で、オフライン環境のタブレット（Android / iPad）で動作します。

| ファイル | 役割 |
| --- | --- |
| `mockup/index.html` | 画面構造 |
| `mockup/style.css` | ダークテーマのスタイル |
| `mockup/app.js` | 表示・タップ操作・バイブ・多言語・時間計測の連携 |
| `mockup/serve-log.js` | 提供時間の計測ロジック（純粋関数・DOM非依存） |
| `mockup/serve-log.test.js` | `serve-log.js` の単体テスト（依存ゼロ） |

### 動作確認

```sh
# ローカルサーバーで開く（file:// では動作しないブラウザがあるため）
cd mockup
python -m http.server 8000
# → http://127.0.0.1:8000/index.html
```

### テスト実行

```sh
node mockup/serve-log.test.js
```

## 提供時間の自動計測（Issue #29）

注文受付（`start`）から全品目完了までの提供時間を自動記録し、`localStorage`（キー `kds_serve_log`）に追記保存します。PRD の KPI「平均提供時間 MVP前比20%減」の**導入前ベースラインデータ**として用います。

- 全品目をタップ完了した瞬間に完了時刻・提供時間を記録
- 完了を取り消すと該当レコードも取り消し（誤タップ補正）
- ヘッダーの **「📊 提供時間ログ」** ボタンで件数・平均を表示し、CSV をエクスポート

コンソールからの参照用アクセサ:

```js
window.KDS_getServeLog()    // 記録レコード配列
window.KDS_getServeStats()  // 件数・平均・最大・最小・10分超件数
window.KDS_exportServeCSV() // CSV ダウンロード
window.KDS_clearServeLog()  // ログ全消去
```
