"use strict";

const { createHash, randomBytes } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { FieldPath, Timestamp } = require("firebase-admin/firestore");
const { hasCapability } = require("./rbac");
const { isAudioReadAdmitted, mayUseMedia } = require("./media-access");
const {
  DEFAULT_MEDIA_KINDS,
  isMediaAssetId,
  mediaAssetSummary,
  mediaSearchText,
} = require("./media-library");
const {
  MEDIA_DISCOVERY_SCHEMA, MEDIA_DISCOVERY_STATE, BROWSE_TERM, OVERFLOW_TERM,
  discoveryTerm, deriveMediaDiscovery,
} = require("./media-discovery");

const MAX_DISCOVERY_CANDIDATES = 120;
const MAX_DISCOVERY_PAGE_SIZE = 30;
const OWNER_CHUNK_SIZE = 6;
const CURSOR_COLLECTION = "mediaDiscoveryCursors";
const CURSOR_LIFETIME_MS = 30 * 60 * 1000;
const SORT_KEYS = Object.freeze({
  name: "nameKey", createdAt: "createdAtKey", updatedAt: "updatedAtKey", sizeBytes: "sizeBytesKey",
});

class MediaDiscoveryError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function authorizedOwners(principal, kind, audioReadAdmitted = false) {
  const capabilities = kind === "audio" && audioReadAdmitted === true
    ? ["media.audio.read", "media.upload", "media.manage"]
    : ["media.image.read", "media.upload", "media.manage"];
  // Categories never authorize a media read. A held media capability uses one
  // bounded site-wide branch, including when the role grant names content areas.
  return capabilities.some((capability) => hasCapability(principal, capability)) ? null : [];
}

// Live labels are deliberately excluded from stored grams. Choose only a gram that cannot
// be supplied by a label or a joined-field boundary. Otherwise browse bounded candidates.
function searchCandidateTerm(q, categoryLabels) {
  const text = q.toLocaleLowerCase("en-US");
  const labels = Object.values(categoryLabels).map((label) => label.toLocaleLowerCase("en-US"));
  for (let i = text.length - 3; i >= 0; i--) {
    const gram = text.slice(i, i + 3);
    if (!/\s/u.test(gram) && !labels.some((label) => label.includes(gram))) {
      return discoveryTerm(gram);
    }
  }
  return null;
}

function ownerChunkSize(kinds) {
  // Two kinds and two search terms expand each owner into four five-filter clauses.
  // Four owners keep filters plus sort orders below Firestore's 100-constraint limit.
  return kinds?.length === 2 ? 4 : OWNER_CHUNK_SIZE;
}

function discoveryQueries(
  firestore,
  { owners, kinds, term, sort, direction, after = null, limit, fields },
) {
  const chunks = owners === null ? [null] : [];
  if (owners !== null) {
    const chunkSize = ownerChunkSize(kinds);
    for (let i = 0; i < owners.length; i += chunkSize) chunks.push(owners.slice(i, i + chunkSize));
  }
  return chunks.map((chunk) => {
    let query = firestore.collection("media_assets")
      .where("mediaDiscovery.schema", "==", MEDIA_DISCOVERY_SCHEMA)
      .where("mediaDiscovery.eligible", "==", true)
      .where("mediaDiscovery.terms", term === null ? "array-contains" : "array-contains-any",
        term === null ? BROWSE_TERM : [term, OVERFLOW_TERM]);
    if (kinds?.length === 1) query = query.where("kind", "==", kinds[0]);
    else if (kinds?.length === 2) query = query.where("kind", "in", kinds);
    if (chunk) query = query.where("category", "in", chunk);
    query = query.orderBy(`mediaDiscovery.${SORT_KEYS[sort]}`, direction);
    if (sort !== "name") query = query.orderBy("mediaDiscovery.nameKey", direction);
    query = query.orderBy(FieldPath.documentId(), direction);
    if (after) query = query.startAfter(...after);
    if (fields) query = query.select(...fields, "mediaDiscovery");
    return query.limit(limit);
  });
}

function position(document, sort) {
  const index = document.get("mediaDiscovery");
  return sort === "name"
    ? [index.nameKey, document.id]
    : [index[SORT_KEYS[sort]], index.nameKey, document.id];
}

function comparePositions(left, right, direction) {
  for (let i = 0; i < left.length; i++) {
    const comparison = typeof left[i] === "number"
      ? Math.sign(left[i] - right[i])
      : Buffer.compare(Buffer.from(left[i]), Buffer.from(right[i]));
    if (comparison) return direction === "asc" ? comparison : -comparison;
  }
  return 0;
}

function matches(summary, query, labels) {
  if (query.q && !mediaSearchText(summary, labels).includes(query.q.toLocaleLowerCase("en-US"))) return false;
  if (!(query.kinds.length ? query.kinds : DEFAULT_MEDIA_KINDS).includes(summary.kind)) return false;
  return !query.categories.length || summary.categories.some((id) => query.categories.includes(id));
}

function emptyLibrary(query, records, nextCursor, matched) {
  return {
    records, paging: "cursor", nextCursor,
    total: nextCursor === null ? matched : null,
    allCount: !query.q && !query.categories.length && !query.kinds.length && nextCursor === null ? matched : null,
    page: query.page, pageCount: null, categoryCounts: null, kindCounts: null,
  };
}

async function readCursor(firestore, token, binding) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(token)) {
    throw new MediaDiscoveryError(400, "Invalid media continuation.");
  }
  const ref = firestore.collection(CURSOR_COLLECTION).doc(digest(token));
  const document = await ref.get();
  const data = document.data();
  if (!data || data.expireAt.toMillis() <= Date.now()) {
    throw new MediaDiscoveryError(410, "Media continuation expired. Return to the first page.");
  }
  if (data.binding !== binding) {
    throw new MediaDiscoveryError(409, "The media library or access changed. Return to the first page.");
  }
  return data;
}

async function writeCursor(firestore, binding, after, matched) {
  const token = randomBytes(24).toString("base64url");
  await firestore.collection(CURSOR_COLLECTION).doc(digest(token)).create({
    binding, after, matched, expireAt: Timestamp.fromMillis(Date.now() + CURSOR_LIFETIME_MS),
  });
  return token;
}

async function readIndexedMedia(firestore, user, query, categoryLabels, summaryFields) {
  if (user.approvedActive !== true) throw new MediaDiscoveryError(403, "You do not have permission to list media.");
  const stateRef = firestore.doc(MEDIA_DISCOVERY_STATE);
  const state = (await stateRef.get()).data();
  if (state?.schema !== MEDIA_DISCOVERY_SCHEMA || state?.state !== "ready") {
    throw new MediaDiscoveryError(503, "Media search index is not ready. Try again after migration.");
  }
  const requestedKind = query.kinds.length === 1 ? query.kinds[0] : undefined;
  const audioReadAdmitted = isAudioReadAdmitted(user);
  const owners = authorizedOwners(user.principal, requestedKind, audioReadAdmitted);
  const term = searchCandidateTerm(query.q, categoryLabels);
  const binding = digest({ uid: user.uid, principal: user.principal, owners, labels: categoryLabels,
    schema: MEDIA_DISCOVERY_SCHEMA, revision: state.revision ?? 0,
    query: { ...query, page: 1, cursor: undefined } });
  const cursor = query.cursor ? await readCursor(firestore, query.cursor, binding) : null;
  const records = [];
  let matched = cursor?.matched ?? 0;
  let after = cursor?.after ?? null;
  const pageSize = Math.min(query.pageSize ?? MAX_DISCOVERY_PAGE_SIZE, MAX_DISCOVERY_PAGE_SIZE);
  const requestedKinds = query.kinds.length ? query.kinds : DEFAULT_MEDIA_KINDS;
  const indexedKinds = requestedKinds.length <= 2 ? requestedKinds : undefined;
  // ID priority remains independent of the sort and only appears on the first page.
  if (!cursor && isMediaAssetId(query.q)) {
    const [exact] = await firestore.getAll(firestore.collection("media_assets").doc(query.q),
      { fieldMask: summaryFields });
    const summary = exact.exists ? mediaAssetSummary(exact.id, exact.data()) : null;
    if (summary && mayUseMedia(
      user.principal, summary.category, summary.kind, audioReadAdmitted,
    ) &&
        matches(summary, query, categoryLabels)) {
      records.push(summary);
      matched++;
    }
  }
  const branches = owners === null ? 1 : Math.ceil(owners.length / ownerChunkSize(indexedKinds));
  // Plain browse already constrains kind and authorized primary owners in Firestore.
  // Search, descriptive filters and merging owner branches need a larger bounded slice.
  const candidateBudget = query.q || query.categories.length || branches > 1
    ? MAX_DISCOVERY_CANDIDATES : pageSize;
  const branchLimit = Math.max(1,
    Math.floor(candidateBudget / Math.max(branches, 1)));
  const snapshots = await Promise.all(discoveryQueries(firestore, {
    owners, kinds: indexedKinds, term, sort: query.sort, direction: query.direction, after,
    limit: branchLimit + 1, fields: summaryFields,
  }).map((candidateQuery) => candidateQuery.get()));
  const offsets = snapshots.map(() => 0);
  let hasMore = false;
  while (records.length < pageSize) {
    // A branch that consumed its bounded batch can have an unseen next row before the
    // other heads. Continue from the last consumed global key instead of skipping it.
    if (snapshots.some((snapshot, i) => offsets[i] >= branchLimit && snapshot.size > branchLimit)) {
      hasMore = true;
      break;
    }
    let selected = -1;
    for (let i = 0; i < snapshots.length; i++) {
      if (offsets[i] >= snapshots[i].size) continue;
      if (selected < 0 || comparePositions(position(snapshots[i].docs[offsets[i]], query.sort),
        position(snapshots[selected].docs[offsets[selected]], query.sort), query.direction) < 0) selected = i;
    }
    if (selected < 0) break;
    const document = snapshots[selected].docs[offsets[selected]++];
    const data = document.data();
    after = position(document, query.sort);
    const summary = mediaAssetSummary(document.id, data);
    if (!summary || !isDeepStrictEqual(data.mediaDiscovery, deriveMediaDiscovery(document.id, data))) {
      throw new MediaDiscoveryError(503, "Media search index needs repair.");
    }
    if (!mayUseMedia(
      user.principal, summary.category, summary.kind, audioReadAdmitted,
    )) continue;
    if (document.id === query.q || !matches(summary, query, categoryLabels)) continue;
    records.push(summary);
    matched++;
  }
  hasMore ||= snapshots.some((snapshot, i) => offsets[i] < snapshot.size);
  const freshState = (await stateRef.get()).data();
  if (freshState?.state !== "ready" || freshState.revision !== state.revision) {
    throw new MediaDiscoveryError(409, "The media library changed. Return to the first page.");
  }
  const nextCursor = hasMore ? await writeCursor(firestore, binding, after, matched) : null;
  return emptyLibrary(query, records, nextCursor, matched);
}

// Production readiness must exercise both scoped and global shapes for every supported sort.
// The emulator cannot prove composite indexes are built.
async function probeDiscoveryIndexes(firestore) {
  const queries = [];
  for (const owners of [null, ["general", "news", "programs", "education"]]) {
    for (const sort of Object.keys(SORT_KEYS)) {
      for (const direction of ["asc", "desc"]) {
        for (const term of [null, discoveryTerm("xyz")]) {
          for (const kinds of [undefined, ["audio"], DEFAULT_MEDIA_KINDS]) {
            queries.push(discoveryQueries(firestore, { owners, kinds, sort, direction, term, limit: 1,
              fields: ["name"] })[0]);
          }
        }
      }
    }
  }
  // Bound readiness work while avoiding one network round trip per shape.
  for (let offset = 0; offset < queries.length; offset += 8) {
    await Promise.all(queries.slice(offset, offset + 8).map((query) => query.get()));
  }
  return queries.length;
}

module.exports = {
  MediaDiscoveryError, MAX_DISCOVERY_CANDIDATES, MAX_DISCOVERY_PAGE_SIZE,
  CURSOR_COLLECTION, CURSOR_LIFETIME_MS, SORT_KEYS,
  authorizedOwners, searchCandidateTerm, discoveryQueries, comparePositions,
  readIndexedMedia, probeDiscoveryIndexes,
};
