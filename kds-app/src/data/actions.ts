import type { KdsActions } from "./contract";
import { assignKonro, buildSeatedOrder, completeOne, undoOne } from "./logic";
import { loadDone, loadKonro, loadStock, putOrder, readOrders, saveDone, saveKonro, saveStock } from "./storage";
import { konroMsg, moveToMainMsg, toggleMsg, type Channel } from "./sync";

/** 操作ごとに最新の保存状態を読み、保存 → 他画面への通知 → 自画面の再読込の順で反映する。 */
export function createKdsActions(post: Channel["post"], refresh: () => void): KdsActions {
  const done = (orderId: string, index: number, op: typeof completeOne) => {
    const order = readOrders().find((o) => String(o.id) === orderId);
    if (!order) return;
    const doneMap = loadDone();
    const r = op(order, doneMap, index);
    if (!r) return;
    doneMap[orderId] = r.counts;
    saveDone(doneMap);
    post(toggleMsg(orderId, index, r.doneCount));
    refresh();
  };

  return {
    completeOne: (orderId, index) => done(String(orderId), index, completeOne),
    undoOne: (orderId, index) => done(String(orderId), index, undoOne),
    setKonro(orderId, num, konroState) {
      const { map, changes } = assignKonro(loadKonro(), String(orderId), num, konroState);
      saveKonro(map);
      changes.forEach((c) => post(konroMsg(c)));
      refresh();
    },
    seatReservation(rid, table) {
      const seat = String(table || "").trim();
      if (!seat) return;
      const stock = loadStock();
      const r = stock.find((x) => String(x.rid) === String(rid));
      if (!r) return;
      const order = buildSeatedOrder(r, seat, Date.now());
      putOrder(order);
      const rest = stock.filter((x) => String(x.rid) !== String(rid));
      saveStock(rest);
      post(moveToMainMsg(rest, order));
      refresh();
    },
  };
}
