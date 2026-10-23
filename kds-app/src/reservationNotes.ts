/**
 * 予約レコードからアレルギー文と要望文を取り出す純粋関数。
 * 現行 kds-a-grid.html の normalizeNoteValue / reservationRequestValue / buildReservationNotes と同じ判定。
 * DOM 生成はしない (表示は各コンポーネントが行う)。
 */

export interface ReservationNotes {
  allergy: string;
  request: string;
}

/* 旧形式の memo に混ざったアレルギー表記を剥がす */
const ALLERGY_WORD = /アレルギ|allerg|食物アレルギ|dietary\s+restriction/i;
const ALLERGY_PREFIX = /^\s*(?:アレルギー|allerg(?:y|ies)|食物アレルギー|dietary\s+restriction(?:s)?)\s*[:：]?\s*/i;
const NONE_WORD = /^(?:なし|無|ない|特になし|なしです|no|none|n\/a)$/i;
/* 「アレルギー: なし」のように要望欄へラベル付きで入っている「なし」 */
const LABEL_NONE = /^(?:アレルギー|allerg(?:y|ies))\s*[:：]?\s*(?:なし|無|ない|特になし|なしです|no|none|n\/a)$/i;

/* 注文端末からの値を1本の文字列にする。配列は「、」でつなぐ */
function normalize(value: unknown): string {
  if (value == null || value === false) return "";
  if (Array.isArray(value)) {
    return value
      .filter((v) => v != null && String(v).trim() !== "")
      .map((v) => String(v).trim())
      .join("、");
  }
  return String(value).trim();
}

/* request → specialRequest → memo の順。memo は旧形式の自由記述だけに残るため、
   既に分離済みのアレルギーがあるときは同じ special_request を二重表示しない。 */
function requestValue(r: Record<string, unknown>, allergy: string): unknown {
  if (r.request != null) return r.request;
  if (r.specialRequest != null) return r.specialRequest;
  return allergy ? "" : r.memo;
}

export function reservationNotes(r: Record<string, unknown> | null | undefined): ReservationNotes {
  if (!r) return { allergy: "", request: "" };

  let allergy = normalize(r.allergies || r.allergy || r.allergyInfo);
  let request = normalize(requestValue(r, allergy));

  // relay-server v1 の memo だけが残る場合でも、アレルギーを要望扱いにしない。
  if (!allergy && request && ALLERGY_WORD.test(request)) {
    const parsed = request.replace(ALLERGY_PREFIX, "").trim() || request;
    allergy = NONE_WORD.test(parsed) ? "" : parsed;
    request = "";
  }
  if (!allergy && LABEL_NONE.test(request)) {
    request = "";
  }
  return { allergy, request };
}
