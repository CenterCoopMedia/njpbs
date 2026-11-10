import { previewOutputTarget } from "../site/scripts/preview-output-target.mjs";
import { cachedDatastoreToken } from "../publisher/google-access-token-cache";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const MAX_RESPONSE_BYTES = 64 * 1024;

export async function jsonResponse(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("Cloud preview work check failed");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_RESPONSE_BYTES) throw new Error("Cloud preview work response exceeds its size limit");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new Error("Cloud preview work response is not JSON"); }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Cloud preview work response is invalid");
  return value as Record<string, unknown>;
}

function base64Url(value: string | Uint8Array): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(""))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function accessToken(rawAccount: string, projectId: string, request: typeof fetch): Promise<string> {
  if (rawAccount.length > MAX_RESPONSE_BYTES) throw new Error("Cloud preview credential exceeds its size limit");
  let parsed: unknown;
  try { parsed = JSON.parse(rawAccount); }
  catch { throw new Error("Cloud preview work credential is not JSON"); }
  const account = record(parsed);
  if (account.type !== "service_account" || account.project_id !== projectId ||
    typeof account.client_email !== "string" ||
    (projectId === "njpbs-site-dev" && !account.client_email.endsWith(`@${projectId}.iam.gserviceaccount.com`)) ||
    typeof account.private_key !== "string") {
    throw new Error("Cloud preview work credential is invalid");
  }
  const privateKey = account.private_key;
  return cachedDatastoreToken(rawAccount, projectId, async () => {
    const keyBytes = Uint8Array.from(atob(privateKey
      .replace("-----BEGIN PRIVATE KEY-----", "").replace("-----END PRIVATE KEY-----", "").replace(/\s/g, "")), char => char.charCodeAt(0));
    const key = await crypto.subtle.importKey("pkcs8", keyBytes,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
    const issuedAt = Math.floor(Date.now() / 1000);
    const unsigned = `${base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64Url(JSON.stringify({
      iss: account.client_email, scope: "https://www.googleapis.com/auth/datastore",
      aud: TOKEN_URL, iat: issuedAt, exp: issuedAt + 300,
    }))}`;
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
    const response = await request(TOKEN_URL, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${base64Url(new Uint8Array(signature))}` }) });
    const token = record(await jsonResponse(response));
    if (typeof token.access_token !== "string" || !token.access_token || token.token_type !== "Bearer") throw new Error("Cloud preview access token is invalid");
    return { value: token.access_token, expiresIn: token.expires_in };
  });
}

/** Read only queue names and the journal's job identity, never draft snapshots
 * or raw claim tokens. Idle minutes perform no container startup or keepalive.
 */
export async function hasPendingPreviewWork({ account, rendererSha, serializerId, workerVersion,
  deploymentEnvironment = "production", projectId = "njpbs-site" }: {
  account: string;
  rendererSha: string;
  serializerId: string;
  workerVersion?: string;
  deploymentEnvironment?: string;
  projectId?: string;
}, request = fetch): Promise<boolean> {
  previewOutputTarget(deploymentEnvironment, projectId);
  const DOCUMENTS = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
  if (!/^[a-f0-9]{40}$/.test(rendererSha) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(serializerId)) {
    throw new Error("Cloud preview work identity is invalid");
  }
  const token = await accessToken(account, projectId, request);
  const headers = { Authorization: `Bearer ${token}` };
  let phase: unknown;
  try {
    const runtime = await request(`${DOCUMENTS}/system/cmsPreviewRuntime?mask.fieldPaths=schemaVersion&mask.fieldPaths=phase&mask.fieldPaths=rendererSha&mask.fieldPaths=serializerId&mask.fieldPaths=selectedPairId&mask.fieldPaths=recoveryPairId`, {
      headers, redirect: "manual", signal: AbortSignal.timeout(10_000),
    });
    const fields = record(record(await jsonResponse(runtime)).fields);
    phase = record(fields.phase).stringValue;
    if (record(fields.schemaVersion).integerValue === "2") {
      const selected = record(fields.selectedPairId).stringValue;
      const recovery = record(fields.recoveryPairId).stringValue;
      if (phase !== "ready" || !/^preview-[a-z0-9][a-z0-9-]{0,31}$/.test(serializerId) ||
          ![selected, recovery].includes(serializerId) || !workerVersion) throw new Error("Invalid retained pair");
      const pairResponse = await request(`${DOCUMENTS}/cmsPreviewPairs/${serializerId}?mask.fieldPaths=pairId&mask.fieldPaths=rendererSha&mask.fieldPaths=serializerId&mask.fieldPaths=workerVersion`, {
        headers, redirect: "manual", signal: AbortSignal.timeout(10_000),
      });
      const pair = record(record(await jsonResponse(pairResponse)).fields);
      if (record(pair.pairId).stringValue !== serializerId || record(pair.serializerId).stringValue !== serializerId ||
          record(pair.rendererSha).stringValue !== rendererSha || record(pair.workerVersion).stringValue !== workerVersion) {
        throw new Error("Invalid retained pair version");
      }
    } else if (record(fields.schemaVersion).integerValue !== "1" ||
      typeof phase !== "string" || !["paused", "starting", "ready"].includes(phase) ||
      record(fields.rendererSha).stringValue !== rendererSha ||
      record(fields.serializerId).stringValue !== serializerId) {
      throw new Error("Invalid runtime");
    }
  } catch {
    throw new Error("Cloud preview runtime control is invalid");
  }
  // Starting boots the real runtime for preflight without admitting a fake job.
  if (phase === "starting") return true;
  // Paused admission must still drain work already in the journal or queue.
  const journal = await request(`${DOCUMENTS}/cmsPreviewSerializerJournals/${serializerId}?mask.fieldPaths=job.queueId&mask.fieldPaths=job.commitSha`, {
    headers, redirect: "manual", signal: AbortSignal.timeout(10_000),
  });
  if (journal.status !== 404) {
    const document = record(await jsonResponse(journal));
    const fields = document.fields === undefined ? {} : record(document.fields);
    if (fields.job !== undefined) {
      const jobValue = record(fields.job);
      if (!Object.hasOwn(jobValue, "nullValue")) {
        const job = record(record(jobValue.mapValue).fields);
        const queueId = record(job.queueId).stringValue;
        if (typeof queueId !== "string" || !/^[A-Za-z0-9]{20}$/.test(queueId) || record(job.commitSha).stringValue !== rendererSha) {
          throw new Error("Cloud preview journal requires its original renderer");
        }
        return true;
      }
    }
  } else await journal.body?.cancel();

  const response = await request(`${DOCUMENTS}:runQuery`, { method: "POST", headers: {
    ...headers, "Content-Type": "application/json",
  }, redirect: "manual", signal: AbortSignal.timeout(10_000), body: JSON.stringify({ structuredQuery: {
    from: [{ collectionId: "cmsPreviewQueue" }], select: { fields: [{ fieldPath: "__name__" }] }, limit: 1,
    where: { compositeFilter: { op: "AND", filters: Object.entries({ status: "pending", transport: "serializer", rendererSha,
      ...(/^preview-[a-z0-9][a-z0-9-]{0,31}$/.test(serializerId) ? { serializerId } : {}) })
      .map(([fieldPath, stringValue]) => ({ fieldFilter: { field: { fieldPath }, op: "EQUAL", value: { stringValue } } })) } },
  } }) });
  const result = await jsonResponse(response);
  if (!Array.isArray(result) || result.length > 2) throw new Error("Cloud preview queue response is invalid");
  return result.some(row => {
    const item = record(row);
    if (item.document === undefined) return false;
    const name = record(item.document).name;
    if (typeof name !== "string" || !new RegExp(`^projects/${projectId}/databases/\\(default\\)/documents/cmsPreviewQueue/[A-Za-z0-9]{20}$`).test(name)) {
      throw new Error("Cloud preview queue response has another identity");
    }
    return true;
  });
}
