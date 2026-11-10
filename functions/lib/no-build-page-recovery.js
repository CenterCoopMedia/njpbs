"use strict";

const { randomUUID } = require("node:crypto");
const { FieldValue } = require("firebase-admin/firestore");
const { PAGE_OWNER_COLLECTION, validateNoBuildPageState, readNoBuildPageOwner, assertPageOwnerSnapshot, digest, refuse } = require("./no-build-page-ownership");
const { PUBLIC_PAGE_DEFINITIONS } = require("./public-page-contract");
const { preparePageAggregateRetryInTransaction } = require("./no-build-page-aggregate-confirmation");
const { createHash } = require("node:crypto");
const { pagePublicationTarget } = require("./no-build-page-target");
const { capturePageSchedule, assertPageScheduleCapture } = require("./no-build-page-schedule-reader");
const { createHomeProviderCapture } = require("./no-build-home-provider-capture");
const { capturePageHomeCodeSourcesIfNeeded } = require("./no-build-page-home-code-capture");
const { readPageAuthorityInTransaction } = require("./no-build-page-serving");
const { settleBuildQueue } = require("./publish-build-state");
const { can, canEditContent } = require("./rbac");
const { contentResourceSection } = require("./content-authorization");
const { assertReadbackTarget, publicReadbackHeaders, withinDeadline, verifyPublicHtml, readPublicPostAfterRefresh } = require("./no-build-post-recovery");

const { readRenderedRecordSourceReceipt, assertRenderedRecordSourceBinding } = require("./no-build-page-source-binding");

const TRANSPORT = "page-no-build-v1";
const { publicationAttempt, publicationClaim, publicationFailure, publicationRetry } = require("./background-output-attempt");
// The real 38-day Schedule renders about 2.35 MiB. Match the public Page
// Worker's bounded HTML allowance; Home catalog JSON keeps its 2 MiB bound.
const PUBLIC_PAGE_HTML_MAX_BYTES = 4 * 1024 * 1024;
function assertPageQueue(queue, state) {
  const operation = queue?.noBuildPage;
  const change = queue?.changes?.[0];
  const fields = ["pageId", "operationId", "sourceVersion", "snapshotDigest", "datasetFiguresDigest", "path", "visible", "rendererSha", "generation", "contextRevision", "contextDigest"];
  if (queue?.transport !== TRANSPORT || operation?.schemaVersion !== 1 ||
      fields.some(key => operation[key] !== state[key]) ||
      JSON.stringify(operation.ownedPaths) !== JSON.stringify(state.ownedPaths) ||
      queue.backgroundRuntime?.owner !== state.runtime.owner || queue.backgroundRuntime?.release !== state.runtime.release ||
      queue.changes.length !== 1 || change?.collection !== "cmsPages" || change.id !== state.pageId ||
      change.sourceVersion !== state.sourceVersion || (change.operation === "withdraw") === state.visible) refuse();
  if (operation.contextQueueId !== state.contextQueueId) refuse();
}

/** Every retained route proves the same operation and current context. A 404,
 * followed redirect, stale alias or metadata-only body never completes a Page. */
async function readPublicPageReceipt({ state, fetchPublic = fetch, target, headers, signal = AbortSignal.timeout(10_000) }) {
  if (state.pageId === "home" && !state.visible) refuse("Home cannot be unpublished.");
  const routes = [];
  let identity;
  let homeCatalog;
  let recordSourceDigest;
  async function readRoute(path) {
    const response = await readPublicPostAfterRefresh(`${target.origin}${path}`, fetchPublic, signal, headers);
    const status = !state.visible ? 410 : path === state.path ? state.contentRedirectUrl ? 302 : 200 : path === "/_home-sources.json" ? 200 : 308;
    const revision = response.headers.get("x-njpbs-admission-revision");
    const datasetFiguresDigest = response.headers.get("x-njpbs-dataset-figures-sha256");
    const observed = { rendererSha: response.headers.get("x-njpbs-renderer-sha"),
      contextDigest: response.headers.get("x-njpbs-context-sha256"),
      admissionRevision: revision === "unavailable" && !state.visible ? null : Number(revision) };
    if (state.pageId === "home") observed.homeRefreshRevision = Number(response.headers.get("x-njpbs-home-refresh-revision"));
    try {
      // The legacy edge redirects this alias before the Page reader runs.
      // Its canonical route must still prove the complete Page receipt below.
      if (state.visible && state.pageId === "public-meetings" && path === "/public-meetings/" &&
          state.path === "/meeting-notices/" && response.status === 301 &&
          ![...response.headers.keys()].some(name => name.startsWith("x-njpbs-")) &&
          new URL(response.headers.get("location"), `${target.origin}${path}`).href === `${target.origin}${state.path}`) {
        return { route: { path, status: 301, location: state.path, legacyRedirect: true } };
      }
      if (response.status !== status || response.headers.get("cache-control") !== "no-store" ||
          response.headers.get("x-njpbs-content-source") !== "cms-page-no-build" ||
          response.headers.get("x-njpbs-publication-operation") !== state.operationId ||
          response.headers.get("x-njpbs-source-version") !== String(state.sourceVersion) ||
          response.headers.get("x-njpbs-snapshot-sha256") !== state.snapshotDigest ||
          datasetFiguresDigest !== (state.datasetFiguresDigest ?? null) ||
          !state.visible && (response.headers.get("x-njpbs-durable-withdrawal-operation") !== state.operationId ||
            response.headers.get("x-njpbs-withdrawal-revision") !== String(state.generation)) ||
          !/^[a-f0-9]{40}$/.test(observed.rendererSha ?? "") || !/^[a-f0-9]{64}$/.test(observed.contextDigest ?? "") ||
          !(observed.admissionRevision === null || /^[1-9][0-9]*$/.test(revision ?? "") && Number.isSafeInteger(observed.admissionRevision)) ||
          (status === 308 && response.headers.get("location") !== state.path) ||
          (status === 302 && (response.headers.get("location") !== state.contentRedirectUrl || response.headers.get("x-robots-tag") !== "noindex, nofollow")) ||
          (status === 200 && !response.headers.get("content-type")?.startsWith(path === "/_home-sources.json" ? "application/json" : "text/html")) ||
          (state.pageId === "home" && (response.headers.get("x-njpbs-home-refresh-revision") !== String(state.homeRefresh?.revision ?? 0)))) throw new Error("Public Page receipt is unavailable");
      const chunks = status === 200 && path === "/_home-sources.json" ? [] : null;
      const htmlDigest = status === 200 ? await verifyPublicHtml(response,
        path === "/_home-sources.json" ? 2 * 1024 * 1024 : PUBLIC_PAGE_HTML_MAX_BYTES, path !== "/_home-sources.json",
        chunks ? chunk => chunks.push(Buffer.from(chunk)) : undefined) : null;
      const catalog = chunks ? JSON.parse(Buffer.concat(chunks).toString("utf8")).editorial : null;
      const rendered = [200, 302].includes(status) ? readRenderedRecordSourceReceipt(response) : null;
      const scheduleReceiptDigest = status === 200 && ["schedule", "live"].includes(state.pageId)
        ? response.headers.get("x-njpbs-schedule-receipt-sha256") : null;
      if (status === 200 && ["schedule", "live"].includes(state.pageId) &&
          !/^[a-f0-9]{64}$/.test(scheduleReceiptDigest ?? "")) refuse();
      return { route: { path, status, htmlDigest, ...(rendered ?? {}),
        ...(status === 302 ? { location: response.headers.get("location") } : {}),
        ...(scheduleReceiptDigest ? { scheduleReceiptDigest } : {}) }, identity: observed, catalog };
    } finally { await response.body?.cancel().catch(() => {}); }
  }
  // A bounded batch keeps the supported alias count within one read deadline.
  // Ordered results retain the owner's route order and one context identity.
  for (let offset = 0; offset < state.ownedPaths.length; offset += 8) {
    const batch = await Promise.all(state.ownedPaths.slice(offset, offset + 8).map(readRoute));
    for (const observed of batch) {
      if (observed.catalog) homeCatalog = observed.catalog;
      if ([200, 302].includes(observed.route.status)) {
        if (recordSourceDigest && recordSourceDigest !== observed.route.recordSourceDigest) refuse("Page rendered record source changed between routes.");
        recordSourceDigest = observed.route.recordSourceDigest;
      }
      if (observed.identity) {
        if (identity && JSON.stringify(identity) !== JSON.stringify(observed.identity)) throw new Error("Public Page context changed between routes");
        identity = observed.identity;
      }
      routes.push(observed.route);
    }
  }
  if (routes.some(route => route.legacyRedirect) && !routes.some(route => route.path === state.path && [200, 302].includes(route.status))) {
    refuse("The legacy Page alias has no verified canonical route.");
  }
  return { operationId: state.operationId, sourceVersion: state.sourceVersion, snapshotDigest: state.snapshotDigest,
    ...(state.datasetFiguresDigest ? { datasetFiguresDigest: state.datasetFiguresDigest } : {}),
    visible: state.visible, ...identity, routes, ...(recordSourceDigest ? { recordSourceDigest } : {}), ...(homeCatalog ? { homeCatalog } : {}) };
}

function compactPageReceipt(receipt) {
  const compact = { ...receipt };
  delete compact.homeCatalog;
  return compact;
}

async function registerVerifiedHomeCatalog({ firestore, receipt }) {
  await firestore.runTransaction(async transaction => {
    const { state } = await readNoBuildPageOwner({ firestore, transaction, pageId: "home" });
    if (!state || state.operationId !== receipt.operationId || state.sourceVersion !== receipt.sourceVersion ||
        state.snapshotDigest !== receipt.snapshotDigest || state.visible !== receipt.visible ||
        state.datasetFiguresDigest !== receipt.datasetFiguresDigest ||
        (state.homeRefresh?.revision ?? 0) !== receipt.homeRefreshRevision) refuse();
    const authority = await readPageAuthorityInTransaction({ firestore, transaction, state, rendererSha: receipt.rendererSha });
    if (authority.contextDigest !== receipt.contextDigest || authority.admission.admissionRevision !== receipt.admissionRevision) refuse();
    const rendered = await require("./no-build-page-render-context").assertNoBuildPageContextInTransaction({
      firestore, transaction, pageId: "home", rendererSha: receipt.rendererSha, nextDocument: authority.document });
    assertRenderedRecordSourceBinding(receipt, rendered);
    const write = await require("./home-source-selection-admission").preparePageHomeCatalogInTransaction({ firestore, transaction,
      state, source: receipt.homeCatalog, rendererSha: receipt.rendererSha, contextDigest: receipt.contextDigest,
      homeRefreshRevision: receipt.homeRefreshRevision });
    write();
  });
}

/** Context updates can invalidate a picker receipt after the Home operation has
 * completed. Re-prove its catalog without changing that terminal operation. */
async function recoverNoBuildHomeCatalog({ firestore, target, headers, fetchPublic = fetch,
  now = Date.now, deadline = now() + 45_000 }) {
  const state = await firestore.runTransaction(async transaction => {
    if (!await require("./no-build-home-ownership").readHomePageAuthorityInTransaction({ firestore, transaction })) return null;
    const { state } = await readNoBuildPageOwner({ firestore, transaction, pageId: "home" });
    const pointer = (await transaction.get(firestore.doc("system/publicDeployment"))).data();
    const authority = await readPageAuthorityInTransaction({ firestore, transaction, state, rendererSha: pointer?.activeCommitSha });
    const row = (await transaction.get(firestore.doc(`cmsHomeSourceCatalogs/${state.operationId}`))).data();
    if (row?.page?.operationId === state.operationId && row.page.sourceVersion === state.sourceVersion &&
        row.page.contextDigest === authority.contextDigest && row.page.homeRefreshRevision === (state.homeRefresh?.revision ?? 0) &&
        row.receipt?.commitSha === authority.effective.rendererSha &&
        row.receipt.generation === Math.max(state.generation, authority.codeGeneration)) return null;
    return state;
  }, { readOnly: true });
  if (!state) return;
  if (now() >= deadline) return;
  headers = publicReadbackHeaders(target, headers);
  headers.set("cache-control", "no-cache");
  const receipt = await withinDeadline(Math.min(10_000, deadline - now()), signal => readPublicPageReceipt({ state, target, headers, fetchPublic, signal }));
  if (now() >= deadline) return;
  await registerVerifiedHomeCatalog({ firestore, receipt });
}

async function capturePageRenderContext({ firestore, state, rendererSha, target, scheduleCapture,
  now, deadline, currentCodeRequest }) {
  const homeCodeCapture = state.pageId === "home" ? await capturePageHomeCodeSourcesIfNeeded({
    firestore, target, rendererSha, request: currentCodeRequest, now, deadline }) : undefined;
  const capture = createHomeProviderCapture({ firestore, target, now, deadline });
  const read = () => firestore.runTransaction(async transaction => {
    const current = (await readNoBuildPageOwner({ firestore, transaction, pageId: state.pageId })).state;
    if (!current || digest(current) !== digest(state)) refuse();
    const authority = await readPageAuthorityInTransaction({ firestore, transaction, state: current, rendererSha, target });
    const rendered = await require("./no-build-page-render-context").assertNoBuildPageContextInTransaction({ firestore, transaction,
      pageId: state.pageId, rendererSha, nextDocument: authority.document, target,
      scheduleCapture });
    const home = state.pageId === "home" ? await require("./no-build-home-ownership").readHomeSourcesInTransaction({
      firestore, transaction, state, rendererSha, readHomeSource: capture.readHomeSource, homeCodeCapture, target }) : null;
    return { rendered, home };
  }, { readOnly: true });
  if (now() >= deadline) refuse("The Page confirmation deadline expired.");
  await withinDeadline(deadline - now(), () => read());
  capture.seal();
  const selection = await withinDeadline(deadline - now(), () => read());
  return { capture, homeCodeCapture, ...selection };
}

// Manual rechecks and automatic recovery share the same bounded public read
// and transaction-time authority proof.
async function preparePageConfirmation({ firestore, state, fetchPublic = fetch, now = Date.now,
  target, headers = {}, currentCodeRequest, deadline = now() + 45_000, fetchPurge, purgeConfig }) {
  target = assertReadbackTarget(firestore, pagePublicationTarget({ firestore, target }));
  const readHeaders = publicReadbackHeaders(target, headers);
  if (state.pageId === "home") await require("./no-build-post-recovery").purgePublicHome({ target, fetchPurge, purgeConfig });
  const scheduleCapture = state.visible && ["schedule", "live"].includes(state.pageId)
    ? await capturePageSchedule({ firestore, target, request: currentCodeRequest, now, deadline }) : undefined;
  const receipt = await withinDeadline(Math.max(1, Math.min(10_000, deadline - now())),
    signal => readPublicPageReceipt({ state, fetchPublic, signal, target, headers: readHeaders }));
  const records = state.visible ? await capturePageRenderContext({ firestore, state, rendererSha: receipt.rendererSha,
    target, scheduleCapture, now, deadline, currentCodeRequest }) : null;
  return {
    receipt: compactPageReceipt(receipt),
    homeCatalog: receipt.homeCatalog,
    preflight: async ({ transaction, queue }) => {
      if (now() >= deadline) refuse("The Page confirmation deadline expired.");
      const current = (await readNoBuildPageOwner({ firestore, transaction, pageId: state.pageId })).state;
      if (!current || current.operationId !== state.operationId || current.sourceVersion !== receipt.sourceVersion ||
          current.snapshotDigest !== receipt.snapshotDigest || current.visible !== receipt.visible ||
          current.datasetFiguresDigest !== receipt.datasetFiguresDigest ||
          (state.pageId === "home" && (current.homeRefresh?.revision ?? 0) !== receipt.homeRefreshRevision) ||
          current.path !== state.path || JSON.stringify(current.ownedPaths) !== JSON.stringify(state.ownedPaths)) refuse();
      assertPageQueue(queue, current);
      const authority = await readPageAuthorityInTransaction({ firestore, transaction, state: current,
        rendererSha: receipt.rendererSha, target });
      if (authority.contextDigest !== receipt.contextDigest || authority.admission.admissionRevision !== receipt.admissionRevision) refuse();
      if (current.visible) {
        const rendered = await require("./no-build-page-render-context").assertNoBuildPageContextInTransaction({
          firestore, transaction, pageId: current.pageId, rendererSha: receipt.rendererSha,
          nextDocument: authority.document, target, scheduleCapture });
        if (digest(rendered) !== digest(records.rendered)) refuse("The Page render inputs moved after immutable IO.");
        assertRenderedRecordSourceBinding(receipt, rendered);
        if (rendered.schedule) {
          const expected = createHash("sha256").update(JSON.stringify(rendered.schedule.receipt)).digest("hex");
          if (receipt.routes.filter(route => route.status === 200).some(route => route.scheduleReceiptDigest !== expected)) refuse();
          assertPageScheduleCapture({ firestore, target, rendererSha: receipt.rendererSha, capture: scheduleCapture });
        }
      }
      if (current.pageId === "home") {
        const home = await require("./no-build-home-ownership").readHomeSourcesInTransaction({
          firestore, transaction, state: current, rendererSha: receipt.rendererSha, readHomeSource: records.capture.readHomeSource,
          homeCodeCapture: records.homeCodeCapture, target });
        if (digest(home) !== digest(records.home)) refuse("The Home provider selection moved after immutable IO.");
      }
      if (now() >= deadline) refuse("The Page confirmation deadline expired.");
      records?.capture.assertCurrent();
    },
  };
}

async function recoverNoBuildPageDetail({ firestore, operationId, fetchPublic = fetch, now = Date.now,
  target, headers = {}, currentCodeRequest, deadline = now() + 45_000, fetchPurge, purgeConfig }) {
  target = pagePublicationTarget({ firestore, target });
  target = assertReadbackTarget(firestore, target);
  const readHeaders = publicReadbackHeaders(target, headers);
  if (!operationId) {
    const maxOwners = 500 + Object.keys(PUBLIC_PAGE_DEFINITIONS).length;
    const rows = await firestore.collection(PAGE_OWNER_COLLECTION).limit(maxOwners + 1).get();
    if (rows.size > maxOwners) refuse("Page recovery exceeds its owner bound.");
    const owners = [];
    for (const row of rows.docs) {
      try {
        const state = validateNoBuildPageState(row.data());
        if (state?.pageId === row.id) owners.push(state);
      } catch { /* One corrupt owner must not stop another Page's recovery. */ }
    }
    const due = [];
    for (let offset = 0; offset < owners.length && now() < deadline; offset += 100) {
      const queues = await firestore.getAll(...owners.slice(offset, offset + 100).map(state => firestore.doc(`cmsPublishQueue/${state.operationId}`)));
      for (const [index, row] of queues.entries()) {
        const queue = row.data();
        if (publicationAttempt(queue, "page", now())) {
          due.push({ state: owners[offset + index], nextAttemptAt: queue.nextAttemptAt });
        }
      }
    }
    due.sort((left, right) => left.nextAttemptAt - right.nextAttemptAt || left.state.operationId.localeCompare(right.state.operationId));
    for (const { state } of due) {
      if (now() >= deadline) break;
      try { await recoverNoBuildPageDetail({ firestore, operationId: state.operationId, fetchPublic, now, target,
        headers: readHeaders, currentCodeRequest, deadline, fetchPurge, purgeConfig }); }
      catch { /* Retain the refusing queue while recovering other operations. */ }
    }
    const home = owners.find(state => state.pageId === "home" && state.homeRefresh?.status === "pending");
    if (home && now() < deadline) {
      try { await recoverNoBuildHomeRefresh({ firestore, fetchPublic, now, target, headers: readHeaders, deadline, currentCodeRequest, fetchPurge, purgeConfig }); }
      catch { /* Home has its own durable retry and claim. */ }
    }
    if (owners.some(state => state.pageId === "home") && now() < deadline) {
      // Every public context writer can invalidate the selector row, including
      // legacy paths that produce neither a Page nor a context queue event.
      try { await recoverNoBuildHomeCatalog({ firestore, fetchPublic, target, headers: readHeaders, now, deadline }); }
      catch { /* One bounded minute probe leaves unavailable catalogs refusing. */ }
    }
    const context = (await firestore.doc("system/publicDeployment/aggregateContexts/current").get()).data();
    if (context?.operationId && now() < deadline) {
      const ids = context.operationIds ?? [context.operationId];
      if (!Array.isArray(ids) || ids.length > 100 || !ids.includes(context.operationId) ||
          new Set(ids).size !== ids.length || ids.some(id => !/^[A-Za-z0-9]{20}$/.test(id))) refuse("Invalid aggregate confirmation aliases.");
      for (const id of ids) {
        if (now() >= deadline) break;
        try { await require("./no-build-page-settings-confirmation").confirmNoBuildPageSettings({
          firestore, operationId: id, target, headers: readHeaders, fetchPublic, now, deadline, currentCodeRequest, fetchPurge, purgeConfig }); }
        catch { /* Each alias retains its own logged, durable proof failure. */ }
      }
      if (ids.length > 1 && now() < deadline) await require("./public-context-publication").retireConfirmedPublicContextAliases({ firestore });
    }
    return;
  }
  if (!/^[A-Za-z0-9]{20}$/.test(operationId)) refuse("Invalid Page confirmation operation.");
  if (now() >= deadline) return;
  const queueRef = firestore.doc(`cmsPublishQueue/${operationId}`);
  const accepted = (await queueRef.get()).data();
  if (accepted?.transport !== TRANSPORT) return;
  const claim = randomUUID();
  const state = await firestore.runTransaction(async transaction => {
    const queue = (await transaction.get(queueRef)).data();
    const owner = await readNoBuildPageOwner({ firestore, transaction, pageId: accepted.noBuildPage?.pageId });
    const attempt = publicationAttempt(queue, "page", now());
    if (!owner.state || owner.state.operationId !== operationId || !attempt) return null;
    assertPageQueue(queue, owner.state);
    if (attempt === "exhaust") {
      transaction.update(queueRef, publicationFailure(queue, "page", now()));
      return null;
    }
    transaction.update(queueRef, publicationClaim(queue, claim, now()));
    return owner.state;
  });
  if (!state) return;
  try {
    const proof = await preparePageConfirmation({ firestore, state, fetchPublic, now, target,
      headers: readHeaders, currentCodeRequest, deadline, fetchPurge, purgeConfig });
    if (state.pageId === "home") await registerVerifiedHomeCatalog({ firestore,
      receipt: { ...proof.receipt, homeCatalog: proof.homeCatalog } });
    // Paired aggregate jobs retain their own proof and retry budget.
    await settleBuildQueue(firestore, { queueId: operationId, status: "success",
      acceptQueue: queue => queue.transport === TRANSPORT && queue.claim === claim,
      preflight: proof.preflight,
      queueUpdate: () => ({ status: "success", completedAt: FieldValue.serverTimestamp(), error: null,
        claim: null, nextAttemptAt: null, publicReceipt: proof.receipt }),
    });
    return;
  } catch { /* The claimed attempt below records the failed public read. */ }
  await firestore.runTransaction(async transaction => {
    const queue = (await transaction.get(queueRef)).data();
    if (queue?.claim !== claim || queue.status === "success" || queue.status === "cancelled") return;
    transaction.update(queueRef, publicationFailure(queue, "page", now()));
  });
}

async function recoverNoBuildHomeRefresh({ firestore, fetchPublic = fetch, now = Date.now, target, headers,
  deadline = now() + 45_000, currentCodeRequest, fetchPurge, purgeConfig }) {
  target = pagePublicationTarget({ firestore, target });
  if (now() >= deadline) return;
  const claim = randomUUID();
  const state = await firestore.runTransaction(async transaction => {
    const { state } = await readNoBuildPageOwner({ firestore, transaction, pageId: "home" });
    const signal = state?.homeRefresh;
    if (signal?.status !== "pending") return null;
    if (state.visible !== true) refuse("Home cannot be unpublished.");
    if (signal.schemaVersion !== 1 || !Number.isSafeInteger(signal.revision) || signal.revision < 1 ||
        !/^[A-Za-z0-9]{20}$/.test(signal.sourceOperationId ?? "") ||
        signal.taskPath !== `cmsPublishQueue/${signal.sourceOperationId}/homePageRefresh/home`) refuse();
    const taskRef = firestore.doc(signal.taskPath);
    const task = (await transaction.get(taskRef)).data();
    const attempt = publicationAttempt(task, "home", now());
    if (!attempt) return null;
    if (task.schemaVersion !== 1 || task.owner !== TRANSPORT || task.revision !== signal.revision ||
        task.input?.homeOperationId !== state.operationId || task.input.homeSourceVersion !== state.sourceVersion ||
        task.input.sourceOperationId !== signal.sourceOperationId) refuse();
    const grouped = ["serializer", "github"].includes(task.input.sourceTransport);
    if (grouped ? signal.sourceTransport !== task.input.sourceTransport || !require("node:util").isDeepStrictEqual(signal.postChanges, task.input.postChanges) || signal.postId !== undefined || signal.sourceVersion !== undefined :
      task.input.postId !== signal.postId || task.input.sourceVersion !== signal.sourceVersion) refuse();
    require("./no-build-home-confirmation").assertHomeRefreshInput(task.input);
    if (attempt === "exhaust") {
      if (task.runtime?.owner !== state.runtime.owner || task.runtime?.release !== state.runtime.release) refuse();
      await require("./no-build-home-confirmation").assertHomeRefreshSourceInTransaction({ firestore, transaction, input: task.input });
      transaction.update(taskRef, publicationFailure(task, "home", now()));
      return null;
    }
    transaction.update(taskRef, publicationClaim(task, claim, now()));
    return state;
  });
  if (!state) return;
  const taskRef = firestore.doc(state.homeRefresh.taskPath);
  try {
    if (now() >= deadline) refuse("The Home confirmation deadline expired.");
    await require("./no-build-post-recovery").purgePublicHome({ target, fetchPurge, purgeConfig });
    const receipt = await withinDeadline(Math.min(10_000, deadline - now()), signal => readPublicPageReceipt({ state, fetchPublic, signal, target, headers }));
    const records = state.visible ? await capturePageRenderContext({ firestore, state,
      rendererSha: receipt.rendererSha, target, now, deadline, currentCodeRequest }) : null;
    await firestore.runTransaction(async transaction => {
      if (now() >= deadline) refuse("The Home confirmation deadline expired.");
      const current = (await readNoBuildPageOwner({ firestore, transaction, pageId: "home" })).state;
      const task = (await transaction.get(taskRef)).data();
      if (task?.claim !== claim || task.status === "verified") return;
      if (!current || current.operationId !== state.operationId || current.snapshotDigest !== state.snapshotDigest ||
          current.datasetFiguresDigest !== state.datasetFiguresDigest ||
          JSON.stringify(current.homeRefresh) !== JSON.stringify(state.homeRefresh)) refuse();
      const authority = await readPageAuthorityInTransaction({ firestore, transaction, state: current, rendererSha: receipt.rendererSha, target });
      await require("./no-build-home-confirmation").assertHomeRefreshSourceInTransaction({ firestore, transaction, input: task.input });
      if (authority.contextDigest !== receipt.contextDigest || authority.admission.admissionRevision !== receipt.admissionRevision ||
          receipt.homeRefreshRevision !== current.homeRefresh.revision) refuse();
      const home = await require("./no-build-home-ownership").readHomeSourcesInTransaction({ firestore, transaction,
        state: current, rendererSha: receipt.rendererSha, readHomeSource: records.capture.readHomeSource,
        homeCodeCapture: records.homeCodeCapture, target });
      if (digest(home) !== digest(records.home)) refuse("The Home provider selection moved after immutable IO.");
      if (current.visible) {
        const rendered = await require("./no-build-page-render-context").assertNoBuildPageContextInTransaction({
          firestore, transaction, pageId: "home", rendererSha: receipt.rendererSha, nextDocument: authority.document,
          target });
        if (digest(rendered) !== digest(records.rendered)) refuse("The Home render inputs moved after immutable IO.");
        assertRenderedRecordSourceBinding(receipt, rendered);
      }
      const writeCatalog = await require("./home-source-selection-admission").preparePageHomeCatalogInTransaction({ firestore, transaction,
        state: current, source: receipt.homeCatalog, rendererSha: receipt.rendererSha, contextDigest: receipt.contextDigest,
        homeRefreshRevision: receipt.homeRefreshRevision });
      if (now() >= deadline) refuse("The Home confirmation deadline expired.");
      records?.capture.assertCurrent();
      writeCatalog();
      transaction.update(taskRef, { status: "verified", claim: null, nextAttemptAt: null, publicReceipt: compactPageReceipt(receipt),
        completedAt: FieldValue.serverTimestamp(), error: null });
      transaction.update(firestore.doc("system/publicDeployment/noBuildPageOwners/home"), {
        homeRefresh: { ...current.homeRefresh, status: "verified" } });
    });
  } catch {
    await firestore.runTransaction(async transaction => {
      const task = (await transaction.get(taskRef)).data();
      if (task?.claim !== claim || task.status === "verified" || task.status === "superseded") return;
      transaction.update(taskRef, publicationFailure(task, "home", now()));
    });
  }
}

async function existingNoBuildPagePublication({ firestore, changes, retry = false, actor, baseVersion }) {
  const pageChanges = changes.filter(change => change.collection === "cmsPages");
  if (!pageChanges.length) return null;
  return firestore.runTransaction(async transaction => {
    const owners = await Promise.all(pageChanges.map(change => readNoBuildPageOwner({ firestore, transaction, pageId: change.id })));
    const state = owners.find(owner => owner.state)?.state;
    if (!state) return null;
    const document = (await transaction.get(firestore.doc(`cmsPages/${state.pageId}`))).data();
    const change = changes[0];
    const resource = { ownerId: document?.createdBy,
      section: contentResourceSection({ collection: "cmsPages", documentId: state.pageId, stored: document }) };
    const allowed = state.visible ? canEditContent(actor.principal, resource) || can(actor.principal, "content.publish", resource)
      : can(actor.principal, "content.unpublish", resource) || can(actor.principal, "content.delete", resource);
    if (!allowed) throw Object.assign(new Error("Publication access required."), { status: 403 });
    if (changes.length !== 1 || change.id !== state.pageId || change.sourceVersion !== state.sourceVersion ||
        (change.operation === "withdraw") === state.visible || (retry && document?.version !== baseVersion)) {
      refuse("Publication changed. Reload its status before retrying.");
    }
    assertPageOwnerSnapshot(state, document);
    const ref = firestore.doc(`cmsPublishQueue/${state.operationId}`);
    const queue = (await transaction.get(ref)).data();
    assertPageQueue(queue, state);
    if (retry) await require("./public-release-legacy-queue-admission").assertLegacyPublicQueueAdmissionInTransaction({ firestore, transaction });
    const retryAggregates = retry ? await preparePageAggregateRetryInTransaction({ firestore, transaction, queue, state }) : null;
    if (retry && publicationRetry(queue, "page")) transaction.update(ref, { status: "pending", attempts: 0,
      claim: null, nextAttemptAt: 0, error: null });
    retryAggregates?.();
    return { success: true, queueId: state.operationId, dispatched: false, status: "pending", transport: TRANSPORT,
      existingBuild: true, message: "This publication retains its existing Page operation." };
  });
}

module.exports = { preparePageConfirmation, TRANSPORT, PUBLIC_PAGE_HTML_MAX_BYTES, assertPageQueue, readPublicPageReceipt, recoverNoBuildPageDetail, recoverNoBuildHomeRefresh,
  recoverNoBuildHomeCatalog, existingNoBuildPagePublication };
