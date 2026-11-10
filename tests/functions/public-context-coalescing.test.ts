import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import publication from "../../functions/lib/public-context-publication.js";
import context from "../../functions/lib/public-context-revision.js";
import background from "../../functions/lib/post-background-outputs.js";
import alerts from "../../functions/lib/post-background-alerts.js";
import homeAdmission from "../../functions/lib/home-source-selection-admission.js";
import settingsPublication from "../../functions/lib/settings-publication.js";
import { firebaseAdminRuntime } from "../../site/scripts/firebase-admin-runtime";
import { noBuildPostMaintenance } from "../../site/scripts/no-build-post-background";
import { createNoBuildPreparationStorage, backgroundInputFiles, backgroundOutputFiles } from "../../site/scripts/no-build-preparation-storage";
import { backgroundStorageFixture } from "./background-storage-fixture";
import { readPublicationHealth } from "../../publisher/publication-health";

const runtime = { owner: "cloudflare" as const, release: "a".repeat(40) };
const epoch = 1_800_000_000_000;
const id = (revision: number) => String(revision).padStart(20, "0");
const paths = { listings: ["/posts/"], authors: ["/authors/example/"], feed: ["/feeds/news.xml"],
  contentApi: ["/api/v1/content.json"], sitemap: ["/sitemap-index.xml"], search: ["/pagefind/pagefind.js", "/search/meaning-index.json"],
  programs: ["/programs/", "/shows/"] };
let directory: string;
let boundary: Awaited<ReturnType<typeof backgroundStorageFixture>>;
const app = firebaseAdminRuntime.initializeApp({ projectId: "demo-njpbs-context-coalescing" }, "context-coalescing");
const db = firebaseAdminRuntime.getFirestore(app);
beforeAll(async () => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "")) throw new Error("Use local demo Firestore");
  boundary = await backgroundStorageFixture("coalescing-fixture");
  directory = await realpath(await mkdtemp(path.join(tmpdir(), "context-coalescing-")));
});
beforeEach(async () => {
  boundary.objects.clear();
  await rm(path.join(directory, "cache"), { recursive: true, force: true });
  await db.recursiveDelete(db.doc("system/publicDeployment"));
  await db.recursiveDelete(db.collection("cmsPublishQueue"));
  await db.recursiveDelete(db.collection("cmsBackgroundOutputs"));
  await db.recursiveDelete(db.collection("cmsHomeSourceCatalogs"));
  await db.doc("system/cmsBackgroundAlerts").delete();
  await db.doc("system/noBuildPostAdmission").delete();
  await db.doc("system/publicDeployment").set({ state: "idle", activeCommitSha: runtime.release, activeGeneration: 1,
    activeDeploymentId: "11111111-1111-4111-8111-111111111111" });
  await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: "ready", commitSha: runtime.release, serializerId: "cloudflare-publisher" });
  await db.doc(context.PUBLIC_CONTEXT_PATH).set({ schemaVersion: 1, revision: 1, withdrawalRevision: 0, homeRevision: 0 });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(epoch);
});
afterEach(() => { boundary.onRead(null); vi.useRealTimers(); });
afterAll(async () => { await boundary.close(); await firebaseAdminRuntime.deleteApp(app); await rm(directory, { recursive: true, force: true }); });
async function enqueue(revision: number, withdrawalRevision?: number) {
  await db.runTransaction(async transaction => {
    const accepted = await publication.enqueuePublicContextInTransaction({ transaction, firestore: db, runtime,
      operationId: id(revision), reason: "context", contextRevision: revision, recordFamily: "programs" });
    accepted.write();
    transaction.update(db.doc(context.PUBLIC_CONTEXT_PATH), { revision,
      ...(withdrawalRevision === undefined ? {} : { withdrawalRevision }) });
  });
}
async function alias(operationId: string, revision: number) {
  await db.runTransaction(async transaction => {
    const accepted = await publication.enqueuePublicContextInTransaction({ transaction, firestore: db, runtime,
      operationId, reason: "settings", contextRevision: revision, recordFamily: "programs" });
    accepted.write();
  });
}
const queue = async (revision: number) => (await db.doc(`cmsPublishQueue/${id(revision)}`).get()).data()!;
const selected = async () => (await db.doc(publication.CURRENT_PATH).get()).data()!;
async function prepared(revision: number, status = "verified", operationId = id(revision), fixtureRuntime = runtime,
  { withdrawalRevision = 0, cutoffMillis = epoch } = {}) {
  const digest = context.publicContextDigest(revision);
  const retained = path.join(directory, operationId);
  await mkdir(retained, { recursive: true, mode: 0o700 });
  const files = [];
  const homePublication = { buildBatchId: `fixture-${revision}`, generation: 2, commitSha: fixtureRuntime.release };
  const editorial = homeAdmission.sealHomeCatalog({ schemaVersion: 1, cutoffAt: "2026-11-03T12:00:00Z",
    sources: Object.fromEntries(["home-featured", "home-more", "home-spotlight", "home-posts"].map(section =>
      [section, { status: "ready", checkedAt: "2026-11-03T12:00:00Z", cards: [] }])) }, homePublication);
  for (const [output, routes] of Object.entries({ ...paths, home: ["/", "/_home-sources.json"] })) for (const route of routes) {
    const file = `${output}/${routes.indexOf(route)}.txt`, bytes = Buffer.from(route === "/_home-sources.json"
      ? JSON.stringify({ publication: homePublication, editorial }) : `Context ${revision}: ${route}`);
    await mkdir(path.dirname(path.join(retained, "files", file)), { recursive: true, mode: 0o700 });
    await writeFile(path.join(retained, "files", file), bytes);
    files.push({ path: route, file, outputs: [output], contentType: "text/plain", size: bytes.length,
      digest: createHash("sha256").update(bytes).digest("hex") });
  }
  await writeFile(path.join(retained, "receipt.json"), JSON.stringify({ schemaVersion: 2, contextDigest: digest, routes: [], files }));
  for (const name of ["artifact-inventory.json", "public-context.json"]) await writeFile(path.join(retained, name), "{}");
  const cutoffAt = firebaseAdminRuntime.Timestamp.fromMillis(cutoffMillis);
  const storage = createNoBuildPreparationStorage("coalescing-fixture", app,
    { operationId, contextDigest: digest, commitSha: fixtureRuntime.release, owner: "cloudflare", cutoffMillis, admissionRevision: null });
  const preparedDigest = await storage.checkpoint("prepared", retained, [...backgroundOutputFiles, ...files.map(file => `files/${file.file}`)]);
  await db.doc(`cmsPublishQueue/${operationId}/backgroundPreparation/${digest}`).set({ schemaVersion: 1, runtime: fixtureRuntime,
    contextDigest: digest, recordFamilies: ["programs"], status, attempts: status === "verified" ? 1 : 0,
    nextAttemptAt: status === "verified" ? null : Date.now(), preparedDigest,
    frozenContext: { revision, withdrawalRevision, homeRevision: 0 }, progressAt: Date.now(), admissionRevision: null,
    backgroundBucket: "coalescing-fixture", reservation: { cutoffAt, commitSha: fixtureRuntime.release, buildBatchId: `fixture-${revision}`, generation: 2 } });
}
const maintain = (buildPublication?: () => Promise<never>) => noBuildPostMaintenance({ firestore: db, firebaseApp: app, runtime, commitSha: runtime.release,
  stateDirectory: path.join(directory, "cache"), distDirectory: path.join(directory, "unused"), buildEnvironment: {},
  backgroundBucket: "coalescing-fixture", ...(buildPublication ? { buildPublication } : {}) })();

it.each(["success", "failure", "cancelled-primary"])("shares waiting same-revision operations through %s", async outcome => {
  await enqueue(1); await prepared(1);
  vi.setSystemTime(epoch + 90_000); await enqueue(2);
  const peers = ["R".repeat(20), "S".repeat(20)];
  for (const peer of peers) await alias(peer, 2);
  await alias(peers[0], 2); // Deterministic retries neither cancel nor duplicate.
  expect((await selected()).followUp.operationIds).toEqual([id(2), ...peers]);
  for (const operationId of [id(2), ...peers]) {
    expect((await db.doc(`cmsPublishQueue/${operationId}`).get()).data()?.status).toBe("pending");
    expect((await db.collection(`cmsPublishQueue/${operationId}/backgroundOutputs`).get()).empty).toBe(true);
  }
  expect(await db.runTransaction(transaction => publication.retainedPublicContextQueueIdsInTransaction({ transaction, firestore: db })))
    .toEqual(new Set([id(1), id(2), ...peers]));
  if (outcome === "cancelled-primary") await db.doc(`cmsPublishQueue/${id(2)}`).update({ status: "cancelled", error: "record_regeneration_superseded" });
  vi.setSystemTime(epoch + 240_000); await maintain();
  const operationId = outcome === "cancelled-primary" ? peers[0] : id(2);
  if (outcome === "failure") {
    await db.runTransaction(async transaction => {
      const accepted = await publication.enqueuePublicContextInTransaction({ transaction, firestore: db, runtime,
        operationId, reason: "context", contextRevision: 2, activateQueued: true });
      accepted.write();
    });
    await prepared(2, "failed", operationId);
    await db.doc(`cmsPublishQueue/${operationId}/backgroundPreparation/${context.publicContextDigest(2)}`)
      .update({ attempts: 4, nextAttemptAt: null });
    await publication.failPublicContextPreparation({ firestore: db, operationId, runtime });
  } else { await prepared(2, "verified", operationId); await maintain(); }
  for (const peer of peers) expect((await db.doc(`cmsPublishQueue/${peer}`).get()).data()?.status)
    .toBe(outcome === "failure" ? "failed" : "success");
  expect((await queue(2)).status).toBe(outcome === "cancelled-primary" ? "cancelled" : outcome === "failure" ? "failed" : "success");
  if (outcome !== "failure") expect((await selected()).operationIds).toEqual([operationId]);
});

it("cancels old-release waiting aliases when a new release takes the context", async () => {
  await enqueue(1); await prepared(1);
  vi.setSystemTime(epoch + 90_000); await enqueue(2);
  const oldAlias = "R".repeat(20); await alias(oldAlias, 2);
  const nextRuntime = { owner: "cloudflare" as const, release: "b".repeat(40) };
  const replacementId = "N".repeat(20);
  await db.doc("system/publicDeployment").update({ activeCommitSha: nextRuntime.release });
  await db.doc("system/cmsPublicationRuntime").update({ commitSha: nextRuntime.release });
  await db.runTransaction(async transaction => {
    const accepted = await publication.enqueuePublicContextInTransaction({ transaction, firestore: db,
      runtime: nextRuntime, operationId: replacementId, reason: "context", contextRevision: 2, recordFamily: "programs" });
    accepted.write();
  });
  expect((await selected()).operationIds).toEqual([replacementId]);
  expect((await selected()).followUp).toBeUndefined();
  for (const operationId of [id(1), id(2), oldAlias]) {
    expect((await db.doc(`cmsPublishQueue/${operationId}`).get()).data()).toMatchObject({
      status: "cancelled", error: "public_context_superseded", runtime });
  }
  expect(await db.runTransaction(transaction => publication.retainedPublicContextQueueIdsInTransaction({ transaction, firestore: db })))
    .toEqual(new Set([replacementId]));
  await prepared(2, "verified", replacementId, nextRuntime);
  await noBuildPostMaintenance({ firestore: db, firebaseApp: app, runtime: nextRuntime, commitSha: nextRuntime.release,
    stateDirectory: path.join(directory, "cache"), distDirectory: path.join(directory, "unused"), buildEnvironment: {},
    backgroundBucket: "coalescing-fixture" })();
  expect((await db.doc(`cmsPublishQueue/${replacementId}`).get()).data()).toMatchObject({ status: "success", runtime: nextRuntime });
});

it("retains unfinished consumer aliases across a completed same-context join and retires them after proof", async () => {
  await enqueue(1); await prepared(1); await enqueue(2);
  const peers = ["R".repeat(20), "S".repeat(20)], next = "N".repeat(20);
  const identity = { rendererSha: runtime.release, contextRevision: 2, contextDigest: context.publicContextDigest(2) };
  for (const peer of peers) await alias(peer, 2);
  await db.doc(`cmsPublishQueue/${peers[0]}`).update({ settingsPublication: identity });
  await db.doc(`cmsPublishQueue/${peers[1]}`).update({ libraryCardPublication: identity });
  await maintain();
  await db.runTransaction(async transaction => {
    const accepted = await publication.enqueuePublicContextInTransaction({ transaction, firestore: db, runtime,
      operationId: id(2), reason: "context", contextRevision: 2, activateQueued: true });
    accepted.write();
  });
  await prepared(2); await maintain();
  expect((await selected()).operationIds).toEqual([...peers, id(2)]);
  await alias(next, 2); await maintain();
  expect((await selected()).operationIds).toEqual([...peers, next]);
  const receipt = { ...identity, verifiedAt: Date.now() };
  const confirm = async peer => db.doc(`cmsPublishQueue/${peer}`).update({
    consumerReceipts: { pages: receipt, home: receipt, posts: receipt } });
  await confirm(peers[0]);
  const completed = (await db.doc(`cmsPublishQueue/${peers[0]}`).get()).data();
  await publication.retireConfirmedPublicContextAliases({ firestore: db });
  expect((await selected()).operationIds).toEqual([peers[1], next]);
  expect((await db.doc(`cmsPublishQueue/${peers[0]}`).get()).data()).toEqual(completed);
  await confirm(peers[1]);
  await publication.retireConfirmedPublicContextAliases({ firestore: db });
  expect((await selected()).operationIds).toEqual([next]);
});

it("replaces every alias when a newer waiting context arrives", async () => {
  await enqueue(1); await prepared(1);
  vi.setSystemTime(epoch + 90_000); await enqueue(2);
  const peer = "R".repeat(20); await alias(peer, 2);
  vi.setSystemTime(epoch + 180_000); await enqueue(3);
  expect((await queue(2)).status).toBe("cancelled");
  expect((await db.doc(`cmsPublishQueue/${peer}`).get()).data()?.status).toBe("cancelled");
  expect((await selected()).followUp).toMatchObject({ operationId: id(3), operationIds: [id(3)], pendingSince: epoch + 90_000 });
  expect((await queue(1)).status).toBe("pending");
});

it("joins waiting aliases after the selected frozen cohort has finished", async () => {
  await enqueue(1); await prepared(1);
  vi.setSystemTime(epoch + 90_000); await enqueue(2);
  const peers = ["R".repeat(20), "S".repeat(20)];
  await alias(peers[0], 2);
  vi.setSystemTime(epoch + 240_000); await maintain();
  expect((await queue(1)).status).toBe("success");
  await alias(peers[1], 2);
  for (const operationId of [id(2), ...peers]) expect((await db.doc(`cmsPublishQueue/${operationId}`).get()).data()?.status).toBe("pending");
  expect((await selected()).operationIds).toEqual([id(2), ...peers]);
  await prepared(2, "verified", peers[1]); await maintain();
  for (const operationId of [id(2), ...peers]) expect((await db.doc(`cmsPublishQueue/${operationId}`).get()).data()?.status).toBe("success");
});

it("keeps the oldest waiting change when an observer seeds a newer family pending time", async () => {
  await enqueue(1); await prepared(1);
  vi.setSystemTime(epoch + 90_000); await enqueue(2);
  vi.setSystemTime(epoch + 180_000); await enqueue(3);
  await db.doc(context.PUBLIC_CONTEXT_PATH).update({ changedAt: firebaseAdminRuntime.Timestamp.fromMillis(Date.now()) });
  vi.setSystemTime(epoch + 240_000); await maintain();
  await alerts.checkPostBackgroundAlerts({ firestore: db, now: Date.now, send: async () => {} });
  expect((await db.doc("cmsBackgroundOutputs/listings").get()).data()?.pendingSince).toBe(epoch + 180_000);
  await db.runTransaction(async transaction => {
    const accepted = await publication.enqueuePublicContextInTransaction({ transaction, firestore: db, runtime,
      operationId: id(3), reason: "context", contextRevision: 3, activateQueued: true });
    accepted.write();
  });
  expect((await db.doc("cmsBackgroundOutputs/listings").get()).data()?.pendingSince).toBe(epoch + 90_000);
  await prepared(3); await maintain();
  expect((await queue(3)).status).toBe("success");
});

it.each(["running", "finished"])("replaces a cancelled follow-up while the selected cohort is %s", async phase => {
  await enqueue(1); await prepared(1);
  vi.setSystemTime(epoch + 90_000); await enqueue(2);
  if (phase === "finished") await maintain();
  // Deferred record regeneration can cancel a queued successor without bumping
  // the context or rewriting current.followUp.
  await db.doc(`cmsPublishQueue/${id(2)}`).update({ status: "cancelled", error: "record_regeneration_superseded" });
  expect(await db.runTransaction(transaction => publication.retainedPublicContextQueueIdsInTransaction({ transaction, firestore: db })))
    .toEqual(new Set([id(1)]));
  await maintain(async () => { throw new Error("Fixture waits for a retained checkpoint"); });
  const latest = (await selected()).followUp ?? await selected();
  expect(latest.contextRevision).toBe(2);
  expect(latest.operationId).not.toBe(id(2));
  expect((await queue(2)).status).toBe("cancelled");
  await prepared(2, "verified", latest.operationId);
  vi.setSystemTime(epoch + 240_000); await maintain();
  expect((await selected()).operationId).toBe(latest.operationId);
  expect((await selected()).followUp).toBeUndefined();
  expect((await db.doc(`cmsPublishQueue/${latest.operationId}`).get()).data()?.status).toBe("success");
  expect((await db.doc("cmsBackgroundOutputs/listings").get()).data()?.receipt.contextDigest).toBe(context.publicContextDigest(2));
});

it("finishes four-minute replacements during 90-second changes and converges to the latest context", async () => {
  await enqueue(1);
  let revision = 1, nextChange = 90_000;
  const successes: number[] = [];
  // The frozen renderer/storage boundary advances only the fake Date clock;
  // no sleep, real build or increased test timeout represents these minutes.
  for (let start = 0; start < 720_000; start += 240_000) {
    const active = (await selected()).followUp?.contextRevision ?? (await selected()).contextRevision;
    // Recover a completed cloud checkpoint whose preparation verification was
    // interrupted. The real preparer holds its build lease across the changes.
    await prepared(active, "failed");
    let entered!: () => void, resume!: () => void;
    const reading = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { resume = resolve; });
    boundary.onRead(async key => { if (key.endsWith(`/${id(active)}/${context.publicContextDigest(active)}/prepared.json`)) { entered(); await held; } });
    const running = maintain();
    try {
      await reading;
      while (nextChange < start + 240_000 && nextChange <= 630_000) {
        vi.setSystemTime(epoch + nextChange);
        const waiting = (await selected()).followUp;
        await enqueue(++revision);
        expect((await queue(active)).status).toBe("pending");
        expect((await selected()).operationId).toBe(id(active));
        expect((await selected()).followUp.contextRevision).toBe(revision);
        if (waiting) {
          expect((await queue(waiting.contextRevision)).status).toBe("cancelled");
          expect((await selected()).followUp.pendingSince).toBe(waiting.pendingSince);
        }
        expect(await db.runTransaction(transaction => publication.retainedPublicContextQueueIdsInTransaction({ transaction, firestore: db })))
          .toEqual(new Set([id(active), id(revision)]));
        expect((await db.doc(`cmsPublishQueue/${id(revision)}/backgroundOutputs/listings`).get()).exists).toBe(false);
        nextChange += 90_000;
      }
      vi.setSystemTime(epoch + start + 240_000);
    } finally { boundary.onRead(null); resume(); await running; }
    expect((await queue(active)).status).toBe("success");
    expect((await db.doc(`cmsPublishQueue/${id(active)}/backgroundPreparation/${context.publicContextDigest(active)}`).get()).data())
      .toMatchObject({ status: "verified", timings: { restore_prepared: 240_000 } });
    successes.push(active);
  }
  expect(successes).toEqual([1, 3, 6]);
  await prepared(revision);
  vi.setSystemTime(epoch + 960_000);
  await maintain();
  expect((await queue(revision)).status).toBe("success");
  expect((await selected()).contextRevision).toBe(revision);
  expect((await selected()).followUp).toBeUndefined();
  for (const output of Object.keys(paths)) expect((await db.doc(`cmsBackgroundOutputs/${output}`).get()).data()).toMatchObject({
    status: "verified", contextDigest: context.publicContextDigest(revision), receipt: { contextDigest: context.publicContextDigest(revision) } });
});

it("a failed frozen replacement releases its latest follow-up and cannot later overwrite it", async () => {
  await enqueue(1); await prepared(1);
  let entered!: () => void, resume!: () => void;
  const building = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { resume = resolve; });
  const artifacts = new Map<string, Buffer>();
  const oldOwner = background.createPostBackgroundOutputs({ firestore: db, runtime, enabled: true, recoveryOutputs: ["listings"],
    readContextInTransaction: transaction => publication.readSelectedPublicContextInTransaction({ transaction, firestore: db, operationId: id(1), runtime }),
    artifacts: { async put(key, bytes) { artifacts.set(key, Buffer.from(bytes)); }, async get(key) { return artifacts.get(key); } },
    build: async () => { entered(); await held; return { input: { kind: "public-background", rendererSha: runtime.release,
      contextDigest: context.publicContextDigest(1), routes: [] }, files: [{ path: "/posts/", bytes: "old", contentType: "text/plain" }] }; } });
  const running = oldOwner.recover();
  try {
    await building;
    vi.setSystemTime(epoch + 30_000); await enqueue(2);
    const digest = context.publicContextDigest(1);
    await db.doc(`cmsPublishQueue/${id(1)}/backgroundPreparation/${digest}`).update({ status: "failed", attempts: 4, nextAttemptAt: null });
    await publication.failPublicContextPreparation({ firestore: db, operationId: id(1), runtime });
    expect((await queue(1)).status).toBe("failed");
    await prepared(2); await maintain();
    expect((await queue(2)).status).toBe("success");
  } finally { resume(); await running; }
  expect(await publication.settlePublicContext({ firestore: db, operationId: id(1), runtime })).toBe(false);
  expect((await db.doc("cmsBackgroundOutputs/listings").get()).data()).toMatchObject({
    status: "verified", contextDigest: context.publicContextDigest(2), taskPath: `cmsPublishQueue/${id(2)}/backgroundOutputs/listings` });
});

it("keeps 90-second changes quiet with progress and alerts blocked output once after a 15-minute stall", async () => {
  await enqueue(1); await prepared(1);
  const preparation = db.doc(`cmsPublishQueue/${id(1)}/backgroundPreparation/${context.publicContextDigest(1)}`);
  const messages: string[] = [];
  const check = () => alerts.checkPostBackgroundAlerts({ firestore: db, now: Date.now, send: async message => { messages.push(message); } });
  for (let revision = 2; revision <= 14; revision++) {
    vi.setSystemTime(epoch + (revision - 1) * 90_000);
    await enqueue(revision);
    if (revision % 2 === 0) await preparation.update({ progressAt: Date.now() });
    await check();
  }
  expect(messages).toEqual([]);
  const lastProgress = Date.now();
  vi.setSystemTime(lastProgress + 15 * 60_000 - 1); await check();
  expect(messages).toEqual([]);
  vi.setSystemTime(Date.now() + 1); await Promise.all([check(), check()]);
  vi.setSystemTime(Date.now() + 20 * 60_000); await check();
  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain("Public listing output is blocked");
});

it("does not send recovery for healthy replacements that never alerted", async () => {
  await enqueue(1); await prepared(1);
  const messages: string[] = [];
  const check = () => alerts.checkPostBackgroundAlerts({ firestore: db, now: Date.now, send: async message => { messages.push(message); } });
  vi.setSystemTime(epoch + 90_000); await enqueue(2); await maintain(); await check();
  await prepared(2);
  vi.setSystemTime(epoch + 240_000); await maintain(); await check();
  expect((await queue(2)).status).toBe("success");
  expect(messages).toEqual([]);
});

it("retains final-family progress after a frozen queue settles and still reports a stalled follow-up", async () => {
  await enqueue(1); await prepared(1);
  vi.setSystemTime(epoch + 90_000); await enqueue(2);
  await db.doc(context.PUBLIC_CONTEXT_PATH).update({ changedAt: firebaseAdminRuntime.Timestamp.fromMillis(Date.now()) });
  // Finish an old cohort after both observer windows, with its successor waiting.
  vi.setSystemTime(epoch + 20 * 60_000); await maintain();
  expect((await queue(1)).status).toBe("success");
  expect((await selected()).progressAt).toBe(Date.now());
  await db.doc("system/publicDeployment/externalRefresh/current").set({ schemaVersion: 1, runtime,
    status: "verified", nextAttemptAt: epoch + 60 * 60_000 });
  const health = () => readPublicationHealth({ runtime, now: Date.now(),
    read: async name => (await db.doc(name).get()).data() ?? null });
  const messages: string[] = [];
  const statuses: Record<string, unknown>[] = [];
  const check = () => alerts.checkPostBackgroundAlerts({ firestore: db, now: Date.now,
    log: { info: (_message: string, status: Record<string, unknown>) => statuses.push(status) },
    send: async message => { messages.push(message); } });
  const progressAt = Date.now();
  await check();
  const observed = await health();
  expect({ reasons: observed.reasons, messages }).toEqual({ reasons: [], messages: [] });
  vi.setSystemTime(progressAt + 5 * 60_000 - 1);
  expect((await health()).healthy).toBe(true);
  vi.setSystemTime(Date.now() + 1);
  expect((await health()).reasons).toContain("work_overdue");
  vi.setSystemTime(progressAt + 15 * 60_000 - 1); await check();
  expect(messages).toEqual([]);
  expect(statuses).toEqual([]);
  vi.setSystemTime(Date.now() + 1); await check(); await check();
  expect(messages).toEqual([]);
  expect(statuses).toHaveLength(1);
  expect(statuses[0]).toMatchObject({ recovered: false,
    outputs: expect.arrayContaining(["listings"]),
    observations: expect.arrayContaining([{ output: "listings", reason: "rebuild_delayed" }]) });
});

it("keeps a live replacement quiet and retains real progress when its lease expires", async () => {
  await enqueue(1); await prepared(1);
  const preparation = db.doc(`cmsPublishQueue/${id(1)}/backgroundPreparation/${context.publicContextDigest(1)}`);
  const messages: string[] = [];
  const check = () => alerts.checkPostBackgroundAlerts({ firestore: db, now: Date.now, send: async message => { messages.push(message); } });
  vi.setSystemTime(epoch + 16 * 60_000);
  await preparation.update({ status: "building", claim: "C".repeat(20), nextAttemptAt: Date.now() + 10 * 60_000 });
  await check();
  vi.setSystemTime(epoch + 20 * 60_000); await preparation.update({ progressAt: Date.now() });
  vi.setSystemTime(epoch + 26 * 60_000); await check();
  expect(messages).toEqual([]);
  vi.setSystemTime(epoch + 35 * 60_000); await check(); await check();
  expect(messages).toHaveLength(1);
});

it.each(["preparation", "family"])("alerts a terminal %s failure immediately even during admission pause", async kind => {
  await enqueue(1); await prepared(1);
  const failed = { status: "failed", attempts: 4, nextAttemptAt: null, claim: null };
  if (kind === "preparation") {
    await db.doc(`cmsPublishQueue/${id(1)}/backgroundPreparation/${context.publicContextDigest(1)}`).update(failed);
    await db.doc(`cmsPublishQueue/${id(1)}`).update({ status: "failed" });
  } else await db.doc(`cmsPublishQueue/${id(1)}/backgroundOutputs/listings`).update(failed);
  await db.doc("system/cmsPublicationRuntime").update({ phase: "paused" });
  const messages: string[] = [];
  const check = () => alerts.checkPostBackgroundAlerts({ firestore: db, now: Date.now, send: async message => { messages.push(message); } });
  await check(); await check();
  expect(messages.filter(message => message.includes("Automatic listing recovery is exhausted"))).toHaveLength(1);
});

it("finishing frozen bytes never renews withdrawal grace for a change accepted during preparation", async () => {
  await enqueue(1); await prepared(1);
  vi.setSystemTime(epoch + 90_000); await enqueue(2);
  await db.doc(context.PUBLIC_CONTEXT_PATH).update({ withdrawalRevision: 1 });
  vi.setSystemTime(epoch + 240_000);
  const owner = background.createPostBackgroundOutputs({ firestore: db, runtime, enabled: true, recoveryOutputs: ["listings"],
    readContextInTransaction: transaction => publication.readSelectedPublicContextInTransaction({ transaction, firestore: db, operationId: id(1), runtime }),
    artifacts: { async put() {}, async get() { return Buffer.from("frozen"); } },
    build: async () => ({ input: { kind: "public-background", rendererSha: runtime.release, contextDigest: context.publicContextDigest(1), routes: [] },
      files: [{ path: "/posts/", bytes: "frozen", contentType: "text/plain" }] }) });
  await owner.recover();
  const state = (await db.doc("cmsBackgroundOutputs/listings").get()).data()!;
  expect(state.receipt).toMatchObject({ verifiedAt: Date.now(), sourceReadAt: epoch, withdrawalRevision: 0 });
  expect(background.backgroundHealth(state, background.dependency(null), { digest: context.publicContextDigest(2),
    rendererSha: runtime.release, withdrawalRevision: 1 }, Date.now()).reason).toBe("withdrawal_expired");
});

it.each(["enqueue", "maintenance", "unqueued"])("bypasses withdrawn frozen backoff through %s and fences its live older family writer", async producer => {
  await enqueue(1); await prepared(1, "failed");
  const ref = db.doc(`cmsPublishQueue/${id(1)}/backgroundPreparation/${context.publicContextDigest(1)}`);
  await ref.update({ attempts: 1, nextAttemptAt: epoch + 600_000 });
  let entered!: () => void, resume!: () => void;
  const building = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { resume = resolve; });
  const oldOwner = background.createPostBackgroundOutputs({ firestore: db, runtime, enabled: true, recoveryOutputs: ["listings"],
    readContextInTransaction: transaction => publication.readSelectedPublicContextInTransaction({ transaction, firestore: db, operationId: id(1), runtime }),
    artifacts: { async put() {}, async get() { return Buffer.from("Withdrawn story"); } },
    build: async () => { entered(); await held; return { input: { kind: "public-background", rendererSha: runtime.release,
      contextDigest: context.publicContextDigest(1), routes: [] }, files: [{ path: "/posts/", bytes: "Withdrawn story", contentType: "text/plain" }] }; } });
  const running = oldOwner.recover();
  const reader = background.createPostBackgroundOutputs({ firestore: db, runtime, enabled: true,
    readContextInTransaction: transaction => context.readPublicBackgroundContextInTransaction(transaction, db),
    artifacts: { async get(key) { return boundary.objects.get(key); } } });
  let latest!: string;
  const peers = ["R".repeat(20), "S".repeat(20)];
  try {
    await building;
    vi.setSystemTime(epoch + 90_000);
    if (producer === "maintenance") await enqueue(2, 1);
    else await db.doc(context.PUBLIC_CONTEXT_PATH).update({ revision: 2, withdrawalRevision: 1 });
    if (producer === "enqueue") await enqueue(2);
    else await maintain(async () => { throw new Error("Fixture waits for withdrawal-safe bytes"); });
    latest = (await selected()).operationId;
    expect(latest).not.toBe(id(1));
    for (const peer of peers) await alias(peer, 2);
    latest = (await selected()).operationId;
    expect((await selected()).contextRevision).toBe(2);
    expect((await queue(1)).status).toBe("cancelled");
    expect((await ref.get()).data()).toMatchObject({ nextAttemptAt: epoch + 600_000,
      frozenContext: { withdrawalRevision: 0 }, reservation: { cutoffAt: firebaseAdminRuntime.Timestamp.fromMillis(epoch) } });
    expect((await db.doc(`cmsPublishQueue/${id(1)}/backgroundOutputs/listings`).get()).data())
      .toMatchObject({ status: "superseded", claim: null });
    // The older writer is still blocked in build: metadata supersession did not abort it.
    expect((await reader.serve(new Request("https://example.test/posts/")))?.status).toBe(503);
    await prepared(2, "verified", latest, runtime, { withdrawalRevision: 1, cutoffMillis: Date.now() });
    await maintain();
    expect(Date.now()).toBeLessThan(epoch + 600_000);
    expect((await db.doc(`cmsPublishQueue/${latest}`).get()).data()?.status).toBe("success");
    for (const peer of [...(producer !== "unqueued" ? [id(2)] : []), ...peers])
      expect((await db.doc(`cmsPublishQueue/${peer}`).get()).data()?.status).toBe("success");
  } finally { resume(); await running; }
  expect(await publication.settlePublicContext({ firestore: db, operationId: id(1), runtime })).toBe(false);
  const state = (await db.doc("cmsBackgroundOutputs/listings").get()).data()!;
  expect(state).toMatchObject({ status: "verified", contextDigest: context.publicContextDigest(2),
    taskPath: `cmsPublishQueue/${latest}/backgroundOutputs/listings`,
    receipt: { withdrawalRevision: 1, sourceReadAt: epoch + 90_000 } });
  expect(background.backgroundHealth(state, background.dependency(null), { digest: context.publicContextDigest(2),
    rendererSha: runtime.release, withdrawalRevision: 1 }, Date.now()).reason).toBe(null);
  const response = await reader.serve(new Request("https://example.test/posts/"));
  expect(response?.status).toBe(200);
  expect(await response!.text()).toBe("Context 2: /posts/");
});

it("fences a still-live older preparation after withdrawal metadata supersession", async () => {
  await enqueue(1); await prepared(1, "failed");
  let entered!: () => void, resume!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { resume = resolve; });
  boundary.onRead(async key => {
    if (key.endsWith(`/${id(1)}/${context.publicContextDigest(1)}/prepared.json`)) { entered(); await held; }
  });
  const running = maintain();
  try {
    await reading;
    vi.setSystemTime(epoch + 90_000);
    await db.doc(context.PUBLIC_CONTEXT_PATH).update({ revision: 2, withdrawalRevision: 1 });
    await enqueue(2);
    expect((await selected()).operationId).toBe(id(2));
    await prepared(2, "verified", id(2), runtime, { withdrawalRevision: 1, cutoffMillis: Date.now() });
    vi.setSystemTime(epoch + 180_000); await enqueue(3);
    expect((await selected()).operationId).toBe(id(2));
    expect((await selected()).followUp.contextRevision).toBe(3);
    await maintain();
    expect((await queue(2)).status).toBe("success");
  } finally { boundary.onRead(null); resume(); await running; }
  expect((await queue(1)).status).toBe("cancelled");
  expect((await db.doc(`cmsPublishQueue/${id(1)}/backgroundPreparation/${context.publicContextDigest(1)}`).get()).data()?.status).not.toBe("verified");
  expect((await db.doc("cmsBackgroundOutputs/listings").get()).data()).toMatchObject({
    status: "verified", contextDigest: context.publicContextDigest(2), receipt: { withdrawalRevision: 1 } });
});

it("drains frozen work during admission pause without accepting an unqueued newer context", async () => {
  await enqueue(1); await prepared(1);
  await db.doc(context.PUBLIC_CONTEXT_PATH).update({ revision: 2 });
  await db.doc("system/cmsPublicationRuntime").update({ phase: "paused" });
  await maintain();
  expect((await queue(1)).status).toBe("success");
  expect((await selected()).followUp).toBeUndefined();
  expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
});

it.each([false, true])("drains accepted work when withdrawal precedes admission pause (queued: %s)", async queued => {
  await enqueue(1); await prepared(1);
  vi.setSystemTime(epoch + 90_000);
  if (queued) await enqueue(2, 1);
  else await db.doc(context.PUBLIC_CONTEXT_PATH).update({ revision: 2, withdrawalRevision: 1 });
  await db.doc("system/cmsPublicationRuntime").update({ phase: "paused" });
  if (queued) await prepared(2, "verified", id(2), runtime, { withdrawalRevision: 1, cutoffMillis: Date.now() });
  vi.setSystemTime(epoch + 240_000); await maintain();
  expect((await selected()).operationId).toBe(id(queued ? 2 : 1));
  expect((await queue(queued ? 2 : 1)).status).toBe("success");
  expect((await db.collection("cmsPublishQueue").get()).size).toBe(queued ? 2 : 1);
  if (!queued) {
    const state = (await db.doc("cmsBackgroundOutputs/listings").get()).data()!;
    expect(background.backgroundHealth(state, background.dependency(null), { digest: context.publicContextDigest(2),
      rendererSha: runtime.release, withdrawalRevision: 1 }, Date.now()).reason).toBe("withdrawal_expired");
  }
});

it.each(["enqueue-primary", "enqueue-alias", "maintenance-alias", "enqueue-confirmed-consumers"])(
  "keeps an exact staff receipt on its frozen context through withdrawal (%s)", async mode => {
    await enqueue(1);
    const operationId = settingsPublication.settingsOperationId("site-navigation", 2);
    await alias(operationId, 1);
    if (mode !== "enqueue-primary") await alias("A".repeat(20), 1);
    const frozenId = (await selected()).operationId;
    const identity = { id: "site-navigation", sourceVersion: 2, snapshotDigest: "b".repeat(64), operationId,
      originalOperationId: operationId, rendererSha: runtime.release, contextRevision: 1,
      contextDigest: context.publicContextDigest(1), requiredConsumers: settingsPublication.REQUIRED_CONSUMERS };
    const consumer = { rendererSha: runtime.release, contextRevision: 1, contextDigest: identity.contextDigest, verifiedAt: epoch };
    await db.doc(`cmsPublishQueue/${operationId}`).update({ settingsPublication: identity,
      createdAt: firebaseAdminRuntime.Timestamp.fromMillis(epoch),
      ...(mode === "enqueue-confirmed-consumers" ? { consumerReceipts: { pages: consumer, home: consumer, posts: consumer } } : {}) });
    await prepared(1, "failed", frozenId);
    await db.doc(`cmsPublishQueue/${frozenId}/backgroundPreparation/${identity.contextDigest}`)
      .update({ attempts: 1, nextAttemptAt: epoch + 600_000 });
    vi.setSystemTime(epoch + 90_000);
    if (mode === "maintenance-alias") await enqueue(2, 1);
    else { await db.doc(context.PUBLIC_CONTEXT_PATH).update({ revision: 2, withdrawalRevision: 1 }); await enqueue(2); }
    await maintain();
    expect((await selected()).operationId).toBe(frozenId);
    expect((await selected()).followUp.operationId).toBe(id(2));
    let staff = (await db.doc(`cmsPublishQueue/${operationId}`).get()).data()!;
    expect(staff.settingsPublication).toEqual(identity);
    expect(staff.status).toBe("pending");
    expect(settingsPublication.settingsPublicationReceipt(staff)).toMatchObject({ status: "pending" });
    expect(settingsPublication.settingsPublicationReceipt(staff).warning).toBeUndefined();
    await prepared(1, "verified", frozenId);
    vi.setSystemTime(epoch + 240_000); await maintain();
    await prepared(2, "verified", id(2), runtime, { withdrawalRevision: 1, cutoffMillis: epoch + 90_000 });
    await maintain();
    expect((await queue(2)).status).toBe("success");
    staff = (await db.doc(`cmsPublishQueue/${operationId}`).get()).data()!;
    expect(staff.settingsPublication).toEqual(identity);
    expect(settingsPublication.settingsPublicationReceipt(staff).status)
      .toBe(mode === "enqueue-confirmed-consumers" ? "success" : "pending");
  });

it("keeps Post Home recovery out of a running frozen aggregate namespace", async () => {
  await enqueue(1); await prepared(1);
  const preparation = db.doc(`cmsPublishQueue/${id(1)}/backgroundPreparation/${context.publicContextDigest(1)}`);
  await preparation.update({ status: "building", nextAttemptAt: epoch + 600_000 });
  vi.setSystemTime(epoch + 90_000); await enqueue(2);
  const postId = "retained-post", operationId = "H".repeat(20);
  await db.doc("system/noBuildPostAdmission").set({ schemaVersion: 2, revision: 1, enabled: true,
    families: { posts: { mode: "all" } }, backgroundBucket: "coalescing-fixture" });
  await db.doc(`system/publicDeployment/noBuildPostOwners/${postId}`).set({ schemaVersion: 1, runtime,
    postId, operationId, mode: "dynamic", servingEnabled: true, rendererSha: runtime.release, sourceVersion: 1,
    slug: postId, ownedSlugs: [postId], generation: 1, visible: true });
  await db.doc(`cmsPublishQueue/${operationId}`).set({ schemaVersion: 1, transport: "post-no-build-v1", runtime,
    backgroundRuntime: runtime, status: "success", noBuildPost: { postId, operationId } });
  const after = background.dependency(null), taskPath = `cmsPublishQueue/${operationId}/backgroundOutputs/home`;
  await db.doc(taskPath).set({ schemaVersion: 1, owner: "post-background-v1", runtime, output: "home", revision: 1,
    postId, status: "pending", contextDigest: null, attempts: 0, claim: null, nextAttemptAt: Date.now(),
    dependencies: { before: after, after, slugs: [], authorIds: [], mediaIds: [], homePlacementPaths: [] } });
  await db.doc("cmsBackgroundOutputs/home").set({ schemaVersion: 1, owner: "post-background-v1", runtime, output: "home", revision: 1,
    postId, status: "pending", contextDigest: null, receipt: null, taskPath, after, pendingSince: Date.now() });
  await prepared(2, "verified", operationId);
  const refs = publication.OUTPUTS.map(output => db.doc(`cmsBackgroundOutputs/${output}`));
  const snapshot = async () => (await db.getAll(...refs)).map(row => row.data());
  const before = await snapshot();
  await maintain();
  expect((await db.doc("cmsBackgroundOutputs/home").get()).data()).toMatchObject({ status: "verified",
    receipt: { contextDigest: context.publicContextDigest(2) } });
  expect(await snapshot()).toEqual(before);
  expect((await queue(1)).status).toBe("pending");
  await preparation.update({ status: "verified", nextAttemptAt: null });
  await maintain();
  expect((await queue(1)).status).toBe("success");
  expect((await db.doc("cmsBackgroundOutputs/home").get()).data()?.receipt.contextDigest).toBe(context.publicContextDigest(2));
});

it.each([false, true])("refreshes Post Home only from the current aggregate preparation (newer context: %s)", async newer => {
  await enqueue(1); await prepared(1);
  const after = background.dependency(null), taskPath = `cmsPublishQueue/${"H".repeat(20)}/backgroundOutputs/home`;
  await db.doc(taskPath).set({ schemaVersion: 1, owner: "post-background-v1", runtime, output: "home", revision: 1,
    postId: "retained-post", status: "pending", contextDigest: null, attempts: 0, claim: null, nextAttemptAt: Date.now(),
    dependencies: { before: after, after, slugs: [], authorIds: [], mediaIds: [], homePlacementPaths: [] } });
  await db.doc("cmsBackgroundOutputs/home").set({ schemaVersion: 1, owner: "post-background-v1", runtime, output: "home", revision: 1,
    postId: "retained-post", status: "pending", contextDigest: null, receipt: null, taskPath, after, pendingSince: Date.now() });
  if (newer) { await enqueue(2); await db.doc(context.PUBLIC_CONTEXT_PATH).update({ homeRevision: 1 }); }
  await maintain();
  expect((await queue(1)).status).toBe("success");
  const home = (await db.doc("cmsBackgroundOutputs/home").get()).data()!;
  expect(home.status).toBe(newer ? "pending" : "verified");
  if (!newer) expect(home.receipt.contextDigest).toBe(context.publicContextDigest(1));
  else expect((await db.doc(taskPath).get()).data()?.attempts).toBe(0);
});

it("does not count a new preparation claim or acceptance as completed progress", async () => {
  await enqueue(1); await prepared(1, "failed");
  const ref = db.doc(`cmsPublishQueue/${id(1)}/backgroundPreparation/${context.publicContextDigest(1)}`);
  await ref.update({ progressAt: firebaseAdminRuntime.FieldValue.delete() });
  let entered!: () => void, resume!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { resume = resolve; });
  boundary.onRead(async key => { if (key.endsWith("/prepared.json")) { entered(); await held; } });
  const running = maintain();
  try {
    await reading;
    expect((await ref.get()).data()).toMatchObject({ status: "building", attempts: 1 });
    expect((await ref.get()).data()).not.toHaveProperty("progressAt");
  } finally { boundary.onRead(null); resume(); await running; }
  expect((await ref.get()).data()).toMatchObject({ status: "verified", progressAt: Date.now() });
});

it.each(["missing", "retained", "discovered"])("credits durable work rather than a restart with %s input", async input => {
  boundary.objects.clear();
  await enqueue(1); await prepared(1, "failed");
  const digest = context.publicContextDigest(1), operationId = id(1);
  const ref = db.doc(`cmsPublishQueue/${operationId}/backgroundPreparation/${digest}`);
  boundary.objects.delete(`post-background-v1/preparation/${operationId}/${digest}/prepared.json`);
  await ref.update({ preparedDigest: firebaseAdminRuntime.FieldValue.delete(), progressAt: epoch });
  if (input !== "missing") {
    const retained = path.join(directory, operationId);
    for (const name of backgroundInputFiles) await writeFile(path.join(retained, name), "{}");
    const storage = createNoBuildPreparationStorage("coalescing-fixture", app,
      { operationId, contextDigest: digest, commitSha: runtime.release, owner: "cloudflare", cutoffMillis: epoch, admissionRevision: null });
    const inputDigest = await storage.checkpoint("input", retained, backgroundInputFiles);
    if (input === "retained") await ref.update({ inputDigest });
  }
  await db.doc("system/publicDeployment/externalRefresh/current").set({ schemaVersion: 1, runtime,
    status: "verified", nextAttemptAt: epoch + 24 * 60 * 60_000 });
  vi.setSystemTime(epoch + 20 * 60_000);
  let entered!: () => void, resume!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { resume = resolve; });
  if (input === "missing") boundary.onRead(async key => { if (key.endsWith(`/${digest}/input.json`)) { entered(); await held; } });
  const running = maintain(async () => { entered(); await held; throw new Error("Fixture interrupts rendering"); });
  try {
    await reading;
    expect((await ref.get()).data()).toMatchObject({ status: "building", progressAt: input === "discovered" ? Date.now() : epoch });
    const health = await readPublicationHealth({ runtime, now: Date.now(),
      read: async name => (await db.doc(name).get()).data() ?? null });
    expect(health.reasons.includes("work_overdue")).toBe(input !== "discovered");
  } finally {
    boundary.onRead(null);
    if (input === "missing") boundary.refuseReads(true);
    resume();
    try { await running; } finally { boundary.refuseReads(false); }
  }
});
