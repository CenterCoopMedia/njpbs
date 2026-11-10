// The runtime composes this maintenance pass independently of the serializer. Frozen generation
// happens before the bounded family owner reads and verifies immutable bytes.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { restoreCloudExternalInputs } from "./cloud-external-refresh";
import { freezeRetainedPublicImages } from "./retained-public-images";
import type { App } from "firebase-admin/app";
import type { Firestore, Transaction } from "firebase-admin/firestore";
import { firebaseAdminRuntime } from "./firebase-admin-runtime";
import { buildFrozenPublication, freezeBackgroundPublicationInputs, type MediaManagerCredential } from "./frozen-publication";
import { projectPublicArtifactContent, readPublicArtifactContentFromDatabase } from "../src/lib/cms-loader";

import { writePublicArtifactBundle } from "../src/lib/public-artifact-bundle";
import { backgroundInputFiles, backgroundOutputFiles, createNoBuildPreparationStorage, PreparationIntegrityError } from "./no-build-preparation-storage";
import { backgroundPreparationDiagnostic } from "./background-preparation-diagnostic";
import { buildNoBuildCloudPreviewProjection } from "./build-no-build-cloud-background";
import { familyFiles, backgroundFamilies as families, type FileRecord } from "./post-background-files";
export { familyFiles } from "./post-background-files";

const require = createRequire(import.meta.url);
const { readNoBuildFamilyAdmission } = require("../../functions/lib/no-build-family-admission");
const { ownsPublication, samePublicationOwner, runtimeFields, assertRuntimeSource } = require("../../functions/lib/publication-runtime-owner");
const { listNoBuildPostOwners, readNoBuildPostOwner, readNoBuildPostCapability,
  effectiveNoBuildPostState } = require("../../functions/lib/no-build-post-ownership");
const { retryDue, cloudBillingPaused } = require("../../functions/lib/no-build-cloud-work");
const { slowBackgroundRetryDue, expiredBackgroundClaim } = require("../../functions/lib/background-output-attempt");
const { assertCmsPublicationCloudAdmission, CmsPublicationRuntimeControlError } = require("../../functions/lib/cms-publication-runtime-control");
const { FieldValue } = firebaseAdminRuntime;
const { OUTPUTS: legacyFamilies, createPostBackgroundOutputs, backgroundOutputForPath: outputForPath, dependency, isBackgroundAssetPath } = require("../../functions/lib/post-background-outputs");
const { readPublicContextInTransaction, readPublicBackgroundContextInTransaction } = require("../../functions/lib/public-context-revision") as {
  readPublicContextInTransaction(transaction: unknown, firestore: Firestore): Promise<string>;
  readPublicBackgroundContextInTransaction(transaction: unknown, firestore: Firestore): Promise<unknown> };
const { createPostBackgroundStorage } = require("../../functions/lib/post-background-storage");
const { verifiedPreviewProjection } = require("../../functions/lib/editorial-preview-projection");
const { enqueuePostWithdrawalBuild, warnFirstHomeFailure } = require("../../functions/lib/transitional-post-withdrawal");
const { contextOutputs, outputLimits, CHECKPOINT_FILES_MAX, CHECKPOINT_MANIFEST_BYTES_MAX } = require("../../functions/lib/no-build-record-namespace");
const { enqueuePublicContextInTransaction, settlePublicContext, failPublicContextPreparation, verifiedPreparation, frozenContextMatches, canSupersedeFrozenContext,
  readSelectedPublicContextInTransaction, publicContextFollowUpQueuesInTransaction, CURRENT_PATH } = require("../../functions/lib/public-context-publication");
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
interface PreparedBackground { schemaVersion: 2; contextDigest: string;
  routes: { path: string; sourceVersion: number; digest: string }[]; files: FileRecord[] }
interface PostOwnerState { postId: string; operationId: string; mode?: "dynamic" | "static";
  rendererSha: string; generation: number; visible: boolean }
interface BackgroundJob { state?: PostOwnerState; queueId: string; contextOnly?: boolean }
interface BackgroundContextSelection { operationId: string; contextDigest: string; preparationOperationId?: string }
interface BackgroundAdmission { valid: boolean; enabled: boolean; backgroundBucket: string; admissionRevision: number | null }
function backgroundContextSelection(value: unknown, preparationId: unknown): BackgroundContextSelection {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !("operationId" in value) || typeof value.operationId !== "string" || !/^[A-Za-z0-9]{20}$/.test(value.operationId) ||
      !("contextDigest" in value) || typeof value.contextDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.contextDigest)) {
    throw new Error("Aggregate context selection refused");
  }
  const preparationOperationId = preparationId ?? value.operationId;
  if (typeof preparationOperationId !== "string" || !/^[A-Za-z0-9]{20}$/.test(preparationOperationId)) {
    throw new Error("Aggregate preparation selection refused");
  }
  return { operationId: value.operationId, contextDigest: value.contextDigest, preparationOperationId };
}
export function parsePreparedBackground(bytes: Buffer, contextDigest: string): PreparedBackground {
  if (bytes.length > CHECKPOINT_MANIFEST_BYTES_MAX) throw new PreparationIntegrityError("Retained background receipt exceeds its bound");
  const prepared: PreparedBackground = JSON.parse(bytes.toString("utf8"));
  if (prepared.schemaVersion !== 2 || prepared.contextDigest !== contextDigest ||
      !Array.isArray(prepared.routes) || !Array.isArray(prepared.files) || prepared.files.length > CHECKPOINT_FILES_MAX - 8 ||
      prepared.files.some(file => typeof file.file !== "string" || file.file.startsWith("/") ||
        file.file.includes("\\") || file.file.split("/").some(part => !part || part === "." || part === "..") ||
        (!outputForPath(file.path) && !isBackgroundAssetPath(file.path)) ||
        !Array.isArray(file.outputs) || !file.outputs.length || file.outputs.some(output => !families.includes(output)) || !/^[a-f0-9]{64}$/.test(file.digest) ||
        !Number.isSafeInteger(file.size) || file.size < 0 || file.size > 16 * 1024 * 1024)) {
    throw new PreparationIntegrityError("Invalid retained background generation");
  }
  return prepared;
}

async function retainFiles(dist: string, directory: string, prepared: PreparedBackground): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const file of prepared.files) {
    const bytes = await readFile(path.join(dist, file.file));
    if (bytes.length !== file.size || sha256(bytes) !== file.digest) throw new Error("Background generation changed");
    const destination = path.join(directory, "files", file.file);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, bytes, { mode: 0o600 });
  }
  const temporary = path.join(directory, `receipt-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(prepared), { mode: 0o600 });
  await rename(temporary, path.join(directory, "receipt.json"));
}

export function noBuildPostMaintenance({ firestore, firebaseApp, commitSha, stateDirectory, distDirectory, buildEnvironment,
  mediaManagerCredential, backgroundBucket, serializerId, buildPublication = buildFrozenPublication,
  buildPreviewProjection = buildNoBuildCloudPreviewProjection, onPreviewProjection, runtime = { owner: "node-compute", release: commitSha } }: { runtime?: { owner: "node-compute" | "cloudflare"; release: string }; firestore: Firestore; firebaseApp?: App; commitSha: string; stateDirectory: string; distDirectory: string;
    buildPreviewProjection?: typeof buildNoBuildCloudPreviewProjection; onPreviewProjection?: () => void;
    backgroundBucket?: string; serializerId?: string; buildEnvironment: Record<string, string | undefined>; mediaManagerCredential?: MediaManagerCredential; buildPublication?: typeof buildFrozenPublication }) {
  assertRuntimeSource(runtime, commitSha);
  const paused = (transaction?: Transaction) => cloudBillingPaused({ runtime,
    read: async (document: string) => (await (transaction ? transaction.get(firestore.doc(document)) : firestore.doc(document).get())).data() ?? null });
  const eligibleState = (state: PostOwnerState | null, capability: unknown) => {
    const effective = effectiveNoBuildPostState(state, capability);
    return state?.operationId && state.mode !== "static" && samePublicationOwner(state, runtime) &&
      effective.rendererSha === commitSha && (effective.servingEnabled || state.visible === false);
  };
  async function currentState(transaction: Transaction, expected: PostOwnerState) {
    const [{ state }, capability] = await Promise.all([
      readNoBuildPostOwner({ firestore, transaction, postId: expected.postId }),
      readNoBuildPostCapability({ firestore, transaction }),
    ]);
    if (!state || state.operationId !== expected.operationId || !samePublicationOwner(state, runtime) ||
        effectiveNoBuildPostState(state, capability).rendererSha !== commitSha) return null;
    return effectiveNoBuildPostState(state, capability);
  }
  // Queue failure is independent of frozen-generation preparation. Its
  // durable error can retry without discarding an already verified checkpoint.
  async function attemptHomeFallback(queueId: string, preparationFailed = false) {
    try { await warnFirstHomeFailure({ firestore, operationId: queueId, preparationFailed }); }
    catch { console.error("First Home withdrawal warning receipt failed"); }
  }
  async function prepareJob({ state, queueId, contextOnly = false }: BackgroundJob, contextDigest: string, admission: BackgroundAdmission) {
    const queueRef = firestore.doc(`cmsPublishQueue/${queueId}`);
    const preparation = firestore.doc(`cmsPublishQueue/${queueId}/backgroundPreparation/${contextDigest}`);
    const [admissionFailure, priorPreparation] = await Promise.all([
      queueRef.collection("backgroundOutputs").doc("_admission").get(), preparation.get(),
    ]);
    if (!contextOnly) await attemptHomeFallback(queueId, admissionFailure.data()?.status === "failed" || priorPreparation.data()?.status === "failed");
    const claim = randomUUID();
    const buildBatchId = `post-background-${queueId}-${contextDigest}`;
    const acquired = await firestore.runTransaction(async transaction => {
      if (await paused(transaction)) return false;
      const before = (await transaction.get(preparation)).data();
      const admitted = (await transaction.get(queueRef)).data();
      if (!admitted || !samePublicationOwner({ runtime: admitted.backgroundRuntime }, runtime)) return false;
      const liveState = state ? await currentState(transaction, state) : null;
      if ((!contextOnly && !liveState) || (before && !ownsPublication(before, runtime))) return false;
      const pointer = (await transaction.get(firestore.doc("system/publicDeployment"))).data();
      const currentAdmission = contextOnly ? admission : await readNoBuildFamilyAdmission({ firestore, transaction, env: buildEnvironment });
      const outputs = await transaction.getAll(...families.map(output => firestore.doc(`cmsBackgroundOutputs/${output}`)));
      const liveTask = outputs.some(row => {
        const output = row.data();
        return (contextOnly ? output?.contextOnly === true : output?.postId === state?.postId) && output?.taskPath?.split("/")[1] === queueId && samePublicationOwner(output, runtime);
      });
      let privateRecovery = false;
      if (contextOnly && admitted.preparationRecoveryOfQueueId) {
        const selected = (await transaction.get(firestore.doc(CURRENT_PATH))).data();
        const ownTasks = await transaction.getAll(...(contextOutputs(admitted.publicContext) as string[])
          .map(output => queueRef.collection("backgroundOutputs").doc(output)));
        privateRecovery = selected?.operationId === queueId && selected.preparationOperationId === queueId &&
          selected.contextDigest === contextDigest && ownsPublication(selected, runtime) &&
          outputs.filter(row => (contextOutputs(admitted.publicContext) as string[]).includes(row.id)).every(row => {
            const value = row.data();
            return value?.status === "verified" && ownsPublication(value, runtime) && value.contextDigest === contextDigest &&
              value.receipt?.revision === value.revision && value.receipt?.contextDigest === contextDigest && value.receipt?.rendererSha === commitSha;
          }) && ownTasks.every(row => row.data()?.contextOnly === true && ownsPublication(row.data(), runtime) &&
            row.data()?.contextDigest === contextDigest);
      }
      const contextIdentity = admitted.publicContext;
      if (contextOnly && (admitted.transport !== "public-context-no-build-v1" || admitted.status !== "pending" ||
          contextIdentity?.contextDigest !== contextDigest || !ownsPublication(admitted, runtime))) return false;
      const selectedDigest = contextOnly && before?.frozenContext
        ? (await readSelectedPublicContextInTransaction({ transaction, firestore, operationId: queueId, runtime })).digest
        : await readPublicContextInTransaction(transaction, firestore);
      if ((!liveTask && !privateRecovery) || !currentAdmission.valid || (!contextOnly && !eligibleState(liveState, null)) ||
          currentAdmission.backgroundBucket !== admission.backgroundBucket ||
          pointer?.state !== "idle" || pointer.activeCommitSha !== commitSha ||
          selectedDigest !== contextDigest) return false;
      if (before?.status === "verified") return false;
      if (before?.attempts >= 4 || before?.nextAttemptAt > Date.now()) return false;
      const publicContext = contextOnly ? (await transaction.get(firestore.doc("system/publicDeployment/contexts/public"))).data() : null;
      transaction.set(preparation, { ...before, ...runtimeFields(runtime), schemaVersion: 1, contextDigest, claim, status: "building",
        ...(publicContext ? { frozenContext: before?.frozenContext ?? { revision: publicContext.revision,
          withdrawalRevision: publicContext.withdrawalRevision ?? 0, homeRevision: publicContext.homeRevision ?? 0 } } : {}),
        ...(contextOnly && admitted.publicContext?.recordFamilies?.length ? { recordFamilies: admitted.publicContext.recordFamilies } : {}),
        admissionRevision: before?.admissionRevision ?? admission.admissionRevision, backgroundBucket: before?.backgroundBucket ?? admission.backgroundBucket,
        attempts: (before?.attempts ?? 0) + 1, nextAttemptAt: Date.now() + 10 * 60_000,
        reservation: before?.reservation ?? { schemaVersion: 1, buildBatchId, generation: Math.max(liveState?.generation ?? pointer.activeGeneration, pointer.activeGeneration) + 1, commitSha, status: "reserved",
          reservedAgainstGeneration: pointer.activeGeneration, reservedAgainstDeploymentId: pointer.activeDeploymentId,
          reservedAgainstCommitSha: pointer.activeCommitSha, cutoffAt: FieldValue.serverTimestamp(), reservedAt: FieldValue.serverTimestamp() } });
      return true;
    });
    const retained = path.join(stateDirectory, "jobs", queueId, `background-${contextDigest}`);
    let prepared: PreparedBackground;
    let retainedValid = false;
    let stage = "restore_prepared";
    let stageStartedAt = Date.now();
    const timings: Record<string, number> = {};
    async function advanceStage(next: string) {
      const time = Date.now();
      timings[stage] = (timings[stage] ?? 0) + Math.max(0, time - stageStartedAt);
      stage = next;
      stageStartedAt = time;
      if (acquired) await firestore.runTransaction(async transaction => {
        const current = (await transaction.get(preparation)).data();
        if (!current || !ownsPublication(current, runtime) || current.claim !== claim) throw new Error("Background preparation lease changed");
        // Stage entry is diagnostic timing, not evidence of new durable work.
        transaction.update(preparation, { stage, timings });
      });
    }
    try {
      if (!acquired && await paused()) return false;
      const stored = (await preparation.get()).data();
      if (!stored || !ownsPublication(stored, runtime) || (!acquired && stored.status !== "verified")) return false;
      if (!firebaseApp) throw new Error("Durable preparation storage is unavailable");
      if (stored.backgroundBucket !== admission.backgroundBucket) throw new PreparationIntegrityError("Preparation bucket changed");
      const cloud = createNoBuildPreparationStorage(stored.backgroundBucket, firebaseApp, {
        operationId: queueId, contextDigest, commitSha, owner: runtime.owner,
        cutoffMillis: stored.reservation.cutoffAt.toMillis(), admissionRevision: stored.admissionRevision,
      });
      let preparedDigest = await cloud.restore("prepared", retained, stored.preparedDigest);
      if (preparedDigest && stored.preparedDigest && stored.preparedDigest !== preparedDigest) {
        throw new PreparationIntegrityError("Preparation manifest digest changed");
      }
      if (!preparedDigest) {
        if (!acquired) throw new PreparationIntegrityError("Verified preparation checkpoint is missing");
        await advanceStage("restore_input");
        let inputDigest = await cloud.restore("input", retained, stored.inputDigest);
        if (inputDigest && stored.inputDigest && stored.inputDigest !== inputDigest) throw new PreparationIntegrityError("Preparation input digest changed");
        if (!inputDigest) {
          await advanceStage("freeze_input");
          const reservation = stored.reservation;
          // This one historical read is needed only before input is durable.
          // A retry keeps its original cutoff; it never silently reads newer data.
          const frozenContext = await firestore.runTransaction(async transaction => ({
            digest: await readPublicContextInTransaction(transaction, firestore),
            externalInputs: (await transaction.get(firestore.doc("system/publicDeployment/contexts/public"))).data()?.externalInputs,
          }), { readOnly: true, readTime: reservation.cutoffAt });
          if (frozenContext.digest !== contextDigest) throw new Error("Background context changed before reservation");
          const frozen = await readPublicArtifactContentFromDatabase(firestore as never,
            { buildBatchId, commitSha, batchMode: "background" }, new Date());
          const routes = frozen.posts.filter(post => post.type === "post" && post.published && typeof post.published === "object")
            .flatMap(post => { const source = dependency(post); return source.visible
              ? [{ path: source.canonicalPath, sourceVersion: source.sourceVersion, digest: source.digest }] : []; });
          await mkdir(retained, { recursive: true, mode: 0o700 });
          await writePublicArtifactBundle(path.join(retained, "input.json"), { schemaVersion: 3, ...projectPublicArtifactContent(frozen) });
          await writeFile(path.join(retained, "routes.json"), JSON.stringify(routes), { mode: 0o600 });
          let imageFiles: string[];
          if (frozenContext.externalInputs) {
            await restoreCloudExternalInputs({ inputs: frozenContext.externalInputs,
              storage: createPostBackgroundStorage(admission.backgroundBucket, firebaseApp), directory: retained });
            imageFiles = await freezeRetainedPublicImages(retained, { buildBatchId, commitSha });
          } else imageFiles = await freezeBackgroundPublicationInputs({ buildBatchId, commitSha,
            artifactReceiptPath: path.join(retained, "artifact-inventory.json"), buildEnvironment, mediaManagerCredential,
            retainedInputDirectory: retained });
          await advanceStage("checkpoint_input");
          inputDigest = await cloud.checkpoint("input", retained, [...backgroundInputFiles, ...imageFiles]);
        }
        // The digest only becomes recoverable after all cloud bytes pass readback.
        await firestore.runTransaction(async transaction => {
          const current = (await transaction.get(preparation)).data();
          if (!current || !ownsPublication(current, runtime) || current.claim !== claim) throw new Error("Background preparation lease changed");
          transaction.update(preparation, { inputDigest,
            ...(current.inputDigest !== inputDigest ? { progressAt: Date.now() } : {}) });
        });
        if (contextOnly && runtime.owner === "cloudflare") {
          try {
            await advanceStage("preview_projection");
            if (stored.previewProjection && !verifiedPreviewProjection({ ...stored, inputDigest }, runtime, contextDigest)) {
              throw new PreparationIntegrityError("Preview projection identity changed");
            }
            const projectionDirectory = path.join(retained, "preview", "dist");
            const projectionStorage = createNoBuildPreparationStorage(stored.backgroundBucket, firebaseApp,
              { operationId: queueId, contextDigest, commitSha, owner: runtime.owner,
                cutoffMillis: stored.reservation.cutoffAt.toMillis(), admissionRevision: stored.admissionRevision, inputDigest });
            let projectionDigest = await projectionStorage.restore("preview", projectionDirectory, stored.previewProjection?.digest);
            if (!projectionDigest) {
              if (stored.previewProjection) throw new PreparationIntegrityError("Verified preview projection is missing");
              await buildPreviewProjection({ buildBatchId, commitSha, retainedInputDirectory: retained,
                artifactReceiptPath: path.join(retained, "artifact-inventory.json"), buildEnvironment }, projectionDirectory);
              projectionDigest = await projectionStorage.checkpoint("preview", projectionDirectory, ["public-context.json"]);
            }
            await firestore.runTransaction(async transaction => {
              const current = (await transaction.get(preparation)).data();
              const selected = await readSelectedPublicContextInTransaction({ transaction, firestore, operationId: queueId, runtime });
              if (!current || !ownsPublication(current, runtime) || current.claim !== claim ||
                  current.inputDigest !== inputDigest || selected.digest !== contextDigest) throw new Error("Preview projection lease changed");
              transaction.update(preparation, { previewProjection: { schemaVersion: 1, status: "verified",
                digest: projectionDigest, inputDigest }, progressAt: Date.now() });
            });
            onPreviewProjection?.();
          } catch (error) {
            // This optional early seal never spends the public compiler's budget.
            // Without it, a successful full preparation keeps its existing reader.
            console.error(`Independent preview projection refused: ${backgroundPreparationDiagnostic(error, "preview_projection", buildEnvironment)}`);
          }
        }
        await advanceStage("renderer");
        await buildPublication({ buildBatchId, commitSha, artifactReceiptPath: path.join(retained, "artifact-inventory.json"),
          retainedInputDirectory: retained,
          buildEnvironment: { ...buildEnvironment, PUBLIC_POST_RENDERER_COMPILE: "0", PUBLIC_ARTIFACT_BATCH_MODE: "background" } });
        await advanceStage("collect_family_files");
        prepared = { schemaVersion: 2, contextDigest, routes: JSON.parse(await readFile(path.join(retained, "routes.json"), "utf8")),
          files: await familyFiles(distDirectory, ["home", ...(contextOutputs(stored) as string[])], contextDigest) };
        await retainFiles(distDirectory, retained, prepared);
        await advanceStage("checkpoint_prepared");
        preparedDigest = await cloud.checkpoint("prepared", retained,
          [...backgroundOutputFiles, ...prepared.files.map(file => `files/${file.file}`)]);
      }
      await advanceStage("verify_prepared");
      const bytes = await readFile(path.join(retained, "receipt.json"));
      prepared = parsePreparedBackground(bytes, contextDigest);
      if (acquired) {
        const readPreparedContext = async (transaction: Transaction) => contextOnly
          ? (await readSelectedPublicContextInTransaction({ transaction, firestore, operationId: queueId, runtime })).digest
          : readPublicContextInTransaction(transaction, firestore);
        const currentContext = await firestore.runTransaction(readPreparedContext, { readOnly: true });
        if (currentContext !== contextDigest) throw new Error("Background context changed during generation");
        await firestore.runTransaction(async transaction => {
          const current = (await transaction.get(preparation)).data();
          const liveState = state ? await currentState(transaction, state) : null;
          if (!current || !ownsPublication(current, runtime) || (!contextOnly && !liveState) || current.claim !== claim ||
              await readPreparedContext(transaction) !== contextDigest) throw new Error("Background preparation lease changed");
          transaction.update(preparation, { status: "verified", preparedDigest, claim: null, nextAttemptAt: null, error: null, diagnostic: null,
            progressAt: Date.now(), stage: "family_recovery", timings: { ...timings, verify_prepared: Date.now() - stageStartedAt } });
        });
      } else if (stored.preparedDigest !== preparedDigest) throw new PreparationIntegrityError("Preparation manifest digest changed");
      retainedValid = true;
      stage = "family_recovery";
      const owner = createPostBackgroundOutputs({ firestore, runtime, enabled: true, accepting: false, postIds: state ? [state.postId] : [],
        searchFileCount: prepared.files.filter(file => file.outputs.includes("search")).length,
        contentApiEnabled: true, recoveryOutputs: contextOnly ? ["home", ...contextOutputs(stored)] : legacyFamilies,
        artifacts: createPostBackgroundStorage(admission.backgroundBucket, firebaseApp),
        readContextInTransaction: async (transaction: Transaction, output?: string) => {
          if (contextOnly) {
            // Each family claim and completion is fenced by the explicitly
            // selected preparation. A superseded A cannot generate B's tasks.
            const context = await readSelectedPublicContextInTransaction({ transaction, firestore, operationId: queueId, runtime });
            if (context.digest !== contextDigest) throw new Error("Aggregate preparation superseded");
            if (output === "home") {
              const live = await readPublicBackgroundContextInTransaction(transaction, firestore) as { digest: string };
              if (live.digest !== contextDigest) throw new Error("Home requires the current public context");
              return live;
            }
            return context;
          }
          return readPublicBackgroundContextInTransaction(transaction, firestore);
        },
        build: async (task: { output: string; contextDigest: string }, { signal }: { signal: AbortSignal }) => {
          if (task.contextDigest !== prepared.contextDigest) throw new Error("Background input changed");
          const input = { kind: "public-background", rendererSha: commitSha, contextDigest: prepared.contextDigest, routes: prepared.routes };
          if (["programs", "events"].includes(task.output)) {
            return { input, prepared: { operationId: queueId, checkpointDigest: preparedDigest } };
          }
          const selected = prepared.files.filter(file => file.outputs.includes(task.output));
          const files: { path: string; contentType: string; bytes: Buffer }[] = [];
          for (let offset = 0; offset < selected.length; offset += 32) {
            files.push(...await Promise.all(selected.slice(offset, offset + 32).map(async file => {
              signal.throwIfAborted();
              const bytes = await readFile(path.join(retained, "files", file.file));
              if (bytes.length !== file.size || sha256(bytes) !== file.digest) throw new Error("Retained background bytes changed");
              return { path: file.path, contentType: file.contentType, bytes };
            })));
          }
          return { input, files: files.filter(file => !isBackgroundAssetPath(file.path)),
            assets: files.filter(file => isBackgroundAssetPath(file.path)) };
        } });
      await owner.recover();
      if (contextOnly) await settlePublicContext({ firestore, operationId: queueId, runtime });
      else await attemptHomeFallback(queueId);
      return true;
    } catch (error) {
      const diagnostic = backgroundPreparationDiagnostic(error, stage, buildEnvironment);
      // A restore I/O failure does not invalidate a cloud-verified checkpoint or
      // consume another build attempt. The next maintenance pass may restore it.
      // A proven digest/identity conflict still fails closed as a preparation error.
      if (!acquired && (retainedValid || !(error instanceof PreparationIntegrityError))) {
        console.error(`No-build background checkpoint recovery failed: ${diagnostic}`);
        if (!contextOnly) await attemptHomeFallback(queueId, true);
        return true;
      }
      console.error(`No-build background preparation failed: ${diagnostic}`);
      await firestore.runTransaction(async transaction => {
        const current = (await transaction.get(preparation)).data();
        if (!current || !ownsPublication(current, runtime) || (acquired ? current.claim !== claim : current.status !== "verified")) return;
        transaction.update(preparation, { status: "failed", claim: null, error: "background_preparation_failed", diagnostic,
          nextAttemptAt: current.attempts >= 4 ? null : Date.now() + 60_000 * 2 ** (current.attempts - 1) });
      });
      if (!contextOnly) await attemptHomeFallback(queueId, true);
      else await failPublicContextPreparation({ firestore, operationId: queueId, runtime });
      return true;
    }
  };
  async function recoverFailedContextOutputs(contextJob: BackgroundContextSelection, publicContext: unknown, bucket: string) {
    // Restore only the sealed preparation. Never reset its build budget or the
    // aggregate's failed status before every exact output receipt verifies.
    const states = await firestore.getAll(...(contextOutputs(publicContext) as string[])
      .map(output => firestore.doc(`cmsBackgroundOutputs/${output}`)));
    if (states.every(row => row.data()?.status === "verified")) {
      await settlePublicContext({ firestore, operationId: contextJob.operationId, runtime });
      return;
    }
    const refs = states.filter(row => row.data()?.taskPath).map(row => firestore.doc(row.data()!.taskPath));
    if (!refs.length) return;
    const tasks = await firestore.getAll(...refs);
    if (!tasks.some(row => slowBackgroundRetryDue(row.data(), Date.now()) || expiredBackgroundClaim(row.data(), Date.now()))) return;
    const preparationId = contextJob.preparationOperationId ?? contextJob.operationId;
    const preparation = await firestore.doc(`cmsPublishQueue/${preparationId}/backgroundPreparation/${contextJob.contextDigest}`).get();
    if (!verifiedPreparation(preparation.data(), runtime, contextJob.contextDigest)) return;
    await prepareJob({ queueId: preparationId, contextOnly: true }, contextJob.contextDigest,
      { valid: true, enabled: true, backgroundBucket: bucket, admissionRevision: null });
  }
  return async () => {
    if (await paused()) return;
    const admission = await readNoBuildFamilyAdmission({ firestore, env: buildEnvironment });
    const owners = await listNoBuildPostOwners({ firestore });
    // Accepted normal builds must drain even when fast admission is missing or
    // malformed. Keep the existing owner fence; generation still needs admission.
    for (const { state } of owners) {
      if (!state.operationId || state.mode === "static" || state.visible !== false || !samePublicationOwner(state, runtime)) continue;
      const queue = (await firestore.doc(`cmsPublishQueue/${state.operationId}`).get()).data();
      if (!samePublicationOwner({ runtime: queue?.backgroundRuntime }, runtime)) continue;
      try { await enqueuePostWithdrawalBuild({ firestore, operationId: state.operationId }); }
      catch { console.error("Post withdrawal full build could not start"); }
    }
    if (runtime.owner === "cloudflare" && backgroundBucket) {
      if (!/^[a-z0-9][a-z0-9._-]{2,220}$/.test(backgroundBucket)) throw new Error("Invalid cloud aggregate bucket");
      const contextJob = await firestore.runTransaction(async transaction => {
        if (await paused(transaction)) return null;
        const [current, context, pointer, control] = await transaction.getAll(firestore.doc(CURRENT_PATH),
          firestore.doc("system/publicDeployment/contexts/public"), firestore.doc("system/publicDeployment"),
          firestore.doc("system/cmsPublicationRuntime"));
        if (pointer.data()?.state !== "idle" || pointer.data()?.activeCommitSha !== commitSha) return null;
        const digest = await readPublicContextInTransaction(transaction, firestore);
        const previous = current.data();
        let frozenToDrain: typeof previous = undefined;
        if (previous && previous.contextDigest !== digest && ownsPublication(previous, runtime) && previous.finalNamespaceOwner === true) {
          const followUpQueues = await publicContextFollowUpQueuesInTransaction({ transaction, firestore, selected: previous });
          const followUpQueue = followUpQueues.find((row: { data(): { status: string } }) => row.data().status === "pending");
          const ids = previous.operationIds ?? [previous.operationId];
          if (!Array.isArray(ids) || !ids.length || ids.length > 100 || new Set(ids).size !== ids.length ||
              !ids.includes(previous.operationId) || !ids.every(id => /^[A-Za-z0-9]{20}$/.test(id))) throw new Error("Aggregate aliases refused");
          const [preparationRow, ...queueRows] = await transaction.getAll(
            firestore.doc(`cmsPublishQueue/${previous.preparationOperationId}/backgroundPreparation/${previous.contextDigest}`),
            ...ids.map(id => firestore.doc(`cmsPublishQueue/${id}`)));
          const queueRow = queueRows.find(row => row.id === previous.operationId)!;
          const frozen = queueRow.data()?.status === "pending" && frozenContextMatches(preparationRow.data(), previous, runtime);
          if (frozen) frozenToDrain = previous;
          if (frozen && !canSupersedeFrozenContext(preparationRow.data(), context.data()?.withdrawalRevision ?? 0, queueRows)) {
            // Context-only changes may not have an explicit queue producer. Keep
            // exactly one latest follow-up without replacing the running cohort.
            if (previous.followUp?.contextDigest !== digest || !followUpQueue) {
              try { assertCmsPublicationCloudAdmission(control.data() ?? null, { commitSha, serializerId }); }
              catch (error) { if (error instanceof CmsPublicationRuntimeControlError) return previous; throw error; }
              const accepted = await enqueuePublicContextInTransaction({ transaction, firestore,
                operationId: randomUUID().replaceAll("-", "").slice(0, 20), runtime, reason: "context", contextRevision: context.data()?.revision });
              accepted.write();
            }
            return previous;
          }
          if (previous.followUp?.contextDigest === digest && followUpQueue) {
            const identity = followUpQueue.data().publicContext;
            const accepted = await enqueuePublicContextInTransaction({ transaction, firestore,
              operationId: identity.operationId, runtime, reason: identity.reason,
              contextRevision: identity.contextRevision, activateQueued: true });
            accepted.write();
            return identity;
          }
        }
        if (previous && previous.contextDigest === digest && ownsPublication(previous, runtime) && previous.finalNamespaceOwner !== true) {
          const outputs = await transaction.getAll(...(contextOutputs(previous) as string[])
            .map(output => firestore.doc(`cmsBackgroundOutputs/${output}`)));
          const namespaceOperationId = outputs[0].data()?.taskPath?.split("/")[1];
          if (typeof namespaceOperationId === "string" && /^[A-Za-z0-9]{20}$/.test(namespaceOperationId) &&
              outputs.every(row => row.data()?.contextOnly === true && ownsPublication(row.data(), runtime) &&
                row.data()?.contextDigest === digest && row.data()?.taskPath === `cmsPublishQueue/${namespaceOperationId}/backgroundOutputs/${row.id}`)) {
            if (!/^[A-Za-z0-9]{20}$/.test(previous.preparationOperationId ?? "")) throw new Error("Legacy aggregate namespace ownership refused");
            const [queueRow, preparationRow] = await transaction.getAll(firestore.doc(`cmsPublishQueue/${namespaceOperationId}`),
              firestore.doc(`cmsPublishQueue/${previous.preparationOperationId}/backgroundPreparation/${digest}`));
            const queue = queueRow.data(), preparation = preparationRow.data();
            const tasks = await transaction.getAll(...outputs.map(row => firestore.doc(row.data()!.taskPath)));
            if (queue?.transport !== "public-context-no-build-v1" || !ownsPublication(queue, runtime) ||
                queue.publicContext?.contextDigest !== digest || preparation?.schemaVersion !== 1 ||
                preparation.contextDigest !== digest || !ownsPublication(preparation, runtime) ||
                preparation.reservation?.commitSha !== runtime.release || !tasks.every((row, index) => row.data()?.schemaVersion === 1 &&
                  row.data()?.contextOnly === true && ownsPublication(row.data(), runtime) && row.data()?.output === outputs[index].id &&
                  row.data()?.contextDigest === digest && row.data()?.revision === outputs[index].data()?.revision)) {
              throw new Error("Legacy aggregate namespace ownership refused");
            }
            transaction.update(current.ref, { finalNamespaceOwner: true, namespaceOperationId });
            return { ...previous, finalNamespaceOwner: true, namespaceOperationId };
          }
        }
        if (previous && previous.contextDigest === digest && ownsPublication(previous, runtime) && previous.finalNamespaceOwner === true) {
          const outputs = await transaction.getAll(...(contextOutputs(previous) as string[])
            .map(output => firestore.doc(`cmsBackgroundOutputs/${output}`)));
          if (!outputs.every(row => row.data()?.contextOnly === true && ownsPublication(row.data(), runtime) &&
              row.data()?.contextDigest === digest && row.data()?.taskPath === `cmsPublishQueue/${previous.namespaceOperationId}/backgroundOutputs/${row.id}`)) {
            throw new Error("Final aggregate namespace ownership refused");
          }
          return previous;
        }
        try { assertCmsPublicationCloudAdmission(control.data() ?? null, { commitSha, serializerId }); }
        catch (error) {
          // A withdrawal can commit just before a pause. Accepted frozen work
          // still drains when the latest unqueued context cannot be admitted.
          if (error instanceof CmsPublicationRuntimeControlError) return frozenToDrain ??
            (previous && previous.contextDigest === digest && ownsPublication(previous, runtime) ? previous : null);
          throw error;
        }
        const operationId = randomUUID().replaceAll("-", "").slice(0, 20);
        const accepted = await enqueuePublicContextInTransaction({ transaction, firestore, operationId, runtime,
          reason: "context", contextRevision: context.data()?.revision });
        accepted.write();
        return { operationId, contextDigest: digest };
      });
      if (contextJob) {
        const queue = (await firestore.doc(`cmsPublishQueue/${contextJob.operationId}`).get()).data();
        if (queue?.status === "failed") {
          const selection = backgroundContextSelection(queue.publicContext, contextJob.preparationOperationId);
          if (selection.operationId !== contextJob.operationId || selection.contextDigest !== contextJob.contextDigest) {
            throw new Error("Aggregate context selection changed");
          }
          await recoverFailedContextOutputs(selection, queue.publicContext, backgroundBucket);
        }
        if (queue?.status === "pending") {
          if (!await settlePublicContext({ firestore, operationId: contextJob.operationId, runtime })) {
            const current = (await firestore.doc(`cmsPublishQueue/${contextJob.operationId}`).get()).data();
            if (current?.status === "pending") await prepareJob({ queueId: contextJob.operationId, contextOnly: true }, contextJob.contextDigest,
              { valid: true, enabled: true, backgroundBucket, admissionRevision: null });
          }
          // Context preparation/backoff never starves retained Post-owned Home work.
        }
      }
    }
    if (!admission.valid) return;
    const capability = await readNoBuildPostCapability({ firestore });
    const states = new Map<string, PostOwnerState>(owners.filter(({ state }: { state: PostOwnerState }) =>
      eligibleState(state, capability)).map(({ state }: { state: PostOwnerState }) => [state.postId, state]));
    if (!states.size) return;
    const currentQueues: string[] = [];
    for (const state of states.values()) {
      const queue = (await firestore.doc(`cmsPublishQueue/${state.operationId}`).get()).data();
      if (!samePublicationOwner({ runtime: queue?.backgroundRuntime }, runtime)) continue;
      currentQueues.push(state.operationId);
    }
    const contextDigest = await firestore.runTransaction((transaction: unknown) =>
      readPublicContextInTransaction(transaction, firestore), { readOnly: true });
    for (const queueId of currentQueues) {
      const [admissionFailure, priorPreparation] = await Promise.all([
        firestore.doc(`cmsPublishQueue/${queueId}/backgroundOutputs/_admission`).get(),
        firestore.doc(`cmsPublishQueue/${queueId}/backgroundPreparation/${contextDigest}`).get(),
      ]);
      await attemptHomeFallback(queueId, admissionFailure.data()?.status === "failed" || priorPreparation.data()?.status === "failed");
    }
    const outputs = await firestore.getAll(...families.map(output => firestore.doc(`cmsBackgroundOutputs/${output}`)));
    const jobs = new Map<string, BackgroundJob>();
    for (const row of outputs) {
      const output = row.data();
      const state = output && states.get(output.postId);
      if (!state || !samePublicationOwner(output, runtime)) continue;
      const changed = output.contextDigest !== contextDigest || !ownsPublication(output, runtime) ||
        (output.status === "verified" && output.receipt?.rendererSha !== commitSha);
      if (!changed && output.status === "verified") continue;
      const match = new RegExp(`^cmsPublishQueue/([A-Za-z0-9]{20})/backgroundOutputs/${row.id}(?:-[0-9]+)?$`).exec(output.taskPath ?? "");
      if (!match) continue;
      const task = (await firestore.doc(output.taskPath).get()).data();
      if (!task || task.postId !== state.postId || !samePublicationOwner(task, runtime) ||
          (!changed && (!ownsPublication(task, runtime) || !(retryDue(task, Date.now()) ||
            slowBackgroundRetryDue(task, Date.now()) || expiredBackgroundClaim(task, Date.now()))))) continue;
      const queueId = match[1];
      const queue = (await firestore.doc(`cmsPublishQueue/${queueId}`).get()).data();
      if (!queue || queue.transport !== "post-no-build-v1" || queue.noBuildPost?.postId !== state.postId ||
          queue.noBuildPost.operationId !== queueId || !samePublicationOwner({ runtime: queue.backgroundRuntime }, runtime)) continue;
      jobs.set(queueId, { state, queueId });
    }
    // Every preparation contains the complete public context. One successful
    // preparation can feed every current family task at that exact context.
    for (const job of jobs.values()) {
      if (await prepareJob(job, contextDigest, admission)) return;
    }
  };
}
