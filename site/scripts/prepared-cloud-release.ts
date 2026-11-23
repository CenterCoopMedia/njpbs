import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import type { Firestore } from "firebase-admin/firestore";
import type { PreviewStorageCredential } from "./cms-preview-storage-credential";
import type { createCmsPublicationCloudStorage } from "./cms-publication-cloud-storage";
import { checkpointNoBuildCloudRelease } from "./no-build-cloud-release";
import { assertCmsPublicationSourceCheckout } from "./cms-publication-runtime-guard";
import { manifestFromArtifact, restoreDetachedReleaseUploadPaths, uploadPublicWorkerCandidate } from "./upload-public-worker-candidate";
import { retainCloudPreviewPublicContext } from "./cms-preview-cloud-storage";
import { readFile } from "node:fs/promises";
import { assertPublicArtifactInventoryReceipt } from "../src/lib/public-artifact-inventory";
import { expectedPublicBuildValues, readPreparedPublicBuildSettings } from "./prepared-public-build-settings";
import type { PublicationTarget } from "../../functions/lib/publication-target";

const require = createRequire(import.meta.url);
const { readPublicReleasePreparation, checkPublicReleasePreparation } = require("../../functions/lib/public-release-preparation");
const { writeLiveBlogContractMarker } = require("../../functions/lib/live-blog-compatibility");
const { sealPreparedPublicRelease, promotePreparedPublicRelease } = require("../../functions/lib/public-release-promotion");

/** Called under the producer wrapper's checkout lock while OLD is ready.
 * Every slow transfer and byte proof finishes before this seal can be stored. */
export async function sealPreparedCloudRelease({ firestore, storage, queueId, commitSha, stateDirectory,
  cloudflareApiToken, previewStorageCredential, buildEnvironment, target }: {
  firestore: Firestore; storage: ReturnType<typeof createCmsPublicationCloudStorage>; queueId: string; commitSha: string;
  stateDirectory: string; cloudflareApiToken: string; previewStorageCredential: PreviewStorageCredential;
  buildEnvironment: Record<string, string | undefined>;
  /** Development only; shared release records treat an absent target as production. */
  target?: PublicationTarget;
}) {
  const expectedValues = expectedPublicBuildValues(commitSha, buildEnvironment);
  await assertCmsPublicationSourceCheckout(commitSha);
  await checkPublicReleasePreparation({ firestore, preparationId: queueId, commitSha, target });
  const reservation = await readPublicReleasePreparation({ firestore, preparationId: queueId, commitSha, target });
  const input = await storage.readInput(queueId);
  if (!input) throw new Error("The prepared release input is missing");
  const identity = { queueId, buildBatchId: reservation.buildBatchId, commitSha,
    inputSha256: createHash("sha256").update(input).digest("hex") };
  const directory = path.join(stateDirectory, "releases", queueId);
  if (!await storage.restoreArtifact(identity, directory)) throw new Error("The prepared release checkpoint is missing");
  await readPreparedPublicBuildSettings(directory, commitSha, expectedValues);
  const { prepared, artifactCheckpointDigest } = await checkpointNoBuildCloudRelease({ storage, identity, directory });
  const publicBuildSettings = await readPreparedPublicBuildSettings(directory, commitSha, expectedValues);
  const preparedArtifactPath = path.join(directory, "prepared-worker.json");
  const distDirectory = await restoreDetachedReleaseUploadPaths(preparedArtifactPath);
  const artifactReceiptPath = path.join(directory, "artifact-inventory.json");
  const candidate = await uploadPublicWorkerCandidate({ firestore: firestore as never, preparationId: queueId,
    artifactReceiptPath, preparedArtifactPath, distDirectory, cloudflareApiToken,
    runtime: { owner: "cloudflare", release: commitSha }, ...(target ? { target } : {}) });
  const { publicationReceiptDigest: _digest, artifactFileCount: _count, artifactBytes: _bytes, ...publication } = prepared;
  await retainCloudPreviewPublicContext({ firestore, file: path.join(directory, "public-context.json"), publication,
    ...previewStorageCredential, allowCloudRecovery: true,
    ...(target ? { bucket: target.previewBucket, deploymentEnvironment: target.environment } : {}) });
  const artifact = assertPublicArtifactInventoryReceipt(JSON.parse(await readFile(artifactReceiptPath, "utf8")));
  const mediaManifest = manifestFromArtifact(artifact, reservation);
  // This operator runs from the verified candidate checkout under its source
  // lock. Attest that source only after artifact/provider verification and
  // before the seal reads its companion; NEW has not started on this path.
  if (candidate.noBuildPost?.liveBlogVersion === 1) {
    await firestore.runTransaction(async transaction => {
      writeLiveBlogContractMarker({ firestore, transaction, rendererSha: commitSha });
    });
  }
  await sealPreparedPublicRelease({ firestore, preparationId: queueId, commitSha, inputSha256: identity.inputSha256,
    artifactCheckpointDigest, preparedArtifact: prepared, mediaManifest, publicBuildSettings, target });
  return { queueId, commitSha, generation: candidate.generation, workerVersionId: candidate.workerVersionId, status: "sealed" };
}

/** The short paused step reads only small sealed Firestore records. It never
 * restores an artifact, uploads a Worker, or retains preview context. */
export async function promotePreparedCloudRelease({ firestore, queueId, commitSha, apply = false, target }: {
  firestore: Firestore; queueId: string; commitSha: string; apply?: boolean; target?: PublicationTarget;
}) {
  await assertCmsPublicationSourceCheckout(commitSha);
  return promotePreparedPublicRelease({ firestore, preparationId: queueId, commitSha, apply, target });
}
