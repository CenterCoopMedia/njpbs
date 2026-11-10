import { describe, expect, it } from "vitest";
import {
  buildReportPayload,
  canSubmit,
  CATEGORY_IDS,
  clampDescription,
  deliverableEmail,
  isDescriptionLongEnough,
  isValidCategory,
  isValidEmail,
  MAX_CONSOLE_ENTRIES,
  MAX_CONSOLE_MESSAGE_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_SCREEN_SIZE_LENGTH,
  MAX_URL_LENGTH,
  MAX_USER_AGENT_LENGTH,
  MIN_DWELL_MS,
  normalizeEmail,
  passesDwell,
} from "../src/lib/report-form";
import type { ConsoleEntry } from "../src/lib/console-capture";

describe("category", () => {
  it("accepts the three real categories and nothing else", () => {
    expect(CATEGORY_IDS).toEqual(["bug", "suggestion", "question"]);
    expect(isValidCategory("bug")).toBe(true);
    expect(isValidCategory("suggestion")).toBe(true);
    expect(isValidCategory("question")).toBe(true);
    expect(isValidCategory("spam")).toBe(false);
    expect(isValidCategory("")).toBe(false);
    expect(isValidCategory(null)).toBe(false);
    expect(isValidCategory(3)).toBe(false);
  });
});

describe("email", () => {
  it("normalizes only strings, trimming whitespace", () => {
    expect(normalizeEmail("  a@b.com ")).toBe("a@b.com");
    expect(normalizeEmail(42)).toBe("");
    expect(normalizeEmail(null)).toBe("");
    expect(normalizeEmail({})).toBe("");
  });

  it("validates the obvious shape and rejects typos", () => {
    expect(isValidEmail("a@b.com")).toBe(true);
    expect(isValidEmail("first.last@sub.example.org")).toBe(true);
    expect(isValidEmail("no-at-sign")).toBe(false);
    expect(isValidEmail("a@b")).toBe(false);
    expect(isValidEmail("a b@c.com")).toBe(false);
  });

  it("returns a deliverable address or null, never an invalid string", () => {
    expect(deliverableEmail(" a@b.com ")).toBe("a@b.com");
    expect(deliverableEmail("garbage")).toBeNull();
    expect(deliverableEmail("")).toBeNull();
    expect(deliverableEmail(undefined)).toBeNull();
    expect(deliverableEmail(123)).toBeNull();
  });
});

describe("description", () => {
  it("requires at least 10 non-whitespace characters", () => {
    expect(isDescriptionLongEnough("too short")).toBe(false); // 9 chars
    expect(isDescriptionLongEnough("just enough")).toBe(true); // 11 chars
    expect(isDescriptionLongEnough("          ")).toBe(false); // whitespace only
  });

  it("clamps to the max length and trims", () => {
    expect(clampDescription("  hi  ")).toBe("hi");
    const long = "x".repeat(MAX_DESCRIPTION_LENGTH + 500);
    expect(clampDescription(long)).toHaveLength(MAX_DESCRIPTION_LENGTH);
  });
});

describe("dwell and canSubmit", () => {
  it("blocks submissions faster than the minimum dwell", () => {
    expect(passesDwell(MIN_DWELL_MS - 1)).toBe(false);
    expect(passesDwell(MIN_DWELL_MS)).toBe(true);
    expect(passesDwell(Number.NaN)).toBe(false);
  });

  it("enables submit only when description and dwell both pass", () => {
    expect(canSubmit({ description: "long enough now", timeElapsed: 5000 })).toBe(true);
    expect(canSubmit({ description: "short", timeElapsed: 5000 })).toBe(false);
    expect(canSubmit({ description: "long enough now", timeElapsed: 500 })).toBe(false);
  });
});

describe("buildReportPayload", () => {
  const base = {
    category: "bug" as const,
    description: "  the live player will not load on my phone  ",
    email: " viewer@example.com ",
    url: "https://njpbs.org/live/",
    userAgent: "Mozilla/5.0",
    screenSize: "390x844",
    formOpenedAt: 1000,
    timeElapsed: 8000,
    turnstileToken: "tok",
  };

  it("normalizes description and email and passes context through", () => {
    const p = buildReportPayload(base);
    expect(p.category).toBe("bug");
    expect(p.description).toBe("the live player will not load on my phone");
    expect(p.email).toBe("viewer@example.com");
    expect(p.url).toBe("https://njpbs.org/live/");
    expect(p.screenSize).toBe("390x844");
    expect(p.turnstileToken).toBe("tok");
  });

  it("collapses an invalid email to null rather than shipping garbage", () => {
    expect(buildReportPayload({ ...base, email: "not-an-email" }).email).toBeNull();
    expect(buildReportPayload({ ...base, email: undefined }).email).toBeNull();
  });

  it("keeps only the last 50 console entries", () => {
    const logs: ConsoleEntry[] = Array.from({ length: 70 }, (_v, i) => ({
      level: "log",
      message: `m${i}`,
      timestamp: "2026-07-01T00:00:00.000Z",
    }));
    const p = buildReportPayload({ ...base, consoleLogs: logs });
    expect(p.consoleLogs).toHaveLength(MAX_CONSOLE_ENTRIES);
    expect(p.consoleLogs[0].message).toBe("m20");
    expect(p.consoleLogs[49].message).toBe("m69");
  });

  it("defaults missing context fields to null and missing logs to []", () => {
    const p = buildReportPayload({ category: "question", description: "why is the schedule empty" });
    expect(p.url).toBeNull();
    expect(p.userAgent).toBeNull();
    expect(p.consoleLogs).toEqual([]);
  });

  it("throws on an invalid category so a doomed report is never sent", () => {
    expect(() => buildReportPayload({ ...base, category: "spam" })).toThrow(/Invalid category/);
  });
});

describe("context sanitization (untrusted-POST defense)", () => {
  it("clamps oversized url, userAgent, and screenSize", () => {
    const p = buildReportPayload({
      category: "bug",
      description: "the live player will not load",
      url: `https://njpbs.org/${"a".repeat(5000)}`,
      userAgent: "x".repeat(2000),
      screenSize: "y".repeat(200),
    });
    expect(p.url).toHaveLength(MAX_URL_LENGTH);
    expect(p.userAgent).toHaveLength(MAX_USER_AGENT_LENGTH);
    expect(p.screenSize).toHaveLength(MAX_SCREEN_SIZE_LENGTH);
  });

  it("normalizes untrusted console entries: unknown level, non-string message, oversized message", () => {
    const logs = [
      { level: "hack", message: "z".repeat(2000), timestamp: 123 },
      { level: "warn", message: { nested: true } },
    ] as unknown as ConsoleEntry[];
    const p = buildReportPayload({
      category: "bug",
      description: "the live player will not load",
      consoleLogs: logs,
    });
    expect(p.consoleLogs[0].level).toBe("log"); // unknown level collapses to log
    expect(p.consoleLogs[0].message).toHaveLength(MAX_CONSOLE_MESSAGE_LENGTH);
    expect(typeof p.consoleLogs[0].timestamp).toBe("string"); // non-string timestamp coerced
    expect(p.consoleLogs[1].level).toBe("warn");
    expect(typeof p.consoleLogs[1].message).toBe("string"); // object message coerced to string
  });
});
