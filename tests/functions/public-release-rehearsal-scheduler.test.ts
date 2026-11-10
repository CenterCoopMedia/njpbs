import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { FieldValue } from "firebase-admin/firestore";
import { isolatedFirestore, clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { seedSwitch } from "../helpers/public-release-switch.js";
import { createRehearsalPublicOwners } from "../../scripts/lib/rehearsal-public-owners.mjs";
import { rehearsalOperationId } from "../../scripts/lib/public-release-rehearsal.mjs";
import save from "../../functions/save.js";
import scheduler from "../../functions/scheduled-publish.js";
import admission from "../../functions/lib/public-release-admission.js";
import protocol from "../../functions/lib/public-release-pair.js";

const require = createRequire(import.meta.url);
const scoped = require("../../functions/lib/public-release-rehearsal-schedule.js");
const db = isolatedFirestore("rehearsal-scheduler");
const fixtureDb = new Proxy(db, { get(target, key) {
  if (key === "projectId") return "njpbs-site-dev";
  const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
} });
const targetId = "bound-source", otherId = "unrelated-source";
const savedAt = "2026-11-03T23:00:00.000Z", dueAt = "2026-11-03T23:30:00.000Z";
const quiet = { info() {}, warn() {}, error() {} };
const actor = { uid: "rehearsal-editor", principal: { id: "rehearsal-editor", grants: [{ role: "admin" }] } };
const legacy = vi.fn(async () => { throw new Error("Legacy work must not escape a scoped pair schedule"); });
let seeded: Awaited<ReturnType<typeof seedSwitch>>, source: any;

beforeEach(async () => {
  for (const key of ['FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_CONFIG', 'GOOGLE_APPLICATION_CREDENTIALS', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT']) vi.stubEnv(key, undefined);
  legacy.mockClear();
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
  const contract = { schemaVersion: 2, families: ["posts"], features: [] };
  seeded = await seedSwitch(fixtureDb, { admittedContract: contract });
  await db.doc(`${admission.CONTRACTS}/${protocol.publicReleaseDigest(contract)}`).set(contract);
  await db.doc(`${admission.ADMISSIONS}/controls/adoption`).set({ schemaVersion: 2, enabled: true });
  await db.doc("sections/news").set({ label: "News" });
  const handler = save.createCmsSaveHandler({ firestore: fixtureDb, requirePrincipalFn: async () => actor,
    enablePublishSnapshot: true, now: () => savedAt, assertPublishReadyFn: legacy, log: quiet });
  for (const id of [targetId, otherId]) {
    await db.doc(`cmsPosts/${id}`).set({ id, type: "post", title: `Scheduled ${id}`, summary: "Source-bound schedule proof.",
      status: "draft", createdBy: actor.uid, section: "news", slug: `${id}-story`, previousSlugs: [], locale: "en",
      tags: [], categories: [], date: "2026-11-03", credits: [{ kind: "custom", name: "Rehearsal desk" }],
      blocks: [], version: 1, updatedAt: savedAt });
    const response = { code: 200, body: undefined as any, headersSent: false, status(code: number) { this.code = code; return this; },
      set() { return this; }, json(body: unknown) { this.body = body; this.headersSent = true; return this; } };
    await handler({ method: "POST", headers: {}, ip: "127.0.0.1", body: {
      collection: "cmsPosts", id, baseVersion: 1, scheduleAt: dueAt, document: {},
    } }, response);
    expect(response.code, JSON.stringify(response.body)).toBe(200);
  }
  const saved = (await db.doc(`cmsPosts/${targetId}`).get()).data()!;
  source = { collection: "cmsPosts", id: targetId, version: saved.version, publishAt: saved.publishAt };
});
afterEach(() => vi.unstubAllEnvs());

const binding = (firestore = db, pair = seeded.old) => scoped.createRehearsalScheduledSourceBinding({ firestore,
  configuration: scoped.CONFIGURATION, runId: "rehearsal-scheduler", pair, source, authorized: true });
const runner = (firestore: any, sourceBinding: any, reconcile = vi.fn(async () => {})) => scheduler.createScheduledPublishRunner({
  firestore, sourceBinding, now: () => dueAt, log: quiet, reconcileStaleFn: reconcile,
  assertPublishReadyFn: legacy, assertPublishedMediaSafeFn: legacy, enqueuePublishFn: legacy,
});

it("runs only the named source through the actual scheduler and preserves its original acceptance on retry", async () => {
  const untouched = await db.doc(`cmsPosts/${otherId}`).get();
  const packet = { schemaVersion: 1, runId: "rehearsal-scheduler", projectId: db.projectId,
    emulatorHost: process.env.FIRESTORE_EMULATOR_HOST, ingressOrigin: "http://127.0.0.1:18396", proofOrigin: "http://127.0.0.1:18397",
    adapter: resolve("scripts/lib/public-release-rehearsal-adapter.mjs"), oldPair: seeded.old, newPair: seeded.next,
    previewPairs: { old: { pairId: "preview-old", rendererSha: seeded.old.commitSha, serializerId: "preview-old" },
      new: { pairId: "preview-new", rendererSha: seeded.next.commitSha, serializerId: "preview-new" } },
    scheduledSource: { collection: source.collection, documentId: source.id, version: source.version, publishAt: source.publishAt } };
  const unavailable = async () => { throw new Error("No renderer, provider or terminal call belongs to acceptance"); };
  const owners = createRehearsalPublicOwners({ packet, firestore: db, store: { get: unavailable, put: unavailable },
    credentials: unavailable, ingress: { prove: unavailable }, fieldValues: FieldValue, scheduleNow: () => dueAt, authorized: true });
  const operationId = rehearsalOperationId(packet, "scheduled");
  const accepted = await owners.acceptScheduled({ operationId, target: "old" });
  expect(accepted.source).toMatchObject({ id: targetId, sourceVersion: source.version + 1 });
  const queue = await db.doc(`cmsPublishQueue/${operationId}`).get();
  expect(queue.data()).toMatchObject({ status: "pending", transport: admission.TRANSPORT, triggeredBy: scheduler.SCHEDULER_ACTOR,
    execution: null, terminalReceipt: null });
  await db.doc(`cmsPosts/${targetId}`).update({ version: source.version + 2, title: "Later private edit" });
  expect(await owners.acceptScheduled({ operationId, target: "old" })).toEqual(accepted);
  expect((await queue.ref.get()).updateTime!.isEqual(queue.updateTime!)).toBe(true);
  expect((await untouched.ref.get()).updateTime!.isEqual(untouched.updateTime!)).toBe(true);
  expect((await untouched.ref.get()).data()).toEqual(untouched.data());
  expect((await db.collection(`${admission.ADMISSIONS}/operations`).get()).size).toBe(1);
  expect(legacy).not.toHaveBeenCalled();
});

it("refuses production configuration even for a previously allocated development binding", async () => {
  const sourceBinding = binding();
  const before = await db.doc(`cmsPosts/${targetId}`).get();
  vi.stubEnv("CMS_DEPLOYMENT_ENVIRONMENT", "production");
  expect(() => binding()).toThrow("binding refused");
  await expect(runner(db, sourceBinding)()).rejects.toThrow("binding refused");
  expect((await before.ref.get()).updateTime!.isEqual(before.updateTime!)).toBe(true);
  expect((await db.collection(`${admission.ADMISSIONS}/operations`).get()).empty).toBe(true);
});

it("refuses unnamed configurations and serialized handles", async () => {
  expect(() => scoped.createRehearsalScheduledSourceBinding({ firestore: db, configuration: "ordinary-cron",
    runId: "rehearsal-scheduler", pair: seeded.old, source, authorized: true })).toThrow("binding refused");
  await expect(runner(db, JSON.parse(JSON.stringify(binding())))()).rejects.toThrow("binding refused");
});

it("rechecks the exact version inside the actual acceptance transaction", async () => {
  let changed = false;
  const racing = new Proxy(db, { get(target, key) {
    if (key === "runTransaction") return async (execute: any, options: any) => {
      if (!changed) { changed = true; await db.doc(`cmsPosts/${targetId}`).update({ version: source.version + 1 }); }
      return target.runTransaction(execute, options);
    };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  const reconcile = vi.fn(async () => {});
  expect((await runner(racing, binding(racing), reconcile)()).publishedCount).toBe(0);
  expect((await db.doc(`cmsPosts/${targetId}`).get()).data()).toMatchObject({ status: "scheduled", version: source.version + 1 });
  expect((await db.collection(`${admission.ADMISSIONS}/operations`).get()).empty).toBe(true);
  expect(reconcile).not.toHaveBeenCalled();
});

it("pins the original publishAt even when a different due time is observed by the query", async () => {
  const sourceBinding = binding();
  await db.doc(`cmsPosts/${targetId}`).update({ publishAt: "2026-11-03T23:29:59.000Z" });
  expect((await runner(db, sourceBinding)()).publishedCount).toBe(0);
  expect((await db.doc(`cmsPosts/${targetId}`).get()).data()).toMatchObject({ status: "scheduled", version: source.version });
  expect((await db.collection(`${admission.ADMISSIONS}/operations`).get()).empty).toBe(true);
});

it("requires the bound selected pair in the source transaction", async () => {
  expect((await runner(db, binding(db, seeded.next))()).publishedCount).toBe(0);
  expect((await db.doc(`cmsPosts/${targetId}`).get()).data()).toMatchObject({ status: "scheduled", version: source.version });
  expect((await db.collection(`${admission.ADMISSIONS}/operations`).get()).empty).toBe(true);
});

it("finds the exact due source beyond a full unrelated global scan without publishing that backlog", async () => {
  const batch = db.batch();
  for (let index = 0; index < 201; index++) batch.create(db.doc(`cmsPosts/earlier-${index}`), {
    type: 'post', status: 'scheduled', version: 1, publishAt: '2026-11-03T23:29:00.000Z',
  });
  await batch.commit();
  const reconcile = vi.fn(async () => {});
  expect((await runner(db, binding(), reconcile)()).publishedCount).toBe(1);
  expect((await db.doc(`cmsPosts/${targetId}`).get()).data()).toMatchObject({ status: 'published', version: source.version + 1 });
  expect((await db.collection('cmsPosts').where('status', '==', 'scheduled').get()).size).toBe(202);
  expect((await db.collection(`${admission.ADMISSIONS}/operations`).get()).size).toBe(1);
  expect(reconcile).not.toHaveBeenCalled(); expect(legacy).not.toHaveBeenCalled();
});

it("retains the default unbound scan and legacy reconciliation behavior", async () => {
  const reconcile = vi.fn(async () => {});
  const unbound = runner(db, undefined, reconcile);
  expect((await unbound()).publishedCount).toBe(2);
  expect((await unbound()).publishedCount).toBe(0);
  expect(reconcile).toHaveBeenCalledOnce();
});
