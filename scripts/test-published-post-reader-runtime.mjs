import { build } from "esbuild";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { compatibilityDate } from "workerd";

// No socket or external service is configured. The test bundles the actual
// Worker signer and relay with a synthetic Function fetch boundary.
const directory = await mkdtemp(join(tmpdir(), "njpbs-reader-runtime-"));
try {
  await build({ entryPoints: ["tests/published-post-reader-runtime.ts"], bundle: true, platform: "browser", format: "esm",
    outfile: join(directory, "test.mjs") });
  await writeFile(join(directory, "test.capnp"), `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (services = [(name = "reader", worker = (
  compatibilityDate = "${compatibilityDate}", modules = [(name = "main.mjs", esModule = embed "test.mjs")]
))]);\n`);
  const result = spawnSync(process.execPath, [resolve("node_modules/workerd/bin/workerd"), "test", "-I", resolve("node_modules"),
    join(directory, "test.capnp")], { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}

await import("./test-no-build-post-reader-runtime.mjs");
