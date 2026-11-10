import { describe, expect, it } from "vitest";
import { createPerfRecorder, PERF_MEASURES, reportCorrelationIds, type PerfReceiptMeasure } from "../src/lib/perf-receipts";

describe("report request correlation", () => {
  it("keeps at most ten distinct safe CMS request IDs, newest retained first", () => {
    const ids = Array.from({ length: 12 }, (_, index) =>
      `abcdef00-0000-4000-8000-${String(index).padStart(12, "0")}`);
    const measure = (requestId: string, name: string = PERF_MEASURES.cmsTransport): PerfReceiptMeasure => ({
      name, durationMs: 10, detail: { requestId },
    });
    const receipt = createPerfRecorder(null).receipt();
    receipt.measures = [
      ...ids.map(id => measure(id)),
      measure(ids[11].toUpperCase()),
      measure("staff@example.com"),
      measure("Bearer secret"),
      measure("https://cms.internal/?token=secret"),
      measure("ffffffff-0000-4000-8000-000000000000", PERF_MEASURES.saveTransaction),
    ];
    const original = structuredClone(receipt);
    expect(reportCorrelationIds(receipt)).toEqual(ids.slice(-10).reverse());
    expect(receipt).toEqual(original);
  });

  it("has no IDs before a CMS request receipt is available", () => {
    expect(reportCorrelationIds(createPerfRecorder(null).receipt())).toEqual([]);
  });

  it("keeps recent request IDs after the session exceeds its retained entry limit", () => {
    let clock = 0;
    const recorder = createPerfRecorder({ now: () => ++clock, mark() {}, measure() {} });
    const ids = Array.from({ length: 520 }, (_, index) =>
      `abcdef00-0000-4000-8000-${String(index).padStart(12, "0")}`);
    for (const requestId of ids) recorder.begin("cms-request").end({ requestId });
    const receipt = recorder.receipt();
    expect(receipt.marks).toHaveLength(500);
    expect(receipt.measures).toHaveLength(500);
    expect(receipt.counts.cmsRequest).toBe(520);
    expect(receipt.counts.open).toBe(0);
    expect(reportCorrelationIds(receipt)).toEqual(ids.slice(-10).reverse());
  });
});
