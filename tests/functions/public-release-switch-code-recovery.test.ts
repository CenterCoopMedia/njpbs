import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { isolatedFirestore, clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { seedSwitch, fixtureGuard, fixtureReadOwner } from "../helpers/public-release-switch.js";
import { releasePair, pairReference } from "../helpers/private-public-release-pair.js";
import switches from "../../functions/lib/public-release-switch.js";
import p from "../../functions/lib/public-release-pair.js";
import log from "../../functions/lib/public-release-change-log.js";
import work from "../../functions/lib/public-release-pair-work.js";
import inputs from "../../functions/lib/public-release-pair-input.js";
import { capturePublicReleasePairInput } from "../../site/scripts/public-release-pair-input-storage";
const db = isolatedFirestore("switch-code-recovery"), hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
let runtime: Miniflare, store: Awaited<ReturnType<Miniflare["getR2Bucket"]>>;
const memberKey = hash(JSON.stringify(["provider", "public-code"]));
beforeAll(async () => {
  runtime = new Miniflare({ workers: [{ config: { name: "code-recovery", type: "worker", compatibilityDate: "2026-07-09",
    manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: "export default {fetch(){return new Response(null,{status:404})}}" } } },
    env: { CONTENT: { type: "r2", name: "code-recovery" } } } }] });
  store = await runtime.getR2Bucket("CONTENT");
});
afterAll(async () => { await runtime?.dispose(); });
beforeEach(async () => { await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db); });

async function switched() {
  const seeded = await seedSwitch(db);
  await switches.reservePublicReleaseSwitch({ firestore: db, attempt: seeded.attempt });
  // Actual switch/log transaction; the late qualification callbacks remain
  // explicit test preconditions. This is not a bootstrap/qualification proof.
  await switches.applyPublicReleaseSwitch({ firestore: db, attempt: seeded.attempt, qualificationReadOwner: fixtureReadOwner,
    assertQualificationsCurrentInTransaction: fixtureGuard, assertAcceptedWorkIncludedInTransaction: fixtureGuard });
  const entry = (await db.doc("system/publicReleaseChanges/entries/0000000000000001").get()).data()!;
  const member = (await db.doc(`system/publicReleaseChanges/operations/${entry.operationId}/members/${memberKey}`).get()).data()!;
  const scope = { kind: "recovery" as const, sourceOperationId: entry.operationId, sourceVersion: entry.changes[0].sourceVersion,
    snapshotDigest: entry.changes[0].snapshotDigest, contextSequence: entry.sequence };
  const bytes = new TextEncoder().encode(member.json), pair = seeded.next;
  expect(hash(bytes)).toBe(scope.snapshotDigest);
  const root = { schemaVersion: 2, kind: "pair-render-input", pairDigest: p.publicReleaseDigest(pair),
    source: { kind: "provider", id: "public-code" }, scope,
    cursor: { baselineDigest: entry.previousDigest, sequence: entry.sequence, lastDigest: entry.entryDigest },
    snapshotFile: "snapshot.json", entryFiles: ["snapshot.json"],
    files: [{ name: "snapshot.json", digest: hash(bytes), bytes: bytes.length,
      objectKey: inputs.publicReleasePairInputObjectKey(pair, hash(bytes)), dependencies: [] as string[] }] };
  return { ...seeded, pair, entry, member, root, bytes };
}
const capture = (state: Awaited<ReturnType<typeof switched>>, root = state.root, files = [{ name: "snapshot.json", bytes: state.bytes }]) => {
  let writes = 0;
  const wrapped = { get: store.get.bind(store), async put(...args: Parameters<typeof store.put>) { writes++; return store.put(...args); } };
  return { writes: () => writes, result: capturePublicReleasePairInput({ firestore: db, store: wrapped, pair: state.pair, plan: root,
    expectedSource: root.source as any, expectedCursor: root.cursor, bindSourceOperation: true,
    files: (async function* () { yield* files; })() }) };
};
it("captures and enqueues the exact selected NEW switch CODE H once, without creating another publish or admission", async () => {
  const state = await switched(), first = await capture(state).result, again = await capture(state).result;
  expect(first.idempotent).toBe(false); expect(again.idempotent).toBe(true);
  expect(first.receipt).toEqual(again.receipt);
  const enqueue = () => db.runTransaction(transaction => work.enqueuePublicReleasePairWorkInTransaction({ firestore: db,
    transaction, pair: state.pair, input: { ...state.root.scope, inputManifestDigest: first.receipt.inputManifestDigest } }));
  const a = await enqueue(), b = await enqueue();
  expect(a.idempotent).toBe(false); expect(b.idempotent).toBe(true); expect(b.taskId).toBe(a.taskId);
  expect((await db.collection(`${work.publicReleasePairPath(state.pair.pairId)}/work`).get()).size).toBe(1);
  expect((await db.collection("cmsPublishQueue").get()).empty).toBe(true);
  expect((await db.collection("system/publicReleaseAdmissions/operations").get()).empty).toBe(true);
  expect((await db.collection("system/publicReleaseChanges/entries").get()).size).toBe(1);
});
it("refuses a different valid H after the immutable CODE scope has its first capture binding", async () => {
  const state = await switched(); await capture(state).result;
  const extra = new TextEncoder().encode("{}"), extraFile = { name: "context.json", digest: hash(extra), bytes: extra.length,
    objectKey: inputs.publicReleasePairInputObjectKey(state.pair, hash(extra)), dependencies: [] as string[] };
  const root = { ...state.root, entryFiles: ["context.json", "snapshot.json"], files: [extraFile, ...state.root.files] };
  const refused = capture(state, root, [{ name: "context.json", bytes: extra }, { name: "snapshot.json", bytes: state.bytes }]);
  await expect(refused.result).rejects.toThrow(); expect(refused.writes()).toBe(0);
});
it.each(["missing-event", "tampered-event", "non-code", "replayed-event", "other-pair", "candidate", "retired"])("refuses %s before any R2 write", async mode => {
  const state = await switched();
  const eventRef = db.doc("system/publicReleaseChanges/entries/0000000000000001");
  if (mode === "missing-event") await eventRef.delete();
  if (mode === "tampered-event") await eventRef.update({ "changes": [{ ...state.entry.changes[0], sourceVersion: 99 }] });
  if (mode === "candidate" || mode === "retired") await db.doc(`${work.publicReleasePairPath(state.pair.pairId)}/controls/runtime`).update({ status: mode });
  if (mode === "other-pair") {
    const third = releasePair("c", "c".repeat(40)); await work.registerPublicReleasePair({ firestore: db, pair: third });
    await db.doc(`${work.publicReleasePairPath(third.pairId)}/controls/runtime`).update({ status: "retained" });
    const root = (await db.doc("system/publicDeployment").get()).data()!;
    await db.doc("system/publicDeployment").set({ ...root, selectedPair: pairReference(third), recoveryPair: pairReference(state.pair),
      activeCommitSha: third.commitSha, activeDeploymentId: third.publicWorker.versionId,
      contentHead: { ...root.contentHead, pairId: third.pairId } });
    state.pair = third; state.root.pairDigest = p.publicReleaseDigest(third);
    state.root.files = state.root.files.map(file => ({ ...file, objectKey: inputs.publicReleasePairInputObjectKey(third, file.digest) }));
  }
  if (mode === "non-code" || mode === "replayed-event") {
    const core = { ...state.entry, operationId: "replayed-code" };
    delete core.entryDigest;
    if (mode === "non-code") core.changes = [{ ...core.changes[0], kind: "post", id: "story", action: "publish" }];
    const entry = { ...core, entryDigest: p.publicReleaseDigest(core) };
    await eventRef.set(entry);
    await db.doc(`system/publicReleaseChanges/operations/${entry.operationId}`).set({ schemaVersion: 2, sequence: entry.sequence,
      entryDigest: entry.entryDigest, inputDigest: p.publicReleaseDigest(log.parsePublicReleaseChangeInput({ operationId: entry.operationId,
        pair: entry.pair, contextRevision: entry.contextRevision, changes: entry.changes })) });
    await db.doc(`system/publicReleaseChanges/operations/${entry.operationId}/members/${memberKey}`).set({ ...state.member,
      operationId: entry.operationId, entryDigest: entry.entryDigest });
    await db.doc("system/publicReleaseChanges").update({ lastDigest: entry.entryDigest });
    state.root.scope.sourceOperationId = entry.operationId; state.root.cursor.lastDigest = entry.entryDigest;
  }
  const refused = capture(state); await expect(refused.result).rejects.toThrow(); expect(refused.writes()).toBe(0);
});
