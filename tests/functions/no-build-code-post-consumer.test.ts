import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import consumer from "../../functions/lib/no-build-code-post-consumer.js";
import deployment from "../../functions/lib/public-deployment.js";
import { schedulePacketFixture } from "./page-schedule-packet-fixture";
import postFixture from "../../site/tests/fixtures/shadow-posts/post.json";
import { createNoBuildCodePostWorker } from "../../workers/src/no-build-code-post-worker";
import { publicationTarget } from "../../functions/lib/publication-target.js";

const rendererSha = "a".repeat(40), path = "/posts/shadow-fixture/";
const app = initializeApp({ projectId: "njpbs-site-dev" }, "code-post-local-fixture");
const db = getFirestore(app);
let boundary: Awaited<ReturnType<typeof schedulePacketFixture>> | undefined;
function post() {
  const value: any = structuredClone(postFixture.document);
  value.version = 9;
  value.published.metadata.previousSlugs = ["old-fixture"];
  value.published.blocks.push({ id: "newsletter", type: "record_card", visible: true, order: 1,
    data: { recordKind: "newsletter", recordId: "newsletter-one" } });
  return value;
}
async function fixture(document = post()) {
  await db.doc("cmsPosts/shadow-fixture").set(document);
  boundary = await schedulePacketFixture({ firestore: db, rendererSha, generation: 3,
    attachExternalInputs: false, postDocuments: [{ ...document, id: "shadow-fixture" }] });
  await db.doc("system/publicDeployment").set({ ...deployment.initialPublicDeploymentPointer(), activeGeneration: 3,
    activeCommitSha: rendererSha, activeDeploymentId: "code-post-fixture", lastReservedGeneration: 3,
    newestEligibleGeneration: 3, newestEligibleBuildBatchId: boundary.reference.publication.buildBatchId });
  const approved = { type: "newsletter", status: "approved", version: 7, deleted: false,
    title: "Approved newsletter", signupUrl: "https://example.test/signup" };
  await db.doc("cmsPosts/newsletter-one").set({ ...approved, status: "draft", version: 9, title: "Private working newsletter" });
  await db.doc("cmsVersionHistory/newsletter-approval").set({ collection: "cmsPosts", documentId: "newsletter-one", action: "approve", after: approved });
  return () => consumer.readCodePostConsumer({ firestore: db, path, rendererSha, currentCodeRequest: boundary!.request });
}
beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") ||
      process.env.GCLOUD_PROJECT !== "demo-njpbs") throw new Error("Use the local demo Firestore emulator.");
});
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/njpbs-site-dev/databases/(default)/documents`, { method: "DELETE" });
  await db.doc("system/publicDeployment/contexts/public").set({ schemaVersion: 1, revision: 4 });
});
afterEach(async () => { await boundary?.close(); boundary = undefined; });
afterAll(async () => { await deleteApp(app); });

it("qualifies current code and refreshes approved cards through the ordinary Worker contract", async () => {
  const read = await fixture();
  const decision = await read();
  expect(decision).toMatchObject({ kind: "code-post", receipt: { sourceVersion: 7, contextRevision: 4 } });
  expect(JSON.stringify(decision.published.joinedRecords)).not.toContain("Private working newsletter");
  const worker = createNoBuildCodePostWorker({ rendererSha, target: publicationTarget("development"),
    getDecision: async requested => consumer.readCodePostConsumer({ firestore: db, path: requested, rendererSha, currentCodeRequest: boundary!.request }),
    readWithdrawal: async () => null, render: async content => `<!doctype html><html><title>${content.posts[0].title}</title><main>${content.recordCards?.[0]?.title}</main></html>` });
  const response = (await worker.fetch(new Request("https://dev-public.example.org" + path)))!;
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("Approved newsletter");
  await db.doc("cmsVersionHistory/newsletter-new-approval").set({ collection: "cmsPosts", documentId: "newsletter-one", action: "approve",
    after: { type: "newsletter", status: "approved", version: 8, deleted: false, title: "Next approved newsletter", signupUrl: "https://example.test/signup" } });
  await db.doc("system/publicDeployment/contexts/public").update({ revision: 5 });
  const next = await read();
  expect(next.receipt.inputSourceDigest).not.toBe(decision.receipt.inputSourceDigest);
  expect(next.codeFrame).toEqual(decision.codeFrame);
  expect(next.published.joinedRecords[0].approvedLibraryVersion.title).toBe("Next approved newsletter");
  // The code bytes are immutable; current reference and Firestore authority
  // are still qualified for every capture, including the render's second read.
  expect(boundary!.codeReads()).toBe(1);
  expect(boundary!.referenceReads()).toBeGreaterThanOrEqual(8);
});

it("retains legacy published visibility without omitting the frozen body", async () => {
  const document = post();
  document.status = "published";
  document.publishAt = document.published.publishedAt;
  delete document.publiclyVisible;
  const read = await fixture(document);
  const result = await read();
  expect(result.kind).toBe("code-post");
  expect(result.published.document.published.blocks).toHaveLength(2);
});

it("preserves retained aliases and omits withdrawn approved cards", async () => {
  await fixture();
  const alias = await consumer.readCodePostConsumer({ firestore: db, path: "/posts/old-fixture/", rendererSha, currentCodeRequest: boundary!.request });
  expect(alias).toMatchObject({ kind: "code-post-alias", location: path, receipt: { sourceVersion: 7 } });
  await db.doc("cmsPosts/newsletter-one").delete();
  const result = await consumer.readCodePostConsumer({ firestore: db, path, rendererSha, currentCodeRequest: boundary!.request });
  expect(result.published.joinedRecords).toEqual([]);
});

it("refuses moved code authority and forged captures", async () => {
  await fixture();
  const capture = await consumer.captureCodePostConsumers({ firestore: db, rendererSha, request: boundary!.request });
  await db.doc("system/publicDeployment").update({ activeCommitSha: "b".repeat(40) });
  await expect(db.runTransaction(transaction => consumer.readCodePostConsumerInTransaction({ firestore: db, transaction,
    path, rendererSha, capture }), { readOnly: true })).rejects.toThrow("code Post context");
  await expect(db.runTransaction(transaction => consumer.readCodePostConsumerInTransaction({ firestore: db, transaction,
    path, rendererSha, capture: {} }), { readOnly: true })).rejects.toThrow("code Post context");
});

it("leaves Posts without joined cards with their existing reader", async () => {
  const value = post();
  value.published.blocks.pop();
  await db.doc("cmsPosts/shadow-fixture").set(value);
  expect(await consumer.readCodePostConsumer({ firestore: db, path, rendererSha })).toEqual({ kind: "pass" });
});

it.each([true, false])("refreshes a static story with global end rules, including enabled=%s", async enabled => {
  const document = post(); document.published.blocks.pop();
  const read = await fixture(document);
  const rule = { id: "donate", label: "Support reporting", enabled, target: { contentTypes: ["post"] },
    position: { kind: "end" }, content: { type: "support_appeal", data: { heading: "Support reporting", copy: "Your gift helps.",
      buttonLabel: "Donate", href: "https://example.org/donate", style: "blue" } } };
  await db.doc("cmsSettings/story-ctas").set({ version: 1, schemaVersion: 1, values: { rules: [] },
    published: { schemaVersion: 1, sourceVersion: 1, publishedAt: "2026-10-07T12:00:00.000Z", values: { rules: [rule] } } });
  const decision = await read();
  expect(decision.kind).toBe("code-post");
  expect(decision.published.document.published.blocks).toHaveLength(1);
  expect(decision.published.settings.find((setting: any) => setting.id === "story-ctas").published.values.rules[0].enabled).toBe(enabled);
});

it("logs fixed refusal classes without copying private transport details", async () => {
  await fixture();
  const warnings: unknown[] = [];
  const reply = await consumer.readCodePostConsumer({ firestore: db, path, rendererSha,
    currentCodeRequest: async () => { throw new Error("PRIVATE transport URL and token"); },
    log: { warn: (...args: unknown[]) => warnings.push(args) } });
  expect(reply).toEqual({ kind: "code-post-unavailable" });
  expect(warnings).toEqual([["Code Post qualification refused", { path, stage: "capture", reason: "context_unavailable", status: 503 }]]);
  expect(JSON.stringify(warnings)).not.toContain("PRIVATE");
});

it.each(["missing", "paused", "other-release"])("qualifies CODE Post cards when the unrelated Page capability is %s", async mode => {
  const read = await fixture();
  const capability = db.doc("system/publicDeployment/noBuildPages/capability");
  if (mode === "missing") await capability.delete();
  if (mode === "paused") await capability.update({ servingEnabled: false });
  if (mode === "other-release") await capability.update({ rendererSha: "b".repeat(40) });
  expect(await read()).toMatchObject({ kind: "code-post", receipt: { sourceVersion: 7, rendererSha },
    published: { joinedRecords: [{ id: "newsletter-one" }] } });
});
