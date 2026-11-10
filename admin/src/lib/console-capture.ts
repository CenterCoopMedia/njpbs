export type ConsoleLevel = "debug" | "log" | "info" | "warn" | "error";

export interface ConsoleEntry {
  level: ConsoleLevel;
  message: string;
  timestamp: string;
}

const LEVELS: ConsoleLevel[] = ["debug", "log", "info", "warn", "error"];
const MAX_ENTRIES = 100;
const MAX_MESSAGE_LENGTH = 1_000;
const MAX_VALUE_LENGTH = 500;
const MAX_STACK_LENGTH = 1_500;
const MAX_DEPTH = 3;
const MAX_ITEMS = 20;
const SENSITIVE_KEY = /authorization|cookie|token|secret|password|api.?key/i;
const OPAQUE_VALUE = /^[A-Za-z0-9._~+/=-]{24,}$/;

type ConsoleMethod = (...args: unknown[]) => void;

let entries: ConsoleEntry[] = [];
let initialized = false;
const originals: Partial<Record<ConsoleLevel, ConsoleMethod>> = {};
let errorListener: ((event: ErrorEvent) => void) | undefined;
let rejectionListener: ((event: PromiseRejectionEvent) => void) | undefined;

function truncateUtf8(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  let result = "";
  for (const character of value) {
    if (encoder.encode(`${result}${character}…`).byteLength > maxBytes) break;
    result += character;
  }
  return `${result}…`;
}

function redactText(value: string): string {
  const redacted = value
    .replace(/\b(authorization)\s*[:=]\s*[^\n]+/gi, "$1: [redacted]")
    .replace(/\b(cookie|set-cookie)\s*[:=]\s*[^\n]+/gi, "$1=[redacted]")
    .replace(
      /(^|[^A-Za-z0-9])((?:(?:access|refresh|id|auth|session)[_ -]?)?(?:api[_ -]?key|token|secret|password))\s*[:=]\s*[^\n&]+/gi,
      "$1$2=[redacted]",
    )
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted token]")
    .replace(/\b(?:gh[pousr]_|github_pat_|AIza|AKIA|xox[baprs]-|sk-|pk_live_|rk_live_)[A-Za-z0-9._-]{12,}\b/g, "[redacted token]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted email]");
  const candidate = redacted.trim();
  if (
    OPAQUE_VALUE.test(candidate) &&
    new Set(candidate).size >= 6
  ) {
    return "[redacted opaque value]";
  }
  return redacted;
}

function safeString(value: string, maxBytes: number): string {
  const boundedInput = value.slice(0, maxBytes * 2);
  return truncateUtf8(redactText(boundedInput), maxBytes);
}

function boundedValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") {
    return safeString(value, MAX_VALUE_LENGTH);
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "symbol") return value.toString();
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  }
  if (typeof URL !== "undefined" && value instanceof URL) {
    return safeString(value.href, MAX_VALUE_LENGTH);
  }
  if (value instanceof Error) {
    const cause = (value as Error & { cause?: unknown }).cause;
    return {
      name: safeString(value.name, 80),
      message: safeString(value.message, MAX_VALUE_LENGTH),
      ...(value.stack
        ? { stack: safeString(value.stack, MAX_STACK_LENGTH) }
        : {}),
      ...(cause !== undefined && depth < MAX_DEPTH
        ? { cause: boundedValue(cause, depth + 1, seen) }
        : {}),
    };
  }
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  if (depth >= MAX_DEPTH) return "[Max depth]";
  seen.add(value);

  if (Array.isArray(value)) {
    const result = value
      .slice(0, MAX_ITEMS)
      .map((candidate) => boundedValue(candidate, depth + 1, seen));
    if (value.length > MAX_ITEMS) result.push(`[${value.length - MAX_ITEMS} more items]`);
    return result;
  }

  const result: Record<string, unknown> = {};
  let count = 0;
  try {
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      if (count >= MAX_ITEMS) {
        result["…"] = "[more properties omitted]";
        break;
      }
      count += 1;
      if (SENSITIVE_KEY.test(key)) {
        result[key] = "[redacted]";
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      result[key] = descriptor && "value" in descriptor
        ? boundedValue(descriptor.value, depth + 1, seen)
        : "[accessor omitted]";
    }
  } catch {
    return "[unserializable]";
  }
  return result;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return safeString(value, MAX_MESSAGE_LENGTH);
  const bounded = boundedValue(value, 0, new WeakSet<object>());
  return typeof bounded === "string" ? bounded : JSON.stringify(bounded);
}

function record(level: ConsoleLevel, values: unknown[]): void {
  const boundedValues = values.slice(0, MAX_ITEMS).map(stringify);
  if (values.length > MAX_ITEMS) boundedValues.push(`[${values.length - MAX_ITEMS} more arguments]`);
  const message = truncateUtf8(boundedValues.join(" ").trim(), MAX_MESSAGE_LENGTH);
  if (!message) return;
  entries.push({ level, message, timestamp: new Date().toISOString() });
  if (entries.length > MAX_ENTRIES) entries.shift();
}

export function initConsoleCapture(): void {
  if (initialized || typeof console === "undefined") return;
  const wrapped: ConsoleLevel[] = [];
  try {
    for (const level of LEVELS) {
      const original = console[level] as ConsoleMethod;
      originals[level] = original;
      console[level] = ((...values: unknown[]) => {
        record(level, values);
        original.apply(console, values);
      }) as Console[ConsoleLevel];
      wrapped.push(level);
    }
    if (typeof window !== "undefined") {
      errorListener = (event) => {
        record("error", ["Uncaught browser error", event.error ?? event.message]);
      };
      rejectionListener = (event) => {
        record("error", ["Unhandled promise rejection", event.reason]);
      };
      window.addEventListener("error", errorListener);
      window.addEventListener("unhandledrejection", rejectionListener);
    }
    initialized = true;
  } catch {
    if (typeof window !== "undefined") {
      if (errorListener) window.removeEventListener("error", errorListener);
      if (rejectionListener) window.removeEventListener("unhandledrejection", rejectionListener);
    }
    errorListener = undefined;
    rejectionListener = undefined;
    for (const level of wrapped) {
      const original = originals[level];
      if (original) console[level] = original as Console[ConsoleLevel];
      delete originals[level];
    }
  }
}

export function getConsoleLogs(): ConsoleEntry[] {
  return entries.map((entry) => ({ ...entry }));
}

export function clearConsoleLogs(): void {
  entries = [];
}

export function restoreConsole(): void {
  if (!initialized) return;
  if (typeof window !== "undefined") {
    if (errorListener) window.removeEventListener("error", errorListener);
    if (rejectionListener) window.removeEventListener("unhandledrejection", rejectionListener);
  }
  errorListener = undefined;
  rejectionListener = undefined;
  for (const level of LEVELS) {
    const original = originals[level];
    if (original) console[level] = original as Console[ConsoleLevel];
    delete originals[level];
  }
  initialized = false;
}
