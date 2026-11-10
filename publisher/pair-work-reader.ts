import { accessToken, jsonResponse } from "./pending-work";
import pairs from "../functions/lib/public-release-pair.js";
import work from "../functions/lib/public-release-pair-work.js";
import targets from "../functions/lib/publication-target.js";
import type { PairWakeIdentity } from "./release-pair-wake";
import { pendingSelectedSwitchCode } from "./pair-switch-code-wake";
import { pairOwnerCodeSnapshotReader } from "./pair-owner-code-reader";
import { pairOwnerEvidenceClient } from "./pair-owner-evidence-client";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid private pair read");
  return value as Record<string, unknown>;
}
function fields(value: unknown, depth = 0): Record<string, unknown> {
  const source = record(value);
  if (depth > 16 || Object.keys(source).length > 128) throw new Error("Private pair read exceeds bounds");
  const decode = (raw: unknown): unknown => {
    const item = record(raw);
    if (Object.hasOwn(item, "nullValue")) return null;
    if (typeof item.stringValue === "string") return item.stringValue;
    if (typeof item.booleanValue === "boolean") return item.booleanValue;
    if (typeof item.integerValue === "string" && /^-?\d+$/.test(item.integerValue) && Number.isSafeInteger(Number(item.integerValue))) return Number(item.integerValue);
    if (item.mapValue) return fields(record(item.mapValue).fields ?? {}, depth + 1);
    if (item.arrayValue) {
      const values = record(item.arrayValue).values ?? [];
      if (!Array.isArray(values) || values.length > 100) throw new Error("Invalid private pair array");
      if (depth >= 16) throw new Error("Private pair read exceeds bounds");
      return values.map(value => fields({ value }, depth + 1).value);
    }
    if (typeof item.timestampValue === "string" && Number.isFinite(Date.parse(item.timestampValue))) {
      const millis = Date.parse(item.timestampValue);
      return { toMillis: () => millis };
    }
    throw new Error("Unsupported private pair field");
  };
  return Object.fromEntries(Object.entries(source).map(([key, value]) => [key, decode(value)]));
}
export { fields as decodePairEvidenceFields };

/** Provider boundary. The production caller fixes the project from the pair's
 * environment; tests route this exact REST shape to a local demo emulator.
 */
export function pairFirestoreReader({ projectId, token, request = fetch }: { projectId: string; token: string; request?: typeof fetch }) {
  if (!/^[a-z][a-z0-9-]{1,62}$/.test(projectId)) throw new Error("Invalid pair project");
  const resource = `projects/${projectId}/databases/(default)/documents`;
  const base = `https://firestore.googleapis.com/v1/${resource}`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const encoded = (path: string) => path.split("/").map(encodeURIComponent).join("/");
  return {
    async read(path: string): Promise<Record<string, unknown> | null> {
      // Budget telemetry can contain doubles/Infinity. Only the admission bit
      // belongs to this observer; do not decode or transfer unrelated billing.
      const mask = path === "system/billing" ? "?mask.fieldPaths=disabled" : "";
      const response = await request(`${base}/${encoded(path)}${mask}`, { headers, redirect: "error", signal: AbortSignal.timeout(10_000) });
      if (response.status === 404) { await response.body?.cancel(); return null; }
      const document = record(await jsonResponse(response));
      if (document.name !== `${resource}/${path}`) throw new Error("Private pair document differs");
      return fields(document.fields ?? {});
    },
    async hasPendingStaging(pairId: string, now = Date.now(), collection: "staging" | "activationPending" = "staging") {
      if (!Number.isSafeInteger(now) || now < 1) throw new Error("Invalid private staging clock");
      if (!["staging", "activationPending"].includes(collection)) throw new Error("Invalid private continuation collection");
      const parent = work.publicReleasePairPath(pairId);
      const response = await request(`${base}/${encoded(parent)}:runQuery`, { method: "POST", headers, redirect: "error",
        signal: AbortSignal.timeout(10_000), body: JSON.stringify({ structuredQuery: {
          from: [{ collectionId: collection }], select: { fields: [{ fieldPath: collection === "staging" ? "taskId" : "intent.taskId" }] },
          where: { fieldFilter: { field: { fieldPath: "nextAttemptAt" }, op: "LESS_THAN_OR_EQUAL", value: { integerValue: String(now) } } }, limit: 1 } }) });
      const rows = await jsonResponse(response);
      if (!Array.isArray(rows) || rows.length > 3) throw new Error("Private staging query exceeds bounds");
      const documents = rows.filter(row => record(row).document !== undefined);
      if (documents.length > 1) throw new Error("Private staging query exceeds bounds");
      for (const raw of documents) {
        const document = record(record(raw).document), decoded = fields(document.fields ?? {}),
          taskId = collection === "staging" ? decoded.taskId : record(decoded.intent).taskId;
        if (typeof taskId !== "string" || !/^[a-f0-9]{64}$/.test(taskId) ||
            document.name !== `${resource}/${parent}/${collection}/${taskId}`) throw new Error("Private staging owner differs");
      }
      return documents.length === 1;
    },
    async hasPendingPublication(pairId: string, now: number) {
      if (!Number.isSafeInteger(now) || now < 1) throw new Error("Invalid private publication clock");
      const parent = work.publicReleasePairPath(pairId);
      const response = await request(`${base}/${encoded(parent)}:runQuery`, { method: "POST", headers, redirect: "error",
        signal: AbortSignal.timeout(10_000), body: JSON.stringify({ structuredQuery: {
          from: [{ collectionId: "publicationPending" }],
          select: { fields: ["schemaVersion", "operationId", "admissionDigest"].map(fieldPath => ({ fieldPath })) },
          where: { fieldFilter: { field: { fieldPath: "nextAttemptAt" }, op: "LESS_THAN_OR_EQUAL", value: { integerValue: String(now) } } }, limit: 1 } }) });
      const rows = await jsonResponse(response);
      if (!Array.isArray(rows) || rows.length > 3) throw new Error("Private publication query exceeds bounds");
      const documents = rows.filter(row => record(row).document !== undefined);
      if (documents.length > 1) throw new Error("Private publication query exceeds bounds");
      for (const raw of documents) {
        const document = record(record(raw).document), decoded = fields(document.fields ?? {});
        if (decoded.schemaVersion !== 2 || typeof decoded.operationId !== "string" ||
            !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(decoded.operationId) ||
            typeof decoded.admissionDigest !== "string" || !/^[a-f0-9]{64}$/.test(decoded.admissionDigest) ||
            document.name !== `${resource}/${parent}/publicationPending/${decoded.operationId}`) throw new Error("Private publication owner differs");
      }
      return documents.length === 1;
    },
    async listDue(pairId: string, field: "acceptedDueAt" | "nextAttemptAt" | "leaseUntil", now: number, limit: number) {
      if (!Number.isSafeInteger(now) || now < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error("Invalid pair query");
      const parent = work.publicReleasePairPath(pairId);
      const response = await request(`${base}/${encoded(parent)}:runQuery`, { method: "POST", headers, redirect: "error",
        signal: AbortSignal.timeout(10_000), body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "work" }],
          where: { fieldFilter: { field: { fieldPath: field }, op: "LESS_THAN_OR_EQUAL", value: { integerValue: String(now) } } }, limit } }) });
      const rows = await jsonResponse(response);
      if (!Array.isArray(rows) || rows.length > limit + 2) throw new Error("Private pair query exceeds bounds");
      const prefix = `${resource}/${parent}/work/`;
      const results = rows.filter(row => record(row).document !== undefined).map(row => {
        const document = record(record(row).document);
        const id = typeof document.name === "string" && document.name.startsWith(prefix) ? document.name.slice(prefix.length) : "";
        if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Private pair query owner differs");
        return { id, data: fields(document.fields ?? {}) };
      });
      if (results.length > limit) throw new Error("Private pair query exceeds bounds");
      return results;
    },
  };
}

export async function readPrivatePairRecord(reader: Pick<ReturnType<typeof pairFirestoreReader>, "read">, identity: PairWakeIdentity, workerVersionId: string) {
  const pair = pairs.parsePublicReleasePair(await reader.read(work.publicReleasePairPath(identity.pairId)));
  work.assertPrivatePairResources(pair);
  if (pair.pairId !== identity.pairId || pair.commitSha !== identity.commitSha || pair.environment !== identity.environment ||
      pair.publisher.journalNamespace !== identity.journalNamespace || pair.publisher.workerVersionId !== workerVersionId) throw new Error("Private pair version differs");
  return pair;
}
export async function privatePairReader({ account, identity, workerVersionId, request = fetch, originalRecoveryEnabled = false, switchCodeRecoveryEnabled = false }: {
  account: string; identity: PairWakeIdentity; workerVersionId: string; request?: typeof fetch; originalRecoveryEnabled?: boolean; switchCodeRecoveryEnabled?: boolean;
}) {
  const target = targets.publicationTarget(identity.environment);
  const reader = pairFirestoreReader({ projectId: target.projectId, token: await accessToken(account, request, target.projectId), request });
  const pair = await readPrivatePairRecord(reader, identity, workerVersionId);
  return { pair, read: reader.read, async due(now = Date.now()) {
    const hint = await work.readPublicReleasePairWorkHint({ pair, read: reader.read, now,
      listDue: (field, limit) => reader.listDue(pair.pairId, field, now, limit) });
    if (hint.billingDisabled || hint.taskIds.length) return hint;
    const stagingPending = await reader.hasPendingStaging(pair.pairId, now);
    const observation = { ...hint, stagingPending,
      activationPending: !stagingPending && await reader.hasPendingStaging(pair.pairId, now, "activationPending") };
    if (originalRecoveryEnabled !== true || stagingPending || observation.activationPending) return observation;
    const root = await reader.read("system/publicDeployment");
    if (root?.schemaVersion !== 2) return observation;
    const selector = pairs.parseStoredPublicReleaseSelector(root);
    const adoption = await reader.read("system/publicReleaseAdmissions/controls/adoption");
    if (adoption?.enabled !== true) return observation;
    if (adoption.schemaVersion !== 2 || Object.keys(adoption).sort().join(",") !== "enabled,schemaVersion")
      throw new Error("Private original recovery adoption differs");
    const publicationPending = await reader.hasPendingPublication(pair.pairId, now);
    return { ...observation, publicationPending: publicationPending || switchCodeRecoveryEnabled === true &&
      await pendingSelectedSwitchCode({ pair, selector, now, read: reader.read }) };
  } };
}

/** Separate construction for the granted owner-write binding. Existing
 * observer readers expose no private evidence mutation. */
export async function privatePairOwnerWriteReader({ account, identity, workerVersionId, request = fetch }: {
  account: string; identity: PairWakeIdentity; workerVersionId: string; request?: typeof fetch;
}) {
  const target = targets.publicationTarget(identity.environment), token = await accessToken(account, request, target.projectId);
  const reader = pairFirestoreReader({ projectId: target.projectId, token, request });
  const pair = await readPrivatePairRecord(reader, identity, workerVersionId);
  return { pair, read: reader.read, codeSnapshot: pairOwnerCodeSnapshotReader({ projectId: target.projectId, token, decode: fields, request }),
    ...pairOwnerEvidenceClient({ projectId: target.projectId, token, pair, decode: fields, request }) };
}
