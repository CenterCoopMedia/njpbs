"use strict";

const { PublicReleaseProtocolError } = require("./public-release-pair");
const { publicationTarget } = require("./publication-target");
const { noAnswer } = require("./release-wait");

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

// DEADLINE_EXCEEDED, RESOURCE_EXHAUSTED, ABORTED, INTERNAL (a reset stream), UNAVAILABLE.
const TRANSPORT_GRPC = new Set([4, 8, 10, 13, 14]);
const transportStatus = status => status === 408 || status === 429 || Number.isInteger(status) && status >= 500 && status <= 599;
/** A service did not answer, or answered that it cannot serve now. The next
 * attempt can differ, so this is never evidence about content. */
function isPairTransportFailure(error) {
  if (error instanceof PublicReleaseProtocolError) return false;
  if (noAnswer(error)) return true;
  for (let cause = error; cause && typeof cause === "object"; cause = cause.cause) {
    if (cause.code === "storage-unavailable" || cause.name === "TimeoutError" ||
        // A child process error carries its exit code in the same field.
        cause.cmd === undefined && TRANSPORT_GRPC.has(cause.code) ||
        [cause.code, cause.status, cause.statusCode, cause.response?.status, cause.$metadata?.httpStatusCode].some(transportStatus)) return true;
  }
  return false;
}
/** For a catch that would otherwise name a content failure. */
function rethrowPairTransport(error) {
  if (!isPairTransportFailure(error)) return;
  const failure = new PairExecutionError("storage-unavailable");
  Object.defineProperty(failure, "cause", { value: error });
  throw failure;
}

function assertPrivatePairResources(pair) {
  if (pair.publisher.application !== `njpbs-pair-publisher-${pair.publicWorker.incarnation}` ||
      pair.publicWorker.service !== `njpbs-pair-slot-${pair.publicWorker.incarnation}`) throw new PublicReleaseProtocolError();
  const targets = [publicationTarget("production"), publicationTarget("development")];
  const liveWorkers = new Set(targets.flatMap(target => [target.workerName, target.publisherWorker]));
  if (liveWorkers.has(pair.publisher.application) || liveWorkers.has(pair.publicWorker.service) ||
      targets.some(target => pair.publisher.journalNamespace === target.serializerId)) throw new PublicReleaseProtocolError();
}

module.exports = { isPairFailureCode, isPairTransportFailure, rethrowPairTransport, PairExecutionError, assertPrivatePairResources };
