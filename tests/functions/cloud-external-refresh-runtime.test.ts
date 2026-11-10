import { beforeAll, beforeEach, afterAll, afterEach, expect, it } from "vitest";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import deployment from "../../functions/lib/public-deployment.js";
import aggregates from "../../functions/lib/public-context-publication.js";
import context from "../../functions/lib/public-context-revision.js";
import { firebaseAdminRuntime } from "../../site/scripts/firebase-admin-runtime";
import { startNoBuildCloudRuntime } from "../../site/scripts/no-build-cloud-runtime";
import { backgroundStorageFixture } from "./background-storage-fixture";
import { cloudReleaseCollection } from "../../site/scripts/no-build-cloud-release";

const projectId = isolatedFirestore("cloud-external-refresh-runtime.test.ts").projectId;
let db: ReturnType<typeof firebaseAdminRuntime.getFirestore>;
let app: ReturnType<typeof firebaseAdminRuntime.initializeApp>;
let release: string;
let directory: string;
let tvssFixture: string;
let storageBoundary: Awaited<ReturnType<typeof backgroundStorageFixture>>;
const serializerId = "cloudflare-publisher";
const releaseId = "R".repeat(20);
const aggregateId = "A".repeat(20);
const requestPath = `${cloudReleaseCollection(serializerId)}/${releaseId}`;
beforeAll(async () => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") ||
      !/^demo-njpbs(?:-[a-z0-9-]+)?$/.test(process.env.GCLOUD_PROJECT ?? "")) throw new Error("Use demo Firestore emulators");
  tvssFixture = await readFile(new URL("../../site/tests/fixtures/tvss-wnjt-20260710.jsonp", import.meta.url), "utf8");
  release = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  directory = await mkdtemp(path.join(tmpdir(), "refresh-runtime-"));
  storageBoundary = await backgroundStorageFixture("fixture-bucket");
});
afterAll(async () => {
  await storageBoundary?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
afterEach(async () => {
  // SDK rollback RPCs outlive the rejected transaction promise. Drain the native
  // client before the next reset; each case opens a fresh client for this project.
  if (db) await db.terminate();
  if (app) await firebaseAdminRuntime.deleteApp(app);
});
beforeEach(async () => {
  app = firebaseAdminRuntime.initializeApp({ projectId }, "refresh-runtime-fixture");
  db = firebaseAdminRuntime.getFirestore(app);
  // Reset only this fixture's project, without BulkWriter's wall-clock limiter.
  await clearEmulatorFirestore(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${db.projectId}/databases/(default)/documents`,
    { method: "DELETE" }, db,
  );
  const runtime = { owner: "cloudflare", release };
  await db.doc("system/publicDeployment").set({ ...deployment.initialPublicDeploymentPointer(),
    activeCommitSha: release, activeGeneration: 1, activeDeploymentId: "11111111-1111-4111-8111-111111111111",
    lastReservedGeneration: 1, newestEligibleGeneration: 1, newestEligibleBuildBatchId: "fixture" });
  await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: "ready", commitSha: release, serializerId });
  await db.doc(context.PUBLIC_CONTEXT_PATH).set({ schemaVersion: 1, revision: 1 });
  const identity = { schemaVersion: 1, operationId: aggregateId, runtime, contextRevision: 1, contextDigest: context.publicContextDigest(1) };
  await db.doc("system/publicDeployment/aggregateContexts/current").set(identity);
  await db.doc(`cmsPublishQueue/${aggregateId}`).set({ schemaVersion: 1, transport: "public-context-no-build-v1",
    runtime, backgroundRuntime: runtime, publicContext: identity, status: "failed", changes: [] });
  await db.doc(requestPath).set({ schemaVersion: 1, runtime, commitSha: release, status: "pending", attempts: 0,
    nextAttemptAt: Date.now() - 1, inputSha256: "e".repeat(64), artifactCheckpointDigest: "f".repeat(64) });
  await db.doc(`system/publicDeployment/buildBatches/cms-${releaseId}`).set({ runtime, status: "cancelled" });
});

it.each(["blocked-provider", "claim-error"])("keeps accepted release recovery independent of %s", async mode => {
  // The aggregate already owns the six selected namespaces, so maintenance starts
  // no new context preparation ahead of the accepted release.
  const runtime = { owner: "cloudflare", release };
  const contextDigest = context.publicContextDigest(1);
  await db.doc("system/publicDeployment/aggregateContexts/current").update({ finalNamespaceOwner: true,
    namespaceOperationId: aggregateId, preparationOperationId: aggregateId });
  await Promise.all(aggregates.OUTPUTS.map(output => db.doc(`cmsBackgroundOutputs/${output}`).set({ schemaVersion: 1,
    runtime, output, revision: 1, contextOnly: true, contextDigest,
    taskPath: `cmsPublishQueue/${aggregateId}/backgroundOutputs/${output}` })));
  let unblock!: () => void;
  const blocked = new Promise<void>(resolve => { unblock = resolve; });
  let providerReached!: () => void;
  const providerStarted = new Promise<void>(resolve => { providerReached = resolve; });
  let providerRequests = 0;
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/shows/")) {
      providerRequests++;
      providerReached();
      void blocked.then(() => {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ data: [{ id: "fixture-show", attributes: {
          title: "Painting Community", slug: "painting-community", description: "Public program", image: "https://image.pbs.org/fixture.jpg",
        } }] }));
      });
    } else if (request.url?.startsWith("/tvss/")) {
      response.setHeader("Content-Type", "application/javascript");
      response.end(tvssFixture);
    } else response.end('<rss><channel><item><title>Public story</title><link>https://www.njspotlightnews.org/2026/10/public-story/</link></item></channel></rss>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local provider boundary did not bind");
  const endpoint = `http://127.0.0.1:${address.port}/`;
  if (mode === "claim-error") await db.doc("system/publicDeployment/externalRefresh/current").set({ schemaVersion: 99,
    runtime: { owner: "cloudflare", release }, status: "failed", nextAttemptAt: Date.now() - 1 });
  if (mode === "blocked-provider") await db.doc(requestPath).update({ nextAttemptAt: Date.now() + 600_000 });
  let releaseTimedOut!: (error: Error) => void;
  let detach = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const completed = new Promise<void>((resolve, reject) => {
    releaseTimedOut = reject;
    if (mode !== "blocked-provider") timer = setTimeout(() => reject(new Error("Accepted release recovery waited behind provider work")), 4000);
    detach = db.doc(requestPath).onSnapshot(row => { if (row.data()?.status === "cancelled") resolve(); }, reject);
  });
  const owner = startNoBuildCloudRuntime({ firestore: db, firebaseApp: app, commitSha: release, serializerId,
    stateDirectory: directory, buildEnvironment: { MEDIA_MANAGER_BASE_URL: endpoint, SPOTLIGHT_NEWS_FEED_URL: `${endpoint}feed/`, SCHEDULE_FEED_BASE_URL: `${endpoint}tvss/` },
    cloudflareApiToken: "fixtureTokenForLocalTests", storage: { target: { backgroundBucket: "fixture-bucket" } },
    previewStorageCredential: {}, mediaManagerCredential: { key: "fixture-key", secret: "fixture-value" } } as Parameters<typeof startNoBuildCloudRuntime>[0]);
  void owner.closed.catch(() => {});
  try {
    for (let hint = 0; hint < 8; hint++) owner.wake();
    if (mode === "blocked-provider") {
      await Promise.race([providerStarted, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Blocked provider never started")), 4000);
      })]);
      clearTimeout(timer);
      expect((await db.doc(requestPath).get()).data()?.status).toBe("pending");
      timer = setTimeout(() => releaseTimedOut(new Error("Accepted release recovery waited behind provider work")), 4000);
      await db.doc(requestPath).update({ nextAttemptAt: Date.now() - 1 });
      owner.wake();
    }
    await completed;
    expect((await db.doc(requestPath).get()).data()?.status).toBe("cancelled");
    if (mode === "blocked-provider") {
      expect(providerRequests).toBe(1);
      owner.stop();
      let closed = false;
      void owner.closed.then(() => { closed = true; });
      await db.doc(requestPath).get();
      expect(closed).toBe(false);
    } else expect(providerRequests).toBe(0);
  } finally {
    clearTimeout(timer); detach(); unblock(); owner.stop();
    await Promise.allSettled([owner.closed]);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

it("starts a newly due provider claim while the existing background input freeze is blocked", async () => {
  await db.doc("system/publicDeployment/aggregateContexts/current").delete();
  await db.doc(`cmsPublishQueue/${aggregateId}`).delete();
  await db.runTransaction(async transaction => {
    const accepted = await aggregates.enqueuePublicContextInTransaction({ transaction, firestore: db,
      operationId: aggregateId, runtime: { owner: "cloudflare", release }, reason: "context", contextRevision: 1 });
    accepted.write();
  });
  const refreshPath = "system/publicDeployment/externalRefresh/current";
  const next = Date.now() + 600_000;
  await db.doc(refreshPath).set({ schemaVersion: 1, runtime: { owner: "cloudflare", release },
    operationId: "N".repeat(20), status: "verified", attempts: 1, nextAttemptAt: next, nextCheckAt: next,
    checkedAt: Date.now(), periodStartedAt: Date.now() });
  let unblock!: () => void;
  const blocked = new Promise<void>(resolve => { unblock = resolve; });
  let reached!: () => void;
  const inputFreezeReached = new Promise<void>(resolve => { reached = resolve; });
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/shows/")) {
      reached();
      void blocked.then(() => { response.statusCode = 401; response.end(); });
    } else if (request.url?.startsWith("/tvss/")) response.end(tvssFixture);
    else response.end('<rss><channel><item><title>Public story</title><link>https://www.njspotlightnews.org/2026/10/public-story/</link></item></channel></rss>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local provider boundary did not bind");
  const endpoint = `http://127.0.0.1:${address.port}/`;
  let detach = () => {};
  const timers: ReturnType<typeof setTimeout>[] = [];
  const deadline = (message: string) => new Promise<never>((_resolve, reject) => {
    timers.push(setTimeout(() => reject(new Error(message)), 4000));
  });
  const owner = startNoBuildCloudRuntime({ firestore: db, firebaseApp: app, commitSha: release, serializerId,
    stateDirectory: directory, buildEnvironment: { REQUIRE_FRESH_CONTENT: "1", MEDIA_MANAGER_BASE_URL: endpoint,
      SPOTLIGHT_NEWS_FEED_URL: `${endpoint}feed/`, SCHEDULE_FEED_BASE_URL: `${endpoint}tvss/` },
    cloudflareApiToken: "fixtureTokenForLocalTests", storage: { target: { backgroundBucket: "fixture-bucket" } },
    previewStorageCredential: {}, mediaManagerCredential: { key: "fixture-key", secret: "fixture-value" } } as Parameters<typeof startNoBuildCloudRuntime>[0]);
  void owner.closed.catch(() => {});
  try {
    await Promise.race([inputFreezeReached, deadline("Background input freeze did not reach its local provider")]);
    expect((await db.doc(refreshPath).get()).data()?.status).toBe("verified");
    const claimed = new Promise<void>((resolve, reject) => {
      detach = db.doc(refreshPath).onSnapshot(row => { if (row.data()?.status === "fetching") resolve(); }, reject);
    });
    await db.doc(refreshPath).update({ nextAttemptAt: Date.now() - 1 });
    owner.wake();
    await Promise.race([claimed, deadline("A due refresh waited behind background preparation")]);
    expect((await db.doc(`cmsPublishQueue/${aggregateId}`).get()).data()?.status).toBe("pending");
  } finally {
    timers.forEach(clearTimeout); detach(); owner.stop(); unblock();
    await Promise.allSettled([owner.closed]);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
