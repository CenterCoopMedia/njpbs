import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { artifactFiles, verifyPreparedPublicWorkerArtifact } from "../src/lib/public-worker-artifact";
import { assertPreparedPublicWorkerArtifact, publicationFromPrepared,
  publicPublicationReceiptMatchesPreparedArtifact, type PreparedPublicWorkerArtifact } from "../src/lib/public-publication-receipt";
import { BASELINE_FILE_BYTES, baselineManifestKey, baselineObjectKey, ContentBaselineError,
  validateContentBaseline, type ContentBaseline, type BaselineFile } from "../../packages/content-core/src/public-content-baseline";
import { assertPublicationTarget, type PublicationTarget } from "../../functions/lib/publication-target";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export type BaselineUpload = { writeAndVerify(key: string, bytes: Buffer): Promise<void> };
export type BaselinePlan = { target: PublicationTarget; distDirectory: string; baseline: ContentBaseline;
  manifestKey: string; manifestBytes: Buffer; publicationReceiptDigest: string };

/** Dry preparation checks the complete sealed artifact before storage is opened. */
export async function prepareContentBaseline({ target, distDirectory, preparedArtifact }: {
  target: PublicationTarget; distDirectory: string; preparedArtifact: PreparedPublicWorkerArtifact;
}): Promise<BaselinePlan> {
  target = assertPublicationTarget(target);
  const prepared = assertPreparedPublicWorkerArtifact(preparedArtifact);
  await verifyPreparedPublicWorkerArtifact({ preparedArtifact: prepared, distDirectory });
  const root = await realpath(distDirectory);
  const publication = await readFile(path.join(root, "_publication.json"), 8 * 1024);
  if (!publicPublicationReceiptMatchesPreparedArtifact(publication.toString("utf8"), prepared)) {
    throw new ContentBaselineError("The baseline publication differs from its sealed artifact");
  }
  const files = await artifactFiles(root);
  const baseline = await validateContentBaseline({ schemaVersion: 1, publication: publicationFromPrepared(prepared), files },
    publicationFromPrepared(prepared));
  const manifestBytes = Buffer.from(JSON.stringify(baseline));
  return { target, distDirectory: root, baseline, manifestBytes, manifestKey: baselineManifestKey(target, baseline.publication),
    publicationReceiptDigest: prepared.publicationReceiptDigest };
}

async function readFile(filePath: string, limit: number): Promise<Buffer> {
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > limit) throw new ContentBaselineError("The baseline file exceeds its bound");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > limit) throw new ContentBaselineError("The baseline file exceeds its bound");
      chunks.push(Buffer.from(chunk));
    }
    const after = await handle.stat();
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new ContentBaselineError("The baseline file changed while it was read");
    }
    return Buffer.concat(chunks, size);
  } finally { await handle.close(); }
}

/** No manifest is committed until every immutable blob has an exact readback. */
export async function seedContentBaseline(plan: BaselinePlan, storage: BaselineUpload) {
  const baseline = await validateContentBaseline(plan.baseline, plan.baseline.publication);
  const target = assertPublicationTarget(plan.target);
  const manifestBytes = Buffer.from(JSON.stringify(baseline));
  const manifestKey = baselineManifestKey(target, baseline.publication);
  if (manifestKey !== plan.manifestKey || !manifestBytes.equals(plan.manifestBytes)) throw new ContentBaselineError("The baseline plan changed");
  // The public manifest deliberately excludes _publication.json from its
  // artifact hash. Retain its independently sealed exact bytes by digest too,
  // so frozen replay never needs a mutable public receipt fetch.
  const publication = await readFile(path.join(plan.distDirectory, "_publication.json"), 8 * 1024);
  if (!/^[a-f0-9]{64}$/.test(plan.publicationReceiptDigest) || digest(publication) !== plan.publicationReceiptDigest) {
    throw new ContentBaselineError("The baseline publication changed after preparation");
  }
  for (const file of baseline.files) {
    const bytes = await readFile(path.join(plan.distDirectory, file.path), BASELINE_FILE_BYTES);
    if (bytes.byteLength !== file.bytes || digest(bytes) !== file.digest) throw new ContentBaselineError("The baseline bytes changed after preparation");
    await storage.writeAndVerify(baselineObjectKey(target, file.digest), bytes);
  }
  await storage.writeAndVerify(baselineObjectKey(target, plan.publicationReceiptDigest), publication);
  await storage.writeAndVerify(manifestKey, manifestBytes);
  return baselineSummary(plan, "seeded");
}

export function baselineSummary(plan: BaselinePlan, status = "prepared") {
  return { status, workerName: plan.target.workerName, publication: plan.baseline.publication,
    files: plan.baseline.files.length, bytes: plan.baseline.files.reduce((sum, file: BaselineFile) => sum + file.bytes, 0),
    manifestKey: plan.manifestKey, manifestDigest: digest(plan.manifestBytes) };
}
