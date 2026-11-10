"use strict";
const { createHash } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { homeCatalogJson, readHomeEditorialSourceReceipt, resolveHomeShelf, resolveHomeNewsletter } = require("./home-source-catalog");
const { readPublicBackgroundContextInTransaction, PUBLIC_CONTEXT_PATH, publicContextDigest } = require("./public-context-revision");
const { publiclyVisible } = require("./public-video-references");
class HomeSelectionAdmissionError extends Error {
  constructor(message, publicMessage = "The published Home catalog is unavailable. Reload the cards before changing their selection.") {
    super(message); this.code = "HOME_SELECTION_ADMISSION"; this.publicMessage = publicMessage;
  }
}
const HOME_CATALOGS_COLLECTION = "cmsHomeSourceCatalogs";

function assertHomeCatalogReceipt(value) {
  let source;
  try { source = readHomeEditorialSourceReceipt(value); }
  catch { throw new HomeSelectionAdmissionError("Home catalog schema is invalid."); }
  if (createHash("sha256").update(homeCatalogJson(source.catalog)).digest("hex") !== source.receipt.digest) {
    throw new HomeSelectionAdmissionError("Home catalog digest does not match its public entries.");
  }
  return source;
}
function sealHomeCatalog(catalog, publication) {
  return assertHomeCatalogReceipt({ catalog, receipt: { buildBatchId: publication.buildBatchId,
    generation: publication.generation, commitSha: publication.commitSha,
    digest: createHash("sha256").update(homeCatalogJson(catalog)).digest("hex") } });
}

async function readPageHomeCatalogIdentityInTransaction({ firestore, transaction }) {
  const { readHomePageAuthorityInTransaction, HOME_PAGE_OWNER } = require("./no-build-home-ownership");
  let owner;
  try { owner = await readHomePageAuthorityInTransaction({ firestore, transaction }); }
  catch (error) {
    if (error.status !== 409) throw error;
    throw new HomeSelectionAdmissionError("Page Home authority is unavailable.");
  }
  if (!owner) return null;
  const [deployment, context, home] = await transaction.getAll(firestore.doc("system/publicDeployment"),
    firestore.doc(PUBLIC_CONTEXT_PATH), firestore.doc("cmsPages/home"));
  const pointer = deployment.data();
  const revision = context.data()?.revision;
  if (pointer?.state !== "idle" || !/^[a-f0-9]{40}$/.test(pointer.activeCommitSha ?? "") ||
      !Number.isSafeInteger(pointer.activeGeneration) || pointer.activeGeneration < 1 ||
      context.data()?.schemaVersion !== 1 || !Number.isSafeInteger(revision) || revision < 1 ||
      !owner.visible || !publiclyVisible(home.data()) || home.data()?.published?.sourceVersion !== owner.sourceVersion) {
    throw new HomeSelectionAdmissionError("Page Home catalog authority is unavailable.");
  }
  const homeRefreshRevision = owner.homeRefresh?.revision ?? 0;
  if (!Number.isSafeInteger(homeRefreshRevision) || homeRefreshRevision < 0) throw new HomeSelectionAdmissionError("Page Home refresh identity is invalid.");
  return { owner, publication: { buildBatchId: owner.operationId,
    generation: Math.max(owner.generation, pointer.activeGeneration), commitSha: pointer.activeCommitSha },
  page: { schemaVersion: 1, owner: HOME_PAGE_OWNER, operationId: owner.operationId, sourceVersion: owner.sourceVersion,
    contextRevision: revision, contextDigest: publicContextDigest(revision), homeRefreshRevision } };
}

/** Confirmation supplies the catalog proved at both public Home routes. Reads
 * precede writes; its closure joins the caller's fenced settlement transaction. */
async function preparePageHomeCatalogInTransaction({ firestore, transaction, state, source, rendererSha, contextDigest, homeRefreshRevision }) {
  const identity = await readPageHomeCatalogIdentityInTransaction({ firestore, transaction });
  const catalog = assertHomeCatalogReceipt(source);
  if (!identity || !isDeepStrictEqual(identity.owner, state) || rendererSha !== identity.publication.commitSha ||
      contextDigest !== identity.page.contextDigest || homeRefreshRevision !== identity.page.homeRefreshRevision ||
      !isDeepStrictEqual({ buildBatchId: catalog.receipt.buildBatchId, generation: catalog.receipt.generation,
        commitSha: catalog.receipt.commitSha }, identity.publication)) throw new HomeSelectionAdmissionError("Page Home catalog proof changed.");
  const ref = firestore.collection(HOME_CATALOGS_COLLECTION).doc(identity.owner.operationId);
  const existing = (await transaction.get(ref)).data();
  if (existing && (existing.page?.owner !== identity.page.owner || existing.page.operationId !== identity.page.operationId ||
      existing.page.contextRevision > identity.page.contextRevision ||
      isDeepStrictEqual(existing.page, identity.page) && existing.receipt?.commitSha === rendererSha &&
        existing.receipt?.digest !== catalog.receipt.digest)) throw new HomeSelectionAdmissionError("Page Home catalog identity changed.");
  return () => transaction.set(ref, { ...catalog, page: identity.page });
}

/** All reads stay inside the content transaction and before any content/history write. */
async function verifyHomeSelections({ firestore, transaction, blocks, previousBlocks = [] }) {
  const ids = block => block.type === "newsletter_signup" ? block.data.newsletterIds : block.data.selectedIds;
  const isNewsletter = block => block.type === "newsletter_signup" && block.section === "home-newsletter";
  const changed = blocks.filter(block => (isNewsletter(block) && block.data.newsletterIds.length > 0 || block.type === "content_shelf" && block.data.selectedIds !== undefined) &&
    !previousBlocks.some(previous => previous.id === block.id && previous.section === block.section &&
      previous.data?.source === block.data.source && isDeepStrictEqual(ids(previous), ids(block)) &&
      isDeepStrictEqual(previous.data?.selectionReceipt, block.data.selectionReceipt)));
  if (!changed.length) return;
  const home = await transaction.get(firestore.doc("cmsBackgroundOutputs/home"));
  const pageIdentity = await readPageHomeCatalogIdentityInTransaction({ firestore, transaction });
  let currentReceipt;
  let pointer;
  const catalogs = new Map();
  if (pageIdentity) {
    const row = (await transaction.get(firestore.collection(HOME_CATALOGS_COLLECTION).doc(pageIdentity.owner.operationId))).data();
    const source = assertHomeCatalogReceipt({ catalog: row?.catalog, receipt: row?.receipt });
    if (!isDeepStrictEqual(row.page, pageIdentity.page) ||
        !isDeepStrictEqual({ buildBatchId: source.receipt.buildBatchId, generation: source.receipt.generation,
          commitSha: source.receipt.commitSha }, pageIdentity.publication)) throw new HomeSelectionAdmissionError("Page Home catalog is not current.");
    currentReceipt = source.receipt;
    catalogs.set(source.receipt.buildBatchId, source);
  } else if (home.exists) {
    const state = home.data();
    const receipt = state?.receipt;
    if (state?.schemaVersion === 1 && state.owner === "post-background-v1" && state.status === "verified" &&
        Number.isSafeInteger(state.revision) && state.revision > 0 && receipt?.revision === state.revision &&
        receipt.homeSourceReceipt) {
      const context = await readPublicBackgroundContextInTransaction(transaction, firestore);
      const runtime = state.runtime;
      const runtimeMatches = runtime === undefined ? receipt.runtime === undefined :
        ["node-compute", "cloudflare"].includes(runtime.owner) && runtime.release === context.rendererSha &&
        isDeepStrictEqual(runtime, receipt.runtime);
      if (state.contextDigest === context.digest && receipt.contextDigest === context.digest &&
          receipt.rendererSha === context.rendererSha && runtimeMatches) {
        // Reuse the public reader's exact pilot/lease/source/media policy within this save transaction.
        // Typed admission refusals cause the public Home reader to fall through to full-build Assets.
        try {
          const decision = await require("./no-build-post-publication").readNoBuildPostDecisionInTransaction({
            firestore, transaction, path: "/", rendererSha: context.rendererSha,
          });
          if (decision.kind === "background") currentReceipt = receipt.homeSourceReceipt;
        } catch (error) { if (error.status !== 409) throw error; }
      }
    }
  }
  if (!currentReceipt) {
    // The publisher also imports this receipt contract; avoid a module-load cycle.
    pointer = (await transaction.get(require("./public-deployment-coordinator").publicDeploymentRef(firestore))).data();
  }
  for (const block of changed) {
    const receipt = block.data.selectionReceipt;
    if (currentReceipt ? !isDeepStrictEqual(receipt, currentReceipt) :
        receipt.generation !== pointer?.activeGeneration || receipt.commitSha !== pointer?.activeCommitSha) {
      throw new HomeSelectionAdmissionError("Home catalog is not current.", "The published Home catalog changed. Reload the cards before changing their selection.");
    }
    let source = catalogs.get(receipt.buildBatchId);
    if (!source) {
      source = assertHomeCatalogReceipt((await transaction.get(firestore.collection(HOME_CATALOGS_COLLECTION).doc(receipt.buildBatchId))).data());
      catalogs.set(receipt.buildBatchId, source);
    }
    if (!isDeepStrictEqual(receipt, source.receipt)) throw new HomeSelectionAdmissionError("The Home selection receipt is not the published catalog receipt.");
    const resolved = isNewsletter(block) ? resolveHomeNewsletter(block, source.catalog) : resolveHomeShelf(block, source.catalog);
    const previous = previousBlocks.find(candidate => candidate.id === block.id && candidate.section === block.section &&
      candidate.data?.source === block.data.source);
    if ((isNewsletter(block) ? source.catalog.services?.newsletters : source.catalog.sources[block.section])?.status !== "ready" &&
        ids(block).some(id => !previous || !ids(previous)?.includes(id))) {
      throw new HomeSelectionAdmissionError("The selected Home source is unavailable.", "Published cards are unavailable. Reload them before adding a new selection.");
    }
    if (isNewsletter(block)) {
      // A retained picker receipt cannot authorize a newly selected record that
      // has since been archived, revoked or replaced by a newer approval.
      const { approvedLibraryVersion } = require("./approved-library-records");
      for (const card of resolved.cards) {
        if (previous && ids(previous)?.includes(card.id)) continue;
        const record = (await transaction.get(firestore.doc(`cmsPosts/${card.id}`))).data();
        const history = await transaction.get(firestore.collection("cmsVersionHistory")
          .where("collection", "==", "cmsPosts").where("documentId", "==", card.id));
        const approved = record && approvedLibraryVersion({ ...record, id: card.id }, history.docs.map(doc => doc.data()));
        if (!approved || approved.type !== "newsletter" || approved.version !== card.sourceVersion) {
          throw new HomeSelectionAdmissionError("The selected Newsletter approval changed.", "This Newsletter changed or is unavailable. Reload published Newsletters before selecting it.");
        }
      }
    }
    // Keep already admitted IDs across withdrawal and reordering, but never admit a new missing ID.
    if (resolved.missingIds.some(id => !previous || !ids(previous)?.includes(id))) {
      throw new HomeSelectionAdmissionError("A selected Home card is not published in its assigned source.", "A selected Home card is no longer published. Remove it before saving this new selection.");
    }
  }
}
module.exports = { HomeSelectionAdmissionError, HOME_CATALOGS_COLLECTION, assertHomeCatalogReceipt, sealHomeCatalog,
  readPageHomeCatalogIdentityInTransaction, preparePageHomeCatalogInTransaction, verifyHomeSelections };
