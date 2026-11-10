import { createHash } from "node:crypto";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { PairTaskIdentity } from "../../functions/lib/public-release-pair-work";
import protocol from "../../functions/lib/public-release-pair.js";
import views from "../../functions/lib/public-release-pair-view.js";
import type { PairViewStore } from "./public-release-pair-view-storage";

export type ReplayCursor = Readonly<{ baselineDigest: string; sequence: number; lastDigest: string }>;
export type ReplayViewReference = Readonly<{ identity: PairTaskIdentity; claimDigest: string;
  manifestDigest: string; manifestBytes: number }>;
export type ReplaySelectionMember = Readonly<{ path: string; view: ReplayViewReference; bodyDigest: string }>;
export type ReplaySelectionKind = "content" | "code-pack-overlay";
type Page = Readonly<{ digest: string; count: number; firstPath: string; lastPath: string }>;
export type ReplaySelectionRoot = Readonly<{ schemaVersion: 2; kind: ReplaySelectionKind; pairDigest: string;
  cursor: ReplayCursor; pages: readonly Page[]; count: number }>;
const LIMIT = 100_000, PAGE_LIMIT = 256, ROOT_BYTES = 256 * 1024, PAGE_BYTES = 1024 * 1024;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const isDigest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const compareReplayPaths = (a: string, b: string) => views.comparePrivatePairArtifactPaths(a, b);
const same = (a: unknown, b: unknown) => protocol.publicReleaseDigest(a) === protocol.publicReleaseDigest(b);
function refuse(): never { throw new protocol.PublicReleaseProtocolError(); }
function exact(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))) refuse();
  return value as Record<string, unknown>;
}
export function parseReplayCursor(raw: unknown): ReplayCursor {
  const value = exact(raw, ["baselineDigest", "sequence", "lastDigest"]);
  if (!isDigest(value.baselineDigest) || !isDigest(value.lastDigest) || !Number.isSafeInteger(value.sequence) ||
      (value.sequence as number) < 0 || value.sequence === 0 && value.lastDigest !== value.baselineDigest) refuse();
  return Object.freeze({ baselineDigest: value.baselineDigest, sequence: value.sequence as number, lastDigest: value.lastDigest });
}
export function parseReplayViewReference(raw: unknown, pair: PublicReleasePair): ReplayViewReference {
  const value = exact(raw, ["identity", "claimDigest", "manifestDigest", "manifestBytes"]);
  const identity = views.parseViewIdentity(value.identity, pair);
  if (!isDigest(value.claimDigest) || !isDigest(value.manifestDigest) || !Number.isSafeInteger(value.manifestBytes) ||
      (value.manifestBytes as number) < 1 || (value.manifestBytes as number) > views.VIEW_ROOT_BYTES_LIMIT) refuse();
  return Object.freeze({ identity, claimDigest: value.claimDigest, manifestDigest: value.manifestDigest,
    manifestBytes: value.manifestBytes as number });
}
function member(raw: unknown, pair: PublicReleasePair, cursor: ReplayCursor, kind: ReplaySelectionKind): ReplaySelectionMember {
  const value = exact(raw, ["path", "view", "bodyDigest"]);
  const view = parseReplayViewReference(value.view, pair);
  if (typeof value.path !== "string" ||
      value.path !== "/" && !views.isPrivatePairArtifactPath(value.path.endsWith("/") ? value.path.slice(0, -1) : value.path) ||
      kind === "content" && typeof value.path === "string" && !value.path.endsWith("/") ||
      !isDigest(value.bodyDigest) || view.identity.contextSequence > cursor.sequence) refuse();
  return Object.freeze({ path: value.path, view, bodyDigest: value.bodyDigest });
}
function prefix(pair: PublicReleasePair) { return `release-pair-replay/v2/${protocol.publicReleaseDigest(pair)}/`; }
// JSON bytes use the same canonical key ordering as publicReleaseDigest.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
const encode = (value: unknown) => new TextEncoder().encode(canonical(value));
function seal(pair: PublicReleasePair, digest: string) {
  return { schemaversion: "2", pairdigest: protocol.publicReleaseDigest(pair), bodydigest: digest };
}
async function read(store: PairViewStore, pair: PublicReleasePair, key: string, digest: string, limit: number) {
  const stored = await store.get(key), expected = seal(pair, digest);
  if (!stored || !Number.isSafeInteger(stored.size) || stored.size < 1 || stored.size > limit ||
      Object.entries(expected).some(([key, value]) => stored.customMetadata?.[key] !== value)) {
    if (stored) void stored.body.cancel().catch(() => {});
    refuse();
  }
  const reader = stored.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > stored.size) refuse();
      chunks.push(chunk.value);
    }
  } finally { void reader.cancel().catch(() => {}); }
  if (size !== stored.size) refuse();
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  if (hash(bytes) !== digest) refuse();
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
async function put(store: PairViewStore, pair: PublicReleasePair, category: string, value: unknown, limit: number) {
  const bytes = encode(value), digest = hash(bytes), key = `${prefix(pair)}${category}/${digest}.json`;
  if (bytes.byteLength > limit) refuse();
  await store.put(key, bytes, { onlyIf: { etagDoesNotMatch: "*" }, sha256: digest, customMetadata: seal(pair, digest) });
  const verified = await read(store, pair, key, digest, limit);
  if (!same(verified, value)) refuse();
  return digest;
}
function parseRoot(raw: unknown, pair: PublicReleasePair, kind: ReplaySelectionKind, cursor: ReplayCursor): ReplaySelectionRoot {
  const value = exact(raw, ["schemaVersion", "kind", "pairDigest", "cursor", "pages", "count"]);
  if (value.schemaVersion !== 2 || value.kind !== kind || value.pairDigest !== protocol.publicReleaseDigest(pair) ||
      !same(parseReplayCursor(value.cursor), cursor) || !Array.isArray(value.pages) || value.pages.length > Math.ceil(LIMIT / PAGE_LIMIT) ||
      !Number.isSafeInteger(value.count) || (value.count as number) < 0 || (value.count as number) > LIMIT) refuse();
  let previous = "", count = 0;
  const pages = value.pages.map(raw => {
    const page = exact(raw, ["digest", "count", "firstPath", "lastPath"]);
    if (!isDigest(page.digest) || !Number.isSafeInteger(page.count) || (page.count as number) < 1 ||
        (page.count as number) > PAGE_LIMIT || typeof page.firstPath !== "string" || typeof page.lastPath !== "string" ||
        compareReplayPaths(page.firstPath, previous) <= 0 || compareReplayPaths(page.firstPath, page.lastPath) > 0 ||
        (page.count === 1 ? page.firstPath !== page.lastPath : page.firstPath === page.lastPath)) refuse();
    previous = page.lastPath; count += page.count as number;
    return Object.freeze({ digest: page.digest, count: page.count as number, firstPath: page.firstPath, lastPath: page.lastPath });
  });
  if (count !== value.count) refuse();
  return Object.freeze({ schemaVersion: 2, kind, pairDigest: value.pairDigest as string, cursor, pages: Object.freeze(pages), count });
}
/** Immutable, paged current selection. A selection is private data, not qualification. */
export async function writePublicReleasePairReplaySelection({ store, pair: rawPair, kind, cursor: rawCursor, members }:
  { store: PairViewStore; pair: PublicReleasePair; kind: ReplaySelectionKind; cursor: ReplayCursor;
    members: Iterable<ReplaySelectionMember> }) {
  const pair = protocol.parsePublicReleasePair(rawPair), cursor = parseReplayCursor(rawCursor);
  if (!["content", "code-pack-overlay"].includes(kind)) refuse();
  const pages: Page[] = [];
  let pending: ReplaySelectionMember[] = [], count = 0, previous = "";
  const flush = async () => {
    if (!pending.length) return;
    const digest = await put(store, pair, "pages", { schemaVersion: 2, pairDigest: protocol.publicReleaseDigest(pair), kind, cursor,
      index: pages.length, members: pending }, PAGE_BYTES);
    pages.push({ digest, count: pending.length, firstPath: pending[0].path, lastPath: pending.at(-1)!.path });
    pending = [];
  };
  for (const raw of members) {
    const parsed = member(raw, pair, cursor, kind);
    if (compareReplayPaths(parsed.path, previous) <= 0 || ++count > LIMIT) refuse();
    previous = parsed.path; pending.push(parsed);
    if (pending.length === PAGE_LIMIT) await flush();
  }
  await flush();
  const root = parseRoot({ schemaVersion: 2, pairDigest: protocol.publicReleaseDigest(pair), kind, cursor, pages, count }, pair, kind, cursor);
  return { digest: await put(store, pair, "selections", root, ROOT_BYTES), root };
}
/** Exhaust the iterator before treating its page/body inventory as complete. */
export async function* readPublicReleasePairReplaySelection({ store, pair: rawPair, kind, cursor: rawCursor, digest }:
  { store: PairViewStore; pair: PublicReleasePair; kind: ReplaySelectionKind; cursor: ReplayCursor; digest: string }) {
  const pair = protocol.parsePublicReleasePair(rawPair), cursor = parseReplayCursor(rawCursor);
  if (!isDigest(digest) || !["content", "code-pack-overlay"].includes(kind)) refuse();
  const root = parseRoot(await read(store, pair, `${prefix(pair)}selections/${digest}.json`, digest, ROOT_BYTES), pair, kind, cursor);
  let previous = "";
  for (const [index, descriptor] of root.pages.entries()) {
    const page = exact(await read(store, pair, `${prefix(pair)}pages/${descriptor.digest}.json`, descriptor.digest, PAGE_BYTES),
      ["schemaVersion", "pairDigest", "kind", "cursor", "index", "members"]);
    if (page.schemaVersion !== 2 || page.pairDigest !== root.pairDigest || page.kind !== kind || page.index !== index ||
        !same(parseReplayCursor(page.cursor), cursor) || !Array.isArray(page.members) || page.members.length !== descriptor.count) refuse();
    const members = page.members.map(raw => member(raw, pair, cursor, kind));
    if (members[0].path !== descriptor.firstPath || members.at(-1)!.path !== descriptor.lastPath) refuse();
    for (const selected of members) {
      if (compareReplayPaths(selected.path, previous) <= 0) refuse();
      previous = selected.path;
      yield selected;
    }
  }
}

/** Durable readback only. The replay cursor still requires its own full-page CAS. */
export async function stagePublicReleasePairReplaySelection({ firestore, store, pair: rawPair, kind, cursor: rawCursor, digest }:
  { firestore: import("firebase-admin/firestore").Firestore; store: PairViewStore; pair: PublicReleasePair;
    kind: ReplaySelectionKind; cursor: ReplayCursor; digest: string }) {
  const pair = protocol.parsePublicReleasePair(rawPair), cursor = parseReplayCursor(rawCursor);
  if (!isDigest(digest)) refuse();
  const root = parseRoot(await read(store, pair, `${prefix(pair)}selections/${digest}.json`, digest, ROOT_BYTES), pair, kind, cursor);
  const proof = createHash("sha256").update("private-pair-replay-selection-v2\n").update(digest + "\n");
  const work = await import("../../functions/lib/public-release-pair-work.js");
  const base = work.default.publicReleasePairPath(pair.pairId);
  let count = 0, index = 0;
  let pending: ReplaySelectionMember[] = [];
  for await (const member of readPublicReleasePairReplaySelection({ store, pair, kind, cursor, digest })) {
    proof.update(canonical(member) + "\n"); count++; pending.push(member);
    if (pending.length === root.pages[index].count) {
      const page = { schemaVersion: 2, pairDigest: protocol.publicReleaseDigest(pair), kind, cursor, index, members: pending };
      const pageDigest = protocol.publicReleaseDigest(page);
      if (pageDigest !== root.pages[index].digest) refuse();
      await firestore.runTransaction(async transaction => {
        const ref = firestore.doc(`${base}/replaySelectionPages/${pageDigest}`), row = await transaction.get(ref);
        if (row.exists) { if (!same(row.data(), page)) refuse(); }
        else transaction.create(ref, page);
      });
      pending = []; index++;
    }
  }
  if (count !== root.count || pending.length || index !== root.pages.length) refuse();
  const record = { root, readbackDigest: proof.digest("hex") };
  // Pair identity, runtime and all original claims are checked again by the
  // transition/baseline owner before a cursor or witness can use this receipt.
  const path = `${base}/replaySelections/${digest}`;
  await firestore.runTransaction(async transaction => {
    const ref = firestore.doc(path), row = await transaction.get(ref);
    if (row.exists) { if (!same(row.data(), record)) refuse(); }
    else transaction.create(ref, record);
  });
  return record;
}
