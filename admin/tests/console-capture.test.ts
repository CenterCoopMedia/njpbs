import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearConsoleLogs,
  getConsoleLogs,
  initConsoleCapture,
  restoreConsole,
} from "../src/lib/console-capture";

afterEach(() => {
  restoreConsole();
  clearConsoleLogs();
  vi.restoreAllMocks();
});

describe("Admin console capture", () => {
  it("keeps debug messages and calls the original console", () => {
    const original = vi.spyOn(console, "debug").mockImplementation(() => {});
    initConsoleCapture();

    console.debug("Save state", { status: 409 });

    expect(getConsoleLogs()).toEqual([
      expect.objectContaining({
        level: "debug",
        message: 'Save state {"status":409}',
      }),
    ]);
    expect(original).toHaveBeenCalledWith("Save state", { status: 409 });
  });

  it("bounds the buffer and redacts values under sensitive object keys", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    initConsoleCapture();

    for (let index = 0; index < 105; index += 1) {
      console.log({ index, accessToken: "private-value" });
    }

    const logs = getConsoleLogs();
    expect(logs).toHaveLength(100);
    expect(logs[0].message).toContain('"index":5');
    expect(logs[0].message).toContain('"accessToken":"[redacted]"');
    expect(logs[0].message).not.toContain("private-value");
  });

  it("drops empty calls and bounds multibyte messages by UTF-8 bytes", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    initConsoleCapture();

    console.log();
    console.log("   ");
    console.log("漢".repeat(1_000));

    const logs = getConsoleLogs();
    expect(logs).toHaveLength(1);
    expect(new TextEncoder().encode(logs[0].message).byteLength).toBeLessThanOrEqual(1_000);
    expect(logs[0].message.endsWith("…")).toBe(true);
  });

  it("keeps object values up to the expanded value limit", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    initConsoleCapture();

    console.log({ detail: "x".repeat(600) });

    const detail = JSON.parse(getConsoleLogs()[0].message).detail as string;
    expect(new TextEncoder().encode(detail).byteLength).toBe(500);
    expect(detail.endsWith("…")).toBe(true);
  });

  it("redacts labeled, known-format, and opaque standalone credentials", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    initConsoleCapture();

    console.error("authorization: Bearer private-value");
    console.error("ghp_abcdefghijklmnopqrstuvwxyz123456");
    console.error("a1b2c3d4e5f6g7h8i9j0k1l2m3n4");
    console.error("GET /callback?access_token=oauth-private&state=kept");

    const messages = getConsoleLogs().map((entry) => entry.message);
    expect(messages).toEqual([
      "authorization: [redacted]",
      "[redacted token]",
      "[redacted opaque value]",
      "GET /callback?access_token=[redacted]&state=kept",
    ]);
    expect(messages.join(" ")).not.toContain("private-value");
  });

  it("preserves bounded Date and URL evidence", () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    initConsoleCapture();

    console.info(
      new Date("2026-08-29T19:00:00.000Z"),
      new URL("https://admin.njpbs.org/callback?access_token=private&state=kept"),
    );

    const message = getConsoleLogs()[0].message;
    expect(message).toContain("2026-08-29T19:00:00.000Z");
    expect(message).toContain("access_token=[redacted]&state=kept");
    expect(message).not.toContain("private");
  });

  it("keeps bounded Error stack and cause details", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    initConsoleCapture();
    const cause = new Error("token=private-value");
    cause.stack = "Error: token=private-value\n    at save.ts:40:9";
    const error = new Error("Save failed", { cause });
    error.stack = "Error: Save failed\n    at RouteErrorBoundary (ReportsRoute.tsx:44:7)";

    console.error(error);

    const message = getConsoleLogs()[0].message;
    expect(message).toContain("RouteErrorBoundary");
    expect(message).toContain("save.ts:40:9");
    expect(message).not.toContain("private-value");
    expect(new TextEncoder().encode(message).byteLength).toBeLessThanOrEqual(1_000);
  });

  it("captures uncaught errors and unhandled promise rejections", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    initConsoleCapture();

    window.dispatchEvent(new ErrorEvent("error", {
      message: "Route crashed",
      error: new Error("Route crashed"),
    }));
    const rejection = new Event("unhandledrejection") as PromiseRejectionEvent;
    Object.defineProperty(rejection, "reason", { value: new Error("Save rejected") });
    window.dispatchEvent(rejection);

    const messages = getConsoleLogs().map((entry) => entry.message);
    expect(messages[0]).toContain("Uncaught browser error");
    expect(messages[0]).toContain("Route crashed");
    expect(messages[1]).toContain("Unhandled promise rejection");
    expect(messages[1]).toContain("Save rejected");
  });

  it("bounds object depth and properties without invoking accessors", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    initConsoleCapture();
    const value: Record<string, unknown> = {};
    Object.defineProperty(value, "dangerous", {
      enumerable: true,
      get: () => {
        throw new Error("getter must not run");
      },
    });
    for (let index = 0; index < 25; index += 1) value[`field${index}`] = index;
    value.nested = { one: { two: { three: "too deep" } } };

    console.log(value);

    const message = getConsoleLogs()[0].message;
    expect(message).toContain('"…":"[more properties omitted]"');
    expect(message).not.toContain("getter must not run");
    expect(new TextEncoder().encode(message).byteLength).toBeLessThanOrEqual(1_000);
  });
});
