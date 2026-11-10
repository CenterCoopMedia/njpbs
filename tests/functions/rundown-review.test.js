import { beforeEach, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import firebase from "../../functions/lib/firebase.js";
import store from "../../functions/lib/rundown-review-store.js";
import marker from "../../functions/lib/rundown-marker-parser.js";
import structure from "../../functions/lib/rundown-document-structure.js";
import { rundownDocument, sourceConfig, paragraph } from "../fixtures/rundown.js";
const db = firebase.db, actor = { uid: "review-producer", emailVerified: true }, now = 100000;
let id, ref, generation;
async function source(headline = "BANNER: SYNTHETIC CITY HEARING", ambiguous = false) {
  generation++;
  const doc = rundownDocument(headline);
  if (ambiguous) doc.tabs[0].childTabs[0].documentTab.body.content = [paragraph("LOWER THIRDS:"), paragraph("ALEX EXAMPLE"), paragraph("SYNTHETIC REPORTER")];
  const snapshot = { ...structure.structureDocument(doc, sourceConfig), generation, configVersion: 1,
    expiresAtMs: now + 100000, purgeAt: Timestamp.fromMillis(now + 100000) };
  const parsed = { ...marker.extractMarkedBanners(snapshot), configVersion: 1, cacheKey: `cache-${generation}`,
    documentId: sourceConfig.documentId, expiresAtMs: snapshot.expiresAtMs, purgeAt: snapshot.purgeAt };
  await ref.collection("rundown").doc("source").set({ generation, configVersion: 1, config: sourceConfig });
  await ref.collection("rundownSnapshots").doc("current").set(snapshot);
  await ref.collection("rundownProposals").doc("current").set(parsed);
}
const review = async () => (await store.reconcileRundown(db, { sessionId: id, sourceGeneration: generation }, actor, now)).review;
function decision(view, change, action = "accept", extras = {}) {
  return { sessionId: id, sourceGeneration: generation, requestId: randomUUID(), reviewVersion: view.version,
    suggestionId: change.id, baseVersion: change.target?.baseVersion ?? 0, action,
    ...(action === "accept" && change.candidate?.text ? { text: change.candidate.text } : {}), ...extras };
}
const decide = request => store.decideRundown(db, request, actor, now);
describe("versioned Accept and Ignore transactions", () => {
  beforeEach(async () => {
    if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Use the Firestore emulator.");
    id = randomUUID(); ref = db.doc(`liveProductionSessions/${id}`); generation = 0;
    await db.doc("users/review-producer").set({ active: true, grants: [{ role: "editor" }] });
    await ref.set({ schemaVersion: 1, id, title: "Synthetic show", productionProgramId: "synthetic", publicProgramId: null,
      showPlanId: null, deviceId: null, generation: 1, mappingVersion: 1, state: "draft", createdAtMs: now, updatedAtMs: now });
    await source();
  });
  it("accepts a new draft once, retries a receipt safely, and never issues a command", async () => {
    const current = await review(), change = current.changes[0], request = decision(current, change);
    const accepted = await decide(request);
    expect(accepted).toMatchObject({ decision: "accepted", draftVersion: 1, replayed: false });
    expect(await decide(request)).toMatchObject({ bannerId: accepted.bannerId, replayed: true });
    expect((await ref.collection("banners").get()).size).toBe(1);
    expect((await ref.collection("commands").get()).empty).toBe(true);
    expect((await review()).changes.map(item => item.candidate?.text.templateId)).toEqual(["name_title"]);
  });
  it("persists ignored fingerprints through reconciliation but surfaces a newer source edit", async () => {
    const current = await review();
    await decide(decision(current, current.changes[0], "ignore"));
    expect((await review()).changes).toHaveLength(1);
    await source(); // Identical content, synthetic generation changed.
    expect((await review()).changes).toHaveLength(1);
    await source("BANNER: GENUINELY NEW SOURCE");
    expect((await review()).changes).toHaveLength(2);
  });
  it("requires explicit producer edits and preserves actual source text separately", async () => {
    let current = await review();
    const request = decision(current, current.changes[0], "accept", { text: { templateId: "headline", headline: "PRODUCER WORDING" } });
    await expect(decide(request)).rejects.toThrow(/Confirm edited proposal fields/);
    const accepted = await decide({ ...request, editedFields: ["headline"] });
    const bannerRef = ref.collection("banners").doc(accepted.bannerId);
    let saved = (await bannerRef.get()).data();
    expect(saved.rundown.sourceText.headline).toBe("SYNTHETIC CITY HEARING");
    expect(saved.record.draft.text.headline).toBe("PRODUCER WORDING");
    expect(saved.rundown.protectedFields).toContain("headline");
    await source("BANNER: A LATER SOURCE REVISION");
    current = await review();
    await decide(decision(current, current.changes.find(item => item.target?.bannerId === accepted.bannerId)));
    saved = (await bannerRef.get()).data();
    expect(saved.record.draft.text.headline).toBe("PRODUCER WORDING");
    expect(saved.rundown.sourceText.headline).toBe("A LATER SOURCE REVISION");
  });
  it("tracks producer wording independently from an ambiguous proposal's template mapping", async () => {
    await source(undefined, true);
    const current = await review(), change = current.changes.find(item => item.candidate?.text === null);
    const request = decision(current, change, "accept", { text: { templateId: "name_title", name: "PRODUCER NAME", title: "SYNTHETIC REPORTER" } });
    await expect(decide(request)).rejects.toThrow(/Confirm edited proposal fields/);
    const accepted = await decide({ ...request, editedFields: ["name"] });
    const saved = (await ref.collection("banners").doc(accepted.bannerId).get()).data();
    expect(saved.rundown.sourceText).toBeNull();
    expect(saved.rundown.resolutionText).toEqual({ templateId: "name_title", name: "ALEX EXAMPLE", title: "SYNTHETIC REPORTER" });
    expect(saved.rundown.protectedFields).toEqual(["name", "templateId"]);
  });
  it("rejects two-editor/stale-source decisions and a concurrent producer save", async () => {
    let current = await review();
    const request = decision(current, current.changes[0]);
    const accepted = await decide(request);
    await expect(decide({ ...request, requestId: randomUUID() })).rejects.toThrow(/changed/);
    await source("BANNER: NEW SOURCE");
    current = await review();
    const changed = current.changes.find(item => item.target?.bannerId === accepted.bannerId), next = decision(current, changed);
    expect(changed.target.sourceContext).toBe("Selected show / City hearing");
    await ref.collection("banners").doc(accepted.bannerId).update({ "record.draft.version": 2, "record.draft.text.headline": "MANUAL EDIT" });
    await expect(decide(next)).rejects.toThrow(/changed/);
    current = await review();
    const stale = decision(current, current.changes.find(item => item.target?.bannerId === accepted.bannerId));
    await source("BANNER: EVEN NEWER SOURCE");
    await expect(decide(stale)).rejects.toThrow(/changed|Refresh/);
  });
  it("keeps manual fields, cue and confirmed live snapshots intact until a deliberate field override", async () => {
    let current = await review();
    const accepted = await decide(decision(current, current.changes[0]));
    const bannerRef = ref.collection("banners").doc(accepted.bannerId), before = (await bannerRef.get()).data();
    const snapshot = { bannerId: accepted.bannerId, sessionId: id, version: 1, mappingVersion: 1, text: before.record.draft.text };
    const cue = { id: "synthetic-cue", capturedAtMs: now, snapshot };
    const confirmedLive = { commandId: "synthetic-take", observationSequence: 1, observedAtMs: now, snapshot };
    await bannerRef.update({ "record.cue": cue, "record.confirmedLive": confirmedLive,
      "record.draft.version": 2, "record.draft.text.headline": "MANUAL PRODUCER EDIT", order: 9 });
    await source("BANNER: SOURCE REVISION TWO");
    current = await review();
    let change = current.changes.find(item => item.target?.bannerId === accepted.bannerId);
    expect(change.target.protectedFields).toEqual(["headline", "order"]);
    await decide(decision(current, change));
    let after = (await bannerRef.get()).data();
    expect(after.record.draft.text.headline).toBe("MANUAL PRODUCER EDIT");
    expect(after.order).toBe(9);
    expect(after.record.cue).toEqual(cue); expect(after.record.confirmedLive).toEqual(confirmedLive);
    await source("BANNER: SOURCE REVISION THREE");
    current = await review(); change = current.changes.find(item => item.target?.bannerId === accepted.bannerId);
    expect(change.target.protectedFields).toEqual(["headline", "order"]);
    await decide(decision(current, change, "accept", { overrideFields: ["headline"] }));
    after = (await bannerRef.get()).data();
    expect(after.record.draft.text.headline).toBe("SOURCE REVISION THREE"); expect(after.order).toBe(9);
    expect(after.record.cue).toEqual(cue); expect(after.record.confirmedLive).toEqual(confirmedLive);
  });
  it("acknowledges missing source text while retaining its draft and protects unrelated manual banners", async () => {
    let current = await review(); const accepted = await decide(decision(current, current.changes[0]));
    const bannerRef = ref.collection("banners").doc(accepted.bannerId), before = (await bannerRef.get()).data();
    await ref.collection("banners").doc("manual").set({ ...before, source: "manual", rundown: null,
      record: { ...before.record, id: "manual" } });
    await source("SCRIPT: no banner now");
    current = await review();
    const removed = current.changes.find(item => item.status === "REMOVED");
    await decide(decision(current, removed));
    const after = (await bannerRef.get()).data();
    expect(after.record).toEqual(before.record); expect(after.archived).toBe(false);
    expect((await review()).changes.some(item => item.target?.bannerId === accepted.bannerId)).toBe(false);
    await source("SCRIPT: unrelated story edit");
    expect((await review()).changes.some(item => item.target?.bannerId === accepted.bannerId)).toBe(false);
    expect((await ref.collection("banners").doc("manual").get()).data().record.draft).toEqual(before.record.draft);
  });
  it("keeps ignored removals quiet through unrelated edits but surfaces a new absence after a return", async () => {
    let current = await review(); const accepted = await decide(decision(current, current.changes[0]));
    await source("SCRIPT: no headline now");
    current = await review(); const removed = current.changes.find(item => item.target?.bannerId === accepted.bannerId);
    await decide(decision(current, removed, "ignore"));
    await source("SCRIPT: unrelated edit while still absent");
    expect((await review()).changes.some(item => item.target?.bannerId === accepted.bannerId)).toBe(false);
    await source(); await review();
    await source("SCRIPT: removed a second time");
    expect((await review()).changes.some(item => item.status === "REMOVED" && item.target?.bannerId === accepted.bannerId)).toBe(true);
  });
});
