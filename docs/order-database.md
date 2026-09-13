# 注文DBの独立モック

商品ID・注文個数・人数だけでDBの保存・取得を試す独立モックです。
2026-09-11に注文端末→既存注文サーバーの仕様を確定しましたが、実注文はサブモジュール内のPostgreSQLへ保存します（[接続先と仕様](注文端末_注文サーバー接続.md)）。本モックのフィールド名・型は実APIの契約ではありません。

```json
{
  "people": 2,
  "items": [
    { "productId": "MOCK-001", "qty": 2 },
    { "productId": "MOCK-002", "qty": 1 }
  ]
}
```

| テーブル | 項目 | 意味 |
|---|---|---|
| mock_orders | people | 注文全体の人数 |
| mock_order_items | product_id | 仮の商品ID（文字列） |
| mock_order_items | qty | 商品ごとの注文個数 |

注文と複数明細を結び付けるため、内部管理用の注文IDと明細位置も持ちます。
人数・個数は正の整数としています。商品名・卓番・注記・厨房状態などは今回のモックには含めません。

## 試し方

モック実行にはNode.js 22.13以上が必要です。
リポジトリ直下で次を実行すると、SQLite DBを作成し、サンプル注文を保存・表示します。
再実行時は既存データを表示し、サンプルを追加しません。

```powershell
node relay-server/database.js
```

保存先: `data/mock-orders.sqlite`（Git管理対象外）。DDLは [schema.sql](../relay-server/schema.sql)。

このモックは既存サーバーと独立しており、`POST /api/orders` やデシャップへの配信にはまだ接続していません。
先に追加した通常サーバーのDB保存処理は取り下げ、既存の通信は元の動作を維持しています。
実注文側の `menuId`・`quantity` と、本モックの `productId`・`qty` は別のフィールドです。実APIとの接続は行っていません。
