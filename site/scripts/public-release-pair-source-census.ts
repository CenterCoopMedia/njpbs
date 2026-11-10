import { createRequire } from "node:module";
import type { Firestore, Transaction } from "firebase-admin/firestore";
import protocol from "../../functions/lib/public-release-pair.js";
import log from "../../functions/lib/public-release-change-log.js";
import baseline from "../../functions/lib/public-release-change-baseline.js";
const require = createRequire(import.meta.url);
const source = require("../../functions/lib/public-release-source-body.js");
const { publiclyVisible } = require("../../functions/lib/public-video-references.js");
const { shapeJoinedRecord } = require("../../functions/lib/joined-records.js");
const { mediaProjection } = require("../../functions/lib/media-contract.js");
export const PAIR_SOURCE_METADATA_FILE = "source-metadata.json";
export type PairSourceCursor = Readonly<{ baselineDigest: string; sequence: number; lastDigest: string }>;
export type PairSourceMetadata = Readonly<{ schemaVersion: 1; kind: "pair-public-source-metadata";
  members: readonly Readonly<{ path: string; digest: string }>[]; digest: string }>;
export class PairSourceCensusError extends Error {
  constructor(readonly code: "source-census-projection-unsupported" | "source-census-mismatch" | "source-census-transaction-limit" | "source-census-read-limit") {
    super(code); this.name = "PairSourceCensusError";
  }
}
const fail = (code: PairSourceCensusError["code"] = "source-census-mismatch"): never => { throw new PairSourceCensusError(code); };
const authorityDocuments = new Set(["system/publicDeployment", "system/publicDeployment/pairMedia/current", "system/publicDeployment/contexts/public", "system/noBuildPostAdmission",
  "system/publicDeployment/noBuildPosts/current", "system/publicDeployment/noBuildPosts/capability", "system/publicDeployment/noBuildPages/capability",
  "system/publicDeployment/noBuildRecords/capability", "system/publicDeployment/noBuildRecordFamilies/current", "cmsBackgroundOutputs/home"]);
const authorityCollection = /^system\/publicDeployment\/(?:noBuildPostOwners|noBuildPageOwners|noBuildRecordOwners|noBuildPageRoutes|noBuildRecordRoutes)\/[A-Za-z0-9_-]+$/;
const normalized = (value: unknown) => JSON.parse(JSON.stringify(value));

/** Deterministic public-field identity, shared by H and live metadata. Event
 * body hashes may bundle several documents and are deliberately not reused. */
export function projectPublicReleasePairSourceCensusDocuments(documents: ReadonlyMap<string, any>): PairSourceMetadata {
  try {
    if (documents.size > 20_000) fail();
    const root = documents.get("system/publicDeployment");
    if (root?.schemaVersion === 2) {
      // Both documents came from the same actual SDK snapshot (or sealed H).
      // Missing/corrupt pair media is a refusal, never legacy readiness.
      require("../../functions/lib/public-release-switch.js").parsePairMedia(
        documents.get("system/publicDeployment/pairMedia/current"), source.publicReleaseAuthorityDocument("system/publicDeployment", root));
    }
    const history = [...documents].filter(([path]) => path.startsWith("cmsVersionHistory/")).map(([, value]) => value);
    const members: { path: string; digest: string }[] = [];
    for (const [path, value] of [...documents].sort(([a], [b]) => a < b ? -1 : 1)) {
      const lineage = /^system\/publicReleaseSwitchLineage\/entries\/([A-Za-z0-9._:-]+)$/.exec(path);
      if (lineage) {
        const history = documents.get(`system/publicReleaseSwitches/entries/${lineage[1]}`);
        if (history?.schemaVersion !== 2 || history.operationId !== lineage[1]) fail();
        const parsed = require("../../functions/lib/public-release-switch-lineage.js")
          .parsePublicReleaseSwitchLineage(value, history.selector);
        if (parsed.operationId !== lineage[1]) fail();
        continue; // immutable CODE reconstruction evidence, never mutable source identity
      }
      // These are reconstruction support, not mutable source identities. Approved
      // library semantics and the exact immutable CODE manifest remain below.
      if (path === "system/publicReleaseHistoricalCode" || /^cmsVersionHistory\//.test(path) ||
          /^system\/publicReleaseSwitches\/entries\//.test(path) || path === "system/publicDeployment/pairMedia/current") continue;
      if (!value || typeof value !== "object" || Array.isArray(value)) fail();
      let projection: unknown;
      if (/^cms(?:Posts|Pages)\/[A-Za-z0-9_-]+$/.test(path)) {
        if (path.startsWith("cmsPosts/") && ["sponsor", "newsletter"].includes(value.type)) {
          const id = path.split("/").at(-1)!;
          projection = shapeJoinedRecord(id, value, history.filter(row => row.collection === "cmsPosts" && row.documentId === id))?.approvedLibraryVersion;
          if (!projection) continue;
        } else {
          if (!value.published) continue;
          if (!value.published.metadata || !Number.isSafeInteger(value.published.sourceVersion) || value.published.sourceVersion < 1) fail();
          projection = { published: value.published, publiclyVisible: publiclyVisible(value) };
        }
      } else if (/^cmsSettings\/[A-Za-z0-9_-]+$/.test(path)) {
        if (!value.published) continue;
        projection = { published: value.published };
      } else if (/^cmsAuthorProfilesPublic\/[A-Za-z0-9_-]+$/.test(path) || /^media_assets_public\/[A-Za-z0-9_-]+$/.test(path)) {
        projection = value;
      } else if (/^media_assets\/[A-Za-z0-9_-]+$/.test(path)) {
        if (!documents.has(path.replace("media_assets/", "media_assets_public/"))) continue;
        projection = { ...mediaProjection(value), source: value.source, lifecycle: value.lifecycle };
      } else if (/^cmsPreviewPublicContexts\/cms-[A-Za-z0-9]{20}$/.test(path)) {
        const names = ["schemaVersion", "buildBatchId", "artifactReceiptDigest", "byteLength", "sha256", "key"];
        if (names.some(name => value[name] === undefined)) fail();
        projection = Object.fromEntries(names.map(name => [name, value[name]]));
      } else if (authorityDocuments.has(path) || authorityCollection.test(path) || path === "system/devPublicReleasePauseRecovery") {
        projection = source.publicReleaseAuthorityIdentityDocument(path, value);
        // Historical replay synthesizes this operational timestamp at its cursor.
        if (path === "system/publicDeployment/contexts/public") {
          const { changedAt: _changedAt, ...publicContext } = projection as Record<string, unknown>;
          projection = publicContext;
        }
      } else fail("source-census-projection-unsupported");
      members.push({ path, digest: protocol.publicReleaseDigest(normalized(projection)) });
    }
    if (!members.length || members.length > 10_000) fail();
    const identity = { schemaVersion: 1 as const, kind: "pair-public-source-metadata" as const, members };
    return Object.freeze({ ...identity, members: Object.freeze(members.map(member => Object.freeze(member))), digest: protocol.publicReleaseDigest(identity) });
  } catch (error) {
    if (error instanceof PairSourceCensusError) throw error;
    return fail();
  }
}
function parseExpected(value: PairSourceMetadata) {
  if (!value || value.schemaVersion !== 1 || value.kind !== "pair-public-source-metadata" || !Array.isArray(value.members) ||
      Object.keys(value).sort().join(",") !== "digest,kind,members,schemaVersion" ||
      !value.members.length || value.members.length > 10_000 || value.members.some((member, index) =>
        !member || Object.keys(member).sort().join(",") !== "digest,path" || typeof member.path !== "string" || !/^[a-f0-9]{64}$/.test(member.digest) || index > 0 && value.members[index - 1].path >= member.path) ||
      value.digest !== protocol.publicReleaseDigest({ schemaVersion: 1, kind: value.kind, members: value.members })) fail();
  return value;
}
function assertHead(value: unknown, cursor: PairSourceCursor) {
  const head = log.parsePublicReleaseChangeHead(value);
  if (protocol.publicReleaseDigest({ baselineDigest: head.baselineDigest, sequence: head.sequence, lastDigest: head.lastDigest }) !==
      protocol.publicReleaseDigest(cursor)) fail();
}

export const SOURCE_CENSUS_READ_LIMIT = 20_000;
function sourceCensusReads(options: { firestore: Firestore; transaction?: Transaction; maxDocuments?: number; signal?: AbortSignal }) {
  const cap = options.transaction ? options.maxDocuments ?? 500 : SOURCE_CENSUS_READ_LIMIT;
  if (options.transaction && (!Number.isInteger(cap) || cap < 1 || cap > 500)) fail("source-census-transaction-limit");
  let readCount = 0;
  let pending: Promise<void> = Promise.resolve();
  let failed = false, failure: unknown;
  const limitFailure = () => fail(options.transaction ? "source-census-transaction-limit" : "source-census-read-limit");
  const allowance = (count: number) => {
    options.signal?.throwIfAborted();
    if (readCount + count > cap) limitFailure();
  };
  const wait = async <T>(request: Promise<T>): Promise<T> => {
    const signal = options.signal;
    if (!signal) return request;
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      request.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => {
        signal.removeEventListener("abort", abort); reject(error);
      });
      if (signal.aborted) abort();
    });
  };
  const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = pending.then(() => { if (failed) throw failure; return operation(); });
    pending = result.then(() => {}, error => { failed = true; failure = error; });
    return result;
  };
  const get = (reference: any) => serialized(async () => {
    allowance(1);
    const query = typeof reference.limit === "function";
    if (query && !options.transaction) {
      const docs: any[] = [];
      let after: any;
      for (;;) {
        allowance(1);
        const bound = Math.min(100, cap - readCount);
        let page = reference.orderBy("__name__").limit(bound);
        if (after) page = page.startAfter(after);
        const value = await wait<any>(page.get());
        readCount += Math.max(1, value.size);
        options.signal?.throwIfAborted();
        docs.push(...value.docs);
        if (value.size < bound) return { docs, size: docs.length, empty: !docs.length };
        if (readCount >= cap) limitFailure();
        after = value.docs.at(-1);
      }
    }
    if (query) reference = reference.limit(cap - readCount);
    const value: any = await wait(options.transaction ? options.transaction.get(reference) : reference.get());
    readCount += query ? Math.max(1, value.size) : 1;
    options.signal?.throwIfAborted();
    if (query && readCount >= cap) limitFailure();
    return value;
  });
  const getAll = (...refs: any[]) => serialized(async () => {
    allowance(refs.length);
    const rows = [];
    for (let offset = 0; offset < refs.length; offset += 100) {
      options.signal?.throwIfAborted();
      const batch = refs.slice(offset, offset + 100);
      rows.push(...await wait(options.transaction ? options.transaction.getAll(...batch) : options.firestore.getAll(...batch)));
      readCount += batch.length;
    }
    options.signal?.throwIfAborted();
    return rows;
  });
  return { get, getAll, count: () => readCount };
}
/** Metadata preparation pages queries outside transactions and prospectively
 * bounds the final transaction. At most one bounded SDK request is in flight. */
async function readCensus(options: { firestore: Firestore; transaction?: Transaction; expected: PairSourceMetadata; cursor: PairSourceCursor; maxDocuments?: number; signal?: AbortSignal }) {
  const expected = parseExpected(options.expected);
  const reader = sourceCensusReads(options), { get: read, getAll } = reader;
  try {
    const head = options.firestore.doc(log.PUBLIC_RELEASE_CHANGES_PATH);
    assertHead((await read(head)).data(), options.cursor);
    const census = await baseline.readPublicReleaseSourceCensusInTransaction({ firestore: options.firestore,
      transaction: { get: read, getAll } as unknown as Transaction });
    const documents = new Map<string, any>();
    for (const value of census.values) for (const document of JSON.parse(value.json).documents) {
      if (document.data !== null) documents.set(document.path, document.data);
    }
    // Historical CODE itself is private support. Its exact immutable manifest
    // is an actual reader dependency and is checked with the live metadata.
    const manifests = expected.members.filter(member => member.path.startsWith("cmsPreviewPublicContexts/"));
    const rows = await getAll(...manifests.map(member => options.firestore.doc(member.path)));
    rows.forEach((row, index) => { if (!row.exists) fail(); documents.set(manifests[index].path, row.data()); });
    assertHead((await read(head)).data(), options.cursor);
    let metadata = projectPublicReleasePairSourceCensusDocuments(documents);
    if (metadata.digest !== expected.digest) {
      const expectedMembers = new Map(expected.members.map(member => [member.path, member.digest]));
      const members = metadata.members.map(member => {
        if (member.digest === expectedMembers.get(member.path) ||
            !/^system\/publicDeployment\/(?:noBuildPostOwners\/[A-Za-z0-9_-]+|noBuildPosts\/current)$/.test(member.path)) return member;
        const owner = documents.get(member.path);
        if (owner?.mode !== "static" || owner.staticProof === undefined) return member;
        // Old immutable bodies predate this additive field. Permit only that
        // exact legacy identity; modern H still binds every proof byte.
        const { staticProof: _staticProof, ...legacyOwner } = source.publicReleaseAuthorityDocument(member.path, owner);
        const digest = protocol.publicReleaseDigest(normalized(legacyOwner));
        return digest === expectedMembers.get(member.path) ? { path: member.path, digest } : member;
      });
      const identity = { schemaVersion: metadata.schemaVersion, kind: metadata.kind, members };
      metadata = { ...identity, digest: protocol.publicReleaseDigest(identity) };
    }
    if (metadata.digest !== expected.digest) fail();
    return { metadata, readCount: reader.count(), validatorCount: metadata.members.length, transactionEligible: reader.count() <= 500 };
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof protocol.PublicReleaseProtocolError) return fail();
    throw error;
  }
}

/** Read-only qualification source census. */
export function preparePublicReleasePairSourceCensus(options: { firestore: Firestore; expected: PairSourceMetadata; cursor: PairSourceCursor; signal?: AbortSignal }) {
  return readCensus(options);
}
export function assertPublicReleasePairSourceCensusInTransaction(options: { firestore: Firestore; transaction: Transaction;
  expected: PairSourceMetadata; cursor: PairSourceCursor; maxDocuments?: number; signal?: AbortSignal }) {
  return readCensus(options);
}

/** Read-only cost observation before enrollment. Returns counts only, with no
 * source data, freshness receipt or inferred original-H identity. Protocol head
 * and original-H manifest reads are additional qualification costs. */
export async function measurePublicReleasePairSourceCensusReads(options: { firestore: Firestore; signal?: AbortSignal }) {
  const reader = sourceCensusReads(options);
  const census = await baseline.readPublicReleaseSourceCensusInTransaction({ firestore: options.firestore, transaction: reader as unknown as Transaction });
  const documents = new Map<string, unknown>();
  for (const value of census.values) for (const document of JSON.parse(value.json).documents) {
    if (document.data !== null) documents.set(document.path, document.data);
  }
  options.signal?.throwIfAborted();
  return { censusOnly: true as const, readCount: reader.count(),
    validatorCount: projectPublicReleasePairSourceCensusDocuments(documents).members.length,
    excludesProtocolAndManifestReads: true as const };
}
