/**
 * 新規注文の通知音。ブラウザの自動再生制限は、画面への最初の pointerdown で解く。
 * 専用ボタンは作らない。
 */
export const SOUND_URL = "/assets/sounds/shishiodoshi.ogg";
export const ORDER_ADDED_EVENT = "kds:order-added";

/** イベントと unlock を購読する。戻り値で解除 */
export function startOrderSound(): () => void {
  let audio: HTMLAudioElement | null = null;
  const get = () => {
    if (!audio && typeof Audio !== "undefined") {
      audio = new Audio(SOUND_URL);
      audio.preload = "auto";
    }
    return audio;
  };

  const unlock = () => {
    const a = get();
    if (!a) return;
    // 無音で一瞬再生して許可を得る
    a.muted = true;
    const p = a.play();
    const reset = () => { a.pause(); a.currentTime = 0; a.muted = false; };
    if (p && typeof p.then === "function") p.then(reset, () => { a.muted = false; });
    else reset();
  };
  window.addEventListener("pointerdown", unlock, { once: true, capture: true });

  const onAdded = () => {
    const a = get();
    if (!a) return;
    try {
      a.currentTime = 0;
      const p = a.play();
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch { /* 鳴らせなくても業務は止めない */ }
  };
  window.addEventListener(ORDER_ADDED_EVENT, onAdded);

  return () => {
    window.removeEventListener("pointerdown", unlock, { capture: true });
    window.removeEventListener(ORDER_ADDED_EVENT, onAdded);
  };
}
