import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
const sealName = "pair-renderer-release.json";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
async function inventoryEntries(directory, prefix = "") {
  const files = [];
  for (const name of (await readdir(path.join(directory, prefix))).sort()) {
    const relative = path.posix.join(prefix, name);
    if (relative === sealName) continue;
    const status = await lstat(path.join(directory, relative));
    if (status.isDirectory()) files.push(...await inventoryEntries(directory, relative));
    else if (status.isFile()) files.push({ relative, size: status.size });
    else throw new Error("Private pair renderer contains a non-regular file");
  }
  return files;
}
async function inventory(directory) {
  const files = {}, entries = await inventoryEntries(directory);
  let batch = [], bytes = 0;
  const flush = async () => {
    const results = await Promise.allSettled(batch.map(async entry => [entry.relative, hash(await readFile(path.join(directory, entry.relative)))]));
    for (const result of results) if (result.status === "rejected") throw result.reason;
    for (const result of results) if (result.status === "fulfilled") files[result.value[0]] = result.value[1];
    batch = []; bytes = 0;
  };
  for (const entry of entries) {
    // Four reads and 32 MiB at a time. A pre-existing larger member stays
    // serial; valid graphs and their canonical seal bytes are unchanged.
    if (batch.length && (batch.length === 4 || bytes + entry.size > 32 * 1024 * 1024)) await flush();
    batch.push(entry); bytes += entry.size;
  }
  await flush();
  return files;
}
function digests(bytes, files) {
  const assets = Object.fromEntries(Object.entries(files).filter(([name]) => name.startsWith("client/")));
  return { rendererDigest: hash(bytes), compiledClientManifestDigest: hash(JSON.stringify(assets)) };
}
export async function sealPublicReleasePairRenderer(directory, rendererSha) {
  if (!/^[a-f0-9]{40}$/.test(rendererSha)) throw new Error("Invalid pair renderer source");
  const files = await inventory(directory);
  if (!files["server/entry.mjs"] || !files["runtime/pair.mjs"] || !Object.keys(files).some(name => name.startsWith("client/"))) {
    throw new Error("Private pair renderer is incomplete");
  }
  const bytes = JSON.stringify({ schemaVersion: 1, kind: "pair-public-renderer", rendererSha, files }) + "\n";
  await writeFile(path.join(directory, sealName), bytes, { mode: 0o600 });
  return digests(bytes, files);
}
export async function verifyPublicReleasePairRenderer(directory, pair) {
  if (!(await lstat(path.join(directory, sealName))).isFile()) throw new Error("Invalid pair renderer seal");
  const bytes = await readFile(path.join(directory, sealName)), manifest = JSON.parse(bytes.toString("utf8"));
  const files = await inventory(directory), expected = digests(bytes, files);
  const publicSeal = JSON.parse(await readFile(path.join(directory, "renderer-release.json"), "utf8"));
  if (publicSeal.rendererSha !== pair.commitSha || (publicSeal.environment ?? "production") !== pair.environment) {
    throw new Error("Private pair renderer environment differs");
  }
  if (Object.keys(manifest).sort().join(",") !== "files,kind,rendererSha,schemaVersion" ||
      manifest.schemaVersion !== 1 || manifest.kind !== "pair-public-renderer" || manifest.rendererSha !== pair.commitSha ||
      !files["server/entry.mjs"] || !files["runtime/pair.mjs"] ||
      JSON.stringify(files) !== JSON.stringify(manifest.files) || expected.rendererDigest !== pair.rendererDigest) throw new Error("Private pair renderer seal differs");
  return expected;
}
