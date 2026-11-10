import { cachedDatastoreToken } from "./google-access-token-cache";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DOCUMENTS =
  "https://firestore.googleapis.com/v1/projects/njpbs-site/databases/(default)/documents";
const MAX_RESPONSE_BYTES = 64 * 1024;

export async function jsonResponse(response: Response, maxBytes = MAX_RESPONSE_BYTES): Promise<unknown> {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("Cloud publication work check failed");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maxBytes)
        throw new Error(
          "Cloud publication work response exceeds its size limit",
        );
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("Cloud publication work response is not JSON");
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Cloud publication work response is invalid");
  return value as Record<string, unknown>;
}

function base64Url(value: string | Uint8Array): string {
  const bytes =
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export async function accessToken(
  rawAccount: string,
  request: typeof fetch,
  projectId = "njpbs-site",
): Promise<string> {
  if (rawAccount.length > MAX_RESPONSE_BYTES)
    throw new Error("Cloud publication credential exceeds its size limit");
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawAccount);
  } catch {
    throw new Error("Cloud publication work credential is not JSON");
  }
  const account = record(parsed);
  if (
    account.type !== "service_account" ||
    account.project_id !== projectId ||
    typeof account.client_email !== "string" ||
    typeof account.private_key !== "string"
  ) {
    throw new Error("Cloud publication work credential is invalid");
  }
  const privateKey = account.private_key;
  return cachedDatastoreToken(rawAccount, projectId, async () => {
    const keyBytes = Uint8Array.from(
      atob(
        privateKey
          .replace("-----BEGIN PRIVATE KEY-----", "")
          .replace("-----END PRIVATE KEY-----", "")
          .replace(/\s/g, ""),
      ),
      (char) => char.charCodeAt(0),
    );
    const key = await crypto.subtle.importKey(
      "pkcs8",
      keyBytes,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const issuedAt = Math.floor(Date.now() / 1000);
    const unsigned = `${base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64Url(
      JSON.stringify({
        iss: account.client_email,
        scope: "https://www.googleapis.com/auth/datastore",
        aud: TOKEN_URL,
        iat: issuedAt,
        exp: issuedAt + 300,
      }),
    )}`;
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      new TextEncoder().encode(unsigned),
    );
    const response = await request(TOKEN_URL, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${base64Url(new Uint8Array(signature))}`,
      }),
    });
    const token = record(await jsonResponse(response));
    if (typeof token.access_token !== "string" || !token.access_token || token.token_type !== "Bearer")
      throw new Error("Cloud publication access token is invalid");
    return { value: token.access_token, expiresIn: token.expires_in };
  });
}

/** Read only queue names and the journal's job identity, never draft snapshots
 * or raw claim tokens. Idle minutes perform no container startup or keepalive. Coordinator and oldest pending work remain observable.
 */
export async function readPublicationWork(
  {
    account,
    commitSha,
    serializerId,
  }: {
    account: string;
    commitSha: string;
    serializerId: string;
  },
  request = fetch,
): Promise<{ needsRuntime: boolean; healthy: boolean }> {
  if (
    !/^[a-f0-9]{40}$/.test(commitSha) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(serializerId)
  ) {
    throw new Error("Cloud publication work identity is invalid");
  }
  const token = await accessToken(account, request);
  const headers = { Authorization: `Bearer ${token}` };
  let phase: unknown;
  try {
    const runtime = await request(
      `${DOCUMENTS}/system/cmsPublicationRuntime?mask.fieldPaths=schemaVersion&mask.fieldPaths=phase&mask.fieldPaths=commitSha&mask.fieldPaths=serializerId`,
      {
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      },
    );
    const fields = record(record(await jsonResponse(runtime)).fields);
    phase = record(fields.phase).stringValue;
    if (
      record(fields.schemaVersion).integerValue !== "1" ||
      typeof phase !== "string" ||
      !["paused", "starting", "ready"].includes(phase) ||
      record(fields.commitSha).stringValue !== commitSha ||
      record(fields.serializerId).stringValue !== serializerId
    ) {
      throw new Error("Invalid runtime");
    }
  } catch {
    throw new Error("Cloud publication runtime control is invalid");
  }
  // Starting boots the real runtime for preflight without admitting a fake job.
  let needsRuntime = phase === "starting";
  // Paused admission must still drain work already in the journal or queue.
  const journal = await request(
    `${DOCUMENTS}/cmsPublicationSerializerJournals/${serializerId}?mask.fieldPaths=job.queueId&mask.fieldPaths=job.commitSha`,
    {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (journal.status !== 404) {
    const document = record(await jsonResponse(journal));
    const fields = document.fields === undefined ? {} : record(document.fields);
    if (fields.job !== undefined) {
      const jobValue = record(fields.job);
      if (!Object.hasOwn(jobValue, "nullValue")) {
        const job = record(record(jobValue.mapValue).fields);
        const queueId = record(job.queueId).stringValue;
        if (
          typeof queueId !== "string" ||
          !/^[A-Za-z0-9]{20}$/.test(queueId) ||
          record(job.commitSha).stringValue !== commitSha
        ) {
          throw new Error(
            "Cloud publication journal requires its original publisher",
          );
        }
        needsRuntime = true;
      }
    }
  } else await journal.body?.cancel();

  const response = await request(`${DOCUMENTS}:runQuery`, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "cmsPublishQueue" }],
        select: {
          fields: [{ fieldPath: "__name__" }, { fieldPath: "triggeredAt" }],
        },
        limit: 1,
        orderBy: [
          { field: { fieldPath: "triggeredAt" }, direction: "ASCENDING" },
        ],
        where: {
          compositeFilter: {
            op: "AND",
            filters: [
              {
                fieldFilter: {
                  field: { fieldPath: "status" },
                  op: "IN",
                  value: {
                    arrayValue: {
                      values: [
                        { stringValue: "pending" },
                        { stringValue: "publishing" },
                      ],
                    },
                  },
                },
              },
              {
                fieldFilter: {
                  field: { fieldPath: "transport" },
                  op: "EQUAL",
                  value: { stringValue: "serializer" },
                },
              },
            ],
          },
        },
      },
    }),
  });
  const result = await jsonResponse(response);
  if (!Array.isArray(result) || result.length > 11)
    throw new Error("Cloud publication queue response is invalid");
  let overdue = false;
  for (const row of result) {
    const item = record(row);
    if (item.document === undefined) continue;
    const name = record(item.document).name;
    if (
      typeof name !== "string" ||
      !/^projects\/njpbs-site\/databases\/\(default\)\/documents\/cmsPublishQueue\/[A-Za-z0-9]{20}$/.test(
        name,
      )
    ) {
      throw new Error("Cloud publication queue response has another identity");
    }
    needsRuntime = true;
    const fields = record(record(item.document).fields);
    const triggeredAt = Date.parse(
      String(record(fields.triggeredAt).timestampValue),
    );
    if (!Number.isFinite(triggeredAt) || Date.now() - triggeredAt > 15 * 60_000)
      overdue = true;
  }
  const coordinator = await request(
    `${DOCUMENTS}/system/publicDeployment?mask.fieldPaths=state&mask.fieldPaths=leaseAcquiredAt`,
    {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    },
  );
  const fields = record(record(await jsonResponse(coordinator)).fields);
  const state = record(fields.state).stringValue;
  if (!["idle", "deploying", "reconciling"].includes(String(state)))
    throw new Error("Cloud publication coordinator is invalid");
  if (state !== "idle") {
    needsRuntime = true;
    const acquiredAt = Date.parse(
      String(record(fields.leaseAcquiredAt).timestampValue),
    );
    if (!Number.isFinite(acquiredAt) || Date.now() - acquiredAt > 15 * 60_000)
      overdue = true;
  }
  return { needsRuntime, healthy: phase === "ready" && !overdue };
}

/** Decode only bounded server-owned control fields. */
function decodeFields(fields: Record<string, unknown>): Record<string, any> {
  function value(raw: unknown): any {
    const field = record(raw);
    if (Object.hasOwn(field, "nullValue")) return null;
    if (Object.hasOwn(field, "stringValue")) return field.stringValue;
    if (Object.hasOwn(field, "booleanValue")) return field.booleanValue;
    if (Object.hasOwn(field, "integerValue")) return Number(field.integerValue);
    if (Object.hasOwn(field, "doubleValue")) return Number(field.doubleValue);
    if (Object.hasOwn(field, "timestampValue")) return Date.parse(String(field.timestampValue));
    if (field.arrayValue) {
      const values = record(field.arrayValue).values ?? [];
      if (!Array.isArray(values)) throw new Error("Invalid cloud control array");
      return values.map(value);
    }
    if (field.mapValue) return decodeFields(record(record(field.mapValue).fields ?? {}));
    throw new Error("Unsupported cloud control field");
  }
  return Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, value(field)]));
}

import externalRefresh from "../functions/lib/cloud-external-refresh-state.js";
import cloudWork from "../functions/lib/no-build-cloud-work.js";
import { readPublicationHealth, publicationAttemptsExhausted, type PublicationHealth } from "./publication-health";
import targets, { type PublicationTarget } from "../functions/lib/publication-target.js";
import runtimeControl from "../functions/lib/cms-publication-runtime-control.js";
const CONTROL_FIELDS = ["disabled", "schemaVersion", "phase", "commitSha", "serializerId", "runtime", "state",
  "servingEnabled", "generation", "ownedSlugs", "sourceVersion", "slug", "families.posts.mode", "families.posts.ids",
  "owner", "pageId", "ownerPath", "ownedPaths", "acceptedAt", "progressAt", "followUp.pendingSince", "finalNamespaceOwner", "preparationOperationId", "namespaceOperationId", "publicContext.contextRevision", "publicContext.contextDigest", "publicContext.recordFamilies", "recordFamilies", "contextOnly",
  "transport", "noBuildPost.postId", "noBuildPost.operationId", "noBuildPost.sourceVersion", "homeFullBuild.status",
  "cloud.phase", "cloud.commitSha", "cloud.serializerId",
  "activeCommitSha", "activeGeneration", "updatedAt", "previewContext.status", "previewContext.manifestId",
  "previewContext.publicationGeneration", "previewContext.publicationArtifactReceiptDigest", "previewContext.contextDigest",
  "previewContext.attempts", "previewContext.startedAt", "previewContext.nextAttemptAt", "mode", "postId", "operationId", "rendererSha", "visible", "revision", "enabled",
  "backgroundBucket", "backgroundRuntime", "job.queueId", "job.commitSha", "status", "attempts", "nextAttemptAt", "contextDigest", "taskPath", "receipt.rendererSha",
  "preparedDigest", "claim", "slowRetryAt", "lastAttempt.retryable", "lastAttempt.failureClass",
  "periodStartedAt", "nextCheckAt", "checkedAt", "hold", "pendingSince", "changedAt", "withdrawalDeadline", "withdrawalDeadlineRevision", "withdrawalRevision", "leaseAcquiredAt",
  "receipt.withdrawalRevision", "receipt.verifiedAt", "receipt.sourceReadAt", "after.visible", "lastGood.receipt.withdrawalRevision", "lastGood.receipt.verifiedAt", "lastGood.receipt.sourceReadAt", "lastGood.after.visible", "homeFullBuild.status"];

const OWNER_FIELDS = ["schemaVersion", "servingEnabled", "generation", "ownedSlugs", "sourceVersion",
  "slug", "rendererSha", "postId", "operationId", "visible", "mode", "runtime"];
const OWNER_COLLECTION = "system/publicDeployment/noBuildPostOwners";
const OWNER_PAGE_SIZE = 25;
const OWNER_MAX_PAGES = 100;

/** Fetch every masked page before selecting work. A failed or bounded read
 * refuses the observation rather than silently overlooking a retained owner. */
export async function readPublicationOwners(documents: string, headers: Record<string, string>, request = fetch) {
  const owners: Record<string, any>[] = [];
  const names = new Set<string>();
  const tokens = new Set<string>();
  const namePrefix = `${new URL(documents).pathname.split("/v1/")[1]}/${OWNER_COLLECTION}/`;
  let pageToken = "";
  for (let page = 0; page < OWNER_MAX_PAGES; page++) {
    const params = new URLSearchParams({ pageSize: String(OWNER_PAGE_SIZE) });
    for (const field of OWNER_FIELDS) params.append("mask.fieldPaths", field);
    if (pageToken) params.set("pageToken", pageToken);
    const response = await request(`${documents}/${OWNER_COLLECTION}?${params}`, {
      headers, redirect: "manual", signal: AbortSignal.timeout(10_000),
    });
    const result = record(await jsonResponse(response, 256 * 1024));
    const rows = result.documents ?? [];
    if (!Array.isArray(rows) || rows.length > OWNER_PAGE_SIZE) throw new Error("Invalid cloud owner page");
    for (const raw of rows) {
      const document = record(raw);
      if (typeof document.name !== "string" || !document.name.startsWith(namePrefix)) {
        throw new Error("Cloud owner page has another target");
      }
      const postId = document.name.slice(namePrefix.length);
      const owner = decodeFields(record(document.fields));
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(postId) || owner.postId !== postId || names.has(postId)) {
        throw new Error("Cloud owner page has an invalid identity");
      }
      names.add(postId);
      owners.push(owner);
    }
    const next = result.nextPageToken;
    if (next === undefined || next === "") return owners;
    if (typeof next !== "string" || next.length > 4096 || tokens.has(next)) throw new Error("Invalid cloud owner page token");
    tokens.add(next);
    pageToken = next;
  }
  throw new Error("Cloud owner collection exceeds its page limit");
}

export async function readNoBuildPublicationWork(options: {
  account: string; commitSha: string; serializerId: string; target?: PublicationTarget;
}, request = fetch): Promise<{ needsRuntime: boolean; healthy: boolean; diagnostics: Omit<PublicationHealth, "healthy"> }> {
  if (!/^[a-f0-9]{40}$/.test(options.commitSha) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(options.serializerId)) throw new Error("Invalid cloud runtime identity");
  const target = targets.assertPublicationTarget(options.target ?? targets.publicationTarget());
  if (options.serializerId !== target.serializerId) throw new Error("Refusing a mixed publication serializer");
  const documents = `https://firestore.googleapis.com/v1/projects/${target.projectId}/databases/(default)/documents`;
  const token = await accessToken(options.account, request, target.projectId);
  const headers = { Authorization: `Bearer ${token}` };
  const cache = new Map<string, Promise<Record<string, any> | null>>();
  let owners: Promise<Record<string, any>[]> | undefined;
  const listOwners = () => owners ??= readPublicationOwners(documents, headers, request);
  const fetchDocument = async (path: string) => {
    const mask = CONTROL_FIELDS.map(field => `mask.fieldPaths=${field}`).join("&");
    const response = await request(`${documents}/${path}?${mask}`, {
      headers, redirect: "manual", signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404) { await response.body?.cancel(); return null; }
    return decodeFields(record(record(await jsonResponse(response)).fields ?? {}));
  };
  const read = (path: string) => {
    if (!cache.has(path)) cache.set(path, fetchDocument(path));
    return cache.get(path)!;
  };
  const control = runtimeControl.cloudCmsPublicationRuntimeControl(await read("system/cmsPublicationRuntime"));
  if (!control || !["starting", "ready", "paused"].includes(control.phase) ||
      control.commitSha !== options.commitSha || control.serializerId !== options.serializerId) {
    throw new Error("Cloud publication runtime control is invalid");
  }
  if ((await read("system/billing"))?.disabled === true) {
    return { needsRuntime: false, healthy: false, diagnostics: { reasons: ["billing_disabled"], oldestDueAt: null } };
  }
  const journal = await read(`cmsPublicationSerializerJournals/${options.serializerId}`);
  let journalSettlement = false;
  let retainedDue = false;
  if (journal?.job) {
    if (journal.runtime?.owner !== "cloudflare" || journal.runtime?.release !== options.commitSha ||
        journal.job.commitSha !== options.commitSha || !/^[A-Za-z0-9]{20}$/.test(journal.job.queueId)) {
      throw new Error("Cloud journal requires its original owner");
    }
    const batch = await read(`system/publicDeployment/buildBatches/cms-${journal.job.queueId}`);
    // Retired reservations belong to legacy history, never a cloud journal.
    if (batch?.status === "retired") throw new Error("A retired legacy reservation cannot belong to the cloud journal");
    journalSettlement = ["deployed", "failed", "superseded", "cancelled"].includes(batch?.status);
    const retained = await read(`cmsPublicationSerializerJournals/${options.serializerId}/releases/${journal.job.queueId}`);
    retainedDue = cloudWork.retryDue(retained, Date.now());
  }
  let work = { maintenance: false, reconcile: false };
  let workUnreadable = false;
  try { work = await cloudWork.readNoBuildCloudWork({ read, listOwners, runtime: { owner: "cloudflare", release: options.commitSha } }); }
  catch { workUnreadable = true; }
  const admission = await read("system/noBuildPostAdmission");
  if (admission && admission.backgroundBucket !== target.backgroundBucket) throw new Error("Refusing a mixed publication background bucket");
  const pointer = await read("system/publicDeployment");
  const idle = pointer?.state === "idle";
  let refreshDue = false;
  try {
    if (idle && control.phase === "ready" && pointer.activeCommitSha === options.commitSha && await read("system/publicDeployment/contexts/public")) {
      refreshDue = externalRefresh.externalRefreshDue(await read(externalRefresh.EXTERNAL_REFRESH_PATH), { owner: "cloudflare", release: options.commitSha });
    }
  } catch { workUnreadable = true; }
  // Release requests are a private subcollection of the existing cloud journal.
  // A trusted release producer creates one only after the complete checkpoint.
  const response = journal?.job || !idle ? null : await request(`${documents}/cmsPublicationSerializerJournals/${options.serializerId}:runQuery`, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    redirect: "manual", signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "releases" }],
      select: { fields: [{ fieldPath: "__name__" }] }, limit: 1,
      where: { compositeFilter: { op: "AND", filters: [
        { fieldFilter: { field: { fieldPath: "runtime.owner" }, op: "EQUAL", value: { stringValue: "cloudflare" } } },
        { fieldFilter: { field: { fieldPath: "runtime.release" }, op: "EQUAL", value: { stringValue: options.commitSha } } },
        { fieldFilter: { field: { fieldPath: "nextAttemptAt" }, op: "LESS_THAN_OR_EQUAL", value: { integerValue: String(Date.now()) } } },
      ] } }, orderBy: [{ field: { fieldPath: "nextAttemptAt" }, direction: "ASCENDING" }],
    } }),
  });
  const result = response ? await jsonResponse(response) : [];
  if (!Array.isArray(result) || result.length > 2) throw new Error("Invalid cloud release query");
  const releaseDue = result.some(row => record(row).document !== undefined);
  let progress: PublicationHealth;
  try { progress = await readPublicationHealth({ read, listOwners, runtime: { owner: "cloudflare", release: options.commitSha } }); }
  catch { progress = { healthy: false, reasons: ["state_unreadable"], oldestDueAt: null }; }
  if (workUnreadable) { progress.healthy = false; progress.reasons.push("state_unreadable"); }
  const retained = journal?.job && !journalSettlement ? await read(`cmsPublicationSerializerJournals/${options.serializerId}/releases/${journal.job.queueId}`) : null;
  const retainedUnreadable = journal?.job && !journalSettlement && (!retained ||
    retained.runtime?.owner !== "cloudflare" || retained.runtime?.release !== options.commitSha ||
    !["pending", "failed"].includes(retained.status) || !Number.isSafeInteger(retained.attempts) ||
    retained.attempts < 0 || retained.attempts > 4 ||
    !(Number.isFinite(retained.nextAttemptAt) && retained.nextAttemptAt >= 0 ||
      retained.nextAttemptAt === null && retained.status === "failed" && retained.attempts === 4));
  if (retainedUnreadable) { progress.healthy = false; progress.reasons.push("state_unreadable"); }
  const releaseExhausted = publicationAttemptsExhausted(retained);
  // An interrupted final claim gets one wake to record exhaustion and clear its due time.
  const exhaustionDue = !retainedUnreadable && releaseExhausted && Number.isFinite(retained?.nextAttemptAt);
  if (releaseExhausted) progress.reasons.push("release_exhausted");
  if (control.phase !== "ready") progress.reasons.push("runtime_not_ready");
  const previewDue = control.phase === "ready" && "previewContext" in work && work.previewContext === true;
  return { needsRuntime: control.phase === "starting" || refreshDue || previewDue || work.maintenance || work.reconcile || (idle && (releaseDue || journalSettlement || retainedDue || exhaustionDue)),
    healthy: control.phase === "ready" && progress.healthy && !releaseExhausted,
    diagnostics: { reasons: [...new Set(progress.reasons)].sort(), oldestDueAt: progress.oldestDueAt } };
}
