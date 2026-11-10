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

/** Prefer the pinned cache; frozen publication builds never download missing files. */
export async function loadSearchEncoder(
  offline = Boolean(process.env.PUBLIC_ARTIFACT_BUNDLE_PATH),
) {
  const { pipeline, env, ModelFileNotFoundError } = await import("@huggingface/transformers");
  env.remotePathTemplate = `{model}/resolve/${MODEL_REVISION}/`;
  const originalFetch = env.fetch;
  const load = (cacheOnly: boolean) => {
    env.allowLocalModels = cacheOnly;
    env.allowRemoteModels = !cacheOnly;
    env.useFSCache = !cacheOnly;
    env.fetch = cacheOnly ? originalFetch : fetchSearchModel;
    // The exact directory keeps optional discovery probes local too.
    if (cacheOnly && !env.cacheDir)
      throw new Error("Search model cache is unavailable");
    const model = cacheOnly
      ? path.join(env.cacheDir!, MODEL_ID, MODEL_REVISION)
      : MODEL_ID;
    return pipeline("feature-extraction", model, {
      dtype: "q8",
      revision: MODEL_REVISION,
      local_files_only: cacheOnly,
    });
  };
  try {
    try {
      return await load(true);
    } catch (error) {
      if (offline || !(error instanceof ModelFileNotFoundError)) throw error;
      return await load(false);
    }
  } finally {
    env.fetch = originalFetch;
  }
}
