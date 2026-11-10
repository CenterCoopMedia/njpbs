"use strict";

const { createHomeProviderCapture } = require("./no-build-home-provider-capture");
const { capturePageSchedule, readCapturedPageScheduleInTransaction, assertPageScheduleCapture } = require("./no-build-page-schedule-reader");
const { pagePublicationTarget } = require("./no-build-page-target");
const { digest, refuse } = require("./no-build-page-ownership");
const { withinDeadline } = require("./no-build-post-recovery");
const { capturePageHomeCodeSourcesIfNeeded } = require("./no-build-page-home-code-capture");
const captures = new WeakMap();

async function selection({ firestore, transaction, target, rendererSha, scheduleCapture, homeCodeCapture, memo }) {
  const coverage = await require("./no-build-page-settings-confirmation").pageCoverage({ firestore, transaction,
    rendererSha, target, scheduleCapture, homeCodeCapture, readHomeSource: memo.readHomeSource });
  if (coverage.missing.length) refuse(`Complete Page consumer coverage is unavailable: ${coverage.missing.join(", ")}.`);
  const schedule = await readCapturedPageScheduleInTransaction({ firestore, transaction, target, rendererSha, capture: scheduleCapture });
  const [deployment, context] = await transaction.getAll(firestore.doc("system/publicDeployment"),
    firestore.doc("system/publicDeployment/contexts/public"));
  // Keep SDK references out of the private equality/digest representation.
  return { coverage: { ...coverage, owners: coverage.owners.map(({ ref, state }) => ({ path: ref.path, state })) },
    scheduleReceipt: schedule.receipt, deployment: deployment.data(), context: context.data() };
}

/** Node-only complete roster adapter owned by Page. Immutable IO finishes
 * outside the final CAS. Owned and qualified CODE Home both cover the roster. */
async function capturePageConsumerCoverage({ firestore, target, rendererSha, currentCodeRequest,
  now = Date.now, deadline = now() + 45_000 }) {
  target = pagePublicationTarget({ firestore, target });
  const scheduleCapture = await capturePageSchedule({ firestore, target, rendererSha, request: currentCodeRequest, now, deadline });
  const homeCodeCapture = await capturePageHomeCodeSourcesIfNeeded({ firestore, target, rendererSha,
    request: currentCodeRequest, now, deadline });
  const memo = createHomeProviderCapture({ firestore, target, now, deadline });
  const read = () => firestore.runTransaction(transaction => selection({ firestore, transaction,
    target, rendererSha, scheduleCapture, homeCodeCapture, memo }), { readOnly: true });
  if (now() >= deadline) refuse("The complete Page consumer deadline expired.");
  await withinDeadline(deadline - now(), () => read());
  memo.seal();
  const after = await withinDeadline(deadline - now(), () => read());
  assertPageScheduleCapture({ firestore, target, rendererSha, capture: scheduleCapture });
  memo.assertCurrent();
  const capture = Object.freeze({});
  captures.set(capture, { target, rendererSha, scheduleCapture, homeCodeCapture, memo, after });
  return capture;
}

/** Re-run the same full roster on the caller's actual final SDK snapshot.
 * Missing/forged/expired/moved captures and unknown references refuse, no IO. */
async function readCompletePageConsumerCoverageInTransaction({ firestore, transaction, target, rendererSha, capture }) {
  target = pagePublicationTarget({ firestore, target });
  const data = captures.get(capture);
  if (!data || data.target !== target || data.rendererSha !== rendererSha) refuse("The complete Page consumer capture is unavailable.");
  assertPageScheduleCapture({ firestore, target, rendererSha, capture: data.scheduleCapture });
  data.memo.assertCurrent();
  const current = await selection({ firestore, transaction, target, rendererSha,
    scheduleCapture: data.scheduleCapture, homeCodeCapture: data.homeCodeCapture, memo: data.memo });
  if (digest(current) !== digest(data.after)) refuse("The complete Page consumer selection moved after IO.");
  const { coverage, scheduleReceipt } = current;
  const entries = [
    ...coverage.owners.flatMap(({ state }) => state.ownedPaths.map(path => {
      const source = coverage.ownedContexts.find(context => context.pageId === state.pageId);
      return { kind: "page-owner", pageId: state.pageId, path, state,
        status: !state.visible ? 410 : path === state.path || path === "/_home-sources.json" ? 200 : 308,
        ...(source ? { renderContext: source.rendered, ...(source.home ? { home: source.home } : {}) } : {}) };
    })),
    ...coverage.contexts.map(({ path, decision }) => ({ kind: "page-context", path, decision })),
    { kind: "schedule-export", path: "/_schedule-sources.json", status: 200, scheduleReceipt, seal: scheduleReceipt.projectionJson },
    { kind: "schedule-export", path: "/schedule/downloads/nj-pbs-schedule.pdf", status: 200, scheduleReceipt, seal: scheduleReceipt.retainedPdf },
  ].sort((a, b) => a.path.localeCompare(b.path));
  if (!entries.length || new Set(entries.map(entry => entry.path)).size !== entries.length) refuse();
  assertPageScheduleCapture({ firestore, target, rendererSha, capture: data.scheduleCapture });
  data.memo.assertCurrent();
  return { schemaVersion: 1, complete: true, entries, rosterDigest: coverage.rosterDigest, selectionDigest: digest(current) };
}

module.exports = { capturePageConsumerCoverage, readCompletePageConsumerCoverageInTransaction };
