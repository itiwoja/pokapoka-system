import { useEffect, useRef, useState } from "react";
import type { Order } from "../types";
import { printSlip } from "./printSlip";

/** cards / board 共通の印刷中・3秒間の失敗表示。rail / stove の通知方針とは分けておく。 */
export function usePrintSlip(order: Order) {
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState(false);
  const errTimer = useRef<number | null>(null);
  useEffect(() => () => { if (errTimer.current) window.clearTimeout(errTimer.current); }, []);

  const onPrint = async () => {
    setPrinting(true);
    try {
      const r = await printSlip(order);
      if (r === "busy") return; // 別のカードの送信中は失敗ではないので何も出さない
      if (r === "failed") throw new Error("failed");
    } catch {
      setPrintError(true);
      if (errTimer.current) window.clearTimeout(errTimer.current);
      errTimer.current = window.setTimeout(() => setPrintError(false), 3000);
    } finally {
      setPrinting(false);
    }
  };

  return { printing, printError, onPrint };
}
