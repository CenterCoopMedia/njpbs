// Exercises the exact inline snippet that ships in the document head (issue #306),
// by evaluating the shipped string against fake window/console globals — the same
// way the browser runs it against the real ones. Keeping the test on the emitted
// string (not a separate copy of the logic) means it fails if the snippet drifts.
import { describe, expect, it } from "vitest";
import {
  EARLY_CONSOLE_CAPTURE_SNIPPET,
} from "../src/lib/console-capture-early";
import {
  EARLY_CAPTURE_GLOBAL_KEY,
  MAX_ENTRIES,
  MAX_MESSAGE_LENGTH,
} from "../src/lib/console-capture";

interface Slot {
  buffer: { level: string; message: string; timestamp: string }[];
  originals: Record<string, (...args: unknown[]) => void>;
}

// Run the shipped snippet with window/console shadowed by the passed fakes. The
// snippet references bare `window` and `console`; as Function parameters they
// resolve to these arguments, exactly as they resolve to the browser globals.
function runSnippet(win: Record<string, unknown>, con: Record<string, unknown>): void {
  new Function("window", "console", EARLY_CONSOLE_CAPTURE_SNIPPET)(win, con);
}

// A console double that records pass-through calls, so a test can assert both the
// capture and that the original method still ran.
function makeConsole() {
  const passthrough: [string, unknown[]][] = [];
  const con: Record<string, unknown> = {};
  for (const level of ["log", "warn", "error", "info"]) {
    con[level] = (...args: unknown[]) => passthrough.push([level, args]);
  }
  return { con, passthrough };
}

describe("early console capture snippet", () => {
  it("installs the shared slot and captures a call while calling through", () => {
    const { con, passthrough } = makeConsole();
    const win: Record<string, unknown> = {};
    runSnippet(win, con);

    (con.error as (...a: unknown[]) => void)("boom", 42);

    const slot = win[EARLY_CAPTURE_GLOBAL_KEY] as Slot;
    expect(slot.buffer).toHaveLength(1);
    expect(slot.buffer[0]).toMatchObject({ level: "error", message: "boom 42" });
    // The captured original still ran, so dev-tools output is preserved.
    expect(passthrough).toContainEqual(["error", ["boom", 42]]);
  });

  it("records a boot-time error thrown before any adopting module runs", () => {
    const { con } = makeConsole();
    const win: Record<string, unknown> = {};
    runSnippet(win, con);

    // Simulate an earlier page script logging an error during boot.
    (con.error as (...a: unknown[]) => void)("player failed to init");

    const slot = win[EARLY_CAPTURE_GLOBAL_KEY] as Slot;
    expect(slot.buffer.map((e) => e.message)).toContain("player failed to init");
  });

  it("stashes the real methods so an adopter can unwrap without double-recording", () => {
    const { con } = makeConsole();
    const original = con.log;
    const win: Record<string, unknown> = {};
    runSnippet(win, con);

    const slot = win[EARLY_CAPTURE_GLOBAL_KEY] as Slot;
    expect(slot.originals.log).toBe(original);
    // The live method is the wrapper, not the original.
    expect(con.log).not.toBe(original);
  });

  it("clamps a long message and keeps only the most recent entries", () => {
    const { con } = makeConsole();
    const win: Record<string, unknown> = {};
    runSnippet(win, con);
    const log = con.log as (...a: unknown[]) => void;

    log("x".repeat(MAX_MESSAGE_LENGTH + 500));
    for (let i = 0; i < MAX_ENTRIES + 10; i++) log(`m${i}`);

    const slot = win[EARLY_CAPTURE_GLOBAL_KEY] as Slot;
    expect(slot.buffer).toHaveLength(MAX_ENTRIES);
    // The oversized first entry was pushed out; the tail is the last MAX_ENTRIES.
    expect(slot.buffer[slot.buffer.length - 1].message).toBe(`m${MAX_ENTRIES + 9}`);
    for (const entry of slot.buffer) {
      expect(entry.message.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
    }
  });

  it("stringifies exotic values without throwing", () => {
    const { con } = makeConsole();
    const win: Record<string, unknown> = {};
    runSnippet(win, con);
    const log = con.log as (...a: unknown[]) => void;

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => log(circular, new TypeError("bad"), undefined, null)).not.toThrow();

    const slot = win[EARLY_CAPTURE_GLOBAL_KEY] as Slot;
    const message = slot.buffer[0].message;
    expect(message).toContain("TypeError: bad");
    expect(message).toContain("undefined");
    expect(message).toContain("null");
  });

  it("does not reinstall over an existing slot (idempotent across scripts)", () => {
    const { con } = makeConsole();
    const win: Record<string, unknown> = {};
    runSnippet(win, con);
    const firstSlot = win[EARLY_CAPTURE_GLOBAL_KEY];
    const wrappedLog = con.log;

    runSnippet(win, con);

    // Same slot, and the console was not wrapped a second time.
    expect(win[EARLY_CAPTURE_GLOBAL_KEY]).toBe(firstSlot);
    expect(con.log).toBe(wrappedLog);
  });

  it("leaves the console untouched when a method is non-writable", () => {
    const { con } = makeConsole();
    const original = con.error;
    Object.defineProperty(con, "error", {
      value: original,
      writable: false,
      configurable: true,
    });
    const win: Record<string, unknown> = {};

    expect(() => runSnippet(win, con)).not.toThrow();
    // Install bailed: no slot, and the writable methods it had already wrapped
    // were put back, so nothing is left half-hooked.
    expect(win[EARLY_CAPTURE_GLOBAL_KEY]).toBeUndefined();
    expect(con.error).toBe(original);
  });
});
