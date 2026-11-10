import { createHash } from "node:crypto";
import { readPageSchedulePacket, type PageScheduleInputs } from "../src/lib/page-schedule-packet";
import { validateCurrentCodeReference } from "../../functions/lib/current-public-code-source.js";
import protocol from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import { PAIR_CODE_PACK_CHUNK_BYTES, decodePublicReleasePairCodePackChunk } from "./public-release-pair-code-pack-chunks";

export type FrozenReplayFileReader = (name: string) => Promise<Uint8Array>;
type Family = "request" | "code" | "schedule" | "program-images";
export class PairReplayFrozenInputError extends work.PairExecutionError {
  constructor(code: `replay-frozen-${Family}-${"missing" | "mismatch"}`) { super(code); this.name = "PairReplayFrozenInputError"; }
}
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const same = (a: unknown, b: unknown) => protocol.publicReleaseDigest(a) === protocol.publicReleaseDigest(b);
const fail = (family: Family, reason: "missing" | "mismatch"): never => { throw new PairReplayFrozenInputError(`replay-frozen-${family}-${reason}`); };
async function json(read: FrozenReplayFileReader | undefined, name: string, family: Family) {
  if (!read) return fail(family, "missing");
  let bytes: Uint8Array;
  try { bytes = await read(name); } catch (error) { return fail(family, error instanceof work.PairExecutionError && error.code === "byte-mismatch" ? "mismatch" : "missing"); }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { return fail(family, "mismatch"); }
}
async function chunks(read: FrozenReplayFileReader | undefined, value: any, family: Family, limit: number) {
  if (!Number.isSafeInteger(value?.bytes) || value.bytes < 1 || value.bytes > limit || !/^[a-f0-9]{64}$/.test(value.digest ?? "") ||
      !Array.isArray(value.chunkFiles) || value.chunkFiles.length !== Math.ceil(value.bytes / PAIR_CODE_PACK_CHUNK_BYTES) ||
      new Set(value.chunkFiles).size !== value.chunkFiles.length || value.chunkFiles.some((name: unknown) => typeof name !== "string")) fail(family, "mismatch");
  const parts = [];
  for (let index = 0; index < value.chunkFiles.length; index++) {
    const packed = await json(read, value.chunkFiles[index], family);
    try { parts.push(decodePublicReleasePairCodePackChunk(packed, Math.min(PAIR_CODE_PACK_CHUNK_BYTES, value.bytes - index * PAIR_CODE_PACK_CHUNK_BYTES))); }
    catch { fail(family, "mismatch"); }
  }
  const bytes = Buffer.concat(parts);
  if (bytes.length !== value.bytes || hash(bytes) !== value.digest) fail(family, "mismatch");
  return bytes;
}

/** The private entry accepts the actual H bytes, never a caller's projector or
 * a newly labelled source. The supplied reader is confined to this claim's H. */
export async function assertFrozenReplayRequest(read: FrozenReplayFileReader | undefined, name: string, digest: string, request: unknown) {
  if (!read) return fail("request", "missing");
  const bytes = await read(name);
  if (hash(bytes) !== digest) fail("request", "mismatch");
  const actual = await json(async () => bytes, name, "request");
  if (!same(actual, request)) fail("request", "mismatch");
}

/** Re-run the same packet adapter used by the historical source owner over
 * retained raw JSON/PDF, original CODE DTO and provider identity. No SDK,
 * current-CODE request, storage fallback or provider transport is available. */
export async function rederiveFrozenReplaySchedule(input: Record<string, any>, originalSha: string, read?: FrozenReplayFileReader): Promise<PageScheduleInputs> {
  const provider = await json(read, "provider-inputs.json", "schedule");
  const descriptor = await json(read, "code-source.json", "code");
  const bytes = await chunks(read, { ...descriptor, digest: descriptor?.sha256 }, "code", 20 * 1024 * 1024);
  let qualified: any;
  try {
    qualified = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const reference = validateCurrentCodeReference(qualified.reference);
    // The historical source owner already validated the full CODE grammar.
    // Recheck its original receipt/publication seal without importing a live
    // reader or filesystem-backed artifact materializer into this sandbox.
    const receipt = qualified.publicContext?.receipt;
    // Legacy receipt normalization changes aggregate/Program route fields.
    // The source owner already verified the written receipt before freezing
    // this qualified DTO; recheck its stable publication identity here.
    if (!receipt ||
        (["buildBatchId", "generation", "commitSha", "mediaManifestDigest"] as const).some(key => receipt[key] !== reference.publication[key])) fail("code", "mismatch");
    if (descriptor.schemaVersion !== 1 || !same(descriptor.reference, reference) || !same(reference.publication, qualified.publication) ||
        qualified.publication.commitSha !== originalSha) fail("code", "mismatch");
  } catch { return fail("code", "mismatch"); }
  const original = input.schedule?.receipt;
  if (!original || provider?.schemaVersion !== 1 || !Array.isArray(provider.files) || provider.files.length > 103 ||
      !same(original.code, { ...qualified.publication, deploymentId: original.code?.deploymentId, contextDigest: hash(JSON.stringify(qualified.publicContext)) }) ||
      original.code?.generation !== input.sourceSeal?.codeGeneration || original.contextRevision !== input.sourceSeal?.contextRevision ||
      original.contextDigest !== input.sourceSeal?.contextDigest) fail("schedule", "mismatch");
  const storage = {
    async get(key: string) {
      const selected = provider.files.filter((file: any) => file.key === key);
      if (selected.length !== 1) fail("schedule", "missing");
      return chunks(read, selected[0], "schedule", 16 * 1024 * 1024);
    },
    async put() { return fail("schedule", "mismatch"); },
  };
  try {
    const result = await readPageSchedulePacket({ authority: { contextRevision: original.contextRevision, contextDigest: original.contextDigest,
      code: original.code, inputs: provider.externalInputs }, storage });
    // Verify the OLD read's data and raw seals before using NEW's rederivation.
    if (!same(result.schedule.data, input.schedule.data) || !same(result.schedule.receipt.source, original.source) ||
        !same(result.schedule.receipt.rawJson, original.rawJson) || !same(result.schedule.receipt.retainedPdf, original.retainedPdf)) fail("schedule", "mismatch");
    return result.schedule;
  } catch (error) {
    if (error instanceof PairReplayFrozenInputError) throw error;
    return fail("schedule", "mismatch");
  }
}
