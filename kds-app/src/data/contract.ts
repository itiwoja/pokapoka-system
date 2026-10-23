/**
 * 画面 (components) とデータ層 (data) の境目。画面はここに書いた関数と hook だけを使う。
 * 実装は data/ 配下 (useKds.ts ほか)。
 */
import type { Card, Connection, KonroState, Reservation } from "../types";

export interface KdsState {
  /** 配膳順 (FIFO・並び順は kds_order_v1 に従う)。全品完了・削除済みの注文は含まない */
  cards: Card[];
  /** 当日の予約ストック (時刻順) */
  stock: Reservation[];
  connection: Connection;
  /** 現在時刻 (1秒ごとに更新)。経過時間の表示に使う */
  now: number;
}

export interface KdsActions {
  /** 品目を1個完了にする (全数完了なら何もしない) */
  completeOne(orderId: string, index: number): void;
  /** 品目を1個未完了に戻す (0 なら何もしない) */
  undoOne(orderId: string, index: number): void;
  /** コンロ番号の状態を設定する。null で解除。同じ番号を別カードが使っていたらそちらは解除する */
  setKonro(orderId: string, num: number, state: KonroState | null): void;
  /** 予約を卓番付きで配膳エリアへ移す */
  seatReservation(rid: string, table: string): void;
}
