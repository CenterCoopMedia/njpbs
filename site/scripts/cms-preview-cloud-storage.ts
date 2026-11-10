import { cloudflareR2Endpoint } from "./cloudflare-account.mjs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import type { Firestore } from "firebase-admin/firestore";
import type { S3Client as S3ClientInstance } from "@aws-sdk/client-s3";
import { canonicalPublicationReceipt, type PublicPublicationReceipt } from "../src/lib/public-publication-receipt.ts";
import { assertContextMatchesPublication, readPrivateContextBytes, readRetainedPublicContext } from "../src/lib/retained-public-context.ts";
import { EDITORIAL_CONTEXTS_COLLECTION, EDITORIAL_SEALS_COLLECTION, LAST_SEALED_EDITORIAL_CONTEXT, editorialPreviewContextId, readEditorialPreviewSelection, readSealedEditorialPreviewSelection,
  assertEditorialPreparedContext, editorialContextManifest, legacyEditorialContextManifest, assertEditorialContextManifest, assertEditorialContextBytes,
  EditorialPreviewContextNotReadyError, type EditorialPreviewManifest } from "./cms-preview-editorial-context";
export { editorialPreviewContextId } from "./cms-preview-editorial-context";
import { PUBLICATION_PROBE_ORIGIN, PUBLICATION_PROBE_PATH, requestPublicPublicationReceipt } from "./activate-public-worker-candidate.ts";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
// Share the installed SDK used by uploads and the R2 helper; do not load a second copy.
const { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3") as typeof import("@aws-sdk/client-s3");
const { isConditionalConflict, normalizeMetadata, r2ClientConfig } = require("./lib/r2-media.js");
const { HOME_CATALOGS_COLLECTION, assertHomeCatalogReceipt } = require("./lib/home-source-selection-admission.js");
const { cloudCmsPublicationRuntimeControl } = require("./lib/cms-publication-runtime-control.js");
const BUCKET = "njpbs-cms-previews";
const CONTEXTS_COLLECTION = "cmsPreviewPublicContexts";
const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const QUEUE_ID = /^[A-Za-z0-9]{20}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const CACHE_CONTROL = "private, no-store, max-age=0";
const CONTENT_TYPE = "application/octet-stream";
type ContextReadPhase = "publication-probe" | "context-manifest" | "context-object" | "context-assert";

interface ContextManifest {
  schemaVersion: 1;
  buildBatchId: string;
  artifactReceiptDigest: string;
  sha256: string;
  byteLength: number;
  key: string;
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function inputKey(queueId: string): string {
  if (!QUEUE_ID.test(queueId)) throw new Error("Invalid cloud preview queue identity");
  return `inputs/${queueId}/input.json`;
}

function contextKey(buildBatchId: string, sha256: string): string {
  if (!/^cms-[A-Za-z0-9]{20}$/.test(buildBatchId) || !DIGEST.test(sha256)) {
    throw new Error("Invalid cloud preview public context identity");
  }
  return `public-context/${buildBatchId}/${sha256}.json`;
}

function assertManifest(value: unknown, publication: PublicPublicationReceipt): ContextManifest {
  const fields = ["schemaVersion", "buildBatchId", "artifactReceiptDigest", "sha256", "byteLength", "key"];
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Cloud preview context manifest is invalid");
  const manifest = value as Record<string, unknown>;
  if (Object.keys(manifest).length !== fields.length || !fields.every(field => Object.hasOwn(manifest, field)) ||
    manifest.schemaVersion !== 1 || manifest.buildBatchId !== publication.buildBatchId ||
    manifest.artifactReceiptDigest !== publication.artifactReceiptDigest ||
    typeof manifest.sha256 !== "string" || !DIGEST.test(manifest.sha256) ||
    !Number.isSafeInteger(manifest.byteLength) || Number(manifest.byteLength) < 1 || Number(manifest.byteLength) > MAX_INPUT_BYTES ||
    manifest.key !== contextKey(publication.buildBatchId, manifest.sha256)) {
    throw new Error("Cloud preview context manifest does not match the publication");
  }
  return { schemaVersion: 1, buildBatchId: publication.buildBatchId,
    artifactReceiptDigest: publication.artifactReceiptDigest, sha256: manifest.sha256,
    byteLength: Number(manifest.byteLength), key: String(manifest.key) };
}

function assertCloudContextBytes(bytes: Buffer | null, manifest: ContextManifest, publication: PublicPublicationReceipt) {
  if (!bytes || bytes.length !== manifest.byteLength || digest(bytes) !== manifest.sha256) {
    throw new Error("Retained cloud public context bytes differ");
  }
  return assertContextMatchesPublication(JSON.parse(bytes.toString("utf8")), publication);
}

async function boundedBytes(body: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) throw new Error("Cloud preview input exceeds its size limit");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}

const requestOptions = () => ({ abortSignal: AbortSignal.timeout(30_000) });

function previewStorageClient(accessKeyId?: string, secretAccessKey?: string) {
  if (!accessKeyId || !secretAccessKey) throw new Error("Cloud preview storage credentials are required");
  return new S3Client({ ...r2ClientConfig({
    endpoint: cloudflareR2Endpoint(), accessKeyId, secretAccessKey,
  }), maxAttempts: 3 });
}

async function readStorageObject(storage: S3ClientInstance, key: string, bucket: string) {
  let object;
  try { object = await storage.send(new GetObjectCommand({ Bucket: bucket, Key: key }), requestOptions()); }
  catch (error) {
    if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
    throw error;
  }
  if (!object.Body || typeof object.ContentLength !== "number" || !Number.isSafeInteger(object.ContentLength) ||
    object.ContentLength < 1 || object.ContentLength > MAX_INPUT_BYTES) {
    await object.Body?.transformToWebStream().cancel();
    throw new Error("Cloud preview object is invalid");
  }
  const bytes = await boundedBytes(object.Body.transformToWebStream());
  if (bytes.length !== object.ContentLength) throw new Error("Cloud preview object length differs");
  return { bytes, object };
}

/** Exact input bytes survive container replacement. This prefix is never served
 * by the preview Worker; only the operator receives it through private R2.
 */
export function createCmsPreviewCloudStorage({ accessKeyId, secretAccessKey, client, contextMode = "code",
  bucket: configuredBucket, deploymentEnvironment = process.env.CMS_DEPLOYMENT_ENVIRONMENT, publicationAccess, contextSignal,
  pairContextReader, pairEditorialContextReader }: {
  pairContextReader?: ReturnType<typeof import("./cms-preview-pair-context.ts").createPreviewPairContextReader>;
  pairEditorialContextReader?: ReturnType<typeof import("./cms-preview-pair-editorial-context.ts").createPreviewPairEditorialContextReader>;
  bucket?: string;
  contextMode?: "editorial" | "code";
  deploymentEnvironment?: string;
  publicationAccess?: { clientId: string; clientSecret: string };
  contextSignal?: AbortSignal;
  accessKeyId?: string;
  secretAccessKey?: string;
  client?: S3ClientInstance;
}) {
  const bucket = resolvePreviewContextBucket(configuredBucket, deploymentEnvironment);
  const storage = client ?? previewStorageClient(accessKeyId, secretAccessKey);
  const isDev = deploymentEnvironment === "development";
  const publicationOrigin = isDev ? "https://dev-public.example.org" : PUBLICATION_PROBE_ORIGIN;
  const requestReceipt = isDev
    ? (url: string) => requestDevPublicationReceipt(url, publicationAccess)
    : requestPublicPublicationReceipt;
  let contextRefreshDeadline: number | undefined;

  const read = async (queueId: string): Promise<Buffer | null> => {
    const stored = await readStorageObject(storage, inputKey(queueId), bucket);
    if (!stored) return null;
    const metadata = normalizeMetadata(stored.object.Metadata);
    if (metadata.schema !== "njpbs-preview-input-v1" || metadata.queueid !== queueId ||
      metadata.sha256 !== digest(stored.bytes) || stored.object.ContentType !== CONTENT_TYPE ||
      stored.object.CacheControl !== CACHE_CONTROL) throw new Error("Cloud preview input identity differs");
    return stored.bytes;
  };

  // Losing a read fence restarts the bounded readiness owner. It must not
  // trigger another selection within the same attempt.
  class ContextReadChangedError extends EditorialPreviewContextNotReadyError {}
  const readCurrentPublicContext = async (firestore: Firestore,
    requestPublication = requestReceipt, onPhase: (phase: ContextReadPhase) => void = () => undefined, mode = contextMode) => {
    const url = new URL(`${PUBLICATION_PROBE_PATH}?cms-context=code`, publicationOrigin).toString();
    onPhase("publication-probe");
    const publication = canonicalPublicationReceipt(JSON.parse(await requestPublication(url)));
    onPhase("context-manifest");
    const select = () => mode === "code" ? null : firestore.runTransaction(
      transaction => readEditorialPreviewSelection(transaction, firestore, publication), { readOnly: true });
    const selection = await select();
    const manifestRef = firestore.collection(selection ? EDITORIAL_CONTEXTS_COLLECTION : CONTEXTS_COLLECTION)
      .doc(selection ? editorialPreviewContextId(publication, selection.contextDigest, selection.operationId) : publication.buildBatchId);
    let snapshot = await manifestRef.get();
    if (selection && !snapshot.exists) {
      // Retention commits its marker and manifest together. Read both at one
      // snapshot so completion during this read cannot look like lost data.
      const [confirmed, queue] = await firestore.runTransaction(transaction => transaction.getAll(
        manifestRef, firestore.doc(`cmsPublishQueue/${selection.operationId}`)), { readOnly: true });
      snapshot = confirmed;
      if (!snapshot.exists) {
        const retention = queue.data()?.previewContext;
        if (retention?.contextDigest === selection.contextDigest && retention.publicationGeneration === publication.generation &&
            (retention.status === "verified" || retention.status === "failed" && retention.nextAttemptAt === null)) {
          throw new Error("Editorial preview context is unavailable");
        }
        throw new EditorialPreviewContextNotReadyError();
      }
    }
    const manifest = selection ? assertEditorialContextManifest(snapshot.data(), selection) : assertManifest(snapshot.data(), publication);
    onPhase("context-object");
    const stored = await readStorageObject(storage, manifest.key, bucket);
    if (!stored) throw Object.assign(new Error("Retained cloud public context bytes differ"), { httpStatus: 404 });
    onPhase("context-assert");
    const publicContext = selection ? assertEditorialContextBytes(stored.bytes, assertEditorialContextManifest(manifest, selection))
      : assertCloudContextBytes(stored.bytes, assertManifest(manifest, publication), publication);
    onPhase("publication-probe");
    const after = canonicalPublicationReceipt(JSON.parse(await requestPublication(url)));
    onPhase("context-assert");
    if (!isDeepStrictEqual(publication, after)) {
      if (mode === "editorial") throw new ContextReadChangedError("The public publication changed while reading cloud preview context");
      throw new Error("The public publication changed while reading cloud preview context");
    }
    let selectedAfter;
    try { selectedAfter = await select(); }
    catch (error) {
      if (error instanceof EditorialPreviewContextNotReadyError) throw new ContextReadChangedError(error.message);
      throw error;
    }
    if (!isDeepStrictEqual(selection, selectedAfter)) {
      throw new ContextReadChangedError("The editorial context changed while reading cloud preview context");
    }
    return { publicContext, publication };
  };
  const readLegacyPublicContext = async (firestore: Firestore,
    requestPublication = requestReceipt, onPhase: (phase: ContextReadPhase) => void = () => undefined, mode = contextMode) => {
    try { return await readCurrentPublicContext(firestore, requestPublication, onPhase, mode); }
    catch (error) {
      if (mode !== "editorial" || !(error instanceof EditorialPreviewContextNotReadyError) || error instanceof ContextReadChangedError) throw error;
      const url = new URL(`${PUBLICATION_PROBE_PATH}?cms-context=code`, publicationOrigin).toString();
      onPhase("publication-probe");
      const publication = canonicalPublicationReceipt(JSON.parse(await requestPublication(url)));
      const select = (manifestId?: string) => firestore.runTransaction(transaction =>
        readSealedEditorialPreviewSelection(transaction, firestore, publication, manifestId), { readOnly: true });
      onPhase("context-manifest");
      const manifest = await select();
      if (!manifest) throw error;
      const manifestId = editorialPreviewContextId(publication, manifest.selection.contextDigest, manifest.selection.operationId);
      onPhase("context-object");
      const stored = await readStorageObject(storage, manifest.key, bucket);
      const publicContext = assertEditorialContextBytes(stored?.bytes ?? null, manifest);
      onPhase("publication-probe");
      const after = canonicalPublicationReceipt(JSON.parse(await requestPublication(url)));
      onPhase("context-assert");
      if (!isDeepStrictEqual(publication, after) || !isDeepStrictEqual(manifest, await select(manifestId))) throw error;
      return { publicContext, publication, verifyBeforeFreeze: async () => {
        const current = canonicalPublicationReceipt(JSON.parse(await requestPublication(url)));
        if (!isDeepStrictEqual(publication, current) || !isDeepStrictEqual(manifest, await select(manifestId))) throw error;
      } };
    }
  };
  const readPublicContext = async (firestore: Firestore,
    requestPublication = requestReceipt, onPhase: (phase: ContextReadPhase) => void = () => undefined, mode = contextMode) => {
    if (!pairContextReader) return readLegacyPublicContext(firestore, requestPublication, onPhase, mode);
    contextSignal?.throwIfAborted();
    if (mode !== "editorial") return pairContextReader();
    if (!pairEditorialContextReader) throw new EditorialPreviewContextNotReadyError();
    return pairEditorialContextReader(publication => readLegacyPublicContext(firestore, async () => JSON.stringify(publication), onPhase, "editorial"));
  };

  return {
    readPublicContext,
    readEditorialPublicContext: async (firestore: Firestore, onRefreshing: () => Promise<void> = async () => {}) => {
      let notified = false;
      for (;;) {
        contextSignal?.throwIfAborted();
        try {
          const result = await readPublicContext(firestore, requestReceipt, () => undefined, "editorial");
          contextRefreshDeadline = undefined;
          return result;
        }
        catch (error) {
          if (!(error instanceof EditorialPreviewContextNotReadyError)) throw error;
          // Share one wait across the serial queue, then probe without waiting
          // for a minute before allowing another refresh window.
          const now = Date.now();
          if (contextRefreshDeadline === undefined || now >= contextRefreshDeadline + 60_000) {
            contextRefreshDeadline = now + 240_000;
          }
          const deadline = contextRefreshDeadline;
          if (now >= deadline) throw error;
          if (!notified) { await onRefreshing(); notified = true; }
          // Restart both receipt probes and both selection fences. Never reuse
          // bytes or a selection from an attempt that lost a publication race.
          await new Promise(resolve => setTimeout(resolve, Math.min(5_000, deadline - Date.now())));
        }
      }
    },
    read,
    freeze: async (queueId: string, payload: Buffer): Promise<Buffer> => {
      if (!Buffer.isBuffer(payload) || payload.length < 1 || payload.length > MAX_INPUT_BYTES) {
        throw new Error("Cloud preview input exceeds its size limit");
      }
      try {
        await storage.send(new PutObjectCommand({ Bucket: bucket, Key: inputKey(queueId), Body: payload,
          ContentLength: payload.length, ContentType: CONTENT_TYPE, CacheControl: CACHE_CONTROL,
          Metadata: { schema: "njpbs-preview-input-v1", queueid: queueId, sha256: digest(payload) }, IfNoneMatch: "*" }), requestOptions());
        return payload;
      } catch (error) {
        if (!isConditionalConflict(error)) throw error;
        // A competing exact claim may have frozen an earlier public context.
        // Reuse that complete input; the processor revalidates its queue snapshot.
        const stored = await read(queueId);
        if (!stored) throw new Error("Frozen cloud preview input is unavailable");
        return stored;
      }
    },
    remove: async (queueId: string) => {
      await storage.send(new DeleteObjectCommand({ Bucket: bucket, Key: inputKey(queueId) }), requestOptions());
    },
    close: () => { if (!client) storage.destroy(); },
  };
}

async function requestDevPublicationReceipt(url: string, access?: { clientId: string; clientSecret: string }): Promise<string> {
  if (!access?.clientId || !access.clientSecret) throw new Error("Dev publication Access credentials are required");
  let response: Response;
  try {
    response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(10_000), headers: {
      Accept: "application/json", "Cache-Control": "no-cache",
      "CF-Access-Client-Id": access.clientId, "CF-Access-Client-Secret": access.clientSecret,
    } });
  } catch (error) {
    throw Object.assign(new Error("Dev publication receipt request failed"), {
      errorClass: error instanceof Error && ["TypeError", "TimeoutError", "AbortError"].includes(error.name) ? error.name : "Error",
    });
  }
  if (!response.ok || !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    await response.body?.cancel();
    throw Object.assign(new Error("Dev publication receipt response is invalid"), { httpStatus: response.status });
  }
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > 64 * 1024) throw new Error("Dev publication receipt response is too large");
  return body;
}

export function resolvePreviewContextBucket(bucket?: string, environment = process.env.CMS_DEPLOYMENT_ENVIRONMENT): string {
  if (environment === "development") {
    if (bucket !== "template-dev-cms-previews") throw new Error("Development context requires its own preview bucket");
    return bucket;
  }
  if (bucket !== undefined && bucket !== BUCKET) throw new Error("Invalid production preview bucket");
  return BUCKET;
}

interface ContextRetentionInput {
  bucket?: string;
  deploymentEnvironment?: string;
  firestore: Firestore;
  file: string;
  publication: PublicPublicationReceipt;
  allowCloudRecovery?: boolean;
}

async function retainStoredPublicContext(storage: S3ClientInstance, { firestore, file, publication,
  allowCloudRecovery = false, bucket: configuredBucket, deploymentEnvironment }: ContextRetentionInput): Promise<void> {
  const bucket = resolvePreviewContextBucket(configuredBucket, deploymentEnvironment);
  const receipt = canonicalPublicationReceipt(publication);
  const ref = firestore.collection(CONTEXTS_COLLECTION).doc(receipt.buildBatchId);
  const read = async (key: string) => (await readStorageObject(storage, key, bucket))?.bytes ?? null;
  if (allowCloudRecovery) {
    const stored = await ref.get();
    if (stored.exists) {
      const manifest = assertManifest(stored.data(), receipt);
      const bytes = await read(manifest.key);
      if (bytes) {
        const context = assertCloudContextBytes(bytes, manifest, receipt);
        await retainHomeCatalog(firestore, context.homeSources?.editorial);
        return;
      }
    }
  }
  const context = await readRetainedPublicContext(file, receipt);
  await retainHomeCatalog(firestore, context.homeSources?.editorial);
  const bytes = Buffer.from(`${JSON.stringify(context)}\n`);
  if (bytes.length > MAX_INPUT_BYTES) throw new Error("Cloud preview public context exceeds its size limit");
  const sha256 = digest(bytes);
  const manifest: ContextManifest = { schemaVersion: 1, buildBatchId: receipt.buildBatchId,
    artifactReceiptDigest: receipt.artifactReceiptDigest, sha256, byteLength: bytes.length,
    key: contextKey(receipt.buildBatchId, sha256) };
  await firestore.runTransaction(async transaction => {
    const stored = await transaction.get(ref);
    if (stored.exists) {
      if (!isDeepStrictEqual(assertManifest(stored.data(), receipt), manifest)) {
        throw new Error("Retained cloud public context cannot change");
      }
    } else transaction.create(ref, manifest);
  });

  const previous = await read(manifest.key);
  if (previous) {
    if (!previous.equals(bytes)) throw new Error("Cloud public context object conflicts with its digest");
    return;
  }
  try {
    await storage.send(new PutObjectCommand({ Bucket: bucket, Key: manifest.key, Body: bytes,
      ContentLength: bytes.length, ContentType: CONTENT_TYPE, CacheControl: CACHE_CONTROL,
      Metadata: { schema: "njpbs-preview-public-context-v1", sha256, buildbatchid: receipt.buildBatchId },
      IfNoneMatch: "*" }), requestOptions());
  } catch (error) {
    if (!isConditionalConflict(error)) throw error;
  }
  const stored = await read(manifest.key);
  if (!stored?.equals(bytes)) throw new Error("Cloud public context upload was not verified");
}

async function retainHomeCatalog(firestore: Firestore, value: unknown) {
  if (value === undefined) return;
  const source = assertHomeCatalogReceipt(value);
  const ref = firestore.collection(HOME_CATALOGS_COLLECTION).doc(source.receipt.buildBatchId);
  await firestore.runTransaction(async transaction => {
    const stored = await transaction.get(ref);
    if (stored.exists) {
      if (!isDeepStrictEqual(assertHomeCatalogReceipt(stored.data()), source)) throw new Error("Published Home catalog cannot change.");
    } else transaction.create(ref, source);
  });
}

/** The publisher receives the existing bucket-scoped S3 credential separately
 * from its Worker activation token. Neither credential enters the Astro build.
 * An immutable manifest and conditional object creation preserve exact context.
 */
export async function retainCloudPreviewPublicContext({ accessKeyId, secretAccessKey, client, ...input }:
  ContextRetentionInput & { accessKeyId?: string; secretAccessKey?: string; client?: S3ClientInstance }): Promise<void> {
  const storage = client ?? previewStorageClient(accessKeyId, secretAccessKey);
  try { await retainStoredPublicContext(storage, input); }
  finally { if (!client) storage.destroy(); }
}

/** Called by the cloud aggregate owner's durable retention retry. Publish the
 * manifest only after R2 readback, under the verified preparation and live-source fence. */
export async function retainCloudEditorialPreviewContext({ firestore, file, operationId, publication, claim, serializerId, clock = Date.now,
  accessKeyId, secretAccessKey, client, bucket: configuredBucket, deploymentEnvironment }: {
  firestore: Firestore; file: string; operationId: string; publication: PublicPublicationReceipt;
  claim: string; serializerId: string; clock?: () => number;
  accessKeyId?: string; secretAccessKey?: string; client?: S3ClientInstance;
  bucket?: string; deploymentEnvironment?: string;
}): Promise<void> {
  if (!/^[A-Za-z0-9]{20}$/.test(claim)) throw new Error("Invalid editorial retention claim");
  const bucket = resolvePreviewContextBucket(configuredBucket, deploymentEnvironment);
  const storage = client ?? previewStorageClient(accessKeyId, secretAccessKey);
  try {
    const { selection, withdrawalRevision } = await firestore.runTransaction(async transaction => {
      const selection = await readEditorialPreviewSelection(transaction, firestore, publication, operationId);
      const context = (await transaction.get(firestore.doc("system/publicDeployment/contexts/public"))).data();
      const withdrawalRevision = context?.withdrawalRevision ?? 0;
      if (!Number.isSafeInteger(withdrawalRevision) || withdrawalRevision < 0) throw new Error("Editorial withdrawal revision is unavailable");
      return { selection, withdrawalRevision };
    }, { readOnly: true });
    if (!selection) throw new Error("Editorial preview context is unavailable");
    const id = editorialPreviewContextId(publication, selection.contextDigest, selection.operationId);
    const ref = firestore.collection(EDITORIAL_CONTEXTS_COLLECTION).doc(id);
    const sealRef = firestore.collection(EDITORIAL_SEALS_COLLECTION).doc(id);
    const [before, beforeSeal] = await Promise.all([ref.get(), sealRef.get()]);
    let manifest: EditorialPreviewManifest;
    let seal: EditorialPreviewManifest | undefined;
    if (before.exists) {
      manifest = assertEditorialContextManifest(before.data(), selection);
      if (manifest.schemaVersion !== 1) throw new Error("Legacy editorial preview manifest is incompatible");
      // A historical legacy-only document never acquires withdrawal authority.
      // Only an already existing atomic pair can be recovered as a seal.
      if (beforeSeal.exists) {
        seal = assertEditorialContextManifest(beforeSeal.data(), selection);
        if (seal.schemaVersion !== 2 || !isDeepStrictEqual(legacyEditorialContextManifest(seal), manifest)) {
          throw new Error("Editorial preview seal differs from its legacy manifest");
        }
      }
      const stored = await readStorageObject(storage, manifest.key, bucket);
      assertEditorialContextBytes(stored?.bytes ?? null, manifest);
    } else {
      if (beforeSeal.exists) throw new Error("Editorial preview seal has no legacy manifest");
      const bytes = await readPrivateContextBytes(file);
      const checkpoint = await readPrivateContextBytes(path.join(path.dirname(file), `.checkpoint-${selection.checkpointStage ?? "prepared"}.json`));
      assertEditorialPreparedContext(bytes, checkpoint, selection);
      seal = editorialContextManifest(bytes, selection, withdrawalRevision);
      manifest = legacyEditorialContextManifest(seal);
      const previous = await readStorageObject(storage, manifest.key, bucket);
      if (previous) assertEditorialContextBytes(previous.bytes, manifest);
      else {
        try {
          await storage.send(new PutObjectCommand({ Bucket: bucket, Key: manifest.key, Body: bytes,
            ContentLength: bytes.length, ContentType: CONTENT_TYPE, CacheControl: CACHE_CONTROL,
            IfNoneMatch: "*" }), requestOptions());
        } catch (error) { if (!isConditionalConflict(error)) throw error; }
        const stored = await readStorageObject(storage, manifest.key, bucket);
        assertEditorialContextBytes(stored?.bytes ?? null, manifest);
      }
    }
    await firestore.runTransaction(async transaction => {
      const current = await readEditorialPreviewSelection(transaction, firestore, publication, operationId);
      const sealedRef = firestore.doc(LAST_SEALED_EDITORIAL_CONTEXT);
      const [stored, queue, controlRow, sealedRow, contextRow, storedSeal] = await transaction.getAll(ref,
        firestore.doc(`cmsPublishQueue/${operationId}`), firestore.doc("system/cmsPublicationRuntime"), sealedRef,
        firestore.doc("system/publicDeployment/contexts/public"), sealRef);
      const retention = queue.data()?.previewContext;
      const control = cloudCmsPublicationRuntimeControl(controlRow.data());
      if (!isDeepStrictEqual(selection, current) || (contextRow.data()?.withdrawalRevision ?? 0) !== withdrawalRevision ||
          seal && seal.withdrawalRevision !== withdrawalRevision || retention?.status !== "building" || retention.claim !== claim ||
          retention.manifestId !== id || retention.contextDigest !== selection.contextDigest ||
          retention.publicationArtifactReceiptDigest !== publication.artifactReceiptDigest ||
          retention.publicationGeneration !== publication.generation || !(retention.nextAttemptAt > clock()) ||
          control?.phase !== "ready" || control.commitSha !== publication.commitSha || control.serializerId !== serializerId) {
        throw new Error("Editorial preview context changed during retention");
      }
      if (stored.exists) {
        if (!isDeepStrictEqual(assertEditorialContextManifest(stored.data(), selection), manifest)) {
          throw new Error("Retained editorial preview context cannot change");
        }
      } else transaction.create(ref, manifest);
      if (storedSeal.exists) {
        if (!seal || !isDeepStrictEqual(assertEditorialContextManifest(storedSeal.data(), selection), seal)) {
          throw new Error("Retained editorial preview seal cannot change");
        }
      } else if (seal) {
        if (stored.exists) throw new Error("Historical editorial preview manifest cannot acquire a seal");
        transaction.create(sealRef, seal);
      }
      const previous = sealedRow.data();
      if (seal && (!previous ||
          previous.publication?.generation < publication.generation ||
          isDeepStrictEqual(previous.publication, publication) && previous.contextRevision <= selection.contextRevision)) {
        transaction.set(sealedRef, { schemaVersion: 1, manifestId: id, publication,
          contextRevision: selection.contextRevision });
      }
      transaction.update(firestore.doc(`cmsPublishQueue/${operationId}`), {
        previewContext: { status: "verified", manifestId: id, contextDigest: selection.contextDigest,
          publicationArtifactReceiptDigest: selection.publication.artifactReceiptDigest,
          publicationGeneration: selection.publication.generation },
      });
    });
  } finally { if (!client) storage.destroy(); }
}
