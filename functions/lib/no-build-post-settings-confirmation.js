"use strict";

const { createHash } = require("node:crypto");
const { publiclyVisible } = require("./public-video-references");
const { readNoBuildPostOwner } = require("./no-build-post-ownership");
const { readNoBuildPostDecisionInTransaction } = require("./no-build-post-publication");
const { joinedRecordIds } = require("./joined-records");
const { contentLink } = require("./content-link");
const { readPublicContextRevisionInTransaction, publicContextDigest } = require("./public-context-revision");
const { withinDeadline, verifyPublicHtml, readPublicPostAfterRefresh } = require("./no-build-post-recovery");

const { readSettingsInputs } = require("./settings-proof-transaction");

const MAX_POSTS = 500;
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function refuse(postId, reason) {
  throw Object.assign(new Error(`The settings Post proof for ${postId} ${reason}.`), { status: 409 });
}

/** The published roster, not the admitted catalog or sitemap, defines coverage.
 * Private later drafts do not change this roster or its public source seal. */
async function postSettingsCoverage({ firestore, transaction, identity, target, codeCapture }) {
  const [rows, pointer, revision] = await Promise.all([
    transaction.get(firestore.collection("cmsPosts").where("published.metadata.type", "==", "post").limit(MAX_POSTS + 1)),
    transaction.get(firestore.doc("system/publicDeployment")),
    readPublicContextRevisionInTransaction(transaction, firestore),
  ]);
  if (rows.size > MAX_POSTS) refuse("the published roster", "exceeds its bound");
  if (pointer.data()?.state !== "idle" || pointer.data()?.activeCommitSha !== identity.rendererSha ||
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
    const path = `/posts/${metadata.slug}/`;
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
  return { entries, missingPosts, rosterDigest };
}

async function readPostSettingsReceipt({ entry, target, headers, fetchPublic, signal }) {
  const expected = entry.receipt;
  const codePost = entry.kind === "code-post";
  const path = codePost ? expected.canonicalPath : `/posts/${expected.slug}/`;
  const status = entry.contentRedirectUrl ? 302 : 200;
  const response = await readPublicPostAfterRefresh(`${target.origin}${path}`, fetchPublic, signal, headers);
  try {
    if (response.status !== status || response.headers.get("cache-control") !== "no-store" ||
        response.headers.get("x-njpbs-content-source") !== (codePost ? "cms-code-post-context" : "cms-no-build") ||
        response.headers.get("x-njpbs-renderer-sha") !== expected.rendererSha ||
        response.headers.get("x-njpbs-context-sha256") !== expected.contextDigest ||
        response.headers.get("x-njpbs-source-version") !== String(expected.sourceVersion) ||
        status === 200 && !response.headers.get("content-type")?.startsWith("text/html") ||
        status === 302 && (response.headers.get("location") !== entry.contentRedirectUrl ||
          response.headers.get("x-robots-tag") !== "noindex, nofollow")) {
      refuse(entry.postId, `has an unavailable public receipt at ${path}`);
    }
    if (codePost) {
      const seals = { "x-njpbs-public-context-revision": String(expected.contextRevision),
        "x-njpbs-code-generation": String(expected.code.generation), "x-njpbs-code-receipt-sha256": expected.code.artifactReceiptDigest,
        "x-njpbs-code-context-sha256": expected.codeContextDigest, "x-njpbs-code-post-frame-sha256": expected.codeFrameDigest,
        "x-njpbs-input-source-sha256": expected.inputSourceDigest, "x-njpbs-snapshot-sha256": expected.snapshotDigest };
      if (Object.entries(seals).some(([key, value]) => response.headers.get(key) !== value) ||
          response.headers.has("x-njpbs-publication-operation") || response.headers.has("x-njpbs-admission-revision") ||
          !/^[a-f0-9]{64}$/.test(response.headers.get("x-njpbs-input-sha256") ?? "")) refuse(entry.postId, "has a changed CODE receipt");
    } else if (response.headers.get("x-njpbs-publication-operation") !== expected.operationId ||
        response.headers.get("x-njpbs-admission-revision") !== String(expected.admissionRevision)) {
      refuse(entry.postId, `has an unavailable public receipt at ${path}`);
    }
    return { postId: entry.postId, path, htmlDigest: status === 200 ? await verifyPublicHtml(response, 2 * 1024 * 1024, true) : null };
  } finally { await response.body?.cancel().catch(() => {}); }
}

/** Bound concurrent public reads and header/body time together. Every batch
 * must finish; a rejected or timed-out detail cannot acknowledge a subset. */
async function readSettingsProofs(values, read, { deadline, now, onFailure }) {
  const results = [];
  for (let offset = 0; offset < values.length; offset += 8) {
    if (now() >= deadline) throw new Error("Settings consumer confirmation timed out");
    const batch = await Promise.allSettled(values.slice(offset, offset + 8).map(async value => {
      try { return await withinDeadline(Math.min(10_000, deadline - now()), signal => read(value, signal)); }
      catch (error) {
        if (!onFailure) throw error;
        return onFailure(value, error);
      }
    }));
    const failed = batch.find(result => result.status === "rejected");
    if (failed) throw failed.reason;
    results.push(...batch.map(result => result.value));
  }
  return results;
}

module.exports = { postSettingsCoverage, readPostSettingsReceipt, readSettingsProofs };
