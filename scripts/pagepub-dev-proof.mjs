import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { assertNoBuild } from "./fastpub-dev-proof.mjs";

const require = createRequire(import.meta.url);
const { validateNoBuildPageState } = require("../functions/lib/no-build-page-ownership");
const { readPublicPageReceipt } = require("../functions/lib/no-build-page-recovery");
const { withinDeadline } = require("../functions/lib/no-build-post-recovery");
const { publicationTarget } = require("../functions/lib/publication-target");
const target = publicationTarget("development");

/** Read-only proof primitive for an authenticated development harness. The
 * caller owns fixture creation, browser-visible content, credentials and cleanup.
 * No production target override or publication mutation is accepted here. */
export async function proveDevPagePublication({ state, rendererSha, contextDigest, admissionRevision,
  fetchPublic, readAuthority, readPublication, readBaseline, headers = {}, now = Date.now }) {
  validateNoBuildPageState(state);
  if (!/^[a-f0-9]{40}$/.test(rendererSha ?? "") || !/^[a-f0-9]{64}$/.test(contextDigest ?? "") ||
      !(Number.isSafeInteger(admissionRevision) && admissionRevision > 0 || !state.visible && admissionRevision === null)) {
    throw new Error("exact_page_proof_identity_required");
  }
  const startedAt = now();
  const [before, authorityBefore] = await Promise.all([readBaseline(), readAuthority()]);
  const receipt = await withinDeadline(10_000, signal => readPublicPageReceipt({ state, target, headers, fetchPublic, signal }));
  const [after, authorityAfter, publication] = await Promise.all([readBaseline(), readAuthority(), readPublication()]);
  assertNoBuild(before, after);
  if (JSON.stringify(authorityBefore) !== JSON.stringify(authorityAfter) || authorityAfter.operationId !== state.operationId ||
      authorityAfter.pageId !== state.pageId || authorityAfter.sourceVersion !== state.sourceVersion || authorityAfter.path !== state.path ||
      authorityAfter.visible !== state.visible || JSON.stringify(authorityAfter.ownedPaths) !== JSON.stringify(state.ownedPaths) ||
      authorityAfter.snapshotDigest !== state.snapshotDigest || authorityAfter.rendererSha !== rendererSha ||
      authorityAfter.contextDigest !== contextDigest || authorityAfter.admissionRevision !== admissionRevision ||
      receipt.rendererSha !== rendererSha || receipt.contextDigest !== contextDigest || receipt.admissionRevision !== admissionRevision ||
      publication?.queueStatus !== "success" || publication.publicUpdatePending !== false ||
      publication.publishedSourceVersion !== state.sourceVersion || publication.publiclyVisible !== state.visible ||
      publication.publicSourceVersion !== (state.visible ? state.sourceVersion : null) ||
      publication.pageReceipt?.operationId !== state.operationId || publication.pageReceipt.sourceVersion !== state.sourceVersion ||
      publication.pageReceipt.visible !== state.visible) throw new Error("page_proof_not_confirmed");
  // Only public identity/digests survive into the operator's receipt file.
  return { schemaVersion: 1, target: target.origin, pageId: state.pageId, operationId: state.operationId,
    sourceVersion: state.sourceVersion, snapshotDigest: state.snapshotDigest, visible: state.visible,
    rendererSha, contextDigest, admissionRevision, routes: receipt.routes,
    seconds: (now() - startedAt) / 1000, noFullBuild: true, result: "pass",
    authorityDigest: createHash("sha256").update(JSON.stringify(authorityAfter)).digest("hex") };
}
