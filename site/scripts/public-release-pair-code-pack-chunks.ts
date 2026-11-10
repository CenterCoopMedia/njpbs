/** Shared bounded codec; safe to bundle without artifact/filesystem readers. */
export class PairCodePackError extends Error {
  constructor(readonly code: "invalid-code-pack" | "incomplete-code-pack" | "code-pack-source-mismatch" | "code-pack-bytes-mismatch") {
    super(code); this.name = "PairCodePackError";
  }
}
const fail = (code: PairCodePackError["code"] = "invalid-code-pack"): never => { throw new PairCodePackError(code); };
export const PAIR_CODE_PACK_CHUNK_BYTES = 4 * 1024 * 1024;
export function publicReleasePairCodePackChunkCount(size: number) {
  if (!Number.isSafeInteger(size) || size < 0 || size > 16 * 1024 ** 2) fail();
  return Math.max(1, Math.ceil(size / PAIR_CODE_PACK_CHUNK_BYTES));
}
export function publicReleasePairCodePackChunkName(member: { sha256: string; size: number }, index: number) {
  if (!/^[a-f0-9]{64}$/.test(member.sha256) || !Number.isSafeInteger(index) || index < 0 || index >= publicReleasePairCodePackChunkCount(member.size)) fail();
  return `code-pack/objects/${member.sha256}/${String(index).padStart(4, "0")}.json`;
}
export function encodePublicReleasePairCodePackChunk(bytes: Uint8Array) {
  if (!(bytes instanceof Uint8Array) || bytes.length > PAIR_CODE_PACK_CHUNK_BYTES) fail();
  return new TextEncoder().encode(JSON.stringify({ bodyBase64: Buffer.from(bytes).toString("base64") }));
}
export function decodePublicReleasePairCodePackChunk(value: unknown, expectedBytes: number) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.keys(value).join("\n") !== "bodyBase64") fail();
  const base64 = (value as { bodyBase64: unknown }).bodyBase64;
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > PAIR_CODE_PACK_CHUNK_BYTES ||
      typeof base64 !== "string" || base64.length > Math.ceil(PAIR_CODE_PACK_CHUNK_BYTES / 3) * 4) return fail();
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length !== expectedBytes || bytes.toString("base64") !== base64) fail("code-pack-bytes-mismatch");
  return new Uint8Array(bytes);
}
