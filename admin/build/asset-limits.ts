import type { Plugin } from "vite";
import { readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";

/** Cloudflare Pages refuses any single file above 25 MiB. */
export const PAGES_ASSET_MAX_BYTES = 25 * 1024 * 1024;

// Meaning search pins the plain ONNX runtime (packages/browser-search/worker.ts,
// device "wasm"). Transformers.js also references the asyncify (WebGPU) build, which
// Vite emits but nothing loads; from onnxruntime-web 1.31 it is above the file limit.
const UNUSED_RUNTIME_ASSET = /^ort-wasm-simd-threaded\.asyncify-[A-Za-z0-9_-]+\.wasm$/;

async function files(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await files(file));
    else if (entry.isFile()) found.push(file);
  }
  return found;
}

/** Bundle deletes are not honored for emitted assets, so prune the written output. */
export function adminAssetLimitsPlugin(): Plugin {
  let outDir = "";
  return {
    name: "admin-asset-limits",
    apply: "build",
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      const oversized: string[] = [];
      for (const file of await files(outDir)) {
        if (UNUSED_RUNTIME_ASSET.test(path.basename(file))) await unlink(file);
        else if ((await stat(file)).size > PAGES_ASSET_MAX_BYTES) oversized.push(path.relative(outDir, file));
      }
      if (oversized.length) {
        throw new Error(`Admin assets exceed the 25 MiB Pages limit: ${oversized.sort().join(", ")}`);
      }
    },
  };
}
