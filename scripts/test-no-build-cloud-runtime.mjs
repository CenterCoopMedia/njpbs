import { build } from "esbuild";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { compatibilityDate } from "workerd";
const directory = await mkdtemp(join(tmpdir(), "njpbs-cloud-runtime-"));
try {
  await build({ entryPoints: ["tests/no-build-cloud-workerd.ts"], bundle: true, platform: "browser", format: "esm",
    outfile: join(directory, "test.mjs") });
  await writeFile(join(directory, "test.capnp"), `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (services = [(name = "cloud", worker = (
  compatibilityDate = "${compatibilityDate}",
  modules = [(name = "main.mjs", esModule = embed "test.mjs")]
))]);\n`);
  const result = spawnSync(resolve("node_modules/workerd/bin/workerd"), ["test", "-I", resolve("node_modules"),
    join(directory, "test.capnp")], { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally { await rm(directory, { recursive: true, force: true }); }
