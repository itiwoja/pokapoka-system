const pad = (n: number) => String(n).padStart(2, "0");

/** 経過秒を MM:SS にする。60分を超えても分はそのまま数える (例 75:03)。 */
export function mmss(sec: number): string {
  return `${pad(Math.floor(sec / 60))}:${pad(sec % 60)}`;
}

/** epoch ミリ秒を端末のローカル時刻 HH:MM にする。 */
export function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
