export const PAIR_READER_PATH: "/private-pair-reader/v2/read";
export const PAIR_READER_PATHS_LIMIT: 32;
export const PAIR_READER_DEADLINE_MS: 3000;
export const PAIR_READER_BYTES_LIMIT: number;
export const PAIR_READER_REQUEST_LIMIT: number;
export const PAIR_READER_REPLY_LIMIT: number;
export const PAIR_READER_CONTRACT: Readonly<{ schemaVersion: 2; protocol: "private-pair-reader-v2";
  input: "settled-view-v2"; catalog: "exact-source-catalog-images-v1"; absence: "complete-search-and-content-feed-namespaces-v1";
  maximumPaths: 32; maximumBytes: number }>;
export const PAIR_OPERATOR_PROVE_PATH: "/private-pair-operator/v1/prove";
export const PAIR_OPERATOR_CAPTURE_PATH: "/private-pair-operator/v1/capture-recovery";
export function privatePairReaderCapabilities(commitSha: string): Readonly<{
  schemaVersion: 1; rendererSha: string;
  post: Readonly<{ dataFigureVersion: 1; electionResultsVersion: 2; liveBlogVersion: 1 }>;
  page: Readonly<{ dataFigureVersion: 1; electionResultsVersion: 2; dataHubReportingVersion: 1; dataHubCompositionVersion: 1 }>;
  record: Readonly<{ families: readonly ["programs", "events"];
    terminalOwner: Readonly<{ schemaVersion: 1; transport: "public-context-no-build-v1"; rendererSha: string }> }>;
}>;
