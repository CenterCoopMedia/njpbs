import path from "node:path";
import {
  MODEL_ID,
  MODEL_REVISION,
} from "../../../packages/browser-search/contracts";

const networkErrorCodes = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/** Retry transport failures only; HTTP, revision and integrity errors pass through. */
export async function fetchSearchModel(input: string | URL, init?: RequestInit) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await globalThis.fetch(input, init);
    } catch (error) {
      const cause = (error as Error)?.cause as { code?: string } | undefined;
      const networkError =
        error instanceof TypeError &&
        error.message === "fetch failed" &&
        (!cause || networkErrorCodes.has(cause.code ?? ""));
      if (!networkError || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
}

/** Frozen publication builds use only the model cache packaged with the release. */
export async function loadSearchEncoder(
  offline = Boolean(process.env.PUBLIC_ARTIFACT_BUNDLE_PATH),
) {
  const { pipeline, env } = await import("@huggingface/transformers");
  env.allowLocalModels = offline;
  env.allowRemoteModels = !offline;
  env.useFSCache = !offline;
  env.remotePathTemplate = `{model}/resolve/${MODEL_REVISION}/`;
  // The exact local directory lets discovery probes find the pinned metadata
  // without a network request or cache write.
  if (offline && !env.cacheDir)
    throw new Error("Search model cache is unavailable");
  const model = offline
    ? path.join(env.cacheDir!, MODEL_ID, MODEL_REVISION)
    : MODEL_ID;
  const originalFetch = env.fetch;
  if (!offline) env.fetch = fetchSearchModel;
  try {
    return await pipeline("feature-extraction", model, {
      dtype: "q8",
      revision: MODEL_REVISION,
      local_files_only: offline,
    });
  } finally {
    env.fetch = originalFetch;
  }
}
