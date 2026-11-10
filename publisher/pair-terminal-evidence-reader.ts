import { jsonResponse } from "./pending-work";

// Canonical/coverage facts may contain 750,000 decoded JSON bytes. Firestore's
// typed REST encoding expands small scalar values; bound the wire separately.
export const TERMINAL_EVIDENCE_WIRE_BYTES = 8 * 1024 * 1024;
const ARRAY_LIMIT = 100_000, VALUE_LIMIT = 200_000;
function refuse(): never { throw new Error("Invalid private terminal evidence"); }
function record(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return refuse();
  return value as Record<string, any>;
}
function decodeFields(raw: unknown) {
  let values = 0;
  const fields = (raw: unknown, depth: number): Record<string, unknown> => {
    const source = record(raw);
    if (depth > 16 || Object.keys(source).length > 128) refuse();
    return Object.fromEntries(Object.entries(source).map(([key, value]) => [key, decode(value, depth)]));
  };
  const decode = (raw: unknown, depth: number): unknown => {
    if (++values > VALUE_LIMIT) refuse();
    const item = record(raw);
    if (Object.keys(item).length !== 1) refuse();
    if (Object.hasOwn(item, "nullValue") && [null, "NULL_VALUE"].includes(item.nullValue)) return null;
    if (typeof item.stringValue === "string") return item.stringValue;
    if (typeof item.booleanValue === "boolean") return item.booleanValue;
    if (typeof item.integerValue === "string" && /^-?\d+$/.test(item.integerValue) && Number.isSafeInteger(Number(item.integerValue)))
      return Number(item.integerValue);
    if (item.mapValue) return fields(record(item.mapValue).fields ?? {}, depth + 1);
    if (item.arrayValue) {
      const array = record(item.arrayValue).values ?? [];
      if (depth >= 16 || !Array.isArray(array) || array.length > ARRAY_LIMIT) refuse();
      return array.map(value => decode(value, depth + 1));
    }
    if (typeof item.timestampValue === "string" && Number.isFinite(Date.parse(item.timestampValue))) {
      const millis = Date.parse(item.timestampValue); return { toMillis: () => millis };
    }
    return refuse();
  };
  return fields(raw, 0);
}

/** Private FACT verification only. Observer/work readers keep their original
 * 64 KiB/100-element bounds. This client exposes no mutation or generic path. */
export function terminalEvidenceReader({ projectId, token, request = fetch }: {
  projectId: string; token: string; request?: typeof fetch;
}) {
  if (!/^[a-z][a-z0-9-]{1,62}$/.test(projectId)) refuse();
  const resource = `projects/${projectId}/databases/(default)/documents`;
  const allowed = (path: string) =>
    /^system\/publicReleaseAdmissions\/(operations|pending|terminalReceipts)\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(path) ||
    /^cmsPublishQueue\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(path) ||
    /^system\/publicReleaseAdmissions\/(coverageProofs|canonicalProofs|inclusionProofs|inclusionPages)\/[a-f0-9]{64}$/.test(path) ||
    /^system\/publicReleasePairs\/entries\/[a-f0-9]{64}$/.test(path);
  return async (path: string): Promise<Record<string, unknown> | null> => {
    if (typeof path !== "string" || !allowed(path)) refuse();
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    const response = await request(`https://firestore.googleapis.com/v1/${resource}/${encoded}`, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      redirect: "error", signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404) { await response.body?.cancel(); return null; }
    const document = record(await jsonResponse(response, TERMINAL_EVIDENCE_WIRE_BYTES));
    if (document.name !== `${resource}/${path}`) refuse();
    return decodeFields(document.fields ?? {});
  };
}
