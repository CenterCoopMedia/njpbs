import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import firebase from "../../functions/lib/firebase.js";
import datasetsEndpoint from "../../functions/datasets.js";
import { withCmsEdge } from "../../functions/lib/cms-edge.js";
import datasetDependencies from "../../functions/lib/dataset-dependencies.js";
import datasetRefresh from "../../functions/lib/dataset-refresh.js";
import datasetUsage from "../../functions/lib/dataset-usage.js";
import datasetFigures from "../../functions/lib/dataset-figures.js";
import snapshots from "../../functions/lib/publish-snapshot.js";
import deployment from "../../functions/lib/public-deployment.js";
import context from "../../functions/lib/public-context-revision.js";
import postRecovery from "../../functions/lib/no-build-post-recovery.js";
import postPublication from "../../functions/lib/no-build-post-publication.js";
import postOwnership from "../../functions/lib/no-build-post-ownership.js";
import pageOwnership from "../../functions/lib/no-build-page-ownership.js";
import publicationTargets from "../../functions/lib/publication-target.js";
import recordNamespace from "../../functions/lib/no-build-record-namespace.js";
import publicContext from "../../functions/lib/public-context-publication.js";
import scheduler from "../../functions/scheduled-publish.js";
import bulkArchive from "../../functions/bulk-archive.js";
import preview from "../../functions/preview.js";
import previewTarget from "../../functions/lib/preview-target.js";
import audit from "../../functions/lib/audit.js";
import { datasetRelease } from "../fixtures/dataset-release.js";
import { electionBlock, electionRace } from "../fixtures/election-results.ts";
import electionApproval from "../../functions/lib/election-results-approval.js";

const { db, admin } = firebase;
const sha = "a".repeat(40);
const runtime = { owner: "cloudflare", release: sha };
const project = process.env.GCLOUD_PROJECT ?? "demo-njpbs";
const firestore = new Proxy(db, { get(target, key) {
  if (key === "projectId") return "njpbs-site-dev";
  const value = Reflect.get(target, key);
  return typeof value === "function" ? value.bind(target) : value;
} });
const ownerIds = { postA: "dataset-post-a", postB: "dataset-post-b", page: "contact" };
const originalOperations = {
  postA: `${"A".repeat(19)}1`, postB: `${"B".repeat(19)}2`, page: `${"C".repeat(19)}3`,
};

let server;
let origin;
let actor;

function responseBody(serverResponse, body) {
  serverResponse.setHeader("Content-Type", "application/json");
  serverResponse.end(JSON.stringify(body));
  return serverResponse;
}

async function call(body, path = "/") {
  const response = await fetch(`${origin}${path}`, { method: "POST", headers: {
    "Content-Type": "application/json",
    "x-njpbs-cms-edge": "synthetic-edge",
    Authorization: `Bearer ${actor.token}`,
  }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

async function saveDataset(release, record) {
  const response = await call({ action: "save", title: "Synthetic refresh dataset", release,
    requestId: randomUUID(), ...(record ? { id: record.id, baseVersion: record.version } : {}) });
  expect(response.status, response.body.error).toBe(200);
  return response.body.dataset;
}

async function transition(record, action, extra = {}, requestId = randomUUID()) {
  return call({ action, id: record.id, baseVersion: record.version, requestId, ...extra });
}

async function approveFreshDataset() {
  let record = await saveDataset(datasetRelease());
  const reviewed = await transition(record, "review");
  expect(reviewed.status, reviewed.body.error).toBe(200);
  record = reviewed.body.dataset;
  const approved = await transition(record, "approve", { expectedUseCount: 0 });
  expect(approved.status, approved.body.error).toBe(200);
  return approved.body.dataset;
}

function dataFigureBlock(id, datasetId, version) {
  return { id, type: "data_figure", order: 0, visible: true,
    data: { datasetId, version, display: "expanded" } };
}

function frozenFigures(block, projection) {
  return { figures: [{ blockId: block.id, datasetId: projection.datasetId,
    releaseId: projection.releaseId, revision: projection.revision, digest: projection.digest }],
  releases: [structuredClone(projection)] };
}

function postSource(id, block, version, title) {
  return { id, type: "post", title, status: "draft", section: "news", slug: `${id}-story`,
    previousSlugs: [], locale: "en-US", version, createdBy: actor.uid, tags: [], categories: [],
    credits: [], date: "2026-10-20", blocks: [structuredClone(block)] };
}

function pageSource(block, version, title) {
  return { id: ownerIds.page, title, status: "draft", version, createdBy: actor.uid,
    previousSlugs: [], blocks: [structuredClone(block)] };
}

function freezeSource(collection, source, projection, extraProjection) {
  const published = snapshots.createPublishedSnapshot({ collection, document: source,
    publishedAt: "2026-10-20T12:00:00.000Z", publishedBy: actor.uid });
  const datasetFigures = frozenFigures(source.blocks[0], projection);
  if (extraProjection) {
    const block = dataFigureBlock(`second-${source.id}`, extraProjection.datasetId,
      { mode: "pinned", releaseId: extraProjection.releaseId });
    published.blocks.push(block);
    datasetFigures.figures.push(...frozenFigures(block, extraProjection).figures);
    datasetFigures.releases.push(structuredClone(extraProjection));
    datasetFigures.figures.sort((a, b) => a.blockId.localeCompare(b.blockId));
    datasetFigures.releases.sort((a, b) => `${a.datasetId}/${a.releaseId}`.localeCompare(`${b.datasetId}/${b.releaseId}`));
  }
  return { ...published, datasetFigures };
}

async function seedSystem() {
  const pointer = { ...deployment.initialPublicDeploymentPointer(), activeGeneration: 1,
    activeDeploymentId: "11111111-1111-4111-8111-111111111111", activeCommitSha: sha,
    lastReservedGeneration: 1, newestEligibleGeneration: 1,
    newestEligibleBuildBatchId: "baseline", mediaLifecycleReady: true };
  const batch = db.batch();
  batch.set(db.doc("system/publicDeployment"), pointer);
  batch.set(db.doc(context.PUBLIC_CONTEXT_PATH), { schemaVersion: 1, revision: 1,
    withdrawalRevision: 0, homeRevision: 0 });
  batch.set(db.doc("system/noBuildPostAdmission"), { schemaVersion: 2, revision: 1, enabled: true,
    families: { posts: { mode: "all" }, pages: { mode: "ids", ids: [ownerIds.page] } },
    backgroundBucket: "njpbs-dev-public-artifacts" });
  batch.set(db.doc("system/cmsPublicationRuntime"), { schemaVersion: 1, phase: "paused",
    commitSha: sha, serializerId: "node-compute-publisher",
    cloud: { phase: "ready", commitSha: sha, serializerId: "cloudflare-dev-publisher" } });
  batch.set(db.doc(postOwnership.CAPABILITY_PATH), { schemaVersion: 2, rendererSha: sha,
    servingEnabled: true, generation: 1, dataFigureVersion: 1 });
  batch.set(db.doc(pageOwnership.PAGE_CAPABILITY_PATH), { schemaVersion: 1, rendererSha: sha,
    servingEnabled: true, generation: 1, dataFigureVersion: 1,
    terminalOwner: { schemaVersion: 1, transport: "page-no-build-v1", rendererSha: sha } });
  await batch.commit();
}

function postOwner(postId, operationId, snapshot) {
  return { schemaVersion: 1, postId, operationId, rendererSha: sha, servingEnabled: true,
    generation: 1, sourceVersion: snapshot.sourceVersion, slug: snapshot.metadata.slug,
    visible: true, ownedSlugs: [snapshot.metadata.slug],
    ...(snapshot.metadata.contentLinkMode === "custom" ? { contentRedirectUrl: snapshot.metadata.contentLinkUrl } : {}),
    snapshotDigest: datasetDependencies.digest(snapshot),
    datasetFiguresDigest: datasetDependencies.digest(snapshot.datasetFigures), runtime };
}

function pageOwner(operationId, snapshot) {
  return { schemaVersion: 1, pageId: ownerIds.page, operationId, rendererSha: sha,
    servingEnabled: true, generation: 1, sourceVersion: snapshot.sourceVersion,
    path: "/contact/", ownedPaths: ["/contact/"], visible: true,
    ...(snapshot.metadata.contentLinkMode === "custom" ? { contentRedirectUrl: snapshot.metadata.contentLinkUrl } : {}),
    snapshotDigest: pageOwnership.digest(snapshot),
    datasetFiguresDigest: datasetDependencies.digest(snapshot.datasetFigures),
    admissionRevision: 1, contextRevision: 1, contextDigest: context.publicContextDigest(1), runtime };
}

async function writeUsage(collection, documentId, snapshot) {
  await firestore.runTransaction(async transaction => {
    const write = await datasetUsage.prepareDatasetUsageWrites({ firestore, transaction,
      collection, documentId, snapshot, visible: true });
    write();
  });
}

async function seedPublishedOwners(datasetId, releaseId, projection, extraProjection, election = false, customLinks = false) {
  const blocks = {
    postA: dataFigureBlock("figure-post-a", datasetId, { mode: "pinned", releaseId }),
    postB: dataFigureBlock("figure-post-b", datasetId, { mode: "latestApproved" }),
    page: dataFigureBlock("figure-page", datasetId, { mode: "latestApproved" }),
  };
  const sources = {
    postA: postSource(ownerIds.postA, blocks.postA, 2, "Published Post A"),
    postB: postSource(ownerIds.postB, blocks.postB, 2, "Published Post B"),
    page: pageSource(blocks.page, 2, "Published contact Page"),
  };
  if (customLinks) for (const key of ["postA", "page"]) Object.assign(sources[key], { contentLinkMode: "custom", contentLinkUrl: "https://example.test/election-results" });
  if (election) {
    sources.postA.blocks.push({ ...electionBlock(electionRace({ asOf: "2026-10-20T11:00:00.000Z" })), order: 1 });
    sources.postA.electionResultsApprovals = electionApproval.approveElectionResults(sources.postA,
      { uid: actor.uid, displayName: "Synthetic editor" }, "2026-10-20T11:30:00.000Z");
  }
  const published = {
    postA: freezeSource("cmsPosts", sources.postA, projection, extraProjection),
    postB: freezeSource("cmsPosts", sources.postB, projection, extraProjection),
    page: freezeSource("cmsPages", sources.page, projection, extraProjection),
  };
  const documents = {
    postA: { ...sources.postA, version: 7, title: "Private newer Post A draft",
      blocks: [{ ...blocks.postA, data: { ...blocks.postA.data, display: "compact" } }],
      publiclyVisible: true, published: published.postA },
    postB: { ...sources.postB, version: 5, title: "Private newer Post B draft",
      publiclyVisible: true, published: published.postB },
    page: { ...sources.page, version: 8, title: "Private newer Page draft",
      publiclyVisible: true, published: published.page },
  };
  const owners = {
    postA: postOwner(ownerIds.postA, originalOperations.postA, published.postA),
    postB: postOwner(ownerIds.postB, originalOperations.postB, published.postB),
    page: pageOwner(originalOperations.page, published.page),
  };
  const batch = db.batch();
  for (const key of ["postA", "postB"]) {
    const id = ownerIds[key];
    batch.set(db.doc(`cmsPosts/${id}`), documents[key]);
    batch.set(db.doc(`${postOwnership.OWNER_COLLECTION}/${id}`), owners[key]);
    batch.set(db.doc(`cmsPublishQueue/${originalOperations[key]}`), { status: "success",
      transport: "post-no-build-v1", noBuildPost: owners[key], backgroundRuntime: runtime });
  }
  batch.set(db.doc(`cmsPages/${ownerIds.page}`), documents.page);
  batch.set(db.doc(`${pageOwnership.PAGE_OWNER_COLLECTION}/${ownerIds.page}`), owners.page);
  batch.set(db.doc(`cmsPublishQueue/${originalOperations.page}`), { status: "success",
    transport: "page-no-build-v1", noBuildPage: owners.page, backgroundRuntime: runtime });
  batch.set(pageOwnership.pageRouteRef(db, "/contact/"), {
    schemaVersion: 1, pageId: ownerIds.page, path: "/contact/" });
  await batch.commit();
  await writeUsage("cmsPosts", ownerIds.postA, published.postA);
  await writeUsage("cmsPosts", ownerIds.postB, published.postB);
  await writeUsage("cmsPages", ownerIds.page, published.page);
  return { blocks, documents, published };
}

async function republishPostB(projection) {
  const ref = firestore.doc(`cmsPosts/${ownerIds.postB}`);
  const before = (await ref.get()).data();
  const version = before.version + 1;
  const source = postSource(ownerIds.postB, before.published.blocks[0], version,
    "Newer independently republished Post B");
  const published = freezeSource("cmsPosts", source, projection);
  const nextDocument = { ...before, ...source, version, publiclyVisible: true, published };
  let operation;
  await firestore.runTransaction(async transaction => {
    const queueRef = firestore.collection("cmsPublishQueue").doc();
    const prepared = await postPublication.prepareNoBuildPostPublication({ firestore, transaction,
      collection: "cmsPosts", documentId: ownerIds.postB, nextDocument, queueRef,
      actor: { uid: actor.uid, email: actor.email }, target: publicationTargets.publicationTarget("development") });
    if (!prepared) throw new Error("The stale Post fixture did not receive its compiled owner");
    const write = await datasetUsage.prepareDatasetUsageWrites({ firestore, transaction,
      collection: "cmsPosts", documentId: ownerIds.postB, snapshot: published, visible: true,
      previousSnapshot: before.published, operationId: prepared.operation.operationId });
    prepared.write();
    write();
    transaction.set(ref, { ...nextDocument, publishBuildPending: true,
      publishBuildQueueId: prepared.contentQueueId });
    operation = prepared.operation;
  });
  return { operation, document: nextDocument };
}

async function ownerTasks(jobId) {
  const rows = await firestore.collection(`cmsDatasetRefreshJobs/${jobId}/owners`).orderBy("__name__").get();
  return new Map(rows.docs.map(row => [`${row.data().capture.collection}/${row.data().capture.documentId}`,
    { ref: row.ref, ...row.data() }]));
}

function detailReceipt(task, owner, contextDigest, { wrongDatasetDigest = false } = {}) {
  const base = { operationId: task.operationId, sourceVersion: task.sourceVersion, visible: owner.visible,
    rendererSha: owner.rendererSha, contextDigest, admissionRevision: owner.admissionRevision ?? 1,
    snapshotDigest: task.snapshotDigest,
    datasetFiguresDigest: wrongDatasetDigest ? "0".repeat(64) : task.datasetFiguresDigest };
  if (task.capture.collection === "cmsPosts") return { ...base, ...(owner.visible ? owner.contentRedirectUrl
    ? { htmlDigest: null, contentRedirectUrl: owner.contentRedirectUrl } : { htmlDigest: "d".repeat(64) } : {}) };
  return { ...base, routes: [owner.contentRedirectUrl ? { path: owner.path, status: 302, htmlDigest: null, location: owner.contentRedirectUrl }
    : { path: owner.path, status: 200, htmlDigest: "e".repeat(64) }] };
}

async function seedPersistedReceipts(tasks, { wrongPage = false, rendererSha = sha, contextOperationId, detailOnly = false } = {}) {
  const receiptRuntime = { owner: "cloudflare", release: rendererSha };
  const revision = (await firestore.doc(context.PUBLIC_CONTEXT_PATH).get()).data().revision;
  const contextDigest = context.publicContextDigest(revision);
  const batch = firestore.batch();
  const outputReceipts = {};
  const current = (await firestore.doc(publicContext.CURRENT_PATH).get()).data();
  for (const output of detailOnly ? [] : recordNamespace.contextOutputs(current)) {
    const ref = firestore.doc(`cmsBackgroundOutputs/${output}`);
    const state = (await ref.get()).data();
    if (!state) throw new Error(`The ${output} background owner was not reserved`);
    const receipt = { runtime: receiptRuntime, revision: state.revision, rendererSha, contextDigest,
      routeSetDigest: datasetDependencies.digest([output, revision]),
      digest: datasetDependencies.digest({ output, revision }), verifiedAt: Date.now(),
      withdrawalRevision: 0, homeRevision: 0 };
    outputReceipts[output] = { rendererSha, contextRevision: revision, contextDigest,
      verifiedAt: receipt.verifiedAt, revision: state.revision, digest: receipt.digest,
      routeSetDigest: receipt.routeSetDigest, taskPath: state.taskPath };
    batch.update(ref, { status: "verified", contextDigest, receipt });
    batch.update(firestore.doc(state.taskPath), { status: "verified", contextDigest,
      claim: null, nextAttemptAt: null, error: null, receipt });
  }
  for (const [path, task] of tasks) {
    const ownerPath = task.capture.collection === "cmsPages"
      ? `${pageOwnership.PAGE_OWNER_COLLECTION}/${task.capture.documentId}`
      : `${postOwnership.OWNER_COLLECTION}/${task.capture.documentId}`;
    const owner = (await firestore.doc(ownerPath).get()).data();
    const receipt = detailReceipt(task, { ...owner, rendererSha }, contextDigest,
      { wrongDatasetDigest: wrongPage && path === `cmsPages/${ownerIds.page}` });
    const queueRef = firestore.doc(`cmsPublishQueue/${task.operationId}`);
    if (task.capture.collection === "cmsPosts") {
      batch.update(queueRef, { status: "success", publicReceipt: receipt,
        ...(owner.visible ? { postProof: { status: "verified", attempts: 1, claim: null,
          nextAttemptAt: null, error: null } } : {}) });
    } else {
      const queue = (await queueRef.get()).data();
      batch.update(queueRef, { status: "success", publicReceipt: receipt,
        claim: null, nextAttemptAt: null, error: null });
      if (detailOnly) continue;
      const contextRef = firestore.doc(`cmsPublishQueue/${contextOperationId ?? queue.contextPublication.queueId}`);
      const contextJob = (await contextRef.get()).data();
      const aggregateOutputs = Object.fromEntries(Object.entries(outputReceipts).map(([output, value]) =>
        [output, { ...value, contextRevision: contextJob.publicContext.contextRevision,
          contextDigest: contextJob.publicContext.contextDigest }]));
      batch.update(contextRef, { status: "success", aggregateReceipt: { runtime: receiptRuntime,
        contextRevision: contextJob.publicContext.contextRevision,
        contextDigest: contextJob.publicContext.contextDigest, outputs: aggregateOutputs } });
    }
  }
  await batch.commit();
}

function workingDocument(document) {
  const working = structuredClone(document);
  delete working.published;
  delete working.publishBuildPending;
  delete working.publishBuildQueueId;
  return working;
}

function expectExactCompletion(jobId, job, tasks, expected) {
  const receiptDigests = [...tasks.values()].map(task => task.receiptDigest).sort();
  expect(job).toMatchObject({ status: "success", verifiedOwnerCount: expected.verifiedOwnerCount,
    supersededOwnerCount: 0, failedOwnerCount: 0 });
  expect(job.receipt).toEqual({ schemaVersion: 1, jobId, action: expected.action,
    datasetId: expected.datasetId, releaseId: expected.releaseId, revision: expected.revision,
    approvedDigest: expected.approvedDigest, captureDigest: job.captureDigest,
    expectedUseCount: expected.expectedUseCount, expectedOwnerCount: expected.expectedOwnerCount,
    verifiedOwnerCount: expected.verifiedOwnerCount, supersededOwnerCount: 0, failedOwnerCount: 0,
    sortedOwnerReceiptDigests: receiptDigests,
    ownerReceiptsDigest: datasetDependencies.digest(receiptDigests),
    completedAt: expect.any(String) });
}

beforeAll(async () => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") ||
      !/^127\.0\.0\.1:\d+$/.test(process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "") ||
      !/^demo-njpbs(?:-[a-z0-9-]+)?$/.test(project)) {
    throw new Error("Use local demo Auth and Firestore emulators");
  }
  const uid = `dataset-refresh-${randomUUID()}`;
  const email = `${uid}@example.test`;
  await admin.auth().createUser({ uid, email, emailVerified: true });
  const signIn = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=synthetic`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: await admin.auth().createCustomToken(uid), returnSecureToken: true }),
  });
  if (!signIn.ok) throw new Error("Synthetic emulator sign-in failed");
  actor = { uid, email, token: (await signIn.json()).idToken };
  const handler = withCmsEdge(datasetsEndpoint.createDatasetsHandler({ firestore }),
    { readSecret: () => "synthetic-edge" });
  const bulkHandler = withCmsEdge(bulkArchive.createCmsBulkArchiveHandler({ firestore,
    log: { error() {} } }), { readSecret: () => "synthetic-edge" });
  const previewHandler = withCmsEdge(preview.createCmsPreviewHandler({ firestore,
    getTransport: () => "serializer", serializerReady: true, getRendererSha: () => sha,
    assertBillingEnabledFn: async () => true, log: { error() {}, warn() {} } }), { readSecret: () => "synthetic-edge" });
  server = createServer(async (request, result) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    request.rawBody = Buffer.concat(chunks);
    request.body = JSON.parse(request.rawBody.toString());
    result.set = (name, value) => { result.setHeader(name, value); return result; };
    result.status = code => { result.statusCode = code; return result; };
    result.json = body => responseBody(result, body);
    await (request.url === "/bulk-archive" ? bulkHandler : request.url === "/preview" ? previewHandler : handler)(request, result);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
}, 20_000);

beforeEach(async () => {
  vi.stubEnv("CMS_DEPLOYMENT_ENVIRONMENT", "development");
  vi.stubEnv("FUNCTIONS_EMULATOR", "true");
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${project}/databases/(default)/documents`,
    { method: "DELETE" });
  await db.doc(`users/${actor.uid}`).set({ active: true, role: "admin", email: actor.email, displayName: "Dataset approver" });
  await seedSystem();
});

afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (actor?.uid) await admin.auth().deleteUser(actor.uid).catch(() => {});
});

describe("durable dataset correction refresh", () => {
  async function capturedCorrection({ runWorker = true, customLinks = false } = {}) {
    let record = await approveFreshDataset();
    const selected = await call({ action: "figure", id: record.id, version: { mode: "pinned", releaseId: record.approvedReleaseId } });
    await seedPublishedOwners(record.id, record.approvedReleaseId, selected.body.figure, undefined, false, customLinks);
    record = await saveDataset({ ...datasetRelease(), value: 4.3, changeKind: "correction", changeNote: "Corrected terminal-state measure." }, record);
    record = (await transition(record, "review")).body.dataset;
    const approved = await transition(record, "approve", { expectedUseCount: 3 });
    expect(approved.status, approved.body.error).toBe(200);
    if (runWorker) await datasetRefresh.processDatasetRefreshJob({ firestore, jobId: approved.body.dataset.refreshJobId });
    return approved.body.dataset;
  }

  it.each(["matching", "Post destination", "Page destination", "Page status", "missing Post destination"])("binds custom-link dataset refresh receipts: %s", async fault => {
    const record = await capturedCorrection({ customLinks: true });
    const tasks = await ownerTasks(record.refreshJobId);
    await seedPersistedReceipts(tasks);
    const task = tasks.get(`cmsPosts/${ownerIds.postA}`);
    const owner = (await firestore.doc(`${postOwnership.OWNER_COLLECTION}/${ownerIds.postA}`).get()).data();
    const contextDigest = context.publicContextDigest((await firestore.doc(context.PUBLIC_CONTEXT_PATH).get()).data().revision);
    // Only HTTP is substituted; serialize the real Post confirmation receipt,
    // store it in Firestore and consume it through the dataset refresh worker.
    const receipt = await postRecovery.readPublicPostReceipt(owner, async () => new Response(null, { status: 302, headers: {
      location: "https://example.test/election-results", "x-robots-tag": "noindex, nofollow", "cache-control": "no-store",
      "x-njpbs-content-source": "cms-no-build", "x-njpbs-publication-operation": owner.operationId,
      "x-njpbs-source-version": String(owner.sourceVersion), "x-njpbs-snapshot-sha256": owner.snapshotDigest,
      "x-njpbs-dataset-figures-sha256": owner.datasetFiguresDigest, "x-njpbs-renderer-sha": sha,
      "x-njpbs-context-sha256": contextDigest, "x-njpbs-admission-revision": "1",
    } }), new AbortController().signal, publicationTargets.publicationTarget("development"), new Headers());
    expect(receipt).toMatchObject({ htmlDigest: null, contentRedirectUrl: "https://example.test/election-results" });
    if (fault === "Post destination") receipt.contentRedirectUrl = "https://example.test/wrong";
    if (fault === "missing Post destination") delete receipt.contentRedirectUrl;
    await firestore.doc(`cmsPublishQueue/${task.operationId}`).update({ publicReceipt: receipt });
    if (["Page destination", "Page status"].includes(fault)) {
      const pageQueue = firestore.doc(`cmsPublishQueue/${tasks.get(`cmsPages/${ownerIds.page}`).operationId}`);
      const pageReceipt = (await pageQueue.get()).data().publicReceipt;
      if (fault === "Page destination") pageReceipt.routes[0].location = "https://example.test/wrong";
      else Object.assign(pageReceipt.routes[0], { status: 200, htmlDigest: "e".repeat(64) });
      await pageQueue.update({ publicReceipt: pageReceipt });
    }
    await datasetRefresh.processDatasetRefreshJob({ firestore, jobId: record.refreshJobId });
    const completed = await ownerTasks(record.refreshJobId);
    for (const [path, row] of completed) expect(row.status, path).toBe(
      ["Page destination", "Page status"].includes(fault) && path === `cmsPages/${ownerIds.page}` ||
      ["Post destination", "missing Post destination"].includes(fault) && path === `cmsPosts/${ownerIds.postA}` ? "failed" : "verified");
    expect((await firestore.doc(`cmsDatasetRefreshJobs/${record.refreshJobId}`).get()).data())
      .toMatchObject({ failedOwnerCount: fault === "matching" ? 0 : 1, verifiedOwnerCount: fault === "matching" ? 3 : 2 });
  });

  it.each(["code release", "admission pause", "runtime pause"])("automatically resumes a correction after a temporary %s", async reason => {
    const record = await capturedCorrection({ runWorker: false });
    const controls = {
      "code release": { path: "system/publicDeployment", paused: { activeCommitSha: "b".repeat(40) }, resumed: { activeCommitSha: sha } },
      "admission pause": { path: "system/noBuildPostAdmission", paused: { enabled: false }, resumed: { enabled: true } },
      "runtime pause": { path: "system/cmsPublicationRuntime", paused: { "cloud.phase": "paused" }, resumed: { "cloud.phase": "ready" } },
    }[reason];
    const controlRef = firestore.doc(controls.path);
    await controlRef.update(controls.paused);
    await datasetRefresh.recoverDatasetRefreshJobs({ firestore });
    let tasks = await ownerTasks(record.refreshJobId);
    expect(tasks.size).toBe(3);
    for (const task of tasks.values()) expect(task).toMatchObject({ status: "pending", operationId: null });
    expect((await firestore.doc(`cmsDatasetRefreshJobs/${record.refreshJobId}`).get()).data())
      .toMatchObject({ status: "pending", failedOwnerCount: 0, verifiedOwnerCount: 0 });
    for (const key of ["postA", "postB", "page"]) {
      const collection = key === "page" ? "cmsPages" : "cmsPosts";
      expect((await firestore.doc(`${collection}/${ownerIds[key]}`).get()).data().published.datasetFigures.releases[0].revision).toBe(1);
    }
    await controlRef.update(controls.resumed);
    await datasetRefresh.recoverDatasetRefreshJobs({ firestore });
    tasks = await ownerTasks(record.refreshJobId);
    for (const task of tasks.values()) expect(task).toMatchObject({ status: "pending", operationId: expect.stringMatching(/^[A-Za-z0-9]{20}$/) });
    await seedPersistedReceipts(tasks);
    await datasetRefresh.recoverDatasetRefreshJobs({ firestore });
    expect((await firestore.doc(`cmsDatasetRefreshJobs/${record.refreshJobId}`).get()).data())
      .toMatchObject({ status: "success", verifiedOwnerCount: 3, failedOwnerCount: 0 });
    const next = await transition(record, "archive", { expectedUseCount: 3 });
    expect(next.status, next.body.error).toBe(200);
  });

  it.each([["ABORTED", 10], ["UNAVAILABLE", 14]])("automatically resumes after an exhausted Firestore %s error", async (_name, code) => {
    const record = await capturedCorrection({ runWorker: false });
    // Fail a database read after SDK retries are exhausted, while retaining the
    // real transactions, private records and HTTP approval boundary.
    const interrupted = new Proxy(firestore, { get(target, key) {
      if (key === "runTransaction") return (callback, options) => target.runTransaction(transaction => callback(
        new Proxy(transaction, { get(current, property) {
          if (property === "get") return reference => {
            if (reference.path?.startsWith(`cmsDatasetRefreshJobs/${record.refreshJobId}/owners/`)) {
              throw Object.assign(new Error("Synthetic database interruption"), { code });
            }
            return current.get(reference);
          };
          const value = Reflect.get(current, property);
          return typeof value === "function" ? value.bind(current) : value;
        } }),
      ), { ...options, maxAttempts: 1 });
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    await datasetRefresh.recoverDatasetRefreshJobs({ firestore: interrupted });
    let tasks = await ownerTasks(record.refreshJobId);
    expect(tasks.size).toBe(3);
    for (const task of tasks.values()) expect(task).toMatchObject({ status: "pending", operationId: null });
    expect((await firestore.doc(`cmsDatasetRefreshJobs/${record.refreshJobId}`).get()).data())
      .toMatchObject({ status: "pending", failedOwnerCount: 0 });
    await datasetRefresh.recoverDatasetRefreshJobs({ firestore });
    tasks = await ownerTasks(record.refreshJobId);
    await seedPersistedReceipts(tasks);
    await datasetRefresh.recoverDatasetRefreshJobs({ firestore });
    expect((await firestore.doc(`cmsDatasetRefreshJobs/${record.refreshJobId}`).get()).data())
      .toMatchObject({ status: "success", verifiedOwnerCount: 3, failedOwnerCount: 0 });
  });

  it.each([undefined, "programs"])("completes a Page whose aggregate was superseded by a later context operation (%s)", async recordFamily => {
    const record = await capturedCorrection();
    const tasks = await ownerTasks(record.refreshJobId);
    const pageTask = tasks.get(`cmsPages/${ownerIds.page}`);
    const pageQueue = (await firestore.doc(`cmsPublishQueue/${pageTask.operationId}`).get()).data();
    const replacementId = "R".repeat(20);
    await firestore.runTransaction(async transaction => {
      const contextRef = firestore.doc(context.PUBLIC_CONTEXT_PATH);
      const prior = (await transaction.get(contextRef)).data();
      const prepared = await publicContext.enqueuePublicContextInTransaction({ firestore, transaction,
        operationId: replacementId, runtime, reason: "settings", contextRevision: prior.revision + 1, recordFamily });
      prepared.write();
      transaction.update(contextRef, { revision: prior.revision + 1 });
    });
    const originalContextRef = firestore.doc(`cmsPublishQueue/${pageQueue.contextPublication.queueId}`);
    expect((await originalContextRef.get()).data()).toMatchObject({ status: "cancelled", error: "public_context_superseded" });
    await seedPersistedReceipts(tasks, { contextOperationId: replacementId });
    await datasetRefresh.processDatasetRefreshJob({ firestore, jobId: record.refreshJobId });
    const completed = await ownerTasks(record.refreshJobId);
    expect((await firestore.doc(`cmsDatasetRefreshJobs/${record.refreshJobId}`).get()).data())
      .toMatchObject({ status: "success", verifiedOwnerCount: 3 });
    const currentAggregate = (await firestore.doc(`cmsPublishQueue/${replacementId}`).get()).data().aggregateReceipt;
    if (recordFamily) expect(Object.keys(currentAggregate.outputs)).toEqual(["listings", "authors", "feed", "contentApi", "sitemap", "search", "programs"]);
    expect(completed.get(`cmsPages/${ownerIds.page}`).receipt.aggregateReceiptDigest).toBe(datasetDependencies.digest(currentAggregate));
    expect((await originalContextRef.get()).data().status).toBe("cancelled");
  });

  it.each([false, true])("waits for a superseding Page aggregate behind a frozen cohort (live advanced: %s)", async liveAdvanced => {
    const frozenId = "F".repeat(20), replacementId = "R".repeat(20);
    await firestore.runTransaction(async transaction => {
      const accepted = await publicContext.enqueuePublicContextInTransaction({ firestore, transaction,
        operationId: frozenId, runtime, reason: "context", contextRevision: 1 });
      accepted.write();
    });
    await firestore.doc(`cmsPublishQueue/${frozenId}/backgroundPreparation/${context.publicContextDigest(1)}`).set({
      runtime, contextDigest: context.publicContextDigest(1), status: "building",
      frozenContext: { revision: 1, withdrawalRevision: 0, homeRevision: 0 } });
    const record = await capturedCorrection();
    const tasks = await ownerTasks(record.refreshJobId);
    const pageTask = tasks.get(`cmsPages/${ownerIds.page}`);
    const pageQueue = (await firestore.doc(`cmsPublishQueue/${pageTask.operationId}`).get()).data();
    const revision = (await firestore.doc(context.PUBLIC_CONTEXT_PATH).get()).data().revision + 1;
    await firestore.runTransaction(async transaction => {
      const accepted = await publicContext.enqueuePublicContextInTransaction({ firestore, transaction,
        operationId: replacementId, runtime, reason: "settings", contextRevision: revision });
      accepted.write();
      transaction.update(firestore.doc(context.PUBLIC_CONTEXT_PATH), { revision });
    });
    expect((await firestore.doc(`cmsPublishQueue/${pageQueue.contextPublication.queueId}`).get()).data())
      .toMatchObject({ status: "cancelled", error: "public_context_superseded" });
    if (liveAdvanced) await firestore.doc(context.PUBLIC_CONTEXT_PATH).update({ revision: revision + 1 });
    await seedPersistedReceipts(tasks, { detailOnly: true });
    await datasetRefresh.processDatasetRefreshJob({ firestore, jobId: record.refreshJobId });
    expect((await ownerTasks(record.refreshJobId)).get(`cmsPages/${ownerIds.page}`)).toMatchObject({ status: "pending", error: null });
    expect((await firestore.doc(`cmsDatasetRefreshJobs/${record.refreshJobId}`).get()).data().failedOwnerCount).toBe(0);
    await firestore.doc(`cmsPublishQueue/${frozenId}`).update({ status: "success" });
    const latestId = liveAdvanced ? "L".repeat(20) : replacementId;
    await firestore.runTransaction(async transaction => {
      const accepted = await publicContext.enqueuePublicContextInTransaction({ firestore, transaction,
        operationId: latestId, runtime, reason: "settings", contextRevision: revision + (liveAdvanced ? 1 : 0),
        activateQueued: !liveAdvanced });
      accepted.write();
    });
    await seedPersistedReceipts(tasks, { contextOperationId: latestId });
    await datasetRefresh.processDatasetRefreshJob({ firestore, jobId: record.refreshJobId });
    expect((await firestore.doc(`cmsDatasetRefreshJobs/${record.refreshJobId}`).get()).data())
      .toMatchObject({ status: "success", verifiedOwnerCount: 3, failedOwnerCount: 0 });
  });

  it("completes a superseded Post withdrawal without a visible Post proof", async () => {
    const record = await capturedCorrection();
    const post = (await firestore.doc(`cmsPosts/${ownerIds.postA}`).get()).data();
    const archived = await call({ items: [{ collection: "cmsPosts", id: ownerIds.postA, baseVersion: post.version }] }, "/bulk-archive");
    expect(archived.status, archived.body.error).toBe(200);
    await datasetRefresh.processDatasetRefreshJob({ firestore, jobId: record.refreshJobId });
    const tasks = await ownerTasks(record.refreshJobId);
    const task = tasks.get(`cmsPosts/${ownerIds.postA}`);
    expect(task).toMatchObject({ superseded: true, status: "pending" });
    await seedPersistedReceipts(tasks);
    const queue = (await firestore.doc(`cmsPublishQueue/${task.operationId}`).get()).data();
    expect(queue).not.toHaveProperty("postProof");
    expect(queue.publicReceipt).toMatchObject({ visible: false, operationId: task.operationId });
    expect(queue.publicReceipt).not.toHaveProperty("htmlDigest");
    await datasetRefresh.processDatasetRefreshJob({ firestore, jobId: record.refreshJobId });
    const job = (await firestore.doc(`cmsDatasetRefreshJobs/${record.refreshJobId}`).get()).data();
    expect(job).toMatchObject({ status: "success", verifiedOwnerCount: 2, supersededOwnerCount: 1 });
    const next = await transition(record, "archive", { expectedUseCount: 2 });
    expect(next.status, next.body.error).toBe(200);
  });

  it.each([true, false])("rebuilds a corrected figure in an exact ready preview (persistent %s)", async persistent => {
    let record = await approveFreshDataset();
    const block = dataFigureBlock("figure-preview", record.id, { mode: "pinned", releaseId: record.approvedReleaseId });
    await firestore.doc(`cmsPages/${ownerIds.page}`).set(pageSource(block, 7, "Preview figure"));
    const request = { collection: "cmsPages", pageId: ownerIds.page, sourceVersion: 7, persistent };
    const first = await call(request, "/preview");
    expect(first.status, first.body.error).toBe(202);
    const queueRef = firestore.doc(`cmsPreviewQueue/${first.body.queueId}`);
    await queueRef.update({ status: "ready", previewUrl: `https://preview.njpbs.org/${persistent ? "s" : "p"}/${first.body.queueId}/`,
      completedAt: new Date(), expiresAt: new Date(Date.now() + 3600_000) });
    await firestore.doc(`cmsPreviewHeads/${previewTarget.previewContentKey("cmsPages", ownerIds.page)}`).update({ readyQueueId: first.body.queueId });
    const unchanged = await call(request, "/preview");
    expect(unchanged.body).toMatchObject({ queueId: first.body.queueId, reused: true });
    record = await saveDataset({ ...datasetRelease(), value: 4.3, changeKind: "correction", changeNote: "Corrected preview measure." }, record);
    record = (await transition(record, "review")).body.dataset;
    const approved = await transition(record, "approve", { expectedUseCount: 0 });
    expect(approved.status, approved.body.error).toBe(200);
    const corrected = await call(request, "/preview");
    expect(corrected.status, corrected.body.error).toBe(202);
    expect(corrected.body.queueId).not.toBe(first.body.queueId);
    expect((await firestore.doc(`cmsPreviewQueue/${corrected.body.queueId}`).get()).data().snapshot.datasetFigures.releases[0])
      .toMatchObject({ revision: 2, release: { value: 4.3 } });
    expect((await firestore.doc(`cmsPages/${ownerIds.page}`).get()).data().version).toBe(7);
  });

  it("verifies retained Page and Post owners against a newly active renderer", async () => {
    let record = await approveFreshDataset();
    const selected = await call({ action: "figure", id: record.id, version: { mode: "pinned", releaseId: record.approvedReleaseId } });
    await seedPublishedOwners(record.id, record.approvedReleaseId, selected.body.figure);
    record = await saveDataset({ ...datasetRelease(), value: 4.3, changeKind: "correction", changeNote: "Corrected measure." }, record);
    record = (await transition(record, "review")).body.dataset;
    const approved = await transition(record, "approve", { expectedUseCount: 3 });
    expect(approved.status, approved.body.error).toBe(200);
    const jobId = approved.body.dataset.refreshJobId;
    await datasetRefresh.processDatasetRefreshJob({ firestore, jobId });
    const tasks = await ownerTasks(jobId);
    expect([...tasks.values()].every(task => task.status === "pending" && task.operationId)).toBe(true);
    const nextRenderer = "b".repeat(40);
    await firestore.doc(postOwnership.CAPABILITY_PATH).update({ rendererSha: nextRenderer, generation: 2 });
    await firestore.doc(pageOwnership.PAGE_CAPABILITY_PATH).update({ rendererSha: nextRenderer, generation: 2,
      "terminalOwner.rendererSha": nextRenderer });
    await firestore.doc("system/publicDeployment").update({ activeCommitSha: nextRenderer, activeGeneration: 2 });
    await seedPersistedReceipts(tasks, { rendererSha: nextRenderer });
    await datasetRefresh.processDatasetRefreshJob({ firestore, jobId });
    const completed = await ownerTasks(jobId);
    expect((await firestore.doc(`cmsDatasetRefreshJobs/${jobId}`).get()).data()).toMatchObject({ status: "success", verifiedOwnerCount: 3 });
    for (const task of completed.values()) {
      expect(task.receipt.rendererSha).toBe(nextRenderer);
      expect((await firestore.doc(`${task.capture.collection === "cmsPages" ? pageOwnership.PAGE_OWNER_COLLECTION : postOwnership.OWNER_COLLECTION}/${task.capture.documentId}`).get()).data().rendererSha).toBe(sha);
    }
  });

  it.each([false, true])("keeps snapshot maintenance from blocking other owners' approval (election section: %s)", async election => {
    let record = await approveFreshDataset();
    const projection = await call({ action: "figure", id: record.id,
      version: { mode: "pinned", releaseId: record.approvedReleaseId } });
    expect(projection.status).toBe(200);
    await seedPublishedOwners(record.id, record.approvedReleaseId, projection.body.figure, undefined, election);
    // Video withdrawal maintenance can rewrite this server-owned snapshot field
    // after publication without changing the compiled owner's usage receipt.
    await firestore.doc(`cmsPosts/${ownerIds.postA}`).update({ "published.previousVideoCopies": [] });
    record = await saveDataset({ ...datasetRelease(), value: 4.3, changeKind: "correction",
      changeNote: "Corrected measure." }, record);
    record = (await transition(record, "review")).body.dataset;
    const approved = await transition(record, "approve", { expectedUseCount: 3 });
    expect(approved.status, approved.body.error).toBe(200);
    const jobId = approved.body.dataset.refreshJobId;
    await datasetRefresh.processDatasetRefreshJob({ firestore, jobId, maxOwners: 5 });
    const tasks = await ownerTasks(jobId);
    expect(tasks.get(`cmsPosts/${ownerIds.postA}`).status).toBe("failed");
    for (const path of [`cmsPosts/${ownerIds.postB}`, `cmsPages/${ownerIds.page}`]) {
      expect(tasks.get(path)).toMatchObject({ status: "pending", operationId: expect.any(String) });
    }
  });

  it("fails unavailable and over-capacity scheduled figures without blocking later Posts and Pages", async () => {
    const archived = await approveFreshDataset();
    const withdrawn = await transition(archived, "archive", { expectedUseCount: 0 });
    expect(withdrawn.status, withdrawn.body.error).toBe(200);
    const full = await approveFreshDataset();
    const projection = await call({ action: "figure", id: full.id,
      version: { mode: "pinned", releaseId: full.approvedReleaseId } });
    expect(projection.status, projection.body.error).toBe(200);
    const capacity = firestore.batch();
    for (let index = 0; index < 500; index += 1) {
      const identity = { collection: "cmsPosts", documentId: `capacity-owner-${index}`, blockId: "figure" };
      capacity.set(firestore.doc(`cmsDatasetUses/${datasetUsage.useId(identity)}`), {
        schemaVersion: 1, ...identity, datasetId: full.id, state: "published", releasePolicy: "pinned",
        releaseId: full.approvedReleaseId, revision: 1, approvedDigest: projection.body.figure.digest,
        operationId: "C".repeat(20), sourceVersion: 1, snapshotDigest: "c".repeat(64),
        ownerSnapshotDigest: "c".repeat(64), editorialSnapshotDigest: "e".repeat(64),
      });
    }
    await capacity.commit();
    await firestore.doc(`cmsDatasets/${full.id}`).update({ publishedUseCount: 500, usageRevision: 1 });
    const unavailable = postSource("schedule-unavailable", dataFigureBlock("unavailable", archived.id,
      { mode: "pinned", releaseId: archived.approvedReleaseId }), 1, "Unavailable source");
    const overCapacity = postSource("schedule-capacity", dataFigureBlock("capacity", full.id,
      { mode: "pinned", releaseId: full.approvedReleaseId }), 1, "Full source");
    const healthyPost = postSource("schedule-healthy", { id: "post-divider", type: "divider", order: 0,
      visible: true, data: {} }, 1, "Healthy later Post");
    const healthyPage = pageSource({ id: "page-divider", type: "divider", order: 0,
      visible: true, data: {} }, 1, "Healthy later Page");
    const batch = firestore.batch();
    for (const [index, document] of [unavailable, overCapacity, healthyPost].entries()) {
      batch.set(firestore.doc(`cmsPosts/${document.id}`), { ...document, status: "scheduled",
        publishAt: `2026-10-20T11:0${index}:00.000Z` });
    }
    batch.set(firestore.doc(`cmsPages/${ownerIds.page}`), { ...healthyPage, status: "scheduled",
      publishAt: "2026-10-20T11:03:00.000Z" });
    await batch.commit();
    const result = await scheduler.createScheduledPublishRunner({ firestore,
      now: () => "2026-10-20T12:00:00.000Z" })();
    expect(result.publishedCount).toBe(2);
    expect(result.changes.map(change => `${change.collection}/${change.id}`).sort())
      .toEqual([`cmsPages/${ownerIds.page}`, "cmsPosts/schedule-healthy"]);
    for (const [id, reason] of [[unavailable.id, "archived"], [overCapacity.id, "500"]]) {
      const blocked = (await firestore.doc(`cmsPosts/${id}`).get()).data();
      expect(blocked).toMatchObject({ status: "draft", version: 2,
        scheduledPublishFailure: { failedBy: scheduler.SCHEDULER_ACTOR } });
      expect(blocked.scheduledPublishFailure.reason).toContain(reason);
      expect(blocked).not.toHaveProperty("publishAt");
      expect(blocked).not.toHaveProperty("published");
    }
    const failures = await firestore.collection(audit.AUDIT_COLLECTIONS.adminLogs)
      .where("action", "==", "cms.schedule-publish-failed").get();
    expect(failures.docs.map(row => row.data().target).sort())
      .toEqual(["cmsPosts/schedule-capacity", "cmsPosts/schedule-unavailable"]);
    const histories = await firestore.collection(audit.AUDIT_COLLECTIONS.versionHistory)
      .where("action", "==", "schedule-publish-failed").get();
    expect(histories.size).toBe(2);
    expect(histories.docs.every(row => row.data().restorable === false)).toBe(true);
    expect((await firestore.collection("cmsDatasetUses").where("datasetId", "==", full.id).get()).size).toBe(500);
    expect((await firestore.doc(`cmsDatasets/${full.id}`).get()).data().publishedUseCount).toBe(500);
  }, 30_000);

  it("clears bulk-archived figure uses before a later dataset correction and archive", async () => {
    let record = await approveFreshDataset();
    const approved = await call({ action: "figure", id: record.id,
      version: { mode: "pinned", releaseId: record.approvedReleaseId } });
    expect(approved.status, approved.body.error).toBe(200);
    const initial = await seedPublishedOwners(record.id, record.approvedReleaseId, approved.body.figure);
    const items = ["postA", "postB"].map(key => ({ id: ownerIds[key], baseVersion: initial.documents[key].version }));
    const archived = await call({ items }, "/bulk-archive");
    expect(archived.status, archived.body.error).toBe(200);
    expect(archived.body.counts.archived).toBe(2);
    for (const key of ["postA", "postB"]) {
      const owner = (await firestore.doc(`${postOwnership.OWNER_COLLECTION}/${ownerIds[key]}`).get()).data();
      expect(owner.visible).toBe(false);
    }
    const repeated = await call({ items }, "/bulk-archive");
    expect(repeated.body.counts.already_archived).toBe(2);
    const uses = await firestore.collection("cmsDatasetUses").where("datasetId", "==", record.id).get();
    expect(uses.size).toBe(1);
    expect(uses.docs[0].data()).toMatchObject({ collection: "cmsPages", documentId: ownerIds.page });
    expect((await firestore.doc(`cmsDatasets/${record.id}`).get()).data().publishedUseCount).toBe(1);
    record = await saveDataset({ ...datasetRelease(), value: 4.3, changeKind: "correction",
      changeNote: "Correct the remaining Page figure." }, record);
    record = (await transition(record, "review")).body.dataset;
    const correction = await transition(record, "approve", { expectedUseCount: 1 });
    expect(correction.status, correction.body.error).toBe(200);
    record = correction.body.dataset;
    await datasetRefresh.processDatasetRefreshJob({ firestore, jobId: record.refreshJobId });
    const tasks = await ownerTasks(record.refreshJobId);
    expect([...tasks.keys()]).toEqual([`cmsPages/${ownerIds.page}`]);
    await seedPersistedReceipts(tasks);
    await datasetRefresh.processDatasetRefreshJob({ firestore, jobId: record.refreshJobId });
    const withdrawal = await transition(record, "archive", { expectedUseCount: 1 });
    expect(withdrawal.status, withdrawal.body.error).toBe(200);
    const job = (await firestore.doc(`cmsDatasetRefreshJobs/${withdrawal.body.dataset.refreshJobId}`).get()).data();
    expect(job).toMatchObject({ action: "archive", expectedUseCount: 1, expectedOwnerCount: 1 });
    expect(job.captures[0]).toMatchObject({ collection: "cmsPages", documentId: ownerIds.page });
  }, 30_000);

  it("merges two captured dataset corrections on the same owners without changing editorial content", async () => {
    async function approve(release, record, expectedUseCount = 0) {
      const saved = await saveDataset(release, record);
      const reviewed = await transition(saved, "review");
      expect(reviewed.status, reviewed.body.error).toBe(200);
      const approved = await transition(reviewed.body.dataset, "approve", { expectedUseCount });
      expect(approved.status, approved.body.error).toBe(200);
      const dataset = approved.body.dataset;
      const projected = await call({ action: "figure", id: dataset.id,
        version: { mode: "pinned", releaseId: dataset.approvedReleaseId } });
      expect(projected.status, projected.body.error).toBe(200);
      return { dataset, projection: projected.body.figure, jobId: dataset.refreshJobId };
    }
    const firstRelease = datasetRelease();
    const secondRelease = { ...datasetRelease(), label: "Second synthetic measure", value: 7 };
    const first = await approve(firstRelease);
    const second = await approve(secondRelease);
    const initial = await seedPublishedOwners(first.dataset.id, first.projection.releaseId,
      first.projection, second.projection);
    const correctionA = await approve({ ...firstRelease, value: 4.3, changeKind: "correction",
      changeNote: "The source corrected the first measure." }, first.dataset, 3);
    const correctionB = await approve({ ...secondRelease, value: 7.1, changeKind: "correction",
      changeNote: "The source corrected the second measure." }, second.dataset, 3);
    const capturedA = (await firestore.doc(`cmsDatasetRefreshJobs/${correctionA.jobId}`).get()).data();
    const capturedB = (await firestore.doc(`cmsDatasetRefreshJobs/${correctionB.jobId}`).get()).data();
    await datasetRefresh.processDatasetRefreshJob({ firestore, jobId: correctionA.jobId });
    await datasetRefresh.processDatasetRefreshJob({ firestore, jobId: correctionB.jobId });
    let tasksB = await ownerTasks(correctionB.jobId);
    expect([...tasksB.values()].every(task => task.status === "pending" && task.operationId)).toBe(true);

    for (const key of ["postA", "postB", "page"]) {
      const collection = key === "page" ? "cmsPages" : "cmsPosts";
      const current = (await firestore.doc(`${collection}/${ownerIds[key]}`).get()).data();
      expect(workingDocument(current)).toEqual(workingDocument(initial.documents[key]));
      const { datasetFigures, ...editorial } = current.published;
      const { datasetFigures: originalFigures, ...originalEditorial } = initial.published[key];
      expect(originalFigures.releases.every(release => release.revision === 1)).toBe(true);
      expect(editorial).toEqual(originalEditorial);
      expect(datasetFigures.releases.find(release => release.datasetId === first.dataset.id))
        .toMatchObject({ revision: 2, release: { value: 4.3 } });
      expect(datasetFigures.releases.find(release => release.datasetId === second.dataset.id))
        .toMatchObject({ revision: 2, release: { value: 7.1 } });
    }
    await seedPersistedReceipts(tasksB);
    await datasetRefresh.processDatasetRefreshJob({ firestore, jobId: correctionB.jobId });
    await datasetRefresh.processDatasetRefreshJob({ firestore, jobId: correctionA.jobId });
    await datasetRefresh.processDatasetRefreshJob({ firestore, jobId: correctionA.jobId });
    tasksB = await ownerTasks(correctionB.jobId);
    expect([...tasksB.values()].every(task => task.status === "verified")).toBe(true);
    const tasksA = await ownerTasks(correctionA.jobId);
    expect([...tasksA.values()].every(task => task.status === "superseded")).toBe(true);
    for (const [jobId, captured] of [[correctionA.jobId, capturedA], [correctionB.jobId, capturedB]]) {
      const completed = (await firestore.doc(`cmsDatasetRefreshJobs/${jobId}`).get()).data();
      expect(completed).toMatchObject({ status: "success", captureDigest: captured.captureDigest,
        captures: captured.captures, failedOwnerCount: 0 });
      const tasks = await ownerTasks(jobId);
      expect(completed.receipt.sortedOwnerReceiptDigests)
        .toEqual([...tasks.values()].map(task => task.receiptDigest).sort());
    }
    const uses = await firestore.collection("cmsDatasetUses").get();
    expect(uses.size).toBe(6);
    expect(uses.docs.every(row => row.data().revision === 2)).toBe(true);
  }, 30_000);

  it("refreshes exact frozen owners, retries one failed receipt, and preserves a newer publication", async () => {
    const initialRelease = { ...datasetRelease(), nextReviewOn: "2026-11-15" };
    let record = await saveDataset(initialRelease);
    record = (await transition(record, "review")).body.dataset;
    const initialApprovalId = randomUUID();
    const initialApproval = { action: "approve", id: record.id, baseVersion: record.version,
      requestId: initialApprovalId, expectedUseCount: 0 };
    const approved = await call(initialApproval);
    expect(approved.status, approved.body.error).toBe(200);
    const replay = await call(initialApproval);
    expect(replay).toMatchObject({ status: 200, body: { replayed: true,
      dataset: { refreshJobId: approved.body.dataset.refreshJobId } } });
    expect(approved.body.dataset.refreshJobId)
      .toBe(datasetDependencies.digest([record.id, initialApprovalId]).slice(0, 32));
    expect((await firestore.collection("cmsDatasetRefreshJobs").get()).size).toBe(1);
    record = approved.body.dataset;
    const releaseId = record.approvedReleaseId;
    const figure = await call({ action: "figure", id: record.id,
      version: { mode: "pinned", releaseId } });
    expect(figure.status, figure.body.error).toBe(200);
    const revisionOne = figure.body.figure;
    expect(revisionOne).toMatchObject({ datasetId: record.id, releaseId, revision: 1,
      release: { value: 4.2, reuse: { display: "allowed" } } });
    expect(revisionOne.release).not.toHaveProperty("nextReviewOn");
    expect(revisionOne.release.reuse).not.toHaveProperty("evidence");
    const immutableRevisionOne = (await firestore.doc(
      `cmsDatasets/${record.id}/releases/${releaseId}/revisions/1`).get()).data();

    const initial = await seedPublishedOwners(record.id, releaseId, revisionOne);
    const uses = await firestore.collection("cmsDatasetUses").where("datasetId", "==", record.id).get();
    expect(uses.size).toBe(3);
    expect(uses.docs.map(row => row.data().releasePolicy).sort())
      .toEqual(["latestApproved", "latestApproved", "pinned"]);
    expect(uses.docs.every(row => row.data().revision === 1 && row.data().approvedDigest === revisionOne.digest)).toBe(true);
    expect(uses.docs.map(row => row.data().publicPath).sort())
      .toEqual(["/contact/", "/posts/dataset-post-a-story/", "/posts/dataset-post-b-story/"]);

    const privateProjection = structuredClone(initial.published.postA);
    privateProjection.datasetFigures.releases[0].release.reuse.evidence = "Private rights evidence";
    expect(() => datasetDependencies.validateFrozenDatasetFigures(privateProjection))
      .toThrow("The frozen data figures are invalid.");
    expect(datasetFigures.isDatasetFigures(privateProjection.datasetFigures)).toBe(false);

    const correctedRelease = { ...initialRelease, value: 4.3, changeKind: "correction",
      changeNote: "The source corrected the September value." };
    record = await saveDataset(correctedRelease, record);
    record = (await transition(record, "review")).body.dataset;
    const jobsBeforeConflict = (await firestore.collection("cmsDatasetRefreshJobs").get()).size;
    const countConflict = await transition(record, "approve", { expectedUseCount: 2 });
    expect(countConflict).toMatchObject({ status: 409,
      body: { error: "The affected use count changed. Review it again." } });
    expect((await firestore.doc(`cmsDatasets/${record.id}`).get()).data()).toMatchObject({
      version: record.version, state: "review" });
    expect((await firestore.collection("cmsDatasetRefreshJobs").get()).size).toBe(jobsBeforeConflict);

    const correctionRequestId = randomUUID();
    const correctionRequest = { action: "approve", id: record.id, baseVersion: record.version,
      requestId: correctionRequestId, expectedUseCount: 3 };
    const correction = await call(correctionRequest);
    expect(correction.status, correction.body.error).toBe(200);
    const correctionReplay = await call(correctionRequest);
    expect(correctionReplay).toMatchObject({ status: 200, body: { replayed: true,
      dataset: { refreshJobId: correction.body.dataset.refreshJobId } } });
    const jobId = correction.body.dataset.refreshJobId;
    expect(jobId).toBe(datasetDependencies.digest([record.id, correctionRequestId]).slice(0, 32));
    const jobBeforeWork = (await firestore.doc(`cmsDatasetRefreshJobs/${jobId}`).get()).data();
    expect(jobBeforeWork).toMatchObject({ action: "correction", datasetId: record.id,
      releaseId, revision: 2, expectedUseCount: 3, expectedOwnerCount: 3,
      status: "preparing" });
    expect(jobBeforeWork.captures).toHaveLength(3);
    expect(jobBeforeWork.captures.flatMap(capture => capture.uses)
      .every(use => use.revision === 1 && use.approvedDigest === revisionOne.digest)).toBe(true);

    const correctedFigure = await call({ action: "figure", id: record.id,
      version: { mode: "pinned", releaseId } });
    expect(correctedFigure.body.figure).toMatchObject({ revision: 2,
      digest: jobBeforeWork.approvedDigest, release: { value: 4.3 } });
    expect(correctedFigure.body.figure.release.reuse).not.toHaveProperty("evidence");
    const staleRepublish = await republishPostB(correctedFigure.body.figure);

    const postABefore = (await firestore.doc(`cmsPosts/${ownerIds.postA}`).get()).data();
    await datasetRefresh.processDatasetRefreshJob({ firestore, jobId, maxOwners: 5 });
    let tasks = await ownerTasks(jobId);
    expect(tasks.size).toBe(3);
    expect([...tasks.values()].every(task => task.status === "pending" && task.operationId)).toBe(true);
    expect(tasks.get(`cmsPosts/${ownerIds.postB}`)).toMatchObject({ superseded: true,
      operationId: staleRepublish.operation.operationId,
      sourceVersion: staleRepublish.operation.sourceVersion });

    await seedPersistedReceipts(tasks, { wrongPage: true });
    await datasetRefresh.processDatasetRefreshJob({ firestore, jobId, maxOwners: 5 });
    tasks = await ownerTasks(jobId);
    expect(tasks.get(`cmsPosts/${ownerIds.postA}`).status).toBe("verified");
    expect(tasks.get(`cmsPosts/${ownerIds.postB}`).status).toBe("superseded");
    expect(tasks.get(`cmsPages/${ownerIds.page}`)).toMatchObject({ status: "failed",
      error: "The dataset public receipt does not match its owner." });
    expect((await firestore.doc(`cmsDatasetRefreshJobs/${jobId}`).get()).data()).toMatchObject({
      status: "partial", verifiedOwnerCount: 1, supersededOwnerCount: 1, failedOwnerCount: 1 });

    const failedPage = tasks.get(`cmsPages/${ownerIds.page}`);
    await datasetRefresh.processDatasetRefreshJob({ firestore, jobId, maxOwners: 5 });
    expect((await ownerTasks(jobId)).get(`cmsPages/${ownerIds.page}`)).toEqual(failedPage);

    const postReceiptsBeforeRetry = await Promise.all([ownerIds.postA, ownerIds.postB].map(async id => {
      const task = tasks.get(`cmsPosts/${id}`);
      return (await firestore.doc(`cmsPublishQueue/${task.operationId}`).get()).data().publicReceipt;
    }));
    const retry = await call({ action: "retry", id: record.id });
    expect(retry.status, retry.body.error).toBe(200);
    tasks = await ownerTasks(jobId);
    expect(tasks.get(`cmsPosts/${ownerIds.postA}`).status).toBe("verified");
    expect(tasks.get(`cmsPosts/${ownerIds.postB}`).status).toBe("superseded");
    expect(tasks.get(`cmsPages/${ownerIds.page}`).status).toBe("pending");
    const postReceiptsAfterRetry = await Promise.all([ownerIds.postA, ownerIds.postB].map(async id => {
      const task = tasks.get(`cmsPosts/${id}`);
      return (await firestore.doc(`cmsPublishQueue/${task.operationId}`).get()).data().publicReceipt;
    }));
    expect(postReceiptsAfterRetry).toEqual(postReceiptsBeforeRetry);

    const pageTask = tasks.get(`cmsPages/${ownerIds.page}`);
    const pageOwnerState = (await firestore.doc(`${pageOwnership.PAGE_OWNER_COLLECTION}/${ownerIds.page}`).get()).data();
    const currentContext = context.publicContextDigest(
      (await firestore.doc(context.PUBLIC_CONTEXT_PATH).get()).data().revision);
    await firestore.doc(`cmsPublishQueue/${pageTask.operationId}`).update({
      publicReceipt: detailReceipt(pageTask, pageOwnerState, currentContext),
    });
    await datasetRefresh.processDatasetRefreshJob({ firestore, jobId, maxOwners: 5 });

    tasks = await ownerTasks(jobId);
    expect([...tasks.values()].map(task => task.status).sort())
      .toEqual(["superseded", "verified", "verified"]);
    const completed = (await firestore.doc(`cmsDatasetRefreshJobs/${jobId}`).get()).data();
    const receiptDigests = [...tasks.values()]
      .map(task => task.receiptDigest).sort();
    expect(completed).toMatchObject({ status: "success", verifiedOwnerCount: 2,
      supersededOwnerCount: 1, failedOwnerCount: 0,
      receipt: { schemaVersion: 1, jobId, action: "correction", datasetId: record.id,
        releaseId, revision: 2, approvedDigest: correctedFigure.body.figure.digest,
        captureDigest: completed.captureDigest, expectedUseCount: 3, expectedOwnerCount: 3,
        verifiedOwnerCount: 2, supersededOwnerCount: 1, failedOwnerCount: 0,
        sortedOwnerReceiptDigests: receiptDigests,
        ownerReceiptsDigest: datasetDependencies.digest(receiptDigests),
        completedAt: expect.any(String) } });

    const postAAfter = (await firestore.doc(`cmsPosts/${ownerIds.postA}`).get()).data();
    expect({ version: postAAfter.version, title: postAAfter.title, blocks: postAAfter.blocks,
      status: postAAfter.status }).toEqual({ version: postABefore.version, title: postABefore.title,
      blocks: postABefore.blocks, status: postABefore.status });
    const { datasetFigures: beforeFigures, ...postAPublishedBefore } = postABefore.published;
    const { datasetFigures: afterFigures, ...postAPublishedAfter } = postAAfter.published;
    expect(postAPublishedAfter).toEqual(postAPublishedBefore);
    expect(afterFigures.figures[0]).toMatchObject({ revision: 2,
      digest: correctedFigure.body.figure.digest });
    expect(beforeFigures.figures[0].revision).toBe(1);

    const pageAfter = (await firestore.doc(`cmsPages/${ownerIds.page}`).get()).data();
    expect({ version: pageAfter.version, title: pageAfter.title, blocks: pageAfter.blocks,
      status: pageAfter.status }).toEqual({ version: initial.documents.page.version,
      title: initial.documents.page.title, blocks: initial.documents.page.blocks,
      status: initial.documents.page.status });
    const { datasetFigures: _pageBeforeFigures, ...pagePublishedBefore } = initial.published.page;
    const { datasetFigures: pageFigures, ...pagePublishedAfter } = pageAfter.published;
    expect(pagePublishedAfter).toEqual(pagePublishedBefore);
    expect(pageFigures.figures[0]).toMatchObject({ revision: 2,
      digest: correctedFigure.body.figure.digest });

    const postBAfter = (await firestore.doc(`cmsPosts/${ownerIds.postB}`).get()).data();
    expect(postBAfter.published).toEqual(staleRepublish.document.published);
    expect(postBAfter.published.sourceVersion).toBe(staleRepublish.operation.sourceVersion);
    expect(postBAfter.title).toBe("Newer independently republished Post B");
    expect((await firestore.doc(`${postOwnership.OWNER_COLLECTION}/${ownerIds.postB}`).get()).data())
      .toMatchObject({ operationId: staleRepublish.operation.operationId,
        sourceVersion: staleRepublish.operation.sourceVersion,
        snapshotDigest: staleRepublish.operation.snapshotDigest });
    const refreshedUses = await firestore.collection("cmsDatasetUses")
      .where("datasetId", "==", record.id).get();
    expect(refreshedUses.size).toBe(3);
    expect(refreshedUses.docs.every(row => row.data().revision === 2 &&
      row.data().approvedDigest === correctedFigure.body.figure.digest)).toBe(true);
    for (const row of refreshedUses.docs) {
      const use = row.data();
      const collection = use.collection === "cmsPages"
        ? pageOwnership.PAGE_OWNER_COLLECTION : postOwnership.OWNER_COLLECTION;
      const owner = (await firestore.doc(`${collection}/${use.documentId}`).get()).data();
      expect(use.operationId).toBe(owner.operationId);
      expect(use.ownerSnapshotDigest).toBe(owner.snapshotDigest);
    }
    expect((await firestore.doc(
      `cmsDatasets/${record.id}/releases/${releaseId}/revisions/1`).get()).data())
      .toEqual(immutableRevisionOne);
  }, 30_000);

  it("moves only latest-approved owners to a new release and withdraws every use after archive proof", async () => {
    const september = datasetRelease();
    let record = await saveDataset(september);
    record = (await transition(record, "review")).body.dataset;
    const firstApproval = await transition(record, "approve", { expectedUseCount: 0 });
    expect(firstApproval.status, firstApproval.body.error).toBe(200);
    record = firstApproval.body.dataset;
    const septemberReleaseId = record.approvedReleaseId;
    const septemberFigure = await call({ action: "figure", id: record.id,
      version: { mode: "pinned", releaseId: septemberReleaseId } });
    expect(septemberFigure.status, septemberFigure.body.error).toBe(200);
    const septemberProjection = septemberFigure.body.figure;
    const septemberHistory = (await firestore.doc(
      `cmsDatasets/${record.id}/releases/${septemberReleaseId}/revisions/1`).get()).data();
    await seedPublishedOwners(record.id, septemberReleaseId, septemberProjection);

    const pinnedDocumentBefore = (await firestore.doc(`cmsPosts/${ownerIds.postA}`).get()).data();
    const pinnedOwnerBefore = (await firestore.doc(
      `${postOwnership.OWNER_COLLECTION}/${ownerIds.postA}`).get()).data();
    const october = { ...datasetRelease(), value: 4.5,
      period: { start: "2026-10-01", end: "2026-10-15", label: "October 1-15, 2026" },
      points: [
        { period: "2026-08-31", value: null, missingReason: "Not reported" },
        { period: "2026-09-30", value: 4.2 },
        { period: "2026-10-15", value: 4.5 },
      ],
      chartText: "The synthetic rate is 4.5% for October 1-15, 2026. August is not reported.",
      releasedOn: "2026-10-19", verifiedOn: "2026-10-20", changeKind: "new_release",
      changeNote: "" };
    record = await saveDataset(october, record);
    record = (await transition(record, "review")).body.dataset;
    const secondApproval = await transition(record, "approve", { expectedUseCount: 2 });
    expect(secondApproval.status, secondApproval.body.error).toBe(200);
    record = secondApproval.body.dataset;
    const octoberReleaseId = record.approvedReleaseId;
    expect(octoberReleaseId).not.toBe(septemberReleaseId);
    const octoberFigure = await call({ action: "figure", id: record.id,
      version: { mode: "latestApproved" } });
    expect(octoberFigure.status, octoberFigure.body.error).toBe(200);
    expect(octoberFigure.body.figure).toMatchObject({ datasetId: record.id,
      releaseId: octoberReleaseId, revision: 1, release: { value: 4.5,
        period: { start: "2026-10-01", end: "2026-10-15" } } });
    const octoberProjection = octoberFigure.body.figure;
    const octoberHistory = (await firestore.doc(
      `cmsDatasets/${record.id}/releases/${octoberReleaseId}/revisions/1`).get()).data();
    const releaseJobId = record.refreshJobId;
    const releaseJobBefore = (await firestore.doc(`cmsDatasetRefreshJobs/${releaseJobId}`).get()).data();
    expect(releaseJobBefore).toMatchObject({ action: "new_release", releaseId: octoberReleaseId,
      revision: 1, approvedDigest: octoberProjection.digest, expectedUseCount: 2,
      expectedOwnerCount: 2, status: "preparing" });

    await datasetRefresh.processDatasetRefreshJob({ firestore, jobId: releaseJobId, maxOwners: 5 });
    let tasks = await ownerTasks(releaseJobId);
    expect([...tasks.keys()].sort()).toEqual([
      `cmsPages/${ownerIds.page}`, `cmsPosts/${ownerIds.postB}`,
    ]);
    await seedPersistedReceipts(tasks);
    await datasetRefresh.processDatasetRefreshJob({ firestore, jobId: releaseJobId, maxOwners: 5 });
    tasks = await ownerTasks(releaseJobId);
    const completedRelease = (await firestore.doc(`cmsDatasetRefreshJobs/${releaseJobId}`).get()).data();
    expectExactCompletion(releaseJobId, completedRelease, tasks, { action: "new_release",
      datasetId: record.id, releaseId: octoberReleaseId, revision: 1,
      approvedDigest: octoberProjection.digest, expectedUseCount: 2, expectedOwnerCount: 2,
      verifiedOwnerCount: 2 });

    const pinnedDocumentAfter = (await firestore.doc(`cmsPosts/${ownerIds.postA}`).get()).data();
    const pinnedOwnerAfter = (await firestore.doc(
      `${postOwnership.OWNER_COLLECTION}/${ownerIds.postA}`).get()).data();
    expect(pinnedDocumentAfter).toEqual(pinnedDocumentBefore);
    expect(pinnedOwnerAfter).toEqual(pinnedOwnerBefore);
    for (const [collection, id] of [["cmsPosts", ownerIds.postB], ["cmsPages", ownerIds.page]]) {
      const published = (await firestore.doc(`${collection}/${id}`).get()).data().published;
      expect(published.datasetFigures.figures[0]).toMatchObject({ datasetId: record.id,
        releaseId: octoberReleaseId, revision: 1, digest: octoberProjection.digest });
    }
    let uses = await firestore.collection("cmsDatasetUses").where("datasetId", "==", record.id).get();
    expect(uses.size).toBe(3);
    const pinnedUse = uses.docs.find(row => row.data().documentId === ownerIds.postA).data();
    expect(pinnedUse).toMatchObject({ releasePolicy: "pinned", releaseId: septemberReleaseId,
      revision: 1, approvedDigest: septemberProjection.digest, state: "published" });
    expect(uses.docs.filter(row => row.data().releasePolicy === "latestApproved")
      .every(row => row.data().releaseId === octoberReleaseId && row.data().revision === 1 &&
        row.data().approvedDigest === octoberProjection.digest && row.data().state === "published"))
      .toBe(true);

    const beforeArchive = new Map();
    for (const [collection, id] of [["cmsPosts", ownerIds.postA], ["cmsPosts", ownerIds.postB],
      ["cmsPages", ownerIds.page]]) {
      const document = (await firestore.doc(`${collection}/${id}`).get()).data();
      beforeArchive.set(`${collection}/${id}`, workingDocument(document));
    }
    const archived = await transition(record, "archive", { expectedUseCount: 3 });
    expect(archived.status, archived.body.error).toBe(200);
    record = archived.body.dataset;
    expect(record.archived).toBe(true);
    const refusedFigure = await call({ action: "figure", id: record.id,
      version: { mode: "latestApproved" } });
    expect(refusedFigure).toMatchObject({ status: 409,
      body: { error: "This dataset is unavailable or archived." } });
    const archiveJobId = record.refreshJobId;
    const archiveBefore = (await firestore.doc(`cmsDatasetRefreshJobs/${archiveJobId}`).get()).data();
    expect(archiveBefore).toMatchObject({ action: "archive", releaseId: null, revision: null,
      approvedDigest: null, expectedUseCount: 3, expectedOwnerCount: 3, status: "preparing" });

    await datasetRefresh.processDatasetRefreshJob({ firestore, jobId: archiveJobId, maxOwners: 5 });
    let archiveTasks = await ownerTasks(archiveJobId);
    expect(archiveTasks.size).toBe(3);
    uses = await firestore.collection("cmsDatasetUses").where("datasetId", "==", record.id).get();
    expect(uses.size).toBe(3);
    expect(uses.docs.every(row => row.data().state === "withdrawal_pending")).toBe(true);
    for (const [collection, id] of [["cmsPosts", ownerIds.postA], ["cmsPosts", ownerIds.postB],
      ["cmsPages", ownerIds.page]]) {
      const document = (await firestore.doc(`${collection}/${id}`).get()).data();
      expect(workingDocument(document)).toEqual(beforeArchive.get(`${collection}/${id}`));
      expect(document.published.datasetFigures).toEqual({ figures: [{
        blockId: document.published.blocks[0].id, datasetId: record.id, withdrawn: true,
      }], releases: [] });
    }
    expect((await firestore.doc(`cmsDatasetRefreshJobs/${archiveJobId}`).get()).data().status)
      .toBe("pending");

    await seedPersistedReceipts(archiveTasks);
    await datasetRefresh.processDatasetRefreshJob({ firestore, jobId: archiveJobId, maxOwners: 5 });
    archiveTasks = await ownerTasks(archiveJobId);
    const completedArchive = (await firestore.doc(`cmsDatasetRefreshJobs/${archiveJobId}`).get()).data();
    expectExactCompletion(archiveJobId, completedArchive, archiveTasks, { action: "archive",
      datasetId: record.id, releaseId: null, revision: null, approvedDigest: null,
      expectedUseCount: 3, expectedOwnerCount: 3, verifiedOwnerCount: 3 });
    uses = await firestore.collection("cmsDatasetUses").where("datasetId", "==", record.id).get();
    expect(uses.size).toBe(0);
    expect((await firestore.doc(`cmsDatasets/${record.id}`).get()).data()).toMatchObject({
      archived: true, publishedUseCount: 0 });
    expect((await firestore.doc(
      `cmsDatasets/${record.id}/releases/${septemberReleaseId}/revisions/1`).get()).data())
      .toEqual(septemberHistory);
    expect((await firestore.doc(
      `cmsDatasets/${record.id}/releases/${octoberReleaseId}/revisions/1`).get()).data())
      .toEqual(octoberHistory);
  }, 30_000);
});
