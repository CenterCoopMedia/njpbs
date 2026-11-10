import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import namespace from "../../functions/lib/no-build-record-namespace.js";
import publication from "../../functions/lib/public-context-publication.js";
import background from "../../functions/lib/post-background-outputs.js";
import context from "../../functions/lib/public-context-revision.js";

const app = initializeApp({ projectId: "demo-njpbs-record-namespace" }, "record-namespace-proof");
const db = getFirestore(app);
const runtime = { owner: "cloudflare", release: "a".repeat(40) };
const id = "A".repeat(20);
const baseline = ["listings", "authors", "feed", "contentApi", "sitemap", "search"];
beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") || process.env.GCLOUD_PROJECT !== "demo-njpbs") {
    throw new Error("Use the local demo Firestore emulator.");
  }
});
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs-record-namespace/databases/(default)/documents`, { method: "DELETE" });
  await db.doc("system/publicDeployment").set({ state: "idle", activeCommitSha: runtime.release });
  await db.doc(context.PUBLIC_CONTEXT_PATH).set({ schemaVersion: 1, revision: 1 });
  await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: "ready", commitSha: runtime.release, serializerId: "cloudflare-publisher" });
});
afterAll(async () => { await deleteApp(app); });
async function enqueue(operationId = id, recordFamily?: string, contextRevision = 1) {
  return db.runTransaction(async transaction => {
    const work = await publication.enqueuePublicContextInTransaction({ firestore: db, transaction, runtime,
      operationId, recordFamily, reason: "context", contextRevision });
    work.write();
    return work.outputs;
  });
}

it("keeps the six-output legacy contract until a record family is registered", async () => {
  expect(await enqueue()).toEqual(baseline);
  expect((await db.doc(namespace.NAMESPACE_PATH).get()).exists).toBe(false);
  const job = (await db.doc(`cmsPublishQueue/${id}`).get()).data();
  expect(job?.publicContext).not.toHaveProperty("recordFamilies");
  expect(namespace.contextOutputs(job?.publicContext)).toEqual(baseline);
});
it("registers Program namespace and context work atomically and keeps retries idempotent", async () => {
  expect(await enqueue(id, "programs")).toEqual([...baseline, "programs"]);
  expect((await db.doc(namespace.NAMESPACE_PATH).get()).data()).toEqual({ schemaVersion: 1, families: ["programs"] });
  const queue = db.doc(`cmsPublishQueue/${id}`);
  const before = await queue.get();
  expect(before.data()?.publicContext.recordFamilies).toEqual(["programs"]);
  expect((await queue.collection("backgroundOutputs").doc("programs").get()).data()).toMatchObject({ output: "programs", status: "pending", contextOnly: true });
  await enqueue(id, "programs");
  expect((await queue.get()).updateTime!.isEqual(before.updateTime!)).toBe(true);
});
it("retains registered families across later settings contexts and adds Event without losing Program", async () => {
  await enqueue(id, "programs");
  await db.doc(context.PUBLIC_CONTEXT_PATH).update({ revision: 2 });
  expect(await enqueue("B".repeat(20), undefined, 2)).toEqual([...baseline, "programs"]);
  await db.doc(context.PUBLIC_CONTEXT_PATH).update({ revision: 3 });
  expect(await enqueue("C".repeat(20), "events", 3)).toEqual([...baseline, "programs", "events"]);
  expect((await db.doc(namespace.NAMESPACE_PATH).get()).data()?.families).toEqual(["programs", "events"]);
});
it("recovers the registered Program family through the actual background owner before context completion", async () => {
  await enqueue(id, "programs");
  let clock = Date.now(), programReady = false;
  const contextDigest = context.publicContextDigest(1);
  const files = new Map<string, Buffer>();
  const paths: Record<string, string[]> = { listings: ["/posts/"], authors: ["/authors/example/"], feed: ["/feeds/news.xml"],
    contentApi: ["/api/v1/content.json"], sitemap: ["/sitemap-index.xml"], search: ["/pagefind/pagefind.js", "/search/meaning-index.json"],
    programs: ["/programs/", "/shows/", "/programs/example/", "/shows/example/"] };
  const ownerOptions = { firestore: db, runtime, enabled: true, postIds: [],
    now: () => clock, readContextInTransaction: (transaction: any) => context.readPublicBackgroundContextInTransaction(transaction, db),
    artifacts: { async put(key: string, bytes: Buffer) { if (!files.has(key)) files.set(key, Buffer.from(bytes)); },
      async get(key: string) { return files.get(key) ?? null; } },
    // Frozen compiler/process boundary; no template or serializer runs here.
    build: async (task: { output: string }) => {
      if (task.output === "programs" && !programReady) throw new Error("The frozen Program fixture is not available yet");
      return { input: { kind: "public-background", rendererSha: runtime.release, contextDigest, routes: [] },
        files: paths[task.output].map(path => ({ path, contentType: path.endsWith(".json") ? "application/json; charset=utf-8"
          : path.endsWith(".js") ? "text/javascript; charset=utf-8" : path.endsWith(".xml") ? "application/xml; charset=utf-8" : "text/html; charset=utf-8",
          bytes: Buffer.from(path.endsWith(".json") ? "{}" : `<!doctype html><html><main>Frozen ${path}</main></html>`) })) };
    } };
  await background.createPostBackgroundOutputs(ownerOptions).recover();
  expect((await db.doc(`cmsPublishQueue/${id}/backgroundOutputs/programs`).get()).data()?.attempts).toBe(0);
  const owner = background.createPostBackgroundOutputs({ ...ownerOptions, recoveryOutputs: [...baseline, "programs"] });
  await owner.recover();
  expect(await publication.settlePublicContext({ firestore: db, operationId: id, runtime })).toBe(false);
  expect((await db.doc("cmsBackgroundOutputs/listings").get()).data()?.status).toBe("verified");
  programReady = true; clock += 120_000;
  await owner.recover();
  expect(await publication.settlePublicContext({ firestore: db, operationId: id, runtime })).toBe(true);
  expect(Object.keys((await db.doc(`cmsPublishQueue/${id}`).get()).data()?.aggregateReceipt.outputs)).toEqual([...baseline, "programs"]);
  const served = await owner.serve(new Request("https://njpbs.org/programs/example/"));
  expect(served?.status).toBe(200);
  expect(await served!.text()).toBe("<!doctype html><html><main>Frozen /programs/example/</main></html>");
});

it("refuses unknown families and corrupt ownership without creating context work", async () => {
  await expect(enqueue(id, "sponsors")).rejects.toMatchObject({ status: 409 });
  expect((await db.doc(`cmsPublishQueue/${id}`).get()).exists).toBe(false);
  await db.doc(namespace.NAMESPACE_PATH).set({ schemaVersion: 1, families: ["programs"], extra: true });
  await expect(enqueue()).rejects.toMatchObject({ status: 409 });
  expect((await db.doc(`cmsPublishQueue/${id}`).get()).exists).toBe(false);
});

it("supersedes pending aliases when registration expands the output set at the same context", async () => {
  await enqueue();
  const successor = "B".repeat(20);
  await enqueue(successor, "programs");
  expect((await db.doc(`cmsPublishQueue/${id}`).get()).data()?.status).toBe("cancelled");
  expect((await db.doc(publication.CURRENT_PATH).get()).data()?.operationIds).toEqual([successor]);
  expect((await db.doc(`cmsPublishQueue/${successor}`).get()).data()?.publicContext.recordFamilies).toEqual(["programs"]);
});


it("serves the 846-Program checkpoint without copying its verified objects", async () => {
  await enqueue(id, "programs");
  const paths = ["/programs/", "/shows/", ...Array.from({ length: 846 }, (_, i) =>
    [`/programs/legacy-${i}/`, `/shows/legacy-${i}/`]).flat()];
  const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const contextDigest = context.publicContextDigest(1), prefix = `post-background-v1/preparation/${id}/${contextDigest}`;
  const objects = new Map<string, Buffer>(), writes: string[] = [];
  const files = paths.map(path => {
    const bytes = Buffer.from(`<!doctype html><html><main>Frozen ${path}</main></html>`), hash = digest(bytes);
    objects.set(`${prefix}/bytes/${hash}`, bytes);
    return { path, file: `${path.slice(1)}index.html`, outputs: ["programs"], digest: hash, size: bytes.length, contentType: "text/html; charset=utf-8" };
  });
  const entries = files.map(file => ({ path: `files/${file.file}`, digest: file.digest, size: file.size }));
  const receipt = Buffer.from(JSON.stringify({ schemaVersion: 2, contextDigest, routes: [], files }));
  objects.set(`${prefix}/bytes/${digest(receipt)}`, receipt);
  entries.push({ path: "receipt.json", digest: digest(receipt), size: receipt.length });
  const metadata = Buffer.from("{}"); objects.set(`${prefix}/bytes/${digest(metadata)}`, metadata);
  for (const path of ["artifact-inventory.json", "public-context.json"]) entries.push({ path, digest: digest(metadata), size: metadata.length });
  const identity = { operationId: id, contextDigest, commitSha: runtime.release, owner: "cloudflare", cutoffMillis: 1000, admissionRevision: null };
  const checkpoint = Buffer.from(JSON.stringify({ schemaVersion: 1, identity, files: entries }));
  objects.set(`${prefix}/prepared.json`, checkpoint);
  await db.doc(`cmsPublishQueue/${id}/backgroundPreparation/${contextDigest}`).set({ runtime, status: "verified", preparedDigest: digest(checkpoint),
    contextDigest, admissionRevision: null, reservation: { commitSha: runtime.release, cutoffAt: Timestamp.fromMillis(1000) } });
  const owner = background.createPostBackgroundOutputs({ firestore: db, runtime, enabled: true, postIds: [], recoveryOutputs: ["programs"],
    readContextInTransaction: (transaction: any) => context.readPublicBackgroundContextInTransaction(transaction, db),
    artifacts: { async put(key: string, bytes: Buffer) { writes.push(key); if (!objects.has(key)) objects.set(key, Buffer.from(bytes)); },
      async get(key: string) { return objects.get(key) ?? null; } },
    build: async () => ({ input: { kind: "public-background", rendererSha: runtime.release, contextDigest, routes: [] },
      prepared: { operationId: id, checkpointDigest: digest(checkpoint) } }),
  });
  await owner.recover();
  const ref = db.doc("cmsBackgroundOutputs/programs"), state = (await ref.get()).data()!;
  expect(state.status).toBe("verified");
  expect(state.receipt.fileManifest.count).toBe(1694);
  expect(Buffer.byteLength(JSON.stringify(state))).toBeLessThan(64 * 1024);
  expect(writes).toHaveLength(1); expect(writes[0]).toMatch(/\/manifest\.json$/);
  expect((await owner.serve(new Request("https://njpbs.org/programs/legacy-845/")))?.status).toBe(200);
  const response = await owner.serve(new Request("https://njpbs.org/shows/legacy-845/"));
  expect(await response!.text()).toBe("<!doctype html><html><main>Frozen /shows/legacy-845/</main></html>");
  objects.delete(`${prefix}/bytes/${files.at(-1)!.digest}`);
  expect((await owner.serve(new Request("https://njpbs.org/shows/legacy-845/")))?.status).toBe(503);
  await ref.update("receipt.fileManifest.digest", "f".repeat(64));
  expect((await owner.serve(new Request("https://njpbs.org/programs/legacy-845/")))?.status).toBe(503);
});

it.each(["stale", "withdrawal"])("serves current record assets during an expired %s predecessor handoff", async reason => {
  await enqueue(id, "programs");
  let clock = Date.now(), revision = 1;
  const objects = new Map<string, Buffer>();
  const artifacts = { async put(key: string, bytes: Buffer) { objects.set(key, Buffer.from(bytes)); },
    async get(key: string) { return objects.get(key) ?? null; } };
  const owner = background.createPostBackgroundOutputs({ firestore: db, runtime, enabled: true, postIds: [], recoveryOutputs: ["programs"],
    now: () => clock, readContextInTransaction: (transaction: any) => context.readPublicBackgroundContextInTransaction(transaction, db), artifacts,
    build: async () => ({ input: { kind: "public-background", rendererSha: runtime.release, contextDigest: context.publicContextDigest(revision), routes: [] },
      files: ["/programs/", "/shows/"].map(path => ({ path, bytes: "<!doctype html>Frozen index", contentType: "text/html" })),
      assets: [{ path: `/_astro/record-${revision}.css`, bytes: `body { --revision: ${revision}; }`, contentType: "text/css" }] }) });
  await owner.recover();
  clock += reason === "stale" ? 24 * 60 * 60_000 + 1 : 60_001;
  revision = 2;
  await db.doc(context.PUBLIC_CONTEXT_PATH).update({ revision, ...(reason === "withdrawal" ? { withdrawalRevision: 1 } : {}) });
  await enqueue("B".repeat(20), undefined, revision);
  await owner.recover();
  expect((await db.doc("cmsBackgroundOutputs/programs").get()).data()?.previousAssets.expiresAt).toBe(clock + 15_000);
  const response = await owner.serve(new Request("https://njpbs.org/_astro/record-2.css"));
  expect(response?.status).toBe(200);
  expect(await response!.text()).toBe("body { --revision: 2; }");
  objects.clear();
  expect((await owner.serve(new Request("https://njpbs.org/_astro/record-2.css")))?.status).toBe(503);
});

it("keeps a static-only asset on its original route after a record manifest is published", async () => {
  const deployment = await import("../../functions/lib/public-deployment.js");
  const publicContent = await import("../../functions/public-content.js");
  await db.doc("system/publicDeployment").set({ ...deployment.default.initialPublicDeploymentPointer(), activeCommitSha: runtime.release,
    activeGeneration: 3, lastReservedGeneration: 3, activeDeploymentId: "fixture-release", newestEligibleGeneration: 3, newestEligibleBuildBatchId: "fixture-release" });
  await enqueue(id, "programs");
  const objects = new Map<string, Buffer>();
  let reads = 0;
  const artifacts = { async put(key: string, bytes: Buffer) { objects.set(key, Buffer.from(bytes)); },
    async get(key: string) { reads++; return objects.get(key) ?? null; } };
  const owner = background.createPostBackgroundOutputs({ firestore: db, runtime, enabled: true, postIds: [], recoveryOutputs: ["programs"],
    readContextInTransaction: (transaction: any) => context.readPublicBackgroundContextInTransaction(transaction, db), artifacts,
    build: async () => ({ input: { kind: "public-background", rendererSha: runtime.release, contextDigest: context.publicContextDigest(1), routes: [] },
      files: ["/programs/", "/shows/"].map(path => ({ path, bytes: "<!doctype html>Frozen index", contentType: "text/html" })),
      assets: [{ path: "/_astro/program.css", bytes: "body { color: blue; }", contentType: "text/css" }] }) });
  await owner.recover();
  const handler = publicContent.default.createCmsGetPublicPageHandler({ firestore: db, backgroundArtifacts: artifacts, log: { error() {}, warn() {} } });
  async function request(path: string) {
    const response: any = { body: null, statusCode: 0, set() { return this; }, status(code: number) { this.statusCode = code; return this; },
      json(body: any) { this.body = body; return this; } };
    await handler({ method: "POST", body: { mode: "no-build-post-v1", path, rendererSha: runtime.release } }, response);
    return response;
  }
  reads = 0;
  const unowned = await request("/_astro/static-only.js");
  expect(unowned.statusCode).toBe(200); expect(unowned.body).toEqual({ kind: "pass" }); expect(reads).toBe(0);
  const selected = await request("/_astro/program.css");
  expect(selected.statusCode).toBe(200); expect(selected.body.status).toBe(200);
  expect(Buffer.from(selected.body.bytes, "base64").toString()).toBe("body { color: blue; }");
  const receipt = (await db.doc("cmsBackgroundOutputs/programs").get()).data()!.receipt;
  const manifest = JSON.parse(objects.get(receipt.fileManifest.key)!.toString());
  objects.delete(manifest.find((file: any) => file.path === "/_astro/program.css").key);
  const missing = await request("/_astro/program.css");
  expect(missing.body.status).toBe(503);
});
