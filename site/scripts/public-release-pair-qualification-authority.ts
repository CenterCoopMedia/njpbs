import { contentLink } from "../../packages/content-core/src/content-link.ts";
import { createRequire } from "node:module";
import type { Firestore, Transaction, DocumentSnapshot } from "firebase-admin/firestore";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import protocol from "../../functions/lib/public-release-pair.js";
import { readerSealPath } from "./public-release-pair-private-reader";
import { canonicalPath, parseReaderSeals, exact, type ReaderSeals } from "./public-release-pair-reader-contract";

const require = createRequire(import.meta.url);
const posts = require("../../functions/lib/no-build-post-ownership.js");
const pages = require("../../functions/lib/no-build-page-ownership.js");
const records = require("../../functions/lib/no-build-record-ownership.js");
const namespace = require("../../functions/lib/no-build-record-namespace.js");
const { publiclyVisible } = require("../../functions/lib/public-video-references.js");
const { parsePublicReleaseChangeHead } = require("../../functions/lib/public-release-change-log.js");
export const QUALIFICATION_OWNER_LIMIT = 4096;
export const QUALIFICATION_ROUTE_LIMIT = 100_000;
export class PairQualificationError extends Error {
  constructor(readonly code: "incomplete-code-pack" | "replay-unproven" | "replay-search-input-evidence-missing" |
    "coverage-mismatch" | "stale-qualification" | "reader-mismatch" | "source-census-unproven" | "qualification-validator-limit" | "qualification-validator-unproven") {
    super(`Private pair qualification refused: ${code}`);
  }
}
export type QualificationRoute = Readonly<{ path: string; kind: "post" | "page" | "record" | "record-index";
  ownerId: string; status: 200 | 302 | 308 | 410; location: string | null; sourceVersion: number; snapshotDigest: string | null }>;
export type QualificationAuthority = Readonly<{ digest: string; capturedAt: number;
  cursor: Readonly<{ baselineDigest: string; sequence: number; lastDigest: string }>;
  contextRevision: number; sealsDigest: string; seals: ReaderSeals; routes: readonly QualificationRoute[] }>;
function refuse(): never { throw new PairQualificationError("coverage-mismatch"); }
const COLLECTIONS = [posts.OWNER_COLLECTION, pages.PAGE_OWNER_COLLECTION, records.RECORD_OWNER_COLLECTION,
  pages.PAGE_ROUTE_COLLECTION, records.RECORD_ROUTE_COLLECTION] as string[];
const VALIDATORS = ["system/publicReleaseChanges", "system/publicDeployment/contexts/public", "system/publicDeployment",
  "system/noBuildPostAdmission", posts.CAPABILITY_PATH, pages.PAGE_CAPABILITY_PATH,
  "system/publicDeployment/noBuildRecords/capability", namespace.NAMESPACE_PATH, posts.LEGACY_STATE_PATH, "system/publicReleaseChangeLog", "system/cmsPublicationRuntime", "system/billing"] as string[];
function version(row: DocumentSnapshot) {
  if (!row.exists) return null;
  const time = row.updateTime;
  if (!time || !Number.isSafeInteger(time.seconds) || !Number.isSafeInteger(time.nanoseconds)) refuse();
  return [time.seconds, time.nanoseconds];
}

/** A bounded qualification census, never an ordinary public request read.
 * Every source batch contains up to 100 references, with at most four batches
 * in flight. Draft versions/update times are deliberately absent from the seal. */
export async function readPairQualificationAuthority({ firestore, transaction, pair }: {
  firestore: Firestore; transaction: Transaction; pair: PublicReleasePair;
}): Promise<QualificationAuthority> {
  pair = protocol.parsePublicReleasePair(pair);
  require("../../functions/lib/public-release-pair-work.js").assertPublicReleasePairDatabase(firestore, pair);
  const pairPath = require("../../functions/lib/public-release-pair-work.js").publicReleasePairPath(pair.pairId);
  const paths = [...VALIDATORS, pairPath, `${pairPath}/controls/runtime`, readerSealPath(pair)];
  const [validators, collections] = await Promise.all([
    transaction.getAll(...paths.map(path => firestore.doc(path))),
    Promise.all(COLLECTIONS.map((path, index) => transaction.get(firestore.collection(path)
      .limit((index < 3 ? QUALIFICATION_OWNER_LIMIT : QUALIFICATION_ROUTE_LIMIT) + 1)))),
  ]);
  if (collections.some((rows, index) => rows.size > (index < 3 ? QUALIFICATION_OWNER_LIMIT : QUALIFICATION_ROUTE_LIMIT))) refuse();
  const head = parsePublicReleaseChangeHead(validators[0].data());
  const context = validators[1].data();
  if (context?.schemaVersion !== 1 || !Number.isSafeInteger(context.revision) || context.revision < 1) refuse();
  const seals = parseReaderSeals(validators.at(-1)!.data(), pair);
  const pairRecord = protocol.parsePublicReleasePair(validators.at(-3)!.data()), control = validators.at(-2)!.data();
  if (protocol.publicReleaseDigest(pairRecord) !== protocol.publicReleaseDigest(pair) || control?.schemaVersion !== 2 ||
      control.pairId !== pair.pairId || !["candidate", "retained"].includes(control.status) || validators[11].data()?.disabled === true) refuse();
  const legacy = validators[8];
  const postRows = [...collections[0].docs, ...(legacy.exists ? [legacy] : [])];
  const postOwners = postRows.map(row => { const state = posts.validateState(row.data());
    if (!state || row !== legacy && state.postId !== row.id) refuse(); return state; });
  if (new Set(postOwners.map(state => state.postId)).size !== postOwners.length) refuse();
  const pageOwners = collections[1].docs.map(row => { const state = pages.validateNoBuildPageState(row.data());
    if (!state || state.pageId !== row.id) refuse(); return state; });
  const recordOwners = collections[2].docs.map(row => { const state = records.validateNoBuildRecordState(row.data());
    if (!state || state.documentId !== row.id) refuse(); return state; });
  const sourcePaths = [...new Set<string>([...postOwners.map(state => `cmsPosts/${state.postId}`),
    ...pageOwners.map(state => `cmsPages/${state.pageId}`), ...recordOwners.map(state => `cmsPosts/${state.documentId}`)])].sort();
  const sourceRows: DocumentSnapshot[] = [];
  for (let offset = 0; offset < sourcePaths.length; offset += 400) {
    const groups = [];
    for (let start = offset; start < Math.min(offset + 400, sourcePaths.length); start += 100) {
      groups.push(transaction.getAll(...sourcePaths.slice(start, start + 100).map(path => firestore.doc(path))));
    }
    sourceRows.push(...(await Promise.all(groups)).flat());
  }
  const sourceByPath = new Map(sourceRows.map(row => [row.ref.path, row.data()]));
  const routes = new Map<string, QualificationRoute>();
  const add = (route: QualificationRoute) => {
    if (!canonicalPath(route.path) || routes.has(route.path) || routes.size === QUALIFICATION_ROUTE_LIMIT) refuse();
    routes.set(route.path, Object.freeze(route));
  };
  for (const state of postOwners) {
    if (state.operationId === null && state.ownedSlugs.length === 0) continue;
    const document = sourceByPath.get(`cmsPosts/${state.postId}`);
    if (!state.operationId || !document?.published || document.published.sourceVersion !== state.sourceVersion ||
        publiclyVisible(document) !== state.visible || document.published.metadata?.slug !== state.slug) refuse();
    const snapshotDigest = pages.digest(document.published);
    if (state.snapshotDigest !== undefined && state.snapshotDigest !== snapshotDigest) refuse();
    for (const slug of state.ownedSlugs) {
      const path = `/posts/${slug}/`, canonical = `/posts/${state.slug}/`;
      add({ path, kind: "post", ownerId: state.postId, status: !state.visible ? 410 : path === canonical ? contentLink(document.published.metadata, canonical).external ? 302 : 200 : 308,
        location: state.visible ? path !== canonical ? canonical : contentLink(document.published.metadata, canonical).external ? contentLink(document.published.metadata, canonical).href : null : null, sourceVersion: state.sourceVersion, snapshotDigest });
    }
  }
  for (const state of pageOwners) {
    const document = sourceByPath.get(`cmsPages/${state.pageId}`);
    if (!document) refuse();
    pages.assertPageOwnerSnapshot(state, document);
    for (const path of state.ownedPaths) {
      const alias = state.pageId !== "home" && path !== state.path;
      add({ path, kind: "page", ownerId: state.pageId, status: !state.visible ? 410 : alias ? 308 : path === state.path && contentLink(document.published.metadata, state.path).external ? 302 : 200,
        location: state.visible ? alias ? state.path : path === state.path && contentLink(document.published.metadata, state.path).external ? contentLink(document.published.metadata, state.path).href : null : null, sourceVersion: state.sourceVersion, snapshotDigest: state.snapshotDigest });
    }
  }
  const namespaceValue = validators[7].data();
  if (namespaceValue) { exact(namespaceValue, ["schemaVersion", "families"]); if (namespaceValue.schemaVersion !== 1) refuse(); }
  const families = namespace.recordFamilies(namespaceValue?.families);
  if (recordOwners.some(state => !families.includes(state.family))) refuse();
  for (const state of recordOwners) {
    records.assertRecordOwnerSnapshot(state, sourceByPath.get(`cmsPosts/${state.documentId}`));
    for (const path of state.ownedPaths) add({ path, kind: "record", ownerId: state.documentId,
      // Native Program/Event output owns HTML at every retained alias. The
      // public edge's legacy redirects belong to the ingress boundary.
      status: state.visible ? 200 : 410, location: null,
      sourceVersion: state.sourceVersion, snapshotDigest: state.snapshotDigest });
  }
  for (const family of families) for (const path of require("../../functions/lib/no-build-record-contract.js").recordIndexPaths(family)) {
    add({ path, kind: "record-index", ownerId: family, status: 200,
      location: null, sourceVersion: 0, snapshotDigest: null });
  }
  // Orphan claims and claims reassigned to another owner refuse. Empty owner
  // collections never release retained Page/record addresses implicitly.
  const claimed = new Set<string>();
  const recordById = new Map(recordOwners.map(state => [state.documentId, state]));
  for (const [index, rows] of collections.slice(3).entries()) for (const row of rows.docs) {
    const claim = row.data(), route = routes.get(claim.path);
    if (!route || route.kind !== (index === 0 ? "page" : "record") || claim.schemaVersion !== 1 ||
        (index === 0 ? claim.pageId : claim.documentId) !== route.ownerId ||
        row.ref.path !== (index === 0 ? pages.pageRouteRef(firestore, claim.path) : records.recordRouteRef(firestore, claim.path)).path ||
        index === 1 && claim.family !== (recordById.get(route.ownerId) as { family: string } | undefined)?.family) refuse();
    claimed.add(route.path);
  }
  if ([...routes.values()].some(route => ["page", "record"].includes(route.kind) && !claimed.has(route.path))) refuse();
  const sourceSeals = sourceRows.map(row => { const document = row.data();
    return [row.ref.path, document ? { published: document.published ?? null, visible: publiclyVisible(document),
      publicSourceVersion: document.publicSourceVersion ?? null } : null]; });
  const cursor = Object.freeze({ baselineDigest: head.baselineDigest, sequence: head.sequence, lastDigest: head.lastDigest });
  const sorted = Object.freeze([...routes.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const capturedAt = Math.floor(validators[0].readTime.toMillis());
  if (!Number.isSafeInteger(capturedAt) || capturedAt < 1) refuse();
  const digest = protocol.publicReleaseDigest({ pairDigest: protocol.publicReleaseDigest(pair), cursor,
    contextRevision: context.revision, validators: validators.map(row => [row.ref.path, version(row)]),
    ownersAndClaims: collections.map(rows => rows.docs.map(row => [row.ref.path, version(row)])), sourceSeals, routes: sorted });
  return Object.freeze({ digest, cursor, capturedAt, contextRevision: context.revision,
    sealsDigest: protocol.publicReleaseDigest(seals), seals, routes: sorted });
}

/** Intended for the later switch owner's transaction, immediately before its
 * own guarded write. This helper grants nothing and performs no writes. */
export async function assertPairQualificationAuthorityCurrent(input: { firestore: Firestore; transaction: Transaction;
  pair: PublicReleasePair; expectedDigest: string; qualifiedAt: number }) {
  const live = await readPairQualificationAuthority(input);
  if (live.digest !== input.expectedDigest || !Number.isSafeInteger(input.qualifiedAt) ||
      live.capturedAt < input.qualifiedAt || live.capturedAt - input.qualifiedAt > 60_000) throw new PairQualificationError("stale-qualification");
  return live;
}
