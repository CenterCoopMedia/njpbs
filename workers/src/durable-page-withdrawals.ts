import { isPublicPageId, isPublicPagePath, isCustomPageId, publicPage, PUBLIC_PAGE_IDS } from "../../packages/content-core/src/public-pages";
import { WITHDRAWAL_MANIFEST_BYTES, WITHDRAWAL_MANIFEST_POSTS, WITHDRAWAL_MANIFEST_SLUGS,
  readWithdrawalValue, readKnownDurableWithdrawal, type WithdrawalObject, type WithdrawalReader } from "./durable-post-withdrawals";

export type PageWithdrawal = {
  pageId: string; operationId: string; sourceVersion: number; revision: number;
  ownedPaths: string[]; verifiedAt: number;
};
export type PageWithdrawalManifest = {
  schemaVersion: 1; workerName: string; contextRevision: number; withdrawals: PageWithdrawal[];
};
function refuse(): never { throw new Error("Durable Page withdrawal manifest is invalid or exceeds its limit"); }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
}
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0; }
export function pageWithdrawalManifestKey(workerName: string): string {
  if (!["template-dev-public", "njpbs-production"].includes(workerName)) refuse();
  return `page-withdrawals/${workerName}/catalog-v1.json`;
}
// A custom Page can own any available slug that no built-in Page owns.
const WITHDRAWABLE_PAGE_IDS = [...PUBLIC_PAGE_IDS.filter(id => id !== "home"), `page-${"0".repeat(32)}`];
/** Only paths that some withdrawable Page could own can carry a withdrawal. */
function withdrawablePagePath(path: string): boolean {
  return WITHDRAWABLE_PAGE_IDS.some(id => isPublicPagePath(id, path));
}
export function validatePageWithdrawalManifest(value: unknown, workerName: string): PageWithdrawalManifest {
  pageWithdrawalManifestKey(workerName);
  if (!record(value) || !exact(value, ["schemaVersion", "workerName", "contextRevision", "withdrawals"]) ||
      value.schemaVersion !== 1 || value.workerName !== workerName || !positive(value.contextRevision) ||
      !Array.isArray(value.withdrawals) || value.withdrawals.length > WITHDRAWAL_MANIFEST_POSTS) refuse();
  const pages = new Set<string>(), paths = new Set<string>();
  const withdrawals = value.withdrawals.map(raw => {
    if (!record(raw) || !exact(raw, ["pageId", "operationId", "sourceVersion", "revision", "ownedPaths", "verifiedAt"]) ||
        typeof raw.pageId !== "string" || !isPublicPageId(raw.pageId) || raw.pageId === "home" || pages.has(raw.pageId) ||
        typeof raw.operationId !== "string" || !/^[A-Za-z0-9]{20}$/.test(raw.operationId) ||
        !positive(raw.sourceVersion) || !positive(raw.revision) || !positive(raw.verifiedAt) ||
        !Array.isArray(raw.ownedPaths) || !raw.ownedPaths.length ||
        raw.ownedPaths.length > (isCustomPageId(raw.pageId) ? 101 : 102 + (publicPage(raw.pageId)?.aliases?.length ?? 0))) refuse();
    const pageId = raw.pageId;
    pages.add(pageId);
    const ownedPaths = raw.ownedPaths.map(path => {
      if (!isPublicPagePath(pageId, path) || paths.has(path)) refuse();
      paths.add(path);
      if (paths.size > WITHDRAWAL_MANIFEST_SLUGS) refuse();
      return path;
    }).sort();
    return { pageId, operationId: raw.operationId, sourceVersion: raw.sourceVersion, revision: raw.revision,
      ownedPaths, verifiedAt: raw.verifiedAt } as PageWithdrawal;
  }).sort((left, right) => left.pageId < right.pageId ? -1 : left.pageId > right.pageId ? 1 : 0);
  return { schemaVersion: 1, workerName, contextRevision: value.contextRevision, withdrawals };
}
export function encodePageWithdrawalManifest(value: unknown, workerName: string): string {
  const text = JSON.stringify(validatePageWithdrawalManifest(value, workerName));
  if (new TextEncoder().encode(text).byteLength > WITHDRAWAL_MANIFEST_BYTES) refuse();
  return text;
}
export async function readPageWithdrawalObject(object: WithdrawalObject, workerName: string,
  signal?: AbortSignal): Promise<PageWithdrawalManifest> {
  return validatePageWithdrawalManifest(await readWithdrawalValue(object, signal), workerName);
}
/** Missing storage, a missing catalog or a path no Page can own reads as no withdrawal. A present but
 * unreadable catalog, an R2 error or a timeout rejects: withdrawal state is unknown. */
export async function readDurablePageWithdrawal(store: WithdrawalReader | undefined, workerName: string,
  path: string): Promise<PageWithdrawal | null> {
  if (!withdrawablePagePath(path)) return null;
  return readKnownDurableWithdrawal(store, async (reader, signal) => {
    const object = await reader.get(pageWithdrawalManifestKey(workerName));
    if (!object) return null;
    const manifest = await readPageWithdrawalObject(object, workerName, signal);
    return manifest.withdrawals.find(entry => entry.ownedPaths.includes(path)) ?? null;
  });
}
