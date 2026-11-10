import { afterAll, beforeAll, expect, it } from "vitest";
import { createRequire } from "node:module";
import { isolatedFirestore } from "../helpers/emulator-firestore.js";
import { publicReleaseR2Fixture } from "../helpers/public-release-r2-fixture";
import { switchedPairFixture } from "../helpers/public-release-switched-pair";
import { rehearsalOperationId } from "../../scripts/lib/public-release-rehearsal.mjs";
import admission from "../../functions/lib/public-release-admission.js";
const family = createRequire(import.meta.url)("../../functions/lib/public-release-family-admission.js");

let binding: Awaited<ReturnType<typeof publicReleaseR2Fixture>>;
let fixture: Awaited<ReturnType<typeof switchedPairFixture>>;
beforeAll(async () => {
  binding = await publicReleaseR2Fixture("rehearsal-native-admission");
  fixture = await switchedPairFixture(isolatedFirestore("rehearsal-native-admission"), binding.store);
}, 120_000);
afterAll(async () => { await fixture?.close(); await binding?.runtime.dispose(); });

it("accepts the harness identity through the actual content owner and retries the same original after a private edit", async () => {
  const { firestore } = fixture;
  const packet = { runId: "native-owner-proof", projectId: firestore.projectId };
  const operationId = rehearsalOperationId(packet, "hold-old");
  expect(rehearsalOperationId(packet, "settle-old")).toBe(operationId);
  expect(rehearsalOperationId(packet, "hold-new")).not.toBe(operationId);
  expect(rehearsalOperationId(packet, "withdraw-after-return")).toBe(rehearsalOperationId(packet, "withdraw"));
  const source = firestore.doc("cmsPosts/story"), queue = firestore.doc(`cmsPublishQueue/${operationId}`);
  const story = (await source.get()).data()!;
  const nextDocument = { ...story, version: story.version + 1, publishBuildPending: true, publishBuildQueueId: operationId,
    published: { ...story.published, sourceVersion: story.version + 1,
      metadata: { ...story.published.metadata, title: "Native rehearsal acceptance" } } };
  const accept = (queueRef = queue) => firestore.runTransaction(async transaction => {
    const prepared = await family.preparePairContentPublication({ firestore, transaction, collection: "cmsPosts", documentId: "story",
      nextDocument, queueRef, actor: { uid: "rehearsal-editor" }, kind: "post", family: "posts" });
    prepared.write();
    if (!prepared.idempotent) transaction.set(source, nextDocument);
    return prepared;
  });
  // The old harness label is deliberately refused by the unchanged owner.
  await expect(accept(firestore.doc(`cmsPublishQueue/${packet.runId}-hold-old`))).rejects.toThrow();
  expect((await accept()).idempotent).toBe(false);
  const original = await queue.get();
  const originalAdmission = (await firestore.doc(`${admission.ADMISSIONS}/operations/${operationId}`).get()).data();
  expect(originalAdmission).toMatchObject({ operationId, source: { sourceVersion: nextDocument.version } });
  await source.update({ version: nextDocument.version + 1, title: "Private working edit after acceptance" });
  expect((await accept(firestore.doc(`cmsPublishQueue/${rehearsalOperationId(packet, "settle-old")}`))).idempotent).toBe(true);
  expect((await queue.get()).updateTime!.isEqual(original.updateTime!)).toBe(true);
  expect((await firestore.doc(`${admission.ADMISSIONS}/operations/${operationId}`).get()).data()).toEqual(originalAdmission);
  expect((await source.get()).data()).toMatchObject({ version: nextDocument.version + 1,
    title: "Private working edit after acceptance", published: { sourceVersion: nextDocument.version } });
});
