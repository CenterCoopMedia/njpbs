import type { PairWakeIdentity } from "./release-pair-wake";
import { accessToken, jsonResponse } from "./pending-work";
import { pairFirestoreReader, readPrivatePairRecord, decodePairEvidenceFields } from "./pair-work-reader";
import targets from "../functions/lib/publication-target.js";

const RECEIPTS = new Set(["cmsDeploymentReceipts/functions", "cmsReaderCompatibilityReceipts/functions"]);
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Bootstrap receipt read refused");
  return value as Record<string, unknown>;
}
/** Full original receipts include the per-export graph (currently 161 entries).
 * Keep the ordinary observer's decode bounds unchanged. Only this separately
 * constructed bootstrap reader accepts the larger, still bounded receipt. */
export function decodeBootstrapReceiptFields(value: unknown): Record<string, unknown> {
  let nodes = 0;
  const fields = (raw: unknown, depth: number): Record<string, unknown> => {
    const source = record(raw);
    if (depth > 16 || Object.keys(source).length > 512) throw new Error("Bootstrap receipt read exceeds bounds");
    return Object.fromEntries(Object.entries(source).map(([key, wire]) => {
      if (++nodes > 20_000) throw new Error("Bootstrap receipt read exceeds bounds");
      const item = record(wire);
      if (item.mapValue) return [key, fields(record(item.mapValue).fields ?? {}, depth + 1)];
      if (item.arrayValue) {
        const values = record(item.arrayValue).values ?? [];
        if (!Array.isArray(values) || values.length > 100 || depth >= 16) throw new Error("Bootstrap receipt read exceeds bounds");
        return [key, values.map(value => fields({ value }, depth + 1).value)];
      }
      return [key, decodePairEvidenceFields({ value: wire }).value];
    }));
  };
  return fields(value, 0);
}

/** Only a bootstrap operator constructs this authority. There is no flag,
 * deployed caller or change to privatePairReader/read/due. Credentials are
 * acquired at construction/use through the existing workload-token owner. */
export async function privateBootstrapProofReader({ account, identity, workerVersionId, request = fetch }: {
  account: string; identity: PairWakeIdentity; workerVersionId: string; request?: typeof fetch;
}) {
  const target = targets.publicationTarget(identity.environment), token = await accessToken(account, request, target.projectId);
  const reader = pairFirestoreReader({ projectId: target.projectId, token, request });
  const pair = await readPrivatePairRecord(reader, identity, workerVersionId);
  const resource = `projects/${target.projectId}/databases/(default)/documents`;
  return { pair, async read(path: string): Promise<Record<string, unknown> | null> {
    if (!RECEIPTS.has(path)) return reader.read(path);
    const response = await request(`https://firestore.googleapis.com/v1/${resource}/${path}`, {
      headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (response.status === 404) { await response.body?.cancel(); return null; }
    const document = record(await jsonResponse(response, 2 * 1024 * 1024));
    if (document.name !== `${resource}/${path}`) throw new Error("Bootstrap receipt owner differs");
    return decodeBootstrapReceiptFields(document.fields ?? {});
  } };
}
