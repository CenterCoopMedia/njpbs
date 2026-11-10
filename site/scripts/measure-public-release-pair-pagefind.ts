import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import path from "node:path";
import os from "node:os";
import { artifactFiles, verifyPreparedPublicWorkerArtifact } from "../src/lib/public-worker-artifact";
import { installPublicReleasePairPagefindEngine, restorePublicReleasePairPagefindEngine } from "./public-release-pair-pagefind-engine";
import { privatePreviewSandbox } from "./process-cms-preview";
const args = process.argv.slice(2);
if (args.length !== 6 || args[0] !== "--dist" || args[2] !== "--prepared-artifact" || args[4] !== "--report") throw new Error("Exact dist, prepared artifact and report paths required");
const distDirectory = path.resolve(args[1]), reportPath = path.resolve(args[5]);
const prepared = await verifyPreparedPublicWorkerArtifact({ distDirectory, preparedArtifact: JSON.parse(await readFile(args[3], "utf8")) });
const files = await artifactFiles(distDirectory);
const directory = await mkdtemp(path.join(os.tmpdir(), "pair-pagefind-measure-"));
try {
  const engine = await installPublicReleasePairPagefindEngine(directory), native = path.join(directory, "pagefind");
  await restorePublicReleasePairPagefindEngine(directory, native);
  const inputs = path.join(directory, "inputs"), output = path.join(directory, "dist"), runner = path.join(directory, "runner.mjs"), input = path.join(directory, "input.json");
  await mkdir(inputs, { mode: 0o700 }); await mkdir(output, { mode: 0o700 });
  const frozen: Array<{ path: string; file: string; bytes: number; digest: string }> = [];
  const entries = files.filter(file => file.path.endsWith(".html")).map(file => ({ file,
      route: `/${file.path.replace(/(?:^|\/)index\.html$/, match => match.startsWith("/") ? "/" : "")}` }))
      .sort((a, b) => Buffer.compare(Buffer.from(a.route), Buffer.from(b.route)));
  for (const { file, route } of entries) {
      const bytes = await readFile(path.join(distDirectory, file.path));
      if (bytes.length !== file.bytes || createHash("sha256").update(bytes).digest("hex") !== file.digest) throw new Error("Frozen census changed");
      const name = `${frozen.length}.html`;
      await writeFile(path.join(inputs, name), bytes, { flag: "wx", mode: 0o600 });
      frozen.push({ path: route, file: name, bytes: bytes.length, digest: file.digest });
  }
  await writeFile(input, JSON.stringify(frozen), { flag: "wx", mode: 0o600 });
  await build({ entryPoints: [fileURLToPath(new URL("./render-public-release-pair-pagefind-measure.ts", import.meta.url))], outfile: runner,
    bundle: true, platform: "node", format: "esm", target: "node22",
    banner: { js: 'import { createRequire as __pairRequire } from "node:module"; const require = __pairRequire(import.meta.url);' } });
  const sandbox = await privatePreviewSandbox({ CMS_PREVIEW_INPUT_PATH: input, CMS_OFFLINE_BUILD: "1" }, output), launch = sandbox.args.slice(0, -1);
  launch.push("--ro-bind", inputs, "/pair/inputs", "--ro-bind", native, "/pair/pagefind", "--ro-bind", runner, "/pair/measure.mjs",
    "--ro-bind", await realpath(process.execPath), "/pair/node", "--", "/pair/node", "/pair/measure.mjs");
  const started = performance.now();
  await new Promise<void>((resolve, reject) => {
    const child = spawn("/usr/bin/bwrap", launch, { env: { PATH: "/usr/bin:/bin", NODE_ENV: "production", TZ: "America/New_York", CMS_OFFLINE_BUILD: "1" },
      stdio: "ignore", timeout: 120_000, killSignal: "SIGKILL" });
    child.once("error", reject); child.once("close", code => code === 0 ? resolve() : reject(new Error("Frozen Pagefind measurement refused")));
  });
  const sandboxElapsedMs = performance.now() - started, metrics = JSON.parse(await readFile(path.join(output, "metrics.json"), "utf8"));
  const report = { schemaVersion: 1, kind: "pair-pagefind-existing-census-measurement", measuredAt: new Date().toISOString(),
    node: process.version, platform: `${process.platform}-${process.arch}`, source: prepared, nativeEngineDigest: engine.sha256,
    nativeEngineBytes: engine.bytes, sealedNativeChunks: engine.chunks.length, metrics: { ...metrics, sandboxElapsedMs },
    note: "Actual immutable prepared HTML census identified by source. Pagefind rebuild only; excludes later CMS changes, NEW full-owner rendering, remote I/O and G staging. One real indexing operation under existing host conditions." };
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  process.stdout.write(JSON.stringify({ commitSha: prepared.commitSha, artifactFileCount: prepared.artifactFileCount, ...metrics, sandboxElapsedMs }) + "\n");
} finally { await rm(directory, { recursive: true, force: true }); }
