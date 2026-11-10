import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  open,
  readdir,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  assertPublicArtifactInventoryReceipt,
  type PublicArtifactInventoryReceipt,
} from "./public-artifact-inventory.ts";
import {
  assertPreparedPublicWorkerArtifact,
  canonicalPublicationReceipt,
  PUBLIC_PUBLICATION_PATH,
  PUBLIC_PUBLICATION_RECEIPT_SCHEMA_VERSION,
  PublicWorkerArtifactError,
  type PreparedPublicWorkerArtifact,
} from "./public-publication-receipt.ts";
export {
  assertPreparedPublicWorkerArtifact,
  MAX_PUBLICATION_RECEIPT_BYTES,
  PREPARED_PUBLIC_WORKER_ARTIFACT_SCHEMA_VERSION,
  PUBLIC_PUBLICATION_PATH,
  PUBLIC_PUBLICATION_RECEIPT_SCHEMA_VERSION,
  publicPublicationReceiptMatchesPreparedArtifact,
  PublicWorkerArtifactError,
  type PreparedPublicWorkerArtifact,
  type PublicPublicationReceipt,
} from "./public-publication-receipt.ts";

const MAX_ARTIFACT_FILES = 100_000;
const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024 * 1024;

interface ArtifactFileReceipt {
  path: string;
  bytes: number;
  digest: string;
}

function invalid(message = "The prepared public Worker artifact is invalid"): never {
  throw new PublicWorkerArtifactError(message);
}

function compareText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function hashFile(filePath: string): Promise<{ bytes: number; digest: string }> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size < 0) {
      invalid("The public Worker artifact contains a non-file entry");
    }
    const digest = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      digest.update(chunk);
    }
    const after = await handle.stat();
    if (
      !after.isFile() ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    ) {
      invalid("The public Worker artifact changed while it was hashed");
    }
    return { bytes: before.size, digest: digest.digest("hex") };
  } catch (error) {
    if (error instanceof PublicWorkerArtifactError) throw error;
    throw new PublicWorkerArtifactError(
      "The public Worker artifact file could not be hashed",
    );
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function artifactFiles(
  distRoot: string,
  directory = distRoot,
): Promise<ArtifactFileReceipt[]> {
  const entries = await readdir(directory, { withFileTypes: true })
    .catch(() => invalid("The public Worker artifact directory could not be read"));
  entries.sort((left, right) => compareText(left.name, right.name));
  const files: ArtifactFileReceipt[] = [];
  for (const entry of entries) {
    if (directory === distRoot && entry.name === PUBLIC_PUBLICATION_PATH) continue;
    const target = path.join(directory, entry.name);
    const status = await lstat(target)
      .catch(() => invalid("The public Worker artifact entry could not be read"));
    if (status.isSymbolicLink()) {
      invalid("The public Worker artifact contains a symbolic link");
    }
    if (status.isDirectory()) {
      files.push(...await artifactFiles(distRoot, target));
      continue;
    }
    if (!status.isFile()) {
      invalid("The public Worker artifact contains a non-file entry");
    }
    const relativePath = path.relative(distRoot, target).split(path.sep).join("/");
    if (
      relativePath === "" ||
      relativePath.startsWith("../") ||
      path.isAbsolute(relativePath)
    ) {
      invalid("The public Worker artifact path is invalid");
    }
    files.push({ path: relativePath, ...await hashFile(target) });
    if (files.length > MAX_ARTIFACT_FILES) {
      invalid("The public Worker artifact file limit was exceeded");
    }
  }
  return files;
}

async function artifactContentSummary(distRoot: string): Promise<{
  artifactDigest: string;
  fileCount: number;
  bytes: number;
}> {
  const files = await artifactFiles(distRoot);
  const bytes = files.reduce((total, file) => total + file.bytes, 0);
  if (
    files.length < 1 ||
    files.length >= MAX_ARTIFACT_FILES ||
    !Number.isSafeInteger(bytes) ||
    bytes < 1 ||
    bytes > MAX_ARTIFACT_BYTES
  ) {
    invalid("The public Worker artifact size is invalid");
  }
  return {
    artifactDigest: sha256(JSON.stringify({
      schemaVersion: 1,
      digestAlgorithm: "sha256",
      files,
    })),
    fileCount: files.length,
    bytes,
  };
}

async function atomicWrite(outputPath: string, bytes: string): Promise<void> {
  const temporaryPath = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, bytes, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporaryPath, outputPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

export async function preparePublicWorkerArtifact({
  artifactReceipt,
  distDirectory,
  outputPath,
}: {
  artifactReceipt: PublicArtifactInventoryReceipt;
  distDirectory: string;
  outputPath: string;
}): Promise<PreparedPublicWorkerArtifact> {
  const canonicalArtifactReceipt = assertPublicArtifactInventoryReceipt(
    artifactReceipt,
  );
  if (!path.isAbsolute(outputPath)) {
    invalid("The prepared public Worker artifact path must be absolute");
  }
  const [distRoot, outputParent] = await Promise.all([
    realpath(distDirectory),
    realpath(path.dirname(outputPath)),
  ]).catch(() => invalid("The prepared public Worker artifact path is invalid"));
  const resolvedOutput = path.join(outputParent, path.basename(outputPath));
  const outputRelation = path.relative(distRoot, resolvedOutput);
  if (
    outputRelation === "" ||
    (!outputRelation.startsWith("..") && !path.isAbsolute(outputRelation))
  ) {
    invalid("The prepared public Worker artifact receipt must stay outside site/dist");
  }

  const content = await artifactContentSummary(distRoot);
  const artifactReceiptDigest = sha256(JSON.stringify(canonicalArtifactReceipt));
  const publication = canonicalPublicationReceipt({
    schemaVersion: PUBLIC_PUBLICATION_RECEIPT_SCHEMA_VERSION,
    digestAlgorithm: "sha256",
    buildBatchId: canonicalArtifactReceipt.buildBatchId,
    generation: canonicalArtifactReceipt.generation,
    commitSha: canonicalArtifactReceipt.commitSha,
    artifactDigest: content.artifactDigest,
    artifactReceiptDigest,
    mediaManifestDigest: canonicalArtifactReceipt.mediaManifestDigest,
  });
  const publicationBytes = `${JSON.stringify(publication, null, 2)}\n`;
  const publicationReceiptDigest = sha256(publicationBytes);
  const publicationPath = path.join(distRoot, PUBLIC_PUBLICATION_PATH);
  await atomicWrite(publicationPath, publicationBytes);

  const prepared = assertPreparedPublicWorkerArtifact({
    ...publication,
    publicationReceiptDigest,
    artifactFileCount: content.fileCount + 1,
    artifactBytes: content.bytes + Buffer.byteLength(publicationBytes, "utf8"),
  });
  await atomicWrite(resolvedOutput, `${JSON.stringify(prepared, null, 2)}\n`);
  return prepared;
}

export async function verifyPreparedPublicWorkerArtifact({
  preparedArtifact,
  distDirectory,
}: {
  preparedArtifact: PreparedPublicWorkerArtifact;
  distDirectory: string;
}): Promise<PreparedPublicWorkerArtifact> {
  const prepared = assertPreparedPublicWorkerArtifact(preparedArtifact);
  const distRoot = await realpath(distDirectory)
    .catch(() => invalid("The public Worker artifact directory could not be read"));
  const [content, publication] = await Promise.all([
    artifactContentSummary(distRoot),
    hashFile(path.join(distRoot, PUBLIC_PUBLICATION_PATH)),
  ]);
  if (
    content.artifactDigest !== prepared.artifactDigest ||
    publication.digest !== prepared.publicationReceiptDigest ||
    content.fileCount + 1 !== prepared.artifactFileCount ||
    content.bytes + publication.bytes !== prepared.artifactBytes
  ) {
    invalid("The public Worker artifact changed after preparation");
  }
  return prepared;
}
