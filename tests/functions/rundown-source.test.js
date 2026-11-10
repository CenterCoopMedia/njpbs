import { beforeEach, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import firebase from "../../functions/lib/firebase.js";
import source from "../../functions/lib/rundown-source-store.js";
import structure from "../../functions/lib/rundown-document-structure.js";
import { rundownDocument, sourceConfig } from "../fixtures/rundown.js";

const db = firebase.db, actor = { uid: "rundown-producer", emailVerified: true };
let id, now;
const request = (action, extras = {}, reader = async () => ({ snapshot: structure.structureDocument(rundownDocument(), sourceConfig),
  drive: { version: "1", modifiedTime: "2026-10-26T12:00:00Z" }, apiRequests: 3 })) =>
  source.rundownSourceRequest(db, { action, sessionId: id, ...extras }, actor, { clock: () => now, readGoogle: reader });
const refresh = (reader, manual = false) => request("refresh_source", { manual }, reader);
describe("rundown refresh transaction fences", () => {
  beforeEach(async () => {
    if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Use the Firestore emulator.");
    id = randomUUID(); now = 100000;
    await db.doc("users/rundown-producer").set({ active: true, grants: [{ role: "editor" }] });
    await db.doc(`liveProductionSessions/${id}`).set({ schemaVersion: 1, id, title: "Synthetic show", productionProgramId: "synthetic",
      publicProgramId: null, showPlanId: null, deviceId: "synthetic-device", generation: 1, mappingVersion: 1, state: "active", createdAtMs: now, updatedAtMs: now });
    await request("set_source", { config: sourceConfig, baseConfigVersion: 0 });
  });
  it("commits one generation, preserves last good content after access loss and backs off", async () => {
    const first = await refresh();
    expect(first.source.generation).toBe(1);
    now += source.POLL_MS;
    const failed = await refresh(async () => { throw { status: 403 }; });
    expect(failed.source).toMatchObject({ generation: 1, status: "access_lost", failures: 1 });
    expect(failed.snapshot.hash).toBe(first.snapshot.hash);
    const configSaved = await request("set_source", { baseConfigVersion: 1, config: sourceConfig });
    expect(configSaved.source.apiRequests).toBe(3);
    expect(configSaved.source.nextAttemptAtMs).toBe(failed.source.nextAttemptAtMs);
    expect(configSaved.source.failures).toBe(1);
    let calls = 0;
    await refresh(async () => { calls++; });
    expect(calls).toBe(0);
    expect((await db.collection(`liveProductionSessions/${id}/commands`).get()).empty).toBe(true);
    now += source.RETENTION_MS;
    expect((await request("get_source")).snapshot).toBeNull();
  });
  it("serializes concurrent external reads and rejects a late result after reconfiguration", async () => {
    let release, entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    const pending = refresh(async () => { entered(); return new Promise(resolve => { release = resolve; }); });
    await waiting;
    let calls = 0;
    await refresh(async () => { calls++; });
    expect(calls).toBe(0);
    await request("set_source", { baseConfigVersion: 1, config: { ...sourceConfig, tabIds: ["show"] } });
    release({ snapshot: structure.structureDocument(rundownDocument(), sourceConfig), drive: { version: "1" }, apiRequests: 3 });
    const result = await pending;
    expect(result.source.configVersion).toBe(2);
    expect(result.snapshot).toBeNull();
  });
  it("stops automatic reads for inactive sessions and discards results after session end", async () => {
    const ref = db.doc(`liveProductionSessions/${id}`);
    await ref.update({ state: "ready" });
    let calls = 0;
    expect((await refresh(async () => { calls++; })).snapshot).toBeNull();
    expect(calls).toBe(0);
    await ref.update({ state: "active" });
    const result = await refresh(async () => {
      await ref.update({ state: "ended", generation: 2 });
      return { snapshot: structure.structureDocument(rundownDocument(), sourceConfig), drive: { version: "1" }, apiRequests: 3 };
    });
    expect(result.snapshot).toBeNull();
    await expect(request("set_source", { baseConfigVersion: 1, config: sourceConfig })).rejects.toThrow(/ended/);
  });
  it("does not advance a generation for metadata-only activity and rechecks staff access", async () => {
    const first = await refresh();
    now += source.POLL_MS;
    const same = await refresh(async () => ({ snapshot: { ...first.snapshot, revisionId: "new-metadata" }, drive: { version: "2" }, apiRequests: 3 }));
    expect(same.source.generation).toBe(1);
    expect(same.snapshot.revisionId).toBe("new-metadata");
    await db.doc("users/rundown-producer").update({ active: false });
    await expect(request("get_source")).rejects.toThrow(/editorial/);
  });
});
