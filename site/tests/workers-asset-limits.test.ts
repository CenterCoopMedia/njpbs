import { mkdtemp, mkdir, readdir, rm, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { WORKERS_ASSET_MAX_BYTES, assertWorkersAssetLimits, pruneUnusedRuntimeAssets } from "../src/lib/workers-asset-limits";

let dist: string;
beforeEach(async () => {
  dist = await mkdtemp(path.join(os.tmpdir(), "workers-assets-"));
  await mkdir(path.join(dist, "_astro"));
});
afterEach(() => rm(dist, { recursive: true, force: true }));

// Names from the October 26, 2026 release 23 build of onnxruntime-web 1.31.
it("removes only the unused asyncify ONNX runtime", async () => {
  for (const name of ["ort-wasm-simd-threaded.asyncify-CxOG5pUO.wasm", "ort-wasm-simd-threaded-4byDm7i3.wasm", "ort-wasm-simd-threaded-BQJNh0bu.mjs"]) {
    await writeFile(path.join(dist, "_astro", name), "x");
  }
  expect(await pruneUnusedRuntimeAssets(dist)).toEqual(["_astro/ort-wasm-simd-threaded.asyncify-CxOG5pUO.wasm"]);
  expect((await readdir(path.join(dist, "_astro"))).sort()).toEqual(["ort-wasm-simd-threaded-4byDm7i3.wasm", "ort-wasm-simd-threaded-BQJNh0bu.mjs"]);
});

it("refuses a build with a file above the Workers asset limit", async () => {
  const file = path.join(dist, "_astro", "large.wasm");
  await writeFile(file, "");
  await truncate(file, WORKERS_ASSET_MAX_BYTES);
  await expect(assertWorkersAssetLimits(dist)).resolves.toBeUndefined();
  await truncate(file, WORKERS_ASSET_MAX_BYTES + 1);
  await expect(assertWorkersAssetLimits(dist)).rejects.toThrow("_astro/large.wasm");
});
