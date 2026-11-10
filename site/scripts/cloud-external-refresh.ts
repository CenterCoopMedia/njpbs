import producer from "../../functions/lib/public-release-producer.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import type { App } from "firebase-admin/app";
import type { Firestore } from "firebase-admin/firestore";
import { main as syncLaunchContent } from "./sync-launch-content.mjs";
import { main as syncSpotlightNews } from "./sync-spotlight-news.mjs";
import { createSpotlightImageStorage } from "./spotlight-image-cache.mjs";
import { main as syncSchedule } from "./sync-schedule.mjs";
import { assertCmsPublicationSourceCheckout } from "./cms-publication-runtime-guard";
import type { MediaManagerCredential } from "./frozen-publication";
import { createCloudSchedulePacket, type CloudSchedulePacket } from "./cloud-schedule-packet";

const require = createRequire(import.meta.url);
const { EXTERNAL_REFRESH_PATH, EXTERNAL_INPUT_FILES, externalRefreshHold, externalRefreshHeld, externalRefreshDue, nextExternalRefreshAt } = require("../../functions/lib/cloud-external-refresh-state");
const { ownsPublication, publicationRuntime } = require("../../functions/lib/publication-runtime-owner");
const { cloudCmsPublicationRuntimeControl } = require("../../functions/lib/cms-publication-runtime-control");
const { PUBLIC_CONTEXT_PATH, bumpPublicContextRevision } = require("../../functions/lib/public-context-revision");
const { enqueuePublicContextInTransaction } = require("../../functions/lib/public-context-publication");
const { createPostBackgroundStorage } = require("../../functions/lib/post-background-storage");
const { parseDataHubReporting } = require("../../functions/lib/data-hub-reporting");
const { reportingMappings } = require("../../functions/lib/data-hub-reporting-sources");
const { refreshSpotlightReporting } = require("../../functions/lib/data-hub-spotlight");
const { readRetainedReporting } = require("../../functions/lib/data-hub-reporting-input");
const { publiclyVisible } = require("../../functions/lib/public-video-references");
const { parsePublishInstant } = require("../../functions/lib/publish-instant");
function publishedReporting(document: any, now: number) {
  const at = parsePublishInstant(document?.status === "published" ? document.publishAt : document?.published?.publishedAt);
  return publiclyVisible(document) && at !== null && at <= now ? parseDataHubReporting(document.published?.metadata?.dataHubReporting) : undefined;
}
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const NO_MAPPING_DIGEST = hash(JSON.stringify(null));
type Runtime = { owner: "cloudflare"; release: string };
type Storage = ReturnType<typeof createPostBackgroundStorage>;
interface InputFile { key: string; digest: string; size: number }
export interface CloudExternalInputs { schemaVersion: 1; operationId: string; runtime: Runtime; contentDigest: string;
  checkedAt: number; files: Record<string, InputFile>; schedulePacket?: CloudSchedulePacket }

// Provider observation timestamps do not change the public cards or schedule.
// Array order and every other public field remain part of the content identity.
function contentValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(contentValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .filter(([key]) => !["checkedAt", "generatedAt", "sourceCheckedAt"].includes(key)).map(([key, item]) => [key, contentValue(item)]));
  return value;
}
export function externalInputContentDigest(files: Record<string, Buffer>) {
  const values = Object.fromEntries(EXTERNAL_INPUT_FILES.map((name: string) => [name, contentValue(JSON.parse(files[name].toString("utf8")))]));
  return hash(JSON.stringify(values));
}
function assertExternalInputs(value: CloudExternalInputs) {
  publicationRuntime(value?.runtime);
  if (value?.schemaVersion !== 1 || value.runtime.owner !== "cloudflare" || !/^[A-Za-z0-9]{20}$/.test(value.operationId) ||
      !/^[a-f0-9]{64}$/.test(value.contentDigest) || !Number.isFinite(value.checkedAt) ||
      !value.files || Object.keys(value.files).length !== EXTERNAL_INPUT_FILES.length) throw new Error("Invalid frozen external inputs");
  for (const name of EXTERNAL_INPUT_FILES) {
    const file = value.files[name];
    if (!file || file.key !== `post-background-v1/external-inputs/${value.operationId}/${name}` ||
        !/^[a-f0-9]{64}$/.test(file.digest) || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > 16 * 1024 * 1024) {
      throw new Error("Invalid frozen external input receipt");
    }
  }
  return value;
}

/** Restore the exact context's immutable inputs. Never fetch fresher providers
 * under an already accepted context revision. */
export async function restoreCloudExternalInputs({ inputs, storage, directory }: {
  inputs: CloudExternalInputs; storage: Storage; directory: string;
}) {
  assertExternalInputs(inputs);
  const files: Record<string, Buffer> = {};
  for (const name of EXTERNAL_INPUT_FILES) {
    const receipt = inputs.files[name];
    const bytes = Buffer.from(await storage.get(receipt.key, { signal: AbortSignal.timeout(30_000) }));
    if (bytes.length !== receipt.size || hash(bytes) !== receipt.digest) throw new Error("Frozen external input digest changed");
    files[name] = bytes;
  }
  if (externalInputContentDigest(files) !== inputs.contentDigest) throw new Error("Frozen external content identity changed");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const name of EXTERNAL_INPUT_FILES) await writeFile(path.join(directory, name), files[name], { mode: 0o600 });
}

export function boundedFetch(fetchImpl: typeof fetch, provider: "media-manager" | "default" = "default"): typeof fetch {
  // Bound complete provider responses before parsing or retaining them.
  const maximumBytes = (provider === "media-manager" ? 4 : 2) * 1024 * 1024;
  return async (url, options = {}) => {
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000);
    let response: Response;
    try { response = await fetchImpl(url, { ...options, redirect: "error", signal }); }
    catch { throw new Error("External provider request failed"); }
    if (!response.ok) {
      await response.body?.cancel();
      return new Response(null, { status: response.status }); // Provider error bodies never enter logs.
    }
    if (!response.body) return response;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        size += result.value.length;
        if (size > maximumBytes) throw new Error("External provider response exceeds its bound");
        chunks.push(result.value);
      }
    } finally { await reader.cancel(); }
    return new Response(Buffer.concat(chunks), { status: response.status, headers: { "Content-Type": response.headers.get("Content-Type") ?? "application/json" } });
  };
}

export function cloudExternalRefresh({ firestore, firebaseApp, runtime, backgroundBucket, stateDirectory,
  buildEnvironment, mediaManagerCredential, serializerId, spotlightImageStorageFactory, fetchImpl = fetch, clock = Date.now }: {
  firestore: Firestore; firebaseApp: App; runtime: Runtime; backgroundBucket: string; stateDirectory: string; serializerId: string;
  buildEnvironment: Record<string, string | undefined>; mediaManagerCredential: MediaManagerCredential; fetchImpl?: typeof fetch; clock?: () => number;
  spotlightImageStorageFactory?: (signal: AbortSignal) => ReturnType<typeof createSpotlightImageStorage>;
}) {
  publicationRuntime(runtime);
  const storage = createPostBackgroundStorage(backgroundBucket, firebaseApp);
  return async () => {
    // A runtime preflight and an uninitialized site do not start provider work.
    const controlSnapshot = (await firestore.doc("system/cmsPublicationRuntime").get()).data();
    if (!controlSnapshot) return;
    const control = cloudCmsPublicationRuntimeControl(controlSnapshot);
    if (control.phase !== "ready" || control.commitSha !== runtime.release || control.serializerId !== serializerId) return;
    const operationId = randomUUID().replaceAll("-", "").slice(0, 20);
    const ref = firestore.doc(EXTERNAL_REFRESH_PATH);
    const claim = await firestore.runTransaction(async transaction => {
      const [row, pointer, context, controlRow, reportingPage] = await transaction.getAll(ref, firestore.doc("system/publicDeployment"),
        firestore.doc(PUBLIC_CONTEXT_PATH), firestore.doc("system/cmsPublicationRuntime"), firestore.doc("cmsPages/data-hub"));
      const liveControl = cloudCmsPublicationRuntimeControl(controlRow.data());
      if (liveControl.phase !== "ready" || liveControl.commitSha !== runtime.release || liveControl.serializerId !== serializerId || pointer.data()?.state !== "idle" ||
          pointer.data()?.activeCommitSha !== runtime.release || context.data()?.schemaVersion !== 1) return null;
      const previous = row.data();
      // A release hold fences mapping changes and successor runtimes too.
      if (externalRefreshHeld(previous, clock())) return null;
      const config = publishedReporting(reportingPage.data(),clock());
      const mappingDigest = hash(JSON.stringify(config ?? null));
      // Rows written before mappings existed carry no digest; they mean "no mapping".
      const mappingChanged = (previous?.mappingDigest ?? NO_MAPPING_DIGEST) !== mappingDigest;
      const fetching = previous?.status === "fetching" && previous.nextAttemptAt > clock();
      if (!externalRefreshDue(previous, runtime, clock()) && (!mappingChanged || fetching)) return null;
      const startedAt = clock();
      const continuing = !mappingChanged && previous && ownsPublication(previous, runtime) && previous.nextCheckAt > startedAt && previous.status !== "verified";
      const hold = externalRefreshHold(previous, clock());
      const next = { schemaVersion: 1, runtime, operationId, mappingDigest, hold, status: "fetching", attempts: continuing ? previous.attempts + 1 : 1,
        periodStartedAt: continuing ? previous.periodStartedAt : startedAt,
        nextCheckAt: continuing ? previous.nextCheckAt : nextExternalRefreshAt(startedAt), nextAttemptAt: startedAt + 10 * 60_000,
        checkedAt: previous?.checkedAt ?? null, error: null, diagnostic: null };
      transaction.set(ref, next);
      return { ...next, config, previousInputs: context.data()?.externalInputs };
    });
    if (!claim) return;
    const directory = path.join(stateDirectory, "external-refresh", operationId);
    let stage: "source" | "provider" | "seal" | "accept" = "source";
    try {
      await assertCmsPublicationSourceCheckout(runtime.release);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const environment = { ...buildEnvironment, REQUIRE_FRESH_CONTENT: "1",
        MEDIA_MANAGER_API_KEY: mediaManagerCredential.key, MEDIA_MANAGER_API_SECRET: mediaManagerCredential.secret,
        LAUNCH_CONTENT_OUTPUT: path.join(directory, "launch-media-manager.json"), SPOTLIGHT_NEWS_OUTPUT: path.join(directory, "spotlight-news.json"),
        SCHEDULE_OUTPUT: path.join(directory, "schedule.json") };
      const request = boundedFetch(fetchImpl);
      stage = "provider";
      let previousReporting;
      try { previousReporting = await readRetainedReporting({ inputs: claim.previousInputs,
        read: (key: string) => storage.get(key,{signal:AbortSignal.timeout(15_000)}) }); } catch { /* Optional source; native Posts remain independent. */ }
      const reporting = claim.config ? refreshSpotlightReporting(reportingMappings(claim.config),previousReporting,{fetchImpl,clock}) : Promise.resolve(undefined);
      const results = await Promise.allSettled([syncLaunchContent(environment, boundedFetch(fetchImpl, "media-manager")), syncSpotlightNews(environment, request, { storageFactory: spotlightImageStorageFactory }), syncSchedule(environment, request, new Date(clock()))]);
      const reportingSnapshot = await reporting;
      if (results.some(result => result.status === "rejected")) throw new Error("External provider refresh failed");
      // Compose after the feed sync writes its file; never change the three-file receipt shape.
      if (reportingSnapshot) {
        const spotlightPath = path.join(directory,"spotlight-news.json");
        const feed = JSON.parse(await readFile(spotlightPath,"utf8"));
        await writeFile(spotlightPath,JSON.stringify({...feed,dataHubReporting:reportingSnapshot})+"\n",{mode:0o600});
      }
      stage = "seal";
      const files: Record<string, Buffer> = {};
      const receipts: Record<string, InputFile> = {};
      for (const name of EXTERNAL_INPUT_FILES) {
        const bytes = await readFile(path.join(directory, name));
        if (bytes.length < 1 || bytes.length > 16 * 1024 * 1024) throw new Error("External input exceeds its bound");
        files[name] = bytes;
        const key = `post-background-v1/external-inputs/${operationId}/${name}`;
        const signal = AbortSignal.timeout(30_000);
        await storage.put(key, bytes, { signal, contentType: "application/json" });
        const retained = await storage.get(key, { signal });
        if (hash(Buffer.from(retained)) !== hash(bytes)) throw new Error("External input readback failed");
        receipts[name] = { key, digest: hash(bytes), size: bytes.length };
      }
      const inputs: CloudExternalInputs = { schemaVersion: 1, operationId, runtime,
        checkedAt: clock(), contentDigest: externalInputContentDigest(files), files: receipts };
      const previousInputs: CloudExternalInputs | undefined = (await firestore.doc(PUBLIC_CONTEXT_PATH).get()).data()?.externalInputs;
      // Initialize a historical input under a successor context while keeping
      // its original provider identity and clock. Existing pairs stay exact.
      const unchanged = previousInputs?.contentDigest === inputs.contentDigest;
      const acceptedInputs = unchanged ? structuredClone(assertExternalInputs(previousInputs)) : inputs;
      const needsAcceptance = !unchanged || !acceptedInputs.schedulePacket;
      if (needsAcceptance) {
        acceptedInputs.schedulePacket = await createCloudSchedulePacket({ inputs: acceptedInputs, storage });
      }
      stage = "accept";
      await firestore.runTransaction(async transaction => {
        const [current, pointer, context, controlRow, reportingPage] = await transaction.getAll(ref, firestore.doc("system/publicDeployment"),
          firestore.doc(PUBLIC_CONTEXT_PATH), firestore.doc("system/cmsPublicationRuntime"), firestore.doc("cmsPages/data-hub"));
        const liveControl = cloudCmsPublicationRuntimeControl(controlRow.data());
        if (!current.exists || !ownsPublication(current.data(), runtime) || current.data()?.operationId !== operationId ||
            current.data()?.nextAttemptAt <= clock() || liveControl.phase !== "ready" || liveControl.commitSha !== runtime.release || liveControl.serializerId !== serializerId ||
            pointer.data()?.state !== "idle" || pointer.data()?.activeCommitSha !== runtime.release) throw new Error("External refresh owner changed");
        if (hash(JSON.stringify(publishedReporting(reportingPage.data(),clock()) ?? null)) !== claim.mappingDigest) throw new Error("Reporting mapping changed");
        if (!isDeepStrictEqual(context.data()?.externalInputs, previousInputs)) throw new Error("External refresh context changed");
        const changed = needsAcceptance;
        const accepted = changed ? await enqueuePublicContextInTransaction({ transaction, firestore, operationId, runtime,
          reason: "provider-refresh", contextRevision: context.data()!.revision + 1 }) : null;
        const writeReleaseChange = accepted ? await producer.preparePublicReleaseProducerInTransaction({ firestore, transaction,
          operationId, contextRevision: context.data()!.revision + 1, changes: [
            { kind: "provider", id: "external-inputs", action: "dependency", sourceVersion: context.data()!.revision + 1, snapshot: acceptedInputs },
            { kind: "schedule", id: "schedule-packet", action: "dependency", sourceVersion: context.data()!.revision + 1, snapshot: acceptedInputs.schedulePacket },
            { kind: "dataHub", id: "reporting-inputs", action: "dependency", sourceVersion: context.data()!.revision + 1, snapshot: acceptedInputs },
          ] }) : () => {};
        if (accepted) {
          writeReleaseChange();
          bumpPublicContextRevision(transaction, firestore);
          transaction.set(firestore.doc(PUBLIC_CONTEXT_PATH), { externalInputs: acceptedInputs }, { merge: true });
          accepted.write();
        }
        transaction.update(ref, { status: "verified", checkedAt: inputs.checkedAt, contentDigest: inputs.contentDigest,
          nextAttemptAt: nextExternalRefreshAt(clock()), error: null, diagnostic: null });
      });
    } catch {
      console.error(`Cloud external refresh failed at ${stage}`);
      await firestore.runTransaction(async transaction => {
        const current = (await transaction.get(ref)).data();
        if (!current || !ownsPublication(current, runtime) || current.operationId !== operationId) return;
        transaction.update(ref, { status: "failed", error: "external_refresh_failed", diagnostic: stage,
          nextAttemptAt: current.attempts >= 4 ? nextExternalRefreshAt(clock()) : clock() + 60_000 * 2 ** (current.attempts - 1) });
      });
    } finally { await rm(directory, { recursive: true, force: true }); }
  };
}
