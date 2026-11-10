import { enrollPublicReleaseLog, publicReleaseEntries } from "../helpers/public-release-producer.js";
import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import "../../functions/lib/firebase.js";
import { createCmsTransitionContentHandler } from "../../functions/lifecycle-transition.js";
import { createCmsSaveHandler } from "../../functions/save.js";
import { publicationMetadata } from "../../functions/get-content.js";
import { initialPublicDeploymentPointer } from "../../functions/lib/public-deployment.js";
import cards from "../../functions/lib/no-build-library-card-publication.js";
import { exportRecordCards } from "../../site/src/lib/record-card-resolution";
import { approvedLibraryRecord } from "../../site/tests/fixtures/approved-library-record";
const db = isolatedFirestore("library-card-publication.test.ts");

const release = "a".repeat(40);
const at = "2026-10-23T16:00:00.000Z";
const actor = { uid: "editor", email: "editor@example.test", principal: { id: "editor", grants: [{ role: "admin" }] } };
const quiet = { warn() {}, error() {}, info() {} };
const rich = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Approved newsletter summary" }] }] };
const fields = {
  newsletter: { title: "Approved newsletter", body: rich, signupUrl: "https://example.test/join", frequency: "Weekly" },
  sponsor: { name: "Approved sponsor", href: "https://example.test/supporter", tier: "Partner", description: "Station support" },
};
const document = (kind: keyof typeof fields) => ({ id: kind, type: kind, ...fields[kind], status: "in_review", version: 2,
  section: "news", createdBy: actor.uid, privateNotes: "Private note", publiclyVisible: false });
async function invoke(kind: string, action = "approve", baseVersion = 2, user = actor) {
  const res = { statusCode: 0, body: null as any, headersSent: false,
    status(code: number) { this.statusCode = code; return this; },
    json(value: unknown) { this.body = value; this.headersSent = true; return this; } };
  await createCmsTransitionContentHandler({ firestore: db, requirePrincipalFn: async () => user, now: () => at, log: quiet })(
    { method: "POST", headers: {}, body: { collection: "cmsPosts", id: kind, action, baseVersion } }, res);
  return res;
}
async function state() {
  const names = ["cmsPosts", "cmsVersionHistory", "admin_logs", "cmsPublishQueue"];
  return Promise.all(names.map(async name => (await db.collection(name).get()).docs.map(row => row.data())));
}
beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") ||
      !/^demo-njpbs(?:-[a-z0-9-]+)?$/.test(process.env.GCLOUD_PROJECT ?? "")) throw new Error("Use a local demo Firestore emulator.");
});
beforeEach(async () => {
  const reset = await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${process.env.GCLOUD_PROJECT}/databases/(default)/documents`, { method: "DELETE" }, db);
  expect(reset.ok).toBe(true);
  await db.doc("system/publicDeployment").set({ ...initialPublicDeploymentPointer(), activeGeneration: 1,
    activeDeploymentId: "11111111-1111-4111-8111-111111111111", activeCommitSha: release, lastReservedGeneration: 1,
    newestEligibleGeneration: 1, newestEligibleBuildBatchId: "baseline" });
  await db.doc("system/publicDeployment/contexts/public").set({ schemaVersion: 1, revision: 7 });
  await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: "ready", commitSha: release, serializerId: "cloudflare-publisher" });
  await db.doc("sections/news").set({ label: "News", order: 1 });
  for (const kind of ["sponsor", "newsletter"] as const) await db.doc(`cmsPosts/${kind}`).set(document(kind));
});

describe("build-free approved library publication", () => {
  it("retains the existing publication metadata defaults for an unversioned library import", async () => {
    const imported = { type: "newsletter", ...fields.newsletter };
    await db.doc("cmsPosts/newsletter").set(imported);
    expect(await publicationMetadata(db, imported, "cmsPosts", "newsletter")).toMatchObject({
      workingVersion: null, contentVersion: null, workingStatus: "draft",
      publishedSourceVersion: null, publiclyVisible: false, publicUpdatePending: false,
    });
  });

  it.each(["sponsor", "newsletter"] as const)("atomically publishes %s approval through context work and preserves full-build card output", async kind => {
    const response = await invoke(kind);
    expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
    const queueId = response.body.publication.queueId;
    const row = (await db.doc(`cmsPublishQueue/${queueId}`).get()).data()!;
    expect(row).toMatchObject({ transport: "public-context-no-build-v1", changes: [], status: "pending",
      libraryCardPublication: { kind, action: "approve", sourceVersion: 3, contextRevision: 8, withdrawal: false } });
    expect((await db.collection(`cmsPublishQueue/${queueId}/backgroundOutputs`).get()).size).toBe(6);
    expect((await db.doc("system/publicDeployment/contexts/public").get()).data()?.revision).toBe(8);
    const stored = (await db.doc(`cmsPosts/${kind}`).get()).data()!;
    const history = (await db.collection("cmsVersionHistory").get()).docs.map(row => row.data());
    expect(history).toHaveLength(1);
    expect((await db.collection("admin_logs").get()).size).toBe(1);
    const { shapeJoinedRecord } = await import("../../functions/lib/joined-records.js");
    const projection = shapeJoinedRecord(kind, stored, history);
    // Characterization oracle: the unchanged full-build export and approved
    // fixture contract from main 67944c300, before this publication owner.
    const fullBuild = exportRecordCards([approvedLibraryRecord({ id: kind, type: kind, ...fields[kind], status: "approved", version: 3 })], [], new Date(at));
    expect(fullBuild).toHaveLength(1);
    expect(exportRecordCards([projection], [], new Date(at))).toEqual(fullBuild);
    expect(JSON.stringify(projection)).not.toContain("Private note");
    expect((await db.doc(`cmsPosts/${kind}/mediaUsage/published`).get()).data()).toMatchObject({ sourceVersion: 3 });
  });

  it.each(["sponsor", "newsletter"])("repeats a lost %s approval response without another context/history/queue", async kind => {
    const first = await invoke(kind);
    const before = await state();
    const retry = await invoke(kind);
    expect(retry.statusCode, JSON.stringify(retry.body)).toBe(200);
    expect(retry.body.publication.queueId).toBe(first.body.publication.queueId);
    expect(await state()).toEqual(before);
    expect((await db.doc("system/publicDeployment/contexts/public").get()).data()?.revision).toBe(8);
  });

  it.each(["unpublish", "archive"])("removes approved cards on %s without needing the removed media", async action => {
    await invoke("newsletter");
    await db.doc("cmsPosts/newsletter").update({ imageAssetId: "missing-private-image", imageAlt: "Private image" });
    const response = await invoke("newsletter", action, 3);
    expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
    const queue = (await db.doc(`cmsPublishQueue/${response.body.publication.queueId}`).get()).data();
    expect(response.body.toStatus).toBe(action === "unpublish" ? "draft" : "archived");
    expect(queue?.libraryCardPublication).toMatchObject({ withdrawal: true, sourceVersion: 4, action });
    expect((await publicationMetadata(db, (await db.doc("cmsPosts/newsletter").get()).data(), "cmsPosts", "newsletter"))).toMatchObject({ publiclyVisible: false, publicUpdatePending: true });
    expect((await db.doc("system/publicDeployment/contexts/public").get()).data()?.withdrawalRevision).toBe(1);
  });

  it("keeps private workflow changes outside public context and retries the approved card across a later draft", async () => {
    const first = await invoke("newsletter");
    expect((await invoke("newsletter", "edit", 3)).statusCode).toBe(200);
    const res = { statusCode: 0, body: null as any, headersSent: false,
      status(code: number) { this.statusCode = code; return this; },
      json(value: unknown) { this.body = value; this.headersSent = true; return this; } };
    await createCmsSaveHandler({ firestore: db, requirePrincipalFn: async () => actor, log: quiet })(
      { method: "POST", headers: {}, body: { collection: "cmsPosts", id: "newsletter", baseVersion: 4,
        document: { title: "Private later draft" } } }, res);
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    const metadata = await publicationMetadata(db, (await db.doc("cmsPosts/newsletter").get()).data(), "cmsPosts", "newsletter");
    expect(metadata.publiclyVisible).toBe(true);
    expect(metadata.workingVersion).toBe(5);
    expect((await db.doc("system/publicDeployment/contexts/public").get()).data()?.revision).toBe(8);
    const repeated = await invoke("newsletter");
    expect(repeated.statusCode, JSON.stringify(repeated.body)).toBe(200);
    expect(repeated.body.publication.queueId).toBe(first.body.publication.queueId);
    expect(repeated.body.document.title).toBe("Private later draft");
  });

  it.each(["release", "billing", "cloud"])("refuses %s races before any approval write", async fault => {
    if (fault === "release") await db.doc("system/publicDeployment").update({ state: "deploying" });
    if (fault === "billing") await db.doc("system/billing").set({ disabled: true });
    if (fault === "cloud") await db.doc("system/cmsPublicationRuntime").update({ phase: "paused" });
    const before = await state();
    const response = await invoke("newsletter");
    expect(response.statusCode, JSON.stringify(response.body)).toBe(fault === "cloud" ? 503 : 409);
    expect(await state()).toEqual(before);
    expect((await db.doc("system/publicDeployment/contexts/public").get()).data()?.revision).toBe(7);
  });

  it("rechecks scoped publication permission on a lost-response retry", async () => {
    await invoke("sponsor");
    const outside = { ...actor, principal: { id: actor.uid, grants: [{ role: "editor", sections: ["watch"] }] } };
    const before = await state();
    expect((await invoke("sponsor", "approve", 2, outside)).statusCode).toBe(403);
    expect(await state()).toEqual(before);
  });

  it("creates one successor at a changed public context without approving a newer draft", async () => {
    const first = await invoke("sponsor");
    await db.doc("system/publicDeployment/contexts/public").update({ revision: 9 });
    await db.doc(`cmsPublishQueue/${first.body.publication.queueId}`).update({ status: "cancelled", error: "public_context_superseded" });
    const retry = await invoke("sponsor");
    expect(retry.statusCode, JSON.stringify(retry.body)).toBe(200);
    expect(retry.body.publication.queueId).not.toBe(first.body.publication.queueId);
    expect((await invoke("sponsor")).body.publication.queueId).toBe(retry.body.publication.queueId);
    expect((await db.collection("cmsVersionHistory").get()).size).toBe(1);
    expect((await db.doc("system/publicDeployment/contexts/public").get()).data()?.revision).toBe(9);
  });

  it("does not report success from aggregate completion or mixed-context consumer receipts", async () => {
    const response = await invoke("newsletter");
    const ref = db.doc(`cmsPublishQueue/${response.body.publication.queueId}`);
    const row = (await ref.get()).data()!;
    const identity = row.libraryCardPublication;
    const receipt = { rendererSha: release, contextRevision: 8, contextDigest: identity.contextDigest, verifiedAt: Date.now() };
    await ref.update({ status: "success", aggregateReceipt: { runtime: row.runtime, contextRevision: 8,
      contextDigest: identity.contextDigest, outputs: Object.fromEntries(["listings", "authors", "feed", "contentApi", "sitemap", "search"].map(name => [name, receipt])) } });
    expect(cards.libraryCardReceipt((await ref.get()).data()).missingConsumers).toEqual(["pages", "posts", "home"]);
    await ref.update({ consumerReceipts: { pages: receipt, posts: receipt, home: { ...receipt, contextRevision: 7 } } });
    expect(cards.libraryCardReceipt((await ref.get()).data()).status).toBe("pending");
    await ref.update({ "consumerReceipts.home": receipt });
    expect(cards.libraryCardReceipt((await ref.get()).data()).status).toBe("success");
    await db.doc("system/publicDeployment/contexts/public").update({ revision: 9 });
    await db.doc("system/billing").set({ disabled: true });
    const before = await state();
    const duplicate = await invoke("newsletter");
    expect(duplicate.statusCode, JSON.stringify(duplicate.body)).toBe(200);
    expect(duplicate.body.publication.queueId).toBe(ref.id);
    expect(await state()).toEqual(before);
  });

  it("keeps accepted removal and retry identity through Archive and Restore without another queue", async () => {
    await invoke("newsletter");
    const removal = await invoke("newsletter", "unpublish", 3);
    expect((await invoke("newsletter", "archive", 4)).statusCode).toBe(200);
    expect((await invoke("newsletter", "restore", 5)).statusCode).toBe(200);
    const metadata = await publicationMetadata(db, (await db.doc("cmsPosts/newsletter").get()).data(), "cmsPosts", "newsletter");
    expect(metadata).toMatchObject({ publiclyVisible: false, publicUpdatePending: true,
      libraryCardPublication: { queueId: removal.body.publication.queueId, action: "unpublish", sourceVersion: 4 } });
    expect((await db.collection("cmsPublishQueue").get()).size).toBe(2);
    const accepted = await cards.readLibraryCardPublication({ firestore: db, operationId: removal.body.publication.queueId });
    expect(accepted.publication.withdrawal).toBe(true);
    expect((await invoke("newsletter", "unpublish", 3)).statusCode).toBe(200);
  });

  it("translates moved output ownership into a recoverable card retry refusal", async () => {
    const response = await invoke("newsletter");
    const queueId = response.body.publication.queueId;
    await db.doc(`cmsPublishQueue/${queueId}`).update({ status: "failed" });
    await db.doc("cmsBackgroundOutputs/listings").update({ taskPath: `cmsPublishQueue/${"Z".repeat(20)}/backgroundOutputs/listings` });
    const retry = await invoke("newsletter");
    expect(retry.statusCode, JSON.stringify(retry.body)).toBe(409);
    expect(retry.body.error).toBe("Another publication is updating the public outputs. Try this card update again shortly.");
  });
});

it.each(["sponsor", "newsletter"] as const)("change-log: appends %s approval and withdrawal with history", async kind => {
  await enrollPublicReleaseLog(db, release);
  const approval = await invoke(kind);
  expect(approval.statusCode, JSON.stringify(approval.body)).toBe(200);
  expect((await publicReleaseEntries(db))[0].changes).toMatchObject([{ kind: "library", id: kind, action: "publish", sourceVersion: 3 }]);
  const removal = await invoke(kind, "unpublish", 3);
  expect(removal.statusCode, JSON.stringify(removal.body)).toBe(200);
  expect((await publicReleaseEntries(db))[1].changes).toMatchObject([{ kind: "library", id: kind, action: "withdraw", sourceVersion: 4 }]);
});
