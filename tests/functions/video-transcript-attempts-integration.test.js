import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isolatedFirestore, clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import handlers from "../../functions/video-transcripts.js";
import byok from "../../functions/video-transcript-byok.js";
import jobs from "../../functions/lib/video-transcript-job.js";
import paidJobs from "../../functions/lib/video-transcript-byok-job.js";
import credentials from "../../functions/lib/video-transcription-credentials.js";
import renditions from "../../functions/lib/source-media-rendition.js";
import fallback from "../../functions/lib/video-transcript-paid-fallback.js";
import localWorker from "../../functions/lib/video-transcript-worker.js";
import { createHash } from "node:crypto";

const source = { id: "video-library", bucket: "originals", prefix: "", writable: true, access: "active_staff" };
const actor = { uid: "staff", authTime: 100, displayName: "Staff", principal: { grants: [{ role: "staff" }] } };
const settings = { languageCode: "en-US", maxSpeakers: 10 };
const identity = { sourceId: source.id, assetId: "asset" };
const config = { enabled: true, localEnabled: true, fallbackEnabled: true, source, bucket: "renditions", accountId: "123456789012", controlRoleArn: "role", dataRoleArn: "data-role" };
let firestore;
const ref = id => firestore.collection(jobs.TRANSCRIPT_JOBS).doc(id);
function video() {
  const asset = { id: "asset", sourceId: source.id, objectKey: "objects/asset.mxf", objectVersionId: "original1", sizeBytes: 100,
    lifecycle: "active", name: "Video", originalName: "video.mxf", nameSort: "video", updatedAtSort: "2026-10-28T12:00:00Z",
    mimeType: "application/mxf", kind: "video", version: 1, preview: "download_only", rightsStatus: "complete", tags: [] };
  const prefix = `outputs/${renditions.sourceMediaRenditionId(asset)}/attempt/`;
  asset.rendition = { schemaVersion: 1, state: "ready", sourceObjectKey: asset.objectKey, sourceObjectVersionId: asset.objectVersionId,
    sourceSizeBytes: asset.sizeBytes, attemptId: "attempt", updatedAt: "2026-10-28T12:00:00Z",
    web: { objectKey: prefix + "preview.mp4", objectVersionId: "web1", sizeBytes: 50, mimeType: "video/mp4", durationSeconds: 60 },
    poster: { objectKey: prefix + "preview-poster.0000000.jpg", objectVersionId: "poster1", sizeBytes: 5, mimeType: "image/jpeg" } };
  return asset;
}
async function call(operation, body, { paid = false, principal = actor, processor, configuration = config } = {}) {
  const dependencies = { firestore, registryFn: () => new Map([[source.id, source]]), configFn: () => configuration,
    verifyAppCheckFn: async () => {}, requirePrincipalFn: async () => principal, processor, log: { warn() {} } };
  const handler = paid ? byok.createByokHandler(operation, dependencies) : handlers.createTranscriptHandler(operation, dependencies);
  const response = { statusCode: 0, set() {}, status(value) { this.statusCode = value; return this; }, json(body) { this.body = JSON.parse(JSON.stringify(body)); return this; } };
  await handler({ method: "POST", headers: { "content-type": "application/json" }, body }, response);
  return response;
}
async function uncertain() {
  const result = await call("request", { ...identity, ...settings });
  expect(result.statusCode).toBe(200);
  const id = result.body.transcript.id;
  await ref(id).update({ phase: "needs_reconciliation", active: false, startIntentAt: "2026-10-28T12:00:00Z" });
  return id;
}
beforeAll(() => { firestore = isolatedFirestore("video-transcript-attempts"); });
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${firestore.projectId}/databases/(default)/documents`, { method: "DELETE" }, firestore);
  await firestore.collection("mediaSourceAssets").doc("asset").set(video());
  await firestore.collection("users").doc(actor.uid).set({ active: true, grants: [{ role: "staff" }] });
});

describe("provider attempts through the callable and Firestore boundaries", () => {
  it("deduplicates racing new attempts in real transactions and keeps history intact", async () => {
    const previous = await uncertain(), before = (await ref(previous).get()).data();
    const body = { ...identity, ...settings, provider: "local", newAttemptOf: previous, attemptKey: "11111111-1111-4111-8111-111111111111" };
    const responses = await Promise.all([call("request", body), call("request", body)]);
    expect(responses.map(value => value.statusCode)).toEqual([200, 200]);
    expect(responses.map(value => value.body.cached).sort()).toEqual([false, true]);
    const id = responses[0].body.transcript.id;
    expect(responses[1].body.transcript.id).toBe(id);
    expect(id).not.toBe(previous);
    expect((await ref(previous).get()).data()).toEqual(before);
    expect((await ref(id).get()).data()).toMatchObject({ provider: "local", attemptGeneration: 1, previousTranscriptId: previous });
    const queue = (await firestore.collection(jobs.TRANSCRIPT_LIMITS).doc("local-outstanding").get()).data();
    expect(queue.activeIds.filter(value => value === id)).toHaveLength(1);
    await ref(id).update({ active: false, phase: "failed" });
    const fresh = await call("request", { ...body, attemptKey: "22222222-2222-4222-8222-222222222222" });
    expect(fresh.statusCode).toBe(200); expect(fresh.body.cached).toBe(false);
    expect(fresh.body.transcript.id).not.toBe(id);
    expect((await ref(previous).get()).data()).toEqual(before);
  });
  it("reads and downloads the newest ready output while listing all attempt history", async () => {
    const previous = await uncertain();
    const result = await call("request", { ...identity, ...settings, provider: "local", newAttemptOf: previous });
    const id = result.body.transcript.id;
    await ref(id).update({ phase: "ready", active: false, outputs: { txt: "ready-text" } });
    const failed = await call("request", { ...identity, ...settings, provider: "amazon-transcribe", newAttemptOf: id });
    await ref(failed.body.transcript.id).update({ phase: "failed", active: false });
    const processor = { read: async () => [{ speaker: "spk_0", startSeconds: 0, endSeconds: 1, text: "Saved words" }],
      download: async job => ({ url: `https://example.test/${job.id}` }) };
    const read = await call("get", { ...identity, ...settings }, { processor });
    expect(read.statusCode).toBe(200); expect(read.body.transcript.id).toBe(id);
    expect(read.body.transcript.segments[0].text).toBe("Saved words");
    const download = await call("download", { ...identity, ...settings, format: "txt" }, { processor });
    expect(download.statusCode).toBe(200); expect(download.body.url).toContain(id);
    const list = await call("list", identity, { paid: true });
    expect(list.statusCode).toBe(200);
    expect(list.body.transcripts.map(value => value.id)).toEqual(expect.arrayContaining([previous, id, failed.body.transcript.id]));
    expect((await call("get", { ...identity, transcriptId: previous })).body.transcript.state).toBe("needs_reconciliation");
  });
  it("consumes each new Amazon attempt once and preserves billing and role checks", async () => {
    const previous = await uncertain();
    const body = { ...identity, ...settings, provider: "amazon-transcribe", newAttemptOf: previous };
    expect((await call("request", body, { principal: { ...actor, principal: { grants: [] } } })).statusCode).toBe(403);
    const result = await call("request", body), id = result.body.transcript.id;
    expect(result.statusCode).toBe(200);
    const claim = await jobs.claimTranscript(firestore, ref(id), source);
    expect(claim).not.toBeNull();
    await jobs.saveTranscript(firestore, ref(id), claim, { leaseUntil: 0 });
    expect(await jobs.claimTranscript(firestore, ref(id), source)).not.toBeNull();
    const budget = (await firestore.collection("mediaTranscriptionBudgets").doc(claim.amazonBudgetReservation.day ? `global-${claim.amazonBudgetReservation.day}` : "invalid").get()).data();
    expect(budget).toMatchObject({ consumedSubmissions: 1, consumedAudioSeconds: 60 });
    await firestore.doc("system/billing").set({ disabled: true });
    await ref(id).update({ active: false, phase: "failed" });
    const next = await call("request", { ...body, newAttemptOf: id });
    expect(next.statusCode).toBe(200);
    expect(await jobs.claimTranscript(firestore, ref(next.body.transcript.id), source)).toBeNull();
  });
  it("settles an uncertain ElevenLabs run and reserves one fresh terminal attempt", async () => {
    const credential = credentials.credentialIdentity(actor, { scope: "organization", provider: "elevenlabs" });
    await firestore.collection(credentials.CREDENTIAL_COLLECTION).doc(credential.id).set({ ...credential, enabled: true, revision: 1 });
    const body = { ...identity, ...settings, provider: "elevenlabs", credentialScope: "organization", credentialRevision: 1 };
    const first = await call("request", body, { paid: true });
    expect(first.statusCode).toBe(200);
    const id = first.body.transcript.id;
    const validateCurrent = async () => true;
    const claim = await paidJobs.claimJob({ firestore, id, validateCurrent });
    await paidJobs.recordIntent({ firestore, claim, validateCurrent });
    await paidJobs.finishJob({ firestore, claim, result: { outcome: "needs_reconciliation" } });
    const before = (await ref(id).get()).data(), nextBody = { ...body, newAttemptOf: id, attemptKey: "11111111-1111-4111-8111-111111111111" };
    const next = await call("request", nextBody, { paid: true });
    expect(next.statusCode).toBe(200); expect(next.body.cached).toBe(false);
    expect((await call("request", nextBody, { paid: true })).body.cached).toBe(true);
    expect((await ref(id).get()).data()).toEqual(before);
    const budget = (await firestore.collection("mediaTranscriptionBudgets").doc(before.budgetReservation.globalRecord).get()).data();
    expect(budget).toMatchObject({ consumedSubmissions: 1, consumedAudioSeconds: 60, reservedSubmissions: 1, reservedAudioSeconds: 60 });
    expect((await call("request", { ...body, newAttemptOf: next.body.transcript.id }, { paid: true })).statusCode).toBe(409);
    const secondClaim = await paidJobs.claimJob({ firestore, id: next.body.transcript.id, validateCurrent });
    await paidJobs.recordIntent({ firestore, claim: secondClaim, validateCurrent });
    await paidJobs.finishJob({ firestore, claim: secondClaim, result: { outcome: "needs_reconciliation" } });
    const fresh = await call("request", { ...nextBody, attemptKey: "22222222-2222-4222-8222-222222222222" }, { paid: true });
    expect(fresh.statusCode).toBe(200); expect(fresh.body.cached).toBe(false);
    expect(fresh.body.transcript.id).not.toBe(next.body.transcript.id);
    const settled = (await firestore.collection("mediaTranscriptionBudgets").doc(before.budgetReservation.globalRecord).get()).data();
    expect(settled).toMatchObject({ consumedSubmissions: 2, reservedSubmissions: 1 });
  });
});

it("shares one active successor across staff action keys without a second paid reservation", async () => {
  const previous = await uncertain();
  const second = { ...actor, uid: "second-staff" };
  await firestore.collection("users").doc(second.uid).set({ active: true, grants: [{ role: "staff" }] });
  const key = credentials.credentialIdentity(actor, { scope: "organization", provider: "elevenlabs" });
  await firestore.collection(credentials.CREDENTIAL_COLLECTION).doc(key.id).set({ ...key, enabled: true, revision: 1 });
  const body = { ...identity, ...settings, provider: "elevenlabs", credentialScope: "organization", credentialRevision: 1, newAttemptOf: previous };
  const results = await Promise.all([
    call("request", { ...body, attemptKey: "11111111-1111-4111-8111-111111111111" }, { paid: true }),
    call("request", { ...body, attemptKey: "22222222-2222-4222-8222-222222222222" }, { paid: true, principal: second }),
  ]);
  expect(results.map(value => value.statusCode)).toEqual([200, 200]);
  expect(results.map(value => value.body.cached).sort()).toEqual([false, true]);
  expect(results[0].body.transcript.id).toBe(results[1].body.transcript.id);
  const job = (await ref(results[0].body.transcript.id).get()).data();
  const budget = (await firestore.collection("mediaTranscriptionBudgets").doc(job.budgetReservation.globalRecord).get()).data();
  expect(budget).toMatchObject({ reservedSubmissions: 1, reservedAudioSeconds: 60, consumedSubmissions: 0 });
  expect((await call("request", { ...identity, ...settings, provider: "local", newAttemptOf: previous, attemptKey: "33333333-3333-4333-8333-333333333333" })).statusCode).toBe(409);
});

it("keeps corrections on the loaded ready ID when a newer provider completes", async () => {
  const previous = await uncertain();
  const first = await call("request", { ...identity, ...settings, provider: "local", newAttemptOf: previous });
  const firstId = first.body.transcript.id;
  await ref(firstId).update({ active: false, phase: "ready", outputs: { txt: "first" } });
  const next = await call("request", { ...identity, ...settings, provider: "amazon-transcribe", newAttemptOf: firstId });
  const nextId = next.body.transcript.id;
  await ref(nextId).update({ active: false, phase: "ready", outputs: { txt: "second" } });
  const processor = { read: async () => [{ speaker: "spk_0", startSeconds: 0, endSeconds: 1, text: "Saved words" }] };
  const ambiguous = await call("edit", { ...identity, ...settings, revision: 0, reviewed: true }, { processor });
  expect(ambiguous.statusCode).toBe(409);
  const result = await call("edit", { ...identity, transcriptId: firstId, revision: 0, reviewed: true }, { processor });
  expect(result.statusCode).toBe(200);
  expect((await ref(firstId).get()).data()).toMatchObject({ editRevision: 1, reviewedRevision: 1 });
  expect((await ref(nextId).get()).data()).not.toHaveProperty("reviewedRevision");
});

it.each(["local", "amazon-transcribe"])("reuses an active %s attempt across two staff members", async provider => {
  const previous = await uncertain();
  const second = { ...actor, uid: "second-staff" };
  await firestore.collection("users").doc(second.uid).set({ active: true, grants: [{ role: "staff" }] });
  const body = { ...identity, ...settings, provider, newAttemptOf: previous };
  const results = await Promise.all([
    call("request", { ...body, attemptKey: "11111111-1111-4111-8111-111111111111" }),
    call("request", { ...body, attemptKey: "22222222-2222-4222-8222-222222222222" }, { principal: second }),
  ]);
  expect(results.map(value => value.statusCode)).toEqual([200, 200]);
  expect(results.map(value => value.body.cached).sort()).toEqual([false, true]);
  const id = results[0].body.transcript.id;
  expect(results[1].body.transcript.id).toBe(id);
  if (provider === "amazon-transcribe") {
    const claim = await jobs.claimTranscript(firestore, ref(id), source);
    const budget = (await firestore.collection("mediaTranscriptionBudgets").doc(`global-${claim.amazonBudgetReservation.day}`).get()).data();
    expect(budget).toMatchObject({ consumedSubmissions: 1, consumedAudioSeconds: 60 });
  }
});

it("reuses a ready local result without createdAt before another provider's active slot", async () => {
  const previous = await uncertain();
  const local = await call("request", { ...identity, ...settings, provider: "local", newAttemptOf: previous });
  const localId = local.body.transcript.id;
  const ready = (await ref(localId).get()).data();
  delete ready.createdAt;
  await ref(localId).set({ ...ready, phase: "ready", active: false });
  const amazon = await call("request", { ...identity, ...settings, provider: "amazon-transcribe", newAttemptOf: localId });
  expect(amazon.statusCode).toBe(200);
  const cached = await call("request", { ...identity, ...settings, provider: "local", newAttemptOf: localId,
    attemptKey: "11111111-1111-4111-8111-111111111111" });
  expect(cached.statusCode).toBe(200); expect(cached.body.cached).toBe(true);
  expect(cached.body.transcript.id).toBe(localId);
  expect((await ref(amazon.body.transcript.id).get()).data()).toMatchObject({ provider: "amazon-transcribe", active: true });
});

it("admits one free retry when the same predecessor races with different recognition settings", async () => {
  const previous = await uncertain();
  const results = await Promise.all([
    call("request", { ...identity, languageCode: "en-US", maxSpeakers: 9, provider: "local", newAttemptOf: previous,
      attemptKey: "11111111-1111-4111-8111-111111111111" }),
    call("request", { ...identity, languageCode: "es-US", maxSpeakers: 10, provider: "local", newAttemptOf: previous,
      attemptKey: "22222222-2222-4222-8222-222222222222" }),
  ]);
  expect(results.map(value => value.statusCode).sort()).toEqual([200, 429]);
  expect(results.find(value => value.statusCode === 429)?.body.error)
    .toBe("A free transcript retry is already active for this earlier request");
  const rows = await firestore.collection(jobs.TRANSCRIPT_JOBS).where("requestedProvider", "==", "local").get();
  expect(rows.size).toBe(1);
});

it("allows only one active free retry per staff member across predecessors", async () => {
  const previous = await uncertain();
  const otherPrevious = "f".repeat(64);
  await ref(otherPrevious).set({ ...(await ref(previous).get()).data(), id: otherPrevious, phase: "failed", active: false });
  const admitted = await call("request", { ...identity, ...settings, provider: "local", newAttemptOf: previous,
    attemptKey: "11111111-1111-4111-8111-111111111111" });
  expect(admitted.statusCode).toBe(200);
  const blocked = await call("request", { ...identity, languageCode: "es-US", maxSpeakers: 9,
    provider: "local", newAttemptOf: otherPrevious, attemptKey: "22222222-2222-4222-8222-222222222222" });
  expect(blocked.statusCode).toBe(429);
  expect(blocked.body.error).toBe("You already have an active free transcript retry");
});

it("caps free retries at five per UTC day after active and ready cache reuse", async () => {
  const previous = await uncertain();
  let fifth;
  for (let index = 0; index < 5; index++) {
    const result = await call("request", { ...identity, languageCode: "en-US", maxSpeakers: index + 2,
      provider: "local", newAttemptOf: previous,
      attemptKey: `${String(index + 1).repeat(8)}-${String(index + 1).repeat(4)}-4${String(index + 1).repeat(3)}-8${String(index + 1).repeat(3)}-${String(index + 1).repeat(12)}` });
    expect(result.statusCode).toBe(200);
    fifth = result.body.transcript;
    if (index < 4) await ref(result.body.transcript.id).update({ active: false, phase: "failed" });
  }
  const activeCache = await call("request", { ...identity, languageCode: "en-US", maxSpeakers: 6,
    provider: "local", newAttemptOf: previous, attemptKey: "66666666-6666-4666-8666-666666666666" });
  expect(activeCache.statusCode).toBe(200); expect(activeCache.body.cached).toBe(true);
  expect(activeCache.body.transcript.id).toBe(fifth.id);
  await ref(fifth.id).update({ active: false, phase: "ready" });
  const readyCache = await call("request", { ...identity, languageCode: "en-US", maxSpeakers: 6,
    provider: "local", newAttemptOf: previous, attemptKey: "77777777-7777-4777-8777-777777777777" });
  expect(readyCache.statusCode).toBe(200); expect(readyCache.body.cached).toBe(true);
  expect(readyCache.body.transcript.id).toBe(fifth.id);
  const blocked = await call("request", { ...identity, languageCode: "en-US", maxSpeakers: 7,
    provider: "local", newAttemptOf: previous, attemptKey: "88888888-8888-4888-8888-888888888888" });
  expect(blocked.statusCode).toBe(429);
  expect(blocked.body.error).toBe("You have reached five free transcript retries today");
});

it.each([undefined, "local"])("keeps initial local requests outside free retry counters (provider %s)", async (provider) => {
  const initial = await call("request", { ...identity, ...settings, ...(provider ? { provider } : {}) });
  expect(initial.statusCode).toBe(200);
  expect((await firestore.collection("mediaSourceTranscriptFreeRetryLimits").get()).size).toBe(0);
});

it.each(["offline", "failed"])("never routes an initial explicit local request to a paid provider when the worker is %s", async (failure) => {
  const initial = await call("request", { ...identity, ...settings, provider: "local" });
  expect(initial.statusCode).toBe(200);
  const jobRef = ref(initial.body.transcript.id);
  const job = (await jobRef.get()).data();
  expect(job).toMatchObject({ provider: "local", requestedProvider: "local", processingPolicy: "local-first-v1" });
  const now = Date.parse(job.createdAt);
  if (failure === "offline") {
    await localWorker.routeLocalFallback({ firestore, ref: jobRef, source, now: now + 120_001, fallbackEnabled: true });
  } else {
    const claimed = await localWorker.claimLocalJob({ firestore, source, now });
    await localWorker.failLocalJob({ firestore, source, now: now + 1, fallbackEnabled: true,
      request: { jobId: job.id, leaseToken: claimed.localLeaseToken, errorCode: "local_processing_failed" } });
  }
  expect((await jobRef.get()).data()).toMatchObject({ provider: "local", requestedProvider: "local", phase: "needs_reconciliation", active: false });
  expect((await jobRef.get()).data().paidFallbackState).toBeUndefined();
  expect((await firestore.collection(jobs.TRANSCRIPT_JOBS).get()).size).toBe(1);
  expect((await firestore.collection("mediaSourceTranscriptFreeRetryLimits").get()).size).toBe(0);
});

it.each([{ enabled: false }, { localEnabled: false }])("refuses an initial local-only request when its deployed switches are off (%o)", async (switches) => {
  const result = await call("request", { ...identity, ...settings, provider: "local" }, { configuration: { ...config, ...switches } });
  expect(result.statusCode).toBe(503);
  expect((await firestore.collection(jobs.TRANSCRIPT_JOBS).get()).size).toBe(0);
});

it("fails closed when a free retry counter is malformed", async () => {
  const previous = await uncertain();
  const actorRecord = createHash("sha256").update(JSON.stringify(["free-transcript-retry-actor-v1", actor.uid])).digest("hex");
  await firestore.collection("mediaSourceTranscriptFreeRetryLimits").doc(actorRecord)
    .set({ kind: "actor", day: "2026-10-28", count: "five", activeId: "f".repeat(64) });
  const result = await call("request", { ...identity, ...settings, provider: "local", newAttemptOf: previous });
  expect(result.statusCode).toBe(503);
  expect(result.body.error).toBe("Free transcript retry limits need an administrator's check");
});

it("reuses already-active paid work when no attempt slot was recorded", async () => {
  const previous = await uncertain();
  const existing = await call("request", { ...identity, ...settings, provider: "amazon-transcribe", newAttemptOf: previous });
  expect(existing.statusCode).toBe(200);
  // Model an in-flight job admitted before source/settings slot records existed.
  const slots = await firestore.collection("mediaSourceTranscriptAttempts").get();
  expect(slots.size).toBe(1);
  await slots.docs[0].ref.delete();
  const second = { ...actor, uid: "second-staff" };
  await firestore.collection("users").doc(second.uid).set({ active: true, grants: [{ role: "staff" }] });
  const result = await call("request", { ...identity, ...settings, provider: "amazon-transcribe", newAttemptOf: previous,
    attemptKey: "11111111-1111-4111-8111-111111111111" }, { principal: second });
  expect(result.statusCode).toBe(200); expect(result.body.cached).toBe(true);
  expect(result.body.transcript.id).toBe(existing.body.transcript.id);
});

it.each(["local", "amazon-transcribe"])("rejects provider-only %s admission while another job is active", async provider => {
  const initial = await call("request", { ...identity, ...settings });
  const before = await firestore.collection(jobs.TRANSCRIPT_JOBS).get();
  const result = await call("request", { ...identity, ...settings, provider });
  expect(initial.statusCode).toBe(200); expect(result.statusCode).toBe(provider === "local" ? 409 : 400);
  expect((await firestore.collection(jobs.TRANSCRIPT_JOBS).get()).size).toBe(before.size);
  expect((await ref(initial.body.transcript.id).get()).data()).toMatchObject({ active: true });
});

it.each([true, false])("prevents a default request from duplicating initial local-only work (local enabled %s)", async localEnabled => {
  const initial = await call("request", { ...identity, ...settings, provider: "local" });
  const result = await call("request", { ...identity, ...settings }, { configuration: { ...config, localEnabled } });
  expect(initial.statusCode).toBe(200);
  expect(result.statusCode).toBe(localEnabled ? 200 : 409);
  if (localEnabled) {
    expect(result.body.cached).toBe(true);
    expect(result.body.transcript.id).toBe(initial.body.transcript.id);
  }
  const all = await firestore.collection(jobs.TRANSCRIPT_JOBS).get();
  expect(all.size).toBe(1);
  expect(all.docs[0].data()).toMatchObject({ active: true, provider: "local", requestedProvider: "local", processingPolicy: "local-first-v1" });
});

it("shows an active Amazon parent after its newer ElevenLabs child fails preparation", async () => {
  const key = credentials.credentialIdentity(actor, { scope: "organization", provider: "elevenlabs" });
  await firestore.collection(credentials.CREDENTIAL_COLLECTION).doc(key.id).set({ ...key, enabled: true, revision: 1 });
  const parent = await call("request", { ...identity, ...settings }, { configuration: { ...config, localEnabled: false } });
  expect(parent.statusCode).toBe(200);
  const id = parent.body.transcript.id, started = Date.now() + 1000;
  const route = now => fallback.routePaidFallback({ firestore, ref: ref(id), source,
    settings: { ...config, amazonFallbackEnabled: true }, admit: byok.admit, now });
  await route(started);
  const childId = (await ref(id).get()).data().fallbackTranscriptId;
  expect(childId).toMatch(/^[a-f0-9]{64}$/);
  for (let attempt = 0; attempt < 3; attempt++) {
    const now = started + attempt * 120001;
    const claim = await paidJobs.claimJob({ firestore, id: childId, validateCurrent: async () => true, now });
    expect(claim).not.toBeNull();
    await paidJobs.deferPreparation({ firestore, claim, now });
  }
  await route(started + 360003);
  expect((await ref(id).get()).data()).toMatchObject({ active: true, phase: "pending", paidFallbackState: "amazon" });
  const status = await call("get", { ...identity, ...settings });
  expect(status.statusCode).toBe(200);
  expect(status.body.transcript).toMatchObject({ id, state: "queued", processing: { provider: "amazon-transcribe" } });
  const history = await call("get", { ...identity, transcriptId: childId });
  expect(history.body.transcript).toMatchObject({ id: childId, state: "failed" });
});
