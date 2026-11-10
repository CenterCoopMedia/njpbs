import { beforeAll, beforeEach, expect, it } from "vitest";
import { isolatedFirestore, clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { seedSwitch } from "../helpers/public-release-switch.js";
import { preparePublicReleaseSwitchWorkCensus, assertPreparedPublicReleaseSwitchWorkCensusInTransaction } from "../../site/scripts/public-release-switch-work-census";
import { trackQualificationTransactionReads, assertQualificationTransactionReadBudget } from "../../site/scripts/public-release-pair-qualification-source";
import admission from "../../functions/lib/public-release-admission.js";
import producer from "../../functions/lib/public-context-revision.js";
import protocol from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";

let db: ReturnType<typeof isolatedFirestore>, sides: Awaited<ReturnType<typeof seedSwitch>>;
const contract = { schemaVersion: 2, families: ["context"], features: [] };
beforeAll(() => { db = isolatedFirestore("switch-work-census"); });
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
  sides = await seedSwitch(db, { admittedContract: contract });
  await db.doc(`${admission.CONTRACTS}/${protocol.publicReleaseDigest(contract)}`).set(contract);
  await db.doc(`${admission.ADMISSIONS}/controls/adoption`).set({ schemaVersion: 2, enabled: true });
});
async function accept(operationId: string) {
  const change = { kind: "provider" as const, id: operationId, action: "dependency" as const,
    sourceVersion: 1, snapshot: { sourceVersion: 1, value: operationId } };
  return db.runTransaction(async transaction => {
    const context = (await transaction.get(db.doc("system/publicDeployment/contexts/public"))).data()!;
    const result = await admission.preparePairPublicationInTransaction({ firestore: db, transaction, operationId,
      source: admission.publicationSource(change), change, contextRevision: context.revision + 1 });
    result.write(); producer.bumpPublicContextRevision(transaction, db); return result.admission;
  });
}
const prepare = () => preparePublicReleaseSwitchWorkCensus({ firestore: db, oldPair: sides.old, newPair: sides.next });
async function current(proof: Awaited<ReturnType<typeof prepare>>) {
  return db.runTransaction(async transaction => {
    const tracker = trackQualificationTransactionReads(transaction);
    const census = await assertPreparedPublicReleaseSwitchWorkCensusInTransaction({ firestore: db, transaction: tracker.transaction, proof });
    expect(assertQualificationTransactionReadBudget(tracker)).toBeLessThanOrEqual(20);
    return census;
  });
}
it("captures the complete actual acceptance census without moving selection or claiming public success", async () => {
  const first = await accept("accepted-a"), second = await accept("accepted-b");
  const root = (await db.doc("system/publicDeployment").get()).data();
  const proof = await prepare(), census = await current(proof);
  expect(proof.operationCount).toBe(2); expect(census.admissionHead.pendingCount).toBe(2);
  expect(census.pages).toHaveLength(1);
  const page = (await db.doc(`system/publicDeployment/switchWorkCensusPages/${census.pages[0]}`).get()).data()!;
  expect(protocol.publicReleaseDigest(page)).toBe(census.pages[0]);
  expect(page.entries.map((entry: any) => entry.admission)).toEqual([first, second]);
  expect((await db.doc("system/publicDeployment").get()).data()).toEqual(root);
  expect((await db.collection(`${admission.ADMISSIONS}/terminalReceipts`).get()).empty).toBe(true);
  const saved = await db.doc(`system/publicDeployment/switchWorkCensuses/${proof.digest}`).get();
  expect((await prepare()).digest).toBe(proof.digest);
  expect((await saved.ref.get()).updateTime!.isEqual(saved.updateTime!)).toBe(true);
});
it("binds the empty census and rejects serialized or foreign-client preparation handles", async () => {
  const proof = await prepare(); expect((await current(proof)).operationCount).toBe(0);
  await expect(current({ ...proof })).rejects.toThrow();
  const foreign = isolatedFirestore("switch-work-census-foreign");
  await expect(foreign.runTransaction(transaction => assertPreparedPublicReleaseSwitchWorkCensusInTransaction({
    firestore: foreign, transaction, proof }))).rejects.toThrow();
});
it("refuses an admission accepted after preparation, retaining both original queues", async () => {
  await accept("accepted-a"); const proof = await prepare(); await accept("accepted-b");
  await expect(current(proof)).rejects.toThrow();
  expect((await db.collection(`${admission.ADMISSIONS}/pending`).get()).size).toBe(2);
  expect((await current(await prepare())).operationCount).toBe(2);
});
it.each(["missing-marker", "wrong-xor", "foreign-queue", "tampered-event"])("refuses inconsistent %s evidence before issuing census", async mode => {
  await accept("accepted-a");
  if (mode === "missing-marker") await db.doc(`${admission.ADMISSIONS}/pending/accepted-a`).delete();
  if (mode === "wrong-xor") await db.doc(admission.ADMISSIONS).update({ pendingDigest: "f".repeat(64) });
  if (mode === "foreign-queue") await db.doc("cmsPublishQueue/accepted-a").update({ operationId: "other" });
  if (mode === "tampered-event") await db.doc("system/publicReleaseChanges/entries/0000000000000001").update({ operationId: "other" });
  await expect(prepare()).rejects.toThrow();
  expect((await db.collection("system/publicDeployment/switchWorkCensuses").get()).empty).toBe(true);
});
it("rechecks retained original-pair lifecycle and immutable census in the final tracked transaction", async () => {
  await accept("accepted-a"); const proof = await prepare();
  const runtime = db.doc(`${work.publicReleasePairPath(sides.old.pairId)}/controls/runtime`), before = (await runtime.get()).data()!;
  await runtime.update({ status: "retired" });
  await expect(current(proof)).rejects.toThrow(); await runtime.set(before);
  await db.doc(`system/publicDeployment/switchWorkCensuses/${proof.digest}`).update({ operationCount: 0 });
  await expect(current(proof)).rejects.toThrow();
  expect((await db.doc("cmsPublishQueue/accepted-a").get()).data()!.status).toBe("pending");
});
