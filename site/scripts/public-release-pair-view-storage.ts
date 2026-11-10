import { createHash } from "node:crypto";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { PairTaskIdentity } from "../../functions/lib/public-release-pair-work";
import work from "../../functions/lib/public-release-pair-work.js";
import view from "../../functions/lib/public-release-pair-view.js";
import protocol from "../../functions/lib/public-release-pair.js";
import search from "../../functions/lib/public-release-pair-search-namespace.js";
import feed from "../../functions/lib/public-release-pair-content-feed-namespace.js";
import composite from "../../functions/lib/public-release-pair-composite-view.js";
import type { PairCompositeManifest } from "../../functions/lib/public-release-pair-composite-view";
import catalog from "../../functions/lib/public-release-pair-catalog-images.js";
import type { PairCatalogImagesManifest } from "../../functions/lib/public-release-pair-catalog-images";
import type { PairSearchNamespaceMember } from "../../functions/lib/public-release-pair-search-namespace";
import type { PairViewRoot } from "../../functions/lib/public-release-pair-view";
import { readPublicReleasePairVerifiedBytes } from "./public-release-pair-verified-read";

type PairViewStoredObject = { size: number; customMetadata?: Record<string, string>; body: ReadableStream<Uint8Array> };
export type PairViewStore = {
  put(key: string, bytes: Uint8Array, options: { onlyIf: { etagDoesNotMatch: string }; sha256: string;
    customMetadata: Record<string, string> }): Promise<unknown>;
  get(key: string): Promise<PairViewStoredObject | null>;
};
export type PairViewOutputInput = { path: string; status: 200 | 302 | 308 | 410; headers: Record<string, string>; bytes: Uint8Array };
const digestBytes = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
function refuse(): never {
  const error = new work.PairExecutionError("byte-mismatch");
  error.message = "Private pair view bytes differ";
  throw error;
}
function decode(bytes: Uint8Array) {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { refuse(); }
}
function invalidInput(): never { throw new Error("Private pair view input is invalid or exceeds its bound"); }
function active(signal?: AbortSignal) { signal?.throwIfAborted(); }
function metadata(pair: PublicReleasePair, identity: PairTaskIdentity, claimDigest: string, bodyDigest: string) {
  return { schemaversion: "2", pairdigest: protocol.publicReleaseDigest(pair),
    taskid: protocol.publicReleaseDigest(identity), claimdigest: claimDigest, bodydigest: bodyDigest };
}
async function readStored(stored: PairViewStoredObject | null, size: number, expected: Record<string, string>, signal?: AbortSignal, observedSize?: number) {
  if (signal?.aborted && stored) void stored.body.cancel().catch(() => {});
  active(signal);
  // A page caller may already have sized this same immutable response.
  const storedSize = observedSize ?? stored?.size;
  if (!stored || storedSize !== size) {
    if (stored) void stored.body.cancel().catch(() => {});
    refuse();
  }
  const customMetadata = stored.customMetadata;
  if (Object.entries(expected).some(([name, value]) => customMetadata?.[name] !== value)) {
    void stored.body.cancel().catch(() => {});
    refuse();
  }
  const chunks: Uint8Array[] = [], reader = stored.body.getReader();
  let total = 0;
  try {
    while (true) {
      active(signal);
      const chunk = await reader.read();
      active(signal);
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > size) refuse();
      chunks.push(chunk.value);
    }
  } finally { void reader.cancel().catch(() => {}); }
  if (total !== size) refuse();
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  if (digestBytes(bytes) !== expected.bodydigest) refuse();
  return bytes;
}
async function readExact(store: PairViewStore, key: string, size: number, expected: Record<string, string>, signal?: AbortSignal) {
  active(signal);
  return readPublicReleasePairVerifiedBytes(store, key, size, expected, signal,
    async () => readStored(await store.get(key), size, expected, signal));
}
async function putImmutable(store: PairViewStore, key: string, bytes: Uint8Array,
  seal: Record<string, string>, signal?: AbortSignal) {
  active(signal);
  await store.put(key, bytes, { onlyIf: { etagDoesNotMatch: "*" }, sha256: seal.bodydigest, customMetadata: seal });
  active(signal);
  // A conditional miss is acceptable only when the retained object is exact.
  await readExact(store, key, bytes.byteLength, seal, signal);
}

export type PairClaimJsonDescriptor = Readonly<{ digest: string; key: string; bytes: number }>;
/** Small auxiliary proofs share the original claim's immutable object codec. */
export async function writePublicReleasePairClaimJson({ store, pair, identity, claimDigest, value, limit, signal }: {
  store: PairViewStore; pair: PublicReleasePair; identity: PairTaskIdentity; claimDigest: string;
  value: unknown; limit: number; signal?: AbortSignal;
}): Promise<PairClaimJsonDescriptor> {
  const bytes = encode(value), digest = digestBytes(bytes);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > view.BODY_BYTES_LIMIT || bytes.length > limit) invalidInput();
  const key = view.publicReleasePairViewObjectKey(pair, identity, claimDigest, digest);
  await putImmutable(store, key, bytes, metadata(pair, identity, claimDigest, digest), signal);
  return Object.freeze({ digest, key, bytes: bytes.length });
}
export async function readPublicReleasePairClaimJson({ store, pair, identity, claimDigest, descriptor, limit, signal }: {
  store: PairViewStore; pair: PublicReleasePair; identity: PairTaskIdentity; claimDigest: string;
  descriptor: PairClaimJsonDescriptor; limit: number; signal?: AbortSignal;
}): Promise<unknown> {
  if (!descriptor || Object.keys(descriptor).sort().join(",") !== "bytes,digest,key" ||
      !/^[a-f0-9]{64}$/.test(descriptor.digest) || !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 1 ||
      descriptor.bytes > limit || !Number.isSafeInteger(limit) || limit < 1 || limit > view.BODY_BYTES_LIMIT ||
      descriptor.key !== view.publicReleasePairViewObjectKey(pair, identity, claimDigest, descriptor.digest)) refuse();
  return decode(await readExact(store, descriptor.key, descriptor.bytes, metadata(pair, identity, claimDigest, descriptor.digest), signal));
}

/** Verified immutable metadata plus bounded requested-body reads. Opening this
 * is not a claim that every declared body has just been read again. */
export async function openPublicReleasePairViewMetadata({ store, pair: rawPair, identity: rawIdentity, claimDigest,
  manifestDigest, manifestBytes, signal }: { store: PairViewStore; pair: PublicReleasePair; identity: PairTaskIdentity;
    claimDigest: string; manifestDigest: string; manifestBytes: number; signal?: AbortSignal }) {
  const pair = protocol.parsePublicReleasePair(rawPair), identity = view.parseViewIdentity(rawIdentity, pair);
  if (!/^[a-f0-9]{64}$/.test(manifestDigest) || !Number.isSafeInteger(manifestBytes) || manifestBytes < 1 || manifestBytes > view.VIEW_ROOT_BYTES_LIMIT) refuse();
  const prefix = view.publicReleasePairViewPrefix(pair, identity, claimDigest);
  const root = view.parsePublicReleasePairViewRoot(decode(await readExact(store, `${prefix}views/${manifestDigest}.json`, manifestBytes,
    metadata(pair, identity, claimDigest, manifestDigest), signal)), pair);
  if (protocol.publicReleaseDigest(root.identity) !== protocol.publicReleaseDigest(identity) || root.claimDigest !== claimDigest) refuse();
  let recent: { digest: string; page: ReturnType<typeof view.parsePublicReleasePairViewPage> } | undefined;
  const page = async (descriptor: typeof root.pages[number]) => {
    if (recent?.digest === descriptor.digest) return recent.page;
    const object = await store.get(`${prefix}pages/${descriptor.digest}.json`);
    const objectSize = object?.size;
    if (!object || objectSize === undefined || !Number.isSafeInteger(objectSize) || objectSize < 1 || objectSize > view.VIEW_PAGE_BYTES_LIMIT) {
      if (object) void object.body.cancel().catch(() => {});
      refuse();
    }
    const value = view.parsePublicReleasePairViewPage(decode(await readStored(object, objectSize,
      metadata(pair, identity, claimDigest, descriptor.digest), signal, objectSize)), pair, identity, claimDigest);
    if (value.index !== descriptor.index || value.outputs.length !== descriptor.count || value.outputs[0].path !== descriptor.firstPath ||
        value.outputs.at(-1)!.path !== descriptor.lastPath || value.outputs.reduce((sum, row) => sum + row.bytes, 0) !== descriptor.bytes) refuse();
    recent = { digest: descriptor.digest, page: value };
    return value;
  };
  const output = async (path: string) => {
    active(signal);
    let start = 0, end = root.pages.length;
    while (start < end) {
      const middle = Math.floor((start + end) / 2);
      if (view.comparePrivatePairArtifactPaths(root.pages[middle].lastPath, path) < 0) start = middle + 1; else end = middle;
    }
    const descriptor = root.pages[start];
    if (!descriptor || view.comparePrivatePairArtifactPaths(descriptor.firstPath, path) > 0) return null;
    const rows = (await page(descriptor)).outputs;
    start = 0; end = rows.length;
    while (start < end) {
      const middle = Math.floor((start + end) / 2);
      if (view.comparePrivatePairArtifactPaths(rows[middle].path, path) < 0) start = middle + 1; else end = middle;
    }
    return rows[start]?.path === path ? rows[start] : null;
  };
  return {
    root, output,
    async readBody(path: string) {
      const row = await output(path);
      if (!row) refuse();
      return { ...row, body: await readExact(store, row.objectKey, row.bytes, metadata(pair, identity, claimDigest, row.bodyDigest), signal) };
    },
    async *entries() { for (const descriptor of root.pages) yield* (await page(descriptor)).outputs; },
  };
}

/** Private bytes only. This grants no eligibility and writes no public pointer. */
export async function writePublicReleasePairView({ store, pair: rawPair, identity: rawIdentity, claimDigest,
  cursor, outputs, signal, deriveNamespaces = false, catalogImages, compositeManifest }: { store: PairViewStore; pair: PublicReleasePair; identity: PairTaskIdentity; claimDigest: string;
    cursor: { baselineDigest: string; sequence: number; lastDigest: string };
    outputs: AsyncIterable<PairViewOutputInput>; signal?: AbortSignal; deriveNamespaces?: boolean; catalogImages?: PairCatalogImagesManifest; compositeManifest?: PairCompositeManifest }) {
  const pair = protocol.parsePublicReleasePair(rawPair), identity = view.parseViewIdentity(rawIdentity, pair);
  const capturedCursor = view.parsePublicReleasePairViewCursor(cursor, identity);
  const prefix = view.publicReleasePairViewPrefix(pair, identity, claimDigest);
  const pages: Array<{ index: number; digest: string; count: number; bytes: number; firstPath: string; lastPath: string }> = [];
  const storedBodies = new Set<string>();
  let bodyBatch: Array<{ key: string; bytes: Uint8Array; seal: Record<string, string> }> = [];
  const flushBodies = async () => {
    // Four independently authorized immutable put/readbacks, at most 64 MiB.
    // Settle every operation before throwing; a failed batch emits no root.
    const results = await Promise.allSettled(bodyBatch.map(body => putImmutable(store, body.key, body.bytes, body.seal, signal)));
    bodyBatch = [];
    for (const result of results) if (result.status === "rejected") throw result.reason;
  };
  let pending: Array<ReturnType<typeof view.parsePublicReleasePairViewOutput>> = [];
  let pendingBytes = 0;
  let previous = "", outputCount = 0, outputBytes = 0;
  const searchMembers: PairSearchNamespaceMember[] = [], feedMembers: PairSearchNamespaceMember[] = [];
  let feedIndex: PairSearchNamespaceMember | undefined, feedIndexBytes: Uint8Array | undefined;
  const imageManifest = catalogImages === undefined ? undefined : catalog.parsePublicReleasePairCatalogImages(catalogImages, pair, identity, capturedCursor);
  const combined = compositeManifest === undefined ? undefined : composite.parsePublicReleasePairCompositeManifest(compositeManifest, pair, identity, capturedCursor);
  let combinedIndex = 0;
  const images = new Map(imageManifest?.members.map(member => [member.path, member]) ?? []), seenImages = new Set<string>();
  const pageValue = (rows: typeof pending) => ({ schemaVersion: 2 as const, pairDigest: protocol.publicReleaseDigest(pair),
    taskId: protocol.publicReleaseDigest(identity), claimDigest, index: pages.length, outputs: rows });
  const flush = async () => {
    if (!pending.length) return;
    const page = view.parsePublicReleasePairViewPage(pageValue(pending), pair, identity, claimDigest);
    const bytes = encode(page), digest = digestBytes(bytes);
    await putImmutable(store, `${prefix}pages/${digest}.json`, bytes,
      metadata(pair, identity, claimDigest, digestBytes(bytes)), signal);
    pages.push({ index: page.index, digest, count: page.outputs.length,
      bytes: page.outputs.reduce((sum, output) => sum + output.bytes, 0),
      firstPath: page.outputs[0].path, lastPath: page.outputs.at(-1)!.path });
    pending = [];
    pendingBytes = 0;
  };
  for await (const output of outputs) {
    active(signal);
    if (!(output.bytes instanceof Uint8Array) || output.bytes.byteLength > view.BODY_BYTES_LIMIT) invalidInput();
    const bodyBytes = new Uint8Array(output.bytes), bodyDigest = digestBytes(bodyBytes);
    const row = view.parsePublicReleasePairViewOutput({ path: output.path, status: output.status, headers: output.headers,
      bodyDigest, bytes: bodyBytes.byteLength,
      objectKey: view.publicReleasePairViewObjectKey(pair, identity, claimDigest, bodyDigest) }, pair, identity, claimDigest);
    if (combined) {
      const member = combined.members[combinedIndex++];
      if (!member || member.path !== row.path || member.status !== row.status || member.mime !== row.headers["content-type"] ||
          member.size !== row.bytes || member.sha256 !== row.bodyDigest) refuse();
    }
    if (imageManifest && row.path.startsWith("/_astro/")) {
      const image = images.get(row.path);
      if (!image) throw new catalog.PairCatalogImageError("catalog-unlisted");
      if (row.status !== 200 || row.bodyDigest !== image.sha256 || row.bytes !== image.size || row.headers["content-type"] !== image.mime) throw new catalog.PairCatalogImageError();
      seenImages.add(row.path);
    }
    if (deriveNamespaces && (row.path.startsWith(search.PAIR_SEARCH_NAMESPACE) || row.path.startsWith(feed.PAIR_CONTENT_FEED_NAMESPACE) || row.path === feed.PAIR_CONTENT_FEED_INDEX)) {
      if (row.status !== 200) invalidInput();
      const member = { path: row.path, mime: row.headers["content-type"], size: row.bytes, sha256: row.bodyDigest };
      if (row.path.startsWith(search.PAIR_SEARCH_NAMESPACE)) searchMembers.push(member);
      else if (row.path === feed.PAIR_CONTENT_FEED_INDEX) { feedIndex = member; feedIndexBytes = bodyBytes; }
      else feedMembers.push(member);
    }
    if (view.comparePrivatePairArtifactPaths(row.path, previous) <= 0 || ++outputCount > view.VIEW_OUTPUT_LIMIT) invalidInput();
    outputBytes += row.bytes;
    if (outputBytes > view.VIEW_TOTAL_BYTES_LIMIT) invalidInput();
    const rowBytes = encode(row).byteLength;
    if (pending.length && (pending.length === view.VIEW_PAGE_OUTPUT_LIMIT ||
        pendingBytes + 1 + rowBytes > view.VIEW_PAGE_BYTES_LIMIT)) await flush();
    if (pages.length >= 512) invalidInput();
    // Count the empty envelope once per page, then each row and separator.
    // Re-encoding the pending page per row would make sizing quadratic.
    pendingBytes = pending.length ? pendingBytes + 1 + rowBytes : encode(pageValue([])).byteLength + rowBytes;
    if (pendingBytes > view.VIEW_PAGE_BYTES_LIMIT) invalidInput();
    // Identical content in one claim needs one immutable put/readback, even
    // when many routes reference it. The set is bounded by VIEW_OUTPUT_LIMIT.
    if (!storedBodies.has(bodyDigest)) {
      bodyBatch.push({ key: row.objectKey, bytes: bodyBytes, seal: metadata(pair, identity, claimDigest, bodyDigest) });
      storedBodies.add(bodyDigest);
      if (bodyBatch.length === 4) await flushBodies();
    }
    pending.push(row);
    previous = row.path;
  }
  await flushBodies();
  await flush();
  let namespaceData: { search: ReturnType<typeof search.parsePublicReleasePairSearchNamespace>;
    feed: ReturnType<typeof feed.parsePublicReleasePairContentFeedNamespace> } | undefined;
  if (deriveNamespaces) {
    if (!feedIndex || !feedIndexBytes) invalidInput();
    const common = { schemaVersion: 1, pairDigest: protocol.publicReleaseDigest(pair), inputManifestDigest: identity.inputManifestDigest, cursor: capturedCursor };
    const searchManifest = search.parsePublicReleasePairSearchNamespace({ ...common, kind: "pair-search-namespace", namespace: search.PAIR_SEARCH_NAMESPACE, members: searchMembers }, pair, identity, capturedCursor);
    const feedManifest = feed.parsePublicReleasePairContentFeedNamespace({ ...common, kind: "pair-content-feed-namespace", namespace: feed.PAIR_CONTENT_FEED_NAMESPACE,
      index: { ...feedIndex, pageCount: feedMembers.length }, members: feedMembers }, pair, identity, capturedCursor);
    feed.assertPublicReleasePairContentFeedIndex(feedIndexBytes, feedManifest);
    namespaceData = { search: searchManifest, feed: feedManifest };
  }
  if (imageManifest && seenImages.size !== imageManifest.members.length) throw new catalog.PairCatalogImageError();
  if (combined && combinedIndex !== combined.members.length) refuse();
  // These at most four immutable descriptors share no mutable state. Keep the
  // canonical link order and drain every put/readback before emitting G's root.
  const proofs = [...(namespaceData ? [namespaceData.search, namespaceData.feed] : []),
    ...(imageManifest ? [imageManifest] : []), ...(combined ? [combined] : [])];
  const written = await Promise.allSettled(proofs.map(value =>
    writePublicReleasePairClaimJson({ store, pair, identity, claimDigest, value, limit: view.BODY_BYTES_LIMIT, signal })));
  const descriptors: PairClaimJsonDescriptor[] = [];
  for (const result of written) { if (result.status === "rejected") throw result.reason; descriptors.push(result.value); }
  let descriptorIndex = 0;
  const namespaces: PairViewRoot["namespaces"] = namespaceData ? {
    search: { namespace: search.PAIR_SEARCH_NAMESPACE, namespaceRootDigest: search.publicReleasePairSearchNamespaceRootDigest(namespaceData.search.members),
      descriptor: descriptors[descriptorIndex++] },
    contentFeed: { namespace: feed.PAIR_CONTENT_FEED_NAMESPACE, namespaceRootDigest: feed.publicReleasePairContentFeedNamespaceRootDigest(namespaceData.feed.members),
      descriptor: descriptors[descriptorIndex++] },
  } : undefined;
  const catalogLink: PairViewRoot["catalogImages"] = imageManifest ? { descriptor: descriptors[descriptorIndex++],
    memberCount: imageManifest.members.length, memberBytes: imageManifest.members.reduce((sum, member) => sum + member.size, 0) } : undefined;
  const compositeLink: PairViewRoot["composite"] = combined ? { descriptor: descriptors[descriptorIndex++],
    memberCount: combined.members.length, memberBytes: combined.members.reduce((sum, member) => sum + member.size, 0) } : undefined;
  const root = view.parsePublicReleasePairViewRoot({ schemaVersion: 2, kind: "private-pair-view",
    pairDigest: protocol.publicReleaseDigest(pair), identity, claimDigest, cursor: capturedCursor, pages, outputCount, outputBytes,
    ...(namespaces ? { namespaces } : {}), ...(catalogLink ? { catalogImages: catalogLink } : {}), ...(compositeLink ? { composite: compositeLink } : {}) }, pair);
  const bytes = encode(root), manifestDigest = digestBytes(bytes), key = `${prefix}views/${manifestDigest}.json`;
  await putImmutable(store, key, bytes, metadata(pair, identity, claimDigest, digestBytes(bytes)), signal);
  return Object.freeze({ manifestDigest, manifestKey: key, manifestBytes: bytes.byteLength, root });
}

/** Stream individually verified private outputs. Exhaust the iterator for full
 * coverage. This is not fresh ownership, producer completeness, deployed-reader
 * replay or public proof. */
export async function* readPublicReleasePairView({ store, pair: rawPair, identity: rawIdentity, claimDigest,
  manifestDigest, manifestBytes, signal }: { store: PairViewStore; pair: PublicReleasePair; identity: PairTaskIdentity;
    claimDigest: string; manifestDigest: string; manifestBytes: number; signal?: AbortSignal }) {
  const pair = protocol.parsePublicReleasePair(rawPair), identity = view.parseViewIdentity(rawIdentity, pair);
  if (!/^[a-f0-9]{64}$/.test(manifestDigest) || !Number.isSafeInteger(manifestBytes) ||
      manifestBytes < 1 || manifestBytes > view.VIEW_ROOT_BYTES_LIMIT) invalidInput();
  const prefix = view.publicReleasePairViewPrefix(pair, identity, claimDigest);
  const bytes = await readExact(store, `${prefix}views/${manifestDigest}.json`, manifestBytes,
    metadata(pair, identity, claimDigest, manifestDigest), signal);
  const root = view.parsePublicReleasePairViewRoot(decode(bytes), pair);
  if (protocol.publicReleaseDigest(root.identity) !== protocol.publicReleaseDigest(identity) || root.claimDigest !== claimDigest) refuse();
  // Keep one small verified shared blob, not the whole view in memory. Each
  // consumer gets an independent copy and cannot alter a later route's bytes.
  let recent: { key: string; bytes: Uint8Array } | undefined;
  for (const descriptor of root.pages) {
    active(signal);
    const key = `${prefix}pages/${descriptor.digest}.json`, stored = await store.get(key);
    if (signal?.aborted && stored) void stored.body.cancel().catch(() => {});
    active(signal);
    const storedSize = stored?.size;
    if (!stored || storedSize === undefined || !Number.isSafeInteger(storedSize) || storedSize < 1 || storedSize > view.VIEW_PAGE_BYTES_LIMIT) {
      if (stored) void stored.body.cancel().catch(() => {});
      refuse();
    }
    const pageBytes = await readStored(stored, storedSize, metadata(pair, identity, claimDigest, descriptor.digest), signal, storedSize);
    const page = view.parsePublicReleasePairViewPage(decode(pageBytes),
      pair, identity, claimDigest);
    if (page.index !== descriptor.index || page.outputs.length !== descriptor.count ||
        page.outputs[0].path !== descriptor.firstPath || page.outputs.at(-1)!.path !== descriptor.lastPath ||
        page.outputs.reduce((sum, output) => sum + output.bytes, 0) !== descriptor.bytes) refuse();
    for (let offset = 0; offset < page.outputs.length;) {
      active(signal);
      let end = offset, size = 0;
      do { size += page.outputs[end++].bytes; }
      while (end < page.outputs.length && end - offset < 4 && size + page.outputs[end].bytes <= view.BODY_BYTES_LIMIT);
      const shared = new Map<string, { size: number; body: Promise<Uint8Array> }>();
      const results = await Promise.allSettled(page.outputs.slice(offset, end).map(async output => {
        if (recent?.key === output.objectKey && recent.bytes.byteLength !== output.bytes) refuse();
        let selected = shared.get(output.objectKey);
        if (selected && selected.size !== output.bytes) refuse();
        if (!selected) {
          selected = { size: output.bytes, body: recent?.key === output.objectKey ? Promise.resolve(recent.bytes)
            : readExact(store, output.objectKey, output.bytes, metadata(pair, identity, claimDigest, output.bodyDigest), signal) };
          shared.set(output.objectKey, selected);
        }
        return { output, body: await selected.body };
      }));
      for (const result of results) if (result.status === "rejected") throw result.reason;
      for (const result of results) if (result.status === "fulfilled") {
        active(signal);
        const { output, body } = result.value;
        recent = body.byteLength <= 1024 * 1024 ? { key: output.objectKey, bytes: body } : undefined;
        yield Object.freeze({ ...output, body: recent ? new Uint8Array(body) : body });
      }
      offset = end;
    }
  }
}
