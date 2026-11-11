import { afterAll, beforeAll, expect, it } from "vitest";
import type { Miniflare } from "miniflare";
import { publicReleaseR2Fixture } from "../helpers/public-release-r2-fixture";
import { isolatedFirestore } from "../helpers/emulator-firestore.js";
import { switchedPairFixture } from "../helpers/public-release-switched-pair";
import { stagedPublicReleasePairCompositeFixture } from "../helpers/staged-public-release-pair-composite";
import { seedSwitch } from "../helpers/public-release-switch.js";
import { verifyPublicReleasePairReplayEntry, assertPublicReleasePairReplayReaderSource } from "../../site/scripts/public-release-pair-log-replay";
import p from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import producer from "../../functions/lib/public-release-producer.js";
let runtime: Miniflare, fixture: Awaited<ReturnType<typeof switchedPairFixture>>;
let store: Awaited<ReturnType<Miniflare["getR2Bucket"]>>, entry: any;
beforeAll(async () => {
  ({ runtime, store } = await publicReleaseR2Fixture("code-replay"));
  fixture = await switchedPairFixture(isolatedFirestore("code-replay-authority"), store);
  entry = (await fixture.firestore.doc("system/publicReleaseChanges/entries/0000000000000001").get()).data();
}, 30_000);
afterAll(async () => { await fixture?.close(); await runtime?.dispose(); });
it("replays actual OLD-appended switch CODE with the exact sealed NEW reader", async () => {
  const { firestore, pair } = fixture, content = await fixture.captureCode();
  const queued = await firestore.runTransaction(transaction => work.enqueuePublicReleasePairWorkInTransaction({ firestore, transaction, pair,
    input: { ...content.root.scope, inputManifestDigest: content.receipt.inputManifestDigest } }));
  const staged = await stagedPublicReleasePairCompositeFixture({ ...fixture, content, taskId: queued.taskId }, store);
  const verified = await verifyPublicReleasePairReplayEntry({ firestore, store, pair, entry, cursor: content.root.cursor,
    reference: { identity: staged.claim.identity, claimDigest: staged.owner.claimDigest,
      manifestDigest: staged.rendered.manifestDigest, manifestBytes: staged.rendered.manifestBytes } });
  const authority = JSON.parse(new TextDecoder().decode(verified.files.get("authority.json")!));
  expect(entry.pair.commitSha).toBe(fixture.sourcePair.commitSha);
  expect(authority.readerSource).toBe(pair.commitSha);
  expect(verified.coverage.entryDigest).toBe(entry.entryDigest);
}, 30_000);
it.each(["missing-publication", "foreign-reference", "tampered-digest"])("refuses %s in the actual sealed CODE verifier", async mode => {
  const { firestore, pair } = fixture, ref = firestore.doc(`${work.publicReleasePairPath(pair.pairId)}/codePacks/publication`);
  const publication = (await ref.get()).data()!;
  try {
    if (mode === "missing-publication") await ref.delete();
    if (mode === "foreign-reference") await ref.update({ "reference.side": p.publicReleasePairReference(fixture.sourcePair) });
    if (mode === "tampered-digest") await ref.update({ "reference.publicationDigest": "f".repeat(64) });
    await expect(assertPublicReleasePairReplayReaderSource({ firestore, entry, readerSource: pair.commitSha })).rejects.toThrow();
  } finally { await ref.set(publication); }
});
it("refuses a reference-less OLD event when H claims the NEW handover reader", async () => {
  const firestore = isolatedFirestore("code-replay-missing-handover-reference"), state = await seedSwitch(firestore);
  await firestore.runTransaction(async transaction => {
    const prepared = await producer.preparePublicReleaseProducerInTransaction({ firestore, transaction, operationId: "missing-code-reference",
      changes: [{ kind: "provider", id: "public-code", action: "dependency", sourceVersion: 8,
        snapshot: { commitSha: state.next.commitSha, deploymentId: state.next.publicWorker.versionId, generation: 8 } }] });
    prepared(); transaction.update(firestore.doc("system/publicDeployment/contexts/public"), { revision: 13 });
  });
  const missing = (await firestore.doc("system/publicReleaseChanges/entries/0000000000000001").get()).data() as any;
  expect(missing.pair).toEqual(p.publicReleasePairReference(state.old));
  expect(state.old.commitSha).not.toBe(state.next.commitSha);
  await expect(assertPublicReleasePairReplayReaderSource({ firestore, entry: missing, readerSource: state.next.commitSha })).rejects.toThrow();
});
it("keeps ordinary-event reader equality", async () => {
  const { firestore, pair, sourcePair } = fixture;
  const append = async (id: string, operationId: string) => firestore.runTransaction(async transaction => {
    const context = await transaction.get(firestore.doc("system/publicDeployment/contexts/public"));
    const prepared = await producer.preparePublicReleaseProducerInTransaction({ firestore, transaction, operationId,
      changes: [{ kind: "provider", id, action: "dependency", sourceVersion: 1, snapshot: { fixture: operationId } }] });
    prepared();
    transaction.update(context.ref, { revision: context.data()!.revision + 1 });
  });
  await append("unrelated-source", "ordinary-source-event");
  const ordinary = (await firestore.doc("system/publicReleaseChanges/entries/0000000000000002").get()).data() as any;
  await expect(assertPublicReleasePairReplayReaderSource({ firestore, entry: ordinary, readerSource: sourcePair.commitSha })).rejects.toThrow();
  expect((await assertPublicReleasePairReplayReaderSource({ firestore, entry: ordinary, readerSource: pair.commitSha })).entry).toEqual(ordinary);
});
