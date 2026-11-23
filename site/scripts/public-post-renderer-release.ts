import { SPANISH_POST_SEAL_ENABLED } from "../../packages/content-core/src/private-pair-http.mjs";
import { isDeepStrictEqual } from "node:util";
import pageReaderContract from "../../functions/lib/page-reader-contract.js";
import { dataHubPageEnabled } from "../src/lib/build-target.ts";

// The deployed CMS must accept version 3 before public candidates advertise it.
const PUBLIC_PAGE_READER_SEAL_VERSION = 2;

export function publicPostRendererRelease(rendererSha: string, environment: "production" | "development", env: NodeJS.ProcessEnv) {
  return { schemaVersion: 1, rendererSha, liveBlogVersion: 1, electionResultsVersion: 2,
    ...(SPANISH_POST_SEAL_ENABLED ? { spanishPostVersion: 1 } : {}),
    pageReaderVersion: PUBLIC_PAGE_READER_SEAL_VERSION,
    ...(dataHubPageEnabled(env) ? { dataHubReportingVersion: 1, dataHubCompositionVersion: 1 } : {}),
    ...(environment === "development" ? { environment } : {}) };
}

export function publicWorkerCandidateRendererContract(rendererRelease: unknown, commitSha: string) {
  const dataHubPublic = rendererRelease !== null && typeof rendererRelease === "object" &&
    "dataHubReportingVersion" in rendererRelease && rendererRelease.dataHubReportingVersion === 1;
  const dataHubComposition = dataHubPublic && "dataHubCompositionVersion" in rendererRelease && rendererRelease.dataHubCompositionVersion === 1;
  const electionResults = rendererRelease !== null && typeof rendererRelease === "object" &&
    "electionResultsVersion" in rendererRelease && [1, 2].includes(rendererRelease.electionResultsVersion as number)
    ? rendererRelease.electionResultsVersion as 1 | 2 : undefined;
  const liveBlog = rendererRelease !== null && typeof rendererRelease === "object" &&
    "liveBlogVersion" in rendererRelease && rendererRelease.liveBlogVersion === 1;
  const spanishPosts = rendererRelease !== null && typeof rendererRelease === "object" &&
    "spanishPostVersion" in rendererRelease && rendererRelease.spanishPostVersion === 1;
  const pageReaderVersion = rendererRelease !== null && typeof rendererRelease === "object" &&
    "pageReaderVersion" in rendererRelease ? rendererRelease.pageReaderVersion : undefined;
  if (pageReaderVersion !== undefined && !pageReaderContract.isPageReaderVersion(pageReaderVersion)) throw new Error("Unsupported Page reader contract");
  if (!isDeepStrictEqual(rendererRelease, { schemaVersion: 1, rendererSha: commitSha,
    ...(dataHubPublic ? { dataHubReportingVersion: 1 } : {}),
    ...(dataHubComposition ? { dataHubCompositionVersion: 1 } : {}),
    ...(liveBlog ? { liveBlogVersion: 1 } : {}),
    ...(spanishPosts ? { spanishPostVersion: 1 } : {}),
    ...(pageReaderVersion !== undefined ? { pageReaderVersion } : {}),
    ...(electionResults ? { electionResultsVersion: electionResults } : {}) })) {
    throw new Error("The public Post renderer does not match its prepared production artifact");
  }
  // Fixed metadata attests the family reader. Each request reads admission;
  // neither this marker nor retained legacy variables enable publication.
  const variables = {
    NO_BUILD_RECORD_RENDERER_SHA: commitSha,
    NO_BUILD_POST_FAMILIES: "posts",
    NO_BUILD_POST_RENDERER_SHA: commitSha,
    NO_BUILD_PAGE_RENDERER_SHA: commitSha,
    DATA_FIGURE_VERSION: "1",
    ELECTION_RESULTS_VERSION: electionResults ? String(electionResults) : "0",
    // Explicit zero clears a retained feature marker when --keep-vars is used.
    LIVE_BLOG_VERSION: liveBlog ? "1" : "0",
    SPANISH_POST_VERSION: spanishPosts ? "1" : "0",
    DATA_HUB_PUBLIC: dataHubPublic ? "1" : "0",
    DATA_HUB_COMPOSITION_VERSION: dataHubComposition ? "1" : "0",
  };
  return { variables, pageReaderVersion };
}
