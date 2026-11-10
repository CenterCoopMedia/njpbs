import { isolatedFirestore } from "../helpers/emulator-firestore.js";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import contract from "../../functions/lib/video-transcript-contract.js";
import jobs from "../../functions/lib/video-transcript-job.js";
import processorModule from "../../functions/lib/video-transcript-processor.js";
import sources from "../../functions/lib/media-sources.js";
import principals from "../../functions/lib/principal.js";
import handlers from "../../functions/video-transcripts.js";

const source = { id: "video-library", bucket: "originals", prefix: "", writable: true, access: "active_staff" };
const config = { source, bucket: "renditions", accountId: "123456789012", controlRoleArn: "role", dataRoleArn: "data-role", region: "us-east-2" };
const segments = [{ text: "Original", speaker: "spk_0", startSeconds: 1, endSeconds: 2 }];
const revocations = [
  { name: "last top-level role", profile: { active: true, role: "admin" }, update: { role: null } },
  { name: "last staff grant", profile: { active: true, grants: [{ role: "staff" }] }, update: { grants: [] } },
];
let firestore, actor, request, job, userRef, assetRef, jobRef, sectionRef;

beforeAll(() => {
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "")) {
    throw new Error("Transcript edit admission tests require a loopback Firestore emulator");
  }
  firestore = isolatedFirestore("video-transcript-edit-admission.test.js");
});

beforeEach(async () => {
  const id = randomUUID();
  actor = { uid: `staff-${id}`, email: "staff@example.test", principal: { grants: [{ role: "staff" }] } };
  request = contract.parseTranscriptRequest({ sourceId: source.id, assetId: `asset-${id}` });
  const asset = { sourceId: source.id, objectKey: `objects/${id}.mp4`, objectVersionId: "original-v1", sizeBytes: 100,
    lifecycle: "active", name: "Video", originalName: "video.mp4", nameSort: "video", updatedAtSort: "2026-09-15T12:00:00Z",
    mimeType: "video/mp4", kind: "video", version: 1, preview: "download_only", rightsStatus: "complete", tags: [] };
  job = { id: contract.transcriptId(asset, source.bucket, request), assetId: request.assetId, sourceId: source.id,
    sourceBucket: source.bucket, sourceObjectKey: asset.objectKey, sourceObjectVersionId: asset.objectVersionId,
    sourceSizeBytes: asset.sizeBytes, languageCode: request.languageCode, maxSpeakers: request.maxSpeakers,
    phase: "ready", active: false, editRevision: 0, totalSegments: 1,
    outputs: { "segments.json": "original-segments", txt: "original-txt", vtt: "original-vtt" } };
  userRef = firestore.collection("users").doc(actor.uid);
  assetRef = firestore.collection("mediaSourceAssets").doc(request.assetId);
  jobRef = firestore.collection(jobs.TRANSCRIPT_JOBS).doc(job.id);
  sectionRef = firestore.collection("sections").doc(`section-${id}`);
  await Promise.all([userRef.set({ active: true, grants: [{ role: "staff" }] }), assetRef.set(asset), jobRef.set(job)]);
});

async function editAudits() {
  return firestore.collection("admin_logs").where("target", "==", jobRef.path).get();
}

afterEach(async () => {
  const audits = await editAudits();
  await Promise.all([userRef.delete(), assetRef.delete(), jobRef.delete(), sectionRef.delete(), ...audits.docs.map(doc => doc.ref.delete())]);
});

function storage(afterWrite = async () => {}) {
  const objects = new Map([[`${processorModule.resultKey(job, "segments.json")}/original-segments`, JSON.stringify(segments)]]);
  let version = 0;
  const s3 = { send: async command => {
    const { Key, VersionId, Body } = command.input;
    if (command.constructor.name === "GetObjectCommand") {
      const body = objects.get(`${Key}/${VersionId}`);
      if (body === undefined) throw new Error("Stored transcript version not found");
      return { Body: Readable.from([body]), ContentLength: Buffer.byteLength(body) };
    }
    if (command.constructor.name !== "PutObjectCommand") throw new Error("Unexpected storage request");
    const savedVersion = `edited-${++version}`;
    objects.set(`${Key}/${savedVersion}`, Body);
    await afterWrite();
    return { VersionId: savedVersion };
  } };
  const processor = processorModule.createVideoTranscriptProcessor(config, { firestore, s3,
    credentials: async () => ({}), transcribe: { send: async () => { throw new Error("Unexpected paid transcription request"); } } });
  return { objects, processor };
}

async function edit(processor) {
  const handler = handlers.createTranscriptHandler("edit", { firestore, processor,
    registryFn: () => new Map([[source.id, source]]), configFn: () => config,
    verifyAppCheckFn: async () => {}, requirePrincipalFn: async () => actor });
  const response = { statusCode: 0, set() {}, status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; } };
  await handler({ method: "POST", headers: { "content-type": "application/json" },
    body: { ...request, revision: 0, segments: [{ index: 0, text: "Corrected" }] } }, response);
  return response;
}

async function revoke(state) {
  if (state === "deactivated") await userRef.update({ active: false });
  else await userRef.delete();
}

describe("transcript edit staff admission at commit", () => {
  it.each(["deactivated", "deleted"])("does not commit when staff is %s during private export writes", async state => {
    const { processor, objects } = storage(() => revoke(state));
    const result = await edit(processor);
    expect([...objects.values()].some(body => body.includes("Corrected"))).toBe(true);
    expect(result.statusCode).toBe(403);
    expect(result.body).toEqual({ error: "Transcript access denied" });
    expect((await jobRef.get()).data()).toEqual(job);
    expect((await editAudits()).size).toBe(0);
  });

  it.each(["deactivated", "deleted"])("does not mark a transcript reviewed after admitted staff is %s", async state => {
    await sources.authorizeMediaSource({ firestore, actor, source, operation: "transcript" });
    await revoke(state);
    const review = contract.parseTranscriptEdit({ ...request, revision: 0, reviewed: true });
    await expect(jobs.commitTranscriptEdit({ firestore, source, request: review, job, actor }))
      .rejects.toMatchObject({ status: 403, message: "Transcript access denied" });
    expect((await jobRef.get()).data()).toEqual(job);
    expect((await editAudits()).size).toBe(0);
  });

  it.each(revocations)("does not commit when the $name is revoked during private export writes", async ({ profile, update }) => {
    await userRef.set(profile);
    actor.principal = principals.principalFromUserDoc(actor.uid, profile);
    const { processor, objects } = storage(() => userRef.update(update));
    const result = await edit(processor);
    expect([...objects.values()].some(body => body.includes("Corrected"))).toBe(true);
    expect((await userRef.get()).data()).toEqual({ ...profile, ...update });
    expect(result.statusCode).toBe(403);
    expect(result.body).toEqual({ error: "Transcript access denied" });
    expect((await jobRef.get()).data()).toEqual(job);
    expect((await editAudits()).size).toBe(0);
  });

  it.each(revocations)("does not mark a transcript reviewed after the $name is revoked", async ({ profile, update }) => {
    await userRef.set(profile);
    actor.principal = principals.principalFromUserDoc(actor.uid, profile);
    await sources.authorizeMediaSource({ firestore, actor, source, operation: "transcript" });
    await userRef.update(update);
    const review = contract.parseTranscriptEdit({ ...request, revision: 0, reviewed: true });
    await expect(jobs.commitTranscriptEdit({ firestore, source, request: review, job, actor }))
      .rejects.toMatchObject({ status: 403, message: "Transcript access denied" });
    expect((await userRef.get()).data()).toEqual({ ...profile, ...update });
    expect((await jobRef.get()).data()).toEqual(job);
    expect((await editAudits()).size).toBe(0);
  });

  it.each([
    { name: "registered", removed: false, status: 200 },
    { name: "removed during private export writes", removed: true, status: 403 },
  ])("rechecks scoped video access when its area is $name", async ({ removed, status }) => {
    await sectionRef.set({ label: "Fixture area" });
    const profile = { active: true, grants: [{ role: "editor", sections: [sectionRef.id] }] };
    await userRef.set(profile);
    actor.principal = await principals.registeredPrincipalFromUserDoc(firestore, actor.uid, profile);
    const { processor } = storage(removed ? () => sectionRef.delete() : undefined);
    const result = await edit(processor);
    expect(result.statusCode).toBe(status);
    if (removed) {
      expect((await jobRef.get()).data()).toEqual(job);
      expect((await editAudits()).size).toBe(0);
    } else {
      expect((await jobRef.get()).data()).toMatchObject({ editRevision: 1, editedBy: actor.uid });
      expect((await editAudits()).size).toBe(1);
    }
  });

  it.each([{ active: true }, {}])("keeps edits available for an admitted staff record %j", async profile => {
    await userRef.set({ ...profile, grants: [{ role: "staff" }] });
    const { processor, objects } = storage();
    const result = await edit(processor);
    expect(result.statusCode).toBe(200);
    expect(result.body.transcript).toMatchObject({ editRevision: 1, segments: [{ ...segments[0], text: "Corrected", index: 0 }] });
    const saved = (await jobRef.get()).data();
    expect(saved).toMatchObject({ editRevision: 1, editedBy: actor.uid, outputs: job.outputs });
    expect(JSON.parse(objects.get(`${processorModule.editedResultKey(job, "segments.json")}/${saved.editedOutputs["segments.json"]}`)))
      .toEqual([{ ...segments[0], text: "Corrected" }]);
    const audits = await editAudits();
    expect(audits.size).toBe(1);
    expect(audits.docs[0].data()).toMatchObject({ actorUid: actor.uid, action: "media.transcript.edit", after: { editRevision: 1 } });
  });
});

describe("shared transcript changes after staff tier activation", () => {
  const activation = () => firestore.doc("system/staffAccessActivation");
  beforeEach(() => activation().set({ schema: 1, state: "active", cleanScan: true }));
  afterEach(() => activation().delete());

  it("a Viewer reads video but cannot request, edit or review a shared transcript", async () => {
    const profile = { active: true, accessTier: "viewer", role: "super_admin", grants: [{ role: "editor" }] };
    await userRef.set(profile);
    actor.principal = await principals.principalFromStoredUserDoc(firestore, actor.uid, profile);
    await expect(sources.authorizeMediaSource({ firestore, actor, source, operation: "browse" })).resolves.toBe(true);
    await expect(sources.authorizeMediaSource({ firestore, actor, source, operation: "transcript" }))
      .rejects.toMatchObject({ status: 403 });
    const { processor, objects } = storage();
    expect((await edit(processor)).statusCode).toBe(403);
    const review = contract.parseTranscriptEdit({ ...request, revision: 0, reviewed: true });
    await expect(jobs.commitTranscriptEdit({ firestore, source, request: review, job, actor }))
      .rejects.toMatchObject({ status: 403, message: "Transcript access denied" });
    expect([...objects.values()].some(body => body.includes("Corrected"))).toBe(false);
    expect((await jobRef.get()).data()).toEqual(job);
    expect((await editAudits()).size).toBe(0);
  });

  it("a Contributor can edit a shared transcript", async () => {
    const profile = { active: true, accessTier: "contributor" };
    await userRef.set(profile);
    actor.principal = await principals.principalFromStoredUserDoc(firestore, actor.uid, profile);
    const result = await edit(storage().processor);
    expect(result.statusCode).toBe(200);
    expect((await jobRef.get()).data()).toMatchObject({ editRevision: 1, editedBy: actor.uid });
    expect((await editAudits()).size).toBe(1);
  });
});
