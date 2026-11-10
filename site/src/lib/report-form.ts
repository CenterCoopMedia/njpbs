// Shared validation and bounded payload shaping for the "report a problem"
// widget. Client checks support the form; the server must enforce the same
// category, description, dwell, email, log and context bounds independently.
// This module has no DOM or network access.

import type { ConsoleEntry, ConsoleLevel } from "./console-capture";

export type CategoryId = "bug" | "suggestion" | "question";

export interface Category {
  id: CategoryId;
  label: string;
}

export const CATEGORIES: readonly Category[] = [
  { id: "bug", label: "Bug or error" },
  { id: "suggestion", label: "Suggestion" },
  { id: "question", label: "Question" },
];

export const CATEGORY_IDS: readonly CategoryId[] = CATEGORIES.map((c) => c.id);

export const MIN_DESCRIPTION_LENGTH = 10;
export const MAX_DESCRIPTION_LENGTH = 2000;
export const MIN_DWELL_MS = 3000;
export const MAX_CONSOLE_ENTRIES = 50;
// Bounds for the auto-collected context. These matter at the edge, where a direct
// POST is untrusted: without them a caller with a valid token could forward a
// megabyte url or 50 giant console entries into the report queue.
export const MAX_URL_LENGTH = 2048;
export const MAX_USER_AGENT_LENGTH = 512;
export const MAX_SCREEN_SIZE_LENGTH = 32;
export const MAX_CONSOLE_MESSAGE_LENGTH = 500;

const CONSOLE_LEVELS: readonly ConsoleLevel[] = ["log", "warn", "error", "info"];

// A deliberately forgiving email shape: one @, no spaces, a dot in the domain.
// The point is to reject obvious typos, not to certify deliverability, which
// only sending can prove. Matches the intent of the server-side isValidEmail.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidCategory(value: unknown): value is CategoryId {
  return typeof value === "string" && (CATEGORY_IDS as readonly string[]).includes(value);
}

// Trim if it is a string; anything else (number, object, null) collapses to ''.
// The server does the same so a non-string email never throws deeper in.
export function normalizeEmail(email: unknown): string {
  return typeof email === "string" ? email.trim() : "";
}

export function isValidEmail(email: string): boolean {
  return EMAIL_PATTERN.test(email);
}

// The address to actually use: normalized and valid, or null. Null means "no
// follow-up address", not an error, since email is optional.
export function deliverableEmail(email: unknown): string | null {
  const normalized = normalizeEmail(email);
  return normalized && isValidEmail(normalized) ? normalized : null;
}

export function clampDescription(description: string): string {
  return description.trim().substring(0, MAX_DESCRIPTION_LENGTH);
}

export function isDescriptionLongEnough(description: string): boolean {
  return description.trim().length >= MIN_DESCRIPTION_LENGTH;
}

export function passesDwell(timeElapsed: number): boolean {
  return typeof timeElapsed === "number" && timeElapsed >= MIN_DWELL_MS;
}

// Whether the submit button should be enabled. The dwell check is deliberately
// part of this: a real person spends more than three seconds on the form, an
// auto-submitting bot does not. The server re-checks dwell independently.
export function canSubmit(input: { description: string; timeElapsed: number }): boolean {
  return isDescriptionLongEnough(input.description) && passesDwell(input.timeElapsed);
}

export interface RawReportInput {
  category: unknown;
  description: string;
  email?: unknown;
  url?: string | null;
  userAgent?: string | null;
  screenSize?: string | null;
  consoleLogs?: ConsoleEntry[];
  formOpenedAt?: number | null;
  timeElapsed?: number | null;
  turnstileToken?: string | null;
}

export interface ReportPayload {
  category: CategoryId;
  description: string;
  email: string | null;
  url: string | null;
  userAgent: string | null;
  screenSize: string | null;
  consoleLogs: ConsoleEntry[];
  formOpenedAt: number | null;
  timeElapsed: number | null;
  turnstileToken: string | null;
}

// Clamp an untrusted value to a max length, or null if it is not a string. The
// edge treats a direct POST as hostile, so the shared shaper bounds the free-form
// context before anyone stores or forwards it.
function clampStringOrNull(value: unknown, max: number): string | null {
  return typeof value === "string" ? value.slice(0, max) : null;
}

// Normalize an untrusted console-log array: keep the last MAX_CONSOLE_ENTRIES and
// coerce each entry to a known level, a string message clamped to
// MAX_CONSOLE_MESSAGE_LENGTH, and a string timestamp. A direct POST can send any
// shape here, so the stored and forwarded logs are made uniform and bounded.
function normalizeConsoleLogs(logs: unknown): ConsoleEntry[] {
  if (!Array.isArray(logs)) return [];
  return logs.slice(-MAX_CONSOLE_ENTRIES).map((entry) => {
    const e = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const level = CONSOLE_LEVELS.includes(e.level as ConsoleLevel)
      ? (e.level as ConsoleLevel)
      : "log";
    const message = String(e.message ?? "").slice(0, MAX_CONSOLE_MESSAGE_LENGTH);
    const timestamp = typeof e.timestamp === "string" ? e.timestamp.slice(0, 40) : "";
    return { level, message, timestamp };
  });
}

// Shape the request body. Throws on an invalid category so a caller cannot send a
// report the server will only reject; every other field is normalized rather than
// rejected. Because the edge treats a direct POST as untrusted, this also bounds
// the free-form context: clamped description, deliverable-or-null email, length-
// clamped url / userAgent / screenSize, and console logs trimmed to the last
// MAX_CONSOLE_ENTRIES and normalized to a known level and a clamped message.
export function buildReportPayload(input: RawReportInput): ReportPayload {
  if (!isValidCategory(input.category)) {
    throw new Error(`Invalid category: ${String(input.category)}`);
  }
  return {
    category: input.category,
    description: clampDescription(input.description),
    email: deliverableEmail(input.email),
    url: clampStringOrNull(input.url, MAX_URL_LENGTH),
    userAgent: clampStringOrNull(input.userAgent, MAX_USER_AGENT_LENGTH),
    screenSize: clampStringOrNull(input.screenSize, MAX_SCREEN_SIZE_LENGTH),
    consoleLogs: normalizeConsoleLogs(input.consoleLogs),
    formOpenedAt: input.formOpenedAt ?? null,
    timeElapsed: input.timeElapsed ?? null,
    turnstileToken: input.turnstileToken ?? null,
  };
}
