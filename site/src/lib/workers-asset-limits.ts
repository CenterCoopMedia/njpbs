import { readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";

/** Cloudflare Workers static assets refuse any single file above 25 MiB. */
export const WORKERS_ASSET_MAX_BYTES = 25 * 1024 * 1024;

// The browser search pins the plain ONNX runtime (packages/browser-search/worker.ts,
// device "wasm"). Transformers.js also references the asyncify (WebGPU) build, which
// Vite emits but nothing loads; from onnxruntime-web 1.31 it is above the asset limit.
const UNUSED_RUNTIME_ASSET = /^ort-wasm-simd-threaded\.asyncify-[A-Za-z0-9_-]+\.wasm$/;

export async function pruneUnusedRuntimeAssets(distDirectory: string): Promise<string[]> {
  const assets = path.join(distDirectory, "_astro");
  let names: string[];
  try {
    names = await readdir(assets);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const removed = names.filter((name) => UNUSED_RUNTIME_ASSET.test(name));
  for (const name of removed) await unlink(path.join(assets, name));
  return removed.map((name) => `_astro/${name}`);
}

export async function assertWorkersAssetLimits(distDirectory: string): Promise<void> {
  const oversized: string[] = [];
  async function visit(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && (await stat(file)).size > WORKERS_ASSET_MAX_BYTES) {
        oversized.push(path.relative(distDirectory, file));
      }
    }
  }
  await visit(distDirectory);
  if (oversized.length) {
    throw new Error(`Static assets exceed the 25 MiB Workers limit: ${oversized.sort().join(", ")}`);
  }
}
