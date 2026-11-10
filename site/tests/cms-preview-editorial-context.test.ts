// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { createRequire } from "node:module";
import type { Firestore } from "firebase-admin/firestore";
import type { S3Client } from "@aws-sdk/client-s3";
import { createPublicArtifactInventoryReceipt } from "../src/lib/public-artifact-inventory";
import { createCmsPreviewCloudStorage, retainCloudEditorialPreviewContext, editorialPreviewContextId } from "../scripts/cms-preview-cloud-storage";
import { EDITORIAL_CONTEXTS_COLLECTION, EDITORIAL_SEALS_COLLECTION, LAST_SEALED_EDITORIAL_CONTEXT } from "../scripts/cms-preview-editorial-context";
import { PUBLICATION_ORIGIN_HEADER, PUBLICATION_ORIGIN_VALUE } from "../scripts/activate-public-worker-candidate";

const { PutObjectCommand } = createRequire(new URL("../../functions/package.json", import.meta.url))("@aws-sdk/client-s3");
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const operationId = "22222222222222222222";
const source = "a".repeat(40);
const runtime = { owner: "cloudflare", release: source };
const currentPath = "system/publicDeployment/aggregateContexts/current";
const contextPath = "system/publicDeployment/contexts/public";
const queuePath = `cmsPublishQueue/${operationId}`;
const contextDigest = hash("njpbs-public-context-v1:2");
const preparationPath = `${queuePath}/backgroundPreparation/${contextDigest}`;
const directories: string[] = [];
afterEach(async () => { vi.useRealTimers(); vi.unstubAllGlobals(); await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function fixture(bucket = "njpbs-cms-previews", selectedOperationId = operationId,
  { revision = 2, release = source, generation = 286, checkpointFiles = 0 } = {}, contextSignal?: AbortSignal) {
  const source = release;
  const runtime = { owner: "cloudflare", release };
  const contextDigest = hash(`njpbs-public-context-v1:${revision}`);
  const operationId = selectedOperationId;
  const queuePath = `cmsPublishQueue/${operationId}`;
  const preparationPath = `${queuePath}/backgroundPreparation/${contextDigest}`;
  const cutoffAt = { seconds: 1_780_000_000, nanoseconds: 0, toMillis: () => 1_780_000_000_000 };
  const receipt = createPublicArtifactInventoryReceipt({ reservation: { schemaVersion: 1,
    buildBatchId: `post-background-${operationId}-${contextDigest}`, generation: generation + 1, status: "reserved", commitSha: source,
    reservedAgainstGeneration: generation, reservedAgainstDeploymentId: "deployment-286", reservedAgainstCommitSha: source, cutoffAt, reservedAt: cutoffAt },
    pages: [], posts: [], programs: [], authors: [], settings: [] });
  const context = { schemaVersion: 3, pages: [], posts: [], programs: [], authors: [], settings: [], receipt };
  const bytes = Buffer.from(`${JSON.stringify(context)}\n`);
  const publication = { schemaVersion: 1 as const, digestAlgorithm: "sha256" as const, buildBatchId: "cms-11111111111111111111",
    generation, commitSha: source, mediaManifestDigest: "b".repeat(64), artifactDigest: "c".repeat(64), artifactReceiptDigest: "d".repeat(64) };
  const identity = { operationId, runtime, contextRevision: revision, contextDigest };
  const rows = new Map<string, any>([
    [currentPath, { ...identity, preparationOperationId: operationId }], [contextPath, { schemaVersion: 1, revision }],
    ["system/publicDeployment", { state: "idle", activeGeneration: generation, activeCommitSha: source }],
    ["system/cmsPublicationRuntime", { schemaVersion: 1, phase: "ready", commitSha: source, serializerId: "cloudflare-publisher" }],
    [queuePath, { transport: "public-context-no-build-v1", runtime, status: "success", publicContext: identity,
      aggregateReceipt: { runtime, contextRevision: revision, contextDigest, preparationOperationId: operationId, outputs: Object.fromEntries(
        ["listings", "authors", "feed", "contentApi", "sitemap", "search"].map(output => [output,
          { rendererSha: source, contextRevision: revision, contextDigest, revision: 1, verifiedAt: 1780000000000,
            taskPath: `${queuePath}/backgroundOutputs/${output}` }])) } }],
    [preparationPath, { runtime, status: "verified", contextDigest, preparedDigest: "e".repeat(64),
      reservation: { buildBatchId: receipt.buildBatchId, generation: generation + 1, commitSha: source } }],
  ]);
  const snapshot = (key: string) => ({ exists: rows.has(key), data: () => rows.get(key) });
  let afterRead = (_key: string) => {};
  const ref = (key: string) => ({ path: key, get: async () => {
    const result = snapshot(key); afterRead(key); return result;
  } });
  const firestore = { doc: ref, collection: (collection: string) => ({ doc: (id: string) => ref(`${collection}/${id}`) }),
    runTransaction: async (fn: any) => {
      const writes: (() => void)[] = [];
      const result = await fn({ get: async (r: any) => snapshot(r.path), getAll: async (...refs: any[]) => refs.map(r => snapshot(r.path)),
        set: (r: any, data: any) => writes.push(() => rows.set(r.path, structuredClone(data))),
        create: (r: any, data: any) => writes.push(() => rows.set(r.path, structuredClone(data))),
        update: (r: any, data: any) => writes.push(() => rows.set(r.path, { ...rows.get(r.path), ...structuredClone(data) })) });
      writes.forEach(write => write()); return result;
    } } as unknown as Firestore;
  const objects = new Map<string, Buffer>(); let afterPut = () => {}; let afterGet = () => {};
  const send = vi.fn(async (command: any) => {
    expect(command.input.Bucket).toBe(bucket); const key = command.input.Key;
    if (command instanceof PutObjectCommand) {
      expect(command.input.IfNoneMatch).toBe("*");
      if (objects.has(key)) throw { $metadata: { httpStatusCode: 412 } };
      objects.set(key, Buffer.from(command.input.Body)); afterPut(); return {};
    }
    const stored = objects.get(key); if (!stored) throw { $metadata: { httpStatusCode: 404 } };
    afterGet();
    return { ContentLength: stored.length, Body: { transformToWebStream: () => Readable.toWeb(Readable.from([stored])) } };
  });
  const client = { send } as unknown as S3Client;
  const directory = await mkdtemp(path.join(tmpdir(), "editorial-preview-context-")); directories.push(directory);
  const file = path.join(directory, "public-context.json"); await writeFile(file, bytes, { mode: 0o600 });
  const checkpoint = Buffer.from(JSON.stringify({ schemaVersion: 1,
    identity: { operationId, contextDigest, commitSha: source, owner: "cloudflare", cutoffMillis: 1780000000000, admissionRevision: null },
    files: [{ path: "public-context.json", digest: hash(bytes), size: bytes.length },
      ...Array.from({ length: checkpointFiles }, (_, index) => ({ path: `files/programs/${"retained-".repeat(15)}${index}/index.html`,
        digest: "f".repeat(64), size: 100 }))] }));
  rows.get(preparationPath).preparedDigest = hash(checkpoint);
  rows.get(preparationPath).admissionRevision = null;
  rows.get(preparationPath).reservation.cutoffAt = cutoffAt;
  const checkpointFile = path.join(directory, ".checkpoint-prepared.json");
  await writeFile(checkpointFile, checkpoint, { mode: 0o600 });
  const target = bucket === "template-dev-cms-previews" ? { bucket, deploymentEnvironment: "development" } : {};
  const claim = "R".repeat(20);
  const retain = (selectedOperationId = operationId) => {
    const queue = rows.get(`cmsPublishQueue/${selectedOperationId}`);
    queue.previewContext = { status: "building", claim, manifestId: editorialPreviewContextId(publication, contextDigest, selectedOperationId),
      contextDigest, publicationArtifactReceiptDigest: publication.artifactReceiptDigest,
      publicationGeneration: publication.generation, attempts: 1, startedAt: Date.now(), nextAttemptAt: Date.now() + 600_000 };
    return retainCloudEditorialPreviewContext({ firestore, file, operationId: selectedOperationId, publication,
      claim, serializerId: "cloudflare-publisher", client, ...target });
  };
  const storage = createCmsPreviewCloudStorage({ client, contextMode: "editorial", contextSignal, ...target });
  const request = vi.fn(async (_url?: string) => JSON.stringify(publication));
  const read = () => storage.readPublicContext(firestore, request);
  const readReady = () => {
    vi.stubGlobal("fetch", async (url: string) => new Response(await request(url), {
      headers: { "Content-Type": "application/json", [PUBLICATION_ORIGIN_HEADER]: PUBLICATION_ORIGIN_VALUE },
    }));
    return storage.readEditorialPublicContext(firestore);
  };
  const manifestPath = `${EDITORIAL_CONTEXTS_COLLECTION}/${editorialPreviewContextId(publication, contextDigest, operationId)}`;
  const sealPath = `${EDITORIAL_SEALS_COLLECTION}/${editorialPreviewContextId(publication, contextDigest, operationId)}`;
  return { rows, objects, send, file, checkpointFile, context, publication, retain, firestore, read, readReady, request, manifestPath, sealPath,
    afterRead: (fn: (key: string) => void) => { afterRead = fn; },
    afterGet: (fn: () => void) => { afterGet = fn; },
    afterPut: (fn: () => void) => { afterPut = fn; } };
}

// #3686, October 19: revision 511 was building at 19:32Z; a run of Post
// publishes reached 519 at 20:02Z. A preview must wait for the latest seal.
it.each(["publish", "release"])("waits for current context and retention after a %s", async kind => {
  const first = await fixture("njpbs-cms-previews", operationId, { revision: 511, generation: 308 });
  const next = await fixture("njpbs-cms-previews", "33333333333333333333",
    { revision: 519, generation: kind === "release" ? 309 : 308, release: kind === "release" ? "f".repeat(40) : source });
  await next.retain();
  first.rows.get(`${queuePath}/backgroundPreparation/${hash("njpbs-public-context-v1:511")}`).status = "building";
  if (kind === "release") first.request.mockResolvedValue(JSON.stringify(next.publication));
  vi.useFakeTimers();
  const result = first.readReady();
  const assertion = expect(result).resolves.toEqual({ publicContext: next.context, publication: next.publication });
  await vi.advanceTimersByTimeAsync(0);
  // The publication and current revision can move while the preview waits.
  next.rows.forEach((value, key) => first.rows.set(key, value));
  first.rows.delete(next.manifestPath);
  Object.assign(first.rows.get("cmsPublishQueue/33333333333333333333").previewContext,
    { status: "building", claim: "R".repeat(20), attempts: 1, startedAt: Date.now(), nextAttemptAt: Date.now() + 600_000 });
  first.request.mockResolvedValue(JSON.stringify(next.publication));
  await vi.advanceTimersByTimeAsync(5_000);
  first.rows.set(next.manifestPath, next.rows.get(next.manifestPath));
  next.objects.forEach((value, key) => first.objects.set(key, value));
  await vi.advanceTimersByTimeAsync(5_000);
  await assertion;
});

it("restarts the entire read when the publication moves between receipt probes", async () => {
  const first = await fixture(); await first.retain();
  const next = await fixture("njpbs-cms-previews", "33333333333333333333",
    { revision: 519, generation: 308, release: "f".repeat(40) });
  await next.retain();
  first.request.mockResolvedValueOnce(JSON.stringify(first.publication)).mockImplementation(async () => {
    next.rows.forEach((value, key) => first.rows.set(key, value));
    next.objects.forEach((value, key) => first.objects.set(key, value));
    return JSON.stringify(next.publication);
  });
  vi.useFakeTimers();
  const result = first.readReady();
  const assertion = expect(result).resolves.toEqual({ publicContext: next.context, publication: next.publication });
  await vi.advanceTimersByTimeAsync(5_000);
  await assertion;
});

it("bounds the readiness wait and never returns stale content", async () => {
  const f = await fixture(); await f.retain();
  f.rows.get(contextPath).revision++;
  f.rows.delete(LAST_SEALED_EDITORIAL_CONTEXT);
  vi.useFakeTimers();
  const result = f.readReady();
  const assertion = expect(result).rejects.toMatchObject({ code: "preview_context_refreshing" });
  await vi.advanceTimersByTimeAsync(240_000);
  await assertion;
  expect(vi.getTimerCount()).toBe(0);
});

it("shares one readiness window across two queued previews and resets it after a complete read", async () => {
  const f = await fixture(); await f.retain();
  f.rows.get(preparationPath).status = "building";
  vi.useFakeTimers();
  const first = expect(f.readReady()).rejects.toMatchObject({ code: "preview_context_refreshing" });
  await vi.advanceTimersByTimeAsync(240_000);
  await first;
  let secondState = "waiting";
  const second = f.readReady().then(() => { secondState = "ready"; }, () => { secondState = "failed"; });
  await vi.advanceTimersByTimeAsync(0);
  expect(secondState).toBe("failed");
  await second;
  expect(vi.getTimerCount()).toBe(0);

  f.rows.get(preparationPath).status = "verified";
  expect(await f.readReady()).toEqual({ publicContext: f.context, publication: f.publication });
  f.rows.get(preparationPath).status = "building";
  const fresh = expect(f.readReady()).resolves.toEqual({ publicContext: f.context, publication: f.publication });
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(1);
  f.rows.get(preparationPath).status = "verified";
  await vi.advanceTimersByTimeAsync(5_000);
  await fresh;
});

it("opens a new shared window after the cooldown for a later publish without an intervening successful preview", async () => {
  const first = await fixture("njpbs-cms-previews", operationId, { revision: 511, generation: 308 });
  const next = await fixture("njpbs-cms-previews", "33333333333333333333", { revision: 519, generation: 308 });
  await next.retain();
  first.rows.get(`${queuePath}/backgroundPreparation/${hash("njpbs-public-context-v1:511")}`).status = "building";
  vi.useFakeTimers();
  const expired = expect(first.readReady()).rejects.toMatchObject({ code: "preview_context_refreshing" });
  await vi.advanceTimersByTimeAsync(240_000);
  await expired;
  await vi.advanceTimersByTimeAsync(59_999);
  await expect(first.readReady()).rejects.toMatchObject({ code: "preview_context_refreshing" });

  // A later Post publish starts after the cooldown; no preview has succeeded.
  await vi.advanceTimersByTimeAsync(1);
  next.rows.forEach((value, key) => first.rows.set(key, value));
  first.rows.get(`cmsPublishQueue/33333333333333333333/backgroundPreparation/${hash("njpbs-public-context-v1:519")}`).status = "building";
  let state = "waiting";
  const later = first.readReady().then(value => { state = "ready"; return value; }, error => { state = "failed"; return error; });
  await vi.advanceTimersByTimeAsync(0);
  expect(state).toBe("waiting");
  first.rows.get(`cmsPublishQueue/33333333333333333333/backgroundPreparation/${hash("njpbs-public-context-v1:519")}`).status = "verified";
  next.objects.forEach((value, key) => first.objects.set(key, value));
  first.request.mockResolvedValue(JSON.stringify(next.publication));
  await vi.advanceTimersByTimeAsync(5_000);
  expect(await later).toEqual({ publicContext: next.context, publication: next.publication });
  expect(state).toBe("ready");
  expect(vi.getTimerCount()).toBe(0);
});

it("stops readiness polling within one interval of runtime shutdown", async () => {
  const controller = new AbortController();
  const f = await fixture("njpbs-cms-previews", operationId, {}, controller.signal);
  f.rows.get(preparationPath).status = "building";
  vi.useFakeTimers();
  let state = "waiting";
  const stopped = f.readReady().then(() => { state = "ready"; }, () => { state = "stopped"; });
  await vi.advanceTimersByTimeAsync(0);
  controller.abort();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(state).toBe("stopped");
  await stopped;
  expect(vi.getTimerCount()).toBe(0);
});

it("does not retry or relabel corrupt retained context as refreshing", async () => {
  const f = await fixture(); await f.retain();
  f.objects.set(f.rows.get(f.manifestPath).key, Buffer.from("corrupt"));
  vi.useFakeTimers();
  await expect(f.readReady()).rejects.toThrow(/unavailable/);
  expect(f.request).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["preparation", "retention", "lost-manifest"])("does not wait on a permanent %s failure", async failure => {
  const f = await fixture(); await f.retain();
  if (failure === "preparation") Object.assign(f.rows.get(preparationPath), { status: "failed", attempts: 4, nextAttemptAt: null });
  else {
    f.rows.delete(f.manifestPath);
    if (failure === "retention") Object.assign(f.rows.get(queuePath).previewContext,
      { status: "failed", attempts: 4, nextAttemptAt: null });
  }
  vi.useFakeTimers();
  await expect(f.readReady()).rejects.toThrow(/^Editorial preview context is unavailable$/);
  expect(vi.getTimerCount()).toBe(0);
});

it("waits for retention that still has an automatic retry", async () => {
  const f = await fixture(); await f.retain();
  const manifest = f.rows.get(f.manifestPath);
  f.rows.delete(f.manifestPath);
  Object.assign(f.rows.get(queuePath).previewContext, { status: "failed", attempts: 1, nextAttemptAt: Date.now() + 1_000 });
  vi.useFakeTimers();
  const assertion = expect(f.readReady()).resolves.toEqual({ publicContext: f.context, publication: f.publication });
  await vi.advanceTimersByTimeAsync(0);
  f.rows.set(f.manifestPath, manifest);
  await vi.advanceTimersByTimeAsync(5_000);
  await assertion;
});

it("accepts retention that commits after the initial missing-manifest read", async () => {
  const f = await fixture(); await f.retain();
  const manifest = f.rows.get(f.manifestPath);
  f.rows.delete(f.manifestPath);
  f.rows.get(queuePath).previewContext.status = "building";
  f.afterRead(key => {
    if (key !== f.manifestPath) return;
    f.rows.set(f.manifestPath, manifest);
    f.rows.get(queuePath).previewContext.status = "verified";
  });
  expect(await f.readReady()).toEqual({ publicContext: f.context, publication: f.publication });
});

it.each(["njpbs-cms-previews", "template-dev-cms-previews"])("reads editorial context off OFJ with its original reservation in %s", async bucket => {
  const f = await fixture(bucket); await f.retain(); await rm(f.file); await rm(f.checkpointFile); await f.retain();
  expect(await f.read()).toEqual({ publicContext: f.context, publication: f.publication });
  expect(f.context.receipt.buildBatchId).not.toBe(f.publication.buildBatchId);
  expect(f.rows.get(queuePath).previewContext.status).toBe("verified");
  expect(f.send.mock.calls.filter(([command]) => command instanceof PutObjectCommand)).toHaveLength(1);
});

it.each(["cancelled", "stale-context", "source", "preparation"])("refuses %s before upload and old-context fallback", async failure => {
  const f = await fixture();
  if (failure === "cancelled") f.rows.get(queuePath).status = failure;
  if (failure === "stale-context") f.rows.get(contextPath).revision++;
  if (failure === "source") f.rows.get("system/publicDeployment").activeCommitSha = "f".repeat(40);
  if (failure === "preparation") f.rows.get(preparationPath).preparedDigest = "invalid";
  await expect(f.retain()).rejects.toThrow(/unavailable/); await expect(f.read()).rejects.toThrow(/unavailable/);
  expect(f.send).not.toHaveBeenCalled(); expect(f.rows.has(f.manifestPath)).toBe(false);
});

it("retries response loss after upload without publishing an unverified manifest", async () => {
  const f = await fixture(); f.send.mockImplementationOnce(async () => { throw { $metadata: { httpStatusCode: 404 } }; })
    .mockImplementationOnce(async (command: any) => { f.objects.set(command.input.Key, Buffer.from(command.input.Body)); throw new Error("lost response"); });
  await expect(f.retain()).rejects.toThrow("lost response"); expect(f.rows.has(f.manifestPath)).toBe(false);
  await f.retain(); expect(await f.read()).toEqual({ publicContext: f.context, publication: f.publication });
});

it.each(["context", "code"])("does not publish a manifest after a %s race during upload", async race => {
  const f = await fixture(); f.afterPut(() => {
    if (race === "context") f.rows.get(contextPath).revision++;
    else f.rows.get("system/publicDeployment").activeGeneration++;
  });
  await expect(f.retain()).rejects.toThrow(/unavailable|changed/);
  expect(f.objects.size).toBe(1); expect(f.rows.has(f.manifestPath)).toBe(false);
  expect(f.rows.get(queuePath).previewContext).toMatchObject({ status: "building", claim: "R".repeat(20) });
});

it("fails closed for a missing manifest or corrupt object", async () => {
  const f = await fixture(); await expect(f.read()).rejects.toThrow(/unavailable/);
  await f.retain(); const key = f.rows.get(f.manifestPath).key; f.objects.set(key, Buffer.from("corrupt"));
  await expect(f.read()).rejects.toThrow(/unavailable/); await expect(f.retain()).rejects.toThrow(/unavailable/);
  expect(f.send.mock.calls.filter(([command]) => command instanceof PutObjectCommand)).toHaveLength(1);
});

it("refuses a bundle from another preparation before contacting storage", async () => {
  const f = await fixture();
  f.rows.get(preparationPath).reservation.generation = 288;
  await expect(f.retain()).rejects.toThrow(/unavailable/);
  expect(f.send).not.toHaveBeenCalled(); expect(f.rows.has(f.manifestPath)).toBe(false);
});

it("rejects same-receipt bytes that differ from the verified preparation checkpoint", async () => {
  const f = await fixture();
  await writeFile(f.file, `${JSON.stringify(f.context)}\n\n`, { mode: 0o600 });
  await expect(f.retain()).rejects.toThrow(/unavailable/);
  expect(f.send).not.toHaveBeenCalled(); expect(f.rows.has(f.manifestPath)).toBe(false);
});

it("retains a same-context successor separately without changing its predecessor", async () => {
  const first = await fixture(); await first.retain();
  const before = structuredClone(first.rows.get(first.manifestPath));
  const next = await fixture("njpbs-cms-previews", "33333333333333333333"); await next.retain();
  expect(next.manifestPath).not.toBe(first.manifestPath);
  next.rows.forEach((value, key) => first.rows.set(key, value));
  next.objects.forEach((value, key) => first.objects.set(key, value));
  expect(await first.read()).toEqual({ publicContext: next.context, publication: next.publication });
  expect(first.rows.get(first.manifestPath)).toEqual(before);
});

it("rejects context change between read fences and code release between receipt probes", async () => {
  const f = await fixture(); await f.retain();
  f.request.mockImplementationOnce(async () => JSON.stringify(f.publication)).mockImplementationOnce(async () => {
    f.rows.get(contextPath).revision++; f.rows.get(contextPath).withdrawalRevision = 1; return JSON.stringify(f.publication);
  });
  await expect(f.read()).rejects.toThrow(/unavailable|changed/); f.rows.get(contextPath).revision = 2; f.rows.get(contextPath).withdrawalRevision = 0;
  f.request.mockResolvedValueOnce(JSON.stringify(f.publication)).mockResolvedValueOnce(JSON.stringify({ ...f.publication, generation: 288 }));
  await expect(f.read()).rejects.toThrow(/changed while reading/);
});


it("retains editorial context from a complete record checkpoint above 2 MiB", async () => {
  const f = await fixture("njpbs-cms-previews", operationId, { checkpointFiles: 9980 });
  await expect((await import("node:fs/promises")).stat(f.checkpointFile).then(stat => stat.size)).resolves.toBeGreaterThan(2 * 1024 * 1024);
  await f.retain();
  await expect(f.readReady()).resolves.toEqual({ publicContext: f.context, publication: f.publication });
});


it.each(["pending", "failed"])("retains and reads verified content while unrelated public outputs are %s", async status => {
  const f = await fixture();
  const queue = f.rows.get(queuePath);
  queue.status = status;
  queue.aggregateReceipt = null;
  for (const output of ["listings", "authors", "feed", "contentApi", "sitemap", "search", "programs", "events"]) {
    f.rows.set(`cmsBackgroundOutputs/${output}`, { status, contextDigest: "f".repeat(64) });
  }
  await f.retain();
  expect(await f.readReady()).toEqual({ publicContext: f.context, publication: f.publication });
  expect(queue.status).toBe(status);
  expect(queue.aggregateReceipt).toBeNull();
  expect(f.rows.get(queuePath).previewContext.status).toBe("verified");
});

it.each([0, 1])("waits through retryable preparation attempt %i and recovers without a new preview request", async attempts => {
  const f = await fixture(); await f.retain();
  Object.assign(f.rows.get(preparationPath), { status: "failed", attempts, nextAttemptAt: Date.now() + 1_000 });
  vi.useFakeTimers();
  const result = expect(f.readReady()).resolves.toEqual({ publicContext: f.context, publication: f.publication });
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(1);
  f.rows.get(preparationPath).status = "verified";
  await vi.advanceTimersByTimeAsync(5_000);
  await result;
  expect(vi.getTimerCount()).toBe(0);
});


it("uses the last sealed context during an ordinary publish burst without a readiness interval", async () => {
  const f = await fixture(); await f.retain();
  f.rows.get(contextPath).revision++;
  vi.useFakeTimers();
  expect(await f.readReady()).toMatchObject({ publicContext: f.context, publication: f.publication });
  expect(vi.getTimerCount()).toBe(0);
  expect(f.rows.get(f.sealPath)).toMatchObject({ schemaVersion: 2, withdrawalRevision: 0 });
});

it("keeps the deployed reader's strict schema-one wire contract beside a new seal", async () => {
  const f = await fixture(); await f.retain();
  const legacy = f.rows.get(f.manifestPath), seal = f.rows.get(f.sealPath);
  expect(legacy.schemaVersion).toBe(1);
  expect(Object.keys(legacy).sort()).toEqual(["byteLength", "contextReceipt", "key", "schemaVersion", "selection", "sha256"]);
  expect(seal).toEqual({ ...legacy, schemaVersion: 2, withdrawalRevision: 0 });
  expect(f.objects.size).toBe(1);
  expect(await f.read()).toEqual({ publicContext: f.context, publication: f.publication });
});

it("never qualifies a legacy-only manifest when retention is retried", async () => {
  const f = await fixture(); await f.retain();
  const legacy = structuredClone(f.rows.get(f.manifestPath));
  f.rows.delete(f.sealPath); f.rows.delete(LAST_SEALED_EDITORIAL_CONTEXT);
  await rm(f.file); await rm(f.checkpointFile);
  await f.retain();
  expect(f.rows.get(f.manifestPath)).toEqual(legacy);
  expect(f.rows.has(f.sealPath)).toBe(false);
  expect(f.rows.has(LAST_SEALED_EDITORIAL_CONTEXT)).toBe(false);
  f.rows.get(contextPath).revision++;
  await expect(f.read()).rejects.toMatchObject({ code: "preview_context_refreshing" });
});

it.each(["seal-only", "different-seal"])("refuses a %s pair instead of rewriting immutable metadata", async reason => {
  const f = await fixture(); await f.retain();
  if (reason === "seal-only") f.rows.delete(f.manifestPath);
  else f.rows.get(f.sealPath).sha256 = "f".repeat(64);
  const before = structuredClone(f.rows.get(f.sealPath));
  await expect(f.retain()).rejects.toThrow();
  expect(f.rows.get(f.sealPath)).toEqual(before);
  expect(f.send.mock.calls.filter(([command]) => command instanceof PutObjectCommand)).toHaveLength(1);
});

it.each(["old", "missing-withdrawal", "withdrawal", "code-generation", "code-sha", "code-digest", "preparation", "cancelled"])(
  "refuses the %s sealed context and keeps the bounded readiness path", async reason => {
    const f = await fixture(); await f.retain();
    f.rows.get(contextPath).revision++;
    const manifest = f.rows.get(f.sealPath);
    if (reason === "old") { manifest.schemaVersion = 1; delete manifest.withdrawalRevision; }
    if (reason === "missing-withdrawal") delete manifest.withdrawalRevision;
    if (reason === "withdrawal") f.rows.get(contextPath).withdrawalRevision = 1;
    if (reason === "code-generation") f.request.mockResolvedValue(JSON.stringify({ ...f.publication, generation: 287 }));
    if (reason === "code-sha") f.request.mockResolvedValue(JSON.stringify({ ...f.publication, commitSha: "f".repeat(40) }));
    if (reason === "code-digest") f.request.mockResolvedValue(JSON.stringify({ ...f.publication, artifactReceiptDigest: "f".repeat(64) }));
    if (reason === "preparation") f.rows.get(preparationPath).preparedDigest = "f".repeat(64);
    if (reason === "cancelled") f.rows.get(queuePath).status = "cancelled";
    // Invalid original provenance is terminal; freshness/metadata mismatches
    // retry the unchanged readiness owner instead of accepting older bytes.
    if (reason === "preparation") await expect(f.read()).rejects.toThrow(/unavailable/);
    else await expect(f.read()).rejects.toMatchObject({ code: "preview_context_refreshing" });
  });

it.each(["withdrawal", "code", "pointer"])("rechecks %s after reading fallback bytes", async race => {
  const f = await fixture(); await f.retain();
  f.rows.get(contextPath).revision++;
  f.afterGet(() => {
    if (race === "withdrawal") f.rows.get(contextPath).withdrawalRevision = 1;
    if (race === "code") f.request.mockResolvedValue(JSON.stringify({ ...f.publication, artifactDigest: "f".repeat(64) }));
    if (race === "pointer") f.rows.delete(LAST_SEALED_EDITORIAL_CONTEXT);
  });
  await expect(f.read()).rejects.toMatchObject({ code: "preview_context_refreshing" });
});

it("keeps corrupt fallback bytes terminal without scanning older contexts", async () => {
  const f = await fixture(); await f.retain();
  f.rows.get(contextPath).revision++;
  f.objects.set(f.rows.get(f.sealPath).key, Buffer.from("corrupt"));
  await expect(f.read()).rejects.toThrow(/^Editorial preview context is unavailable$/);
});

it("reads an old manifest at the exact current context without qualifying it for fallback", async () => {
  const f = await fixture(); await f.retain();
  f.rows.delete(f.sealPath);
  expect(f.rows.get(f.manifestPath).schemaVersion).toBe(1);
  expect(await f.read()).toEqual({ publicContext: f.context, publication: f.publication });
  f.rows.get(contextPath).revision++;
  await expect(f.read()).rejects.toMatchObject({ code: "preview_context_refreshing" });
});


it.each(["withdrawal", "code"])("rechecks %s immediately before input freeze after returning fallback bytes", async race => {
  const f = await fixture(); await f.retain(); f.rows.get(contextPath).revision++;
  const result = await f.read();
  if (race === "withdrawal") f.rows.get(contextPath).withdrawalRevision = 1;
  else f.request.mockResolvedValue(JSON.stringify({ ...f.publication, mediaManifestDigest: "f".repeat(64) }));
  if (!("verifyBeforeFreeze" in result) || typeof result.verifyBeforeFreeze !== "function") {
    throw new Error("Fallback omitted its freeze fence");
  }
  await expect(result.verifyBeforeFreeze()).rejects.toMatchObject({ code: "preview_context_refreshing" });
});

it("does not retain a withdrawal revision that changes during upload", async () => {
  const f = await fixture();
  f.afterPut(() => { f.rows.get(contextPath).withdrawalRevision = 1; });
  await expect(f.retain()).rejects.toThrow(/changed during retention/);
  expect(f.rows.has(f.sealPath)).toBe(false);
  expect(f.rows.has(LAST_SEALED_EDITORIAL_CONTEXT)).toBe(false);
});


it("keeps the selected seal safe when a newer same-code context is sealed before freeze", async () => {
  const f = await fixture(); await f.retain(); f.rows.get(contextPath).revision++;
  const result = await f.read();
  const next = await fixture("njpbs-cms-previews", "33333333333333333333", { revision: 3 }); await next.retain();
  next.rows.forEach((value, key) => f.rows.set(key, value));
  if (!("verifyBeforeFreeze" in result) || typeof result.verifyBeforeFreeze !== "function") {
    throw new Error("Fallback omitted its freeze fence");
  }
  await expect(result.verifyBeforeFreeze()).resolves.toBeUndefined();
});

it("keeps waiting when an arbitrary cancellation invalidates the last sealed aggregate", async () => {
  const f = await fixture(); await f.retain();
  f.rows.get(contextPath).revision++;
  f.rows.get(queuePath).status = "cancelled";
  vi.useFakeTimers();
  let settled = false;
  const result = f.readReady().then(value => { settled = true; return value; });
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).toBe(false);
  expect(vi.getTimerCount()).toBe(1);
  const next = await fixture("njpbs-cms-previews", "33333333333333333333", { revision: 3 }); await next.retain();
  next.rows.forEach((value, key) => f.rows.set(key, value));
  next.objects.forEach((value, key) => f.objects.set(key, value));
  await vi.advanceTimersByTimeAsync(5_000);
  expect(await result).toEqual({ publicContext: next.context, publication: next.publication });
});

it.each(["pending", "failed"])("selects a newly sealed %s aggregate after ordinary supersession", async status => {
  const f = await fixture(); f.rows.get(queuePath).status = status; await f.retain();
  f.rows.get(contextPath).revision++;
  Object.assign(f.rows.get(queuePath), { status: "cancelled", error: "public_context_superseded" });
  vi.useFakeTimers();
  const result = await f.readReady();
  expect(result).toMatchObject({ publicContext: f.context, publication: f.publication });
  expect(vi.getTimerCount()).toBe(0);
  if (!("verifyBeforeFreeze" in result) || typeof result.verifyBeforeFreeze !== "function") {
    throw new Error("Fallback omitted its freeze fence");
  }
  await expect(result.verifyBeforeFreeze()).resolves.toBeUndefined();
  f.rows.get(contextPath).withdrawalRevision = 1;
  await expect(f.read()).rejects.toMatchObject({ code: "preview_context_refreshing" });
});

it.each(["pending", "failed"])("keeps an already selected %s seal through ordinary supersession before freeze", async status => {
  const f = await fixture(); f.rows.get(queuePath).status = status; await f.retain();
  f.rows.get(contextPath).revision++;
  const result = await f.read();
  Object.assign(f.rows.get(queuePath), { status: "cancelled", error: "public_context_superseded" });
  if (!("verifyBeforeFreeze" in result) || typeof result.verifyBeforeFreeze !== "function") {
    throw new Error("Fallback omitted its freeze fence");
  }
  await expect(result.verifyBeforeFreeze()).resolves.toBeUndefined();
  f.rows.get(contextPath).withdrawalRevision = 1;
  await expect(result.verifyBeforeFreeze()).rejects.toMatchObject({ code: "preview_context_refreshing" });
});
