import { beforeEach, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import firebase from "../../functions/lib/firebase.js";
import parser from "../../functions/lib/rundown-parser-store.js";
import structure from "../../functions/lib/rundown-document-structure.js";
import source from "../../functions/lib/rundown-source-store.js";
import { rundownDocument, sourceConfig } from "../fixtures/rundown.js";
const db = firebase.db, actor = { uid: "marker-producer", emailVerified: true }, now = 100000;
let id, ref;
const run = generation => parser.parseRundown(db, { sessionId: id, sourceGeneration: generation }, actor, now);
describe("private deterministic proposal cache", () => {
  beforeEach(async () => {
    if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Use the Firestore emulator.");
    id = randomUUID(); ref = db.doc(`liveProductionSessions/${id}`);
    await db.doc("users/marker-producer").set({ active: true, grants: [{ role: "editor" }] });
    await ref.set({ schemaVersion: 1, id, title: "Synthetic show", productionProgramId: "synthetic", publicProgramId: null,
      showPlanId: null, deviceId: null, generation: 1, mappingVersion: 1, state: "draft", createdAtMs: now, updatedAtMs: now });
    await ref.collection("rundown").doc("source").set({ config: sourceConfig, configVersion: 1, generation: 1 });
    await ref.collection("rundownSnapshots").doc("current").set({ ...structure.structureDocument(rundownDocument(), sourceConfig),
      configVersion: 1, generation: 1, expiresAtMs: now + 10000, purgeAt: Timestamp.fromMillis(now + 10000) });
  });
  it("writes only review proposals, reuses identical input and refreshes cache retention", async () => {
    const first = await run(1), second = await run(1);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(first.parsed.proposals.map(value => value.text.templateId)).toEqual(["headline", "name_title"]);
    expect((await ref.collection("banners").get()).empty).toBe(true);
    expect((await ref.collection("commands").get()).empty).toBe(true);
    await ref.collection("rundownSnapshots").doc("current").update({ expiresAtMs: now + 20000 });
    expect((await run(1)).parsed.expiresAtMs).toBe(now + 20000);
  });
  it("rejects stale generations, expired sources and configuration mismatches without replacing the cache", async () => {
    const first = await run(1);
    await expect(run(2)).rejects.toThrow(/changed/);
    await ref.collection("rundownSnapshots").doc("current").update({ configVersion: 2 });
    await expect(run(1)).rejects.toThrow(/configuration/);
    await ref.collection("rundownSnapshots").doc("current").update({ configVersion: 1, expiresAtMs: now });
    await expect(run(1)).rejects.toThrow(/Refresh/);
    expect((await ref.collection("rundownProposals").doc("current").get()).data().cacheKey).toBe(first.parsed.cacheKey);
  });
  it("removes private proposal passages when source settings change", async () => {
    await run(1);
    await source.rundownSourceRequest(db, { action: "set_source", sessionId: id, baseConfigVersion: 1,
      config: { ...sourceConfig, enabled: false } }, actor, { clock: () => now });
    expect((await ref.collection("rundownSnapshots").doc("current").get()).exists).toBe(false);
    expect((await ref.collection("rundownProposals").doc("current").get()).exists).toBe(false);
  });
});
