"use strict";

const { PublicReleaseProtocolError } = require("./public-release-pair");
const { publicationTarget } = require("./publication-target");

const PAIR_FAILURE_CODES = new Set(["input-unavailable", "render-failed", "byte-mismatch", "storage-unavailable",
  "author-input-missing", "author-input-mismatch", "author-route-collision", "author-owner-mismatch",
  ...["request", "code", "schedule", "program-images"].flatMap(family => ["missing", "mismatch"].map(reason => `replay-frozen-${family}-${reason}`)),
  "unsupported-cross-source-schedule", "unsupported-cross-source-record-images", "reader-mismatch", "lease-lost", "lease-expired", "unexpected-executor-error"]);

class PairExecutionError extends Error {
  constructor(code) {
    if (!PAIR_FAILURE_CODES.has(code)) throw new PublicReleaseProtocolError();
    super("Private pair execution failed");
    this.name = "PairExecutionError";
    Object.defineProperty(this, "code", { value: code, enumerable: true });
  }
}
const isPairFailureCode = code => PAIR_FAILURE_CODES.has(code);

function assertPrivatePairResources(pair) {
  if (pair.publisher.application !== `njpbs-pair-publisher-${pair.publicWorker.incarnation}` ||
      pair.publicWorker.service !== `njpbs-pair-slot-${pair.publicWorker.incarnation}`) throw new PublicReleaseProtocolError();
  const targets = [publicationTarget("production"), publicationTarget("development")];
  const liveWorkers = new Set(targets.flatMap(target => [target.workerName, target.publisherWorker]));
  if (liveWorkers.has(pair.publisher.application) || liveWorkers.has(pair.publicWorker.service) ||
      targets.some(target => pair.publisher.journalNamespace === target.serializerId)) throw new PublicReleaseProtocolError();
}

module.exports = { isPairFailureCode, PairExecutionError, assertPrivatePairResources };
