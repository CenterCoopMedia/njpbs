import { beforeAll, afterAll, beforeEach, afterEach, expect, it } from "vitest";
import { createRequire } from "node:module";
import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { seedSwitch } from "../helpers/public-release-switch.js";
import { schedulePacketFixture } from "./page-schedule-packet-fixture";
import { backgroundStorageFixture } from "./background-storage-fixture";
import { projectPublishedPageRead } from "../../site/src/lib/published-page-render";
import "../../functions/lib/firebase.js";
const require = createRequire(import.meta.url);
const p = require("../../functions/lib/public-release-pair.js");
const a = require("../../functions/lib/public-release-admission.js");
const historical = require("../../functions/lib/public-release-historical-code.js");
const work = require("../../functions/lib/public-release-pair-work.js");
const source = require("../../functions/lib/no-build-page-publication.js");
const schedules = require("../../functions/lib/no-build-page-schedule-reader.js");
const snapshots = require("../../functions/lib/publish-snapshot.js");
const save = require("../../functions/save.js");
const target = require("../../functions/lib/publication-target.js").publicationTarget("development");
const db = isolatedFirestore("public-release-page-schedule.test.ts");
let firestore: any;
const contract = { schemaVersion: 2, families: ["pages"], features: [] };
const instant = "2026-10-12T12:00:00.000Z", actor = { uid: "schedule-editor" };
let fixture: Awaited<ReturnType<typeof schedulePacketFixture>>;
let boundary: Awaited<ReturnType<typeof backgroundStorageFixture>>;
let selector: any, pair: any;
beforeAll(async () => { boundary = await backgroundStorageFixture(target.backgroundBucket); });
afterAll(async () => { await boundary?.close(); });
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
  firestore = new Proxy(db, { get(owner, key) { if (key === "projectId") return "njpbs-site-dev";
    const value = Reflect.get(owner, key); return typeof value === "function" ? value.bind(owner) : value; } });
  const seeded = await seedSwitch(firestore, { admittedContract: contract }); selector = seeded.selector; pair = seeded.old;
  await db.doc(`${a.CONTRACTS}/${p.publicReleaseDigest(contract)}`).set(contract);
  await db.doc(`${a.ADMISSIONS}/controls/adoption`).set({ schemaVersion: 2, enabled: true });
  await db.doc("system/noBuildPostAdmission").set({ schemaVersion: 2, revision: 1, enabled: true,
    families: { pages: { mode: "all" } }, backgroundBucket: target.backgroundBucket });
  boundary.objects.clear(); boundary.reads.length = 0; boundary.writes.length = 0;
  fixture = await schedulePacketFixture({ firestore, rendererSha: pair.commitSha, generation: 37, target, boundary });
  fixture.refuseCode();
  await db.doc("system/publicDeployment/noBuildPages/capability").update({ generation: selector.activeGeneration });
});
afterEach(async () => { await fixture?.close(); });
const capture = () => source.capturePageScheduleForPublication({ firestore, target, collection: "cmsPages", documentId: "schedule",
  publishing: true, config: { valid: false, enabled: false, families: {} }, releaseSelector: selector,
  currentCodeRequest: fixture.request, now: () => Date.parse(instant) });
it.each(["schedule", "live"].flatMap(id => ["publish", "schedule"].map(action => ({ id, action }))))(
  "captures first-adoption $id through actual Save $action with no prior legacy Page owner", async ({ id, action }) => {
    const user = { ...actor, principal: { id: actor.uid, grants: [{ role: "admin" }] } };
    await db.doc(`cmsPages/${id}`).set({ id, template: "programLanding", section: "watch", version: 1,
      title: id, blocks: [], status: "draft", createdBy: actor.uid });
    const handler = save.createCmsSaveHandler({ firestore, requirePrincipalFn: async () => user,
      enablePublishSnapshot: true, now: () => instant, currentCodeRequest: fixture.request,
      assertPublishReadyFn: async () => { throw new Error("Pair publication must not use legacy build readiness"); },
      log: { info() {}, warn() {}, error() {} } });
    const response = { code: 200, headersSent: false, body: undefined as any, set() { return this; },
      status(code: number) { this.code = code; return this; }, json(body: any) { this.body = body; this.headersSent = true; return this; } };
    await handler({ method: "POST", headers: {}, ip: "127.0.0.1", body: { collection: "cmsPages", id, baseVersion: 1,
      document: {}, ...(action === "publish" ? { publish: true } : { scheduleAt: "2026-10-12T15:00:00.000Z" }) } }, response);
    expect(response.code, JSON.stringify(response.body)).toBe(200);
    if (action === "publish") expect(response.body.publication.transport).toBe(a.TRANSPORT);
    else expect((await db.doc(`cmsPages/${id}`).get()).data()).toMatchObject({ status: "scheduled", scheduledPublicationTransport: a.TRANSPORT });
    expect(fixture.codeRequests()).toBe(0);
  });
it.each(["schedule", "live"])("admits %s with actual retained pair CODE and original provider packet bytes", async pageId => {
  // Pair capture uses its explicit selector even when a caller's legacy hint
  // is unselected. Actual source acceptance still checks stored admission.
  expect((await db.doc(`system/publicDeployment/noBuildPageOwners/${pageId}`).get()).exists).toBe(false);
  expect(await source.capturePageScheduleForPublication({ firestore, target, collection: "cmsPages", documentId: pageId,
    publishing: true, config: { valid: false, enabled: false, families: {} },
    currentCodeRequest: fixture.request, now: () => Date.parse(instant) })).toBeUndefined();
  const publication = (await db.doc(`${work.publicReleasePairPath(pair.pairId)}/codePacks/publication`).get()).data();
  const originalCode = await historical.readRetainedPublicReleaseCode({ firestore, descriptor: publication!.historicalCode });
  expect(originalCode.publication.generation).not.toBe(selector.activeGeneration);
  const readCode = schedules.createPageCurrentCodeContextReader({ firestore, target, rendererSha: pair.commitSha, releaseSelector: selector });
  expect(await readCode()).toEqual(originalCode);
  expect(JSON.stringify(await readCode())).toBe(JSON.stringify(originalCode));
  const captured = await capture();
  expect(captured).toBeDefined();
  const document = { id: pageId, template: "programLanding", section: "watch", version: 2, title: pageId, blocks: [],
    status: "published", publiclyVisible: true, publishAt: instant, published: undefined as any };
  document.published = snapshots.createPublishedSnapshot({ collection: "cmsPages", document, publishedAt: instant, publishedBy: actor.uid });
  await db.runTransaction(async transaction => {
    const prepared = await source.preparePairPagePublication({ firestore, transaction, documentId: pageId,
      nextDocument: document, queueRef: db.doc(`cmsPublishQueue/${"A".repeat(20)}`), actor, target, pageScheduleCapture: captured });
    prepared.write(); transaction.set(db.doc(`cmsPages/${pageId}`), document);
  });
  expect((await db.doc(`cmsPublishQueue/${"A".repeat(20)}`).get()).data()).toMatchObject({ status: "pending", transport: a.TRANSPORT });
  const freshCapture = await capture();
  const context = await db.runTransaction(transaction => require("../../functions/lib/no-build-page-render-context.js")
    .assertNoBuildPageContextInTransaction({ firestore, transaction, pageId, rendererSha: pair.commitSha,
      now: new Date(instant), scheduleCapture: freshCapture, target }));
  expect(context.sourceSeal.codeGeneration).toBe(originalCode.publication.generation);
  const rendered = await projectPublishedPageRead(context, pageId, pair.commitSha, new Date(instant));
  expect(rendered.schedule!.receipt.code.generation).toBe(originalCode.publication.generation);
  expect(fixture.codeRequests()).toBe(0);
  expect((await historical.readRetainedPublicReleaseCode({ firestore, descriptor: publication!.historicalCode }))).toEqual(originalCode);
});
it("refuses a changed selected epoch while preserving the captured original CODE", async () => {
  const captured = await capture();
  expect(captured).toBeDefined();
  await db.doc("system/publicDeployment").update({ epoch: selector.epoch + 1 });
  await expect(db.runTransaction(transaction => schedules.readCapturedPageScheduleInTransaction({ firestore, transaction,
    target, rendererSha: pair.commitSha, capture: captured }))).rejects.toThrow();
  expect(fixture.codeRequests()).toBe(0);
});
it("refuses a cold corrupted retained CODE read without using a mutable CODE transport", async () => {
  const publication = (await db.doc(`${work.publicReleasePairPath(pair.pairId)}/codePacks/publication`).get()).data();
  await db.doc(`${historical.CHUNKS}/${publication!.historicalCode.chunks[0]}`).update({ base64: Buffer.from("corrupt").toString("base64") });
  await expect(capture()).rejects.toThrow();
  expect(fixture.codeRequests()).toBe(0);
});
