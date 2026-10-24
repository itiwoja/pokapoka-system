import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent } from "react";

interface Options {
  onTap: () => void;
  onLongPress: () => void;
  /** 長押し成立までのミリ秒 (#153: 0.8秒) */
  delay?: number;
  /** 進捗帯を出し始めるまでのミリ秒 */
  showAfter?: number;
  /** これ以上動いたらキャンセル (スクロール誤爆防止) */
  moveLimit?: number;
}

/**
 * タップと長押しを1つのボタンで両立させる。
 * 長押しが成立したときは、離した直後の click を握りつぶして二重に動かさない。
 */
export function useLongPress({ onTap, onLongPress, delay = 800, showAfter = 200, moveLimit = 12 }: Options) {
  const [pressing, setPressing] = useState(false);
  const timers = useRef<number[]>([]);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);

  const clear = useCallback(() => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
    origin.current = null;
    setPressing(false);
  }, []);

  useEffect(() => clear, [clear]);

  const onPointerDown = (e: ReactPointerEvent) => {
    fired.current = false;
    origin.current = { x: e.clientX, y: e.clientY };
    timers.current = [
      window.setTimeout(() => setPressing(true), showAfter),
      window.setTimeout(() => {
        fired.current = true;
        clear();
        onLongPress();
      }, delay),
    ];
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const o = origin.current;
    if (!o) return;
    if (Math.hypot(e.clientX - o.x, e.clientY - o.y) > moveLimit) clear();
  };
  const onClick = (e: ReactMouseEvent) => {
    if (fired.current) {
      fired.current = false;
      e.preventDefault();
      return;
    }
    onTap();
  };

  return {
    pressing,
    handlers: { onPointerDown, onPointerMove, onPointerUp: clear, onPointerCancel: clear, onPointerLeave: clear, onClick },
  };
}
