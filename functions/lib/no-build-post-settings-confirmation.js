"use strict";

const { postRoutePath } = require("./post-slug-contract");
const { createHash } = require("node:crypto");
const { publiclyVisible } = require("./public-video-references");
const { readNoBuildPostOwner } = require("./no-build-post-ownership");
const { readNoBuildPostDecisionInTransaction } = require("./no-build-post-publication");
const { joinedRecordIds } = require("./joined-records");
const { contentLink } = require("./content-link");
const { readPublicContextRevisionInTransaction, publicContextDigest } = require("./public-context-revision");
const { readPublicAnswer, REFRESH_PENDING, verifyPublicHtml, readPublicPostAfterRefresh } = require("./no-build-post-recovery");

const { readSettingsInputs } = require("./settings-proof-transaction");

const MAX_POSTS = 500;
const PROOF_BATCH_SIZE = 8;
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function refuse(postId, reason, code = "post_coverage_moved") {
  throw Object.assign(new Error(`The settings Post proof for ${postId} ${reason}.`), { status: 409, code });
}
const refuseReceipt = (postId, reason) => refuse(postId, reason, "public_receipt_refused");

/** The published roster, not the admitted catalog or sitemap, defines coverage.
 * Private later drafts do not change this roster or its public source seal. */
async function postSettingsCoverage({ firestore, transaction, identity, target, codeCapture }) {
  const [rows, pointer, revision] = await Promise.all([
    transaction.get(firestore.collection("cmsPosts").where("published.metadata.type", "==", "post").limit(MAX_POSTS + 1)),
    transaction.get(firestore.doc("system/publicDeployment")),
    readPublicContextRevisionInTransaction(transaction, firestore),
  ]);
  if (rows.size > MAX_POSTS) refuse("the published roster", "exceeds its bound");
  const deployment = pointer.data();
  if (deployment?.state !== "idle" || deployment.activeCommitSha !== identity.rendererSha ||
      revision !== identity.contextRevision || publicContextDigest(revision) !== identity.contextDigest) {
    refuse("the published roster", "has a changed renderer or public context");
  }
  const recordId = identity.recordId ?? identity.documentId;
  const ctaSettings = recordId ? await transaction.get(firestore.doc("cmsSettings/story-ctas")) : null;
  const ctaIds = require("./story-cta-dependencies").storyCtaNewsletterIds(ctaSettings?.data());
  const required = rows.docs.filter(row => {
    const document = row.data(), published = document.published;
    return publiclyVisible(document) && (!recordId || joinedRecordIds(published.blocks).includes(recordId) ||
      published.metadata.disableStoryCtas !== true && ctaIds.includes(recordId));
  })
    .sort((a, b) => a.id.localeCompare(b.id));
  const missingPosts = [];
  const entries = [];
  // Native decisions share one snapshot; independent Posts need not wait for
  // every preceding Post's SDK round trips before starting their own checks.
  const results = await readSettingsInputs(required, async row => {
    const owner = await readNoBuildPostOwner({ firestore, transaction, postId: row.id });
    const metadata = row.data().published.metadata;
    const path = postRoutePath(metadata.slug);
    const link = contentLink(metadata, path);
    const destination = link.external ? { contentRedirectUrl: link.href } : {};
    if (!owner.state?.operationId || owner.state.mode === "static") {
      if (!codeCapture) return { missingPost: row.id };
      const decision = await require("./no-build-code-post-consumer").readCodePostConsumerInTransaction({
        firestore, transaction, path, rendererSha: identity.rendererSha, target, capture: codeCapture });
      if (decision.kind !== "code-post" || decision.receipt.postId !== row.id ||
          decision.receipt.contextRevision !== identity.contextRevision || decision.receipt.contextDigest !== identity.contextDigest) {
        return { missingPost: row.id };
      }
      return { entry: { kind: "code-post", postId: row.id, receipt: decision.receipt, sourceDigest: digest(decision.published), ...destination } };
    }
    if (![metadata.slug, ...(metadata.previousSlugs ?? [])].every(slug => owner.state.ownedSlugs.includes(slug))) {
      refuse(row.id, "does not retain every published route");
    }
    const decision = await readNoBuildPostDecisionInTransaction({ firestore, transaction, path, rendererSha: identity.rendererSha });
    if (decision.kind !== "post" || decision.receipt.postId !== row.id ||
        decision.receipt.rendererSha !== identity.rendererSha || decision.receipt.contextDigest !== identity.contextDigest) {
      refuse(row.id, "has no current request-time detail");
    }
    return { entry: { postId: row.id, receipt: decision.receipt, sourceDigest: digest(decision.published), ...destination } };
  });
  for (const result of results) {
    if (result.missingPost) missingPosts.push(result.missingPost);
    else entries.push(result.entry);
  }
  // Include invisible published rows: a withdrawal or republication during IO
  // must invalidate the captured roster, even when it removes a required detail.
  const rosterDigest = digest(rows.docs.map(row => ({ id: row.id, published: row.data().published,
    visible: publiclyVisible(row.data()) })).sort((a, b) => a.id.localeCompare(b.id)));
  return { entries, missingPosts, rosterDigest, deploymentGeneration: deployment.activeGeneration,
    deploymentId: deployment.activeDeploymentId };
}

async function readPostSettingsReceipt({ entry, target, headers, fetchPublic, signal, once = false }) {
  const expected = entry.receipt;
  const codePost = entry.kind === "code-post";
  const path = codePost ? expected.canonicalPath : postRoutePath(expected.slug);
  const status = entry.contentRedirectUrl ? 302 : 200;
  const response = await readPublicPostAfterRefresh(`${target.origin}${path}`, fetchPublic, signal, headers, { once });
  try {
    if (response.status !== status || response.headers.get("cache-control") !== "no-store" ||
        response.headers.get("x-njpbs-content-source") !== (codePost ? "cms-code-post-context" : "cms-no-build") ||
        response.headers.get("x-njpbs-renderer-sha") !== expected.rendererSha ||
        response.headers.get("x-njpbs-context-sha256") !== expected.contextDigest ||
        response.headers.get("x-njpbs-source-version") !== String(expected.sourceVersion) ||
        status === 200 && !response.headers.get("content-type")?.startsWith("text/html") ||
        status === 302 && (response.headers.get("location") !== entry.contentRedirectUrl ||
          response.headers.get("x-robots-tag") !== "noindex, nofollow")) {
      refuseReceipt(entry.postId, `has an unavailable public receipt at ${path}`);
    }
    if (codePost) {
      const seals = { "x-njpbs-public-context-revision": String(expected.contextRevision),
        "x-njpbs-code-generation": String(expected.code.generation), "x-njpbs-code-receipt-sha256": expected.code.artifactReceiptDigest,
        "x-njpbs-code-context-sha256": expected.codeContextDigest, "x-njpbs-code-post-frame-sha256": expected.codeFrameDigest,
        "x-njpbs-input-source-sha256": expected.inputSourceDigest, "x-njpbs-snapshot-sha256": expected.snapshotDigest };
      if (Object.entries(seals).some(([key, value]) => response.headers.get(key) !== value) ||
          response.headers.has("x-njpbs-publication-operation") || response.headers.has("x-njpbs-admission-revision") ||
          !/^[a-f0-9]{64}$/.test(response.headers.get("x-njpbs-input-sha256") ?? "")) refuseReceipt(entry.postId, "has a changed CODE receipt");
    } else if (response.headers.get("x-njpbs-publication-operation") !== expected.operationId ||
        response.headers.get("x-njpbs-admission-revision") !== String(expected.admissionRevision)) {
      refuseReceipt(entry.postId, `has an unavailable public receipt at ${path}`);
    }
    return { postId: entry.postId, path, htmlDigest: status === 200 ? await verifyPublicHtml(response, 2 * 1024 * 1024, true) : null };
  } finally { await response.body?.cancel().catch(() => {}); }
}

/** Every read must finish with its own answer; one refused detail cannot
 * acknowledge a subset. Eight reads run at once, and a route that reports its
 * refresh gives its place to the next one while it waits. */
async function readSettingsProofs(values, read, { onFailure = undefined, onDone = undefined } = {}) {
  const results = [], waiting = new Set(values.keys()), running = [];
  const stop = new AbortController();
  let failed = null;
  const stopped = new Promise((resolve, reject) => {
    stop.signal.addEventListener("abort", () => { if (failed) reject(failed.error); else resolve(); }, { once: true });
  });
  stopped.catch(() => {});
  const attempt = async (value, index, onPending) => {
    try {
      results[index] = await readPublicAnswer("settings proof read", signal => read(value, signal), { onPending, stop: stop.signal });
    } catch (error) {
      if (stop.signal.aborted) return;
      if (!onFailure) { failed ??= { error }; stop.abort(); return; }
      try { results[index] = await onFailure(value, error); }
      catch (thrown) { failed ??= { error: thrown }; stop.abort(); return; }
      onDone?.([...waiting]);
      return;
    }
    waiting.delete(index);
    onDone?.([...waiting]);
  };
  const next = values.entries();
  const worker = async () => {
    for (const [index, value] of next) {
      if (stop.signal.aborted) return;
      await new Promise(resolve => {
        const read = attempt(value, index, resolve);
        read.then(resolve, resolve);
        running.push(read);
      });
    }
  };
  try {
    await Promise.race([stopped, Promise.all(Array.from({ length: PROOF_BATCH_SIZE }, worker)).then(() => Promise.all(running))]);
    return results;
  } finally { stop.abort(); }
}

/** Cover an ordered prefix of one exact roster. A wake can end at the platform
 * limit; the stored prefix continues at the next one. */
async function readPostSettingsProof({ coverage, target, headers, fetchPublic, proof, once = false }) {
  const { entries } = coverage;
  const coverageDigest = digest([target.origin, coverage]);
  const prior = proof.postCheckpoint;
  const start = prior?.coverageDigest === coverageDigest && Number.isSafeInteger(prior.verified) &&
    prior.verified > 0 && prior.verified <= entries.length ? prior.verified : 0;
  if (prior && !start) proof.recordPostCheckpoint(null);
  let verified = start, pending = null;
  await readSettingsProofs(entries.slice(start), (entry, signal) => readPostSettingsReceipt({ entry, target, headers, fetchPublic, signal, once }), {
    // A refreshing detail waits for the next wake beside the rest of this pass.
    ...(once ? { onFailure(entry, error) {
      if (error?.code !== REFRESH_PENDING) throw error;
      pending ??= error;
    } } : {}),
    onDone(waiting) {
      const prefix = waiting.length ? start + Math.min(...waiting) : entries.length;
      proof.waitingOn(`posts ${entries.length - start - waiting.length} of ${entries.length - start}`);
      if (prefix < verified + PROOF_BATCH_SIZE && prefix < entries.length) return;
      verified = prefix;
      proof.recordPostCheckpoint({ coverageDigest, verified });
    },
  });
  if (pending) throw pending;
}

module.exports = { postSettingsCoverage, readPostSettingsReceipt, readSettingsProofs, readPostSettingsProof };
