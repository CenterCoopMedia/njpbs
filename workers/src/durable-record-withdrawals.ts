import { isServerMintableSlugShape } from "../../packages/content-core/src/post-slugs";
import { WITHDRAWAL_MANIFEST_BYTES, WITHDRAWAL_MANIFEST_POSTS, WITHDRAWAL_MANIFEST_SLUGS,
  readWithdrawalValue, readKnownDurableWithdrawal, type WithdrawalObject, type WithdrawalReader } from "./durable-post-withdrawals";

export type RecordFamily = "programs" | "events";
export type RecordWithdrawal = { recordId: string; family: RecordFamily; operationId: string; sourceVersion: number;
  revision: number; ownedPaths: string[]; verifiedAt: number };
export type RecordWithdrawalManifest = { schemaVersion: 1; workerName: string; contextRevision: number;
  families: RecordFamily[]; withdrawals: RecordWithdrawal[] };
export type RecordRouteAuthority = { owned: boolean; withdrawal: RecordWithdrawal | null };
const families: RecordFamily[] = ["programs", "events"];
function refuse(): never { throw new Error("Durable record withdrawal manifest is invalid or exceeds its limit"); }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exact(value: Record<string, unknown>, keys: string[]) { return Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key)); }
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0; }
export function publicRecordFamily(path: string): RecordFamily | null {
  return /^\/(programs|shows)(?:\/|$)/.test(path) ? "programs" : /^\/events(?:\/|$)/.test(path) ? "events" : null;
}
export function recordWithdrawalManifestKey(workerName: string): string {
  if (!["njpbs-production", "template-dev-public"].includes(workerName)) refuse();
  return `record-withdrawals/${workerName}/catalog-v1.json`;
}
export function validateRecordWithdrawalManifest(value: unknown, workerName: string): RecordWithdrawalManifest {
  recordWithdrawalManifestKey(workerName);
  if (!object(value) || !exact(value, ["schemaVersion", "workerName", "contextRevision", "families", "withdrawals"]) ||
      value.schemaVersion !== 1 || value.workerName !== workerName || !positive(value.contextRevision) ||
      !Array.isArray(value.families) || JSON.stringify(value.families) !== JSON.stringify(families.filter(family => (value.families as unknown[]).includes(family))) ||
      !Array.isArray(value.withdrawals) || value.withdrawals.length > WITHDRAWAL_MANIFEST_POSTS) refuse();
  const ownedFamilies = value.families as RecordFamily[], ids = new Set<string>(), paths = new Set<string>();
  const withdrawals = value.withdrawals.map(raw => {
    if (!object(raw) || !exact(raw, ["recordId", "family", "operationId", "sourceVersion", "revision", "ownedPaths", "verifiedAt"]) ||
        typeof raw.recordId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(raw.recordId) || ids.has(raw.recordId) ||
        !ownedFamilies.includes(raw.family as RecordFamily) || typeof raw.operationId !== "string" || !/^[A-Za-z0-9]{20}$/.test(raw.operationId) ||
        !positive(raw.sourceVersion) || !positive(raw.revision) || !positive(raw.verifiedAt) ||
        !Array.isArray(raw.ownedPaths) || !raw.ownedPaths.length || raw.ownedPaths.length > (raw.family === "programs" ? 202 : 101)) refuse();
    ids.add(raw.recordId);
    const ownedPaths = raw.ownedPaths.map(path => {
      if (typeof path !== "string" || publicRecordFamily(path) !== raw.family || paths.has(path) ||
          !isServerMintableSlugShape(/^\/(?:programs|shows|events)\/([^/]+)\/$/.exec(path)?.[1] ?? "")) refuse();
      paths.add(path);
      if (paths.size > WITHDRAWAL_MANIFEST_SLUGS) refuse();
      return path;
    }).sort();
    return { recordId: raw.recordId, family: raw.family, operationId: raw.operationId, sourceVersion: raw.sourceVersion,
      revision: raw.revision, ownedPaths, verifiedAt: raw.verifiedAt } as RecordWithdrawal;
  }).sort((a, b) => a.recordId.localeCompare(b.recordId));
  return { schemaVersion: 1, workerName, contextRevision: value.contextRevision, families: ownedFamilies, withdrawals };
}
export function encodeRecordWithdrawalManifest(value: unknown, workerName: string): string {
  const text = JSON.stringify(validateRecordWithdrawalManifest(value, workerName));
  if (new TextEncoder().encode(text).byteLength > WITHDRAWAL_MANIFEST_BYTES) refuse();
  return text;
}
export async function readRecordWithdrawalObject(object: WithdrawalObject, workerName: string, signal?: AbortSignal): Promise<RecordWithdrawalManifest> {
  return validateRecordWithdrawalManifest(await readWithdrawalValue(object, signal), workerName);
}
/** Missing storage reads as null and a missing catalog as unowned; an absent
 * catalog cannot start a private RPC. A present but unreadable catalog, an R2
 * error or a timeout rejects. A known tombstone is retained by its request's caller. */
export async function readDurableRecordAuthority(store: WithdrawalReader | undefined, workerName: string, path: string): Promise<RecordRouteAuthority | null> {
  const family = publicRecordFamily(path);
  if (!family) return null;
  return readKnownDurableWithdrawal(store, async (reader, signal) => {
    const object = await reader.get(recordWithdrawalManifestKey(workerName));
    if (!object) return { owned: false, withdrawal: null };
    const manifest = await readRecordWithdrawalObject(object, workerName, signal);
    return { owned: manifest.families.includes(family), withdrawal: manifest.withdrawals.find(entry => entry.ownedPaths.includes(path)) ?? null };
  });
}
