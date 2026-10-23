/**
 * デシャップ画面のデータ層。現行 kds-a-grid.html と同じ localStorage / BroadcastChannel の契約で読み書きする。
 * 中継サーバーとのやり取りは relay-server/kds-bridge.js (index.html で読み込み済み) が担当する。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { KdsActions, KdsState } from "./contract";
import {
  applyFinishing, assignKonro, buildSeatedOrder, completeOne, composeCards, connectionFrom, undoOne,
  type DoneMap, type KdsCard,
} from "./logic";
import {
  loadDeleted, loadDone, loadKonro, loadOrderSeq, loadStock, purgeStaleDay, putOrder, readOrders,
  saveDeleted, saveDone, saveKonro, saveOrderSeq, saveStock,
} from "./storage";
import { konroMsg, moveToMainMsg, openChannel, toggleMsg, type Channel } from "./sync";
import { startOrderSound } from "./sound";
import { installDevMock } from "./devMock";
import type { Order, Reservation } from "../types";

const TICK_MS = 1000;

type W = { __KDS_RELAY_BRIDGE__?: boolean; __KDS_SYNC_STATUS__?: any };

/** 状態を LS / window から1回分組み立てる (finishAt は呼び出し側が持つ) */
function snapshot(prevFinishAt: Record<string, number>, now: number) {
  purgeStaleDay(new Date(now));
  const composed = composeCards({
    orders: readOrders(),
    done: loadDone(),
    konro: loadKonro(),
    seq: loadOrderSeq(),
    deleted: loadDeleted(),
  });
  const { cards, finishAt } = applyFinishing(composed, prevFinishAt, now);
  const w = window as unknown as W;
  const state: KdsState = {
    cards,
    stock: [...loadStock()].sort((a, b) => String(a.time).localeCompare(String(b.time))),
    connection: connectionFrom(!!w.__KDS_RELAY_BRIDGE__, w.__KDS_SYNC_STATUS__),
    now,
  };
  return { state, finishAt };
}

export function useKds(): { state: KdsState; actions: KdsActions } {
  const finishAtRef = useRef<Record<string, number>>({});
  const channelRef = useRef<Channel | null>(null);
  const [state, setState] = useState<KdsState>(() => {
    if (import.meta.env.DEV && !(window as unknown as W).__KDS_RELAY_BRIDGE__) installDevMock();
    const r = snapshot({}, Date.now());
    finishAtRef.current = r.finishAt;
    return r.state;
  });

  const refreshRef = useRef<() => void>(() => {});
  refreshRef.current = () => {
    const r = snapshot(finishAtRef.current, Date.now());
    finishAtRef.current = r.finishAt;
    setState(r.state);
  };

  useEffect(() => {
    const refresh = () => refreshRef.current();
    const timer = window.setInterval(refresh, TICK_MS);

    // 他タブ (旧画面など) からの変更を LS に反映してから読み直す。現行の受信処理と同じ扱い
    const channel = openChannel((msg) => {
      if (msg.type === "toggle") {
        const done: DoneMap = loadDone();
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
      refresh();
    });
    channelRef.current = channel;

    const stopSound = startOrderSound();
    window.addEventListener("kds-sync-status", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("kds-sync-status", refresh);
      stopSound();
      channel.close();
      channelRef.current = null;
    };
  }, []);

  const actions = useMemo<KdsActions>(() => {
    const post = (m: Parameters<Channel["post"]>[0]) => channelRef.current?.post(m);
    const done = (orderId: string, index: number, op: typeof completeOne) => {
      const order = readOrders().find((o) => String(o.id) === orderId);
      if (!order) return;
      const doneMap = loadDone();
      const r = op(order, doneMap, index);
      if (!r) return;
      doneMap[orderId] = r.counts;
      saveDone(doneMap);
      post(toggleMsg(orderId, index, r.doneCount));
      refreshRef.current();
    };
    return {
      completeOne: (orderId, index) => done(String(orderId), index, completeOne),
      undoOne: (orderId, index) => done(String(orderId), index, undoOne),
      setKonro(orderId, num, konroState) {
        const { map, changes } = assignKonro(loadKonro(), String(orderId), num, konroState);
        saveKonro(map);
        changes.forEach((c) => post(konroMsg(c)));
        refreshRef.current();
      },
      seatReservation(rid, table) {
        const seat = String(table || "").trim();
        if (!seat) return;
        const stock = loadStock();
        const r = stock.find((x: Reservation) => String(x.rid) === String(rid));
        if (!r) return;
        const order = buildSeatedOrder(r, seat, Date.now());
        putOrder(order);
        const rest = stock.filter((x) => String(x.rid) !== String(rid));
        saveStock(rest);
        post(moveToMainMsg(rest, order));
        refreshRef.current();
      },
    };
  }, []);

  return { state, actions };
}

export type { KdsCard };
