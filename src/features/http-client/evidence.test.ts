import { describe, expect, it, vi } from "vitest";
import type { HttpExchange } from "@/platform/ipc";
import { evidenceCanvas, evidenceRows } from "./evidence";

function exchange(over: Partial<HttpExchange> = {}): HttpExchange {
  return {
    entry: {
      id: "e1",
      timeMs: 1_700_000_000_000,
      name: "login",
      method: "POST",
      url: "https://example.test/login",
      status: 200,
      totalMs: 12,
      file: null,
      error: null,
    },
    request: {
      name: "login",
      method: "POST",
      url: "https://example.test/login",
      headers: [["Content-Type", "application/json"]],
      body: '{"user":"me"}',
    },
    response: null,
    scriptLogs: [],
    scriptError: null,
    ...over,
  };
}

describe("evidence image", () => {
  it("contains the full request and response without branding", () => {
    const text = evidenceRows(
      exchange({
        response: {
          status: 200,
          statusText: "OK",
          version: "HTTP/1.1",
          headers: [["Content-Type", "application/json"]],
          contentType: "application/json",
          body: '{"token":"abc"}',
          size: 16,
          truncated: false,
          ttfbMs: 8,
          totalMs: 12,
        },
      }),
    )
      .map((row) => row.text)
      .join("\n");
    expect(text).toContain("POST https://example.test/login");
    expect(text).toContain("Request time:");
    expect(text).toContain("Content-Type: application/json");
    expect(text).toContain('{"user":"me"}');
    expect(text).toContain("200 OK · HTTP/1.1");
    expect(text).toContain('"token": "abc"');
    expect(text).not.toContain("OpenIDEA");
    expect(text).not.toContain("evidence");
  });

  it("colours request and response headings", () => {
    const rows = evidenceRows(exchange());
    expect(rows.find((row) => row.text === "Request")?.color).toBe("#79c0ff");
    expect(rows.find((row) => row.text === "Response")?.color).toBe("#7ee787");
  });

  it("draws a black card with white text", () => {
    const ctx = {
      font: "",
      fillStyle: "",
      textBaseline: "",
      scale: vi.fn(),
      fillRect: vi.fn(),
      fillText: vi.fn(),
      measureText: (text: string) => ({ width: text.length * 8 }),
    };
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    try {
      evidenceCanvas(exchange());
      expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, 1200, expect.any(Number));
      expect(ctx.fillText.mock.calls.map((call) => call[0]).join("\n")).toContain("POST https://example.test/login");
      expect(ctx.fillText.mock.calls.map((call) => call[0]).join("\n")).not.toContain("OpenIDEA");
    } finally {
      getContext.mockRestore();
    }
  });
});
