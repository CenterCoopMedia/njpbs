import { cloudflareAccount } from "./cloudflare-account.mjs";
import path from "node:path";
import { createRequire } from "node:module";
import type { Firestore } from "firebase-admin/firestore";
import { startCandidateReceipt, verifyCandidateReceipt } from "../../scripts/lib/cms-component-receipt.mjs";
import { verifyVersionedCmsReaders } from "../../.github/scripts/cms-deploy-compatibility.mjs";

const api = createRequire(import.meta.url)("../../functions/lib/cms-preview-pair.js");
export type PreviewPairIdentity = {
  schemaVersion: 2; pairId: string; rendererSha: string; serializerId: string; workerName: string;
  applicationName: string; workerVersion: string; imageDigest: string;
  requirements: Record<string, number>; capabilities: Record<string, number>;
};
type Candidate = {
  sourceSha: string; trustedWorkflowSha: string; runId: string; runAttempt: number;
  inputFingerprint: string; configurationFingerprint: string;
};
type AttemptContext = { operationId: string; attemptDigest: string; signal?: AbortSignal };
export type PreviewPairDeploymentAdapter = {
  deployPrivate(pair: PreviewPairIdentity, context: AttemptContext): Promise<void>;
  readback(pair: PreviewPairIdentity, context: AttemptContext): Promise<Record<string, string>>;
  readLiveState(): Promise<unknown>;
  replayDeployedReader(input: unknown): Promise<{ digest: string; readerDigest: string; stateDigest: string }>;
  provePrivate(pair: PreviewPairIdentity, context: AttemptContext): Promise<{
    pairDigest: string; savedInputsDigest: string; readerDigests: Record<"functions" | "cmsApi", string>;
    replays: Record<"functionsOld" | "functionsNew" | "cmsApiOld" | "cmsApiNew", string>;
  }>;
};
async function assertPrivateRolloutTarget(firestore: Firestore, transaction: FirebaseFirestore.Transaction,
  pair: PreviewPairIdentity, expectedSelectorDigest: string) {
  const row = await transaction.get(firestore.doc(api.SELECTOR_PATH)), selector = api.parseSelector(row.data());
  if (api.digest(selector) !== expectedSelectorDigest || selector.selectedPairId === pair.pairId) throw new Error("Preview selector changed before private rollout");
  const closure = await transaction.get(firestore.doc(`cmsPreviewPairReaderWindows/${pair.pairId}`));
  if (closure.exists) throw new Error("Closed preview incarnation cannot be deployed again");
  if (selector.recoveryPairId !== pair.pairId) {
    const retirement = createRequire(import.meta.url)("../../functions/lib/cms-preview-pair-retirement.js");
    await retirement.prepareRecoveryReplacementInTransaction({ firestore, transaction, selector, candidatePair: pair, now: row.readTime.toMillis() });
  }
}

/** Offline configuration only. The immutable image is prepared separately. */
export function previewPairConfiguration(pair: PreviewPairIdentity, { main, image }: { main: string; image: string }) {
  api.parsePair(pair);
  if (!path.isAbsolute(main) || !/^registry\.cloudflare\.com\/[A-Za-z0-9_./-]+@sha256:[a-f0-9]{64}$/.test(image)
    || !image.endsWith(`@${pair.imageDigest}`)) throw new Error("An immutable private preview image is required");
  const account = cloudflareAccount();
  return { name: pair.workerName, main, account_id: account, compatibility_date: "2026-09-09",
    compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"], workers_dev: false, preview_urls: false,
    secrets: { required: ["FIREBASE_SERVICE_ACCOUNT", "R2_PREVIEW_CREDENTIAL"] },
    // Container integration must forward this binding into its environment.
    vars: { CLOUDFLARE_ACCOUNT_ID: account, PREVIEW_RENDERER_ENABLED: "false", PREVIEW_RENDERER_SHA: pair.rendererSha, PREVIEW_SERIALIZER_ID: pair.serializerId },
    version_metadata: { binding: "PREVIEW_WORKER_VERSION" }, triggers: { crons: ["* * * * *"] },
    containers: [{ name: pair.applicationName, class_name: "PreviewRenderer", image, instance_type: "standard-2", max_instances: 1 }],
    durable_objects: { bindings: [{ name: "RENDERER", class_name: "PreviewRenderer" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["PreviewRenderer"] }],
    observability: { enabled: true, head_sampling_rate: 1 } };
}

/** Inert operator boundary: no default adapter, credentials, shared pause or
 * legacy-container stop. An uncertain provider attempt permits readback only. */
export async function deployPreviewPairRuntime({ firestore, pair, operationId, expectedSelectorDigest, candidate, adapter, signal, qualificationRequestDigest }: {
  firestore: Firestore; pair: PreviewPairIdentity; operationId: string; expectedSelectorDigest: string;
  candidate: Candidate; adapter: PreviewPairDeploymentAdapter; signal?: AbortSignal; qualificationRequestDigest?: string;
}) {
  api.parsePair(pair);
  if (!/^preview-[a-z0-9][a-z0-9-]{0,31}$/.test(operationId) || candidate.sourceSha !== pair.rendererSha
    || !/^[a-f0-9]{40}$/.test(candidate.trustedWorkflowSha) || !/^[0-9]{1,20}$/.test(candidate.runId)
    || !Number.isSafeInteger(candidate.runAttempt) || candidate.runAttempt < 1 || candidate.runAttempt > 1000
    || !/^[a-f0-9]{64}$/.test(candidate.inputFingerprint) || !/^[a-f0-9]{64}$/.test(candidate.configurationFingerprint)
    || !/^[a-f0-9]{64}$/.test(expectedSelectorDigest)
    || qualificationRequestDigest !== undefined && !/^[a-f0-9]{64}$/.test(qualificationRequestDigest)) throw new Error("Invalid preview pair deployment attempt");
  signal?.throwIfAborted();
  const attemptRef = firestore.collection("cmsPreviewPairRollouts").doc(operationId);
  const identity = { pairDigest: api.digest(pair), expectedSelectorDigest, candidate,
    ...(qualificationRequestDigest === undefined ? {} : { qualificationRequestDigest }) };
  const retained = (await attemptRef.get()).data();
  const result = (proofDigest: string) => ({ operationId, newPairId: pair.pairId, expectedSelectorDigest, proofDigest });
  if (retained) {
    if (api.digest(retained.identity) !== api.digest(identity)) throw new Error("Preview rollout attempt conflicts");
    if (retained.state === "verified") return result(retained.proofDigest);
  }
  await verifyVersionedCmsReaders({ cmsSourceSha: candidate.sourceSha, readLiveState: () => adapter.readLiveState(),
    replayDeployedReader: input => adapter.replayDeployedReader(input) });
  signal?.throwIfAborted();
  await api.registerPair(firestore, pair);
  await startCandidateReceipt(firestore, { ...candidate, component: "renderer" });
  const start = await firestore.runTransaction(async tx => {
    const row = await tx.get(attemptRef);
    if (row.exists) {
      if (api.digest(row.data()?.identity) !== api.digest(identity)) throw new Error("Preview rollout attempt conflicts");
      return false;
    }
    await assertPrivateRolloutTarget(firestore, tx, pair, expectedSelectorDigest);
    signal?.throwIfAborted();
    tx.create(attemptRef, { schemaVersion: 2, identity, state: "reserved" });
    return true;
  });
  const context = { operationId, attemptDigest: api.digest(identity), signal };
  let stage = "private_deployment";
  try {
    // Permission is durable before the provider call. A lost response cannot
    // grant another write; a retry verifies the original attempt's readback.
    signal?.throwIfAborted();
    if (start) await adapter.deployPrivate(pair, context);
    signal?.throwIfAborted();
    stage = "candidate_readback";
    const component = { ...candidate, component: "renderer" };
    const retained = await startCandidateReceipt(firestore, component);
    let verified = retained;
    if (retained.state === "verified") {
      if (api.digest(retained.mutation.providerIdentities) !== api.digest(await adapter.readback(pair, context))) {
        throw new Error("Private preview candidate readback changed");
      }
    } else {
      verified = await verifyCandidateReceipt(firestore, component, { collect: () => adapter.readback(pair, context) });
    }
    stage = "private_replay";
    const privateProof = await adapter.provePrivate(pair, context);
    if (privateProof.pairDigest !== api.digest(pair)) throw new Error("Private preview proof has another pair");
    signal?.throwIfAborted();
    stage = "selection_and_reader_check";
    const [selectorRow, functionsRow, apiRow] = await firestore.getAll(firestore.doc(api.SELECTOR_PATH),
      firestore.collection(api.READER_RECEIPTS).doc("functions"), firestore.collection(api.READER_RECEIPTS).doc("cmsApi"));
    const selected = api.parseSelector(selectorRow.data());
    if (api.digest(selected) !== expectedSelectorDigest) throw new Error("Preview selection changed during qualification");
    const oldPair = api.parsePair((await firestore.collection(api.PAIRS).doc(selected.selectedPairId).get()).data());
    for (const [component, row] of [["functions", functionsRow], ["cmsApi", apiRow]] as const) {
      if (privateProof.readerDigests[component] !== api.digest(api.currentReader(row.data(), component))) throw new Error("Private preview replay has another reader");
    }
    stage = "proof_record";
    const proofDigest = await api.recordProof(firestore, { schemaVersion: 2, oldPairDigest: api.digest(oldPair), newPairDigest: api.digest(pair),
      candidateReceiptId: `renderer-${candidate.runId}-${candidate.runAttempt}`, readerDigests: privateProof.readerDigests,
      providerReadbackDigest: api.digest(verified.mutation.providerIdentities), savedInputsDigest: privateProof.savedInputsDigest,
      replays: privateProof.replays, verifiedAt: new Date().toISOString() });
    stage = "attempt_commit";
    return await firestore.runTransaction(async tx => {
      const [row, selector] = await tx.getAll(attemptRef, firestore.doc(api.SELECTOR_PATH));
      const current = row.data();
      if (!current || api.digest(current.identity) !== api.digest(identity)) throw new Error("Preview attempt changed");
      if (current.state === "verified") return result(current.proofDigest);
      if (api.digest(selector.data()) !== expectedSelectorDigest) throw new Error("Preview selector changed before qualification completion");
      await assertPrivateRolloutTarget(firestore, tx, pair, expectedSelectorDigest);
      tx.set(attemptRef, { schemaVersion: 2, identity, state: "verified", proofDigest });
      return result(proofDigest);
    });
  } catch {
    throw new Error(`Private preview qualification was not confirmed (${stage}); reconcile this exact attempt without another provider write`);
  }
}
