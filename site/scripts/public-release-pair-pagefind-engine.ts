import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { constants } from "node:fs";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const CHUNK = 8 * 1024 * 1024, MAX = 256 * 1024 * 1024;
export const PAIR_PAGEFIND_ENGINE_DIRECTORY = "runtime/pagefind-native";
type Engine = { schemaVersion: 1; kind: "pair-pagefind-engine"; version: "1.5.0"; platform: "linux-x64";
  bytes: number; sha256: string; chunks: { file: string; bytes: number; sha256: string }[] };
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
function refuse(): never { throw new Error("Frozen Pagefind engine differs"); }
function exact(value: any, fields: string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== fields.sort().join()) refuse();
}
function parse(value: Engine): Engine {
  exact(value, ["schemaVersion", "kind", "version", "platform", "bytes", "sha256", "chunks"]);
  if (value.schemaVersion !== 1 || value.kind !== "pair-pagefind-engine" || value.version !== "1.5.0" || value.platform !== "linux-x64" ||
      !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > MAX || !/^[a-f0-9]{64}$/.test(value.sha256) ||
      !Array.isArray(value.chunks) || value.chunks.length !== Math.ceil(value.bytes / CHUNK)) refuse();
  for (let index = 0; index < value.chunks.length; index++) {
    const row = value.chunks[index]; exact(row, ["file", "bytes", "sha256"]);
    if (row.file !== `${String(index).padStart(4, "0")}.bin` || row.bytes !== Math.min(CHUNK, value.bytes - index * CHUNK) || !/^[a-f0-9]{64}$/.test(row.sha256)) refuse();
  }
  return value;
}
/** Build-time only. Split the pinned native binary so every compiled graph
 * member fits the unchanged 16 MiB code-pack member limit. */
export async function installPublicReleasePairPagefindEngine(compiledDirectory: string) {
  const packageJson = JSON.parse(await readFile(fileURLToPath(new URL("../package.json", import.meta.resolve("pagefind"))), "utf8"));
  if (packageJson.version !== "1.5.0" || process.platform !== "linux" || process.arch !== "x64") refuse();
  const source = require.resolve("@pagefind/linux-x64/bin/pagefind_extended"), input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  const directory = path.join(compiledDirectory, PAIR_PAGEFIND_ENGINE_DIRECTORY);
  try {
    const before = await input.stat(); if (!before.isFile() || before.size < 1 || before.size > MAX) refuse();
    await rm(directory, { recursive: true, force: true }); await mkdir(directory, { recursive: true, mode: 0o700 });
    const chunks: Engine["chunks"] = [], proof = createHash("sha256");
    for (let offset = 0; offset < before.size; offset += CHUNK) {
      const bytes = new Uint8Array(Math.min(CHUNK, before.size - offset));
      let used = 0;
      while (used < bytes.length) { const next = await input.read(bytes, used, bytes.length - used, offset + used); if (!next.bytesRead) refuse(); used += next.bytesRead; }
      const file = `${String(chunks.length).padStart(4, "0")}.bin`;
      proof.update(bytes); chunks.push({ file, bytes: bytes.length, sha256: hash(bytes) });
      await writeFile(path.join(directory, file), bytes, { flag: "wx", mode: 0o600 });
    }
    const after = await input.stat(); if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) refuse();
    const descriptor = parse({ schemaVersion: 1, kind: "pair-pagefind-engine", version: "1.5.0", platform: "linux-x64",
      bytes: before.size, sha256: proof.digest("hex"), chunks });
    await writeFile(path.join(directory, "engine.json"), JSON.stringify(descriptor) + "\n", { flag: "wx", mode: 0o600 });
    return descriptor;
  } finally { await input.close(); }
}
/** Caller first verifies the complete compiled graph against the pair. The
 * resulting executable is bound read-only at /pair/pagefind in the OS sandbox. */
export async function restorePublicReleasePairPagefindEngine(compiledDirectory: string, output: string) {
  const directory = path.join(compiledDirectory, PAIR_PAGEFIND_ENGINE_DIRECTORY);
  const descriptor = parse(JSON.parse(await readFile(path.join(directory, "engine.json"), "utf8")));
  const target = await open(output, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  let complete = false;
  try {
    const proof = createHash("sha256");
    for (const chunk of descriptor.chunks) {
      const source = await open(path.join(directory, chunk.file), constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Buffer;
      try { const stat = await source.stat(); if (!stat.isFile() || stat.size !== chunk.bytes) refuse(); bytes = await source.readFile(); }
      finally { await source.close(); }
      if (bytes.length !== chunk.bytes || hash(bytes) !== chunk.sha256) refuse();
      proof.update(bytes); await target.writeFile(bytes);
    }
    if (proof.digest("hex") !== descriptor.sha256 || (await target.stat()).size !== descriptor.bytes) refuse();
    await target.chmod(0o700); complete = true; return descriptor;
  } finally { await target.close(); if (!complete) await rm(output, { force: true }); }
}
