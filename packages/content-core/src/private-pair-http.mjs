// Shared by the Node reader and the slot without importing database code.
export const PAIR_READER_PATH = "/private-pair-reader/v2/read";
export const PAIR_READER_PATHS_LIMIT = 32;
export const PAIR_READER_DEADLINE_MS = 3_000;
export const PAIR_READER_BYTES_LIMIT = 16 * 1024 * 1024;
export const PAIR_READER_REQUEST_LIMIT = 64 * 1024;
export const PAIR_READER_REPLY_LIMIT = 24 * 1024 * 1024;
export const PAIR_READER_CONTRACT = Object.freeze({ schemaVersion: 2, protocol: "private-pair-reader-v2",
  input: "settled-view-v2", catalog: "exact-source-catalog-images-v1", absence: "complete-search-and-content-feed-namespaces-v1",
  maximumPaths: PAIR_READER_PATHS_LIMIT, maximumBytes: PAIR_READER_BYTES_LIMIT });
export const PAIR_OPERATOR_PROVE_PATH = "/private-pair-operator/v1/prove";
export const PAIR_OPERATOR_CAPTURE_PATH = "/private-pair-operator/v1/capture-recovery";

/** These are the closed versions implemented by the deployed reader graph.
 * They do not enable publication or replace the qualification late guards. */
export function privatePairReaderCapabilities(commitSha) {
  return { schemaVersion: 1, rendererSha: commitSha,
    post: { dataFigureVersion: 1, electionResultsVersion: 2, liveBlogVersion: 1 },
    page: { dataFigureVersion: 1, electionResultsVersion: 2, dataHubReportingVersion: 1, dataHubCompositionVersion: 1 },
    record: { families: ["programs", "events"],
      terminalOwner: { schemaVersion: 1, transport: "public-context-no-build-v1", rendererSha: commitSha } } };
}
