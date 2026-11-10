import mirrors from "../../functions/lib/public-release-routing-mirror-codec.js";
import protocol from "../../functions/lib/public-release-pair.js";
import { readPublicReleasePairOutput } from "./public-release-view-reader";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import { bytesDigest, canonicalReleaseValue, matchesSelectedPair, originFor, parseSelectorReceipt, releaseDigest,
  ROOT_RECEIPT_PATH, type SelectorReceipt } from "../../packages/content-core/src/public-release-routing";
import { pairArtifactResponse, readIndexedPairOutput, readPairCodeAssetIndex, readPairLifecycle, readRoutingRecord, routingPrefix } from "./public-release-code-assets";
import type { PairReadStore } from "./public-release-view-reader";

function fail(): never { throw new Error("Durable public recovery is unavailable"); }
const exact = (value: any, keys: string[]) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
export const committedRecoveryKey = (environment: SelectorReceipt["environment"]) => `public-release-routing/${environment}/committed-v2.json`;
export const RECOVERY_RECORD_LIFETIME_MS = 24 * 60 * 60 * 1000;
export type RecoveryRoute = Readonly<{ path: string; state: "fallback" | "gone" | "redirect"; canonicalPath: string; body?: import("../../functions/lib/public-release-routing-mirror-codec").RoutingMirrorBody | null }>;
export type RecoveryNamespace = Readonly<{ schemaVersion: 1 | 2; pairDigest: string; revision: number; validUntil: number;
  routes: readonly RecoveryRoute[] }>;
export type RoutingWriteStore = Omit<PairReadStore, "get"> & {
  get(key: string): Promise<(NonNullable<Awaited<ReturnType<PairReadStore["get"]>>> & { etag: string }) | null>;
  put(key: string, body: Uint8Array, options: { onlyIf: { etagMatches: string } | { etagDoesNotMatch: "*" };
    customMetadata: Record<string, string> }): Promise<unknown | null>;
};
function parseRecoveryNamespace(value: any, pairDigest: string, now: number, pair?: PublicReleasePair): RecoveryNamespace {
  if (value?.schemaVersion === 2 && pair) return mirrors.parseNamespace(value, pair, now);
  if (!exact(value, ["schemaVersion", "pairDigest", "revision", "validUntil", "routes"]) || value.schemaVersion !== 1 ||
      value.pairDigest !== pairDigest || !Number.isSafeInteger(value.revision) || value.revision < 1 ||
      !Number.isSafeInteger(value.validUntil) || value.validUntil <= now || !Array.isArray(value.routes) || value.routes.length > 100_000) fail();
  let previous = "";
  for (const route of value.routes) {
    if (!exact(route, ["path", "state", "canonicalPath"]) || typeof route.path !== "string" ||
        !/^\/(?:[A-Za-z0-9._~-]+\/)*$/.test(route.path) || route.path.split("/").some((part: string) => [".", ".."].includes(part)) ||
        route.path <= previous || !["fallback", "gone", "redirect"].includes(route.state) || typeof route.canonicalPath !== "string" ||
        !/^\/(?:[A-Za-z0-9._~-]+\/)*$/.test(route.canonicalPath) || route.canonicalPath.split("/").some((part: string) => [".", ".."].includes(part)) ||
        route.state === "redirect" && route.canonicalPath === route.path) fail();
    previous = route.path;
  }
  return value;
}
export async function readCommittedPairRecovery({ store, environment, pairs, now = Date.now }: {
  store: PairReadStore; environment: SelectorReceipt["environment"]; pairs: readonly PublicReleasePair[]; now?: () => number;
}): Promise<SelectorReceipt> {
  const value = await readRoutingRecord(store, committedRecoveryKey(environment), 64 * 1024);
  if (!exact(value, ["schemaVersion", "selection", "selectorDigest", "capturedAt", "validUntil"]) || value.schemaVersion !== 2 ||
      !Number.isSafeInteger(value.capturedAt) || !Number.isSafeInteger(value.validUntil) || value.capturedAt > now() ||
      value.validUntil <= now() || value.validUntil - value.capturedAt > RECOVERY_RECORD_LIFETIME_MS) fail();
  const selection = parseSelectorReceipt(value.selection, environment);
  if (await releaseDigest(selection.selector) !== value.selectorDigest || !pairs.some(pair => matchesSelectedPair(pair, selection))) fail();
  return selection;
}
/** Explicit private post-commit capture. Fresh authority is checked on both
 * sides; a candidate, stale writer or lost conditional write cannot win. This
 * writes advisory recovery only and never changes the selector or a capability. */
export async function recordCommittedPairRecovery({ store, environment, pairs, readSelector, now = Date.now }: {
  store: RoutingWriteStore; environment: SelectorReceipt["environment"]; pairs: readonly PublicReleasePair[];
  readSelector(): Promise<SelectorReceipt>; now?: () => number;
}): Promise<void> {
  const selection = parseSelectorReceipt(await readSelector(), environment);
  const pair = pairs.find(pair => matchesSelectedPair(pair, selection)); if (!pair) fail();
  const lifecycle = await readPairLifecycle(store, pair, now); if (lifecycle.status !== "retained") fail();
  await readPairCodeAssetIndex(store, pair);
  const key = committedRecoveryKey(environment), existing = await store.get(key);
  let etag: string | undefined;
  if (existing) {
    etag = existing.etag; await existing.body.cancel();
    // Expiry and configured pair membership constrain serving, not replacing
    // an old advisory record after a valid new committed authority read.
    const priorRecord = await readRoutingRecord(store, key, 64 * 1024);
    const prior = parseSelectorReceipt(priorRecord.selection, environment);
    if (priorRecord.schemaVersion !== 2 || priorRecord.selectorDigest !== await releaseDigest(prior.selector)) fail();
    if (prior.selector.epoch > selection.selector.epoch || prior.selector.epoch === selection.selector.epoch &&
        prior.selector.contentHead.contextSequence > selection.selector.contentHead.contextSequence) fail();
  }
  const after = parseSelectorReceipt(await readSelector(), environment);
  if (canonicalReleaseValue(selection.selector) !== canonicalReleaseValue(after.selector) ||
      canonicalReleaseValue(lifecycle) !== canonicalReleaseValue(await readPairLifecycle(store, pair, now))) fail();
  const capturedAt = now(), body = new TextEncoder().encode(canonicalReleaseValue({ schemaVersion: 2, selection: after,
    selectorDigest: await releaseDigest(after.selector), capturedAt, validUntil: capturedAt + RECOVERY_RECORD_LIFETIME_MS }));
  const written = await store.put(key, body, { onlyIf: etag ? { etagMatches: etag } : { etagDoesNotMatch: "*" },
    customMetadata: { schemaversion: "2", bodydigest: await bytesDigest(body) } });
  if (!written) fail();
  const readback = await readCommittedPairRecovery({ store, environment, pairs, now });
  if (canonicalReleaseValue(readback) !== canonicalReleaseValue(after)) fail();
}
/** Real R2 recovery path for both warm and cold isolates. The current durable
 * route list is an exact whitelist, never a namespace wildcard. It is written
 * by the withdrawal/ownership owner before that owner acknowledges the change. */
export async function serveCommittedPairRecovery({ store, pairs, request, selection, now = Date.now }: {
  store: PairReadStore; pairs: readonly PublicReleasePair[]; request: Request; selection: SelectorReceipt; now?: () => number;
}): Promise<Response | null> {
  const pair = pairs.find(pair => matchesSelectedPair(pair, selection)); if (!pair) fail();
  return serveRecoveryInPair({ store, pair, request, selection, now, minimumBodySequence: selection.selector.contentHead.contextSequence });
}
/** Explicit degraded read: actual current namespace/tombstones remain fenced,
 * while the last byte-verified body may lag activation until its ORIGINAL
 * lease expires. This never returns editorial evidence or a root receipt. */
export async function servePreviousVerifiedPairRecovery({ store, pairs, request, selection: raw, now = Date.now }: {
  store: PairReadStore; pairs: readonly PublicReleasePair[]; request: Request; selection: SelectorReceipt; now?: () => number;
}): Promise<Response | null> {
  const selection = parseSelectorReceipt(raw, raw.environment);
  if (!pairs.some(pair=>matchesSelectedPair(pair,selection))) return null;
  let selectedFence: {pair:PublicReleasePair;authority:RecoveryNamespace;lifecycle:unknown}|undefined;
  for (const reference of [selection.selector.selectedPair, selection.selector.recoveryPair]) {
    const pair = pairs.find(value => value.environment === selection.environment &&
      canonicalReleaseValue(protocol.publicReleasePairReference(value)) === canonicalReleaseValue(reference));
    if (!pair) continue;
    try {
      let ownFence: typeof selectedFence;
      const response = await serveRecoveryInPair({ store, pair, request, selection, now, minimumBodySequence: 0,
        onFence: (authority,lifecycle) => { ownFence={pair,authority,lifecycle}; } });
      if (!selectedFence) {
        // Only an explicit current whitelist entry without an available body
        // permits OLD. Missing/corrupt/changed authority is a refusal.
        if (response) return response;
        const route=ownFence?.authority.routes.find(value=>value.path===new URL(request.url).pathname);
        if (!ownFence || route?.state!=="fallback") return null;
        selectedFence=ownFence;continue;
      }
      const retainedRoute=ownFence?.authority.routes.find(value=>value.path===new URL(request.url).pathname);
      // OLD may supply bytes only. Its code-specific tombstone or redirect
      // cannot override the selected authority's explicit live fallback.
      if (!response || !ownFence || retainedRoute?.state!=="fallback" || ownFence.authority.revision<selectedFence.authority.revision) return null;
      // Cross-pair writes are sequential. A selected-side tombstone arriving
      // during the OLD byte read must still fence the final response.
      const lifecycle=await readPairLifecycle(store,selectedFence.pair,now);
      const authority=parseRecoveryNamespace(await readRoutingRecord(store,`${routingPrefix(selectedFence.pair)}namespace-v1.json`),
        await releaseDigest(selectedFence.pair),now(),selectedFence.pair);
      if (canonicalReleaseValue(lifecycle)!==canonicalReleaseValue(selectedFence.lifecycle)||
          canonicalReleaseValue(authority)!==canonicalReleaseValue(selectedFence.authority)) return null;
      return response;
    } catch { return null; }
  }
  return null;
}
async function serveRecoveryInPair({ store, pair, request, selection, now, minimumBodySequence, onFence }: {
  store: PairReadStore; pair: PublicReleasePair; request: Request; selection: SelectorReceipt; now: () => number; minimumBodySequence: number;
  onFence?:(authority:RecoveryNamespace,lifecycle:unknown)=>void;
}): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.origin !== originFor(pair.environment) || !["GET", "HEAD"].includes(request.method) || url.pathname === ROOT_RECEIPT_PATH) fail();
  const lifecycle = await readPairLifecycle(store, pair, now); if (lifecycle.status !== "retained") fail();
  const namespaceKey = `${routingPrefix(pair)}namespace-v1.json`;
  const authority = parseRecoveryNamespace(await readRoutingRecord(store, namespaceKey), lifecycle.pairDigest, now(), pair);
  if (authority.revision <= selection.selector.contentHead.contextSequence) fail();
  onFence?.(authority,lifecycle);
  const route = authority.routes.find(route => route.path === url.pathname); if (!route) return null;
  let response: Response;
  if (route.state === "gone" || route.state === "redirect") {
    response = new Response(null, { status: route.state === "gone" ? 410 : 308,
      headers: { ...(route.state === "redirect" ? { location: route.canonicalPath } : {}), "cache-control": "no-store" } });
  } else if (authority.schemaVersion === 2) {
    const body = route.body;
    if (!body || body.validUntil <= now() || body.verifiedSequence < minimumBodySequence) return null;
    const output = await readPublicReleasePairOutput({ store, pair, locator: body.locator, path: body.artifactPath });
    if (!output || output.status !== 200 || output.bodyDigest !== body.bodyDigest || output.bytes !== body.bytes || output.headers["content-type"] !== body.mime) fail();
    response = pairArtifactResponse(request, output.body, output.bodyDigest, output.headers);
  } else {
    const index = await readPairCodeAssetIndex(store, pair);
    const member = index.members.find(member => member.path === `${url.pathname}index.html`);
    if (!member || member.dynamic || member.family !== "fallbackAsset") return null;
    const output = await readIndexedPairOutput(store, pair, index, member);
    response = pairArtifactResponse(request, output.body, output.bodyDigest, output.headers);
  }
  if (canonicalReleaseValue(authority) !== canonicalReleaseValue(parseRecoveryNamespace(await readRoutingRecord(store, namespaceKey), lifecycle.pairDigest, now(), pair)) ||
      canonicalReleaseValue(lifecycle) !== canonicalReleaseValue(await readPairLifecycle(store, pair, now))) fail();
  response.headers.set("publication-refresh", "pending");
  return response;
}
