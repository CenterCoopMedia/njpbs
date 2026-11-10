import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterAll, beforeAll, expect, it } from "vitest";
import { privatePreviewSandbox } from "../../site/scripts/process-cms-preview";
import { installPublicReleasePairSemanticEngine, restorePublicReleasePairSemanticEngine, PAIR_SEMANTIC_ENGINE_DIRECTORY } from "../../site/scripts/public-release-pair-semantic-engine";
let directory: string, compiled: string, restored: string, descriptor: Awaited<ReturnType<typeof installPublicReleasePairSemanticEngine>>;
beforeAll(async () => {
  const cache = process.env.PAIR_SEMANTIC_TEST_MODEL_CACHE;
  if (!cache) throw new Error("Set explicit pinned local model cache for this focused proof");
  directory = await mkdtemp(path.join(os.tmpdir(), "pair-semantic-")); compiled = path.join(directory, "compiled"); restored = path.join(directory, "restored");
  descriptor = await installPublicReleasePairSemanticEngine(compiled, cache);
  expect(descriptor.files.every(file => file.chunks.every(chunk => chunk.bytes <= 8 * 1024 * 1024))).toBe(true);
  await restorePublicReleasePairSemanticEngine(compiled, restored);
}, 60_000);
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
it("encodes using only the real pinned model and sealed native runtime in the offline OS sandbox", async () => {
  const job = await mkdtemp(path.join(os.tmpdir(), "pair-semantic-job-"));
  try {
    const input = path.join(job, "input.json"), dist = path.join(job, "dist"), runner = path.join(job, "runner.mjs");
    await mkdir(dist, { mode: 0o700 }); await writeFile(input, "{}");
    await writeFile(runner, `import {writeFile} from "node:fs/promises";
let networkAttempts=0; globalThis.fetch=async()=>{networkAttempts++;throw new Error("No network")};
const {createPublicReleasePairSemanticEncoder}=await import("/pair/encoder.mjs");
const encoder=await createPublicReleasePairSemanticEncoder();
try {const first=await encoder.encode("Original title\\nExact accepted article body.");
const changed=await encoder.encode("New title\\nExact accepted article body.");
await writeFile("/preview/dist/result.json",JSON.stringify({first,changed,networkAttempts,modelLoadMs:encoder.modelLoadMs}));}
finally{await encoder.dispose();}
`);
    const sandbox = await privatePreviewSandbox({ CMS_OFFLINE_BUILD: "1", CMS_PREVIEW_INPUT_PATH: input }, dist), args = sandbox.args.slice(0, -1);
    args.push("--ro-bind", restored, "/pair/semantic", "--ro-bind", path.join(compiled, PAIR_SEMANTIC_ENGINE_DIRECTORY, "encoder.mjs"), "/pair/encoder.mjs",
      "--ro-bind", runner, "/pair/run.mjs", "--ro-bind", await realpath(process.execPath), "/pair/node", "--", "/pair/node", "/pair/run.mjs");
    await new Promise<void>((resolve, reject) => {
      const child = spawn("/usr/bin/bwrap", args, { env: { PATH: "/usr/bin:/bin", NODE_ENV: "production", CMS_OFFLINE_BUILD: "1" }, stdio: ["ignore", "ignore", "pipe"], timeout: 60_000, killSignal: "SIGKILL" });
      let error = ""; child.stderr.on("data", bytes => { if (error.length < 2000) error += bytes.toString().slice(0, 2000 - error.length); });
      child.once("error", reject); child.once("close", code => code === 0 ? resolve() : reject(new Error(`Frozen native encode refused: ${error}`)));
    });
    const result = JSON.parse(await readFile(path.join(dist, "result.json"), "utf8"));
    expect(result.first).toHaveLength(384); expect(result.first.every((value: unknown) => typeof value === "number" && Number.isFinite(value))).toBe(true);
    expect(result.changed).not.toEqual(result.first); expect(result.networkAttempts).toBe(0); expect(result.modelLoadMs).toBeGreaterThan(0);
  } finally { await rm(job, { recursive: true, force: true }); }
}, 60_000);
it("refuses a missing frozen weight chunk before importing any encoder", async () => {
  const file = descriptor.files.find(file => file.path.endsWith(".onnx"))!, name = path.join(compiled, PAIR_SEMANTIC_ENGINE_DIRECTORY, file.chunks[0].file), body = await readFile(name);
  try { await rm(name); await expect(restorePublicReleasePairSemanticEngine(compiled, path.join(directory, "missing"))).rejects.toMatchObject({ reason: "semantic-engine-missing" }); }
  finally { await writeFile(name, body); }
});
it("refuses a model revision mismatch before reading weights", async () => {
  const file = path.join(compiled, PAIR_SEMANTIC_ENGINE_DIRECTORY, "engine.json"), original = await readFile(file), raw = JSON.parse(original.toString());
  try { raw.revision = "f".repeat(40); await writeFile(file, JSON.stringify(raw));
    await expect(restorePublicReleasePairSemanticEngine(compiled, path.join(directory, "wrong-revision"))).rejects.toMatchObject({ reason: "semantic-model-revision-mismatch" }); }
  finally { await writeFile(file, original); }
});
