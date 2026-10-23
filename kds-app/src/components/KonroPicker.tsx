import type { Card, KonroState } from "../types";
import "./KonroPicker.css";

interface Props {
  card: Card;
  onSet: (num: number, state: KonroState | null) => void;
  onClose: () => void;
  /** 他のカードが使っている番号 (押せるが薄く出す) */
  usedElsewhere?: Set<number>;
}

const NUMS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/** 未使用 → 白 → 赤 → 未使用 */
function next(cur: KonroState | undefined): KonroState | null {
  if (cur === undefined) return "white";
  if (cur === "white") return "red";
  return null;
}

export default function KonroPicker({ card, onSet, onClose, usedElsewhere }: Props) {
  return (
    <>
      <button type="button" className="kds-konro-backdrop" aria-label="閉じる" onClick={onClose} />
      <div className="kds-konro-picker" role="dialog" aria-label="コンロ番号">
        <div className="kds-konro-grid">
          {NUMS.map((n) => {
            const cur = card.konro[n];
            const cls = [
              "kds-konro-cell",
              cur === "white" ? "kds-konro-cell--white" : "",
              cur === "red" ? "kds-konro-cell--red" : "",
              cur === undefined && usedElsewhere?.has(n) ? "kds-konro-cell--elsewhere" : "",
            ].join(" ").trim();
            return (
              <button key={n} type="button" className={cls} onClick={() => onSet(n, next(cur))}>
                {n}
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}
