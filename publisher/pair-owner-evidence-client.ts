import { terminalEvidenceReader } from "./pair-terminal-evidence-reader";
import type { PublicReleasePair } from "../packages/content-core/src/public-release";
import protocol from "../functions/lib/public-release-pair.js";
import work from "../functions/lib/public-release-pair-work.js";
import { jsonResponse } from "./pending-work";
import { ownerReplayPageEvidencePath, parseOwnerReplayPageEvidence, type OwnerReplayPageEvidence } from "./pair-owner-page-evidence";

/** Only the private owner-write binding constructs this client. No generic
 * mutation is exposed: the one create-only path stores verified page evidence.
 */
export function pairOwnerEvidenceClient({ projectId, token, pair, decode, request = fetch }: {
  projectId: string; token: string; pair: PublicReleasePair;
  decode(value: unknown): Record<string, unknown>; request?: typeof fetch;
}) {
  if (!/^[a-z][a-z0-9-]{1,62}$/.test(projectId)) throw new Error("Invalid private evidence project");
  const resource = `projects/${projectId}/databases/(default)/documents`, base = `https://firestore.googleapis.com/v1/${resource}`;
  const prefix = `${work.publicReleasePairPath(pair.pairId)}/`;
  const allowed = (path: string) => typeof path === "string" && path.startsWith(prefix) &&
    /^(views|receipts|work|ownerReplayPages)\/[a-f0-9]{64}$/.test(path.slice(prefix.length));
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const readMany = async (paths: string[]) => {
    if (!Array.isArray(paths) || paths.length < 1 || paths.length > 768 || new Set(paths).size !== paths.length || paths.some(path => !allowed(path)))
      throw new Error("Invalid private evidence batch");
    const found = new Map<string, Record<string, unknown> | null>();
    for (let offset = 0; offset < paths.length; offset += 64) {
      const batch = paths.slice(offset, offset + 64), expected = new Set(batch.map(path => `${resource}/${path}`));
      const response = await request(`${base}:batchGet`, { method: "POST", headers, redirect: "error", signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({ documents: [...expected] }) });
      const rows = await jsonResponse(response, 2 * 1024 * 1024);
      if (!Array.isArray(rows) || rows.length !== batch.length) throw new Error("Private evidence batch differs");
      for (const row of rows) {
        const name = row?.found?.name ?? row?.missing;
        if (typeof name !== "string" || !expected.delete(name)) throw new Error("Private evidence document differs");
        found.set(name.slice(resource.length + 1), row.found ? decode(row.found.fields ?? {}) : null);
      }
      if (expected.size) throw new Error("Private evidence batch is incomplete");
    }
    return paths.map(path => found.get(path)!);
  };
  const encode = (raw: unknown): unknown => {
    if (typeof raw === "string") return { stringValue: raw };
    if (typeof raw === "number" && Number.isSafeInteger(raw)) return { integerValue: String(raw) };
    if (raw && typeof raw === "object" && !Array.isArray(raw))
      return { mapValue: { fields: Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, encode(value)])) } };
    throw new Error("Invalid private evidence value");
  };
  return { readMany, readTerminalEvidence: terminalEvidenceReader({ projectId, token, request }),
    async createPageEvidence(raw: OwnerReplayPageEvidence) {
      const receipt = parseOwnerReplayPageEvidence(raw, pair), path = ownerReplayPageEvidencePath(pair, receipt.pageDigest);
      try {
        const response = await request(`${base}:commit`, { method: "POST", headers, redirect: "error", signal: AbortSignal.timeout(10_000),
          body: JSON.stringify({ writes: [{ update: { name: `${resource}/${path}`,
            fields: (encode(receipt) as { mapValue: { fields: unknown } }).mapValue.fields }, currentDocument: { exists: false } }] }) });
        await response.body?.cancel();
      } catch { /* An uncertain create is resolved only by exact readback. */ }
      const [stored] = await readMany([path]);
      if (protocol.publicReleaseDigest(parseOwnerReplayPageEvidence(stored, pair)) !== protocol.publicReleaseDigest(receipt))
        throw new Error("Private evidence retry differs");
    },
  };
}
