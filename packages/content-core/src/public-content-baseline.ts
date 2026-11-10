import { assertPublicationTarget, type PublicationTarget } from "../../../functions/lib/publication-target";
export type PublicPublicationReceipt = { schemaVersion: 1; digestAlgorithm: "sha256"; buildBatchId: string;
  generation: number; commitSha: string; artifactDigest: string; artifactReceiptDigest: string; mediaManifestDigest: string };

export const BASELINE_MANIFEST_BYTES = 2 * 1024 * 1024;
export const BASELINE_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 10_000;
const DIGEST = /^[a-f0-9]{64}$/;
const PUBLICATION_FIELDS = ["schemaVersion", "digestAlgorithm", "buildBatchId", "generation", "commitSha",
  "artifactDigest", "artifactReceiptDigest", "mediaManifestDigest"];
export type BaselineFile = { path: string; bytes: number; digest: string };
export type ContentBaseline = { schemaVersion: 1; publication: PublicPublicationReceipt; files: BaselineFile[] };
export class ContentBaselineError extends Error {
  constructor(message = "The retained content baseline is invalid") { super(message); this.name = "ContentBaselineError"; }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function fields(value: unknown, names: string[]): value is Record<string, unknown> {
  return object(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
}
function invalid(): never { throw new ContentBaselineError(); }
export function baselinePublication(value: unknown): PublicPublicationReceipt {
  if (!fields(value, PUBLICATION_FIELDS) || value.schemaVersion !== 1 || value.digestAlgorithm !== "sha256" ||
      typeof value.buildBatchId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.buildBatchId) ||
      [".", ".."].includes(value.buildBatchId) || /^__.*__$/.test(value.buildBatchId) ||
      !Number.isSafeInteger(value.generation) || Number(value.generation) < 1 ||
      typeof value.commitSha !== "string" || !/^[a-f0-9]{40}$/.test(value.commitSha) ||
      [value.artifactDigest, value.artifactReceiptDigest, value.mediaManifestDigest].some(digest => typeof digest !== "string" || !DIGEST.test(digest))) invalid();
  return { schemaVersion: 1, digestAlgorithm: "sha256", buildBatchId: value.buildBatchId,
    generation: Number(value.generation), commitSha: value.commitSha, artifactDigest: String(value.artifactDigest),
    artifactReceiptDigest: String(value.artifactReceiptDigest), mediaManifestDigest: String(value.mediaManifestDigest) };
}
export async function baselineDigest(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    byte => byte.toString(16).padStart(2, "0")).join("");
}
export function baselineManifestKey(target: PublicationTarget, identity: PublicPublicationReceipt): string {
  const { workerName } = assertPublicationTarget(target), value = baselinePublication(identity);
  return `public-content-baseline/v1/${workerName}/${value.commitSha}/${value.generation}/${value.artifactDigest}/${value.artifactReceiptDigest}/manifest.json`;
}
export function baselineObjectKey(target: PublicationTarget, digest: string): string {
  const { workerName } = assertPublicationTarget(target);
  if (!DIGEST.test(digest)) invalid();
  return `public-content-baseline/v1/${workerName}/objects/${digest}`;
}

/** The existing artifact digest binds the complete file table, including its
 * order. A retained manifest cannot add, remove or relabel a public file. */
export async function validateContentBaseline(value: unknown, expected: PublicPublicationReceipt): Promise<ContentBaseline> {
  expected = baselinePublication(expected);
  if (!fields(value, ["schemaVersion", "publication", "files"]) || value.schemaVersion !== 1 ||
      !Array.isArray(value.files) || !value.files.length || value.files.length > MAX_FILES) invalid();
  const identity = baselinePublication(value.publication);
  if (PUBLICATION_FIELDS.some(key => identity[key as keyof PublicPublicationReceipt] !== expected[key as keyof PublicPublicationReceipt])) invalid();
  const paths = new Set<string>();
  const files = value.files.map(raw => {
    if (!fields(raw, ["path", "bytes", "digest"]) || typeof raw.path !== "string" || raw.path.length > 2048 ||
        /[\\\u0000-\u001f\u007f]/.test(raw.path) || raw.path.split("/").some(part => !part || part.startsWith(".")) ||
        raw.path === "_publication.json" || paths.has(raw.path) || !Number.isSafeInteger(raw.bytes) ||
        Number(raw.bytes) < 0 || Number(raw.bytes) > BASELINE_FILE_BYTES || typeof raw.digest !== "string" || !DIGEST.test(raw.digest)) invalid();
    paths.add(raw.path);
    return { path: raw.path, bytes: Number(raw.bytes), digest: raw.digest };
  });
  const table = new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, digestAlgorithm: "sha256", files }));
  if (await baselineDigest(table) !== identity.artifactDigest) invalid();
  const result = { schemaVersion: 1 as const, publication: identity, files };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > BASELINE_MANIFEST_BYTES) invalid();
  return result;
}
