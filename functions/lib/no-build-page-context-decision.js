"use strict";

const { pageContextCodeGeneration } = require("./public-release-page-context-code-seal");
const { PUBLIC_PAGE_DEFINITIONS, publicPageDefinition, publicPagePath } = require("./public-page-contract");
const { pagePublicationTarget } = require("./no-build-page-target");
const { readPublicDeploymentPointer } = require("./public-deployment-pointer");
const { readPublicContextRevisionInTransaction, publicContextDigest, PUBLIC_CONTEXT_PATH } = require("./public-context-revision");
const { pageRouteRef, listNoBuildPageOwners, readNoBuildPageOwner, readNoBuildPageCapability, refuse } = require("./no-build-page-ownership");
const { readNoBuildPageProjectionInTransaction } = require("./no-build-page-source");
const { assertNoBuildPageContextInTransaction, readPageRenderDependenciesInTransaction } = require("./no-build-page-render-context");

/** Called only after the exclusive Page owner decision. Never turns a claim,
 * alias, owned withdrawal, or unreadable snapshot into an ASSETS fallback. */
async function readNoBuildPageContextDecision({ firestore, transaction, path, rendererSha, now = new Date(), target, scheduleCapture, requestScheduleCapture = false, readProviderInput, strictPublicReleaseInputs = false, legacyStaffServing = false }) {
  target = pagePublicationTarget({ firestore, target });
  if (typeof path !== "string" || !(path === "/" || /^\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(path))) return { kind: "pass", path };
  const [claim, owners] = await Promise.all([
    transaction.get(pageRouteRef(firestore, path)),
    listNoBuildPageOwners({ firestore, transaction, path }),
  ]);
  if (claim.exists || owners.length) refuse("An exclusive Page owner must decide this route.");
  const builtIn = Object.entries(PUBLIC_PAGE_DEFINITIONS).find(([, page]) => page.path === path || page.aliases?.includes(path));
  const slug = path.slice(1, -1);
  const [candidates, aliases] = path === "/" ? [[], []] : (await Promise.all([
    transaction.get(firestore.collection("cmsPages").where("published.metadata.slug", "==", slug).limit(2)),
    transaction.get(firestore.collection("cmsPages").where("published.metadata.previousSlugs", "array-contains", slug).limit(2)),
  ])).map(snapshot => snapshot.docs);
  const ids = new Set([...candidates, ...aliases].map(row => row.id));
  if (builtIn) ids.add(builtIn[0]);
  if (!ids.size) return { kind: "pass", path };
  if (ids.size !== 1) refuse("Two Pages claim this context route.");
  const pageId = [...ids][0];
  const definition = publicPageDefinition(pageId);
  if (!definition) refuse("The published Page identity is invalid.");
  const [owner, capability] = await Promise.all([
    readNoBuildPageOwner({ firestore, transaction, pageId }),
    readNoBuildPageCapability({ firestore, transaction }),
  ]);
  if (owner.state) {
    refuse("An exclusive Page owner must decide this logical Page and its aliases.");
  }
  if (!capability?.servingEnabled || capability.rendererSha !== rendererSha) return { kind: "pass", path };
  if (pageId === "data-hub" && capability.dataHubReportingVersion !== 1) return { kind: "pass", path };
  if (["schedule", "live"].includes(pageId) && !scheduleCapture) {
    if (requestScheduleCapture) throw new (require("./no-build-page-schedule-reader").PageScheduleCaptureRequired)(pageId);
    refuse("Schedule and Live require qualified sealed schedule authority.");
  }
  const [pointerSnapshot, contextRevision, contextSnapshot, documentSnapshot] = await Promise.all([
    transaction.get(firestore.doc("system/publicDeployment")),
    readPublicContextRevisionInTransaction(transaction, firestore),
    ["home", "data-hub"].includes(pageId) ? transaction.get(firestore.doc(PUBLIC_CONTEXT_PATH)) : null,
    transaction.get(firestore.doc(`cmsPages/${pageId}`)),
  ]);
  const pointer = readPublicDeploymentPointer(pointerSnapshot.data());
  if (!/^[a-f0-9]{40}$/.test(rendererSha ?? "") || pointer?.activeCommitSha !== rendererSha || pointer.state !== "idle" ||
      !Number.isSafeInteger(pointer.activeGeneration) || pointer.activeGeneration < 1) refuse("The Page context code release is unavailable.");
  const changedAt = contextSnapshot?.data()?.changedAt?.toMillis?.() ?? null;
  const document = documentSnapshot.data();
  if (document?.published?.metadata?.dataHubCompositionVersion === 1 && capability?.dataHubCompositionVersion !== 1) {
    refuse("The installed Page renderer does not support Data Hub composition.");
  }
  const result = await readNoBuildPageProjectionInTransaction({ firestore, transaction, pageId, document, now });
  const siteFrame = result.state !== "live" && !pageId.startsWith("page-") && Boolean(builtIn);
  const receipt = { rendererSha, contextRevision, contextDigest: publicContextDigest(contextRevision),
    codeGeneration: pointer.activeGeneration, path, source: siteFrame ? "site" : "cms",
    ...(siteFrame ? {} : { sourceVersion: document?.published?.sourceVersion }) };
  // An unowned built-in withdrawal/scheduled snapshot keeps its committed
  // frame, as the full build does. Exclusive owners were refused above.
  if (result.state === "withdrawn" && !siteFrame) return { kind: "gone", path, receipt };
  if (result.state !== "live" && !siteFrame) refuse("This Page route has no public context frame.");
  const canonical = result.state === "live" ? publicPagePath(pageId, document.published.metadata) : definition.path;
  // The unmigrated Donate route is a distinct 200/noindex frame. Article
  // aliases such as public-meetings retain the existing canonical redirect.
  if (canonical !== path && !(siteFrame && pageId === "give" && path === "/donate/")) {
    return { kind: "redirect", path, location: canonical, receipt };
  }
  const staffServing = legacyStaffServing && !strictPublicReleaseInputs && pointerSnapshot.data()?.schemaVersion !== 2;
  const context = result.state === "live"
    ? await assertNoBuildPageContextInTransaction({ firestore, transaction, pageId, rendererSha, now, target, scheduleCapture, readProviderInput, strictPublicReleaseInputs, legacyStaffServing: staffServing })
    : { page: null, ...await readPageRenderDependenciesInTransaction({ firestore, transaction, pageId, pointer, rendererSha, now, target, scheduleCapture, readProviderInput, strictPublicReleaseInputs, legacyStaffServing: staffServing }) };
  const codeGeneration = await pageContextCodeGeneration({ firestore, transaction, pointer: pointerSnapshot.data(), context });
  const decision = { kind: "context-page", path, receipt: { ...receipt, codeGeneration }, renderContext: { ...context, kind: "published-page-context", pageId, path,
    sourceSeal: { rendererSha, contextRevision, contextDigest: publicContextDigest(contextRevision),
      codeGeneration,
      ...(Number.isFinite(changedAt) && changedAt > 0 ? { cutoffAt: new Date(changedAt).toISOString() } : {}) } } };
  if (!require("./content-link").contentLinkReadFits(decision.renderContext, 8 * 1024 * 1024) || Buffer.byteLength(JSON.stringify(decision)) > (8 * 1024 * 1024 + require("./content-link").CONTENT_LINK_DIRECTORY_MAX_BYTES)) refuse("Page context input exceeds its bound.");
  return decision;
}

module.exports = { readNoBuildPageContextDecision };
