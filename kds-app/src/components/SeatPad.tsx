import { useEffect, useState } from "react";
import "./SeatPad.css";

export interface SeatPadProps {
  title: string;
  onSubmit(table: string): void;
  onClose(): void;
}

/**
 * 卓番はゾーン英字+番号の「A1」形式 (要件定義書・現行 #118)。現行どおり A/B/C を残す。
 * ゾーンを押すと入力をやり直し、数字は末尾に足す。自由入力にしないのは誤入力防止のため。
 */
const ZONES = ["A", "B", "C"];
const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
const MAX_LEN = 4;

export function SeatPad({ title, onSubmit, onClose }: SeatPadProps) {
  const [value, setValue] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const push = (d: string) => setValue((v) => (v.length >= MAX_LEN ? v : v + d));

  return (
    <div className="kds-seatpad-backdrop" onClick={onClose}>
      <div
        className="kds-seatpad"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="kds-seatpad-title">{title}</div>
        <div className={"kds-seatpad-display" + (value ? "" : " empty")} aria-live="polite">
          {value || "卓番"}
        </div>
        <div className="kds-seatpad-zones">
          {ZONES.map((z) => (
            <button
              key={z}
              type="button"
              className={"kds-seatpad-key" + (value.charAt(0) === z ? " active" : "")}
              onClick={() => setValue(z)}
            >
              {z}
            </button>
          ))}
        </div>
        <div className="kds-seatpad-grid">
          {DIGITS.map((d) => (
            <button key={d} type="button" className="kds-seatpad-key" onClick={() => push(d)}>
              {d}
            </button>
          ))}
          <span />
          <button type="button" className="kds-seatpad-key" onClick={() => push("0")}>
            0
          </button>
          <button
            type="button"
            className="kds-seatpad-key"
            aria-label="1文字消す"
            onClick={() => setValue((v) => v.slice(0, -1))}
          >
            ⌫
          </button>
        </div>
        <div className="kds-seatpad-actions">
          <button type="button" className="kds-seatpad-cancel" onClick={onClose}>
            キャンセル
          </button>
          <button
            type="button"
            className="kds-seatpad-ok"
            disabled={value === ""}
            onClick={() => onSubmit(value)}
          >
            決定
          </button>
        </div>
      </div>
    </div>
  );
}
