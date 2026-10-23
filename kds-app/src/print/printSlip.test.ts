import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Order } from "../types";
import { printSlip } from "./printSlip";

const order: Order = {
  id: "o1", table: "A3", type: "new", start: new Date(2026, 9, 23, 12, 5).getTime(),
  items: [{ name: "土鍋飯", qty: 2, options: "大盛", allergies: "えび" }],
};

function mockFetch(printRes: () => Promise<Response>) {
  return vi.fn((url: string) =>
    url === "/api/slip-style" ? Promise.resolve(new Response("{}", { status: 200 })) : printRes());
}

describe("printSlip", () => {
  beforeEach(() => { localStorage.clear(); vi.spyOn(console, "error").mockImplementation(() => {}); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("/api/print が成功したら printed。window.print は呼ばない", async () => {
    const f = mockFetch(() => Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })));
    vi.stubGlobal("fetch", f);
    const p = vi.fn(); window.print = p;
    expect(await printSlip(order)).toBe("printed");
    expect(p).not.toHaveBeenCalled();
    const call = f.mock.calls.find((c) => c[0] === "/api/print") as unknown as [string, { body: string }];
    const body = JSON.parse(call[1].body);
    expect(body.table).toBe("A3");
    expect(body.items[0].note).toBe("大盛 / アレルギー: えび");
  });

  it("/api/print が失敗したら window.print にフォールバックし、DOM を片付ける", async () => {
    vi.stubGlobal("fetch", mockFetch(() => Promise.resolve(new Response(JSON.stringify({ ok: false }), { status: 400 }))));
    let during = false;
    window.print = vi.fn(() => { during = !!document.getElementById("kds-print-slip"); });
    expect(await printSlip(order)).toBe("browser");
    expect(window.print).toHaveBeenCalledTimes(1);
    expect(during).toBe(true);
    expect(document.getElementById("kds-print-slip")).toBeNull();
  });

  it("fetch が例外でもブラウザ印刷、window.print も失敗なら failed", async () => {
    vi.stubGlobal("fetch", mockFetch(() => Promise.reject(new Error("net"))));
    window.print = vi.fn(() => { throw new Error("x"); });
    expect(await printSlip(order)).toBe("failed");
  });
});
