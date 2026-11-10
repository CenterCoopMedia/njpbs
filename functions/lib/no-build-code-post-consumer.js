"use strict";

const { isDeepStrictEqual } = require("node:util");
const { pagePublicationTarget } = require("./no-build-page-target");
const { readNoBuildPostOwner } = require("./no-build-post-ownership");
const { digest } = require("./no-build-page-ownership");
const { joinedRecordIds } = require("./joined-records");
const { publiclyVisible } = require("./public-video-references");
const { readPublicContextRevisionInTransaction, publicContextDigest } = require("./public-context-revision");
const { createPageCurrentCodeContextReader } = require("./no-build-page-schedule-reader");
const { readPublishedPost } = require("../published-post-reader");
const { readCachedCodePostContext } = require("./code-post-immutable-cache");

const captures = new WeakMap();
function refuse() { throw Object.assign(new Error("The current code Post context is unavailable."), { status: 409 }); }
function targetFor(firestore) {
  return pagePublicationTarget({ firestore });
}
async function codeAuthority({ firestore, transaction, rendererSha, code }) {
  const reference = code.reference;
  const [deployment, manifest] = await transaction.getAll(firestore.doc("system/publicDeployment"),
    firestore.doc(`cmsPreviewPublicContexts/${reference.publication.buildBatchId}`));
  const pointer = deployment.data(), stored = manifest.data();
  if (pointer?.state !== "idle" || pointer.activeCommitSha !== rendererSha ||
      pointer.activeGeneration !== reference.publication.generation || reference.publication.commitSha !== rendererSha ||
      Object.keys(reference.manifest).some(key => stored?.[key] !== reference.manifest[key])) refuse();
  return { pointer, manifest: stored };
}

/** Only existing immutable Posts with joined cards need this adapter. Dynamic
 * Post owners retain their existing publication and withdrawal reader. */
async function selectCodePost({ firestore, transaction, path }) {
  const match = typeof path === "string" && /^\/posts\/([a-z0-9]+(?:-[a-z0-9]+)*)\/$/.exec(path);
  if (!match || path.length > 512) return null;
  const query = firestore.collection("cmsPosts").where("published.metadata.type", "==", "post");
  const [canonical, aliases] = await Promise.all([
    transaction.get(query.where("published.metadata.slug", "==", match[1]).limit(2)),
    transaction.get(query.where("published.metadata.previousSlugs", "array-contains", match[1]).limit(2)),
  ]);
  const rows = new Map([...canonical.docs, ...aliases.docs].map(row => [row.id, row]));
  if (rows.size > 1) refuse();
  const row = [...rows.values()][0];
  if (!row || !joinedRecordIds(row.data().published?.blocks).length) return null;
  const owner = await readNoBuildPostOwner({ firestore, transaction, postId: row.id });
  if (owner.state && owner.state.mode !== "static") return null;
  const document = row.data(), version = document.published?.sourceVersion;
  if (!Number.isSafeInteger(version) || version < 1 || !Number.isSafeInteger(document.version) || document.version < version ||
      document.publicSourceVersion !== undefined && document.publicSourceVersion !== null &&
        (!Number.isSafeInteger(document.publicSourceVersion) || document.publicSourceVersion < 1 || document.publicSourceVersion > version)) refuse();
  return { documentId: row.id, document };
}

/** Qualify actual current code before the final SDK read. The private capture
 * cannot be supplied by an HTTP caller or reconstructed from an ordinary DTO. */
async function captureCodePostConsumers({ firestore, target = targetFor(firestore), rendererSha, request,
  now = Date.now, deadline = now() + 20_000 }) {
  target = pagePublicationTarget({ firestore, target });
  if (now() >= deadline) refuse();
  const signal = AbortSignal.timeout(Math.max(1, Math.ceil(deadline - now())));
  const read = createPageCurrentCodeContextReader({ firestore, target, rendererSha, request, signal });
  const reference = await read.readReference();
  const code = await readCachedCodePostContext({ firestore, identity: digest(reference), load: () => read() });
  if (!isDeepStrictEqual(code.reference, reference)) refuse();
  const authority = await firestore.runTransaction(transaction => codeAuthority({ firestore, transaction, rendererSha, code }), { readOnly: true });
  const after = await read.readReference();
  const afterAuthority = await firestore.runTransaction(transaction => codeAuthority({ firestore, transaction, rendererSha,
    code: { reference: after } }), { readOnly: true });
  if (!isDeepStrictEqual(reference, after) || !isDeepStrictEqual(authority, afterAuthority)) refuse();
  signal.throwIfAborted();
  const capture = Object.freeze({});
  captures.set(capture, { code, authority, rendererSha, target, signal, now, deadline });
  return capture;
}

async function readCodePostConsumerInTransaction({ firestore, transaction, path, rendererSha,
  target = targetFor(firestore), capture, now = new Date() }) {
  target = pagePublicationTarget({ firestore, target });
  const data = captures.get(capture);
  if (!data || data.target !== target || data.rendererSha !== rendererSha || data.now() >= data.deadline) refuse();
  data.signal.throwIfAborted();
  if (!isDeepStrictEqual(await codeAuthority({ firestore, transaction, rendererSha, code: data.code }), data.authority)) refuse();
  const selected = await selectCodePost({ firestore, transaction, path });
  if (!selected) return { kind: "pass" };
  if (!publiclyVisible(selected.document)) refuse();
  const frame = data.code.publicContext.posts.find(post => post.postId === selected.documentId);
  const family = data.code.publicContext.receipt.families.find(family => family.collection === "cmsPosts");
  const route = family?.complete === true && family.artifacts.find(route => route.documentId === selected.documentId);
  if (!frame || !route || selected.document.published.sourceVersion !== frame.sourceVersion ||
      selected.document.published.metadata.slug !== frame.slug || route.sourceVersion !== frame.sourceVersion ||
      route.canonicalPath !== frame.path || !(path === frame.path || route.aliases.includes(path))) refuse();
  const published = await readPublishedPost({ firestore, transaction, slug: frame.slug, now, allowLegacyVisibility: true });
  if (published.kind !== "published-post" || published.document.id !== selected.documentId) refuse();
  const contextRevision = await readPublicContextRevisionInTransaction(transaction, firestore);
  const receipt = { schemaVersion: 1, postId: selected.documentId, sourceVersion: frame.sourceVersion,
    canonicalPath: frame.path, path, rendererSha, snapshotDigest: digest(selected.document.published),
    contextRevision, contextDigest: publicContextDigest(contextRevision), code: data.code.publication,
    codeContextDigest: digest(data.code.publicContext), codeFrameDigest: digest(frame), inputSourceDigest: digest(published) };
  return path === frame.path ? { kind: "code-post", receipt, codeFrame: frame, published }
    : { kind: "code-post-alias", receipt, location: frame.path };
}

async function readCodePostConsumer({ firestore, path, rendererSha, target = targetFor(firestore), currentCodeRequest, log }) {
  target = pagePublicationTarget({ firestore, target });
  const selected = await firestore.runTransaction(transaction => selectCodePost({ firestore, transaction, path }), { readOnly: true });
  if (!selected) return { kind: "pass" };
  let stage = "capture";
  try {
    const capture = await captureCodePostConsumers({ firestore, target, rendererSha, request: currentCodeRequest });
    stage = "decision";
    return await firestore.runTransaction(transaction => readCodePostConsumerInTransaction({ firestore, transaction,
      path, rendererSha, target, capture }), { readOnly: true });
  } catch (error) {
    // Transport errors can carry private URLs. Emit only fixed reason classes.
    const reason = error.name === "AbortError" || error.name === "TimeoutError" ? "timeout"
      : error.status === 409 ? "qualification_refused" : "context_unavailable";
    log?.warn?.("Code Post qualification refused", { path, stage, reason, status: error.status === 409 ? 409 : 503 });
    return { kind: "code-post-unavailable" };
  }
}
module.exports = { captureCodePostConsumers, readCodePostConsumerInTransaction, readCodePostConsumer };
