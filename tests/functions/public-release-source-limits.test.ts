import { afterEach, expect, it, vi } from "vitest";
import limits from "../../functions/lib/public-release-source-limits.js";
import input from "../../functions/lib/public-release-pair-input.js";
afterEach(() => { vi.useRealTimers(); });
it.each([
  ["changes", 10_000, "historical-source-changes-limit"],
  ["rootFiles", 10_000, "historical-source-root-files-limit"],
  ["censusBytes", 16 * 1024 * 1024, "historical-source-census-bytes-limit"],
] as const)("admits %s at the exact ceiling and refuses the next unit by name", (metric, bound, code) => {
  expect(() => limits.checkHistoricalSourceLimit(metric, bound)).not.toThrow();
  expect(() => limits.checkHistoricalSourceLimit(metric, bound + 1)).toThrowError(expect.objectContaining({ code,
    details: { metric, used: bound + 1, limit: bound } }));
});
it("warns at exactly 50% and preserves unknown headroom instead of reporting zero", () => {
  const before = limits.historicalSourceHeadroom({ changes: 4999, rootFiles: 4999, censusBytes: 8 * 1024 * 1024 - 1 });
  expect(before.warnings).toEqual([]);
  const half = limits.historicalSourceHeadroom({ changes: 5000, rootFiles: 5000, censusBytes: 8 * 1024 * 1024 });
  expect(half.warnings).toEqual(["changes", "rootFiles", "censusBytes"]);
  expect(half.checks.changes).toMatchObject({ used: 5000, limit: 10_000, remaining: 5000, percent: 50, warning: true });
  expect(half.checks.transactionMs).toMatchObject({ used: null, limit: null, remaining: null, percent: null, warning: false });
  const measured = limits.historicalSourceHeadroom({ transactionMs: 500_000, readMs: 100_000 });
  expect(measured.checks.transactionMs).toEqual({ used: 500_000, limit: null, remaining: null, percent: null, warning: false, exceeded: false });
  expect(measured.checks.readMs).toEqual({ used: 100_000, limit: null, remaining: null, percent: null, warning: false, exceeded: false });
  expect(measured.warnings).toEqual([]);
});
it("admits replacement files without consuming more root slots and refuses overflow before insert", () => {
  const files = limits.createHistoricalSourceInventory<{ bytes: Uint8Array }>();
  for (let index = 0; index < input.INPUT_FILE_LIMIT; index++) files.set(`source-${index}.json`, { bytes: new Uint8Array() });
  files.set("source-0.json", { bytes: new Uint8Array([1]) });
  expect(files.size).toBe(10_000);
  expect(() => files.set("overflow.json", { bytes: new Uint8Array() })).toThrowError(expect.objectContaining({ code: "historical-source-root-files-limit" }));
  expect(files.has("overflow.json")).toBe(false); expect(files.size).toBe(10_000);
});
it("keeps canonical census encoding within the existing input-file contract", () => {
  const bytes = limits.encodeHistoricalSourceCensus({ z: 1, a: { z: 2, a: 3 } });
  expect(new TextDecoder().decode(bytes)).toBe('{"a":{"a":3,"z":2},"z":1}');
  const files = limits.createHistoricalSourceInventory<{ bytes: Uint8Array }>();
  expect(() => files.set("source-census.json", { bytes: { byteLength: input.INPUT_FILE_BYTES_LIMIT + 1 } as Uint8Array }))
    .toThrowError(expect.objectContaining({ code: "historical-source-census-bytes-limit" }));
  expect(files.size).toBe(0);
});
it("measures transaction and read time without ending a slow read", async () => {
  vi.useFakeTimers({ toFake: ["performance"] });
  const budget = limits.historicalSourceReadBudget();
  vi.advanceTimersByTime(300_000);
  const value = await budget.read(async () => { vi.advanceTimersByTime(120_000); return "answered"; });
  expect(value).toBe("answered");
  expect(budget.usage()).toEqual({ transactionMs: 420_000, readMs: 120_000 });
  expect(await budget.read(async () => "next")).toBe("next");
  expect(budget.usage().readMs).toBe(120_000);
});
it("keeps numeric SDK retry status unchanged", async () => {
  const budget = limits.historicalSourceReadBudget(), error = Object.assign(new Error("contention"), { code: 10 });
  await expect(budget.read(async () => { throw error; })).rejects.toBe(error);
});
it("recognizes the complete error contract across module realms and rejects a forged code or ceiling", () => {
  const original = new limits.HistoricalSourceLimitError("changes", 10_001);
  const copy = { name: original.name, message: original.message, code: original.code, details: { ...original.details } };
  expect(limits.isHistoricalSourceLimitError(copy)).toBe(true);
  expect(limits.isHistoricalSourceLimitError({ ...copy, code: "transport-unavailable" })).toBe(false);
  expect(limits.isHistoricalSourceLimitError({ ...copy, details: { ...copy.details, limit: 20_000 } })).toBe(false);
  expect(limits.isHistoricalSourceLimitError({ ...copy, code: "historical-source-transaction-limit",
    details: { metric: "transactionMs", used: 240_000, limit: 240_000 } })).toBe(false);
  expect(() => limits.checkHistoricalSourceLimit("transactionMs" as never, 1_000_000)).toThrow("Invalid source limit measurement");
});
