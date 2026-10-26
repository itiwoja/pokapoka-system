import { act, renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import { sampleState, useLabData } from "./useLabData";

it("混雑シーンでも注文IDが重複せず、空シーンを作れる", () => {
  expect(new Set(sampleState(16).cards.map((c) => c.order.id)).size).toBe(16);
  expect(sampleState(0).cards).toEqual([]);
});

it("サンプル操作は保存済み注文を変更せず、リセットできる", () => {
  localStorage.setItem("kds_stock_v1", "existing");
  const { result } = renderHook(useLabData);
  act(() => result.current.actions.completeOne("lab-0", 0));
  expect(result.current.state.cards[0].doneCounts[0]).toBe(1);
  act(() => result.current.actions.setKonro("lab-1", 1, "red"));
  expect(result.current.state.cards[0].konro[1]).toBeUndefined();
  expect(result.current.state.cards[1].konro[1]).toBe("red");
  act(() => result.current.actions.seatReservation("mock-r1", "8"));
  expect(result.current.state.stock).toHaveLength(2);
  expect(result.current.state.cards).toHaveLength(8);
  expect(localStorage.getItem("kds_stock_v1")).toBe("existing");
  act(() => result.current.reset(3));
  expect(result.current.state.cards).toHaveLength(3);
  expect(result.current.state.cards[0].doneCounts[0]).toBe(0);
});
