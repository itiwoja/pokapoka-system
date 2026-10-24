/**
 * デシャップ画面が扱うデータの形。
 * 既存 KDS (kds-a-grid.html) と relay-server/kds-bridge.js のデータ契約に合わせている。
 * 形を変えると旧画面・中継サーバーと噛み合わなくなるので、ここでは足すだけにする。
 */

/** window.KDS_ORDERS の1品目 */
export interface OrderItem {
  name: string;
  qty: number;
  options: string | null;
  allergies: string | null;
}

/** window.KDS_ORDERS の1件 */
export interface Order {
  id: string;
  table: string;
  type: "new" | "reserved";
  /** 受付時刻 (epoch ミリ秒) */
  start: number;
  people?: number | { adults?: number; kids?: number } | null;
  items: OrderItem[];
}

/** コンロ番号の状態。"skeleton" は未使用 (保存しない) */
export type KonroState = "white" | "red";

/** localStorage "kds_stock_v1" の1件 (当日の予約ストック) */
export interface Reservation {
  rid: string;
  /** "HH:MM" */
  time: string;
  name?: string;
  adults?: number;
  kids?: number;
  menu?: { name: string; qty: number }[];
  [extra: string]: unknown;
}

/** 画面に出す1枚のカード (注文 + 厨房状態を合成したもの) */
export interface Card {
  order: Order;
  /** 品目ごとの完了個数 (items と同じ長さ) */
  doneCounts: number[];
  /** コンロ番号 → 状態。使っている番号だけ */
  konro: Record<number, KonroState>;
  /**
   * 全品完了した直後の数秒だけ true。カードを薄く残し、誤タップなら品目タップで戻せるようにする。
   * 猶予が過ぎると cards から外れる (確認ボタンや「戻す」トーストは出さない)
   */
  finishing: boolean;
}

/** 中継サーバーとの同期が切れているか。画面には切れているときだけ出す */
export type Connection = "ok" | "offline";
