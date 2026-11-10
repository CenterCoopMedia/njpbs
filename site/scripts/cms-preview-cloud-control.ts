import { createRequire } from "node:module";
import type { Firestore } from "firebase-admin/firestore";
import { openCmsPreviewCloudTokenJournal } from "./cms-preview-cloud-token-journal.ts";
const { previewTimings } = createRequire(import.meta.url)("../../functions/lib/preview-timings.js");
const liveBlog = createRequire(import.meta.url)("../../functions/lib/live-blog-compatibility.js");
const pageReader = createRequire(import.meta.url)("../../functions/lib/page-reader-compatibility.js");
const { PAGE_READER_VERSION } = createRequire(import.meta.url)("../../functions/lib/page-reader-contract.js");
const pairs = createRequire(import.meta.url)("../../functions/lib/cms-preview-pair.js");

export const PREVIEW_RUNTIME_DOCUMENT = "system/cmsPreviewRuntime";
export type PreviewRuntimeControl = {
  schemaVersion: 1;
  phase: "paused" | "starting" | "ready";
  rendererSha: string;
  serializerId: string;
  dataHubCompositionVersion?: 1;
  liveBlogVersion?: 1;
  electionResultsVersion?: 1 | 2;
};

export function parsePreviewRuntimeControl(value: unknown): PreviewRuntimeControl {
  const control = value as Partial<PreviewRuntimeControl> | undefined;
  if (!control || control.schemaVersion !== 1 ||
    !["paused", "starting", "ready"].includes(control.phase ?? "") ||
    typeof control.rendererSha !== "string" || typeof control.serializerId !== "string" ||
    !/^[a-f0-9]{40}$/.test(control.rendererSha ?? "") ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(control.serializerId ?? "") ||
    (control.dataHubCompositionVersion !== undefined && control.dataHubCompositionVersion !== 1) ||
    (control.liveBlogVersion !== undefined && control.liveBlogVersion !== 1) ||
    (control.electionResultsVersion !== undefined && ![1, 2].includes(control.electionResultsVersion))) {
    throw new Error("Cloud preview release control is invalid");
  }
  return control as PreviewRuntimeControl;
}

export async function assertPreviewRuntimeIdentity(firestore: Firestore, rendererSha: string, serializerId: string) {
  const data = (await firestore.doc(PREVIEW_RUNTIME_DOCUMENT).get()).data();
  if (data?.schemaVersion === 2) return retainedPreviewIdentity(firestore, data, rendererSha, serializerId);
  const control = parsePreviewRuntimeControl(data);
  if (control.rendererSha !== rendererSha || control.serializerId !== serializerId) {
    throw new Error("Cloud preview release requires another renderer");
  }
  return control;
}

async function retainedPreviewIdentity(firestore: Firestore, value: unknown, rendererSha: string, serializerId: string,
  read = (ref: FirebaseFirestore.DocumentReference) => ref.get()) {
  const selector = pairs.parseSelector(value);
  const pair = pairs.parsePair((await read(firestore.collection(pairs.PAIRS).doc(serializerId))).data());
  if (![selector.selectedPairId, selector.recoveryPairId].includes(pair.pairId) ||
      pair.serializerId !== serializerId || pair.rendererSha !== rendererSha) throw new Error("Cloud preview requires its retained pair");
  if (pair.pairId === selector.selectedPairId) pairs.assertProjection(selector, pair);
  return { schemaVersion: 2 as const, phase: "ready" as const, rendererSha, serializerId, ...pair.capabilities,
    pairDigest: pairs.digest(pair) as string };
}

export async function previewPairDrained(firestore: Firestore, pairId: string) {
  const pair = pairs.parsePair((await firestore.collection(pairs.PAIRS).doc(pairId).get()).data());
  const queue = await firestore.collection("cmsPreviewQueue").where("serializerId", "==", pair.serializerId)
    .where("status", "in", ["pending", "building"]).limit(1).get();
  const journal = await openCmsPreviewCloudTokenJournal({ firestore, serializerId: pair.serializerId });
  return queue.empty && await journal.read() === null;
}

export async function pausePreviewRuntime(firestore: Firestore, rendererSha: string) {
  const ref = firestore.doc(PREVIEW_RUNTIME_DOCUMENT);
  await firestore.runTransaction(async transaction => {
    const snapshot = await transaction.get(ref);
    const current = snapshot.exists ? parsePreviewRuntimeControl(snapshot.data()) : {
      schemaVersion: 1, rendererSha, serializerId: "cloudflare-preview",
    };
    // Keep admitted work attached to its old renderer while closing admission.
    transaction.set(ref, { ...current, phase: "paused" });
  });
}

export async function previewRuntimeDrained(firestore: Firestore) {
  const queue = await firestore.collection("cmsPreviewQueue")
    .where("transport", "==", "serializer").where("status", "in", ["pending", "building"]).limit(1).get();
  const journal = await openCmsPreviewCloudTokenJournal({ firestore, serializerId: "cloudflare-preview" });
  return queue.empty && await journal.read() === null;
}

/** A startup cannot reopen admission after a release operator has paused it. */
export async function confirmPreviewRuntimeReady(firestore: Firestore, rendererSha: string, serializerId: string, timingsMs?: Record<string, number>) {
  const ref = firestore.doc(PREVIEW_RUNTIME_DOCUMENT);
  return firestore.runTransaction(async transaction => {
    const data = (await transaction.get(ref)).data();
    const writePageReader = await pageReader.preparePageReaderMarker({ firestore, transaction,
      role: "preview", rendererSha, version: PAGE_READER_VERSION });
    if (data?.schemaVersion === 2) {
      const identity = await retainedPreviewIdentity(firestore, data, rendererSha, serializerId, target => transaction.get(target));
      // Each retained runtime attests only itself. Startup never rewrites the
      // selection, its ready projections or another pair's readiness.
      writePageReader();
      liveBlog.writeLiveBlogContractMarker({ firestore, transaction, rendererSha });
      transaction.set(firestore.collection("cmsPreviewPairReadiness").doc(serializerId), {
        ...identity, checkedAt: new Date().toISOString(), startupTimingsMs: previewTimings(timingsMs),
      });
      return;
    }
    const control = parsePreviewRuntimeControl(data);
    if (control.rendererSha !== rendererSha || control.serializerId !== serializerId) {
      throw new Error("Cloud preview release changed during startup");
    }
    if (control.phase === "paused") return;
    writePageReader();
    liveBlog.writeLiveBlogContractMarker({ firestore, transaction, rendererSha });
    // This function is bundled into the sealed current renderer runtime.
    // Startup verifies that bundle and renderer before it can attest readiness.
    transaction.set(ref, { ...control, phase: "ready", dataHubCompositionVersion: 1, liveBlogVersion: 1, electionResultsVersion: 2, checkedAt: new Date().toISOString(),
      startupTimingsMs: previewTimings(timingsMs) });
  });
}

/** Proof gate only. Retiring/reusing a provider application is a separate,
 * explicitly authorized operation. It cannot touch either retained selector.
 * Reader windows must first be closed by the versioned gateway; leases never
 * extend on refresh. Existing artifact storage retains its own expiry policy.
 */
export async function assertPreviewPairRetirement(firestore: Firestore, pairId: string,
  readerDigests: readonly string[], now = Date.now()) {
  const sessions = createRequire(import.meta.url)("../../functions/lib/cms-reader-session.js");
  const selector = pairs.parseSelector((await firestore.doc(PREVIEW_RUNTIME_DOCUMENT).get()).data());
  if ([selector.selectedPairId, selector.recoveryPairId].includes(pairId)) throw new Error("Preview pair is still retained by selection");
  if (!Array.isArray(readerDigests) || readerDigests.length !== 2 || new Set(readerDigests).size !== 2) {
    throw new Error("Both deployed reader expiry proofs are required");
  }
  const rows = await firestore.getAll(...["functions", "cmsApi"].map(component =>
    firestore.collection(pairs.READER_RECEIPTS).doc(component)));
  const required = rows.map((row, i) => sessions.readerSessionDigest(pairs.currentReader(row.data(), ["functions", "cmsApi"][i])) as string);
  if (required.some(digest => !readerDigests.includes(digest))) {
    throw new Error("Retirement requires both current deployed reader expiry proofs");
  }
  if (!await previewPairDrained(firestore, pairId)) throw new Error("Preview pair has outstanding work or journal");
  const expired: { readerDigest: string; maxExpiresAt: number }[] = await sessions.assertPairReaderWindowsExpired(firestore, pairId, now);
  return { pairId, selectorDigest: pairs.digest(selector) as string, readerDigests: expired.map(value => value.readerDigest), currentReaderDigests: required, expired };
}
