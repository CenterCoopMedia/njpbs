import type { PublicReleasePair, PublicReleaseSelector } from "./public-release";

export type SelectorReceipt = Readonly<{
  environment: "production" | "development";
  selector: PublicReleaseSelector;
  /** Server read start, for bounded retained-request validation at the origin. */
  readStartedAt: number;
}>;
export const ROUTING_FRESH_MS = 5_000;
export const AUTHORITY_BUDGET_MS = 3_000;
export const ROOT_RECEIPT_PATH = "/_publication-v2.json";
export const originFor = (environment: SelectorReceipt["environment"]) => environment === "production" ? "https://njpbs.org" : "https://dev-public.example.org";
const digestPattern = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const identifier = /^(?!__.*__$)[a-zA-Z0-9._:-]{1,128}$/;
const positive = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;
function refuse(): never { throw new Error("Public release authority is unavailable"); }
function exact(value: unknown, fields: string[]): asserts value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== fields.length ||
      fields.some(key => !Object.hasOwn(value, key))) refuse();
}
function reference(value: unknown) {
  exact(value, ["pairId", "commitSha", "publicWorkerVersionId"]);
  const parts = typeof value.pairId === "string" ? value.pairId.split(":") : [];
  if (parts.length !== 2 || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(parts[0]) || !uuid.test(parts[1]) || !identifier.test(value.pairId) ||
      typeof value.commitSha !== "string" || !/^[a-f0-9]{40}$/.test(value.commitSha) ||
      typeof value.publicWorkerVersionId !== "string" || !uuid.test(value.publicWorkerVersionId)) refuse();
}
/** Worker-safe strict reader. Writers retain the separate Node protocol parser. */
export function parseSelectorReceipt(value: unknown, environment: SelectorReceipt["environment"]): SelectorReceipt {
  exact(value, ["environment", "selector", "readStartedAt"]);
  if (value.environment !== environment || !positive(value.readStartedAt)) refuse();
  const selector = value.selector;
  exact(selector, ["schemaVersion", "state", "mediaLifecycleReady", "epoch", "activeGeneration", "activeDeploymentId", "activeCommitSha",
    "lastReservedGeneration", "newestEligibleGeneration", "newestEligibleBuildBatchId", "selectedPair", "recoveryPair", "contentHead",
    "admittedContractDigest", "priorSelectorDigest", "switchOperationId", "proofDigest"]);
  reference(selector.selectedPair); reference(selector.recoveryPair);
  exact(selector.contentHead, ["pairId", "viewId", "manifestDigest", "contextSequence"]);
  if (selector.schemaVersion !== 2 || selector.state !== "idle" || selector.mediaLifecycleReady !== true ||
      !positive(selector.epoch) || !positive(selector.activeGeneration) ||
      selector.lastReservedGeneration !== selector.activeGeneration || selector.newestEligibleGeneration !== selector.activeGeneration ||
      selector.activeCommitSha !== selector.selectedPair.commitSha || selector.contentHead.pairId !== selector.selectedPair.pairId ||
      selector.selectedPair.pairId === selector.recoveryPair.pairId ||
      selector.selectedPair.publicWorkerVersionId === selector.recoveryPair.publicWorkerVersionId ||
      ![selector.activeDeploymentId, selector.newestEligibleBuildBatchId, selector.switchOperationId, selector.contentHead.viewId].every(v => typeof v === "string" && identifier.test(v)) ||
      ![selector.admittedContractDigest, selector.priorSelectorDigest, selector.proofDigest, selector.contentHead.manifestDigest].every(v => typeof v === "string" && digestPattern.test(v)) ||
      !Number.isSafeInteger(selector.contentHead.contextSequence) || selector.contentHead.contextSequence < 0) refuse();
  // RPC and caller-owned objects must not mutate a cached authority record.
  return freeze(JSON.parse(JSON.stringify(value))) as SelectorReceipt;
}
function freeze(value: any): any {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
export function canonicalReleaseValue(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonicalReleaseValue).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalReleaseValue(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export async function releaseDigest(value: unknown): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new TextEncoder().encode(canonicalReleaseValue(value));
  return bytesDigest(bytes);
}
export async function bytesDigest(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)), byte => byte.toString(16).padStart(2, "0")).join("");
}
/** No viewer-supplied identity, proof or legacy receipt crosses the trust boundary. */
export function stripInternalHeaders(input: Headers): Headers {
  const headers = new Headers(input);
  for (const name of [...headers.keys()]) if (name.startsWith("x-njpbs-") || name === "publication-refresh") headers.delete(name);
  return headers;
}
export function matchesSelectedPair(pair: PublicReleasePair, receipt: SelectorReceipt): boolean {
  const selected = receipt.selector.selectedPair;
  return pair.environment === receipt.environment && pair.pairId === selected.pairId && pair.commitSha === selected.commitSha &&
    pair.publicWorker.versionId === selected.publicWorkerVersionId && pair.pairId === `${pair.publicWorker.service}:${pair.publicWorker.incarnation}`;
}
/** Includes identity even for negatives, aliases, Assets and range/conditional replies. */
export async function responseCacheKey(receipt: SelectorReceipt, request: Request): Promise<string> {
  return releaseDigest({ environment: receipt.environment, epoch: receipt.selector.epoch,
    pair: receipt.selector.selectedPair, contentHead: receipt.selector.contentHead,
    url: request.url, method: request.method, headers: Array.from(stripInternalHeaders(request.headers).entries()).sort() });
}
