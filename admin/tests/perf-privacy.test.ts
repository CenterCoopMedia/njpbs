import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PERF_MARKS,
  PERF_MEASURES,
  createPerfRecorder,
  type TimingSink,
} from "../src/lib/perf-receipts";
import { findUnsafePerfValues } from "../src/lib/perf-privacy-scan";

const adminRoot = process.cwd();

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = resolve(directory, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry) ? [path] : [];
  });
}

// Values a receipt must never carry: staff identity, credentials, addresses, or any
// editorial content. Each is fed through the recorder below and must not survive.
const privateValues = {
  title: "Newark council delays the budget vote",
  body: "<p>Embargoed until Friday.</p>",
  email: "account-8@example.org",
  uid: "6mE1oQ2sVbTfKk9RzcJH8pWnA0x2",
  idToken:
    "eyJhbGciOiJSUzI1NiIsImtpZCI6ImFiYyJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl",
  cookie: "__session=abc123def456ghi789",
  ip: "203.0.113.7",
  recordId: "post_4f2c9ab1d0e34f7a8c15",
  assetPath: "/media/2026/08/newark-budget-hearing.jpg",
};

function fakeSink(): { sink: TimingSink; emitted: unknown[] } {
  const emitted: unknown[] = [];
  let clock = 0;
  const sink: TimingSink = {
    now: () => (clock += 10),
    mark(name, options) {
      emitted.push({ name, detail: options?.detail });
    },
    measure(name, options) {
      emitted.push({ name, detail: options?.detail });
    },
  };
  return { sink, emitted };
}

describe("Admin performance privacy boundary", () => {
  it("emits only names from the frozen inventory", () => {
    const { sink, emitted } = fakeSink();
    const recorder = createPerfRecorder(sink);
    const allowed = new Set<string>([
      ...Object.values(PERF_MARKS),
      ...Object.values(PERF_MEASURES),
    ]);

    recorder.phase("bootstrap");
    recorder.phase("authResolved");
    recorder.phase("admissionComplete");
    recorder.phase("profileConfirmed");
    recorder.phase("editorMounted");
    recorder.phase("editorReady");
    recorder.begin("route-load", { route: "content" }).end({ outcome: "ok" });
    recorder
      .begin("cms-request", { operation: "content-read" })
      .end({ outcome: "ok", statusClass: "2xx" });
    recorder
      .begin("save", { operation: "content-write" })
      .end({ outcome: "ok", statusClass: "2xx" });

    expect(emitted.length).toBeGreaterThan(0);
    for (const entry of emitted) {
      expect(allowed.has((entry as { name: string }).name)).toBe(true);
    }
  });

  it("refuses private values pushed into every detail channel", () => {
    const { sink, emitted } = fakeSink();
    const recorder = createPerfRecorder(sink);
    const hostile = {
      ...privateValues,
      route: privateValues.assetPath,
      operation: privateValues.title,
      outcome: privateValues.email,
      requestId: privateValues.idToken,
      build: privateValues.cookie,
    } as unknown as Parameters<typeof recorder.phase>[1];

    recorder.phase("bootstrap", hostile);
    recorder.begin("cms-request", hostile).end(hostile);
    recorder.begin("save", hostile).end(hostile);

    const serialized = JSON.stringify({
      emitted,
      receipt: recorder.receipt(),
    });

    for (const value of Object.values(privateValues)) {
      expect(serialized).not.toContain(value);
    }
    expect(findUnsafePerfValues(recorder.receipt())).toEqual([]);
  });

  it("keeps an exported receipt free of unsafe shapes", () => {
    const { sink } = fakeSink();
    const recorder = createPerfRecorder(sink);

    recorder.phase("bootstrap");
    recorder
      .begin("cms-request", { operation: "content-read" })
      .end({ outcome: "ok", statusClass: "2xx" });

    expect(findUnsafePerfValues(recorder.receipt())).toEqual([]);
  });

  it("names the forbidden shapes it scans for", () => {
    expect(findUnsafePerfValues({ a: privateValues.email })).toEqual(["a"]);
    expect(findUnsafePerfValues({ a: privateValues.idToken })).toEqual(["a"]);
    expect(findUnsafePerfValues({ a: privateValues.ip })).toEqual(["a"]);
    expect(findUnsafePerfValues({ a: privateValues.uid })).toEqual(["a"]);
    expect(findUnsafePerfValues({ a: { b: [privateValues.title] } })).toEqual([
      "a.b.0",
    ]);
    expect(
      findUnsafePerfValues({ requestId: "1b4e28ba-2fa1-11d2-883f-0016d3cca427" }),
    ).toEqual([]);
  });

  it("keeps every User Timing call inside the receipt module", () => {
    const receiptModule = resolve(adminRoot, "src/lib/perf-receipts.ts");
    const offenders = sourceFiles(resolve(adminRoot, "src")).filter(
      (path) =>
        path !== receiptModule &&
        /performance\s*\.\s*(mark|measure)\s*\(/.test(
          readFileSync(path, "utf8"),
        ),
    );

    expect(offenders).toEqual([]);
  });
});
