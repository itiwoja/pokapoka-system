/**
 * BroadcastChannel("kds_sync") の送受信。メッセージの形は現行 kds-a-grid.html と完全に同じ。
 * relay-server/kds-bridge.js が同じ名前のチャンネルを聞いて中継サーバーへ送る。
 */
import type { KonroChange } from "./logic";
import type { Order, Reservation } from "../types";
import {
  loadDeleted, loadDone, loadKonro, putOrder, saveDeleted, saveDone, saveKonro, saveOrderSeq, saveStock,
} from "./storage";

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

/** 他タブからの変更を保存先へ反映する。旧画面の受信処理と同じ扱いで、再送信はしない。 */
export function applySyncMessage(msg: Record<string, any>): void {
  if (msg.type === "toggle") {
    const done = loadDone();
    if (!done[msg.id]) done[msg.id] = [];
    done[msg.id][msg.index] = msg.doneCount;
    saveDone(done);
  } else if (msg.type === "konro") {
    const next = loadKonro();
    const key = String(msg.num);
    if (msg.state === "skeleton") {
      if (next[msg.id]) {
        delete next[msg.id][key];
        if (!Object.keys(next[msg.id]).length) delete next[msg.id];
      }
    } else {
      next[msg.id] = { ...(next[msg.id] || {}), [key]: msg.state };
    }
    saveKonro(next);
  } else if (msg.type === "order" && Array.isArray(msg.seq)) {
    saveOrderSeq(msg.seq.map(String));
  } else if (msg.type === "stock" && Array.isArray(msg.stock)) {
    saveStock(msg.stock);
  } else if (msg.type === "moveToMain" && Array.isArray(msg.stock)) {
    saveStock(msg.stock);
    if (msg.order) putOrder(msg.order);
  } else if (msg.type === "deleteOrder" && msg.id) {
    const del = loadDeleted();
    del[String(msg.id)] = true;
    saveDeleted(del);
    const w = window as { KDS_ORDERS?: Order[] };
    if (Array.isArray(w.KDS_ORDERS)) w.KDS_ORDERS = w.KDS_ORDERS.filter((o) => String(o.id) !== String(msg.id));
  }
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
