"use strict";
const input = require("./public-release-pair-input");
const source = require("./public-release-source-body");
const HISTORICAL_CHANGE_LIMIT = 10_000;
// Firestore's hard transaction/idle ceilings are 270 s / 60 s. Refuse earlier.
const HISTORICAL_TRANSACTION_MS = 240_000;
const HISTORICAL_READ_MS = 45_000;
const limits = Object.freeze({ changes: HISTORICAL_CHANGE_LIMIT, transactionMs: HISTORICAL_TRANSACTION_MS,
  readMs: HISTORICAL_READ_MS, rootFiles: input.INPUT_FILE_LIMIT, censusBytes: input.INPUT_FILE_BYTES_LIMIT });
const codes = Object.freeze({ changes: "historical-source-changes-limit", transactionMs: "historical-source-transaction-limit",
  readMs: "historical-source-read-time-limit", rootFiles: "historical-source-root-files-limit", censusBytes: "historical-source-census-bytes-limit" });
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
    Number.isFinite(detail.used) && (detail.metric === "transactionMs" || detail.metric === "readMs" ? detail.used >= detail.limit : detail.used > detail.limit) &&
    value.code === codes[detail.metric]);
}
function checkHistoricalSourceLimit(metric, used) {
  if (!Object.hasOwn(limits, metric) || !Number.isFinite(used) || used < 0) throw new Error("Invalid source limit measurement");
  if (used > limits[metric]) throw new HistoricalSourceLimitError(metric, used);
}
/** Operational observation only. Unknown use is never represented as zero or
 * as eligibility; each measured item warns at 50% of its unchanged limit. */
function historicalSourceHeadroom(usage = {}) {
  const checks = Object.fromEntries(Object.entries(limits).map(([metric, limit]) => {
    const used = usage[metric] ?? null;
    if (used !== null && (!Number.isFinite(used) || used < 0)) throw new Error("Invalid source limit measurement");
    return [metric, { used, limit, remaining: used === null ? null : Math.max(0, limit - used),
      percent: used === null ? null : 100 * used / limit, warning: used !== null && used >= limit / 2,
      exceeded: used !== null && used > limit }];
  }));
  return { schemaVersion: 1, kind: "historical-source-headroom", checks,
    warnings: Object.keys(checks).filter(metric => checks[metric].warning) };
}
/** One owner-local budget per actual transaction attempt. A timed-out SDK
 * request cannot start another page after the caller has already refused. */
function historicalSourceReadBudget() {
  const started = performance.now(); let maxReadMs = 0, failure;
  const elapsed = () => Math.max(0, performance.now() - started);
  const check = () => {
    if (failure) throw failure;
    if (elapsed() >= HISTORICAL_TRANSACTION_MS) {
      failure = new HistoricalSourceLimitError("transactionMs", elapsed()); throw failure;
    }
  };
  const read = async operation => {
    check();
    const remaining = HISTORICAL_TRANSACTION_MS - elapsed();
    const metric = remaining <= HISTORICAL_READ_MS ? "transactionMs" : "readMs";
    const duration = Math.min(HISTORICAL_READ_MS, remaining), before = performance.now();
    let timer;
    try {
      const value = await Promise.race([Promise.resolve().then(() => { check(); return operation(); }), new Promise((_, reject) => {
        timer = setTimeout(() => {
          failure = new HistoricalSourceLimitError(metric, metric === "transactionMs" ? elapsed() : duration);
          reject(failure);
        }, Math.ceil(duration));
      })]);
      const readMs = performance.now() - before;
      maxReadMs = Math.max(maxReadMs, readMs);
      if (readMs >= duration) {
        failure = new HistoricalSourceLimitError(metric, metric === "transactionMs" ? elapsed() : readMs);
        throw failure;
      }
      check(); return value;
    } finally { clearTimeout(timer); }
  };
  return { check, read, usage: () => ({ transactionMs: elapsed(), readMs: maxReadMs }) };
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
module.exports = { HISTORICAL_CHANGE_LIMIT, HISTORICAL_TRANSACTION_MS, HISTORICAL_READ_MS,
  HistoricalSourceLimitError, isHistoricalSourceLimitError, checkHistoricalSourceLimit, historicalSourceHeadroom,
  historicalSourceReadBudget, createHistoricalSourceInventory, encodeHistoricalSourceCensus };
