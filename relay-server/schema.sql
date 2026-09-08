-- 注文端末チームのデータ仕様待ち。実APIの契約ではない。
-- id / order_id / position は注文と明細を結び付ける内部管理用。
BEGIN;
CREATE TABLE IF NOT EXISTS mock_orders (
  id INTEGER PRIMARY KEY,
  people INTEGER NOT NULL CHECK(people > 0)
) STRICT;
CREATE TABLE IF NOT EXISTS mock_order_items (
  order_id INTEGER NOT NULL REFERENCES mock_orders(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK(position >= 0),
  product_id TEXT NOT NULL CHECK(length(trim(product_id)) > 0),
  qty INTEGER NOT NULL CHECK(qty > 0),
  PRIMARY KEY(order_id, position)
) STRICT;
COMMIT;
