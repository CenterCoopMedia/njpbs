import { accessToken, jsonResponse } from "./pending-work";
import targets, { type PublicationTarget } from "../functions/lib/publication-target.js";
import runtimeControl from "../functions/lib/cms-publication-runtime-control.js";
import { encodeWithdrawalManifest, readWithdrawalObject, withdrawalManifestKey,
  WITHDRAWAL_MANIFEST_BYTES, WITHDRAWAL_MANIFEST_POSTS,
  type Withdrawal, type WithdrawalManifest, type WithdrawalObject } from "../workers/src/durable-post-withdrawals";

type Data = Record<string, any>;
export const WITHDRAWAL_PUBLISH_TIMEOUT_MS = 30_000;
const STATIC_DOCUMENT_RESPONSE_BYTES = 8 * 1024 * 1024;
export type CatalogObservation = { contextRevision: number; pointer: Data; owners: Data[];
  queues: Map<string, Data>; posts: Map<string, Data>; recordFamilies?: string[] };
export type CatalogStore = {
  get(key: string): Promise<WithdrawalObject | null>;
  put(key: string, value: string, options: { onlyIf: { etagMatches?: string; etagDoesNotMatch?: string };
    httpMetadata: { contentType: string; cacheControl: string } }): Promise<unknown | null>;
};

function refuse(): never { throw new Error("Durable withdrawal publication is unavailable or exceeds its limit"); }
function object(value: unknown): Data {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse();
  return value as Data;
}
function fields(raw: unknown): Data {
  const decode = (value: unknown): any => {
    const field = object(value);
    if ("nullValue" in field) return null;
    if ("stringValue" in field) return field.stringValue;
    if ("booleanValue" in field) return field.booleanValue;
    if ("integerValue" in field) return Number(field.integerValue);
    if ("doubleValue" in field && Number.isFinite(field.doubleValue)) return field.doubleValue;
    if ("timestampValue" in field) return Date.parse(field.timestampValue);
    if (field.arrayValue) return (field.arrayValue.values ?? []).map(decode);
    if (field.mapValue) return fields(field.mapValue.fields ?? {});
    refuse();
  };
  return Object.fromEntries(Object.entries(object(raw)).map(([key, value]) => [key, decode(value)]));
}
const OWNER_PATH = "system/publicDeployment/noBuildPostOwners";
const LEGACY_PATH = "system/publicDeployment/noBuildPosts/current";
const CONTEXT_PATH = "system/publicDeployment/contexts/public";
const OWNER_FIELDS = ["schemaVersion", "postId", "operationId", "sourceVersion", "generation", "visible", "ownedSlugs", "mode", "rendererSha",
  "staticProof.schemaVersion", "staticProof.postId", "staticProof.operationId", "staticProof.sourceVersion",
  "staticProof.visible", "staticProof.slug", "staticProof.ownedSlugs", "staticProof.snapshotDigest", "staticProof.contextDigest"];
const MASK = [...OWNER_FIELDS, "revision", "state", "activeCommitSha", "phase", "commitSha", "serializerId",
  "cloud.phase", "cloud.commitSha", "cloud.serializerId",
  "transport", "status", "completedAt", "noBuildPost.postId", "noBuildPost.operationId", "noBuildPost.sourceVersion",
  "noBuildPost.visible", "noBuildPost.ownedSlugs", "noBuildPost.generation", "publicReceipt.operationId", "publicReceipt.sourceVersion", "publicReceipt.visible",
  "publicReceipt.htmlDigest", "publicReceipt.rendererSha", "publicReceipt.contextDigest", "postProof.status"];
const PAGE_OWNER_FIELDS = ["schemaVersion", "pageId", "operationId", "sourceVersion", "generation", "visible", "ownedPaths",
  "durableWithdrawal.schemaVersion", "durableWithdrawal.pageId", "durableWithdrawal.operationId", "durableWithdrawal.sourceVersion",
  "durableWithdrawal.revision", "durableWithdrawal.ownedPaths", "durableWithdrawal.snapshotDigest", "durableWithdrawal.contextRevision"];
const PAGE_MASK = [...PAGE_OWNER_FIELDS, "revision", "state", "activeCommitSha", "phase", "commitSha", "serializerId",
  "cloud.phase", "cloud.commitSha", "cloud.serializerId", "transport", "status",
  "noBuildPage.schemaVersion", "noBuildPage.pageId", "noBuildPage.operationId", "noBuildPage.sourceVersion",
  "noBuildPage.visible", "noBuildPage.ownedPaths", "noBuildPage.generation", "noBuildPage.snapshotDigest", "noBuildPage.contextRevision"];

const RECORD_OWNER_FIELDS = ["schemaVersion", "documentId", "family", "operationId", "sourceVersion", "generation", "visible", "ownedPaths",
  "durableWithdrawal.schemaVersion", "durableWithdrawal.recordId", "durableWithdrawal.family", "durableWithdrawal.operationId", "durableWithdrawal.sourceVersion",
  "durableWithdrawal.revision", "durableWithdrawal.ownedPaths", "durableWithdrawal.snapshotDigest", "durableWithdrawal.contextRevision"];
const RECORD_MASK = [...RECORD_OWNER_FIELDS, "revision", "state", "activeCommitSha", "phase", "commitSha", "serializerId", "families",
  "cloud.phase", "cloud.commitSha", "cloud.serializerId", "transport", "status",
  "recordPublication.schemaVersion", "recordPublication.documentId", "recordPublication.family", "recordPublication.operationId", "recordPublication.sourceVersion",
  "recordPublication.visible", "recordPublication.ownedPaths", "recordPublication.generation", "recordPublication.snapshotDigest", "recordPublication.contextRevision"];
const RECORD_NAMESPACE_PATH = "system/publicDeployment/noBuildRecordFamilies/current";

/** One read-only Firestore snapshot pins the catalog, operation and proof.
 * R2's expected ETag is read before this snapshot, never after stale input. */
export async function observeWithdrawalCatalog(options: { account: string; commitSha: string; target: PublicationTarget; signal?: AbortSignal; family?: "page" | "record" },
  request: typeof fetch = fetch): Promise<CatalogObservation> {
  const target = targets.assertPublicationTarget(options.target);
  const pages = options.family === "page", records = options.family === "record";
  const ownerPath = pages ? "system/publicDeployment/noBuildPageOwners" : records ? "system/publicDeployment/noBuildRecordOwners" : OWNER_PATH;
  const idField = pages ? "pageId" : records ? "documentId" : "postId";
  const ownerFields = pages ? PAGE_OWNER_FIELDS : records ? RECORD_OWNER_FIELDS : OWNER_FIELDS;
  const readMask = pages ? PAGE_MASK : records ? RECORD_MASK : MASK;
  const collection = pages ? "cmsPages" : "cmsPosts";
  if (!/^[a-f0-9]{40}$/.test(options.commitSha)) refuse();
  const signal = options.signal ?? AbortSignal.timeout(WITHDRAWAL_PUBLISH_TIMEOUT_MS);
  const base = `https://firestore.googleapis.com/v1/projects/${target.projectId}/databases/(default)/documents`;
  const token = await accessToken(options.account, request, target.projectId);
  signal.throwIfAborted();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const post = (url: string, body: unknown) => request(url, { method: "POST", headers, redirect: "manual",
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]), body: JSON.stringify(body) });
  const started = object(await jsonResponse(await post(`${base}:beginTransaction`, { options: { readOnly: {} } })));
  if (typeof started.transaction !== "string" || !started.transaction || started.transaction.length > 4096) refuse();
  const transaction = started.transaction;
  const read = async (paths: string[], mask = readMask, maxBytes = WITHDRAWAL_MANIFEST_BYTES) => {
    const rows = await jsonResponse(await post(`${base}:batchGet`, { transaction, documents: paths.map(path => `${base.split("/v1/")[1]}/${path}`),
      mask: { fieldPaths: mask } }), maxBytes);
    if (!Array.isArray(rows) || rows.length !== paths.length) refuse();
    const result = new Map<string, Data>();
    for (const raw of rows) {
      const row = object(raw), name = row.found?.name ?? row.missing;
      const prefix = `${base.split("/v1/")[1]}/`;
      if (typeof name !== "string" || !name.startsWith(prefix)) refuse();
      const path = name.slice(prefix.length);
      if (!paths.includes(path) || result.has(path)) refuse();
      result.set(path, row.found ? fields(row.found.fields ?? {}) : {});
    }
    return result;
  };
  try {
    const controls = await read([CONTEXT_PATH, "system/publicDeployment", "system/cmsPublicationRuntime", ...(records ? [RECORD_NAMESPACE_PATH] : pages ? [] : [LEGACY_PATH])]);
    const context = controls.get(CONTEXT_PATH)!, pointer = controls.get("system/publicDeployment")!;
    const cloud = runtimeControl.cloudCmsPublicationRuntimeControl(controls.get("system/cmsPublicationRuntime"));
    if (context.schemaVersion !== 1 || !Number.isSafeInteger(context.revision) || context.revision < 1 ||
        !["starting", "ready", "paused"].includes(cloud?.phase) || cloud.commitSha !== options.commitSha ||
        cloud.serializerId !== target.serializerId) refuse();
    const owners: Data[] = [], names = new Set<string>(), tokens = new Set<string>();
    let pageToken = "";
    for (let page = 0; page <= WITHDRAWAL_MANIFEST_POSTS / 25; page++) {
      const params = new URLSearchParams({ transaction, pageSize: "25" });
      ownerFields.forEach(field => params.append("mask.fieldPaths", field));
      if (pageToken) params.set("pageToken", pageToken);
      const result = object(await jsonResponse(await request(`${base}/${ownerPath}?${params}`, {
        headers, redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) }), WITHDRAWAL_MANIFEST_BYTES));
      if (!Array.isArray(result.documents ?? []) || (result.documents ?? []).length > 25) refuse();
      for (const row of result.documents ?? []) {
        const prefix = `${base.split("/v1/")[1]}/${ownerPath}/`;
        if (typeof row.name !== "string" || !row.name.startsWith(prefix)) refuse();
        const owner = fields(row.fields ?? {}), id = row.name.slice(prefix.length);
        if (owner[idField] !== id || names.has(id)) refuse();
        names.add(id); owners.push(owner);
      }
      if (owners.length > WITHDRAWAL_MANIFEST_POSTS) refuse();
      if (!result.nextPageToken) break;
      if (typeof result.nextPageToken !== "string" || result.nextPageToken.length > 4096 || tokens.has(result.nextPageToken)) refuse();
      tokens.add(result.nextPageToken); pageToken = result.nextPageToken;
      if (page === WITHDRAWAL_MANIFEST_POSTS / 25) refuse();
    }
    const legacy = controls.get(LEGACY_PATH) ?? {};
    if (legacy.operationId) { if (names.has(legacy.postId)) refuse(); owners.push(legacy); }
    const queues = new Map<string, Data>(), posts = new Map<string, Data>();
    if (owners.some(owner => !/^[A-Za-z0-9_-]{1,128}$/.test(owner[idField] ?? "") ||
        !/^[A-Za-z0-9]{20}$/.test(owner.operationId ?? ""))) refuse();
    // Catalogs only append tombstones. Native visible Posts cannot add one.
    // Static owners retain an older visible flag: their current proof must also
    // say visible before hydration can be skipped. Unknown proofs are read.
    // Keep all owner metadata fresh; hydrate after that state changes.
    // A republished Page may still carry an older marker and must be included.
    const candidates = owners.filter(owner => pages || records ? Boolean(owner.durableWithdrawal) :
      owner.visible !== true || owner.mode === "static" && owner.staticProof?.visible !== true);
    for (let offset = 0; offset < candidates.length; offset += 25) {
      const batch = candidates.slice(offset, offset + 25);
      const operations = [...new Set(batch.flatMap(owner => [owner.operationId,
        ...((pages || records) && owner.durableWithdrawal ? [owner.durableWithdrawal.operationId] : [])]))];
      if (operations.some(id => typeof id !== "string" || !/^[A-Za-z0-9]{20}$/.test(id))) refuse();
      const rows = await read(operations.map(id => `cmsPublishQueue/${id}`));
      const native = batch.filter(owner => owner.mode !== "static"), statics = batch.filter(owner => owner.mode === "static");
      const postRows = native.length ? await read(native.map(owner => `${collection}/${owner[idField]}`),
        ["version", "published.sourceVersion", "published.metadata.slug", "publiclyVisible", "status", "deleted"]) : new Map<string, Data>();
      // Firestore permits a 1 MiB document; its typed JSON and escaping can be
      // larger. Read full public static snapshots separately from the compact
      // native metadata batch, never under the R2 manifest's serialization cap.
      for (const owner of statics) {
        const path = `cmsPosts/${owner.postId}`;
        postRows.set(path, (await read([path], ["version", "published", "publiclyVisible", "status", "deleted"],
          STATIC_DOCUMENT_RESPONSE_BYTES)).get(path)!);
      }
      batch.forEach(owner => {
        posts.set(owner[idField], postRows.get(`${collection}/${owner[idField]}`)!);
      });
      operations.forEach(id => queues.set(id, rows.get(`cmsPublishQueue/${id}`)!));
    }
    const namespace = controls.get(RECORD_NAMESPACE_PATH);
    if (records && namespace && Object.keys(namespace).length && (namespace.schemaVersion !== 1 || !Array.isArray(namespace.families))) refuse();
    return { contextRevision: context.revision, pointer, owners, queues, posts,
      ...(records ? { recordFamilies: namespace?.families ?? [] } : {}) };
  } finally {
    try { const response = await request(`${base}:rollback`, { method: "POST", headers, redirect: "manual",
      signal: AbortSignal.timeout(2_000), body: JSON.stringify({ transaction }) }); await response.body?.cancel(); }
    catch { /* The bounded read-only observation has no writes to recover. */ }
  }
}

async function bounded<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const deadline = new Promise<never>((_, reject) => {
    abort = () => reject(new Error("Durable withdrawal publication deadline"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([work(), deadline]); }
  finally { signal.removeEventListener("abort", abort); }
}

function canonical(value: any): any {
  return Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])])) : value;
}
async function digest(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))))
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
}
function visible(post: Data): boolean {
  return !post.deleted && (post.publiclyVisible === true || post.publiclyVisible === undefined && post.status === "published");
}

async function staticPublication(owner: Data, observation: CatalogObservation): Promise<Data | null> {
  const proof = owner.staticProof, post = observation.posts.get(owner.postId), snapshot = post?.published;
  if (owner.mode !== "static" || !proof || observation.pointer.state !== "idle" ||
      observation.pointer.activeCommitSha !== owner.rendererSha || proof.schemaVersion !== 1 ||
      proof.postId !== owner.postId || proof.operationId !== owner.operationId || !snapshot ||
      proof.sourceVersion !== snapshot.sourceVersion || proof.visible !== visible(post!) ||
      proof.slug !== snapshot.metadata?.slug || !Array.isArray(proof.ownedSlugs)) return null;
  const slugs = [...new Set([...owner.ownedSlugs, snapshot.metadata.slug, ...(snapshot.metadata.previousSlugs ?? [])])].sort();
  if (JSON.stringify(slugs) !== JSON.stringify(proof.ownedSlugs)) return null;
  const authorIds = [...new Set([...(snapshot.authorIds ?? []), ...(snapshot.metadata.credits ?? [])
    .filter((credit: Data) => credit.kind === "registered").map((credit: Data) => credit.authorId)])].sort();
  const publicSnapshot = { metadata: snapshot.metadata, blocks: snapshot.blocks, publishedAt: snapshot.publishedAt,
    sourceVersion: snapshot.sourceVersion, authorIds };
  if (proof.snapshotDigest !== await digest(JSON.stringify(canonical({ visible: proof.visible, publicSnapshot }))) ||
      proof.contextDigest !== await digest(`njpbs-public-context-v1:${observation.contextRevision}`)) return null;
  return proof;
}

export async function mergeWithdrawalCatalog(previous: WithdrawalManifest | null, observation: CatalogObservation,
  workerName: string, verifiedAt = Date.now()): Promise<WithdrawalManifest> {
  if (previous && previous.contextRevision > observation.contextRevision) refuse();
  const entries = new Map((previous?.withdrawals ?? []).map(entry => [entry.postId, entry]));
  const retain = (entry: Withdrawal) => {
    const old = entries.get(entry.postId);
    if (old && old.revision > entry.revision) return;
    if (old && old.revision === entry.revision && (old.operationId !== entry.operationId || old.sourceVersion !== entry.sourceVersion)) refuse();
    entries.set(entry.postId, { ...entry, ownedSlugs: [...new Set([...(old?.ownedSlugs ?? []), ...entry.ownedSlugs])],
      verifiedAt: old?.operationId === entry.operationId &&
      old.sourceVersion === entry.sourceVersion ? old.verifiedAt : entry.verifiedAt });
  };
  for (const owner of observation.owners) {
    if (owner.schemaVersion !== 1 || !Number.isSafeInteger(owner.sourceVersion) || owner.sourceVersion < 1 ||
        !Number.isSafeInteger(owner.generation) || owner.generation < 1 ||
        typeof owner.visible !== "boolean" || !Array.isArray(owner.ownedSlugs)) refuse();
    const queue = observation.queues.get(owner.operationId), receipt = queue?.publicReceipt, operation = queue?.noBuildPost;
    const post = observation.posts.get(owner.postId);
    const proof = await staticPublication(owner, observation);
    if (proof) {
      if (!proof.visible) retain({ postId: owner.postId, operationId: owner.operationId, revision: owner.generation,
        sourceVersion: proof.sourceVersion, ownedSlugs: proof.ownedSlugs, verifiedAt });
      continue;
    }
    if (queue?.transport !== "post-no-build-v1" || queue.status !== "success" ||
        operation?.postId !== owner.postId || operation.operationId !== owner.operationId ||
        operation.generation !== owner.generation ||
        operation.sourceVersion !== owner.sourceVersion || operation.visible !== owner.visible ||
        JSON.stringify(operation.ownedSlugs) !== JSON.stringify(owner.ownedSlugs) ||
        receipt?.operationId !== owner.operationId || receipt.sourceVersion !== owner.sourceVersion ||
        receipt.visible !== owner.visible || !/^[a-f0-9]{40}$/.test(receipt.rendererSha ?? "") ||
        !/^[a-f0-9]{64}$/.test(receipt.contextDigest ?? "")) continue;
    if (post && Object.keys(post).length && (post.published?.sourceVersion !== owner.sourceVersion ||
        !owner.ownedSlugs.includes(post.published?.metadata?.slug) ||
        visible(post) !== owner.visible)) continue;
    if (!owner.visible && receipt.htmlDigest === null) retain({ postId: owner.postId, operationId: owner.operationId, revision: owner.generation,
      sourceVersion: owner.sourceVersion, ownedSlugs: [...new Set([...(entries.get(owner.postId)?.ownedSlugs ?? []), ...owner.ownedSlugs])], verifiedAt });
  }
  const value = { schemaVersion: 1, workerName, contextRevision: observation.contextRevision, withdrawals: [...entries.values()] };
  return JSON.parse(encodeWithdrawalManifest(value, workerName));
}

/** This is the cloud publisher's only mutable R2 object. Conditional writes
 * resume from a fresh observation; an older catalog never overwrites a new one. */
export async function publishWithdrawalCatalog(options: { store: CatalogStore | undefined; target: PublicationTarget;
  account: string; commitSha: string }, observe?: () => Promise<CatalogObservation>): Promise<void> {
  return publishWithdrawalCatalogObject({ store: options.store, key: withdrawalManifestKey(options.target.workerName),
    read: (object, signal) => readWithdrawalObject(object, options.target.workerName, signal),
    observe: signal => observe ? observe() : observeWithdrawalCatalog({ ...options, signal }),
    merge: (previous, observed) => mergeWithdrawalCatalog(previous, observed, options.target.workerName),
    encode: value => encodeWithdrawalManifest(value, options.target.workerName) });
}

/** Page and Post manifests use the same ETag-before-observation and bounded CAS protocol. */
export async function publishWithdrawalCatalogObject<Manifest>(options: { store: CatalogStore | undefined; key: string;
  read(object: WithdrawalObject, signal: AbortSignal): Promise<Manifest>;
  observe(signal: AbortSignal): Promise<CatalogObservation>;
  merge(previous: Manifest | null, observation: CatalogObservation): Promise<Manifest>;
  encode(value: Manifest): string }): Promise<void> {
  if (!options.store) refuse();
  const store = options.store;
  const key = options.key;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WITHDRAWAL_PUBLISH_TIMEOUT_MS);
  const signal = controller.signal;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const { current, previous } = await bounded(async () => {
        const current = await store.get(key);
        if (current && (typeof current.etag !== "string" || !current.etag || current.etag.length > 128)) {
          await current.body.cancel(); refuse();
        }
        return { current, previous: current ? await options.read(current, signal) : null };
      }, signal);
      const candidate = await options.merge(previous, await bounded(() => options.observe(signal), signal));
      const text = options.encode(candidate);
      if (previous && text === options.encode(previous)) return;
      const written = await bounded(() => store.put(key, text, {
        onlyIf: current ? { etagMatches: current.etag } : { etagDoesNotMatch: "*" },
        httpMetadata: { contentType: "application/json", cacheControl: "no-store" },
      }), signal);
      if (written) return;
    }
    refuse();
  } finally { clearTimeout(timer); }
}
