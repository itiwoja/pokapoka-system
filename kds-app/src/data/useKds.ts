/**
 * デシャップ画面のデータ層。現行 kds-a-grid.html と同じ localStorage / BroadcastChannel の契約で読み書きする。
 * 中継サーバーとのやり取りは relay-server/kds-bridge.js (index.html で読み込み済み) が担当する。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { KdsActions, KdsState } from "./contract";
import {
  applyFinishing, composeCards, connectionFrom, type KdsCard,
} from "./logic";
import {
  loadDeleted, loadDone, loadKonro, loadOrderSeq, loadStock, purgeStaleDay, readOrders,
} from "./storage";
import { applySyncMessage, openChannel, type Channel } from "./sync";
import { createKdsActions } from "./actions";
import { startOrderSound } from "./sound";
import { installDevMock } from "./devMock";

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
      applySyncMessage(msg);
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

  const actions = useMemo(() => createKdsActions(
    (msg) => channelRef.current?.post(msg),
    () => refreshRef.current(),
  ), []);

  return { state, actions };
}

export type { KdsCard };
