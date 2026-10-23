/**
 * BroadcastChannel("kds_sync") の送受信。メッセージの形は現行 kds-a-grid.html と完全に同じ。
 * relay-server/kds-bridge.js が同じ名前のチャンネルを聞いて中継サーバーへ送る。
 */
import type { KonroChange } from "./logic";
import type { Order, Reservation } from "../types";

export const BC_NAME = "kds_sync";

export type KdsMessage =
  | { type: "toggle"; id: string; index: number; doneCount: number }
  | { type: "konro"; id: string; num: number; state: string }
  | { type: "moveToMain"; stock: Reservation[]; order: Order }
  | { type: "order"; seq: string[] }
  | { type: "stock"; stock: Reservation[] }
  | { type: "deleteOrder"; id: string }
  | { type: "timerLock"; id: string; locked: boolean };

export const toggleMsg = (id: string, index: number, doneCount: number): KdsMessage => ({
  type: "toggle", id, index, doneCount,
});
export const konroMsg = (c: KonroChange): KdsMessage => ({
  type: "konro", id: c.id, num: c.num, state: c.state,
});
export const moveToMainMsg = (stock: Reservation[], order: Order): KdsMessage => ({
  type: "moveToMain", stock, order,
});

export interface Channel {
  post(msg: KdsMessage): void;
  close(): void;
}

/** BroadcastChannel を開く。非対応環境では何もしないチャンネルを返す (localStorage の読み直しだけで動く) */
export function openChannel(onMessage: (msg: Record<string, any>) => void): Channel {
  if (typeof BroadcastChannel === "undefined") return { post() {}, close() {} };
  let bc: BroadcastChannel | null = null;
  try {
    bc = new BroadcastChannel(BC_NAME);
    bc.onmessage = (ev) => {
      if (ev && ev.data) onMessage(ev.data);
    };
  } catch {
    bc = null;
  }
  return {
    post(msg) {
      try { bc?.postMessage(msg); } catch { /* 送れなくても操作自体は成立 */ }
    },
    close() {
      try { bc?.close(); } catch { /* 無視 */ }
    },
  };
}
