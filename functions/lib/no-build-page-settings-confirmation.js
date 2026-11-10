"use strict";

const logger = require("firebase-functions/logger");
const { confirmationErrorCauses } = require("./confirmation-error-causes");
const { PUBLIC_PAGE_DEFINITIONS, publicPageDefinition, publicPagePath } = require("./public-page-contract");
const { listNoBuildPageOwners, readNoBuildPageCapability, digest, refuse } = require("./no-build-page-ownership");
const { pagePublicationTarget } = require("./no-build-page-target");
const { createHash } = require("node:crypto");
const { capturePageSchedule, assertPageScheduleCapture } = require("./no-build-page-schedule-reader");
const { createHomeProviderCapture } = require("./no-build-home-provider-capture");
const { capturePageHomeCodeSourcesIfNeeded, readCapturedPageHomeCodeSourcesInTransaction } = require("./no-build-page-home-code-capture");
const { readPageAuthorityInTransaction } = require("./no-build-page-serving");
const { PUBLIC_PAGE_HTML_MAX_BYTES, readPublicPageReceipt, recoverNoBuildHomeCatalog } = require("./no-build-page-recovery");
const { readNoBuildPageContextDecision } = require("./no-build-page-context-decision");
const { projectPublishedCmsSettings } = require("./cms-settings-contract");
const { assertReadbackTarget, publicReadbackHeaders, withinDeadline, verifyPublicHtml, readPublicPostAfterRefresh } = require("./no-build-post-recovery");
const { postSettingsCoverage, readPostSettingsReceipt, readSettingsProofs } = require("./no-build-post-settings-confirmation");

const { readRenderedRecordSourceReceipt, assertRecordSourceBinding, assertRenderedRecordSourceBinding } = require("./no-build-page-source-binding");
const { claimPageConsumerProof } = require("./page-consumer-proof");

const { settingsProofTransaction, readSettingsInputs } = require("./settings-proof-transaction");

const MAX_PAGES = 500 + Object.keys(PUBLIC_PAGE_DEFINITIONS).length;
function unavailablePageConsumers(failures, log) {
  const missingPages = [...new Set(failures.map(failure => failure.pageId))].sort();
  log.warn("Page consumer confirmation is unavailable", {
    missingPages: missingPages.filter(id => typeof id === "string" && publicPageDefinition(id)).slice(0, 8),
    missingPageCount: missingPages.length,
    failures: failures.filter(failure => typeof failure.pageId === "string" && publicPageDefinition(failure.pageId))
      .slice(0, 8).map(({ pageId, error }) => ({ pageId, causes: confirmationErrorCauses(error) })),
  });
  return { confirmed: false, missingPages };
}
function requiredPages(rows, capability) {
  const required = new Set(Object.keys(PUBLIC_PAGE_DEFINITIONS));
  for (const row of rows.docs) if (row.data().published) required.add(row.id);
  // A gated, unowned route has no public settings consumer to prove. Retained
  // owners are still checked below; an owned route can never bypass its fence.
  if (capability?.dataHubReportingVersion !== 1) required.delete("data-hub");
  return required;
}
async function pageProofPrerequisites({ firestore, transaction, rendererSha }) {
  const [rows, deployment, context, capability] = await Promise.all([
    transaction.get(firestore.collection("cmsPages").limit(MAX_PAGES + 1)),
    transaction.get(firestore.doc("system/publicDeployment")),
    transaction.get(firestore.doc("system/publicDeployment/contexts/public")),
    readNoBuildPageCapability({ firestore, transaction }),
  ]);
  if (rows.size > MAX_PAGES) refuse("The Page settings proof exceeds its bound.");
  const required = requiredPages(rows,capability);
  const pointer = deployment.data();
  const publicContext = context.data();
  if (!capability?.servingEnabled || capability.rendererSha !== rendererSha ||
      pointer?.state !== "idle" || pointer.activeCommitSha !== rendererSha ||
      !Number.isSafeInteger(pointer.activeGeneration) || pointer.activeGeneration < 1 ||
      publicContext?.schemaVersion !== 1 || !Number.isSafeInteger(publicContext.revision) || publicContext.revision < 1) {
    return { missingPages: [...required].sort(), repairHomeCatalog: false };
  }
  const missing = new Set();
  if (!publicContext.externalInputs?.schedulePacket) { missing.add("schedule"); missing.add("live"); }
  for (const row of rows.docs) {
    const published = row.data().published;
    if (published && !Object.hasOwn(PUBLIC_PAGE_DEFINITIONS, row.id) && !publicPagePath(row.id, published.metadata)) missing.add(row.id);
  }
  return { missingPages: [...missing].sort(), repairHomeCatalog: true };
}

async function pageCoverage({ firestore, transaction, rendererSha, target, scheduleCapture, readHomeSource, homeCodeCapture }) {
  const [rows,capability] = await Promise.all([
    transaction.get(firestore.collection("cmsPages").limit(MAX_PAGES + 1)),
    readNoBuildPageCapability({firestore,transaction}),
  ]);
  if (rows.size > MAX_PAGES) refuse("The Page settings proof exceeds its bound.");
  const required = requiredPages(rows,capability);
  const owners = await listNoBuildPageOwners({ firestore, transaction });
  if (owners.length > MAX_PAGES) refuse();
  const contexts = [];
  const missing = [];
  const unowned = [...required].filter(id => !owners.some(owner => owner.state.pageId === id));
  const contextGroups = await readSettingsInputs(unowned, async id => {
    const contexts = [];
    if (id === "home") {
      if (!homeCodeCapture) return { missing: id, contexts };
      const home = await readCapturedPageHomeCodeSourcesInTransaction({ firestore, transaction, rendererSha, target, capture: homeCodeCapture });
      const decision = await readNoBuildPageContextDecision({ firestore, transaction,
        path: "/", rendererSha, target, scheduleCapture });
      if (decision.kind !== "context-page") refuse("The current Home frame is unavailable.");
      contexts.push({ pageId: id, path: "/", decision: { ...decision, ...home } },
        { pageId: id, path: "/_home-sources.json", decision: { kind: "code-home-sources", receipt: decision.receipt, ...home } });
      return { contexts };
    }
    const definition = PUBLIC_PAGE_DEFINITIONS[id];
    const document = rows.docs.find(row => row.id === id)?.data();
    const metadata = document?.published?.metadata;
    const paths = new Set([definition?.path, ...(definition?.aliases ?? []),
      ...(metadata?.slug ? [`/${metadata.slug}/`] : []),
      ...(metadata?.previousSlugs ?? []).map(slug => `/${slug}/`)].filter(Boolean));
    if (!paths.size) return { missing: id, contexts };
    for (const path of paths) {
      try {
        const decision = await readNoBuildPageContextDecision({ firestore, transaction,
          path, rendererSha, target, scheduleCapture });
        if (decision.kind === "pass") return { missing: id, contexts };
        contexts.push({ pageId: id, path, decision });
      } catch (error) {
        if (error.status !== 409) throw error;
        return { missing: id, contexts };
      }
    }
    return { contexts };
  });
  for (const group of contextGroups) {
    contexts.push(...group.contexts);
    if (group.missing) missing.push(group.missing);
  }
  const rosterDigest = digest(rows.docs.map(row => ({ id: row.id, published: row.data().published ?? null,
    visible: row.data().publiclyVisible ?? row.data().status === "published" })).sort((a, b) => a.id.localeCompare(b.id)));
  const owned = await readSettingsInputs(owners, async ({ state }) => {
    const authority = await readPageAuthorityInTransaction({ firestore, transaction, state, rendererSha, target });
    if (state.visible) return { pageId: state.pageId,
      rendered: await require("./no-build-page-render-context").assertNoBuildPageContextInTransaction({
        firestore, transaction, pageId: state.pageId, rendererSha, nextDocument: authority.document,
        target, scheduleCapture }),
      ...(state.pageId === "home" ? { home: await require("./no-build-home-ownership").readHomeSourcesInTransaction({
        firestore, transaction, state, rendererSha, readHomeSource, homeCodeCapture, target }) } : {}) };
    return null;
  });
  const ownedContexts = owned.filter(Boolean);
  return { owners, contexts, ownedContexts, missing: [...new Set(missing)].sort(), rosterDigest };
}

// A Location header resolves against the URL that was requested, as a browser
// resolves it; the Page decision's location is site-relative.
function sameDestination(location, expected, requested) {
  if (typeof location !== "string" || typeof expected !== "string") return false;
  try {
    const actual = new URL(location, requested);
    return actual.origin === new URL(requested).origin && actual.href === new URL(expected, requested).href;
  } catch { return false; }
}

async function readContextReceipt({ path, decision, target, headers, fetchPublic, signal = AbortSignal.timeout(10_000) }) {
  const expected = decision.receipt;
  const response = await readPublicPostAfterRefresh(`${target.origin}${path}`, fetchPublic, signal, headers);
  const contentRedirectUrl = path !== "/_home-sources.json" && decision.renderContext?.page?.contentLinkMode === "custom" ? new URL(decision.renderContext.page.contentLinkUrl).href : null;
  const status = decision.kind === "redirect" ? 308 : decision.kind === "gone" ? 410 : contentRedirectUrl ? 302 : 200;
  try {
    // The public Worker's hand-picked legacy table answers some former routes
    // before the CMS Page path (site/src/lib/legacy-redirects.ts, #3450). That
    // redirect carries no Page context, so it cannot be stale. Accept it only
    // when it sends readers to the same destination as the Page decision.
    if (decision.kind === "redirect" && response.status === 301 && !response.headers.has("x-njpbs-content-source") &&
        sameDestination(response.headers.get("location"), decision.location, `${target.origin}${path}`)) {
      return { path, identity: expected, bodyDigest: null, legacyRedirect: true };
    }
    if (decision.kind === "code-home-sources") {
      if (response.status !== 200 || response.headers.get("cache-control") !== "no-store" ||
          response.headers.get("x-njpbs-content-source") !== "assets" ||
          !response.headers.get("content-type")?.startsWith("application/json")) refuse("The CODE Home catalog is unavailable.");
      const chunks = [];
      const bodyDigest = await verifyPublicHtml(response, 2 * 1024 * 1024, false, chunk => chunks.push(Buffer.from(chunk)));
      if (digest(JSON.parse(Buffer.concat(chunks).toString("utf8"))) !== digest(decision.homeSources)) {
        refuse("The public CODE Home catalog differs from the captured source.");
      }
      return { path, identity: expected, bodyDigest, codeSource: decision.codeSource };
    }
    if (response.status !== status || response.headers.get("cache-control") !== "no-store" ||
        response.headers.get("x-njpbs-content-source") !== "cms-page-context" ||
        response.headers.get("x-njpbs-renderer-sha") !== expected.rendererSha ||
        response.headers.get("x-njpbs-context-sha256") !== expected.contextDigest ||
        response.headers.get("x-njpbs-public-context-revision") !== String(expected.contextRevision) ||
        response.headers.get("x-njpbs-code-generation") !== String(expected.codeGeneration) ||
        response.headers.get("x-njpbs-page-path") !== expected.path ||
        response.headers.get("x-njpbs-source-version") !== (expected.sourceVersion === undefined ? null : String(expected.sourceVersion)) ||
        response.headers.has("x-njpbs-publication-operation") ||
        status === 308 && response.headers.get("location") !== decision.location ||
        status === 302 && (response.headers.get("location") !== contentRedirectUrl || response.headers.get("x-robots-tag") !== "noindex, nofollow") ||
        status === 200 && !response.headers.get("content-type")?.startsWith(path === "/_home-sources.json" ? "application/json" : "text/html")) refuse("Page context receipt is unavailable.");
    const bodyDigest = status === 200 ? await verifyPublicHtml(response,
      path === "/_home-sources.json" ? 2 * 1024 * 1024 : PUBLIC_PAGE_HTML_MAX_BYTES, path !== "/_home-sources.json") : null;
    const rendered = [200, 302].includes(status) ? readRenderedRecordSourceReceipt(response) : null;
    if (rendered) assertRecordSourceBinding(rendered, decision.renderContext);
    const schedule = decision.renderContext?.schedule;
    const scheduleReceiptDigest = schedule && createHash("sha256").update(JSON.stringify(schedule.receipt)).digest("hex");
    if (scheduleReceiptDigest && response.headers.get("x-njpbs-schedule-receipt-sha256") !== scheduleReceiptDigest) {
      refuse("The rendered Schedule/Live packet differs.");
    }
    return { path, identity: expected, bodyDigest, ...(rendered ?? {}), ...(scheduleReceiptDigest ? { scheduleReceiptDigest } : {}) };
  } finally { await response.body?.cancel().catch(() => {}); }
}

/** A subset never acknowledges the family. Committed and unowned frames use
 * current authority; Schedule/Live require their sealed packet capture. */
async function confirmNoBuildPageSettings({ firestore, operationId, target, headers = {}, fetchPublic = fetch,
  now = Date.now, deadline = now() + 45_000, currentCodeRequest, log = logger, fetchPurge, purgeConfig }) {
  target = pagePublicationTarget({ firestore, target: assertReadbackTarget(firestore, target) });
  headers = publicReadbackHeaders(target, headers);
  if (!/^[A-Za-z0-9]{20}$/.test(operationId ?? "")) refuse();
  const queue = (await firestore.doc(`cmsPublishQueue/${operationId}`).get()).data();
  if (queue?.transport !== "public-context-no-build-v1" || !(queue.settingsPublication || queue.libraryCardPublication || queue.recordPublication)) return { confirmed: false };
  if (queue.status === "cancelled") return { confirmed: false };
  if (queue.libraryCardPublication) {
    const accepted = await require("./no-build-library-card-publication").readLibraryCardPublication({ firestore,
      operationId: queue.libraryCardPublication.originalOperationId }).catch(error => {
      if (error.code === "library_card_publication_replaced") return null;
      throw error;
    });
    if (!accepted || accepted.ref.id !== operationId) return { confirmed: false };
  }
  if (queue.recordPublication) {
    const accepted = await require("./no-build-record-publication").readRecordPublication({ firestore,
      operationId: queue.recordPublication.originalOperationId }).catch(error => {
      if (error.code === "record_publication_replaced") return null;
      throw error;
    });
    if (!accepted || accepted.ref.id !== operationId) return { confirmed: false };
  }
  const identity = queue.settingsPublication ?? queue.libraryCardPublication ?? queue.recordPublication;
  if (!/^[a-f0-9]{40}$/.test(identity.rendererSha ?? "") ||
      !Number.isSafeInteger(identity.contextRevision) || identity.contextRevision < 1 ||
      !/^[a-f0-9]{64}$/.test(identity.contextDigest ?? "")) {
    return { confirmed: false, missingPages: Object.keys(PUBLIC_PAGE_DEFINITIONS).sort() };
  }
  if (/^[a-f0-9]{40}$/.test(identity.rendererSha ?? "") &&
      Number.isSafeInteger(identity.contextRevision) && identity.contextRevision > 0 &&
      /^[a-f0-9]{64}$/.test(identity.contextDigest ?? "") && ["pages", "home", "posts"].every(name => {
        const receipt = queue.consumerReceipts?.[name];
        return receipt?.rendererSha === identity.rendererSha && receipt.contextRevision === identity.contextRevision &&
          receipt.contextDigest === identity.contextDigest && Number.isFinite(receipt.verifiedAt) && receipt.verifiedAt > 0;
      })) return { confirmed: true };
  if (now() >= deadline) return { confirmed: false };
  const proof = await claimPageConsumerProof({ firestore, operationId, identity, now, deadline, log });
  if (!proof) return { confirmed: false };
  let result, waitingForInputs = false;
  try {
    const outcome = await provePageConsumers({ firestore, operationId, queue, identity, target, headers, fetchPublic,
      now, deadline, currentCodeRequest, log, proof, fetchPurge, purgeConfig });
    ({ waitingForInputs = false, ...result } = outcome);
    if (!result.confirmed) log.warn("Page consumer confirmation incomplete", { operationId,
      missingPageCount: result.missingPages?.length ?? 0, missingPostCount: result.missingPosts?.length ?? 0 });
    return result;
  } catch (error) {
    log.warn("Page consumer confirmation refused", { operationId, causes: confirmationErrorCauses(error) });
    throw error;
  } finally {
    await proof.finish(result?.confirmed === true, { waitingForInputs });
  }
}

async function provePageConsumers({ firestore, operationId, queue, identity, target, headers, fetchPublic,
  now, deadline, currentCodeRequest, log, proof, fetchPurge, purgeConfig }) {
  // Known missing runtime, packet or roster inputs cannot be repaired by
  // repeatedly reading the full CODE object. Recheck cheap authority each tick.
  const prerequisites = await firestore.runTransaction(transaction => pageProofPrerequisites({
    firestore, transaction, rendererSha: identity.rendererSha }), { readOnly: true });
  if (!prerequisites.missingPages.length && now() < deadline) {
    // Waiting for runtime or packet inputs must not evict every Post each tick.
    // Purge before the Home catalog repair's first public read when ready.
    await require("./no-build-post-recovery").purgePublicHome({ target, fetchPurge, purgeConfig });
  }
  if (prerequisites.repairHomeCatalog && now() < deadline) {
    // The owned picker can still progress while another Page input is missing.
    // Catalog repair never acknowledges the settings family by itself.
    try { await recoverNoBuildHomeCatalog({ firestore, target, headers, fetchPublic, now, deadline }); }
    catch (error) { return { ...unavailablePageConsumers([{ pageId: "home", error }], log),
      waitingForInputs: prerequisites.missingPages.length > 0 }; }
  }
  if (prerequisites.missingPages.length) return { confirmed: false, missingPages: prerequisites.missingPages, waitingForInputs: true };
  if (now() >= deadline) return { confirmed: false };
  let codeCapture;
  const readPostCoverage = () => withinDeadline(deadline - now(), () => firestore.runTransaction(transaction =>
    postSettingsCoverage({ firestore, transaction: settingsProofTransaction(transaction), identity, target, codeCapture }), { readOnly: true }));
  let postCoverage = await readPostCoverage();
  if (postCoverage.missingPosts.length) {
    try {
      codeCapture = await require("./no-build-code-post-consumer").captureCodePostConsumers({
        firestore, target, rendererSha: identity.rendererSha, request: currentCodeRequest, now, deadline });
      postCoverage = await readPostCoverage();
    } catch { return { confirmed: false, missingPosts: postCoverage.missingPosts }; }
  }
  if (postCoverage.missingPosts.length) return { confirmed: false, missingPosts: postCoverage.missingPosts };
  // Actual CODE and packet IO finish before coverage or the write transaction.
  let scheduleCapture;
  try {
    scheduleCapture = await capturePageSchedule({ firestore, target, rendererSha: identity.rendererSha,
      request: currentCodeRequest, now, deadline });
  } catch { return { confirmed: false, missingPages: ["schedule", "live"] }; }
  if (now() >= deadline) return { confirmed: false };
  let homeCodeCapture;
  try {
    homeCodeCapture = await capturePageHomeCodeSourcesIfNeeded({ firestore, target, rendererSha: identity.rendererSha,
      request: currentCodeRequest, now, deadline });
  } catch { return { confirmed: false, missingPages: ["home"] }; }
  const homeCapture = createHomeProviderCapture({ firestore, target, now, deadline });
  const readCoverage = () => firestore.runTransaction(transaction => pageCoverage({ firestore, transaction: settingsProofTransaction(transaction),
    rendererSha: identity.rendererSha, target, scheduleCapture,
    readHomeSource: homeCapture.readHomeSource, homeCodeCapture }), { readOnly: true });
  // Capture provider bytes, then repeat all native Page dependencies in a
  // fresh snapshot after IO with no live source fallback.
  if (now() >= deadline) return { confirmed: false };
  await withinDeadline(deadline - now(), () => readCoverage());
  homeCapture.seal();
  const coverage = await withinDeadline(deadline - now(), () => readCoverage());
  if (coverage.missing.length) return { confirmed: false, missingPages: coverage.missing };
  // A prior-slug redirect has no settings frame. Normal Post publication proves
  // aliases; settings proves every canonical detail through this shared pool.
  const proofs = [
    ...coverage.owners.map(({ state }) => ({ pageId: state.pageId, read: async signal => ({ kind: "page", state,
      receipt: await readPublicPageReceipt({ state, target, headers, fetchPublic, signal }) }) })),
    ...coverage.contexts.map(context => ({ pageId: context.pageId, read: async signal => ({ kind: "context",
      receipt: await readContextReceipt({ ...context, target, headers, fetchPublic, signal }) }) })),
    ...postCoverage.entries.map(entry => ({ postId: entry.postId, read: async signal => ({ kind: "post",
      receipt: await readPostSettingsReceipt({ entry, target, headers, fetchPublic, signal }) }) })),
  ];
  // Keep probing other owners, but never acknowledge a partial family. Failures
  // expose only bounded owner IDs, with no response bodies, URLs or errors.
  const failures = [];
  let results;
  try {
    results = await readSettingsProofs(proofs, (proof, signal) => proof.read(signal), {
      deadline, now, onFailure(proof, error) {
        if (proof.postId) throw error;
        failures.push({ pageId: proof.pageId, error });
        return { kind: "missing" };
      },
    });
  } catch (error) {
    if (failures.length) unavailablePageConsumers(failures, log);
    throw error;
  }
  if (failures.length) return unavailablePageConsumers(failures, log);
  const receipts = results.filter(result => result.kind === "page");
  const contextReceipts = results.filter(result => result.kind === "context").map(result => result.receipt);
  const { readSettingsPublication } = require("./settings-publication");
  if (now() >= deadline) return { confirmed: false };
  return withinDeadline(deadline - now(), () => firestore.runTransaction(async nativeTransaction => {
    const transaction = settingsProofTransaction(nativeTransaction);
    let accepted;
    if (queue.libraryCardPublication) {
      accepted = await require("./no-build-library-card-publication").readLibraryCardPublication({ firestore, transaction,
        operationId: queue.libraryCardPublication.originalOperationId });
    } else if (queue.recordPublication) {
      accepted = await require("./no-build-record-publication").readRecordPublication({ firestore, transaction,
        operationId: queue.recordPublication.originalOperationId });
    } else {
      const stored = (await transaction.get(firestore.doc(`cmsSettings/${queue.settingsPublication.id}`))).data();
      const settings = { published: projectPublishedCmsSettings({ documentId: queue.settingsPublication.id, document: stored }) };
      accepted = await readSettingsPublication({ firestore, transaction, id: queue.settingsPublication.id,
        sourceVersion: queue.settingsPublication.sourceVersion, settings });
    }
    if (!accepted || accepted.ref.id !== operationId || accepted.queue.status === "cancelled") return { confirmed: false };
    await proof.assertCurrent(transaction, accepted.queue);
    const identity = accepted.queue.settingsPublication ?? accepted.queue.libraryCardPublication ?? accepted.queue.recordPublication;
    if (now() >= deadline) return { confirmed: false };
    const currentPosts = await postSettingsCoverage({ firestore, transaction, identity, target, codeCapture });
    if (currentPosts.missingPosts.length || digest(currentPosts) !== digest(postCoverage)) {
      refuse("The published Post roster or its public dependencies changed during the settings proof.");
    }
    const current = await pageCoverage({ firestore, transaction, rendererSha: identity.rendererSha,
      target, scheduleCapture, readHomeSource: homeCapture.readHomeSource, homeCodeCapture });
    if (current.missing.length || current.rosterDigest !== coverage.rosterDigest || current.owners.length !== receipts.length ||
        digest(current.contexts) !== digest(coverage.contexts) ||
        digest(current.ownedContexts) !== digest(coverage.ownedContexts)) refuse();
    for (const receipt of contextReceipts) {
      if (receipt.identity.rendererSha !== identity.rendererSha || receipt.identity.contextDigest !== identity.contextDigest ||
          receipt.identity.contextRevision !== identity.contextRevision) refuse();
    }
    const catalogWrites = [];
    for (const { state, receipt } of receipts) {
      const owner = current.owners.find(owner => owner.state.pageId === state.pageId)?.state;
      if (!owner || digest(owner) !== digest(state)) refuse();
      const authority = await readPageAuthorityInTransaction({ firestore, transaction, state: owner, rendererSha: identity.rendererSha, target });
      if (receipt.rendererSha !== identity.rendererSha || receipt.contextDigest !== identity.contextDigest ||
          authority.contextDigest !== identity.contextDigest || authority.admission.admissionRevision !== receipt.admissionRevision) refuse();
      if (owner.visible) {
        const rendered = current.ownedContexts.find(context => context.pageId === owner.pageId)?.rendered;
        if (!rendered) refuse();
        assertRenderedRecordSourceBinding(receipt, rendered);
        if (rendered.schedule) {
          const expected = createHash("sha256").update(JSON.stringify(rendered.schedule.receipt)).digest("hex");
          if (receipt.routes.filter(route => route.status === 200).some(route => route.scheduleReceiptDigest !== expected)) refuse();
        }
      }
      if (owner.pageId === "home") await require("./no-build-home-ownership").readHomeSourcesInTransaction({
        firestore, transaction, state: owner, rendererSha: identity.rendererSha, target,
        readHomeSource: homeCapture.readHomeSource, homeCodeCapture });
      if (owner.pageId === "home") catalogWrites.push(await require("./home-source-selection-admission").preparePageHomeCatalogInTransaction({
        firestore, transaction, state: owner, source: receipt.homeCatalog, rendererSha: receipt.rendererSha,
        contextDigest: receipt.contextDigest, homeRefreshRevision: receipt.homeRefreshRevision }));
    }
    const consumer = { rendererSha: identity.rendererSha, contextRevision: identity.contextRevision,
      contextDigest: identity.contextDigest, verifiedAt: now() };
    if (now() >= deadline) return { confirmed: false };
    assertPageScheduleCapture({ firestore, target, rendererSha: identity.rendererSha, capture: scheduleCapture });
    homeCapture.assertCurrent();
    for (const write of catalogWrites) write();
    transaction.update(accepted.ref, { "consumerReceipts.pages": consumer, "consumerReceipts.home": consumer,
      "consumerReceipts.posts": consumer });
    return { confirmed: true };
  }));
}

module.exports = { pageCoverage, confirmNoBuildPageSettings, readContextReceipt };
