import { beforeEach, describe, expect, it } from "vitest";
import { isolatedFirestore } from "../helpers/emulator-firestore.js";
import operations from "../../functions/lib/cuez-transfer-operations.js";
const db = isolatedFirestore("cuez-operations");
const store = operations.createTransferOperations({ firestore: db, now: () => Date.parse("2026-10-29T15:00:00Z") });
const prepared = (revision = 1, origin = null) => ({ direction: "export", initiatedBy: "staff", origin,
  selectionSnapshot: { workspaceId: "newsdesk-one", selection: { kind: "video", sourceId: "video-library",
    assetId: "asset", expectedVersion: revision, fileVersion: "74bca5c72cb25c4d9532b08d956d1dc5", expectedUpdateTime: `${revision}:0` },
    target: { kind: "story-asset", storyId: "story-one" }, mappingVersion: 1 },
  resolvedSelection: { record: { collection: "mediaSourceAssets", recordId: "asset", version: revision, updateTime: `${revision}:0` },
    original: { bucket: "test-originals", objectKey: "objects/video.mp4", objectVersionId: "original-v1", sizeBytes: 1000 } } });
const read = async id => (await db.collection(operations.OPERATIONS).doc(id).get()).data();
async function claimed(p = prepared()) {
  const queued = await store.enqueue(p);
  const result = await store.claim(queued.operation.operationId, p);
  expect(result.claimed).toBe(true);
  return result.operation;
}
async function complete(args) {
  await store.reserveMapping(args);
  return store.complete(args);
}
async function partialStory(errorCode = "output_unavailable") {
  const p = prepared(); p.selectionSnapshot.target = { kind: "new-story" };
  const operation = await claimed(p);
  await store.reserveMapping(operation);
  await store.beginStep({ ...operation, step: "story", tool: "stories_create", payloadHash: "a".repeat(64) });
  await store.finishStep({ ...operation, step: "story", outcome: "complete", remoteIdentity: "created-story", remoteChangeMarker: "story-v1" });
  await store.beginStep({ ...operation, step: "asset", tool: "assets_import_from_url", storyId: "created-story", payloadHash: "b".repeat(64) });
  await store.finishStep({ ...operation, step: "asset", outcome: "not-applied", errorCode });
  const event = errorCode === "remote_conflict" ? "confirmed_conflict" : "confirmed_failure";
  await store.advance({ ...operation, event, errorCode,
    ...(event === "confirmed_conflict" ? { conflict: { localRevision: "b".repeat(64), remoteRevision: "unavailable" } } : {}) });
  return { p, operation };
}
beforeEach(async () => {
  await Promise.all([operations.OPERATIONS, operations.MAPPINGS].map(name => db.recursiveDelete(db.collection(name))));
});
describe("durable transfer operations", () => {
  it("permits a queued source conflict before any attempt starts", async () => {
    const queued = (await store.enqueue(prepared())).operation;
    expect(queued.attemptId).toBeNull();
    expect(await store.advance({ ...queued, event: "confirmed_conflict", errorCode: "remote_conflict",
      conflict: { localRevision: "preview-v1", remoteRevision: "changed-v2" } }))
      .toMatchObject({ state: "conflict", attemptCount: 0 });
  });
  it("keeps unknown writes reconcilable after a confirmed read failure", async () => {
    const p = prepared(); p.selectionSnapshot.target = { kind: "new-story" };
    const operation = await claimed(p);
    const reserved = await store.reserveMapping(operation);
    await store.beginStep({ ...operation, step: "story", tool: "stories_create", payloadHash: "a".repeat(64) });
    await store.advance({ ...operation, event: "outcome_unknown", errorCode: "outcome_unknown" });
    const result = await store.advance({ ...operation, event: "confirmed_failure", errorCode: "not_authorized" });
    expect(result.state).toBe("reconciliation");
    expect((await db.collection(operations.MAPPINGS).doc(reserved.operation.mappingCheck.mappingId).get()).data())
      .toMatchObject({ pendingOperationId: operation.operationId });
    await store.finishStep({ ...operation, step: "story", outcome: "complete", remoteIdentity: "created-story", remoteChangeMarker: "story-v1" });
    expect((await store.complete({ ...operation, remoteIdentity: "created-story", remoteChangeMarker: "story-v1" })).state).toBe("complete");
  });
  it("does not let a delayed failure undo a queued retry", async () => {
    const operation = await claimed();
    await store.advance({ ...operation, event: "confirmed_failure", errorCode: "transient_failure" });
    await store.advance({ ...operation, event: "retry" });
    expect((await store.advance({ ...operation, event: "retry" })).state).toBe("queued");
    await expect(store.advance({ ...operation, event: "confirmed_failure", errorCode: "transient_failure" }))
      .rejects.toMatchObject({ code: "invalid_transition" });
    expect((await store.claim(operation.operationId, prepared())).claimed).toBe(true);
  });
  it("stores the imported draft revision on the operation and mapping", async () => {
    const p = { direction: "import", initiatedBy: "staff", origin: null, resolvedSelection: {},
      selectionSnapshot: { workspaceId: "newsdesk-one", storyId: "story-one", importKind: "story-with-brief-and-dossiers",
        remoteChangeMarker: "remote-v1", mappingVersion: 1 } };
    const operation = await claimed(p);
    const importedRecord = { collection: "cmsPosts", recordId: "post-one", version: 3, updateTime: "10:123" };
    const done = await store.complete({ ...operation, remoteIdentity: "story-one", remoteChangeMarker: "remote-v1", importedRecord });
    expect(done.lastLocalRevision).toEqual(importedRecord);
    expect((await db.collection(operations.MAPPINGS).doc(done.mappingId).get()).data().lastLocalRevision).toEqual(importedRecord);
  });
  it("atomically deduplicates concurrent enqueues and claims only one attempt", async () => {
    const results = await Promise.all([store.enqueue(prepared()), store.enqueue(prepared())]);
    expect(results.filter(result => result.created)).toHaveLength(1);
    const ids = results.map(result => result.operation.operationId);
    expect(ids[0]).toBe(ids[1]);
    const claims = await Promise.all([store.claim(ids[0], prepared()), store.claim(ids[0], prepared())]);
    expect(claims.filter(result => result.claimed)).toHaveLength(1);
    expect(await read(ids[0])).toMatchObject({ state: "transferring", attemptCount: 1,
      origin: { system: "boardwalk", operationId: ids[0] } });
    const reloaded = operations.createTransferOperations({ firestore: db });
    expect((await reloaded.claim(ids[0], prepared())).claimed).toBe(false);
  });
  it("does not take over an interrupted write and keeps unknown outcomes out of retry", async () => {
    const operation = await claimed();
    const uncertain = await store.advance({ ...operation, event: "outcome_unknown", errorCode: "outcome_unknown" });
    expect(uncertain).toMatchObject({ state: "reconciliation", attemptCount: 1, finishedAt: null });
    expect((await store.claim(operation.operationId, prepared())).claimed).toBe(false);
    await expect(store.advance({ ...operation, event: "retry" })).rejects.toMatchObject({ code: "invalid_transition" });
    expect((await store.enqueue(prepared())).operation.state).toBe("reconciliation");
    expect((await db.collection(operations.MAPPINGS).get()).empty).toBe(true);
  });
  it("retries only confirmed transient failure and fences the old attempt", async () => {
    const first = await claimed();
    await store.advance({ ...first, event: "confirmed_failure", errorCode: "transient_failure" });
    await store.advance({ ...first, event: "retry" });
    const second = (await store.claim(first.operationId, prepared())).operation;
    expect(second.attemptCount).toBe(2);
    expect(second.attemptId).not.toBe(first.attemptId);
    await expect(store.advance({ ...first, event: "outcome_unknown", errorCode: "outcome_unknown" }))
      .rejects.toMatchObject({ code: "invalid_transition" });
    await store.advance({ ...second, event: "confirmed_failure", errorCode: "selection_changed" });
    await expect(store.advance({ ...second, event: "retry" })).rejects.toMatchObject({ code: "invalid_transition" });
    expect((await read(first.operationId)).attemptCount).toBe(2);
  });
  it("completes the operation and mapping together, including after reconciliation", async () => {
    const operation = await claimed();
    await store.advance({ ...operation, event: "outcome_unknown", errorCode: "outcome_unknown" });
    const result = await complete({ ...operation, remoteIdentity: "asset-one", remoteChangeMarker: "remote-v1" });
    expect(result.state).toBe("complete");
    const mapping = (await db.collection(operations.MAPPINGS).doc(result.mappingId).get()).data();
    expect(mapping).toMatchObject({ externalId: "asset-one", lastOperationId: operation.operationId,
      boardwalkRecord: { collection: "mediaSourceAssets", recordId: "asset" }, lastRemoteRevision: "remote-v1",
      lastLocalRevision: { selectionSnapshot: prepared().selectionSnapshot }, origin: result.origin });
    expect((await store.complete({ ...operation, remoteIdentity: "asset-one", remoteChangeMarker: "remote-v1" })).state).toBe("complete");
    expect((await db.collection(operations.MAPPINGS).get()).size).toBe(1);
    expect((await store.claim(operation.operationId, prepared())).claimed).toBe(false);
  });
  it("retains both versions on a mapping conflict without advancing the old mapping", async () => {
    const first = await claimed();
    const completed = await complete({ ...first, remoteIdentity: "asset-one", remoteChangeMarker: "remote-v1" });
    const previous = (await db.collection(operations.MAPPINGS).doc(completed.mappingId).get()).data();
    const second = await claimed(prepared(2));
    const { operation: conflict } = await store.reserveMapping(second);
    expect(conflict.state).toBe("conflict");
    expect(conflict.conflict.previousMapping).toEqual(previous);
    expect(conflict.conflict.proposed).toMatchObject({ selectionSnapshot: prepared(2).selectionSnapshot });
    expect((await db.collection(operations.MAPPINGS).doc(completed.mappingId).get()).data()).toEqual(previous);
    await expect(store.advance({ ...second, event: "retry" })).rejects.toMatchObject({ code: "invalid_transition" });
  });
  it("advances a mapping only against its expected last operation", async () => {
    const first = await claimed();
    const completed = await complete({ ...first, remoteIdentity: "asset-one", remoteChangeMarker: "remote-v1" });
    const second = await claimed(prepared(2));
    const result = await complete({ ...second, remoteIdentity: "asset-two", remoteChangeMarker: null,
      expectedMappingOperationId: first.operationId });
    expect(result.state).toBe("complete");
    expect(result.mappingId).toBe(completed.mappingId);
    expect((await db.collection(operations.MAPPINGS).doc(result.mappingId).get()).data().lastOperationId).toBe(second.operationId);
    expect((await db.collection(operations.MAPPINGS).doc(result.mappingId).get()).data().externalId).toBe("asset-two");
  });
  it("keeps both conflict revision markers and original selection evidence", async () => {
    const operation = await claimed();
    const result = await store.advance({ ...operation, event: "confirmed_conflict", errorCode: "remote_conflict",
      conflict: { localRevision: "local-v2", remoteRevision: "remote-v2" } });
    expect(result.conflict).toMatchObject({ localRevision: "local-v2", remoteRevision: "remote-v2",
      selectionSnapshot: prepared().selectionSnapshot, resolvedSelection: prepared().resolvedSelection });
    expect((await db.collection(operations.MAPPINGS).get()).empty).toBe(true);
  });
  it("preserves origins and refuses automatic round trips", async () => {
    const origin = { system: "external", operationId: "a".repeat(64), mappingId: "b".repeat(64) };
    await expect(store.enqueue(prepared(1, origin), { automatic: true })).rejects.toMatchObject({ code: "remote_conflict" });
    const explicit = await store.enqueue(prepared(1, origin));
    expect(explicit.operation.origin).toEqual(origin);
    const operation = (await store.claim(explicit.operation.operationId, prepared(1, origin))).operation;
    const result = await complete({ ...operation, remoteIdentity: "asset-one" });
    expect(result.origin).toEqual(origin);
  });
  it("refuses changed resolution, raw content and access URLs before persistence", async () => {
    const operation = await claimed();
    const changed = prepared(); changed.resolvedSelection.original.objectVersionId = "other";
    await expect(store.enqueue(changed)).rejects.toMatchObject({ code: "selection_changed" });
    await expect(store.claim(operation.operationId, changed)).rejects.toMatchObject({ code: "selection_changed" });
    const raw = prepared(); raw.resolvedSelection.transcriptText = "Sensitive text";
    await expect(store.enqueue(raw)).rejects.toMatchObject({ code: "invalid_request" });
    const url = prepared(); url.resolvedSelection.original.objectKey = "https://example.test/?token=secret";
    await expect(store.enqueue(url)).rejects.toMatchObject({ code: "invalid_request" });
    expect((await read(operation.operationId)).resolvedSelection).toEqual(prepared().resolvedSelection);
  });
  it("refuses a repeated event with a different error code", async () => {
    const operation = await claimed();
    await store.advance({ ...operation, event: "confirmed_failure", errorCode: "transient_failure" });
    expect((await store.advance({ ...operation, event: "confirmed_failure", errorCode: "transient_failure" })).state).toBe("failed");
    await expect(store.advance({ ...operation, event: "confirmed_failure", errorCode: "selection_changed" }))
      .rejects.toMatchObject({ code: "invalid_transition" });
    expect((await read(operation.operationId)).errorCode).toBe("transient_failure");
  });
  it("reserves a mapping before writes and refuses a competing operation", async () => {
    const first = await claimed();
    const second = await claimed(prepared(2));
    const reservations = await Promise.all([store.reserveMapping(first), store.reserveMapping(second)]);
    expect(reservations.map(result => result.operation.state).sort()).toEqual(["conflict", "transferring"]);
    const loser = reservations.find(result => result.operation.state === "conflict").operation;
    expect(loser.conflict.proposed.resolvedSelection).toBeDefined();
    expect((await db.collection(operations.MAPPINGS).get()).docs[0].data().externalId).toBeUndefined();
    await expect(store.complete({ ...loser, remoteIdentity: "must-not-be-written" })).rejects.toMatchObject({ code: "invalid_transition" });
  });
  it("retains completed steps across retries and fences unknown steps and old attempts", async () => {
    const p = prepared(); p.selectionSnapshot.target = { kind: "new-story" };
    const operation = await claimed(p);
    await store.reserveMapping(operation);
    const story = { ...operation, step: "story", tool: "stories_create", payloadHash: "a".repeat(64) };
    expect((await store.beginStep(story)).priorOutcome).toBe("not-attempted");
    expect((await store.beginStep(story)).priorOutcome).toBe("unknown");
    const asset = { ...operation, step: "asset", tool: "assets_import_from_url", storyId: "created-story", payloadHash: "b".repeat(64),
      preImportAssetIds: ["staff-asset"] };
    await expect(store.beginStep(asset)).rejects.toMatchObject({ code: "invalid_transition" });
    await store.finishStep({ ...operation, step: "story", outcome: "complete", remoteIdentity: "created-story", remoteChangeMarker: "story-v1" });
    await expect(store.finishStep({ ...operation, step: "story", outcome: "complete", remoteIdentity: "created-story", remoteChangeMarker: "other-revision" }))
      .rejects.toMatchObject({ code: "invalid_transition" });
    await store.beginStep(asset);
    await store.finishStep({ ...operation, step: "asset", outcome: "not-applied", errorCode: "transient_failure" });
    await store.advance({ ...operation, event: "confirmed_failure", errorCode: "transient_failure" });
    await store.advance({ ...operation, event: "retry" });
    const retried = (await store.claim(operation.operationId, p)).operation;
    const reloaded = operations.createTransferOperations({ firestore: db });
    expect((await reloaded.beginStep({ ...story, attemptId: retried.attemptId })).step)
      .toMatchObject({ outcome: "complete", remoteIdentity: "created-story" });
    expect((await reloaded.beginStep({ ...asset, attemptId: retried.attemptId })).priorOutcome).toBe("not-attempted");
    await expect(reloaded.finishStep({ ...operation, step: "asset", outcome: "complete", remoteIdentity: "late-asset" }))
      .rejects.toMatchObject({ code: "invalid_transition" });
    const saved = await read(operation.operationId);
    expect(saved.steps.asset).toMatchObject({ outcome: "unknown", preImportAssetIds: ["staff-asset"] });
    await expect(reloaded.complete({ ...retried, remoteIdentity: "created-story" })).rejects.toMatchObject({ code: "invalid_transition" });
  });
  it("retains a created identity while its first revision read is unavailable", async () => {
    const p = prepared(); p.selectionSnapshot.target = { kind: "new-story" };
    const operation = await claimed(p);
    await store.reserveMapping(operation);
    await store.beginStep({ ...operation, step: "story", tool: "stories_create", payloadHash: "a".repeat(64) });
    await store.finishStep({ ...operation, step: "story", outcome: "complete", remoteIdentity: "created-story" });
    await expect(store.complete({ ...operation, remoteIdentity: "created-story" })).rejects.toMatchObject({ code: "invalid_request" });
    await store.finishStep({ ...operation, step: "story", outcome: "complete", remoteIdentity: "created-story", remoteChangeMarker: "story-v1" });
    expect(await store.finishStep({ ...operation, step: "story", outcome: "complete", remoteIdentity: "created-story" }))
      .toMatchObject({ remoteChangeMarker: "story-v1" });
    expect((await store.complete({ ...operation, remoteIdentity: "created-story", remoteChangeMarker: "story-v1" })).state).toBe("complete");
  });
  it.each([false, true])("retains a partial mapping after non-transient failure (re-export=%s)", async reexport => {
    const p = prepared(); p.selectionSnapshot.target = { kind: "new-story" };
    let expectedMappingOperationId = null;
    if (reexport) {
      const initial = await claimed(p);
      await complete({ ...initial, remoteIdentity: "created-story", remoteChangeMarker: "story-v1" });
      expectedMappingOperationId = initial.operationId;
      p.selectionSnapshot.selection.expectedVersion = 2;
      p.selectionSnapshot.selection.expectedUpdateTime = "2:0";
      p.resolvedSelection.record = { ...p.resolvedSelection.record, version: 2, updateTime: "2:0" };
    }
    const operation = await claimed(p);
    const reserved = await store.reserveMapping({ ...operation, expectedMappingOperationId });
    const mappingRef = db.collection(operations.MAPPINGS).doc(reserved.operation.mappingCheck.mappingId);
    const story = { ...operation, step: "story", tool: reexport ? "stories_update" : "stories_create", payloadHash: "a".repeat(64) };
    await store.beginStep(story);
    await store.finishStep({ ...operation, step: "story", outcome: "complete", remoteIdentity: "created-story", remoteChangeMarker: "story-v2" });
    const asset = { ...operation, step: "asset", tool: "assets_import_from_url", storyId: "created-story", payloadHash: "b".repeat(64) };
    await store.beginStep(asset);
    await store.finishStep({ ...operation, step: "asset", outcome: "not-applied", errorCode: "output_unavailable" });
    await store.advance({ ...operation, event: "confirmed_failure", errorCode: "output_unavailable" });
    expect((await mappingRef.get()).data()).toMatchObject({ pendingOperationId: operation.operationId });
    if (reexport) expect((await mappingRef.get()).data()).toMatchObject({
      externalId: "created-story", lastOperationId: expectedMappingOperationId, lastRemoteRevision: "story-v1" });
    expect((await read(operation.operationId)).steps).toMatchObject({
      story: { outcome: "complete", remoteIdentity: "created-story", remoteChangeMarker: "story-v2" },
      asset: { outcome: "not-applied", errorCode: "output_unavailable" } });
    const changed = prepared(3); changed.selectionSnapshot.target = { kind: "new-story" };
    const competing = await claimed(changed);
    expect((await store.reserveMapping({ ...competing, expectedMappingOperationId })).operation.state).toBe("conflict");
    await store.advance({ ...operation, event: "retry" });
    const retried = (await store.claim(operation.operationId, p)).operation;
    expect((await store.beginStep({ ...story, attemptId: retried.attemptId })).priorOutcome).toBe("complete");
    expect((await store.beginStep({ ...asset, attemptId: retried.attemptId })).priorOutcome).toBe("not-attempted");
    await store.finishStep({ ...retried, step: "asset", outcome: "complete", remoteIdentity: "imported-asset" });
    expect((await store.complete({ ...retried, remoteIdentity: "created-story", remoteChangeMarker: "story-v2", expectedMappingOperationId })).state).toBe("complete");
    expect((await mappingRef.get()).data()).toMatchObject({ externalId: "created-story", lastRemoteRevision: "story-v2",
      lastOperationId: operation.operationId, pendingOperationId: null });
  });
  it("persists a rejected write's conflict evidence without an unknown step", async () => {
    const operation = await claimed();
    await store.reserveMapping(operation);
    await store.beginStep({ ...operation, step: "asset", tool: "assets_import_from_url", storyId: "story-one", payloadHash: "a".repeat(64) });
    await store.finishStep({ ...operation, step: "asset", outcome: "not-applied", errorCode: "remote_conflict" });
    const result = await store.advance({ ...operation, event: "confirmed_conflict", errorCode: "remote_conflict",
      conflict: { localRevision: "a".repeat(64), remoteRevision: "unavailable" } });
    expect(result).toMatchObject({ state: "conflict", errorCode: "remote_conflict",
      steps: { asset: { outcome: "not-applied", errorCode: "remote_conflict", remoteIdentity: null } },
      conflict: { localRevision: "a".repeat(64), remoteRevision: "unavailable" } });
    expect((await db.collection(operations.MAPPINGS).get()).empty).toBe(true);
  });
  it.each(["remote_conflict", "output_unavailable", "invalid_request"])(
    "closes a partial %s by adopting its confirmed story for later exports", async errorCode => {
      const { operation } = await partialStory(errorCode);
      const state = errorCode === "remote_conflict" ? "conflict" : "failed";
      const changed = prepared(2); changed.selectionSnapshot.target = { kind: "new-story" };
      const blocked = await claimed(changed);
      expect((await store.reserveMapping(blocked)).operation.state).toBe("conflict");
      const reloaded = operations.createTransferOperations({ firestore: db });
      const acknowledgment = { ...operation, acknowledgedBy: "reviewing-staff" };
      const closed = await reloaded.acknowledgePartial(acknowledgment);
      expect(closed).toMatchObject({ state, errorCode, remoteIdentity: "created-story", remoteChangeMarker: "story-v1",
        partialAcknowledgment: { acknowledgedBy: "reviewing-staff", completedStepIds: ["story"] },
        steps: { asset: { outcome: "not-applied", errorCode } } });
      expect(closed.partialAcknowledgment.acknowledgedAt.toMillis()).toBeGreaterThan(0);
      const mappingRef = db.collection(operations.MAPPINGS).doc(closed.mappingId);
      expect((await mappingRef.get()).data()).toMatchObject({ externalId: "created-story", lastRemoteRevision: "story-v1",
        lastOperationId: operation.operationId, pendingOperationId: null, partialAcknowledgment: closed.partialAcknowledgment });
      await expect(store.advance({ ...operation, event: "retry" })).rejects.toMatchObject({ code: "invalid_transition" });
      await expect(store.complete({ ...operation, remoteIdentity: "created-story", remoteChangeMarker: "story-v1" }))
        .rejects.toMatchObject({ code: "invalid_transition" });
      const nextSelection = prepared(3); nextSelection.selectionSnapshot.target = { kind: "new-story" };
      const next = await claimed(nextSelection);
      const reserved = await store.reserveMapping({ ...next, expectedMappingOperationId: operation.operationId });
      expect(reserved.operation.state).toBe("transferring");
      expect(reserved.mapping.externalId).toBe("created-story");
      const done = await store.complete({ ...next, expectedMappingOperationId: operation.operationId,
        remoteIdentity: "created-story", remoteChangeMarker: "story-v2" });
      const finalMapping = (await mappingRef.get()).data();
      expect(finalMapping).toMatchObject({ externalId: "created-story", lastOperationId: done.operationId, pendingOperationId: null });
      expect(finalMapping.partialAcknowledgment).toBeUndefined();
      expect(await reloaded.acknowledgePartial(acknowledgment)).toEqual(closed);
      expect((await mappingRef.get()).data()).toEqual(finalMapping);
    });
  it.each(["transferring", "reconciliation", "failed", "conflict"])(
    "refuses to acknowledge an unknown write in %s", async state => {
      const p = prepared(); p.selectionSnapshot.target = { kind: "new-story" };
      const operation = await claimed(p);
      await store.reserveMapping(operation);
      await store.beginStep({ ...operation, step: "story", tool: "stories_create", payloadHash: "a".repeat(64) });
      await store.finishStep({ ...operation, step: "story", outcome: "complete", remoteIdentity: "created-story", remoteChangeMarker: "story-v1" });
      await store.beginStep({ ...operation, step: "asset", tool: "assets_import_from_url", storyId: "created-story", payloadHash: "b".repeat(64) });
      if (state === "reconciliation") await store.advance({ ...operation, event: "outcome_unknown", errorCode: "outcome_unknown" });
      if (state === "failed") await store.advance({ ...operation, event: "confirmed_failure", errorCode: "output_unavailable" });
      if (state === "conflict") await store.advance({ ...operation, event: "confirmed_conflict", errorCode: "remote_conflict",
        conflict: { localRevision: "local-v1", remoteRevision: "remote-v1" } });
      await expect(store.acknowledgePartial({ ...operation, acknowledgedBy: "staff" })).rejects.toMatchObject({ code: "invalid_transition" });
      expect((await db.collection(operations.MAPPINGS).get()).docs[0].data().pendingOperationId).toBe(operation.operationId);
    });
  it("fences acknowledgments against stale attempts and validates the staff identity", async () => {
    const { p, operation } = await partialStory();
    await expect(store.acknowledgePartial({ ...operation, acknowledgedBy: "staff/invalid" })).rejects.toMatchObject({ code: "invalid_request" });
    await store.advance({ ...operation, event: "retry" });
    const current = (await store.claim(operation.operationId, p)).operation;
    await store.advance({ ...current, event: "confirmed_failure", errorCode: "output_unavailable" });
    await expect(store.acknowledgePartial({ ...operation, acknowledgedBy: "staff" })).rejects.toMatchObject({ code: "invalid_transition" });
    expect(await store.acknowledgePartial({ ...current, acknowledgedBy: "staff" }))
      .toMatchObject({ attemptId: current.attemptId, partialAcknowledgment: { acknowledgedBy: "staff" } });
  });
  it("serializes a retry racing a partial acknowledgment", async () => {
    const { operation } = await partialStory();
    const results = await Promise.allSettled([
      store.acknowledgePartial({ ...operation, acknowledgedBy: "staff" }),
      store.advance({ ...operation, event: "retry" }),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected").reason).toMatchObject({ code: "invalid_transition" });
    const saved = await read(operation.operationId);
    const mapping = (await db.collection(operations.MAPPINGS).get()).docs[0].data();
    if (saved.partialAcknowledgment) expect(mapping).toMatchObject({ externalId: "created-story", pendingOperationId: null });
    else expect(mapping.pendingOperationId).toBe(operation.operationId);
    expect(saved.steps.story.remoteIdentity).toBe("created-story");
  });
});
