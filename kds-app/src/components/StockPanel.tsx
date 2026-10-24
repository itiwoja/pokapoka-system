import { useState } from "react";
import type { Reservation } from "../types";
import { reservationNotes } from "../reservationNotes";
import { SeatPad } from "./SeatPad";
import "./StockPanel.css";

export interface StockPanelProps {
  stock: Reservation[];
  now: number;
  onSeat(rid: string, table: string): void;
}

/** 予約時刻の何分前から「まもなく」にするか (現行 SOON_MIN) */
const SOON_MIN = 30;

/**
 * 予約時刻 "HH:MM" までの分数。未来は切り上げ、過去は切り下げる。
 * 四捨五入だと30分ちょうど手前の予約まで「まもなく」に入ってしまうため (現行 #204)。
 */
export function minutesUntil(time: string | undefined, now: number): number {
  const parts = String(time ?? "").split(":");
  if (parts.length < 2) return Infinity;
  const d = new Date(now);
  d.setHours(Number(parts[0]) || 0, Number(parts[1]) || 0, 0, 0);
  const delta = (d.getTime() - now) / 60000;
  return delta >= 0 ? Math.ceil(delta) : Math.floor(delta);
}

/** 開始30分前から開始時刻ちょうどまで true。過ぎたら false */
export function isSoon(time: string | undefined, now: number): boolean {
  const mu = minutesUntil(time, now);
  return mu >= 0 && mu <= SOON_MIN;
}

/* 人数の区分と略記は relay-server/party-size.js (window.PartySize) に合わせる。
   読めないとき (単体で開いた等) は同じ4区分で数える */
interface PartySizeApi {
  total(r: unknown): number;
  breakdown(r: unknown, o?: { onlyMixed?: boolean }): { short: string; n: number }[];
}
const FALLBACK_KINDS: [string, string][] = [["adults", "大"], ["seniors", "シ"], ["children", "子"], ["kids", "幼"]];

function countOf(r: Reservation, key: string): number {
  const n = Number(r[key]);
  return isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function peopleTotal(r: Reservation): number {
  const ps = (window as unknown as { PartySize?: PartySizeApi }).PartySize;
  if (ps) return ps.total(r);
  return FALLBACK_KINDS.reduce((s, [k]) => s + countOf(r, k), 0);
}

/** 大人以外がいるときだけの内訳 ("大2 子1")。大人だけなら空 */
export function peopleBreakdown(r: Reservation): string {
  const ps = (window as unknown as { PartySize?: PartySizeApi }).PartySize;
  if (ps) return ps.breakdown(r, { onlyMixed: true }).map((p) => p.short + p.n).join(" ");
  const parts = FALLBACK_KINDS.filter(([k]) => countOf(r, k) > 0);
  if (parts.every(([k]) => k === "adults")) return "";
  return parts.map(([k, s]) => s + countOf(r, k)).join(" ");
}

export function StockPanel({ stock, now, onSeat }: StockPanelProps) {
  const [seating, setSeating] = useState<Reservation | null>(null);

  return (
    <aside className="kds-stock" aria-label="予約">
      <header className="kds-stock-head">
        <span>予約</span>
        <span className="kds-stock-count">{stock.length}</span>
      </header>
      <div className="kds-stock-list">
        {stock.length === 0 && <p className="kds-stock-empty">本日の予約はありません</p>}
        {stock.map((r) => {
          const mu = minutesUntil(r.time, now);
          const soon = mu >= 0 && mu <= SOON_MIN;
          const late = mu < 0 && mu !== Infinity;
          const mix = peopleBreakdown(r);
          const notes = reservationNotes(r);
          return (
            <article key={r.rid} className={"kds-res" + (soon ? " soon" : "")} data-rid={r.rid}>
              {soon && <span className="kds-res-label">まもなく</span>}
              {late && <span className="kds-res-late">{-mu}分過ぎ</span>}
              <div className="kds-res-time">{r.time || "--:--"}</div>
              <div className="kds-res-row">
                <span className="kds-res-name">{r.name || "—"}</span>
                <span className="kds-res-people">
                  <b>{peopleTotal(r)}</b>名{mix && <span className="kds-res-mix">{mix}</span>}
                </span>
              </div>
              {(r.menu ?? []).length > 0 && (
                <ul className="kds-res-menu">
                  {(r.menu ?? []).map((m, i) => (
                    <li key={i}>
                      <span>{m.name}</span>
                      <span className="kds-res-qty">×{Number(m.qty) || 1}</span>
                    </li>
                  ))}
                </ul>
              )}
              {/* 仕込みで見落とさないよう、来店ボタンの上に常時出す (アレルギーは赤系) */}
              {notes.allergy && <p className="kds-res-allergy">アレルギー: {notes.allergy}</p>}
              {notes.request && <p className="kds-res-request">要望: {notes.request}</p>}
              <button type="button" className="kds-res-seat" onClick={() => setSeating(r)}>
                来店
              </button>
            </article>
          );
        })}
      </div>
      {seating && (
        <SeatPad
          title={`${seating.time ?? ""} ${seating.name ?? ""}`.trim() || "卓番"}
          onClose={() => setSeating(null)}
          onSubmit={(table) => {
            onSeat(seating.rid, table);
            setSeating(null);
          }}
        />
      )}
    </aside>
  );
}
