# kds-app（デシャップ画面 React 版）

厨房スタッフ向けのデシャップ画面を React + Vite で作る。ビルドするとリポジトリ直下の `kds-next.html`（外部参照のない1ファイル）になり、中継サーバーが `/kds-next` で配信する。現行の `/kds` は受け入れまで残す。仕様は [`docs/deshup-spec.md`](../docs/deshup-spec.md) の「React 版（/kds-next）」を参照。

## 開発

```bash
cd kds-app
npm ci
npm run dev
```

- 中継サーバーを別に起動しておくと、`npm run dev` の画面から `/api` などを中継サーバーへプロキシする（`vite.config.ts`）。
  - 中継サーバーは `npm start`（リポジトリ直下で実行）で既定ポート 8000 に起動する。`npm run dev` はこの 8000 へ `/api` などをプロキシする。
- 中継サーバーを起動せずに単体で動かすと、モックデータで画面を確認できる。

## ビルド

```bash
cd kds-app
npm run build
```

- 型チェック → Vite でビルド → `dist/index.html` をリポジトリ直下の `kds-next.html` にコピーする（`scripts/copy-build.mjs`）。
- **ビルド成果物（`kds-next.html`）もコミットする。** 店舗サーバーではビルドしないため、中継サーバーは commit 済みの `kds-next.html` をそのまま配る。画面を変えたら必ずビルドし直して、`kds-next.html` を含めてコミットする。

## レイアウト案の切り替え

### UIラボ（比較ページ）

`/kds-next?view=lab`（開発時は `http://localhost:5173/?view=lab`）で全案を比較できる。

- 新しい5案／全9案の一覧・左右2案比較・1案拡大に対応。同じサンプル注文と操作結果を共有する。
- 3卓／7卓／16卓／注文なし、作業途中／完了数ゼロ、画面幅1024／1280を切り替えて確認できる。
- `/kds-next?view=lab&idea=focus` のように `idea` を指定すると、サンプルを使ってその案を拡大表示する。
- 時刻は固定。完了注文は比較のため残す。注文操作はメモリ内だけで、リセット可能。実注文同期・印刷は行わない。
- 候補と比較メモは、このブラウザの `kds_ui_lab_reviews_v1` に自動保存する。
- 新しい案は `src/views/` に既存と同じ `state` / `actions` を受け取るコンポーネントを作り、`src/views/registry.ts` に追加すると一覧・比較選択に現れる。

どのレイアウトにするか比較中のため、9案を同じデータで動かせる。URL の `?view=` で切り替える（通常画面上に切替は出さない）。

| URL | 案 | 置き場所 |
| --- | --- | --- |
| `/kds-next` | 案0 カード型 | `src/views/cards/` |
| `/kds-next?view=rail` | 案A 伝票レール（古いほど伝票が垂れ下がる） | `src/views/rail/` |
| `/kds-next?view=stove` | 案B コンロ盤（画面がコンロ10口そのもの） | `src/views/stove/` |
| `/kds-next?view=board` | 案C 一枚の板（囲みなし、1卓1行） | `src/views/board/` |
| `/kds-next?view=focus` | フォーカス（選んだ一卓に集中する作業面） | `src/views/focus/` |
| `/kds-next?view=matrix` | 仕込みマトリクス（品目×注文の残数表） | `src/views/matrix/` |
| `/kds-next?view=batch` | まとめ調理（同じ調理条件の料理を集約） | `src/views/batch/` |
| `/kds-next?view=timeline` | タイムライン（待ち時間を横棒で可視化） | `src/views/timeline/` |
| `/kds-next?view=flow` | 調理リレー（受付→調理中→仕上げの工程表示） | `src/views/flow/` |

追加5案は `src/views/shared/` の操作部品を共有する。品目を1個ずつ完了・取り消し、コンロ／タイマー切替、伝票印刷、予約の来店に対応する。予約は右上の「予約」から開く。オフライン時は受信停止を上段に表示する。

- **フォーカス**：左のキューで注文を選び、右で操作。「10分以上」で遅延だけを抽出する。
- **マトリクス**：列は卓ではなく注文単位。同じ卓への追加注文も分けて表示する。卓見出しから詳細・コンロ操作を開く。混雑時は表を縦横にスクロールできる。
- **まとめ調理**：品名・オプション・品目アレルギー・予約全体のアレルギー／要望がすべて一致するときだけ集約する。完了は一括処理せず、元の注文・品目ごとに行う。初期状態では完了分も表示し、戻せる。
- **タイムライン**：棒は調理完了予測ではなく、実際の受付からの経過。10分境界を示し、長い待ち時間に合わせて軸を拡張する。卓番でコンロ操作を開く。
- **調理リレー**：未割当かつ完了数ゼロ＝受付、割当または一部完了＝調理中、一部完了で残り1個または全品完了＝仕上げ。工程は実データから自動表示し、品目・コンロ操作で移動する。ホールでの提供確認を表すものではない。

- 見た目の正となる静止画モックは `concepts/`。
- 案をまたいで使う部品（卓番入力 `SeatPad`、コンロ選択 `KonroPicker`、長押し `useLongPress`、予約一覧 `StockPanel`）は `src/components/`。
- データ層（`src/data/`）・印刷（`src/print/`）は案に依らず共通。どの案で操作しても他の案と現行画面に反映される。
- 案の追加・説明の編集は `src/views/registry.ts` で管理する。

## テスト

```bash
cd kds-app
npm test
```

- Vitest（jsdom）で実行する。型だけを確認するなら `npm run typecheck`。

## 注意

- 外部ライブラリ・CDN を追加しない。店内 LAN で完全オフラインに動かすため、JS/CSS はビルドで1ファイルに埋め込む。
- 中継サーバーが配る共有ファイル（`kds-bridge.js`、`slip-renderer.js`、`party-size.js`）は埋め込まず、`src/main.tsx` が通常画面の起動時に順番に読み込む。UIラボでは読み込まない。
- `src/types.ts`（型）と `src/data/contract.ts`（画面とデータ層の境目）は、画面側の変更で勝手に変えない。
