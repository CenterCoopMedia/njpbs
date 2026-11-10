import path from "node:path";
import { performance } from "node:perf_hooks";
import { pipeline, env } from "@huggingface/transformers";
import { MODEL_ID, MODEL_REVISION, DIMENSIONS } from "../../packages/browser-search/contracts";
/** Bundled into the sealed graph with the fixed native binding adapter. The
 * parent restores and binds only the verified model/runtime pack at this path. */
export async function createPublicReleasePairSemanticEncoder() {
  const started = performance.now();
  env.cacheDir = "/pair/semantic/model-cache";
  env.allowLocalModels = true; env.allowRemoteModels = false; env.useFSCache = false;
  env.fetch = async () => { throw new Error("Frozen semantic encoder has no network"); };
  const encoder = await pipeline("feature-extraction", path.join(env.cacheDir, MODEL_ID, MODEL_REVISION), {
    dtype: "q8", revision: MODEL_REVISION, local_files_only: true,
    session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 },
  });
  return {
    modelLoadMs: performance.now() - started,
    async encode(input: string) {
      if (typeof input !== "string" || !input || input.length > 16 * 1024 * 1024) throw new Error("Frozen semantic input differs");
      const output = await encoder(input, { pooling: "mean", normalize: true });
      const vector = Array.from(output.data, value => Math.round(Number(value) * 1e6) / 1e6);
      if (vector.length !== DIMENSIONS || vector.some(value => !Number.isFinite(value))) throw new Error("Frozen semantic vector differs");
      return vector;
    },
    dispose: () => encoder.dispose(),
  };
}
