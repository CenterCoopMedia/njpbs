import { expect, it } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

it("bundles the private Worker without Node-only database or build dependencies", async () => {
  const result = await build({ entryPoints: [fileURLToPath(new URL("./pair-worker.ts", import.meta.url))],
    bundle: true, platform: "browser", format: "esm", write: false, metafile: true, logLevel: "silent",
    external: ["cloudflare:workers", "@cloudflare/containers", "node:crypto", "node:util", "node:buffer"] });
  expect(Object.keys(result.metafile.inputs).filter(path => /firebase-admin|google-cloud|grpc|google-gax/.test(path))).toEqual([]);
  expect(result.outputFiles[0].contents.length).toBeLessThan(512_000);
});
