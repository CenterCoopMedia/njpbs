"use strict";
const input = require("./public-release-pair-input");
const source = require("./public-release-source-body");
const HISTORICAL_CHANGE_LIMIT = 10_000;
// Size limits only. Firestore enforces its own transaction time limit; the
// transaction and read times are measured and reported, never refused.
const limits = Object.freeze({ changes: HISTORICAL_CHANGE_LIMIT, rootFiles: input.INPUT_FILE_LIMIT, censusBytes: input.INPUT_FILE_BYTES_LIMIT });
const codes = Object.freeze({ changes: "historical-source-changes-limit", rootFiles: "historical-source-root-files-limit",
  censusBytes: "historical-source-census-bytes-limit" });
const MEASURED = Object.freeze(["transactionMs", "readMs"]);
class HistoricalSourceLimitError extends Error {
  constructor(metric, used) {
    super("Historical source limit reached"); this.name = "HistoricalSourceLimitError";
    this.code = codes[metric]; this.details = Object.freeze({ metric, used, limit: limits[metric] });
  }
}
// The source adapter and Functions reader can load the contract through
// separate ESM/CommonJS realms. Preserve the full validated error contract.
function isHistoricalSourceLimitError(value) {
  const detail = value?.details;
  return Boolean(value?.name === "HistoricalSourceLimitError" && typeof value.message === "string" &&
    detail && Object.hasOwn(limits, detail.metric) && detail.limit === limits[detail.metric] &&
    Number.isFinite(detail.used) && detail.used > detail.limit && value.code === codes[detail.metric]);
}
function checkHistoricalSourceLimit(metric, used) {
  if (!Object.hasOwn(limits, metric) || !Number.isFinite(used) || used < 0) throw new Error("Invalid source limit measurement");
  if (used > limits[metric]) throw new HistoricalSourceLimitError(metric, used);
}
function measurement(value) {
  const used = value ?? null;
  if (used !== null && (!Number.isFinite(used) || used < 0)) throw new Error("Invalid source limit measurement");
  return used;
}
/** Operational observation only. Unknown use is never represented as zero or
 * as eligibility; each limited item warns at 50% of its unchanged limit. The
 * measured times carry no limit and never warn. */
function historicalSourceHeadroom(usage = {}) {
  const checks = Object.fromEntries([
    ...Object.entries(limits).map(([metric, limit]) => {
      const used = measurement(usage[metric]);
      return [metric, { used, limit, remaining: used === null ? null : Math.max(0, limit - used),
        percent: used === null ? null : 100 * used / limit, warning: used !== null && used >= limit / 2,
        exceeded: used !== null && used > limit }];
    }),
    ...MEASURED.map(metric => [metric, { used: measurement(usage[metric]), limit: null, remaining: null, percent: null,
      warning: false, exceeded: false }]),
  ]);
  return { schemaVersion: 1, kind: "historical-source-headroom", checks,
    warnings: Object.keys(checks).filter(metric => checks[metric].warning) };
}
/** Measures one actual transaction attempt: its elapsed time and its longest
 * read. It never ends a read or the transaction. */
function historicalSourceReadBudget() {
  const started = performance.now(); let maxReadMs = 0;
  const read = async operation => {
    const before = performance.now();
    try { return await operation(); } finally { maxReadMs = Math.max(maxReadMs, performance.now() - before); }
  };
  return { read, usage: () => ({ transactionMs: Math.max(0, performance.now() - started), readMs: maxReadMs }) };
}
/** Admit each actual source file before growing H's inventory. */
function createHistoricalSourceInventory(entries) {
  class Inventory extends Map {
    set(name, value) {
      checkHistoricalSourceLimit("rootFiles", this.size + (this.has(name) ? 0 : 1));
      if (name === "source-census.json") checkHistoricalSourceLimit("censusBytes", value.bytes.byteLength);
      return super.set(name, value);
    }
  }
  return new Inventory(entries);
}
function encodeHistoricalSourceCensus(value) {
  const json = source.publicReleaseSnapshotJson(value, Infinity);
  checkHistoricalSourceLimit("censusBytes", Buffer.byteLength(json));
  return new TextEncoder().encode(json);
}
module.exports = { HISTORICAL_CHANGE_LIMIT,
  HistoricalSourceLimitError, isHistoricalSourceLimitError, checkHistoricalSourceLimit, historicalSourceHeadroom,
  historicalSourceReadBudget, createHistoricalSourceInventory, encodeHistoricalSourceCensus };
