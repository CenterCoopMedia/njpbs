import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { constants } from "node:fs";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { build } from "esbuild";
import work from "../../functions/lib/public-release-pair-work.js";
import { MODEL_ID, MODEL_REVISION, DIMENSIONS } from "../../packages/browser-search/contracts";
import lock from "./public-release-pair-semantic-model-lock.json";
const require = createRequire(import.meta.url), CHUNK = 8 * 1024 * 1024, MAX_FILE = 256 * 1024 * 1024;
export const PAIR_SEMANTIC_ENGINE_DIRECTORY = "runtime/semantic";
type Chunk = { file: string; bytes: number; sha256: string };
type Member = { path: string; bytes: number; sha256: string; chunks: Chunk[] };
type Engine = { schemaVersion: 1; kind: "pair-semantic-engine"; modelId: string; revision: string; dtype: "q8"; dimensions: number;
  platform: "linux-x64"; transformersVersion: string; onnxVersion: string; files: Member[] };
export class PairSemanticEngineError extends work.PairExecutionError {
  constructor(readonly reason: "semantic-engine-missing" | "semantic-engine-mismatch" | "semantic-model-revision-mismatch") {
    super("input-unavailable"); this.name = "PairSemanticEngineError";
  }
}
function refuse(reason: PairSemanticEngineError["reason"] = "semantic-engine-mismatch"): never { throw new PairSemanticEngineError(reason); }
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function exact(value: any, fields: string[]) { if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== fields.sort().join()) refuse(); }
const modelPath = (name: string) => `model-cache/${MODEL_ID}/${MODEL_REVISION}/${name}`;
const expectedPaths = [...lock.files.map(file => modelPath(file.path)), "native/libonnxruntime.so.1", "native/onnxruntime_binding.node"].sort();
function parse(value: Engine): Engine {
  exact(value, ["schemaVersion", "kind", "modelId", "revision", "dtype", "dimensions", "platform", "transformersVersion", "onnxVersion", "files"]);
  if (value.modelId !== MODEL_ID || value.revision !== MODEL_REVISION || value.dtype !== "q8" || value.dimensions !== DIMENSIONS) refuse("semantic-model-revision-mismatch");
  if (value.schemaVersion !== 1 || value.kind !== "pair-semantic-engine" || value.platform !== "linux-x64" ||
      ![value.transformersVersion, value.onnxVersion].every(version => typeof version === "string" && /^[0-9]+\.[0-9]+\.[0-9]+(?:[-.A-Za-z0-9]+)?$/.test(version)) ||
      !Array.isArray(value.files) || value.files.length !== expectedPaths.length) refuse();
  value.files.forEach((file, index) => {
    exact(file, ["path", "bytes", "sha256", "chunks"]);
    if (file.path !== expectedPaths[index] || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > MAX_FILE || !/^[a-f0-9]{64}$/.test(file.sha256) ||
        !Array.isArray(file.chunks) || file.chunks.length !== Math.ceil(file.bytes / CHUNK)) refuse();
    const original = lock.files.find(row => modelPath(row.path) === file.path);
    if (original && (file.bytes !== original.bytes || file.sha256 !== original.sha256)) refuse("semantic-model-revision-mismatch");
    file.chunks.forEach((chunk, chunkIndex) => {
      exact(chunk, ["file", "bytes", "sha256"]);
      if (chunk.file !== `objects/${file.sha256}/${String(chunkIndex).padStart(4, "0")}.bin` ||
          chunk.bytes !== Math.min(CHUNK, file.bytes - chunkIndex * CHUNK) || !/^[a-f0-9]{64}$/.test(chunk.sha256)) refuse();
    });
  });
  return value;
}
/** No network here. The ordinary pinned model preparer runs before graph
 * compilation; its exact cache bytes must match the revision's Git/LFS lock. */
export async function installPublicReleasePairSemanticEngine(compiledDirectory: string, cacheDirectory?: string) {
  if (process.platform !== "linux" || process.arch !== "x64") refuse();
  const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.resolve("@huggingface/transformers"))));
  const transformers = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  const onnxRoot = path.dirname(path.dirname(require.resolve("onnxruntime-node"))), onnx = JSON.parse(await readFile(path.join(onnxRoot, "package.json"), "utf8"));
  const directory = path.join(compiledDirectory, PAIR_SEMANTIC_ENGINE_DIRECTORY);
  await rm(directory, { recursive: true, force: true }); await mkdir(directory, { recursive: true, mode: 0o700 });
  const sources = [...lock.files.map(file => ({ path: modelPath(file.path), source: path.join(cacheDirectory ?? path.join(packageRoot, ".cache"), MODEL_ID, MODEL_REVISION, file.path) })),
    ...["libonnxruntime.so.1", "onnxruntime_binding.node"].map(name => ({ path: `native/${name}`, source: path.join(onnxRoot, "bin/napi-v6/linux/x64", name) }))]
    .sort((a, b) => a.path < b.path ? -1 : 1);
  const files: Member[] = [];
  for (const source of sources) {
    let handle;
    try { handle = await open(source.source, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") refuse("semantic-engine-missing"); throw error; }
    try {
      const before = await handle.stat(); if (!before.isFile() || before.size < 1 || before.size > MAX_FILE) refuse();
      // Read one bounded member, then persist bounded graph chunks. Model and
      // native members are bounded independently; no whole-pack byte cache.
      const body = await handle.readFile(), digest = hash(body), chunks: Chunk[] = [];
      const expected = lock.files.find(row => modelPath(row.path) === source.path);
      if (expected && (digest !== expected.sha256 || body.length !== expected.bytes)) refuse("semantic-model-revision-mismatch");
      for (let offset = 0; offset < body.length; offset += CHUNK) {
        const bytes = body.subarray(offset, offset + CHUNK), file = `objects/${digest}/${String(chunks.length).padStart(4, "0")}.bin`;
        await mkdir(path.dirname(path.join(directory, file)), { recursive: true, mode: 0o700 });
        await writeFile(path.join(directory, file), bytes, { flag: "wx", mode: 0o600 }); chunks.push({ file, bytes: bytes.length, sha256: hash(bytes) });
      }
      const after = await handle.stat(); if (body.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) refuse();
      files.push({ path: source.path, bytes: body.length, sha256: digest, chunks });
    } finally { await handle.close(); }
  }
  const descriptor = parse({ schemaVersion: 1, kind: "pair-semantic-engine", modelId: MODEL_ID, revision: MODEL_REVISION, dtype: "q8", dimensions: DIMENSIONS,
    platform: "linux-x64", transformersVersion: transformers.version, onnxVersion: onnx.version, files });
  await writeFile(path.join(directory, "engine.json"), JSON.stringify(descriptor) + "\n", { flag: "wx", mode: 0o600 });
  await build({ entryPoints: [fileURLToPath(new URL("./encode-public-release-pair-semantic.ts", import.meta.url))], outfile: path.join(directory, "encoder.mjs"),
    bundle: true, platform: "node", format: "esm", target: "node22", resolveExtensions: [".ts", ".js", ".mjs", ".json"],
    external: ["/pair/semantic/native/onnxruntime_binding.node"],
    banner: { js: 'import { createRequire as __pairRequire } from "node:module"; const require = __pairRequire(import.meta.url);' },
    plugins: [{ name: "frozen-text-native-runtime", setup(builder) {
      builder.onLoad({ filter: /@huggingface[/\\]transformers[/\\]dist[/\\]transformers\.node\.mjs$/ }, async args => {
        const source = await readFile(args.path, "utf8"), needle = 'requireFromHere("onnxruntime-node")';
        if (source.split(needle).length !== 2) refuse();
        return { contents: 'import * as __pairNativeOnnx from "onnxruntime-node";\n' + source.replace(needle, "__pairNativeOnnx"), loader: "js" };
      });
      builder.onLoad({ filter: /onnxruntime-node[/\\]dist[/\\]binding\.js$/ }, async args => {
        const source = await readFile(args.path, "utf8"), needle = 'require(`../bin/napi-v6/${process.platform}/${process.arch}/onnxruntime_binding.node`)';
        if (source.split(needle).length !== 2) refuse();
        return { contents: source.replace(needle, 'require("/pair/semantic/native/onnxruntime_binding.node")'), loader: "js" };
      });
      builder.onResolve({ filter: /^(sharp|onnxruntime-web(?:\/.*)?)$/ }, args => ({ path: args.path, namespace: "pair-text-only" }));
      builder.onLoad({ filter: /.*/, namespace: "pair-text-only" }, args => ({ contents: args.path === "sharp"
        ? 'export default function(){throw new Error("Frozen semantic engine has no image backend")}'
        : 'export const env={}; export class Tensor{}; export const InferenceSession={create(){throw new Error("Frozen semantic engine has no web backend")}};' }));
    } }] });
  return descriptor;
}
/** Called only after the whole local graph matched the pair. Restore every
 * original body by digest before any encoder import; never use a mutable cache. */
export async function restorePublicReleasePairSemanticEngine(compiledDirectory: string, outputDirectory: string) {
  const directory = path.join(compiledDirectory, PAIR_SEMANTIC_ENGINE_DIRECTORY);
  let descriptor: Engine;
  try { descriptor = parse(JSON.parse(await readFile(path.join(directory, "engine.json"), "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") refuse("semantic-engine-missing"); throw error; }
  await mkdir(outputDirectory, { mode: 0o700 });
  let complete = false;
  try {
    for (const file of descriptor.files) {
      const destination = path.join(outputDirectory, file.path); await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      const handle = await open(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o400), proof = createHash("sha256");
      try {
        for (const chunk of file.chunks) {
          let source;
          try { source = await open(path.join(directory, chunk.file), constants.O_RDONLY | constants.O_NOFOLLOW); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") refuse("semantic-engine-missing"); throw error; }
          let bytes: Buffer;
          try { const before = await source.stat(); if (!before.isFile() || before.size !== chunk.bytes) refuse(); bytes = await source.readFile(); }
          finally { await source.close(); }
          if (bytes.length !== chunk.bytes || hash(bytes) !== chunk.sha256) refuse(); proof.update(bytes); await handle.writeFile(bytes);
        }
        if ((await handle.stat()).size !== file.bytes || proof.digest("hex") !== file.sha256) refuse();
      } finally { await handle.close(); }
    }
    complete = true; return descriptor;
  } finally { if (!complete) await rm(outputDirectory, { recursive: true, force: true }); }
}
