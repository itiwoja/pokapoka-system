# 重要操作の監査ログ仕様（Issue #210）

## 目的と対象

監査ログは、業務影響の大きい操作について「いつ・何を・どの端末が・どの認証経路で・どの結果にしたか」を後から確認するためのものです。注文履歴や予約台帳ではありません。

記録対象は次の通りです。

| 操作 | 推奨 operation | target の例 |
|---|---|---|
| 注文の取消・更新・訂正 | `order.cancel` / `order.update` | `order:o-123` |
| 座席の登録・変更・解除 | `seat.create` / `seat.update` / `seat.release` | `seat:5` |
| プリンター設定変更 | `printer.update` | `printer:main` |
| 伝票スタイル・レイアウト変更 | `slip-style.update` | `slip-style:default` |
| 認証失敗・権限エラー | `auth.denied` | `route:POST /api/seats` |

成功、業務上の失敗、認証拒否をいずれも記録します。読み取り専用操作、ヘルスチェック、通常の画面閲覧は対象外です。

## 記録項目

1イベントは次の項目だけを持ちます。

| 項目 | 必須 | 内容 |
|---|---|---|
| `timestamp` | yes | サーバーが付ける UTC ISO 8601 時刻 |
| `operation` | yes | 上表の安定した操作コード |
| `target` | yes | 種別とSHA-256先頭16桁の不透明ID。氏名やURLを使わない |
| `result` | yes | `success` / `failure` / `denied` といった結果コード |
| `actor.authMechanism` | yes | `header` / `query` / `cookie` / `loopback` / `disabled` / `unknown`。トークン値は入れない |
| `actor.device` | yes | 端末ラベルをSHA-256先頭16桁へ変換した不透明ID。識別不能なら `unknown` |
| `actor.ip` | yes | 接続元IP。取得不能なら `unknown` |
| `before` / `after` | no | 状態の最小要約 |

共有トークン認証は個人を識別しません。そのため表示上の実行者は「認証方式 + 端末名 + IP」であり、端末名が無ければ `unknown (IP)` とします。個人名を推測・記録しません。

`before` / `after` は `status`, `state`, `table`, `seat`, `code`, `reason`, `mode`, `source`, `enabled`, `configured`, `printer`, `layout`, `style`, `count`, `itemCount` のプリミティブ値だけを保存します。注文品目、数量明細、アレルギー、氏名、予約情報、自由記述を複製しません。

## 秘密情報と個人情報

次の情報は監査イベントへ渡さず、モジュール側でもキーを拒否または値を `[redacted]` にします。

- 認証トークン、`Authorization`、Cookie、パスワード、APIキー
- クエリー文字列を含む生URL
- 顧客名、予約名、注文品目、アレルギー、備考、リクエストbody
- 注文・予約オブジェクト全体

ログの target と端末ラベルはrelay統合境界で決定的ハッシュへ変換します。同じ入力は同じ不透明IDになるため日時・操作・対象で照合できますが、外部入力の平文は保存しません。ログをIssue、チャット、外部ストレージへ添付する前にも目視で再確認します。

## 保存・保持・容量

- 保存先: ミニPCの `config/audit-log.jsonl`（1行1 JSON、Git管理外）
- 既定保持期間: 30日
- 既定最大件数: 3000件
- 追加のたびと起動時に、期限切れと古い上限超過分を削除
- ローテーション後の内容を一時ファイルへ書き、置換してから成功とみなす

監査ログが保存するのは操作メタデータだけです。注文・予約の内容は従来通り当日メモリのみで、再起動時に消えるため、「注文・予約は永続保存しない」方針と矛盾しません。保持期間の延長を注文分析や顧客追跡に転用しません。

手動削除は中継サーバーを停止し、必要な期間をJSONLでエクスポートした後に `config/audit-log.jsonl` を削除します。次回記録時に空のファイルが再作成されます。削除操作自体を監査対象にする管理APIは現時点では設けません。

## 閲覧・エクスポート

`createAuditLog()` の `query({ from, to, operation, target, limit })` は日時（両端を含む）、操作、対象の完全一致で検索します。`exportJSONL(filters)` は同じ検索条件のJSONLを返します。HTTP統合では `auth.token` が設定された認証済みスタッフ端末だけに GET/エクスポートを許可します。認証無効モードでは `/api/audit` を403にし、OS上のファイルを確認します。認証失敗も `auth.denied` として記録し、監査ファイルを静的ファイルとして公開してはいけません。

## 障害・改ざんへの対応

- 読み書き、ローテーション、形式不正は注入 logger の `error` へ通知します。
- 監査ログ障害を理由に、座席解除など元の業務操作へ例外を投げません。`record()` は保存失敗時に `null` を返すため、サーバーログや運用監視で警告できます。
- 壊れたJSONL行は読み飛ばし、正常行で継続します。
- 保存先はサーバープロセスのOSユーザーだけが書けるようにし、共有フォルダーに置きません。モジュールは新規一時ファイルを `0600` で作成します（WindowsではACLを運用設定で確認します）。
- この方式は一般利用者からの改ざんを抑えますが、ミニPC管理者による改ざんを暗号学的には検知しません。署名付き外部保管は現行の店内単機構成の範囲外です。

## モジュールAPI

```js
var audit = require("./audit-log").createAuditLog({
  filePath: "...",       // 省略時 config/audit-log.jsonl
  retentionDays: 30,
  maxRecords: 3000,
  logger: console,
});

audit.record({ operation, target, result, actor, before, after });
audit.query({ from, to, operation, target, limit });
audit.exportJSONL({ from, to, operation, target, limit });
audit.prune();
```

全メソッドは呼び出し元へファイルI/O例外を投げません。`record()` は成功時に保存済みイベント、失敗時に `null`、`query()` は配列、`exportJSONL()` は文字列を返します。
