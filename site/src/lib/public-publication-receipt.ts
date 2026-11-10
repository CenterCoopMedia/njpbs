import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export const PUBLIC_PUBLICATION_RECEIPT_SCHEMA_VERSION = 1;
export const PREPARED_PUBLIC_WORKER_ARTIFACT_SCHEMA_VERSION = 1;
export const PUBLIC_PUBLICATION_PATH = "_publication.json";
export const MAX_PUBLICATION_RECEIPT_BYTES = 8 * 1024;

const DIGEST = /^[a-f0-9]{64}$/;
const COMMIT_SHA = /^[a-f0-9]{40}$/;
const SAFE_IDENTIFIER = /^[A-Za-z0-9._:-]+$/;
const FIRESTORE_RESERVED_IDENTIFIER = /^__.*__$/;
const MAX_ARTIFACT_FILES = 100_000;
const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024 * 1024;
const PUBLICATION_FIELDS = new Set([
  "schemaVersion",
  "digestAlgorithm",
  "buildBatchId",
  "generation",
  "commitSha",
  "artifactDigest",
  "artifactReceiptDigest",
  "mediaManifestDigest",
]);
const PREPARED_FIELDS = new Set([
  ...PUBLICATION_FIELDS,
  "publicationReceiptDigest",
  "artifactFileCount",
  "artifactBytes",
]);

export interface PublicPublicationReceipt {
  schemaVersion: 1;
  digestAlgorithm: "sha256";
  buildBatchId: string;
  generation: number;
  commitSha: string;
  artifactDigest: string;
  artifactReceiptDigest: string;
  mediaManifestDigest: string;
}

export interface PreparedPublicWorkerArtifact extends PublicPublicationReceipt {
  publicationReceiptDigest: string;
  artifactFileCount: number;
  artifactBytes: number;
}

export class PublicWorkerArtifactError extends Error {
  constructor(message = "The prepared public Worker artifact is invalid") {
    super(message);
    this.name = "PublicWorkerArtifactError";
  }
}

function invalid(message = "The prepared public Worker artifact is invalid"): never {
  throw new PublicWorkerArtifactError(message);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasExactFields(
  value: unknown,
  fields: Set<string>,
): value is Record<string, unknown> {
  return plainObject(value) &&
    Object.keys(value).length === fields.size &&
    Object.keys(value).every((field) => fields.has(field));
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalPublicationReceipt(
  value: unknown,
): PublicPublicationReceipt {
  if (
    !hasExactFields(value, PUBLICATION_FIELDS) ||
    value.schemaVersion !== PUBLIC_PUBLICATION_RECEIPT_SCHEMA_VERSION ||
    value.digestAlgorithm !== "sha256" ||
    typeof value.buildBatchId !== "string" ||
    value.buildBatchId.length < 1 ||
    Buffer.byteLength(value.buildBatchId, "utf8") > 128 ||
    !SAFE_IDENTIFIER.test(value.buildBatchId) ||
    value.buildBatchId === "." ||
    value.buildBatchId === ".." ||
    FIRESTORE_RESERVED_IDENTIFIER.test(value.buildBatchId) ||
    !Number.isSafeInteger(value.generation) ||
    Number(value.generation) < 1 ||
    typeof value.commitSha !== "string" ||
    !COMMIT_SHA.test(value.commitSha) ||
    typeof value.artifactDigest !== "string" ||
    !DIGEST.test(value.artifactDigest) ||
    typeof value.artifactReceiptDigest !== "string" ||
    !DIGEST.test(value.artifactReceiptDigest) ||
    typeof value.mediaManifestDigest !== "string" ||
    !DIGEST.test(value.mediaManifestDigest)
  ) {
    invalid();
  }
  return {
    schemaVersion: PUBLIC_PUBLICATION_RECEIPT_SCHEMA_VERSION,
    digestAlgorithm: "sha256",
    buildBatchId: value.buildBatchId,
    generation: Number(value.generation),
    commitSha: value.commitSha,
    artifactDigest: value.artifactDigest,
    artifactReceiptDigest: value.artifactReceiptDigest,
    mediaManifestDigest: value.mediaManifestDigest,
  };
}

export function assertPreparedPublicWorkerArtifact(
  value: unknown,
): PreparedPublicWorkerArtifact {
  if (
    !hasExactFields(value, PREPARED_FIELDS) ||
    typeof value.publicationReceiptDigest !== "string" ||
    !DIGEST.test(value.publicationReceiptDigest) ||
    !Number.isSafeInteger(value.artifactFileCount) ||
    Number(value.artifactFileCount) < 2 ||
    Number(value.artifactFileCount) > MAX_ARTIFACT_FILES ||
    !Number.isSafeInteger(value.artifactBytes) ||
    Number(value.artifactBytes) < 1 ||
    Number(value.artifactBytes) > MAX_ARTIFACT_BYTES
  ) {
    invalid();
  }
  const publication = canonicalPublicationReceipt(
    Object.fromEntries(
      Object.entries(value).filter(([field]) => PUBLICATION_FIELDS.has(field)),
    ),
  );
  return {
    ...publication,
    publicationReceiptDigest: value.publicationReceiptDigest,
    artifactFileCount: Number(value.artifactFileCount),
    artifactBytes: Number(value.artifactBytes),
  };
}

export function publicationFromPrepared(
  prepared: PreparedPublicWorkerArtifact,
): PublicPublicationReceipt {
  return {
    schemaVersion: prepared.schemaVersion,
    digestAlgorithm: prepared.digestAlgorithm,
    buildBatchId: prepared.buildBatchId,
    generation: prepared.generation,
    commitSha: prepared.commitSha,
    artifactDigest: prepared.artifactDigest,
    artifactReceiptDigest: prepared.artifactReceiptDigest,
    mediaManifestDigest: prepared.mediaManifestDigest,
  };
}

export function publicPublicationReceiptMatchesPreparedArtifact(
  body: unknown,
  preparedArtifact: unknown,
): boolean {
  let prepared: PreparedPublicWorkerArtifact;
  try {
    prepared = assertPreparedPublicWorkerArtifact(preparedArtifact);
  } catch {
    return false;
  }
  if (
    typeof body !== "string" ||
    Buffer.byteLength(body, "utf8") > MAX_PUBLICATION_RECEIPT_BYTES ||
    sha256(body) !== prepared.publicationReceiptDigest
  ) {
    return false;
  }
  try {
    return isDeepStrictEqual(
      canonicalPublicationReceipt(JSON.parse(body)),
      publicationFromPrepared(prepared),
    );
  } catch {
    return false;
  }
}
