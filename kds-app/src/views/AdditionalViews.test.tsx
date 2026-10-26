import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { Card } from "../types";
import type { KdsActions, KdsState } from "../data/contract";
import FocusView from "./focus/FocusView";
import MatrixView from "./matrix/MatrixView";
import BatchView from "./batch/BatchView";
import TimelineView from "./timeline/TimelineView";
import FlowView from "./flow/FlowView";
import { OrderDetail } from "./shared/Workbench";

vi.mock("../print/printSlip", () => ({ printSlip: vi.fn(async () => "printed") }));
afterEach(() => { cleanup(); vi.useRealTimers(); });

function card(id = "a", table = "3"): Card {
  return { order: { id, table, type: "new", start: 0, items: [{ name: "鯛めし", qty: 2, options: "大盛り", allergies: "卵" }] }, doneCounts: [0], konro: {}, finishing: false };
}
function state(cards = [card()]): KdsState {
  return { cards, stock: [{ rid: "r1", time: "12:30", name: "山田", adults: 2, menu: [{ name: "鯛めし", qty: 2 }] }], now: 720000, connection: "ok" };
}
const actions = (): KdsActions => ({ completeOne: vi.fn(), undoOne: vi.fn(), setKonro: vi.fn(), seatReservation: vi.fn() });

describe.each([
  ["フォーカス", FocusView], ["マトリクス", MatrixView], ["まとめ調理", BatchView], ["タイムライン", TimelineView], ["調理リレー", FlowView],
] as const)("%s", (_, View) => {
  it("正しい注文の1個を完了でき、完了行を再タップすると戻せる", () => {
    const a = actions();
    const s = state();
    const { rerender } = render(<View state={s} actions={a} />);
    fireEvent.click(screen.getByRole("button", { name: "3卓 鯛めし 大盛り 0/2個完了・1個完了" }));
    expect(a.completeOne).toHaveBeenCalledWith("a", 0);
    const complete = { ...s, cards: [{ ...s.cards[0], doneCounts: [2], finishing: true }] };
    rerender(<View state={complete} actions={a} />);
    fireEvent.click(screen.getByRole("button", { name: "3卓 鯛めし 大盛り 2/2個完了・1個戻す" }));
    expect(a.undoOne).toHaveBeenCalledWith("a", 0);
    expect(screen.getAllByText(/アレルギー: 卵/).length).toBeGreaterThan(0);
  });

  it("予約の来店を卓番付きで通知できる", () => {
    const a = actions();
    render(<View state={state()} actions={a} />);
    fireEvent.click(screen.getByRole("button", { name: /予約 1/ }));
    fireEvent.click(screen.getByRole("button", { name: "来店" }));
    const pad = screen.getByRole("dialog", { name: "12:30 山田" });
    fireEvent.click(within(pad).getByRole("button", { name: "A" }));
    fireEvent.click(within(pad).getByRole("button", { name: "2" }));
    fireEvent.click(within(pad).getByRole("button", { name: "決定" }));
    expect(a.seatReservation).toHaveBeenCalledWith("r1", "A2");
  });

  it("注文ゼロと通信断を明示する", () => {
    render(<View state={{ ...state([]), connection: "offline" }} actions={actions()} />);
    expect(screen.getByText("注文はありません")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("受信できません");
  });
});

it("フォーカスは新着・並び替えで選択を奪わず、選択注文が消えたら次を表示する", () => {
  const a = actions(), first = card(), second = card("b", "7");
  const { rerender } = render(<FocusView state={state([first, second])} actions={a} />);
  const queue = screen.getByRole("complementary", { name: "注文キュー" });
  fireEvent.click(within(queue).getAllByRole("button")[3]);
  rerender(<FocusView state={state([card("c", "9"), first, second])} actions={a} />);
  expect(within(screen.getByRole("main")).getByRole("button", { name: /7卓 鯛めし/ })).toBeTruthy();
  rerender(<FocusView state={state([first])} actions={a} />);
  expect(within(screen.getByRole("main")).getByRole("button", { name: /3卓 鯛めし/ })).toBeTruthy();
});

it("集約表示でも同じ卓への追加注文と重複品目を別々に操作する", () => {
  const a = actions(), first = card("a"), second = card("b");
  second.order.items.push({ ...second.order.items[0], qty: 1 });
  second.doneCounts.push(0);
  render(<MatrixView state={state([first, second])} actions={a} />);
  const items = screen.getAllByRole("button", { name: /3卓 鯛めし 大盛り .*1個完了/ });
  fireEvent.click(items[1]);
  fireEvent.click(items[2]);
  expect(vi.mocked(a.completeOne).mock.calls).toEqual([["b", 0], ["b", 1]]);
});

it("途中の個数を長押しで1個戻し、離したクリックでは再完了しない", () => {
  vi.useFakeTimers();
  const a = actions(), c = { ...card(), doneCounts: [1] };
  render(<BatchView state={state([c])} actions={a} />);
  const button = screen.getByRole("button", { name: /1\/2個完了/ });
  fireEvent.pointerDown(button, { clientX: 0, clientY: 0 });
  act(() => vi.advanceTimersByTime(800));
  fireEvent.pointerUp(button);
  fireEvent.click(button);
  expect(a.undoOne).toHaveBeenCalledExactlyOnceWith("a", 0);
  expect(a.completeOne).not.toHaveBeenCalled();
});

it("コンロは他卓使用中を選べず、割当→タイマー→解除の操作を渡す", () => {
  const a = actions(), first = card(), other = { ...card("b", "7"), konro: { 2: "white" as const } };
  const s = state([first, other]);
  const { rerender } = render(<OrderDetail card={first} state={s} actions={a} />);
  fireEvent.click(screen.getByRole("button", { name: /コンロ未割当/ }));
  expect((screen.getByRole("button", { name: "2番 他卓使用中" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "1番 空き・割り当てる" }));
  expect(a.setKonro).toHaveBeenLastCalledWith("a", 1, "white");
  const assigned = { ...first, konro: { 1: "white" as const } };
  rerender(<OrderDetail card={assigned} state={state([assigned, other])} actions={a} />);
  fireEvent.click(screen.getByRole("button", { name: "1番 コンロ・タイマーにする" }));
  expect(a.setKonro).toHaveBeenLastCalledWith("a", 1, "red");
  const timed = { ...first, konro: { 1: "red" as const } };
  rerender(<OrderDetail card={timed} state={state([timed, other])} actions={a} />);
  fireEvent.click(screen.getByRole("button", { name: "1番 タイマー・解除する" }));
  expect(a.setKonro).toHaveBeenLastCalledWith("a", 1, null);
});
