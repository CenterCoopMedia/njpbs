import { build } from "esbuild";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { compatibilityDate } from "workerd";

// Real RPC binding and CMS entrypoint, with only its Function network boundary
// substituted. No sockets or external network access and no production secrets.
const directory = await mkdtemp(join(tmpdir(), "njpbs-admission-runtime-"));
try {
  await build({ entryPoints: { test: "tests/no-build-post-reader-runtime.ts", cms: "cms-api/src/index.ts" },
    bundle: true, platform: "browser", format: "esm", external: ["cloudflare:workers", "node:*"], outdir: directory });
  const reader = (name, secret) => `(name = "${name}", worker = (
    compatibilityDate = "${compatibilityDate}", modules = [(name = "main.mjs", esModule = embed "cms.js")],
    globalOutbound = (name = "function", entrypoint = "FunctionBoundary"),
    bindings = [(name = "CMS_EDGE_ORIGIN_SECRET", text = "${secret}"),
      (name = "FUNCTIONS_ORIGIN", text = "https://functions.example.test")]
  ))`;
  await writeFile(join(directory, "test.capnp"), `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (services = [
  (name = "test", worker = (
    compatibilityDate = "${compatibilityDate}", modules = [(name = "main.mjs", esModule = embed "test.js")],
    bindings = [(name = "CONTENT", service = (name = "reader", entrypoint = "PublicContentEntrypoint")),
      (name = "UNAUTHENTICATED", service = (name = "unauthenticated", entrypoint = "PublicContentEntrypoint")),
      (name = "CONTROL", service = (name = "function", entrypoint = "FunctionBoundary"))]
  )),
  ${reader("reader", "synthetic-edge-fixture")},
  ${reader("unauthenticated", "incorrect-fixture")},
  (name = "function", worker = (compatibilityDate = "${compatibilityDate}",
    modules = [(name = "main.mjs", esModule = embed "test.js")])),
  (name = "internet", network = (allow = []))
]);\n`);
  const result = spawnSync(process.execPath, [resolve("node_modules/workerd/bin/workerd"), "test", "-I", resolve("node_modules"),
    join(directory, "test.capnp"), "test"], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
