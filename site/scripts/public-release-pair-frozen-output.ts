import { createHash } from "node:crypto";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { PairTaskIdentity } from "../../functions/lib/public-release-pair-work";
import type { PairInputRoot } from "../../functions/lib/public-release-pair-input";
import protocol from "../../functions/lib/public-release-pair.js";
import input from "../../functions/lib/public-release-pair-input.js";
import views from "../../functions/lib/public-release-pair-view.js";
import work from "../../functions/lib/public-release-pair-work.js";
export const PAIR_FROZEN_OUTPUT_FILE = "frozen-output.json";
const CHUNK_BYTES = 4 * 1024 * 1024;
export type PairFrozenOutput = Readonly<{ path: string; dynamic: true; mime: string; size: number; sha256: string;
  chunks: readonly Readonly<{ name: string; digest: string }>[] }>;
export type PairFrozenOutputPlan = Readonly<{ schemaVersion: 1; kind: "pair-frozen-output"; pairDigest: string;
  codeAssetManifestDigest: string; cursor: PairInputRoot["cursor"]; outputs: readonly PairFrozenOutput[] }>;
// The caller opens this through the source-owned immutable code-pack reader;
// this parser does not replace that reader's complete manifest/member proof.
type VerifiedBaseline = Readonly<{ codeAssetManifestDigest: string; members: readonly Readonly<{
  path: string; mime: string; family: string; source: string; dynamic: boolean }>[] }>;
function refuse(): never { throw new work.PairExecutionError("input-unavailable"); }
function exact(value: unknown, names: string[]): asserts value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== [...names].sort().join(",")) refuse();
}
const packets = new Map([["/schedule/downloads/nj-pbs-schedule.pdf", "schedule-packet/pdf"],
  ["/_schedule-sources.json", "schedule-packet/json"]]);
/** Production copy adapter: derive only the two exact accepted packet exports
 * from H's real provider roster. No synthetic producer descriptor is required. */
export async function derivePublicReleasePairFrozenSchedule(context: {
  root: PairInputRoot; baseline: VerifiedBaseline; readFile(name: string): Promise<Uint8Array>;
}) {
  const read = async (name: string) => {
    const file = context.root.files.find(file => file.name === name), bytes = await context.readFile(name);
    if (!file || bytes.length !== file.bytes || createHash("sha256").update(bytes).digest("hex") !== file.digest) refuse();
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return refuse(); }
  };
  if (!context.root.entryFiles.includes("source-dependencies.json")) refuse();
  const dependency = await read("source-dependencies.json"); exact(dependency, ["schemaVersion"]); if (dependency.schemaVersion !== 1) refuse();
  const provider = await read("provider-inputs.json"); exact(provider, ["schemaVersion", "externalInputs", "retainedHome", "files"]);
  if (provider.schemaVersion !== 1 || !Array.isArray(provider.files)) refuse();
  const outputs = [];
  for (const [path, name] of packets) {
    const baseline = context.baseline.members.filter(member => member.path === path), selected = provider.files.filter((file: any) => file.name === name);
    if (baseline.length !== 1 || baseline[0].source !== "aggregate" || !baseline[0].dynamic || selected.length !== 1) refuse();
    const file = selected[0]; exact(file, ["name", "key", "digest", "bytes", "contentType", "chunkFiles"]);
    const mime = baseline[0].mime, expectedMime = path.endsWith(".pdf") ? "application/pdf" : "application/json";
    if (mime.split(";")[0] !== expectedMime || typeof file.contentType !== "string" || file.contentType.split(";")[0].trim().toLowerCase() !== expectedMime ||
        !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > views.BODY_BYTES_LIMIT || !/^[a-f0-9]{64}$/.test(file.digest) ||
        !Array.isArray(file.chunkFiles) || file.chunkFiles.length !== Math.ceil(file.bytes / CHUNK_BYTES) || new Set(file.chunkFiles).size !== file.chunkFiles.length) refuse();
    const parts = [];
    for (let index = 0; index < file.chunkFiles.length; index++) {
      const packed = await read(file.chunkFiles[index]); exact(packed, ["bodyBase64"]);
      if (typeof packed.bodyBase64 !== "string") refuse();
      const bytes = Buffer.from(packed.bodyBase64, "base64");
      if (bytes.toString("base64") !== packed.bodyBase64 || bytes.length !== Math.min(CHUNK_BYTES, file.bytes - index * CHUNK_BYTES)) refuse();
      parts.push(bytes);
    }
    const bytes = Buffer.concat(parts);
    if (bytes.length !== file.bytes || createHash("sha256").update(bytes).digest("hex") !== file.digest) refuse();
    if (expectedMime === "application/json") try { JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { refuse(); }
    outputs.push({ path, mime, bytes });
  }
  return outputs.sort((a, b) => views.comparePrivatePairArtifactPaths(a.path, b.path));
}
/** Only the two exact raw accepted Schedule packet files may use copy actions.
 * NEW-code aggregate projections have a separate adapter/descriptor. */
export function parsePublicReleasePairFrozenOutput(bytes: Uint8Array, context: {
  pair: PublicReleasePair; identity: PairTaskIdentity; root: PairInputRoot; baseline: VerifiedBaseline; providerInputs: Uint8Array; sourceDependencies: Uint8Array;
}): PairFrozenOutputPlan {
  const pair = protocol.parsePublicReleasePair(context.pair), identity = views.parseViewIdentity(context.identity, pair);
  const root = input.parsePublicReleasePairInputRoot(context.root, pair);
  const scope = { kind: identity.kind, sourceOperationId: identity.sourceOperationId, sourceVersion: identity.sourceVersion,
    snapshotDigest: identity.snapshotDigest, contextSequence: identity.contextSequence };
  if (protocol.publicReleaseDigest(scope) !== protocol.publicReleaseDigest(root.scope) || (!root.entryFiles.includes(PAIR_FROZEN_OUTPUT_FILE) || !root.entryFiles.includes("source-dependencies.json")) ||
      context.baseline.codeAssetManifestDigest !== pair.codeAssetManifestDigest) refuse();
  const named = new Map(root.files.map(file => [file.name, file]));
  const read = (bytes: Uint8Array, name: string): unknown => {
    const file = named.get(name);
    if (!(bytes instanceof Uint8Array) || !file || bytes.length !== file.bytes ||
        createHash("sha256").update(bytes).digest("hex") !== file.digest) refuse();
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { return refuse(); }
  };
  const sourceEntry = read(context.sourceDependencies, "source-dependencies.json");
  exact(sourceEntry, ["schemaVersion"]);
  if (sourceEntry.schemaVersion !== 1) refuse();
  const value = read(bytes, PAIR_FROZEN_OUTPUT_FILE);
  exact(value, ["schemaVersion", "kind", "pairDigest", "codeAssetManifestDigest", "cursor", "outputs"]);
  const cursor = views.parsePublicReleasePairViewCursor(value.cursor, identity);
  if (value.schemaVersion !== 1 || value.kind !== "pair-frozen-output" || value.pairDigest !== protocol.publicReleaseDigest(pair) ||
      value.codeAssetManifestDigest !== pair.codeAssetManifestDigest || protocol.publicReleaseDigest(cursor) !== protocol.publicReleaseDigest(root.cursor) ||
      !Array.isArray(value.outputs) || value.outputs.length !== packets.size) refuse();
  const provider = read(context.providerInputs, "provider-inputs.json");
  exact(provider, ["schemaVersion", "externalInputs", "retainedHome", "files"]);
  if (provider.schemaVersion !== 1 || !Array.isArray(provider.files)) refuse();
  let previous = "";
  const outputs: PairFrozenOutput[] = value.outputs.map((raw: unknown) => {
    exact(raw, ["path", "dynamic", "mime", "size", "sha256", "chunks"]);
    if (typeof raw.path !== "string" || views.comparePrivatePairArtifactPaths(raw.path, previous) <= 0 || !packets.has(raw.path) || raw.dynamic !== true ||
        !Number.isSafeInteger(raw.size) || raw.size < 0 || raw.size > views.BODY_BYTES_LIMIT || typeof raw.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(raw.sha256) || !Array.isArray(raw.chunks)) refuse();
    previous = raw.path;
    const baseline = context.baseline.members.filter(member => member.path === raw.path);
    const original = provider.files.filter((file: any) => file?.name === packets.get(raw.path));
    if (baseline.length !== 1 || baseline[0].source !== "aggregate" || !baseline[0].dynamic ||
        baseline[0].mime !== raw.mime || original.length !== 1) refuse();
    const file = original[0];
    exact(file, ["name", "key", "digest", "bytes", "contentType", "chunkFiles"]);
    if (file.digest !== raw.sha256 || file.bytes !== raw.size || typeof file.contentType !== "string" ||
        file.contentType.split(";", 1)[0].trim().toLowerCase() !== String(raw.mime).split(";", 1)[0] ||
        !Array.isArray(file.chunkFiles) || file.chunkFiles.length !== Math.max(1, Math.ceil(raw.size / CHUNK_BYTES)) || raw.chunks.length !== file.chunkFiles.length) refuse();
    const chunks = raw.chunks.map((chunk: unknown, index: number) => {
      exact(chunk, ["name", "digest"]);
      if (chunk.name !== file.chunkFiles[index] || named.get(chunk.name)?.digest !== chunk.digest) refuse();
      return Object.freeze({ name: String(chunk.name), digest: String(chunk.digest) });
    });
    return Object.freeze({ path: raw.path, dynamic: true as const, mime: String(raw.mime), size: raw.size, sha256: raw.sha256, chunks: Object.freeze(chunks) });
  });
  const dependencies = new Set<string>(), pending = [...named.get("source-dependencies.json")!.dependencies];
  while (pending.length) {
    const name = pending.pop()!;
    if (dependencies.has(name)) continue;
    dependencies.add(name); pending.push(...(named.get(name)?.dependencies ?? []));
  }
  const required = ["source-census.json", "code-source.json", "code-pack.json", "code-pack-baseline.json", "provider-inputs.json",
    ...outputs.flatMap(output => output.chunks.map(chunk => chunk.name))];
  if (required.some(name => !dependencies.has(name))) refuse();
  return Object.freeze({ schemaVersion: 1, kind: "pair-frozen-output", pairDigest: protocol.publicReleaseDigest(pair),
    codeAssetManifestDigest: pair.codeAssetManifestDigest, cursor, outputs: Object.freeze(outputs) });
}
