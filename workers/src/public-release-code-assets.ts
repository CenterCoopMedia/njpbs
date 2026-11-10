import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { PairViewLocator } from "../../functions/lib/public-release-serving";
import { bytesDigest, canonicalReleaseValue, stripInternalHeaders } from "../../packages/content-core/src/public-release-routing";
import { readBoundedPairObject, readPublicReleasePairOutput, type PairReadStore } from "./public-release-view-reader";
import protocol from "../../functions/lib/public-release-pair.js";
import view from "../../functions/lib/public-release-pair-view.js";
import { SECURITY_HEADER_BASELINE } from "../../packages/content-core/src/public-security-headers";

export type PairCodeMember = Readonly<{ path: string; mime: string; size: number; sha256: string;
  family: string; source: "compiled" | "static" | "aggregate"; dynamic: boolean }>;
export type PairCodeAssetIndex = Readonly<{ schemaVersion: 1; pairDigest: string; codeAssetManifestDigest: string;
  view: PairViewLocator; members: readonly PairCodeMember[] }>;
export type PairLifecycle = Readonly<{ schemaVersion: 1; pairDigest: string; status: "candidate" | "retained" | "retired"; validUntil: number }>;
export const routingPrefix = (pair: PublicReleasePair) => `public-release-routing/${pair.environment}/pairs/${protocol.publicReleaseDigest(pair)}/`;
function fail(): never { throw new Error("Retained pair assets are unavailable"); }
const exact = (value: any, keys: string[]) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
export async function readRoutingRecord(store: PairReadStore, key: string, limit = 16 * 1024 * 1024): Promise<any> {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readBoundedPairObject(store, key, limit)));
}
export async function readPairLifecycle(store: PairReadStore, pair: PublicReleasePair, now = Date.now): Promise<PairLifecycle> {
  const value = await readRoutingRecord(store, `${routingPrefix(pair)}lifecycle-v1.json`, 4096);
  if (!exact(value, ["schemaVersion", "pairDigest", "status", "validUntil"]) || value.schemaVersion !== 1 ||
      value.pairDigest !== protocol.publicReleaseDigest(pair) || !["candidate", "retained", "retired"].includes(value.status) ||
      !Number.isSafeInteger(value.validUntil) || value.validUntil <= now()) fail();
  return value;
}
/** The official inventory digest seals the complete ordered member array.
 * This Worker adapter does not import the source builder's filesystem code. */
export async function parsePairCodeAssetIndex(value: any, pair: PublicReleasePair): Promise<PairCodeAssetIndex> {
  if (!exact(value, ["schemaVersion", "pairDigest", "codeAssetManifestDigest", "view", "members"]) || value.schemaVersion !== 1 ||
      value.pairDigest !== protocol.publicReleaseDigest(pair) || value.codeAssetManifestDigest !== pair.codeAssetManifestDigest ||
      !Array.isArray(value.members) || !value.members.length || value.members.length > 100_000) fail();
  if (!exact(value.view, ["pairDigest", "identity", "claimDigest", "manifestDigest", "manifestBytes"]) ||
      value.view.pairDigest !== value.pairDigest || !/^[a-f0-9]{64}$/.test(value.view.claimDigest) ||
      !/^[a-f0-9]{64}$/.test(value.view.manifestDigest) || !Number.isSafeInteger(value.view.manifestBytes) ||
      value.view.manifestBytes < 1 || value.view.manifestBytes > view.VIEW_ROOT_BYTES_LIMIT) fail();
  view.parseViewIdentity(value.view.identity, pair);
  let previous = "", total = 0;
  const members: PairCodeMember[] = value.members.map((member: any) => {
    if (!exact(member, ["path", "mime", "size", "sha256", "family", "source", "dynamic"]) || !view.isPrivatePairArtifactPath(member.path) ||
        view.comparePrivatePairArtifactPaths(previous, member.path) >= 0 || !Number.isSafeInteger(member.size) || member.size < 0 ||
        member.size > view.BODY_BYTES_LIMIT || !/^[a-f0-9]{64}$/.test(member.sha256) || typeof member.mime !== "string" ||
        member.mime.length > 256 || /[\r\n]/.test(member.mime) || typeof member.family !== "string" ||
        !["compiled", "static", "aggregate"].includes(member.source) || typeof member.dynamic !== "boolean") fail();
    previous = member.path; total += member.size;
    return { path: member.path, mime: member.mime, size: member.size, sha256: member.sha256,
      family: member.family, source: member.source, dynamic: member.dynamic };
  });
  if (total > view.VIEW_TOTAL_BYTES_LIMIT || await bytesDigest(new TextEncoder().encode(JSON.stringify(members))) !== pair.codeAssetManifestDigest) fail();
  return { ...value, members };
}
const indexes = new WeakMap<PairReadStore, Map<string, Promise<PairCodeAssetIndex>>>();
export async function readPairCodeAssetIndex(store: PairReadStore, pair: PublicReleasePair): Promise<PairCodeAssetIndex> {
  let entries = indexes.get(store);
  if (!entries) { entries = new Map(); indexes.set(store, entries); }
  const key = routingPrefix(pair), existing = entries.get(key);
  if (existing) return existing;
  // Two configured slots per ingress. Cache only immutable digest-verified
  // inventories; lifecycle/withdrawal authority remains freshly read.
  if (entries.size >= 2) entries.delete(entries.keys().next().value!);
  const pending = parseIndex(); entries.set(key, pending);
  async function parseIndex() {
    try { return await parsePairCodeAssetIndex(await readRoutingRecord(store, `${key}code-assets-v1.json`), pair); }
    catch (error) { entries!.delete(key); throw error; }
  }
  return pending;
}
export async function readIndexedPairOutput(store: PairReadStore, pair: PublicReleasePair, index: PairCodeAssetIndex, member: PairCodeMember) {
  const output = await readPublicReleasePairOutput({ store, pair, locator: index.view, path: member.path });
  if (!output || output.status !== 200 || output.bodyDigest !== member.sha256 || output.bytes !== member.size ||
      output.headers["content-type"] !== member.mime) fail();
  return output;
}
/** Shared by ordinary assets and degraded fallback. Neither carries proof. */
export function pairArtifactResponse(request: Request, body: Uint8Array, digest: string, rawHeaders: HeadersInit, status = 200): Response {
  const headers = stripInternalHeaders(new Headers(rawHeaders));
  for (const [name, value] of Object.entries(SECURITY_HEADER_BASELINE)) if (!headers.has(name)) headers.set(name, value);
  headers.set("cache-control", "no-store");
  const etag = `"${digest}"`; headers.set("etag", etag); headers.set("accept-ranges", "bytes");
  const matches = (input: string | null) => input?.split(",").some(tag => tag.trim().replace(/^W\//, "") === etag || tag.trim() === "*");
  if (status === 200 && request.headers.has("if-match") && !request.headers.get("if-match")?.split(",").some(tag => tag.trim() === etag || tag.trim() === "*")) return new Response(null, { status: 412, headers });
  if (status === 200 && matches(request.headers.get("if-none-match"))) return new Response(null, { status: 304, headers });
  const range = request.headers.get("range"), ifRange = request.headers.get("if-range");
  if (status === 200 && request.method === "GET" && range && (!ifRange || ifRange === etag)) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match && (match[1] || match[2])) {
      const start = match[1] ? Number(match[1]) : Math.max(0, body.length - Number(match[2]));
      const end = !match[1] || !match[2] ? body.length - 1 : Math.min(body.length - 1, Number(match[2]));
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= body.length) {
        headers.set("content-range", `bytes */${body.length}`); return new Response(null, { status: 416, headers });
      }
      headers.set("content-range", `bytes ${start}-${end}/${body.length}`); headers.set("content-length", String(end - start + 1));
      return new Response(body.slice(start, end + 1), { status: 206, headers });
    }
  }
  headers.set("content-length", String(body.length));
  return new Response(request.method === "HEAD" ? null : new Uint8Array(body), { status, headers });
}
/** Only retained, immutable public dependencies can cross a selector switch.
 * Dynamic namespace members never fall back into an old pair's inventory. */
export async function serveRetainedPairCodeAsset({ store, pairs, request, now = Date.now, onRefusal }: {
  store: PairReadStore; pairs: readonly PublicReleasePair[]; request: Request; now?: () => number;
  onRefusal?: (pairId: string, stage: "lifecycle" | "inventory" | "body") => void;
}): Promise<Response | null> {
  const refused = (pair: PublicReleasePair, stage: "lifecycle" | "inventory" | "body") => { try { onRefusal?.(pair.pairId, stage); } catch {} };
  if (!["GET", "HEAD"].includes(request.method)) return null;
  let path: string;
  try { path = decodeURI(new URL(request.url).pathname); } catch { return null; }
  if (!view.isPrivatePairArtifactPath(path) || path.startsWith("/_pair-compiled/")) return null;
  let selected: { pair: PublicReleasePair; index: PairCodeAssetIndex; member: PairCodeMember; lifecycle: PairLifecycle } | undefined;
  for (const pair of pairs) {
    let lifecycle: PairLifecycle, index: PairCodeAssetIndex;
    // A missing advisory inventory cannot disable healthy selected serving.
    // No bytes from that pair can be returned without all checks succeeding.
    try { lifecycle = await readPairLifecycle(store, pair, now); }
    catch { refused(pair, "lifecycle"); continue; }
    if (lifecycle.status !== "retained") continue;
    try { index = await readPairCodeAssetIndex(store, pair); }
    catch { refused(pair, "inventory"); continue; }
    const member = index.members.find(member => member.path === path);
    if (!member || member.dynamic || !["clientAsset", "static"].includes(member.family)) continue;
    // Unversioned static names belong to normal selected routing. The shared
    // lookup retains only digest-addressed dependency URLs.
    if (!path.startsWith("/_astro/") && !path.startsWith("/posts/_no-build-assets/") &&
        !/(?:^|[._-])[a-f0-9]{16,}(?:[._-]|$)/.test(path.split("/").at(-1)!)) continue;
    if (selected && (selected.member.sha256 !== member.sha256 || selected.member.mime !== member.mime)) return null;
    selected ??= { pair, index, member, lifecycle };
  }
  if (!selected) return null;
  try {
    const output = await readIndexedPairOutput(store, selected.pair, selected.index, selected.member);
    if (canonicalReleaseValue(await readPairLifecycle(store, selected.pair, now)) !== canonicalReleaseValue(selected.lifecycle)) fail();
    return pairArtifactResponse(request, output.body, output.bodyDigest, output.headers);
  } catch (error) { refused(selected.pair, "body"); throw error; }
}
