import { createHash } from "node:crypto";
import { pairOwnerWriteRpc } from "../../publisher/pair-owner-write-rpc";
import { beforeEach, expect, it, vi } from "vitest";
import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { seedSwitch, fixtureGuard, fixtureReadOwner } from "../helpers/public-release-switch.js";
import protocol from "../../functions/lib/public-release-pair.js";
import switches from "../../functions/lib/public-release-switch.js";
import code from "../../functions/lib/public-release-switch-code-owner.js";
import producer from "../../functions/lib/public-release-producer.js";
import { bumpPublicContextRevision } from "../../functions/lib/public-context-revision.js";
import "../../functions/lib/firebase.js";
const db = isolatedFirestore("switch-code-owner"), now = 1_800_000_000_000;
const token = "11111111-1111-4111-8111-111111111111";
let state: Awaited<ReturnType<typeof seedSwitch>>, operationId: string;
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
  state = await seedSwitch(db);
  await switches.reservePublicReleaseSwitch({ firestore: db, attempt: state.attempt });
  await switches.applyPublicReleaseSwitch({ firestore: db, attempt: state.attempt, qualificationReadOwner: fixtureReadOwner,
    assertQualificationsCurrentInTransaction: fixtureGuard, assertAcceptedWorkIncludedInTransaction: fixtureGuard });
  operationId = switches.switchChangeOperationId(state.attempt.operationId);
  await db.doc("system/publicReleaseAdmissions/controls/adoption").set({ schemaVersion: 2, enabled: true });
});
const source = (pair = state.next, operation = operationId) => db.runTransaction(transaction => code.readSelectedSwitchCodeSourceInTransaction({
  firestore: db, transaction, pair, operationId: operation }), { readOnly: true });
it("discovers only the actual selected switch CODE from the real switch transaction", async () => {
  const owner = await source();
  expect(owner?.scope.sourceOperationId).toBe(operationId);
  expect(owner?.scope.kind).toBe("recovery");
  expect(owner?.source.eventDigest).toBe((await db.doc("system/publicReleaseChanges/entries/0000000000000001").get()).data()!.entryDigest);
  expect(await source(state.old)).toBeNull();
  expect(await source(state.next, "arbitrary-event")).toBeNull();
  expect((await db.collection("cmsPublishQueue").get()).empty).toBe(true);
  expect((await db.collection("system/publicReleaseAdmissions/operations").get()).empty).toBe(true);
});
it("does not invent switch CODE work for bootstrap's epoch one or absent adoption", async () => {
  await db.doc("system/publicReleaseAdmissions/controls/adoption").set({ schemaVersion: 2, enabled: false });
  expect(await source()).toBeNull();
  await db.doc("system/publicReleaseAdmissions/controls/adoption").set({ schemaVersion: 2, enabled: true });
  await db.doc(switches.ROOT).update({ epoch: 1 });
  expect(await source()).toBeNull();
});
it("requires the exact own live capture lease after all immutable switch source checks", async () => {
  const owner = (await source())!;
  const pending = { schemaVersion: 2, kind: "switch-code-pending", operationId, pairDigest: protocol.publicReleaseDigest(state.next),
    scope: owner.scope, sourceDigest: protocol.publicReleaseDigest(owner.source), lease: { token, until: now + 1 }, nextAttemptAt: 0, failures: 0, lastFailure: null };
  await db.doc(code.codePendingPath(state.next, operationId)).set(pending);
  const check = (at: number, lease = token) => db.runTransaction(transaction => code.assertSelectedSwitchCodeCaptureLeaseInTransaction({
    firestore: db, transaction, pair: state.next, operationId, token: lease, now: at }), { readOnly: true });
  expect((await check(now)).pending).toEqual(pending);
  await expect(check(now + 1)).rejects.toMatchObject({ name: "PublicReleaseProtocolError", status: 409 });
  await expect(check(now, "22222222-2222-4222-8222-222222222222")).rejects.toMatchObject({ name: "PublicReleaseProtocolError", status: 409 });
  await db.doc(code.codePendingPath(state.next, operationId)).update({ sourceDigest: "f".repeat(64) });
  await expect(check(now)).rejects.toMatchObject({ name: "PublicReleaseProtocolError", status: 409 });
});
it("refuses a forged receipt and a held shared writer fence", async () => {
  const receipt = db.doc(`${switches.RECEIPTS}/${state.attempt.operationId}`), original = (await receipt.get()).data()!;
  await receipt.update({ selectorDigest: "f".repeat(64) });
  await expect(source()).rejects.toMatchObject({ name: "PublicReleaseProtocolError", status: 409 });
  await receipt.set(original);
  await db.doc("system/publicDeployment/releaseWriter/fence").set({ schemaVersion: 2, operationId: "another-writer", attemptDigest: "a".repeat(64) });
  expect(await source()).toBeNull();
});

const setLease = async () => {
  const selected = (await source())!;
  await db.doc(code.codePendingPath(state.next, operationId)).set({ schemaVersion: 2, kind: "switch-code-pending", operationId,
    pairDigest: protocol.publicReleaseDigest(state.next), scope: selected.scope, sourceDigest: protocol.publicReleaseDigest(selected.source),
    lease: { token, until: now + 60_000 }, nextAttemptAt: 0, failures: 0, lastFailure: null });
};
const snapshot = <T>(run: (read: (path: string) => Promise<any>) => Promise<T>) => db.runTransaction(transaction =>
  run(async path => (await transaction.get(db.doc(path))).data() ?? null), { readOnly: true });

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const objectRequest = (body = new TextEncoder().encode("{}"), operation = operationId) => {
  const sha = digest(body);
  return new Request(`http://pair-owner-write.internal/release-pair-inputs/v2/${state.next.pairId}/objects/${sha}.json`, {
    method: "PUT", body, headers: { "if-none-match": "*", "content-length": String(body.length),
      "x-owner-operation": operation, "x-owner-kind": "switch-code", "x-switch-code-lease": token,
      "x-pair-metadata": JSON.stringify({ schemaversion: "2", pairdigest: protocol.publicReleaseDigest(state.next), bodydigest: sha }) } });
};
const authority = () => ({ pair: state.next, read: async (path: string) => (await db.doc(path).get()).data() ?? null, codeSnapshot: snapshot });
it("permits only create-only own-pair CODE H bytes under its actual live source and lease", async () => {
  await setLease();
  const request = objectRequest(), data = new Uint8Array(await request.clone().arrayBuffer());
  let saved: any;
  const bucket = { put: vi.fn(async (_key: string, body: Uint8Array, options: any) => {
    saved = { size: body.length, customMetadata: options.customMetadata, data: body }; return { etag: "created" };
  }), get: async () => saved ? { ...saved, body: new Response(saved.data).body } : null };
  expect((await pairOwnerWriteRpc(request, bucket as any, authority(), () => now)).status).toBe(201);
  expect(bucket.put).toHaveBeenCalledTimes(1);
  expect(saved.data).toEqual(data);
  expect((await db.collection("cmsPublishQueue").get()).empty).toBe(true);
  expect((await db.collection("system/publicReleaseAdmissions/operations").get()).empty).toBe(true);
});
it.each(["receipt", "missing-receipt", "foreign-pair", "lease", "arbitrary-event", "hash", "size", "legacy-key", "cross-pair-key", "no-snapshot"])(
  "refuses CODE %s without issuing a storage write", async fault => {
    await setLease();
    const original = objectRequest(), headers = new Headers(original.headers);
    let url = original.url, body = new Uint8Array(await original.arrayBuffer()), auth = authority();
    if (fault === "receipt") await db.doc(`${switches.RECEIPTS}/${state.attempt.operationId}`).update({ selectorDigest: "f".repeat(64) });
    if (fault === "missing-receipt") await db.doc(`${switches.RECEIPTS}/${state.attempt.operationId}`).delete();
    if (fault === "foreign-pair") auth.pair = state.old;
    if (fault === "lease") headers.set("x-switch-code-lease", "22222222-2222-4222-8222-222222222222");
    if (fault === "arbitrary-event") headers.set("x-owner-operation", "arbitrary");
    if (fault === "hash") body = new TextEncoder().encode("[]");
    if (fault === "size") headers.set("content-length", "1");
    if (fault === "legacy-key") url = "http://pair-owner-write.internal/publications/object.json";
    if (fault === "cross-pair-key") url = url.replace(state.next.pairId, state.old.pairId);
    if (fault === "no-snapshot") auth.codeSnapshot = undefined as any;
    const bucket = { put: vi.fn(), get: vi.fn() };
    expect((await pairOwnerWriteRpc(new Request(url, { method: "PUT", headers, body }), bucket as any, auth, () => now)).status).toBe(403);
    expect(bucket.put).not.toHaveBeenCalled();
    expect((await db.collection("cmsPublishQueue").get()).empty).toBe(true);
  });
it("rechecks actual CODE authority after the body before any put", async () => {
  await setLease();
  const original = objectRequest(), originalBody = new Uint8Array(await original.clone().arrayBuffer());
  const request = new Proxy(original, { get(target, key) {
    if (key === "body") return new ReadableStream({ async start(controller) {
      await db.doc(`${switches.RECEIPTS}/${state.attempt.operationId}`).update({ selectorDigest: "f".repeat(64) });
      controller.enqueue(originalBody); controller.close();
    } });
    const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  const bucket = { put: vi.fn(), get: vi.fn() };
  expect((await pairOwnerWriteRpc(request, bucket as any, authority(), () => now)).status).toBe(403);
  expect(bucket.put).not.toHaveBeenCalled();
});

it("retains immutable CODE capture authority across a real unrelated source append during the request body", async () => {
  await setLease();
  const head = (await db.doc("system/publicReleaseChanges").get()).data()!;
  const root = (await db.doc(switches.ROOT).get()).data()!;
  const original = objectRequest(), data = new Uint8Array(await original.clone().arrayBuffer());
  let appended = false, saved: any;
  const request = new Proxy(original, { get(target, key) {
    if (key === "body") return new ReadableStream({ async start(controller) {
      try {
        await db.runTransaction(async transaction => {
          const snapshot = { title: "Concurrent staff settings" };
          const append = await producer.preparePublicReleaseProducerInTransaction({ firestore: db, transaction,
            operationId: "concurrent-staff-settings", changes: [{ kind: "settings", id: "branding", action: "publish", sourceVersion: 1, snapshot }] });
          append();
          transaction.set(db.doc("cmsSettings/branding"), { version: 1, published: snapshot });
          bumpPublicContextRevision(transaction, db);
        });
        appended = true; controller.enqueue(data); controller.close();
      } catch (error) { controller.error(error); }
    } });
    const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  const bucket = { put: vi.fn(async (_key: string, bytes: Uint8Array, options: any) => {
    saved = { size: bytes.length, customMetadata: options.customMetadata, data: bytes }; return { etag: "created" };
  }), get: async () => saved ? { ...saved, body: new Response(saved.data).body } : null };
  expect((await pairOwnerWriteRpc(request, bucket as any, authority(), () => now)).status).toBe(201);
  expect(appended).toBe(true); expect(bucket.put).toHaveBeenCalledTimes(1);
  expect(saved.data).toEqual(data);
  expect((await db.doc("system/publicReleaseChanges").get()).data()!.sequence).toBe(head.sequence + 1);
  expect((await db.doc(switches.ROOT).get()).data()).toEqual(root);
});
