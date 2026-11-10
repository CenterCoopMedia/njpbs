// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { createRequire } from "node:module";
import { S3Client as SiteS3Client } from "@aws-sdk/client-s3";
import type { S3Client, GetObjectCommand as GetCommand, PutObjectCommand as PutCommand, DeleteObjectCommand as DeleteCommand } from "@aws-sdk/client-s3";
import type { Firestore } from "firebase-admin/firestore";
import { createPublicArtifactInventoryReceipt } from "../src/lib/public-artifact-inventory";
import type { PublicArtifactBundle } from "../src/lib/public-artifact-bundle";
import type { PublicPublicationReceipt } from "../src/lib/public-publication-receipt";
import { createCmsPreviewCloudStorage, retainCloudPreviewPublicContext, resolvePreviewContextBucket } from "../scripts/cms-preview-cloud-storage";

const { S3Client: FunctionsS3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } = createRequire(
  new URL("../../functions/package.json", import.meta.url),
)("@aws-sdk/client-s3") as typeof import("@aws-sdk/client-s3");
const queueId = "11111111111111111111";
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const directories: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

function contextFixture(commitSha = "a".repeat(40)) {
  const cutoffAt = { seconds: 1_780_000_000, nanoseconds: 0, toMillis: () => 1_780_000_000_000 };
  const context: PublicArtifactBundle = { schemaVersion: 3, pages: [], posts: [], programs: [], authors: [], settings: [],
    receipt: createPublicArtifactInventoryReceipt({ reservation: { schemaVersion: 1, buildBatchId: `cms-${queueId}`,
      generation: 1, status: "reserved", commitSha, reservedAgainstGeneration: 0,
      reservedAgainstDeploymentId: null, reservedAgainstCommitSha: null, cutoffAt, reservedAt: cutoffAt },
      pages: [], posts: [], programs: [], authors: [], settings: [] }) };
  const publication: PublicPublicationReceipt = { schemaVersion: 1, digestAlgorithm: "sha256", buildBatchId: context.receipt.buildBatchId,
    generation: 1, commitSha: context.receipt.commitSha, mediaManifestDigest: context.receipt.mediaManifestDigest,
    artifactDigest: "d".repeat(64), artifactReceiptDigest: sha(JSON.stringify(context.receipt)) };
  const bytes = Buffer.from(`${JSON.stringify(context)}\n`);
  const manifest = { schemaVersion: 1, buildBatchId: publication.buildBatchId, artifactReceiptDigest: publication.artifactReceiptDigest,
    sha256: sha(bytes), byteLength: bytes.length, key: `public-context/${publication.buildBatchId}/${sha(bytes)}.json` };
  return { context, publication, bytes, manifest };
}

function database(initial?: unknown) {
  let value = initial;
  const snapshot = () => ({ exists: value !== undefined, data: () => value });
  const ref = { get: vi.fn(async () => snapshot()) };
  const create = vi.fn((_ref: unknown, data: unknown) => { value = structuredClone(data); });
  const firestore = { collection: vi.fn(() => ({ doc: vi.fn(() => ref) })),
    doc: () => ({}),
    runTransaction: async (fn: (tx: unknown) => Promise<void>) => fn({ get: async () => snapshot(), create,
      getAll: async () => [{ exists: false }, { exists: false }, { exists: false }] }) } as unknown as Firestore;
  return { firestore, create, value: () => value };
}

function s3(bucket = "njpbs-cms-previews") {
  type Stored = { bytes: Buffer; ContentLength: number; ContentType?: string; CacheControl?: string; Metadata?: Record<string, string> };
  const objects = new Map<string, Stored>();
  const send = vi.fn(async (command: GetCommand | PutCommand | DeleteCommand) => {
    if (command.input.Bucket !== bucket) throw new Error("Storage credential cannot access this bucket");
    const key = command.input.Key!;
    if (command instanceof PutObjectCommand) {
      if (command.input.IfNoneMatch === "*" && objects.has(key)) throw { $metadata: { httpStatusCode: 412 } };
      const bytes = Buffer.from(command.input.Body as Buffer);
      objects.set(key, { bytes, ContentLength: bytes.length, ContentType: command.input.ContentType,
        CacheControl: command.input.CacheControl, Metadata: command.input.Metadata });
      return {};
    }
    if (command instanceof DeleteObjectCommand) { objects.delete(key); return {}; }
    const stored = objects.get(key);
    if (!stored) throw { $metadata: { httpStatusCode: 404 } };
    return { ...stored, Body: { transformToWebStream: () => Readable.toWeb(Readable.from([stored.bytes])) } };
  });
  const client = { send } as unknown as S3Client;
  return { objects, send, client, storage: createCmsPreviewCloudStorage({ client }) };
}

it("freezes S3 inputs conditionally and reuses the original complete bytes on conflict", async () => {
  const { storage, send } = s3();
  expect(await storage.read(queueId)).toBeNull();
  expect(await storage.freeze(queueId, Buffer.from("first"))).toEqual(Buffer.from("first"));
  expect(await storage.freeze(queueId, Buffer.from("different"))).toEqual(Buffer.from("first"));
  const puts = send.mock.calls.map(([command]) => command).filter(command => command instanceof PutObjectCommand);
  expect(puts.every(command => command.input.IfNoneMatch === "*")).toBe(true);
});

it.each(["digest", "queue", "schema", "content-type", "cache-control", "length"])("rejects frozen input %s mismatch", async mismatch => {
  const { storage, objects } = s3();
  await storage.freeze(queueId, Buffer.from("first"));
  const object = objects.get(`inputs/${queueId}/input.json`)!;
  if (mismatch === "digest") object.bytes = Buffer.from("other");
  if (mismatch === "queue") object.Metadata!.queueid = "22222222222222222222";
  if (mismatch === "schema") object.Metadata!.schema = "other";
  if (mismatch === "content-type") object.ContentType = "text/plain";
  if (mismatch === "cache-control") object.CacheControl = "public";
  if (mismatch === "length") object.ContentLength++;
  await expect(storage.read(queueId)).rejects.toThrow(/differs/);
});

it("removes only the exact input key and refuses traversal identities", async () => {
  const { storage, send, objects } = s3();
  await storage.freeze(queueId, Buffer.from("first"));
  await storage.remove(queueId);
  expect(objects.size).toBe(0);
  expect(send.mock.calls.at(-1)![0].input).toEqual({ Bucket: "njpbs-cms-previews", Key: `inputs/${queueId}/input.json` });
  await expect(storage.remove("../saved/current")).rejects.toThrow(/identity/);
  expect(send.mock.calls.filter(([command]) => command instanceof DeleteObjectCommand)).toHaveLength(1);
});

it("reads the full context digest and checks publication both before and after", async () => {
  const f = contextFixture(); const db = database(f.manifest); const { storage, objects } = s3();
  objects.set(f.manifest.key, { bytes: f.bytes, ContentLength: f.bytes.length });
  const request = vi.fn(async () => JSON.stringify(f.publication));
  expect(await storage.readPublicContext(db.firestore, request)).toEqual({ publicContext: f.context, publication: f.publication });
  expect(request.mock.calls).toEqual([["https://njpbs.org/_publication.json?cms-context=code"], ["https://njpbs.org/_publication.json?cms-context=code"]]);
  request.mockResolvedValueOnce(JSON.stringify(f.publication)).mockResolvedValueOnce(JSON.stringify({ ...f.publication, generation: 2 }));
  await expect(storage.readPublicContext(db.firestore, request)).rejects.toThrow(/changed while reading/);
  const corrupted = Buffer.from(f.bytes); corrupted[0] = 32;
  objects.set(f.manifest.key, { bytes: corrupted, ContentLength: corrupted.length });
  await expect(storage.readPublicContext(db.firestore, request)).rejects.toThrow(/bytes differ/);
});

it("keeps code-release context separate from a pending editorial operation", async () => {
  const f = contextFixture(); const db = database(f.manifest); const cloud = s3();
  cloud.objects.set(f.manifest.key, { bytes: f.bytes, ContentLength: f.bytes.length });
  const transaction = vi.spyOn(db.firestore, "runTransaction").mockRejectedValue(new Error("editorial operation pending"));
  const storage = createCmsPreviewCloudStorage({ client: cloud.client, contextMode: "code" });
  expect(await storage.readPublicContext(db.firestore, async () => JSON.stringify(f.publication)))
    .toEqual({ publicContext: f.context, publication: f.publication });
  expect(transaction).not.toHaveBeenCalled();
});

it.each(["manifest", "publication"])("rejects a context with mismatched %s", async mismatch => {
  const f = contextFixture(); const { storage, objects } = s3();
  objects.set(f.manifest.key, { bytes: f.bytes, ContentLength: f.bytes.length });
  const db = database(mismatch === "manifest" ? { ...f.manifest, artifactReceiptDigest: "f".repeat(64) } : f.manifest);
  const request = async () => JSON.stringify(mismatch === "publication" ? { ...f.publication, generation: 2 } : f.publication);
  await expect(storage.readPublicContext(db.firestore, request)).rejects.toThrow(/match/);
});

async function publisherFixture(initial?: unknown) {
  const f = contextFixture(); const db = database(initial);
  const dir = await mkdtemp(path.join(tmpdir(), "njpbs-cloud-context-")); directories.push(dir);
  const file = path.join(dir, "public-context.json"); await writeFile(file, f.bytes, { mode: 0o600 });
  const cloud = s3();
  const run = (allowCloudRecovery = false) => retainCloudPreviewPublicContext({ firestore: db.firestore, file,
    publication: f.publication, allowCloudRecovery, client: cloud.client });
  const store = (key: string, bytes: Buffer) => cloud.objects.set(key, { bytes, ContentLength: bytes.length });
  const methods = () => cloud.send.mock.calls.map(([command]) => command instanceof PutObjectCommand ? "PUT" : "GET");
  return { ...f, db, ...cloud, run, file, store, methods };
}

it("publishes content-addressed bytes with an immutable manifest and reuses an exact retry", async () => {
  const f = await publisherFixture(); await f.run(); await f.run();
  expect(f.db.value()).toEqual(f.manifest); expect(f.db.create).toHaveBeenCalledTimes(1);
  expect([...f.objects.keys()]).toEqual([f.manifest.key]); expect(f.objects.get(f.manifest.key)?.bytes).toEqual(f.bytes);
  expect(f.methods()).toEqual(["GET", "PUT", "GET", "GET"]);
});

it("rejects a different immutable manifest before contacting object storage", async () => {
  const expected = contextFixture().manifest;
  const f = await publisherFixture({ ...expected, byteLength: expected.byteLength + 1 });
  await expect(f.run()).rejects.toThrow(/cannot change/); expect(f.send).not.toHaveBeenCalled();
});

it("rejects existing content that conflicts with its digest without overwriting it", async () => {
  const f = await publisherFixture(); f.store(f.manifest.key, Buffer.from("corrupt"));
  await expect(f.run()).rejects.toThrow(/conflicts/);
  expect(f.send.mock.calls.every(([command]) => !(command instanceof PutObjectCommand))).toBe(true);
  expect(f.objects.get(f.manifest.key)?.bytes).toEqual(Buffer.from("corrupt"));
});

it("requires upload readback to match the exact source bytes", async () => {
  const f = await publisherFixture();
  f.send.mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 } })
    .mockResolvedValueOnce({})
    .mockResolvedValueOnce({ ContentLength: 9,
      Body: { transformToWebStream: () => Readable.toWeb(Readable.from([Buffer.from("truncated")])) } });
  await expect(f.run()).rejects.toThrow(/not verified/);
});


it("recovers verified retained bytes after the local publication context is lost", async () => {
  const f = await publisherFixture(); await f.run();
  await rm(f.file); f.send.mockClear();
  await expect(f.run(true)).resolves.toBeUndefined();
  expect(f.methods()).toEqual(["GET"]);
  expect(f.objects.get(f.manifest.key)?.bytes).toEqual(f.bytes);
  await expect(f.run()).rejects.toMatchObject({ code: "ENOENT" });
});

it("requires and uploads local context when recovery has no cloud manifest", async () => {
  const f = await publisherFixture();
  await f.run(true);
  expect(f.db.value()).toEqual(f.manifest);
  expect(f.objects.get(f.manifest.key)?.bytes).toEqual(f.bytes);
  expect(f.methods()).toEqual(["GET", "PUT", "GET"]);
  const missing = await publisherFixture(); await rm(missing.file);
  await expect(missing.run(true)).rejects.toMatchObject({ code: "ENOENT" });
  expect(missing.send).not.toHaveBeenCalled();
});

it("fails recovery when only a manifest survives and both cloud bytes and local input are missing", async () => {
  const f = await publisherFixture(contextFixture().manifest); await rm(f.file);
  await expect(f.run(true)).rejects.toMatchObject({ code: "ENOENT" });
  expect(f.methods()).toEqual(["GET"]);
});

it("refuses corrupted retained recovery bytes without an overwrite or local fallback", async () => {
  const f = await publisherFixture(); await f.run(); f.send.mockClear();
  const bad = Buffer.from(f.bytes); bad[0] = 32; f.store(f.manifest.key, bad);
  await expect(f.run(true)).rejects.toThrow("bytes differ");
  expect(f.methods()).toEqual(["GET"]);
  expect(f.objects.get(f.manifest.key)?.bytes).toEqual(bad);
});

it("refuses malformed recovery manifests before reading or overwriting cloud bytes", async () => {
  const f = await publisherFixture({ ...contextFixture().manifest, schemaVersion: 2 });
  await expect(f.run(true)).rejects.toThrow(/manifest/);
  expect(f.send).not.toHaveBeenCalled();
});

it("refuses hash-valid cloud context whose receipt belongs to another publication", async () => {
  const f = contextFixture();
  const context = contextFixture("b".repeat(40)).context;
  const bytes = Buffer.from(`${JSON.stringify(context)}\n`);
  const manifest = { ...f.manifest, sha256: sha(bytes), byteLength: bytes.length,
    key: `public-context/${f.publication.buildBatchId}/${sha(bytes)}.json` };
  const test = await publisherFixture(manifest); test.store(manifest.key, bytes);
  await expect(test.run(true)).rejects.toThrow(/does not match/);
  expect(test.methods()).toEqual(["GET"]);
});


it.each([true, false])("verifies the winner's bytes after conditional publication upload conflict (exact=%s)", async exact => {
  const f = await publisherFixture();
  f.send.mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 } })
    .mockImplementationOnce(async command => {
      expect(command).toBeInstanceOf(PutObjectCommand);
      expect((command as PutCommand).input.IfNoneMatch).toBe("*");
      f.store(f.manifest.key, exact ? f.bytes : Buffer.from("conflicting winner"));
      throw { $metadata: { httpStatusCode: 412 } };
    });
  if (exact) await expect(f.run()).resolves.toBeUndefined();
  else await expect(f.run()).rejects.toThrow("upload was not verified");
  expect(f.methods()).toEqual(["GET", "PUT", "GET"]);
  expect(f.objects.get(f.manifest.key)?.bytes).toEqual(exact ? f.bytes : Buffer.from("conflicting winner"));
});


it("constructs its owned storage client from the same Functions SDK as uploads", async () => {
  const wrongCopy = SiteS3Client !== FunctionsS3Client
    ? vi.spyOn(SiteS3Client.prototype, "send").mockImplementation(() => { throw new Error("Unexpected Site SDK client"); })
    : undefined;
  const send = vi.spyOn(FunctionsS3Client.prototype, "send").mockResolvedValue({} as never);
  const storage = createCmsPreviewCloudStorage({ accessKeyId: "fixture-key", secretAccessKey: "fixture-secret" });
  try {
    await expect(storage.freeze(queueId, Buffer.from("frozen input"))).resolves.toEqual(Buffer.from("frozen input"));
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toBeInstanceOf(PutObjectCommand);
    expect(wrongCopy?.mock.calls ?? []).toHaveLength(0);
  } finally {
    storage.close();
    send.mockRestore();
    wrongCopy?.mockRestore();
  }
});


it("keeps the production context bucket and requires an explicit isolated dev bucket", () => {
  expect(resolvePreviewContextBucket(undefined, "production")).toBe("njpbs-cms-previews");
  expect(resolvePreviewContextBucket("template-dev-cms-previews", "development")).toBe("template-dev-cms-previews");
  for (const bucket of [undefined, "njpbs-cms-previews", "template-dev-media"]) {
    expect(() => resolvePreviewContextBucket(bucket, "development")).toThrow();
  }
  expect(() => resolvePreviewContextBucket("template-dev-cms-previews", "production")).toThrow();
});


it("sends every dev context storage operation to the dev bucket", async () => {
  const f = await publisherFixture();
  const cloud = s3("template-dev-cms-previews");
  await retainCloudPreviewPublicContext({ firestore: f.db.firestore, file: f.file,
    publication: f.publication, client: cloud.client, bucket: "template-dev-cms-previews", deploymentEnvironment: "development" });
  expect(cloud.objects.get(f.manifest.key)?.bytes).toEqual(f.bytes);
  expect(cloud.send.mock.calls.length).toBeGreaterThan(0);
  expect(cloud.send.mock.calls.every(([command]) => command.input.Bucket === "template-dev-cms-previews")).toBe(true);
});


it("reads retained dev context and freezes, rereads and removes dev inputs with a dev-only credential", async () => {
  const f = await publisherFixture();
  const cloud = s3("template-dev-cms-previews");
  const target = { bucket: "template-dev-cms-previews", deploymentEnvironment: "development" };
  await retainCloudPreviewPublicContext({ ...target, firestore: f.db.firestore, file: f.file,
    publication: f.publication, client: cloud.client });
  const storage = createCmsPreviewCloudStorage({ ...target, client: cloud.client });
  const request = async () => JSON.stringify(f.publication);
  expect(await storage.readPublicContext(f.db.firestore, request)).toEqual({ publicContext: f.context, publication: f.publication });
  expect(await storage.read(queueId)).toBeNull();
  expect(await storage.freeze(queueId, Buffer.from("dev input"))).toEqual(Buffer.from("dev input"));
  expect(await storage.freeze(queueId, Buffer.from("other input"))).toEqual(Buffer.from("dev input"));
  expect(await storage.read(queueId)).toEqual(Buffer.from("dev input"));
  await storage.remove(queueId);
  expect(await storage.read(queueId)).toBeNull();
  expect(cloud.objects.get(f.manifest.key)?.bytes).toEqual(f.bytes);
});

it.each([undefined, "njpbs-cms-previews", "template-dev-media"])("rejects invalid dev factory bucket %s before storage access", bucket => {
  const cloud = s3();
  expect(() => createCmsPreviewCloudStorage({ client: cloud.client, bucket, deploymentEnvironment: "development" })).toThrow();
  expect(cloud.send).not.toHaveBeenCalled();
});

it("rejects a dev bucket for a production storage factory", () => {
  const cloud = s3();
  expect(() => createCmsPreviewCloudStorage({ client: cloud.client,
    bucket: "template-dev-cms-previews", deploymentEnvironment: "production" })).toThrow();
  expect(cloud.send).not.toHaveBeenCalled();
});


it("authenticates both dev receipt reads on the dev origin without a production header requirement", async () => {
  const f = await publisherFixture();
  const cloud = s3("template-dev-cms-previews");
  const target = { bucket: "template-dev-cms-previews", deploymentEnvironment: "development" };
  await retainCloudPreviewPublicContext({ ...target, firestore: f.db.firestore, file: f.file,
    publication: f.publication, client: cloud.client });
  const request = vi.fn(async () => new Response(JSON.stringify(f.publication), { headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", request);
  const storage = createCmsPreviewCloudStorage({ ...target, client: cloud.client,
    publicationAccess: { clientId: "fixture-id", clientSecret: "fixture-secret" } });
  expect(await storage.readPublicContext(f.db.firestore)).toEqual({ publicContext: f.context, publication: f.publication });
  expect(request).toHaveBeenCalledTimes(2);
  for (const [url, options] of request.mock.calls as unknown as [string, RequestInit][]) {
    expect(url).toBe("https://dev-public.example.org/_publication.json?cms-context=code");
    expect(options.redirect).toBe("error");
    expect(options.headers).toMatchObject({ "CF-Access-Client-Id": "fixture-id", "CF-Access-Client-Secret": "fixture-secret" });
  }
  request.mockResolvedValueOnce(new Response("sign in", { status: 403 }));
  await expect(storage.readPublicContext(f.db.firestore)).rejects.toThrow(/response is invalid/);
});

it("refuses a dev receipt read without Access credentials before network access", async () => {
  const request = vi.fn(); vi.stubGlobal("fetch", request);
  const cloud = s3("template-dev-cms-previews");
  const storage = createCmsPreviewCloudStorage({ client: cloud.client, bucket: "template-dev-cms-previews", deploymentEnvironment: "development" });
  await expect(storage.readPublicContext(database().firestore)).rejects.toThrow(/Access credentials are required/);
  expect(request).not.toHaveBeenCalled();
});

it.each(["publication-probe", "context-manifest", "context-object", "context-assert"])
  ("identifies a failed %s boundary without changing its refusal", async failedPhase => {
    const f = contextFixture();
    const cloud = s3("template-dev-cms-previews");
    cloud.objects.set(f.manifest.key, { bytes: f.bytes, ContentLength: f.bytes.length });
    const db = database(failedPhase === "context-manifest" ? { ...f.manifest, artifactReceiptDigest: "f".repeat(64) } : f.manifest);
    if (failedPhase === "context-object") {
      cloud.send.mockRejectedValueOnce(Object.assign(new Error("fixture-private-provider-body"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } }));
    }
    if (failedPhase === "context-assert") {
      const corrupt = Buffer.from(f.bytes); corrupt[0] = 32;
      cloud.objects.set(f.manifest.key, { bytes: corrupt, ContentLength: corrupt.length });
    }
    vi.stubGlobal("fetch", async () => failedPhase === "publication-probe"
      ? new Response("fixture-private-response-body", { status: 403 })
      : Response.json(f.publication));
    const storage = createCmsPreviewCloudStorage({ client: cloud.client, bucket: "template-dev-cms-previews",
      deploymentEnvironment: "development", publicationAccess: { clientId: "fixture-id", clientSecret: "fixture-secret" } });
    let phase;
    let failure;
    try { await storage.readPublicContext(db.firestore, undefined, value => { phase = value; }); }
    catch (error) { failure = error; }
    expect(phase).toBe(failedPhase);
    expect(failure).toBeInstanceOf(Error);
    if (failedPhase === "publication-probe") expect(failure).toMatchObject({ httpStatus: 403 });
    if (failedPhase === "context-object") expect(failure).toMatchObject({ name: "AccessDenied", $metadata: { httpStatusCode: 403 } });
  });

it("retains the publication-probe phase and safe error class for a refused redirect", async () => {
  const request = vi.fn().mockRejectedValue(new TypeError("fixture-private-access-location"));
  vi.stubGlobal("fetch", request);
  const cloud = s3("template-dev-cms-previews");
  const storage = createCmsPreviewCloudStorage({ client: cloud.client, bucket: "template-dev-cms-previews",
    deploymentEnvironment: "development", publicationAccess: { clientId: "fixture-id", clientSecret: "fixture-secret" } });
  let phase;
  await expect(storage.readPublicContext(database().firestore, undefined, value => { phase = value; }))
    .rejects.toMatchObject({ message: "Dev publication receipt request failed", errorClass: "TypeError" });
  expect(phase).toBe("publication-probe");
});

it("reports a missing retained context object at the object boundary with HTTP 404", async () => {
  const f = contextFixture();
  const cloud = s3("template-dev-cms-previews");
  const storage = createCmsPreviewCloudStorage({ client: cloud.client, bucket: "template-dev-cms-previews", deploymentEnvironment: "development" });
  let phase;
  await expect(storage.readPublicContext(database(f.manifest).firestore, async () => JSON.stringify(f.publication), value => { phase = value; }))
    .rejects.toMatchObject({ message: "Retained cloud public context bytes differ", httpStatus: 404 });
  expect(phase).toBe("context-object");
});

it.each(["TimeoutError", "AbortError"])("retains the safe %s class for a failed publication probe", async name => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("fixture-private-network-details", name)));
  const cloud = s3("template-dev-cms-previews");
  const storage = createCmsPreviewCloudStorage({ client: cloud.client, bucket: "template-dev-cms-previews",
    deploymentEnvironment: "development", publicationAccess: { clientId: "fixture-id", clientSecret: "fixture-secret" } });
  await expect(storage.readPublicContext(database().firestore)).rejects.toMatchObject({
    message: "Dev publication receipt request failed", errorClass: name,
  });
});

it("keeps the bounded refresh wait for versioned context races without probing the legacy publication", async () => {
  const { EditorialPreviewContextNotReadyError } = await import("../scripts/cms-preview-editorial-context");
  const f = contextFixture(), pairContextReader = vi.fn().mockRejectedValueOnce(new EditorialPreviewContextNotReadyError())
    .mockResolvedValue({ publicContext: f.context, publication: f.publication });
  const network = vi.fn(); vi.stubGlobal("fetch", network); vi.useFakeTimers();
  try {
    const code = vi.fn();
    const storage = createCmsPreviewCloudStorage({ client: s3().client, pairContextReader: code, pairEditorialContextReader: pairContextReader });
    const refreshing = vi.fn(async () => {}), result = storage.readEditorialPublicContext(database().firestore, refreshing);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await result).toEqual({ publicContext: f.context, publication: f.publication });
    expect(refreshing).toHaveBeenCalledOnce(); expect(pairContextReader).toHaveBeenCalledTimes(2); expect(network).not.toHaveBeenCalled();
    expect(code).not.toHaveBeenCalled();
    storage.close();
  } finally { vi.useRealTimers(); }
});
it("never freezes CODE-only inputs when a versioned editorial reader is unbound", async () => {
  const pairContextReader = vi.fn(), storage = createCmsPreviewCloudStorage({ client: s3().client, pairContextReader });
  await expect(storage.readPublicContext(database().firestore, vi.fn(), () => {}, "editorial")).rejects.toMatchObject({ code: "preview_context_refreshing" });
  expect(pairContextReader).not.toHaveBeenCalled(); storage.close();
});
