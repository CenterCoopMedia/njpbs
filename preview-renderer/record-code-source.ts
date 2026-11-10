/// <reference types="node" />
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Buffer } from "node:buffer";
import { accessToken, jsonResponse } from "../publisher/pending-work";
import targets from "../functions/lib/publication-target.js";
import codeContexts from "../functions/lib/current-public-code-source.js";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { parsePreviewStorageCredential } from "../site/scripts/cms-preview-storage-credential";
import { canonicalPublicationReceipt } from "../site/src/lib/public-publication-receipt";

// The private Worker does not allocate the existing 64 MiB container limit.
export const RECORD_CODE_WORKER_BYTES = 16 * 1024 * 1024;
type Data = Record<string, any>;
export type RecordCodeSourceEnv = { FIREBASE_SERVICE_ACCOUNT: string; R2_PREVIEW_CREDENTIAL: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CMS_DEPLOYMENT_ENVIRONMENT?: string; FIREBASE_PROJECT_ID?: string;
  CMS_DEV_ACCESS_CLIENT_ID?: string; CMS_DEV_ACCESS_CLIENT_SECRET?: string };

function refuse(): never { throw new Error("Private record code source is unavailable"); }
function object(value: unknown): Data {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse();
  return value as Data;
}
async function bytes(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.ok || !response.body) { await response.body?.cancel(); refuse(); }
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^[1-9][0-9]*$/.test(declared) || Number(declared) > limit)) {
    await response.body.cancel(); refuse();
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const row = await reader.read(); if (row.done) break;
      size += row.value.length; if (size > limit) refuse(); chunks.push(row.value);
    }
  } finally { await reader.cancel(); }
  if (!size || declared !== null && size !== Number(declared)) refuse();
  return Buffer.concat(chunks, size);
}
function decode(raw: unknown): Data {
  const field = (value: unknown): any => {
    const row = object(value);
    if (Object.hasOwn(row, "nullValue")) return null;
    if (typeof row.stringValue === "string") return row.stringValue;
    if (typeof row.booleanValue === "boolean") return row.booleanValue;
    if (typeof row.integerValue === "string" && Number.isSafeInteger(Number(row.integerValue))) return Number(row.integerValue);
    if (typeof row.timestampValue === "string" && Number.isFinite(Date.parse(row.timestampValue))) return Date.parse(row.timestampValue);
    if (row.mapValue) return decode(row.mapValue.fields ?? {});
    if (row.arrayValue) return (row.arrayValue.values ?? []).map(field);
    refuse();
  };
  return Object.fromEntries(Object.entries(object(raw)).map(([key, value]) => [key, field(value)]));
}

/** Private service-binding read only. A caller names a renderer, never an object,
 * bucket, deployment, operation or URL. This function does not touch the queue
 * or the renderer container. Tests replace fetch, not these authority checks. */
async function readPrivateCodeSource(env: RecordCodeSourceEnv, rendererSha: string, request: typeof fetch, referenceOnly = false) {
  if (!/^[a-f0-9]{40}$/.test(rendererSha)) refuse();
  const target = targets.publicationTarget(env.CMS_DEPLOYMENT_ENVIRONMENT ?? "production");
  if ((env.FIREBASE_PROJECT_ID ?? "njpbs-site") !== target.projectId) refuse();
  const deadline = AbortSignal.timeout(10_000);
  const call: typeof fetch = (url, init = {}) => request(url, { ...init, redirect: "manual", signal: deadline });
  const publication = async () => {
    const headers: Record<string, string> = { accept: "application/json", "cache-control": "no-cache" };
    if (target.environment === "development") {
      if (!env.CMS_DEV_ACCESS_CLIENT_ID || !env.CMS_DEV_ACCESS_CLIENT_SECRET) refuse();
      headers["CF-Access-Client-Id"] = env.CMS_DEV_ACCESS_CLIENT_ID;
      headers["CF-Access-Client-Secret"] = env.CMS_DEV_ACCESS_CLIENT_SECRET;
    }
    const response = await call(`${target.origin}/_publication.json?cms-context=code`, { headers });
    if (response.headers.get("x-njpbs-publication-origin") !== target.workerName ||
        !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      // Name the step: a receipt from the zone origin instead of the public
      // Worker looked like every other refusal (#3444).
      console.warn(JSON.stringify({ event: "record-code-publication-refused", status: response.status,
        origin: response.headers.get("x-njpbs-publication-origin")?.slice(0, 64) ?? null }));
      await response.body?.cancel(); refuse();
    }
    return canonicalPublicationReceipt(JSON.parse(Buffer.from(await bytes(response, 8192)).toString("utf8")));
  };
  const beforePublication = await publication();
  if (beforePublication.commitSha !== rendererSha) refuse();
  // Acquire existing credentials only for this read. They never enter replies.
  const token = await accessToken(env.FIREBASE_SERVICE_ACCOUNT, call, target.projectId);
  const base = `https://firestore.googleapis.com/v1/projects/${target.projectId}/databases/(default)/documents`;
  const read = async (path: string, mask: string[] = []) => {
    const params = new URLSearchParams(); mask.forEach(field => params.append("mask.fieldPaths", field));
    const response = await call(`${base}/${path}${mask.length ? `?${params}` : ""}`, { headers: { authorization: `Bearer ${token}` } });
    if (response.status === 404) { await response.body?.cancel(); return null; }
    const row = object(await jsonResponse(response, 2 * 1024 * 1024));
    if (row.name !== `${base.split("/v1/")[1]}/${path}` || typeof row.updateTime !== "string") refuse();
    return { data: decode(row.fields ?? {}), updateTime: row.updateTime };
  };
  const observe = async () => {
    const pointer = await read("system/publicDeployment");
    const deployment = pointer?.data;
    if (deployment?.schemaVersion !== 1 || deployment.state !== "idle" || deployment.activeCommitSha !== rendererSha ||
        !Number.isSafeInteger(deployment.activeGeneration) || deployment.activeGeneration < 1) refuse();
    return { pointer };
  };
  const before = await observe();
  const sourcePublication = beforePublication;
  const manifestPath = `cmsPreviewPublicContexts/${sourcePublication?.buildBatchId}`;
  // Validate a path component before sending a Firestore request.
  if (typeof sourcePublication?.buildBatchId !== "string" || !/^cms-[A-Za-z0-9]{20}$/.test(sourcePublication.buildBatchId)) refuse();
  const manifest = await read(manifestPath);
  const reference = codeContexts.validateCurrentCodeReference({ publication: sourcePublication, manifest: manifest?.data });
  if (reference.publication.commitSha !== rendererSha || reference.publication.generation !== before.pointer!.data.activeGeneration ||
      reference.manifest.byteLength > RECORD_CODE_WORKER_BYTES) refuse();
  const assertCurrent = async () => {
    const [after, afterManifest, afterPublication] = await Promise.all([observe(), read(manifestPath), publication()]);
    if (!isDeepStrictEqual(before, after) || !isDeepStrictEqual(manifest, afterManifest) || !isDeepStrictEqual(beforePublication, afterPublication)) refuse();
  };
  if (referenceOnly) {
    await assertCurrent();
    return { reference };
  }
  const credential = parsePreviewStorageCredential(env.R2_PREVIEW_CREDENTIAL);
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  if (!/^[a-f0-9]{32}$/.test(accountId ?? "")) refuse();
  const client = new S3Client({ endpoint: `https://${accountId}.r2.cloudflarestorage.com`, region: "auto", forcePathStyle: true,
    requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED", credentials: credential,
    maxAttempts: 1, requestHandler: { handle: async (http: any) => {
      const url = new URL(`${http.protocol}//${http.hostname}${http.path}`);
      for (const [key, value] of Object.entries(http.query ?? {})) {
        for (const part of Array.isArray(value) ? value : [value]) if (part !== undefined) url.searchParams.append(key, String(part));
      }
      // Only this fixed read is allowed through the SDK transport.
      if (http.method !== "GET" || url.hostname !== `${accountId}.r2.cloudflarestorage.com` ||
          url.pathname !== `/${target.previewBucket}/${reference.manifest.key}`) refuse();
      const response = await call(url.toString(), { method: "GET", headers: http.headers });
      return { response: { statusCode: response.status, headers: Object.fromEntries(response.headers), body: response.body } };
    } } });
  const storage = { get: async (key: string) => {
    if (key !== reference.manifest.key) refuse();
    try {
      const output = await client.send(new GetObjectCommand({ Bucket: target.previewBucket, Key: key }), { abortSignal: deadline });
      if (output.ContentLength !== reference.manifest.byteLength || !output.Body) {
        await output.Body?.transformToWebStream().cancel(); refuse();
      }
      const capturedBytes = await bytes(new Response(output.Body.transformToWebStream(), {
        headers: { "content-length": String(output.ContentLength) } }), RECORD_CODE_WORKER_BYTES);
      return capturedBytes;
    } finally { client.destroy(); }
  } };
  const body = await storage.get(reference.manifest.key);
  if (body.length !== reference.manifest.byteLength || createHash("sha256").update(body).digest("hex") !== reference.manifest.sha256) refuse();
  const raw = JSON.parse(Buffer.from(body).toString("utf8"));
  if (raw?.schemaVersion !== 3 || raw.receipt?.buildBatchId !== reference.publication.buildBatchId ||
      raw.receipt?.generation !== reference.publication.generation || raw.receipt?.commitSha !== reference.publication.commitSha ||
      raw.receipt?.mediaManifestDigest !== reference.publication.mediaManifestDigest ||
      createHash("sha256").update(JSON.stringify(raw.receipt)).digest("hex") !== reference.publication.artifactReceiptDigest) refuse();
  await assertCurrent();
  return { reference, bytes: body };
}
/** Current CODE qualification is distinct from the stored record baseline.
 * Full context DTO grammar remains the existing Node reader's responsibility. */
export async function readPrivateCurrentCode(env: RecordCodeSourceEnv, rendererSha: string, request: typeof fetch = fetch) {
  const read = await readPrivateCodeSource(env, rendererSha, request);
  if (!(read.bytes instanceof Uint8Array)) refuse();
  return { reference: read.reference, bytes: read.bytes };
}
export async function readPrivateCurrentCodeReference(env: RecordCodeSourceEnv, rendererSha: string, request: typeof fetch = fetch) {
  return (await readPrivateCodeSource(env, rendererSha, request, true)).reference;
}
