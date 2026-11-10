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
  expect(half.checks.transactionMs).toMatchObject({ used: null, remaining: null, percent: null, warning: false });
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
it("refuses the whole-history transaction before its backend lifetime and prevents later reads", async () => {
  vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
  const budget = limits.historicalSourceReadBudget();
  vi.advanceTimersByTime(limits.HISTORICAL_TRANSACTION_MS);
  const read = vi.fn(async () => "should not run");
  await expect(budget.read(read)).rejects.toMatchObject({ code: "historical-source-transaction-limit" });
  expect(read).not.toHaveBeenCalled();
});
it("bounds an unavailable SDK read before idle expiration and ignores a later response", async () => {
  vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
  const budget = limits.historicalSourceReadBudget();
  let finish!: (value: string) => void;
  const pending = budget.read(() => new Promise<string>(resolve => { finish = resolve; }));
  const refusal = expect(pending).rejects.toMatchObject({ code: "historical-source-read-time-limit" });
  await vi.advanceTimersByTimeAsync(limits.HISTORICAL_READ_MS);
  await refusal; finish("late"); await Promise.resolve();
  const next = vi.fn(async () => "wrong"); await expect(budget.read(next)).rejects.toMatchObject({ code: "historical-source-read-time-limit" });
  expect(next).not.toHaveBeenCalled();
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
});
