import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearConsoleLogs,
  EARLY_CAPTURE_GLOBAL_KEY,
  getConsoleLogs,
  initConsoleCapture,
  restoreConsole,
  safeStringify,
} from "../src/lib/console-capture";

afterEach(() => {
  // Always unwrap and empty the buffer so one test never leaks capture state
  // (or a wrapped console) into the next.
  restoreConsole();
  clearConsoleLogs();
  vi.restoreAllMocks();
});

describe("safeStringify", () => {
  it("passes strings through and stringifies primitives", () => {
    expect(safeStringify("hello")).toBe("hello");
    expect(safeStringify(42)).toBe("42");
    expect(safeStringify(true)).toBe("true");
    expect(safeStringify(null)).toBe("null");
    expect(safeStringify(undefined)).toBe("undefined");
  });

  it("renders an Error as name: message, not {}", () => {
    expect(safeStringify(new TypeError("boom"))).toBe("TypeError: boom");
  });

  it("does not throw on a circular object", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    const out = safeStringify(a);
    expect(out).toContain("[Circular]");
    expect(out).toContain('"name":"a"');
  });

  it("returns a marker instead of throwing when both JSON and String() fail", () => {
    // A null-prototype object with a throwing getter makes JSON.stringify throw,
    // and String() on a null-prototype object also throws (no toString). Capture
    // must never make logging itself the error.
    const hostile = Object.create(null);
    Object.defineProperty(hostile, "x", {
      enumerable: true,
      get() {
        throw new Error("boom");
      },
    });
    expect(() => safeStringify(hostile)).not.toThrow();
    expect(safeStringify(hostile)).toBe("[unserializable]");
  });
});

describe("initConsoleCapture", () => {
  it("captures a console.log call while still calling through", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    initConsoleCapture();

    console.log("hello", 123);

    const logs = getConsoleLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0].level).toBe("log");
    expect(logs[0].message).toBe("hello 123");
    // The original (spied) method still ran, so dev tools output is preserved.
    expect(spy).toHaveBeenCalledWith("hello", 123);
  });

  it("captures each level under its own label", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    initConsoleCapture();

    console.warn("w");
    console.error("e");
    console.info("i");

    expect(getConsoleLogs().map((l) => l.level)).toEqual([
      "warn",
      "error",
      "info",
    ]);
  });

  it("is idempotent — a second init does not double-wrap", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    initConsoleCapture();
    initConsoleCapture();

    console.log("once");

    // A double wrap would record two entries for one call.
    expect(getConsoleLogs()).toHaveLength(1);
  });
});

describe("buffer behavior", () => {
  it("truncates a long message to 500 chars", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    initConsoleCapture();

    console.log("x".repeat(1000));

    expect(getConsoleLogs()[0].message).toHaveLength(500);
  });

  it("keeps only the most recent 50 entries", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    initConsoleCapture();

    for (let i = 0; i < 60; i++) console.log(`m${i}`);

    const logs = getConsoleLogs();
    expect(logs).toHaveLength(50);
    // Oldest ten dropped: first surviving entry is m10, last is m59.
    expect(logs[0].message).toBe("m10");
    expect(logs[49].message).toBe("m59");
  });

  it("getConsoleLogs returns a copy, not the live buffer", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    initConsoleCapture();
    console.log("one");

    const snapshot = getConsoleLogs();
    console.log("two");

    // The earlier snapshot must not have grown.
    expect(snapshot).toHaveLength(1);
    expect(getConsoleLogs()).toHaveLength(2);
  });

  it("clearConsoleLogs empties the buffer", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    initConsoleCapture();
    console.log("gone");

    clearConsoleLogs();

    expect(getConsoleLogs()).toHaveLength(0);
  });
});

describe("early-capture adoption (#306)", () => {
  // The head primitive leaves its buffer and the real console methods on a global
  // slot; initConsoleCapture must adopt that buffer so a boot-time entry appears
  // in a report and both surfaces read one buffer, not two.
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[EARLY_CAPTURE_GLOBAL_KEY];
  });

  it("surfaces a boot-time entry and appends later logs to the same buffer", () => {
    // Stub the four levels so capture writes nowhere real; use those stubs as the
    // "real" methods the primitive would have stashed on the slot.
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});

    const buffer = [
      { level: "error" as const, message: "boot boom", timestamp: "2026-07-01T00:00:00.000Z" },
    ];
    (globalThis as Record<string, unknown>)[EARLY_CAPTURE_GLOBAL_KEY] = {
      buffer,
      originals: {
        log: console.log,
        warn: console.warn,
        error: console.error,
        info: console.info,
      },
    };

    initConsoleCapture();
    console.warn("after adoption");

    // The boot error survived and the later warn landed in the same buffer.
    expect(getConsoleLogs().map((l) => l.message)).toEqual(["boot boom", "after adoption"]);
    // The module writes into the adopted array itself, so it is one source of truth.
    expect(buffer.map((l) => l.message)).toEqual(["boot boom", "after adoption"]);
  });

  it("does not double-record: it unwraps the primitive before wrapping", () => {
    // The primitive's stashed "originals" are the real (stubbed) methods. After
    // adoption a single call must record exactly one entry, not two.
    const errorStub = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});

    (globalThis as Record<string, unknown>)[EARLY_CAPTURE_GLOBAL_KEY] = {
      buffer: [],
      originals: {
        log: console.log,
        warn: console.warn,
        error: console.error,
        info: console.info,
      },
    };

    initConsoleCapture();
    console.error("once");

    expect(getConsoleLogs()).toHaveLength(1);
    // The real method still ran exactly once through the single wrapper.
    expect(errorStub).toHaveBeenCalledTimes(1);
  });

  it("wraps a fresh buffer when no early slot is present", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    initConsoleCapture();
    console.log("fresh");
    expect(getConsoleLogs().map((l) => l.message)).toEqual(["fresh"]);
  });
});

describe("restoreConsole", () => {
  it("stops capturing after restore", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    initConsoleCapture();

    restoreConsole();
    console.log("after restore");

    expect(getConsoleLogs()).toHaveLength(0);
  });
});

describe("initConsoleCapture fail-safe", () => {
  it("does not throw or half-wrap the console when a method is non-writable", () => {
    // Some environments make console methods non-writable; assigning to one
    // throws in strict mode (which ES modules run under). Capture is optional,
    // so init must fail safe: leave the console untouched, not abort the island.
    const originalError = console.error;
    const errorDescriptor = Object.getOwnPropertyDescriptor(console, "error");
    Object.defineProperty(console, "error", {
      value: originalError,
      writable: false,
      configurable: true,
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      expect(() => initConsoleCapture()).not.toThrow();
      // Init bailed and restored the methods it had already wrapped, so a later
      // log is not captured and console.error is still the original.
      console.log("after failed init");
      expect(getConsoleLogs()).toHaveLength(0);
      expect(console.error).toBe(originalError);
    } finally {
      if (errorDescriptor) {
        Object.defineProperty(console, "error", errorDescriptor);
      }
    }
  });
});
