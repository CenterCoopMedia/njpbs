// Console capture for the "report a problem" widget.
//
// Intercepts console methods and keeps the most recent entries in a circular
// buffer, so a bug report can carry the debugging context the reporter saw
// without asking them to copy anything. Framework-free typed code can be
// imported by the Astro island.
//
// The original console methods are always called through, so dev tools keep
// working exactly as before. Nothing here sends data anywhere; it only records
// into an in-memory buffer that the report form reads at submit time.

export type ConsoleLevel = "log" | "warn" | "error" | "info";

export interface ConsoleEntry {
  level: ConsoleLevel;
  message: string;
  timestamp: string;
}

// Exported so the boot-time primitive (console-capture-early) inlines the same
// caps into its head snippet, and the two never drift.
export const MAX_ENTRIES = 50;
export const MAX_MESSAGE_LENGTH = 500;
const LEVELS: ConsoleLevel[] = ["log", "warn", "error", "info"];

// The global slot where the boot-time capture primitive leaves its buffer and
// the real console methods it hooked. The primitive is an inline <script> in the
// document head (console-capture-early), so it starts recording before any other
// page script; initConsoleCapture then adopts that buffer, so a boot-time error
// and everything after share one buffer, not two.
export const EARLY_CAPTURE_GLOBAL_KEY = "__njpbsConsoleCapture";

let logBuffer: ConsoleEntry[] = [];
let initialized = false;

type ConsoleMethod = (...args: unknown[]) => void;

// Captured references to the real console methods, so init can wrap them and
// restore can put them back. Populated lazily on init from the live console so
// a test that stubs console before init still wraps the stub, not a stale ref.
const originalConsole: Record<ConsoleLevel, ConsoleMethod | null> = {
  log: null,
  warn: null,
  error: null,
  info: null,
};

// Stringify a value without throwing on circular references or exotic objects.
// A logging path must never itself become the error, so every branch has a
// fallback and the JSON pass swaps circular references for a marker.
export function safeStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value instanceof Error) {
    return `${value.name}: ${value.message}`;
  }
  try {
    const seen = new WeakSet<object>();
    return JSON.stringify(value, (_key, val) => {
      if (typeof val === "object" && val !== null) {
        if (seen.has(val)) return "[Circular]";
        seen.add(val);
      }
      return val;
    }) as string;
  } catch {
    // Last-resort stringify. String() itself can throw on a null-prototype object
    // or a throwing Symbol.toPrimitive, and capture must never make logging fail.
    try {
      return String(value);
    } catch {
      return "[unserializable]";
    }
  }
}

function addEntry(level: ConsoleLevel, args: unknown[]): void {
  const message = args
    .map(safeStringify)
    .join(" ")
    .substring(0, MAX_MESSAGE_LENGTH);

  logBuffer.push({ level, message, timestamp: new Date().toISOString() });

  // Circular buffer: drop the oldest once we exceed the cap.
  if (logBuffer.length > MAX_ENTRIES) {
    logBuffer.shift();
  }
}

function createWrapper(
  level: ConsoleLevel,
  original: ConsoleMethod,
): ConsoleMethod {
  return function wrapped(...args: unknown[]): void {
    addEntry(level, args);
    original.apply(console, args);
  };
}

// Shape of the slot the head primitive installs. Declared structurally here
// (rather than imported from console-capture-early) so this module never pulls
// the inline-snippet string into the report island's client bundle.
interface EarlyCaptureSlot {
  buffer: ConsoleEntry[];
  originals: Partial<Record<ConsoleLevel, ConsoleMethod>>;
}

// Adopt the boot-time buffer the head primitive installed, if present. Point this
// module's buffer at the same array so the early entries survive, then restore
// the real console methods the primitive stashed, so the wrap loop below wraps
// the originals and not the primitive's temporary wrappers (double-wrapping would
// record every later call twice). A no-op when there is no slot: unit tests, and
// any page that does not emit the head primitive.
function adoptEarlyCapture(): void {
  const slot = (globalThis as Record<string, unknown>)[EARLY_CAPTURE_GLOBAL_KEY] as
    | EarlyCaptureSlot
    | undefined;
  if (!slot || !Array.isArray(slot.buffer)) return;
  logBuffer = slot.buffer;
  const originals = slot.originals || {};
  for (const level of LEVELS) {
    const real = originals[level];
    if (real) console[level] = real as Console[ConsoleLevel];
  }
}

// Wrap console.log/warn/error/info once. Safe to call more than once; repeat
// calls are ignored so the wrappers never wrap each other.
export function initConsoleCapture(): void {
  if (initialized) return;
  if (typeof console === "undefined") return;
  // Take over the boot-time buffer (and unwrap the primitive) before wrapping, so
  // the earliest entries survive and this module becomes the single capture owner.
  adoptEarlyCapture();
  // Some environments make console methods non-writable, so assigning throws.
  // Capture is optional, so on failure restore anything already wrapped and
  // leave the console untouched rather than aborting the island script.
  const wrapped: ConsoleLevel[] = [];
  try {
    for (const level of LEVELS) {
      const original = console[level] as ConsoleMethod;
      originalConsole[level] = original;
      console[level] = createWrapper(level, original) as Console[ConsoleLevel];
      wrapped.push(level);
    }
    initialized = true;
  } catch {
    for (const level of wrapped) {
      const original = originalConsole[level];
      if (original) console[level] = original as Console[ConsoleLevel];
      originalConsole[level] = null;
    }
    initialized = false;
  }
}

// Current buffer contents, oldest first. Returns a copy so a caller can hold
// the snapshot it read at submit time without it mutating underneath them.
export function getConsoleLogs(): ConsoleEntry[] {
  return [...logBuffer];
}

export function clearConsoleLogs(): void {
  logBuffer = [];
}

// Put the real console methods back. Used by tests and by any teardown that
// wants the capture gone; leaves the buffer intact so a final read still works.
export function restoreConsole(): void {
  if (!initialized) return;
  for (const level of LEVELS) {
    const original = originalConsole[level];
    if (original) {
      console[level] = original as Console[ConsoleLevel];
    }
    originalConsole[level] = null;
  }
  initialized = false;
}
