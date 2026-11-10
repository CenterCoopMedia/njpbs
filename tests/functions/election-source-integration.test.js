import { readFileSync } from "node:fs";
import { apV3Fixture } from "../fixtures/election-sources/ap-v3.js";
import sources from "../../functions/election-results-sources.js";
import poller from "../../functions/lib/election-source-poller.js";
import refresh from "../../functions/lib/election-source-refresh.js";
import provider from "../../functions/lib/election-source-http.js";
import rehearsal from "../../functions/lib/election-source-rehearsal.js";
import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import firebase from "../../functions/lib/firebase.js";
import save from "../../functions/save.js";
import scheduledPublish from "../../functions/scheduled-publish.js";
import lifecycle from "../../functions/lifecycle-transition.js";
import deployment from "../../functions/lib/public-deployment.js";
import context from "../../functions/lib/public-context-revision.js";
import postOwnership from "../../functions/lib/no-build-post-ownership.js";
import pageOwnership from "../../functions/lib/no-build-page-ownership.js";
import datasetsEndpoint from "../../functions/datasets.js";
import datasetRefresh from "../../functions/lib/dataset-refresh.js";
import electionLineage from "../../functions/lib/election-source-lineage.js";
import datasetDependencies from "../../functions/lib/dataset-dependencies.js";
import datasetIdentity from "../../functions/lib/dataset-refresh-identity.js";
import { datasetRelease } from "../fixtures/dataset-release.js";
import snapshots from "../../functions/lib/publish-snapshot.js";
import { electionBlock, electionRace } from "../fixtures/election-results.ts";
import { seedSwitch, capabilities } from "../helpers/public-release-switch.js";
import pairProtocol from "../../functions/lib/public-release-pair.js";
import pairAdmission from "../../functions/lib/public-release-admission.js";
import mediaContract from "../../functions/lib/media-contract.js";
import mediaUsage from "../../functions/lib/media-usage.js";
import publicationOwners from "../../functions/lib/no-build-content-publication.js";

const { db, admin } = firebase;
const project = process.env.GCLOUD_PROJECT ?? "demo-njpbs";
const sha = "a".repeat(40);
let publicationProject = "njpbs-site-dev";
let endpointNow = "2026-11-04T03:00:00.000Z";
const firestore = new Proxy(db, { get(target, key) {
  if (key === "projectId") return publicationProject;
  const value = Reflect.get(target, key);
  return typeof value === "function" ? value.bind(target) : value;
} });
const productionFirestore = new Proxy(firestore, { get(target, key) {
  if (key === "projectId") return "njpbs-site";
  const value = Reflect.get(target, key);
  return typeof value === "function" ? value.bind(target) : value;
} });
const saveLog = { warn: vi.fn(), error: vi.fn() };
let server;
let origin;
let actors;

async function signIn() {
  const uid = `results-${randomUUID()}`;
  const email = `${uid}@example.test`;
  await admin.auth().createUser({ uid, email, emailVerified: true });
  const response = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=synthetic`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: await admin.auth().createCustomToken(uid), returnSecureToken: true }),
  });
  if (!response.ok) throw new Error("Synthetic emulator sign-in failed");
  return { uid, email, token: (await response.json()).idToken };
}
async function call(path, body, actor = actors.editor) {
  const response = await fetch(`${origin}/${path}`, { method: "POST", headers: {
    "Content-Type": "application/json", Authorization: `Bearer ${actor.token}`,
  }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
function document(collection) {
  const common = { id: collection === "cmsPages" ? "contact" : "election-results-story", title: "Synthetic results",
    status: "draft", version: 1, contentVersion: 1, createdBy: actors.writer.uid, blocks: [electionBlock()] };
  return collection === "cmsPages" ? { ...common, template: "genericPage" }
    : { ...common, type: "post", section: "news", tags: [], categories: [], credits: [], date: "2026-11-03",
      slug: "election-results-story", previousSlugs: [], locale: "en-US" };
}
async function transition(collection, current, action, actor = actors.editor) {
  return call("transition", { collection, id: current.id, baseVersion: current.version, action }, actor);
}
async function approve(collection, current) {
  const submitted = await transition(collection, current, "submit");
  expect(submitted.status, submitted.body.error).toBe(200);
  const approved = await transition(collection, submitted.body.document, "approve");
  expect(approved.status, approved.body.error).toBe(200);
  return approved.body.document;
}
async function seedSystem() {
  const batch = db.batch();
  batch.set(db.doc("system/publicDeployment"), { ...deployment.initialPublicDeploymentPointer(), activeGeneration: 1,
    activeDeploymentId: "11111111-1111-4111-8111-111111111111", activeCommitSha: sha,
    lastReservedGeneration: 1, newestEligibleGeneration: 1, newestEligibleBuildBatchId: "baseline", mediaLifecycleReady: true });
  batch.set(db.doc(context.PUBLIC_CONTEXT_PATH), { schemaVersion: 1, revision: 1, withdrawalRevision: 0, homeRevision: 0 });
  batch.set(db.doc("system/noBuildPostAdmission"), { schemaVersion: 2, revision: 1, enabled: true,
    families: { posts: { mode: "all" }, pages: { mode: "ids", ids: ["contact"] } }, backgroundBucket: "njpbs-dev-public-artifacts" });
  batch.set(db.doc("system/cmsPublicationRuntime"), { schemaVersion: 1, phase: "paused", commitSha: sha,
    serializerId: "node-compute-publisher", cloud: { phase: "ready", commitSha: sha, serializerId: "cloudflare-dev-publisher" } });
  batch.set(db.doc(postOwnership.CAPABILITY_PATH), { schemaVersion: 2, rendererSha: sha, servingEnabled: true,
    generation: 1, dataFigureVersion: 1, electionResultsVersion: 1 });
  batch.set(db.doc(pageOwnership.PAGE_CAPABILITY_PATH), { schemaVersion: 1, rendererSha: sha, servingEnabled: true,
    generation: 1, dataFigureVersion: 1, electionResultsVersion: 1,
    terminalOwner: { schemaVersion: 1, transport: "page-no-build-v1", rendererSha: sha } });
  await batch.commit();
}
beforeAll(async () => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") ||
      !/^127\.0\.0\.1:\d+$/.test(process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "") || !/^demo-njpbs(?:-[a-z0-9-]+)?$/.test(project)) {
    throw new Error("Use local demo Auth and Firestore emulators");
  }
  actors = { editor: await signIn(), writer: await signIn() };
  const now = () => endpointNow;
  const handlers = { datasets: datasetsEndpoint.createDatasetsHandler({ firestore }), sources: sources.createElectionSourcesHandler({ firestore, now, fetchImpl: providerFetch }), save: save.createCmsSaveHandler({ firestore, enablePublishSnapshot: true, now, log: saveLog }),
    transition: lifecycle.createCmsTransitionContentHandler({ firestore, now, log: { warn() {}, error() {} } }) };
  handlers.productionSources = sources.createElectionSourcesHandler({ firestore: productionFirestore, now, fetchImpl: providerFetch });
  const otherProject = new Proxy(firestore, { get(target, key) {
    if (key === "projectId") return "njpbs-site-dev";
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  handlers.otherProjectSources = sources.createElectionSourcesHandler({ firestore: otherProject, now, fetchImpl: providerFetch });
  server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    request.body = JSON.parse(Buffer.concat(chunks).toString());
    response.set = (name, value) => { response.setHeader(name, value); return response; };
    response.status = code => { response.statusCode = code; return response; };
    response.json = body => { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(body)); return response; };
    await handlers[request.url.slice(1)](request, response);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
}, 20_000);
beforeEach(async () => {
  endpointNow = "2026-11-04T03:00:00.000Z";
  publicationProject = "njpbs-site-dev";
  saveLog.error.mockClear();
  saveLog.warn.mockClear();
  vi.stubEnv("CMS_DEPLOYMENT_ENVIRONMENT", "development");
  vi.stubEnv("FUNCTIONS_EMULATOR", "true");
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${project}/databases/(default)/documents`, { method: "DELETE" });
  await db.doc(`users/${actors.editor.uid}`).set({ role: "admin", active: true, email: actors.editor.email, displayName: "Results editor" });
  await db.doc(`users/${actors.writer.uid}`).set({ grants: [{ role: "contributor" }], active: true, email: actors.writer.email, displayName: "Results writer" });
  await seedSystem();
  sourceData = repoFixture();
  providerCalls = [];
  providerFailure = null;
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  for (const actor of Object.values(actors ?? {})) await admin.auth().deleteUser(actor.uid);
});


const fixture = name => JSON.parse(readFileSync(new URL(`../fixtures/election-sources/${name}.json`, import.meta.url), "utf8"));
const roster = fixture("roster");
let sourceData;
let providerCalls = [];
let providerFailure = null;
const now = () => "2026-11-04T03:00:00.000Z";
function repoFixture() {
  const value = fixture("repo-live");
  value.generatedAt = "2026-11-04T02:59:00Z";
  for (const race of value.races) race.asOf = "2026-11-04T02:59:00Z";
  return value;
}
async function providerFetch(url, options) {
  providerCalls.push({ url: String(url), options });
  if (String(url) === provider.ROSTER_URL) return Response.json(roster);
  if (providerFailure && (String(url) === provider.RESULTS_URL || String(url).startsWith("https://api.ap.org/"))) return new Response("provider body must not leak", { status: providerFailure });
  if (String(url) === provider.RESULTS_URL) return Response.json(sourceData, { headers: { ETag: '"synthetic-results-v1"' } });
  if (String(url) === rehearsal.RESULTS_URL) return Response.json(sourceData, { headers: { ETag: '"rehearsal-results-v1"' } });
  if (String(url).startsWith("http://metadata.google.internal/")) return Response.json({ access_token: "synthetic-emulator-oauth" });
  if (String(url).startsWith("https://secretmanager.googleapis.com/")) return Response.json({ payload: { data: Buffer.from("synthetic-emulator-ap-key").toString("base64") } });
  if (String(url).startsWith("https://api.ap.org/")) return Response.json(sourceData);
  throw new Error("Unexpected HTTP boundary");
}
const address = collection => ({ collection, documentId: collection === "cmsPages" ? "contact" : "election-results-story", blockId: "results-block" });
const config = (mode = "automatic", source = { kind: "repo" }) => ({ source, mode,
  raceIds: ["us-senate", "us-house-01"], maxAgeSeconds: 300 });
async function publishedRecord(collection = "cmsPages", extraBlocks = []) {
  let current = document(collection);
  current.blocks.push(...extraBlocks);
  await db.doc(`${collection}/${current.id}`).set(current);
  current = await approve(collection, current);
  const response = await call("save", { collection, id: current.id, baseVersion: current.version, publish: true, document: {} });
  expect(response.status, response.body.error).toBe(200);
  return response.body.document;
}
async function connect(collection = "cmsPages", mode = "automatic", source = { kind: "repo" }, extraBlocks = []) {
  const current = await publishedRecord(collection, extraBlocks);
  const connected = await call("sources", { action: "connect", ...address(collection), baseVersion: 0,
    contentVersion: current.version, config: config(mode, source) });
  expect(connected.status, connected.body.error).toBe(200);
  return { document: current, connection: connected.body.connection,
    id: refresh.connectionId(collection, current.id, "results-block") };
}
async function poll(id, extra = {}) { return poller.pollConnection({ firestore, id, now, fetchImpl: providerFetch, ...extra }); }
async function connection(id) { return (await db.doc(`cmsElectionResultConnections/${id}`).get()).data(); }
async function makeDue(id) { await db.doc(`cmsElectionResultConnections/${id}`).update({ nextPollAt: 0 }); }
const apMapping = Object.fromEntries(roster.races.slice(0, 2).map((race, i) => [String(100 + i), {
  raceId: race.id, candidateIds: Object.fromEntries(race.candidateIds.map((cid, j) => [String(i * 10 + j), cid])),
}]));
function apFixture() {
  return { electionDate: "2026-11-03", races: repoFixture().races.slice(0, 2).map((race, i) => ({
    raceID: String(100 + i), resultsType: "live", raceTypeID: "G", officeID: i ? "H" : "S",
    reportingUnits: [{ statePostal: "NJ", reportingunitLevel: "1", lastUpdated: race.asOf,
      precinctsReportingPct: 50, precinctsReporting: 100, candidates: race.candidates.map((candidate, j) => ({
        candidateID: String(i * 10 + j), voteCount: candidate.votes,
      })) }],
  })), nextrequest: "https://api.ap.org/v3/elections/2026-11-03?statePostal=NJ&raceID=100,101&minDateTime=2026-11-04T02:59:00Z" };
}

async function datasetSave(release, record) {
  const result = await call("datasets", { action: "save", title: "Synthetic election-context measure", release, requestId: randomUUID(),
    ...(record ? { id: record.id, baseVersion: record.version } : {}) });
  expect(result.status, result.body.error).toBe(200); return result.body.dataset;
}
async function datasetApprove(record, expectedUseCount) {
  const reviewed = await call("datasets", { action: "review", id: record.id, baseVersion: record.version, requestId: randomUUID() });
  expect(reviewed.status, reviewed.body.error).toBe(200);
  const approved = await call("datasets", { action: "approve", id: record.id, baseVersion: reviewed.body.dataset.version, expectedUseCount, requestId: randomUUID() });
  expect(approved.status, approved.body.error).toBe(200); return approved.body.dataset;
}
async function correction(record, value = 4.3) {
  return datasetApprove(await datasetSave({ ...datasetRelease(), value, changeKind: "correction", changeNote: "Synthetic corrected observation." }, record), 1);
}
async function withDataset(collection) {
  const dataset = await datasetApprove(await datasetSave(datasetRelease()), 0);
  const block = { id: "context-measure", type: "data_figure", order: 1, visible: true,
    data: { datasetId: dataset.id, version: { mode: "latestApproved" }, display: "expanded" } };
  return { dataset, ...await connect(collection, "automatic", { kind: "repo" }, [block]) };
}
async function adoptPair(electionResultsVersion = 1) {
  const features = ["dataFigureVersion:1", "electionResultsVersion:1", ...(electionResultsVersion === 2 ? ["electionResultsVersion:2"] : [])];
  const contract = { schemaVersion: 2, families: ["posts", "pages"], features };
  const featureCapabilities = commit => {
    const value = capabilities(commit);
    for (const family of ["posts", "pages"]) Object.assign(value[family], { dataFigureVersion: 1, electionResultsVersion });
    return value;
  };
  const seeded = await seedSwitch(firestore, { admittedContract: contract,
    oldCapabilities: featureCapabilities(sha), nextCapabilities: featureCapabilities("b".repeat(40)) });
  await db.doc(`${pairAdmission.CONTRACTS}/${pairProtocol.publicReleaseDigest(contract)}`).set(contract);
  await db.doc(`${pairAdmission.ADMISSIONS}/controls/adoption`).set({ schemaVersion: 2, enabled: true });
  await db.doc("system/noBuildPostAdmission").set({ schemaVersion: 2, revision: 1, enabled: true,
    families: { posts: { mode: "all" }, pages: { mode: "all" } }, backgroundBucket: "njpbs-dev-public-artifacts" });
  return seeded;
}
async function refreshTask(record) {
  const tasks = await db.collection(`cmsDatasetRefreshJobs/${record.refreshJobId}/owners`).get();
  expect(tasks.size).toBe(1); return tasks.docs[0].data();
}

// Source HTTP and the Sheets API are the only mocked boundaries. Auth, content
// handlers, authorization, transactions, publication owners and audit are real.
describe("Election source Auth/HTTP/Firestore and publication boundaries", () => {
  it.each(["cmsPages", "cmsPosts"])("refreshes actual pair %s election and dataset dependencies without changing saved editorial versions", async collection => {
    const art = { source: "upload", lifecycle: "active", mimeType: "image/png", width: 800, height: 300,
      url: "https://media.njpbs.org/cms-media/fixture/election.png", altText: "Election illustration" };
    await db.doc("media_assets/election-art").set(art);
    await db.doc("media_assets_public/election-art").set(mediaContract.mediaProjection(art));
    const figure = await datasetApprove(await datasetSave(datasetRelease()), 0);
    const current = await connect(collection, "automatic", { kind: "repo" }, [
      { id: "context-measure", type: "data_figure", order: 1, visible: true,
        data: { datasetId: figure.id, version: { mode: "latestApproved" }, display: "expanded" } },
      { id: "election-art", type: "image", order: 2, visible: true,
        data: { assetId: "election-art", alt: "Election illustration", decorative: false } },
    ]);
    const revised = await transition(collection, current.document, "revise");
    expect(revised.status, revised.body.error).toBe(200);
    const saved = await call("save", { collection, id: current.document.id, baseVersion: revised.body.document.version,
      document: { title: "Private unpublished headline" } });
    expect(saved.status, saved.body.error).toBe(200);
    await adoptPair();
    const ref = db.doc(`${collection}/${current.document.id}`), before = (await ref.get()).data();
    const cursor = (await db.doc("system/publicReleaseChanges").get()).data();
    for (const options of [
      { dependencyRefresh: true, nextDocument: { ...before, title: "Attempted draft change" } },
      { electionResultsRefresh: { blockId: "results-block" }, nextDocument: { ...before,
        published: { ...before.published, metadata: { ...before.published.metadata, title: "Attempted public headline change" } } } },
      { nextDocument: before },
    ]) await expect(db.runTransaction(transaction => publicationOwners.prepareNoBuildContentPublication({ firestore, transaction,
      collection, documentId: current.document.id, queueRef: db.collection("cmsPublishQueue").doc(),
      actor: { uid: "system:refresh-proof" }, ...options }))).rejects.toThrow();
    expect((await db.doc("system/publicReleaseChanges").get()).data()).toEqual(cursor);
    expect((await ref.get()).data()).toEqual(before);
    // Legacy media admission still refuses a schema-two root without the
    // actual selector returned by the explicit pair source owner.
    await expect(db.runTransaction(transaction => mediaUsage.prepareMediaUsageWrite({ firestore, transaction,
      collection, documentId: current.document.id, state: "published", sourceVersion: before.published.sourceVersion,
      usage: mediaUsage.collectPublishedMediaUsage({ collection, snapshot: before.published }) }))).rejects.toThrow();
    const outcome = await poll(current.id);
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ published: true });
    const afterElection = (await ref.get()).data();
    expect(afterElection.version).toBe(before.version);
    expect(afterElection.title).toBe(before.title);
    expect(afterElection.published.sourceVersion).toBe(before.published.sourceVersion);
    expect((await db.doc(`cmsPublishQueue/${afterElection.publishBuildQueueId}`).get()).data().transport).toBe(pairAdmission.TRANSPORT);
    const corrected = await correction(figure);
    await datasetRefresh.processDatasetRefreshJob({ firestore, jobId: corrected.refreshJobId });
    const afterDataset = (await ref.get()).data();
    expect(afterDataset.version).toBe(before.version);
    expect(afterDataset.title).toBe(before.title);
    expect(afterDataset.published.sourceVersion).toBe(before.published.sourceVersion);
    expect(afterDataset.published.datasetFigures).not.toEqual(afterElection.published.datasetFigures);
    expect((await db.doc(`cmsPublishQueue/${afterDataset.publishBuildQueueId}`).get()).data().transport).toBe(pairAdmission.TRANSPORT);
  });
  it.each(["cmsPages", "cmsPosts"])("updates the published %s only, deduplicates, and audits exact source digest", async collection => {
    const current = await connect(collection);
    const revised = await transition(collection, current.document, "revise");
    expect(revised.status, revised.body.error).toBe(200);
    const saved = await call("save", { collection, id: current.document.id, baseVersion: revised.body.document.version,
      document: { title: "Private unpublished headline" } });
    expect(saved.status, saved.body.error).toBe(200);
    const before = (await db.doc(`${collection}/${current.document.id}`).get()).data();
    const outcome = await poll(current.id);
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ published: true });
    const after = (await db.doc(`${collection}/${current.document.id}`).get()).data();
    expect(after.title).toBe("Private unpublished headline");
    expect(after.blocks).toEqual(before.blocks);
    expect(after.version).toBe(before.version);
    expect(after.published.metadata.title).toBe(before.published.metadata.title);
    expect(after.published.sourceVersion).toBe(before.published.sourceVersion);
    expect(after.published.blocks[0].data.races[0].id).toBe("us-senate");
    expect(after.published.blocks[0].data.races[0].candidates[0].votes).toBe(25);
    expect(after.published).not.toHaveProperty("electionResultsApprovals");
    const row = await connection(current.id);
    const queue = (await db.doc(`cmsPublishQueue/${row.operationId}`).get()).data();
    expect(queue.transport).toBe(collection === "cmsPages" ? "page-no-build-v1" : "post-no-build-v1");
    expect((await db.collection(`cmsElectionResultConnections/${current.id}/publications`).get()).size).toBe(1);
    await makeDue(current.id);
    expect(await poll(current.id)).toMatchObject({ unchanged: true });
    expect((await db.collection(`cmsElectionResultConnections/${current.id}/publications`).get()).size).toBe(1);
    expect((await connection(current.id)).lastGoodDigest).toBe(row.lastGoodDigest);
  });
  it("keeps the last good snapshot and raises a private alert on a bad, missing, stale or unavailable source", async () => {
    const current = await connect();
    await poll(current.id);
    const before = (await db.doc("cmsPages/contact").get()).data().published;
    for (const cause of ["negative", "missing", "stale", "http"]) {
      sourceData = repoFixture(); providerFailure = null;
      if (cause === "negative") sourceData.races[0].candidates[0].votes = -1;
      if (cause === "missing") sourceData.races.shift();
      if (cause === "stale") sourceData.races[0].asOf = "2026-11-04T02:00:00Z";
      if (cause === "http") providerFailure = 503;
      await makeDue(current.id);
      expect(await poll(current.id)).toMatchObject({ held: true });
      expect((await db.doc("cmsPages/contact").get()).data().published).toEqual(before);
      expect((await connection(current.id)).lastHoldReason).not.toBeNull();
      expect(JSON.stringify((await connection(current.id)).lastHoldReason)).not.toContain("provider body");
    }
    providerFailure = null; sourceData = repoFixture(); await makeDue(current.id);
    expect(await poll(current.id)).toMatchObject({ unchanged: true });
    expect((await connection(current.id)).lastHoldReason).toBeNull();
  });
  it("approves the link once for its configuration, then publishes without another per-race approval", async () => {
    const current = await connect("cmsPages", "approve-once");
    const before = (await db.doc("cmsPages/contact").get()).data().published;
    expect(await poll(current.id)).toMatchObject({ pendingApproval: true });
    expect((await db.doc("cmsPages/contact").get()).data().published).toEqual(before);
    const response = await call("sources", { action: "approve", ...address("cmsPages"), baseVersion: 1 });
    expect(response.status, response.body.error).toBe(200);
    expect(await poll(current.id)).toMatchObject({ published: true });
    sourceData.races[0].candidates[0].votes = 26;
    sourceData.races[0].candidates[0].share = 25;
    await makeDue(current.id);
    expect(await poll(current.id)).toMatchObject({ published: true });
  });
  it("publishes counts automatically, holds the call tuple for one click and resumes counts with that authorization", async () => {
    const current = await connect("cmsPages", "counts-auto");
    await poll(current.id);
    Object.assign(sourceData.races[0], { status: "called", sourceKind: "ap", sourceLabel: "The Associated Press",
      calledCandidateId: roster.candidates[0].id, apCallUrl: "https://apnews.com/hub/election-2026" });
    sourceData.races[0].candidates[0].votes = 26;
    await makeDue(current.id); await poll(current.id);
    let row = await connection(current.id);
    expect(row.pendingStatuses).toEqual(["us-senate"]);
    expect(row.lastGoodData.races[0]).toMatchObject({ status: "counting", candidates: [{ votes: 26 }, {}, {}, {}] });
    const response = await call("sources", { action: "status", ...address("cmsPages"), baseVersion: row.version, pendingDigest: row.pendingDigest });
    expect(response.status, response.body.error).toBe(200);
    await poll(current.id); row = await connection(current.id);
    expect(row.lastGoodData.races[0].status).toBe("called");
    expect(row.pendingStatuses).toEqual([]);
  });
  it("denies writer mutations and forged server state, and rechecks publisher deactivation", async () => {
    const current = await connect();
    const denied = await call("sources", { action: "pause", ...address("cmsPages"), baseVersion: 1 }, actors.writer);
    expect(denied.status).toBe(403);
    const forged = await call("sources", { action: "pause", ...address("cmsPages"), baseVersion: 1, lastGoodDigest: "forged" });
    expect(forged.status).toBe(400);
    providerCalls = [];
    await db.doc(`users/${actors.editor.uid}`).update({ active: false });
    expect(await poll(current.id)).toMatchObject({ held: true });
    expect((await connection(current.id)).lastGoodDigest).toBeNull();
    expect((await connection(current.id)).paused).toBe(true);
    expect(providerCalls).toEqual([]);
    expect(await poll(current.id)).toMatchObject({ skipped: true });
  });
  it("denies an editor whose publish grant belongs to another section", async () => {
    const current = await connect("cmsPosts");
    await db.doc("sections/arts").set({ name: "Arts", active: true });
    await db.doc(`users/${actors.writer.uid}`).update({ grants: [{ role: "editor", sections: ["arts"] }] });
    const response = await call("sources", { action: "pause", ...address("cmsPosts"), baseVersion: 1 }, actors.writer);
    expect(response.status).toBe(403);
    expect((await connection(current.id)).paused).toBe(false);
  });
  it("returns the current saved version and public binding for review without exposing private edits", async () => {
    const current = await connect(); await poll(current.id);
    const revised = await transition("cmsPages", (await db.doc("cmsPages/contact").get()).data(), "revise");
    const saved = await call("save", { collection: "cmsPages", id: "contact", baseVersion: revised.body.document.version,
      document: { title: "Private title", blocks: [electionBlock(electionRace({ office: "Private unapproved office" }))] } });
    expect(saved.status, saved.body.error).toBe(200);
    const read = await call("sources", { action: "get", ...address("cmsPages") });
    expect(read.status, read.body.error).toBe(200);
    expect(read.body.documentVersion).toBe(saved.body.document.version);
    expect(read.body.publicData.races[0]).toMatchObject({ id: "us-senate", office: "U.S. Senate" });
    expect(JSON.stringify(read.body)).not.toContain("Private unapproved office");
    expect(JSON.stringify(read.body)).not.toContain("Private title");
  });
  it("pauses future polls and discards a response fetched before a concurrent pause", async () => {
    const current = await connect();
    let release; let fetched;
    const waiting = new Promise(resolve => { fetched = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const fetchImpl = async (url, options) => {
      if (String(url) === provider.RESULTS_URL) { fetched(); await gate; }
      return providerFetch(url, options);
    };
    const work = poller.pollConnection({ firestore, id: current.id, now, fetchImpl });
    await waiting;
    const paused = await call("sources", { action: "pause", ...address("cmsPages"), baseVersion: 1 });
    expect(paused.status, paused.body.error).toBe(200);
    release(); expect(await work).toMatchObject({ discarded: true });
    expect(await poll(current.id)).toMatchObject({ skipped: true });
    expect((await connection(current.id)).lastGoodDigest).toBeNull();
  });
  it("accepts unchanged values after a mode-only reconnect without reserving a duplicate publication", async () => {
    const current = await connect(); await poll(current.id);
    const before = (await db.doc("cmsPages/contact").get()).data();
    const changed = await call("sources", { action: "connect", ...address("cmsPages"), baseVersion: 1,
      contentVersion: before.version, config: config("counts-auto") });
    expect(changed.status, changed.body.error).toBe(200);
    expect((await connection(current.id)).lastGoodData).toBeNull();
    expect(await poll(current.id)).toMatchObject({ unchanged: true });
    expect((await connection(current.id)).lastGoodData.races[0].candidates[0].votes).toBe(25);
    expect((await db.doc("cmsPages/contact").get()).data().publishBuildQueueId).toBe(before.publishBuildQueueId);
    expect((await db.collection(`cmsElectionResultConnections/${current.id}/publications`).get()).size).toBe(1);
  });
  it("runs Sheet rows through the same real publication path, and holds percent-format metadata", async () => {
    const current = await connect("cmsPages", "automatic", { kind: "sheet", spreadsheetId: "synthetic-sheet-id", tab: "Results", columns: {} });
    const columns = ["race_id", "candidate_id", "votes", "share", "status", "as_of", "reporting_share", "source_kind", "source_label", "source_url", "called_candidate_id", "ap_call_url"];
    const rows = [columns, ...sourceData.races.flatMap(race => race.candidates.map(candidate => [race.id, candidate.id,
      candidate.votes ?? "", candidate.share ?? "", race.status, race.asOf, race.reportingShare ?? "", race.sourceKind, race.sourceLabel, race.sourceUrl, "", ""]))];
    const grid = { sheets: [{ data: [{ rowData: rows.map(row => ({ values: row.map(value => ({ effectiveValue: typeof value === "number" ? { numberValue: value } : { stringValue: value }, effectiveFormat: { numberFormat: { type: "NUMBER" } } })) })) }] }] };
    const sheetsApi = async () => grid;
    expect(await poll(current.id, { sheetsApi })).toMatchObject({ published: true });
    grid.sheets[0].data[0].rowData[1].values[3].effectiveValue = { numberValue: 0.25 };
    grid.sheets[0].data[0].rowData[1].values[3].effectiveFormat.numberFormat.type = "PERCENT";
    await makeDue(current.id);
    expect(await poll(current.id, { sheetsApi })).toMatchObject({ held: true, code: "sheet-format" });
  });
  it.each(["timeout", "http-5xx"])("retains a safe %s fetch cause through scheduled recovery without changing public values", async code => {
    const current = await connect("cmsPages", "approve-once");
    const ref = db.doc(`cmsPages/${current.document.id}`);
    const before = (await ref.get()).data().published;
    const fetchImpl = async (url, options) => {
      if (String(url) !== provider.RESULTS_URL) return providerFetch(url, options);
      if (code === "timeout") throw new DOMException("synthetic-private-fetch-detail", "TimeoutError");
      return new Response("synthetic-private-provider-detail", { status: 503 });
    };
    expect(await poll(current.id, { fetchImpl })).toMatchObject({ held: true, code: "source-unavailable" });
    const failure = { code, at: now(), ...(code === "http-5xx" ? { httpStatus: 503 } : {}) };
    const failed = await connection(current.id);
    expect(failed.lastFetchFailure).toEqual(failure);
    expect(failed.lastHoldReason).toEqual({ code: "source-unavailable",
      message: code === "timeout" ? "The source could not be read. The previous public values are retained."
        : "The source is unavailable. The previous public values are retained.", at: now() });
    expect(failed.paused).toBe(false);
    expect(failed.lease).toBeNull();
    expect(failed.nextPollAt).toBe(Date.parse(now()) + 45000);
    const audit = await db.collection("admin_logs").where("action", "==", "election_source.hold").get();
    expect(audit.size).toBe(1);
    expect(audit.docs[0].data().after.fetchFailure).toEqual(failure);
    expect(JSON.stringify([failed, audit.docs[0].data()])).not.toContain("synthetic-private-");
    // The next ordinary due poll succeeds at HTTP but returns to the expected stale hold.
    expect(await poll(current.id, { now: () => "2026-11-04T03:06:00.000Z" })).toMatchObject({ held: true, code: "stale" });
    const recovered = await connection(current.id);
    expect(recovered.lastFetchFailure).toEqual(failure);
    expect(recovered.lastHoldReason.code).toBe("stale");
    expect(recovered.paused).toBe(false);
    expect(recovered.lastGoodData).toEqual(failed.lastGoodData);
    expect((await ref.get()).data().published).toEqual(before);
    expect((await db.collection(`cmsElectionResultConnections/${current.id}/publications`).get()).size).toBe(0);
  });
  it("publishes capture-shaped live-b awaiting results and follows exact microsecond cursors through quiet deltas", async () => {
    const current = await connect("cmsPages", "automatic", { kind: "ap", mapping: apMapping });
    await db.doc(poller.CONTROL).set({ schemaVersion: 1, ap: { enabled: true, requestsPerMinute: 2 } });
    sourceData = apV3Fixture();
    const cursor = sourceData.nextrequest;
    expect(await poll(current.id)).toMatchObject({ published: true });
    const stored = await connection(current.id);
    expect(stored.sourceCache.data.races[0]).toMatchObject({ status: "awaiting", asOf: "2026-11-04T02:59:00.243Z" });
    expect(stored.lastGoodData.races[0].candidates.every(candidate => candidate.votes === null && candidate.share === null)).toBe(true);
    expect(stored.apCursor).toBe(cursor);
    expect((await db.doc("cmsPages/contact").get()).data().published.blocks[0].data).toEqual(stored.lastGoodData);
    await makeDue(current.id);
    sourceData = { nextrequest: cursor.replace("023512Z", "123456Z") };
    expect(await poll(current.id, { now: () => "2026-11-04T03:00:06Z" })).toMatchObject({ unchanged: true });
    expect(providerCalls.filter(call => call.url.startsWith("https://api.ap.org/")).at(-1).url).toBe(cursor);
    expect((await connection(current.id)).apCursor).toBe(sourceData.nextrequest);
  });
  it("automatically recovers from AP 403 quota exhaustion using the next scheduled budgeted poll", async () => {
    const current = await connect("cmsPages", "automatic", { kind: "ap", mapping: apMapping });
    await db.doc(poller.CONTROL).set({ schemaVersion: 1, ap: { enabled: true, requestsPerMinute: 2 } });
    sourceData = apV3Fixture("called"); providerFailure = 403;
    expect(await poll(current.id)).toMatchObject({ held: true, code: "source-access" });
    const failed = await connection(current.id);
    expect(failed.lastFetchFailure).toMatchObject({ code: "quota", httpStatus: 403 });
    expect(failed.paused).toBe(false);
    providerFailure = null;
    expect(await poll(current.id, { now: () => "2026-11-04T03:01:00Z" })).toMatchObject({ published: true });
    expect((await connection(current.id)).lastGoodData.races[0]).toMatchObject({ status: "called", calledCandidateId: apMapping["100"].candidateIds["0"] });
  });
  it("keeps repo polling usable when AP is disabled or its optional secret is missing", async () => {
    const repo = await connect("cmsPages");
    const ap = await connect("cmsPosts", "automatic", { kind: "ap", mapping: apMapping });
    await poller.pollConnections({ firestore, now, fetchImpl: providerFetch });
    expect((await connection(repo.id)).lastGoodDigest).not.toBeNull();
    expect((await connection(ap.id)).lastHoldReason.code).toBe("ap-disabled");
    expect(providerCalls.some(call => call.url.startsWith("https://secretmanager.googleapis.com/"))).toBe(false);
    await db.doc(poller.CONTROL).set({ schemaVersion: 1, ap: { enabled: true, requestsPerMinute: 2 } });
    await makeDue(ap.id);
    const fetchImpl = (url, options) => String(url).startsWith("https://secretmanager.googleapis.com/")
      ? Promise.resolve(new Response("secret missing", { status: 404 })) : providerFetch(url, options);
    expect(await poller.pollConnection({ firestore, id: ap.id, now, fetchImpl })).toMatchObject({ held: true, code: "ap-disabled" });
    expect((await connection(ap.id)).lastSourceSuccessAt).toBeNull();
    expect((await connection(repo.id)).lastGoodDigest).not.toBeNull();
  });
  it.each(["cmsPages", "cmsPosts"])("emits expected vote only after the installed %s reader supports it", async collection => {
    const current = await connect(collection, "automatic", { kind: "ap", mapping: apMapping });
    await db.doc(poller.CONTROL).set({ schemaVersion: 1, ap: { enabled: true, requestsPerMinute: 2 } });
    sourceData = apFixture(); sourceData.races[0].eevp = 85;
    expect(await poll(current.id)).toMatchObject({ published: true });
    const content = () => db.doc(`${collection}/${address(collection).documentId}`);
    let race = (await content().get()).data().published.blocks[0].data.races[0];
    expect(race.reportingShare).toBe(50); expect(race).not.toHaveProperty("expectedVoteShare");
    const path = collection === "cmsPages" ? pageOwnership.PAGE_CAPABILITY_PATH : postOwnership.CAPABILITY_PATH;
    await db.doc(path).update({ electionResultsVersion: 2 });
    await makeDue(current.id); await db.doc("system/electionResultApBudget").delete();
    expect(await poll(current.id)).toMatchObject({ published: true });
    race = (await content().get()).data().published.blocks[0].data.races[0];
    expect(race.expectedVoteShare).toBe(0.85); expect(race.reportingShare).toBeNull();
    expect((await content().get()).data().blocks[0].data.races[0]).not.toHaveProperty("expectedVoteShare");
    await makeDue(current.id); await db.doc("system/electionResultApBudget").delete();
    sourceData = { nextrequest: sourceData.nextrequest };
    expect(await poll(current.id)).toMatchObject({ unchanged: true });
    expect((await connection(current.id)).sourceCache.data.races[0].expectedVoteShare).toBe(0.85);
  });
  it.each(["cmsPages", "cmsPosts"])("requires the admitted version 2 pair contract for expected vote on %s", async collection => {
    const current = await connect(collection, "automatic", { kind: "ap", mapping: apMapping });
    await adoptPair(2);
    await db.doc(poller.CONTROL).set({ schemaVersion: 1, ap: { enabled: true, requestsPerMinute: 2 } });
    sourceData = apFixture(); sourceData.races[0].eevp = 85;
    expect(await poll(current.id)).toMatchObject({ published: true });
    const row = await connection(current.id);
    expect(row.lastGoodData.races[0].expectedVoteShare).toBe(0.85);
    const operation = (await db.doc(`${pairAdmission.ADMISSIONS}/operations/${row.operationId}`).get()).data();
    expect(operation.source.requiredFeatures).toEqual(["electionResultsVersion:2"]);
  });
  it.each(["cmsPages", "cmsPosts"])("keeps AP updating legacy %s values under a retained version 1 pair contract", async collection => {
    const current = await connect(collection, "automatic", { kind: "ap", mapping: apMapping });
    await adoptPair();
    const path = collection === "cmsPages" ? pageOwnership.PAGE_CAPABILITY_PATH : postOwnership.CAPABILITY_PATH;
    await db.doc(path).update({ electionResultsVersion: 2 });
    await db.doc(poller.CONTROL).set({ schemaVersion: 1, ap: { enabled: true, requestsPerMinute: 2 } });
    sourceData = apFixture(); sourceData.races[0].eevp = 85;
    expect(await poll(current.id)).toMatchObject({ published: true });
    const row = await connection(current.id);
    expect(row.lastHoldReason).toBeNull();
    expect(row.lastGoodData.races[0].reportingShare).toBe(50);
    expect(row.lastGoodData.races[0]).not.toHaveProperty("expectedVoteShare");
    const operation = (await db.doc(`${pairAdmission.ADMISSIONS}/operations/${row.operationId}`).get()).data();
    expect(operation.source.requiredFeatures).toEqual(["electionResultsVersion:1"]);
  });
  it("uses successful AP poll freshness for quiet races and never restamps it on an HTTP failure", async () => {
    const current = await connect("cmsPosts", "automatic", { kind: "ap", mapping: apMapping });
    await db.doc(poller.CONTROL).set({ schemaVersion: 1, ap: { enabled: true, requestsPerMinute: 2 } });
    sourceData = apFixture();
    let clock = "2026-11-04T03:00:00Z";
    const now = () => clock;
    expect(await poller.pollConnection({ firestore, id: current.id, now, fetchImpl: providerFetch })).toMatchObject({ published: true });
    const first = await connection(current.id);
    sourceData = { nextrequest: sourceData.nextrequest };
    clock = "2026-11-04T03:06:00Z";
    expect(await poller.pollConnection({ firestore, id: current.id, now, fetchImpl: providerFetch })).toMatchObject({ unchanged: true });
    const quiet = await connection(current.id);
    expect(quiet.lastGoodData.races[0].asOf).toBe(first.lastGoodData.races[0].asOf);
    expect(quiet.lastSourceSuccessAt).toBe(clock);
    providerFailure = 503; clock = "2026-11-04T03:12:00Z";
    expect(await poller.pollConnection({ firestore, id: current.id, now, fetchImpl: providerFetch })).toMatchObject({ held: true });
    const failed = await connection(current.id);
    expect(failed.lastSourceSuccessAt).toBe(quiet.lastSourceSuccessAt);
    expect(failed.lastHoldReason.code).toBe("stale");
    expect(failed.lastGoodDigest).toBe(first.lastGoodDigest);
  });
  it("revalidates cached repo values after 304 and still holds stale result times", async () => {
    const current = await connect(); await poll(current.id);
    const fetchImpl = (url, options) => String(url) === provider.RESULTS_URL
      ? Promise.resolve(new Response(null, { status: 304 })) : providerFetch(url, options);
    await makeDue(current.id);
    expect(await poller.pollConnection({ firestore, id: current.id, now, fetchImpl })).toMatchObject({ unchanged: true });
    await makeDue(current.id);
    expect(await poller.pollConnection({ firestore, id: current.id, now: () => "2026-11-04T03:10:00Z", fetchImpl })).toMatchObject({ held: true, code: "stale" });
  });
  it.each(["cmsPages", "cmsPosts"])("retains identical newer AP values through an older full check in %s, but holds real regressions", async collection => {
    const current = await connect(collection, "automatic", { kind: "ap", mapping: apMapping });
    await db.doc(poller.CONTROL).set({ schemaVersion: 1, ap: { enabled: true, requestsPerMinute: 2 } });
    sourceData = apFixture();
    sourceData.races.forEach(race => { race.reportingUnits[0].lastUpdated = "2026-11-04T02:59:10.123456Z"; });
    expect(await poll(current.id)).toMatchObject({ published: true });
    const first = await connection(current.id);
    const contentRef = db.doc(`${collection}/${current.document.id}`);
    const published = (await contentRef.get()).data().published;
    sourceData.races.forEach(race => { race.reportingUnits[0].lastUpdated = "2026-11-04T02:59:00.123456Z"; });
    expect(await poll(current.id, { now: () => "2026-11-04T03:11:00Z" })).toMatchObject({ unchanged: true });
    const confirmed = await connection(current.id);
    expect(confirmed.lastHoldReason).toBeNull();
    expect(confirmed.lastSourceSuccessAt).toBe("2026-11-04T03:11:00Z");
    expect(confirmed.lastApFullCheckAt).toBe("2026-11-04T03:11:00Z");
    expect(confirmed.lastGoodDigest).toBe(first.lastGoodDigest);
    expect(confirmed.sourceCache.data).toEqual(first.sourceCache.data);
    expect((await contentRef.get()).data().published).toEqual(published);
    sourceData.races[0].reportingUnits[0].candidates[0].voteCount++;
    expect(await poll(current.id, { now: () => "2026-11-04T03:22:00Z" })).toMatchObject({ held: true, code: "regression" });
    const refused = await connection(current.id);
    expect(refused.lastSourceSuccessAt).toBe(confirmed.lastSourceSuccessAt);
    expect(refused.lastApFullCheckAt).toBe(confirmed.lastApFullCheckAt);
    expect(refused.sourceCache.data).toEqual(first.sourceCache.data);
    expect((await contentRef.get()).data().published).toEqual(published);
  });
  it.each(["cmsPages", "cmsPosts"])("retains identical newer AP pending calls in Counts automatic for %s", async collection => {
    const current = await connect(collection, "counts-auto", { kind: "ap", mapping: apMapping });
    await db.doc(poller.CONTROL).set({ schemaVersion: 1, ap: { enabled: true, requestsPerMinute: 2 } });
    sourceData = apFixture();
    sourceData.races.forEach(race => { race.reportingUnits[0].lastUpdated = "2026-11-04T02:59:00Z"; });
    expect(await poll(current.id)).toMatchObject({ published: true });
    sourceData.races.forEach(race => { race.reportingUnits[0].lastUpdated = "2026-11-04T02:59:10Z"; });
    sourceData.races[0].reportingUnits[0].candidates[0].winner = "X";
    expect(await poll(current.id, { now: () => "2026-11-04T03:01:00Z" })).toMatchObject({ published: true });
    const pending = await connection(current.id);
    expect(pending.pendingStatuses).toEqual(["us-senate"]);
    expect(pending.pendingData.races[0].status).toBe("called");
    const contentRef = db.doc(`${collection}/${current.document.id}`);
    const published = (await contentRef.get()).data().published;
    expect(published.blocks[0].data.races[0].status).toBe("counting");
    sourceData.races.forEach(race => { race.reportingUnits[0].lastUpdated = "2026-11-04T02:59:00Z"; });
    expect(await poll(current.id, { now: () => "2026-11-04T03:12:00Z" })).toMatchObject({ unchanged: true });
    const confirmed = await connection(current.id);
    expect(confirmed.lastHoldReason).toBeNull();
    expect(confirmed.pendingData).toEqual(pending.pendingData);
    expect(confirmed.pendingStatuses).toEqual(pending.pendingStatuses);
    expect(confirmed.pendingDigest).toBe(pending.pendingDigest);
    expect(confirmed.sourceCache.data).toEqual(pending.sourceCache.data);
    expect(confirmed.lastApFullCheckAt).toBe("2026-11-04T03:12:00Z");
    delete sourceData.races[0].reportingUnits[0].candidates[0].winner;
    expect(await poll(current.id, { now: () => "2026-11-04T03:23:00Z" })).toMatchObject({ held: true, code: "regression" });
    const refused = await connection(current.id);
    expect(refused.pendingData).toEqual(pending.pendingData);
    expect(refused.pendingDigest).toBe(pending.pendingDigest);
    expect(refused.sourceCache.data).toEqual(pending.sourceCache.data);
    expect(refused.lastSourceSuccessAt).toBe(confirmed.lastSourceSuccessAt);
    expect((await contentRef.get()).data().published).toEqual(published);
  });
  it("holds an AP race disappearing from periodic full reconciliation while keeping ordinary empty deltas valid", async () => {
    const current = await connect("cmsPosts", "automatic", { kind: "ap", mapping: apMapping });
    await db.doc(poller.CONTROL).set({ schemaVersion: 1, ap: { enabled: true, requestsPerMinute: 2 } });
    sourceData = apFixture(); await poll(current.id);
    sourceData.races.pop();
    expect(await poller.pollConnection({ firestore, id: current.id, now: () => "2026-11-04T03:11:00Z", fetchImpl: providerFetch })).toMatchObject({ held: true, code: "missing-race" });
    expect((await connection(current.id)).lastGoodData.races).toHaveLength(2);
  });
  it("stages truncated AP responses and publishes only the complete combined update", async () => {
    const current = await connect("cmsPosts", "automatic", { kind: "ap", mapping: apMapping });
    await db.doc(poller.CONTROL).set({ schemaVersion: 1, ap: { enabled: true, requestsPerMinute: 2 } });
    const full = apFixture(); sourceData = { ...full, isTruncated: true, races: full.races.slice(0, 1) };
    let clock = "2026-11-04T03:00:00Z"; const now = () => clock;
    const before = (await db.doc("cmsPosts/election-results-story").get()).data().published;
    expect(await poller.pollConnection({ firestore, id: current.id, now, fetchImpl: providerFetch })).toMatchObject({ staged: true });
    expect((await db.doc("cmsPosts/election-results-story").get()).data().published).toEqual(before);
    expect((await connection(current.id)).lastGoodDigest).toBeNull();
    sourceData = { ...full, races: full.races.slice(1) }; clock = "2026-11-04T03:01:00Z";
    expect(await poller.pollConnection({ firestore, id: current.id, now, fetchImpl: providerFetch })).toMatchObject({ published: true });
    expect((await connection(current.id)).apStaging).toBeNull();
    expect((await connection(current.id)).lastGoodData.races).toHaveLength(2);
  });
  it("paces two AP connections inside the shared key quota without delaying other source kinds", async () => {
    const first = await connect("cmsPages", "automatic", { kind: "ap", mapping: apMapping });
    const second = await connect("cmsPosts", "automatic", { kind: "ap", mapping: apMapping });
    await db.doc(poller.CONTROL).set({ schemaVersion: 1, ap: { enabled: true, requestsPerMinute: 2 } });
    sourceData = apFixture(); let time = Date.parse("2026-11-04T03:00:00Z");
    const delays = [];
    await poller.pollConnections({ firestore, now: () => new Date(time).toISOString(), fetchImpl: providerFetch,
      wait: async milliseconds => { delays.push(milliseconds); time += milliseconds; } });
    expect((await connection(first.id)).lastGoodDigest).not.toBeNull();
    expect((await connection(second.id)).lastGoodDigest).not.toBeNull();
    expect(delays).toEqual([5000]);
    expect((await db.doc("system/electionResultApBudget").get()).data().used).toBe(2);
  });
  it("polls on the next scheduler minute after a slow successful check, without forcing it due", async () => {
    const current = await connect();
    let clock = Date.parse("2026-11-04T03:00:00Z");
    const fetchImpl = async (url, options) => { if (String(url) === provider.RESULTS_URL) clock += 8000; return providerFetch(url, options); };
    const now = () => new Date(clock).toISOString();
    expect(await poller.pollConnection({ firestore, id: current.id, now, fetchImpl })).toMatchObject({ published: true });
    clock = Date.parse("2026-11-04T03:01:00Z");
    expect(await poller.pollConnection({ firestore, id: current.id, now, fetchImpl })).toMatchObject({ unchanged: true });
    expect(providerCalls.filter(call => call.url === provider.RESULTS_URL)).toHaveLength(2);
    expect((await connection(current.id)).lastCheckAt).toBe("2026-11-04T03:01:08.000Z");
  });
  it("does not add pacing waits for AP rows after the key quota is exhausted", async () => {
    const first = await connect("cmsPages", "automatic", { kind: "ap", mapping: apMapping });
    const second = await connect("cmsPosts", "automatic", { kind: "ap", mapping: apMapping });
    await db.doc(poller.CONTROL).set({ schemaVersion: 1, ap: { enabled: true, requestsPerMinute: 1 } });
    sourceData = apFixture(); const delays = [];
    await poller.pollConnections({ firestore, now, fetchImpl: providerFetch, wait: async value => { delays.push(value); } });
    const rows = [await connection(first.id), await connection(second.id)];
    expect(rows.filter(row => row.lastGoodData)).toHaveLength(1);
    expect(rows.filter(row => row.lastSchedulingReason?.code === "ap-quota")).toHaveLength(1);
    expect(delays).toEqual([]);
  });
  it("allows approval of fresh AP values after a quota deferral without creating a source hold", async () => {
    const current = await connect("cmsPosts", "approve-once", { kind: "ap", mapping: apMapping });
    await db.doc(poller.CONTROL).set({ schemaVersion: 1, ap: { enabled: true, requestsPerMinute: 1 } });
    sourceData = apFixture(); expect(await poll(current.id)).toMatchObject({ pendingApproval: true });
    await makeDue(current.id);
    expect(await poll(current.id)).toMatchObject({ held: true, code: "ap-quota" });
    const deferred = await connection(current.id);
    expect(deferred.lastHoldReason).toBeNull();
    expect(deferred.lastSchedulingReason.code).toBe("ap-quota");
    const approved = await call("sources", { action: "approve", ...address("cmsPosts"), baseVersion: 1 });
    expect(approved.status, approved.body.error).toBe(200);
    expect((await db.collection("admin_logs").where("action", "==", "election_source.hold").get()).size).toBe(0);
    const later = "2026-11-04T03:06:00Z";
    await db.doc("system/electionResultApBudget").set({ startedAt: Date.parse(later), used: 1, lastRequestAt: Date.parse(later) });
    await makeDue(current.id);
    expect(await poller.pollConnection({ firestore, id: current.id, now: () => later, fetchImpl: providerFetch })).toMatchObject({ held: true, code: "ap-quota" });
    expect((await connection(current.id)).lastHoldReason.code).toBe("stale");
    expect((await connection(current.id)).lastSourceSuccessAt).toBe(now());
  });
  it.each(["cmsPages", "cmsPosts"])("keeps a pending dataset refresh valid across an election-only %s poll", async collection => {
    const current = await withDataset(collection);
    const revised = await correction(current.dataset);
    const captured = (await db.doc(`cmsDatasetRefreshJobs/${revised.refreshJobId}`).get()).data();
    if (collection === "cmsPosts") {
      // The pre-source capture schema has no working-version anchor. Its exact
      // approved receipt must survive; no worker may rewrite old captures.
      for (const owner of captured.captures) delete owner.workingVersion;
      captured.captureDigest = datasetDependencies.digest(captured.captures);
      await db.doc(`cmsDatasetRefreshJobs/${revised.refreshJobId}`).update({ captures: captured.captures, captureDigest: captured.captureDigest });
    }
    const before = (await db.doc(`${collection}/${current.document.id}`).get()).data();
    expect(await poll(current.id)).toMatchObject({ published: true });
    const after = (await db.doc(`${collection}/${current.document.id}`).get()).data();
    const lineage = (await electionLineage.lineageRef(db, collection, current.document.id).get()).data();
    expect(lineage.baselineDigest).toBe(datasetIdentity.editorialSnapshotDigest(before.published));
    expect(lineage.editorialDigest).toBe(datasetIdentity.editorialSnapshotDigest(after.published));
    expect(lineage.workingVersion).toBe(before.version);
    expect(after.blocks).toEqual(before.blocks);
    await datasetRefresh.processDatasetRefreshJob({ firestore, jobId: revised.refreshJobId });
    const task = await refreshTask(revised);
    expect(task.error, JSON.stringify(task)).toBeNull();
    expect(task.operationId).toMatch(/^[A-Za-z0-9]{20}$/);
    const updated = (await db.doc(`${collection}/${current.document.id}`).get()).data();
    expect(updated.published.datasetFigures.releases[0].revision).toBe(2);
    expect(updated.published.blocks.find(block => block.id === "results-block").data.races[0].candidates[0].votes).toBe(25);
    expect(updated.blocks).toEqual(before.blocks);
    expect((await db.doc(`cmsDatasetRefreshJobs/${revised.refreshJobId}`).get()).data().captureDigest).toBe(captured.captureDigest);
  });
  it("keeps a dataset approval captured after an earlier poll valid across another poll", async () => {
    const current = await withDataset("cmsPages"); await poll(current.id);
    const revised = await correction(current.dataset);
    sourceData.races[0].candidates[0].votes = 26;
    await makeDue(current.id); expect(await poll(current.id)).toMatchObject({ published: true });
    await datasetRefresh.processDatasetRefreshJob({ firestore, jobId: revised.refreshJobId });
    expect((await refreshTask(revised)).operationId).toMatch(/^[A-Za-z0-9]{20}$/);
    expect((await db.doc("cmsPages/contact").get()).data().published.datasetFigures.releases[0].revision).toBe(2);
  });
  it("breaks digest lineage on a concurrent staff save without leaking that draft", async () => {
    const current = await withDataset("cmsPosts"); await poll(current.id);
    const revisedDataset = await correction(current.dataset);
    sourceData.races[0].candidates[0].votes = 26;
    await makeDue(current.id);
    let release; let fetched;
    const waiting = new Promise(resolve => { fetched = resolve; }); const gate = new Promise(resolve => { release = resolve; });
    const fetchImpl = async (url, options) => { if (String(url) === provider.RESULTS_URL) { fetched(); await gate; } return providerFetch(url, options); };
    const polling = poller.pollConnection({ firestore, id: current.id, now, fetchImpl }); await waiting;
    const revised = await transition("cmsPosts", (await db.doc(`cmsPosts/${current.document.id}`).get()).data(), "revise");
    const saved = await call("save", { collection: "cmsPosts", id: current.document.id, baseVersion: revised.body.document.version, document: { title: "Unpublished staff correction" } });
    expect(saved.status, saved.body.error).toBe(200);
    release(); expect(await polling).toMatchObject({ published: true });
    const document = (await db.doc(`cmsPosts/${current.document.id}`).get()).data();
    expect(document.title).toBe("Unpublished staff correction");
    expect(document.published.metadata.title).toBe("Synthetic results");
    const lineage = (await electionLineage.lineageRef(db, "cmsPosts", current.document.id).get()).data();
    expect(lineage.workingVersion).toBe(saved.body.document.version);
    await datasetRefresh.processDatasetRefreshJob({ firestore, jobId: revisedDataset.refreshJobId });
    const task = await refreshTask(revisedDataset);
    expect(task.status).toBe("failed");
    expect(task.error).toContain("published content changed");
    expect((await db.doc(`cmsPosts/${current.document.id}`).get()).data().published.datasetFigures.releases[0].revision).toBe(1);
  });
  it("holds when the renderer lacks V1 support without changing the public snapshot", async () => {
    const current = await connect();
    const before = (await db.doc("cmsPages/contact").get()).data().published;
    await db.doc(pageOwnership.PAGE_CAPABILITY_PATH).update({ electionResultsVersion: 0 });
    expect(await poll(current.id)).toMatchObject({ held: true });
    expect((await db.doc("cmsPages/contact").get()).data().published).toEqual(before);
    expect((await connection(current.id)).lastGoodDigest).toBeNull();
    expect((await connection(current.id)).lastSourceSuccessAt).toBe(now());
  });
  it("preserves accepted connected values on a later normal publication instead of rolling back to draft numbers", async () => {
    const current = await connect(); await poll(current.id);
    let before = (await db.doc("cmsPages/contact").get()).data();
    const revision = await transition("cmsPages", before, "revise");
    expect(revision.status, revision.body.error).toBe(200);
    const saved = await call("save", { collection: "cmsPages", id: "contact", baseVersion: revision.body.document.version,
      document: { title: "Updated parent title" } });
    expect(saved.status, saved.body.error).toBe(200);
    before = await approve("cmsPages", saved.body.document);
    const result = await call("save", { collection: "cmsPages", id: "contact", baseVersion: before.version,
      publish: true, document: {} });
    expect(result.status, result.body.error).toBe(200);
    expect(result.body.document.published.blocks[0].data.races[0].id).toBe("us-senate");
    expect(result.body.document.published.blocks[0].data.races[0].candidates[0].votes).toBe(25);
  });
  it.each(["paused", "reconfigured"])("retains public source values during an unrelated title publish while %s", async state => {
    const current = await connect(); await poll(current.id);
    const response = await call("sources", state === "paused" ? { action: "pause", ...address("cmsPages"), baseVersion: 1 }
      : { action: "connect", ...address("cmsPages"), baseVersion: 1, contentVersion: current.document.version, config: config("approve-once") });
    expect(response.status, response.body.error).toBe(200);
    const revised = await transition("cmsPages", (await db.doc("cmsPages/contact").get()).data(), "revise");
    const saved = await call("save", { collection: "cmsPages", id: "contact", baseVersion: revised.body.document.version, document: { title: "Unrelated title correction" } });
    expect(saved.status, saved.body.error).toBe(200);
    const approved = await approve("cmsPages", saved.body.document);
    const result = await call("save", { collection: "cmsPages", id: "contact", baseVersion: approved.version, publish: true, document: {} });
    expect(result.status, result.body.error).toBe(200);
    expect(result.body.document.published.blocks[0].data.races[0].id).toBe("us-senate");
    expect(result.body.document.published.blocks[0].data.races[0].candidates[0].votes).toBe(25);
  });
  it.each(["publish", "schedule"])("treats an active source's manual %s refusal as an expected editor decision", async action => {
    const current = await connect(); await poll(current.id);
    const revised = await transition("cmsPages", (await db.doc("cmsPages/contact").get()).data(), "revise");
    const corrected = structuredClone((await connection(current.id)).lastGoodData);
    corrected.races[0].candidates[0].votes = 26;
    const saved = await call("save", { collection: "cmsPages", id: "contact", baseVersion: revised.body.document.version,
      document: { blocks: [{ ...electionBlock(), data: corrected }] } });
    expect(saved.status, saved.body.error).toBe(200);
    const approved = await approve("cmsPages", saved.body.document);
    const refused = await call("save", { collection: "cmsPages", id: "contact", baseVersion: approved.version,
      ...(action === "publish" ? { publish: true } : { scheduleAt: "2026-11-04T04:00:00.000Z" }), document: {} });
    expect(refused.status, refused.body.error).toBe(409);
    expect(refused.body.error).toContain("Pause this election source");
    expect(saveLog.error).not.toHaveBeenCalled();
    expect((await db.doc("cmsPages/contact").get()).data().published.blocks[0].data.races[0].candidates[0].votes).toBe(25);
  });
  it("allows an explicitly paused source to be corrected manually and requires reconnect after publication", async () => {
    const current = await connect(); await poll(current.id);
    expect((await call("sources", { action: "pause", ...address("cmsPages"), baseVersion: 1 })).status).toBe(200);
    const revised = await transition("cmsPages", (await db.doc("cmsPages/contact").get()).data(), "revise");
    const corrected = structuredClone((await connection(current.id)).lastGoodData);
    corrected.races[0].candidates[0].votes = 26;
    corrected.races[0].candidates[0].share = 26;
    corrected.races[0].candidates[1].share = 24;
    const saved = await call("save", { collection: "cmsPages", id: "contact", baseVersion: revised.body.document.version,
      document: { blocks: [{ ...electionBlock(), data: corrected }] } });
    expect(saved.status, saved.body.error).toBe(200);
    const approved = await approve("cmsPages", saved.body.document);
    const result = await call("save", { collection: "cmsPages", id: "contact", baseVersion: approved.version, publish: true, document: {} });
    expect(result.status, result.body.error).toBe(200);
    expect(result.body.document.published.blocks[0].data.races[0].candidates[0].votes).toBe(26);
    const resumed = await call("sources", { action: "resume", ...address("cmsPages"), baseVersion: 2 });
    expect(resumed.status).toBe(409);
    expect(resumed.body.error).toContain("reconnect");
    expect((await connection(current.id)).paused).toBe(true);
    const reconnected = await call("sources", { action: "connect", ...address("cmsPages"), baseVersion: 2,
      contentVersion: result.body.document.version, config: config("counts-auto") });
    expect(reconnected.status, reconnected.body.error).toBe(200);
    expect((await connection(current.id)).lastGoodData).toBeNull();
    const projected = await db.runTransaction(transaction => refresh.withElectionSourceProjection({
      firestore, transaction, collection: "cmsPages", documentId: "contact", document: result.body.document }));
    expect(projected.blocks[0].data.races[0].candidates[0].votes).toBe(26);
    sourceData.races[0] = { ...sourceData.races[0], status: "called", sourceKind: "ap", sourceLabel: "AP", sourceUrl: "https://apnews.com/", calledCandidateId: sourceData.races[0].candidates[0].id };
    expect(await poll(current.id)).toMatchObject({ published: true });
    expect((await connection(current.id)).pendingStatuses).toContain("us-senate");
    expect((await connection(current.id)).lastGoodData.races[0].status).toBe("counting");
  });
  it("disposes a blocked election candidate without starving a later scheduled publication", async () => {
    const current = await connect(); await poll(current.id);
    await call("sources", { action: "pause", ...address("cmsPages"), baseVersion: 1 });
    const revised = await transition("cmsPages", (await db.doc("cmsPages/contact").get()).data(), "revise");
    const corrected = electionRace(); corrected.candidates[0].votes = 630;
    const saved = await call("save", { collection: "cmsPages", id: "contact", baseVersion: revised.body.document.version, document: { blocks: [electionBlock(corrected)] } });
    expect(saved.status, saved.body.error).toBe(200);
    const approved = await approve("cmsPages", saved.body.document);
    const scheduled = await call("save", { collection: "cmsPages", id: "contact", baseVersion: approved.version,
      scheduleAt: "2026-11-04T03:30:00.000Z", document: {} });
    expect(scheduled.status, scheduled.body.error).toBe(200);
    const resumed = await call("sources", { action: "resume", ...address("cmsPages"), baseVersion: 2 });
    expect(resumed.status).toBe(409);
    // Simulate an older/corrupted connection to exercise the final scheduler fence.
    await db.doc(`cmsElectionResultConnections/${current.id}`).update({ paused: false });
    const post = await publishedRecord("cmsPosts");
    const postRevision = await transition("cmsPosts", post, "revise");
    const postApproved = await approve("cmsPosts", postRevision.body.document);
    const postScheduled = await call("save", { collection: "cmsPosts", id: post.id, baseVersion: postApproved.version,
      scheduleAt: "2026-11-04T04:00:00.000Z", document: {} });
    expect(postScheduled.status, postScheduled.body.error).toBe(200);
    const outcome = await scheduledPublish.createScheduledPublishRunner({ firestore, now: () => "2026-11-04T04:00:00.000Z" })();
    expect(outcome).toMatchObject({ publishedCount: 1 });
    expect((await db.doc("cmsPages/contact").get()).data().scheduledPublishFailure).toBeTruthy();
    expect((await db.doc(`cmsPosts/${post.id}`).get()).data().status).toBe("published");
  });
  it.each(["cmsPages", "cmsPosts"])("keeps the latest accepted feed values when a scheduled %s publication fires", async collection => {
    const current = await connect(collection); await poll(current.id);
    const revised = await transition(collection, (await db.doc(`${collection}/${current.document.id}`).get()).data(), "revise");
    expect(revised.status, revised.body.error).toBe(200);
    const approved = await approve(collection, revised.body.document);
    const scheduled = await call("save", { collection, id: current.document.id, baseVersion: approved.version,
      scheduleAt: "2026-11-04T04:00:00.000Z", document: {} });
    expect(scheduled.status, scheduled.body.error).toBe(200);
    sourceData.races[0].candidates[0].votes = 30;
    sourceData.races[0].candidates[0].share = 30;
    sourceData.races[0].candidates[1].share = 20;
    expect(await poller.pollConnection({ firestore, id: current.id, now: () => "2026-11-04T03:01:00.000Z", fetchImpl: providerFetch })).toMatchObject({ published: true });
    const outcome = await scheduledPublish.createScheduledPublishRunner({ firestore, now: () => "2026-11-04T04:00:00.000Z" })();
    expect(outcome).toMatchObject({ publishedCount: 1 });
    const after = (await db.doc(`${collection}/${current.document.id}`).get()).data();
    expect(after.status).toBe("published");
    expect(after.published.blocks[0].data.races[0].candidates[0].votes).toBe(30);
    expect(after.blocks[0].data.races[0].id).toBe("district-7");
  });
});

// Historical fixture stays separate from the live 2026 roster and identities.
const rehearsalPageId = `page-${"c".repeat(32)}`;
const rehearsalAddress = { collection: "cmsPages", documentId: rehearsalPageId, blockId: "results-block" };
async function rehearsalPage() {
  const roster = rehearsal.rehearsalRoster();
  const race = roster.races[0];
  const data = { ...race, status: "awaiting", asOf: "2026-11-04T02:58:00Z", reportingShare: null,
    sourceKind: "official", sourceLabel: "REHEARSAL: 2015 historical returns", sourceUrl: "https://results.example.test/rehearsal",
    candidates: roster.candidates.map(candidate => ({ id: candidate.id, name: candidate.name, party: candidate.ballotLabel, votes: null, share: null })) };
  delete data.candidateIds;
  let current = { ...document("cmsPages"), id: rehearsalPageId, slug: `rehearsal-${"e".repeat(32)}`,
    title: "REHEARSAL: 2015 historical results", seo: { noindex: true }, blocks: [electionBlock(data)] };
  await db.doc("system/noBuildPostAdmission").update({ "families.pages.ids": ["contact", rehearsalPageId] });
  await db.doc(`cmsPages/${rehearsalPageId}`).set(current);
  current = await approve("cmsPages", current);
  const response = await call("save", { collection: "cmsPages", id: current.id, baseVersion: current.version, publish: true, document: {} });
  expect(response.status, response.body.error).toBe(200);
  sourceData = { schemaVersion: 1, electionDate: roster.electionDate, generatedAt: "2026-11-04T02:59:00Z", sample: true,
    races: [{ id: race.id, status: "counting", asOf: "2026-11-04T02:59:00Z", reportingShare: 25,
      sourceKind: "official", sourceLabel: "REHEARSAL: 2015 historical returns", sourceUrl: "https://results.example.test/rehearsal",
      candidates: roster.candidates.map((candidate, index) => ({ id: candidate.id, votes: index + 10, share: Math.round((index + 10) / 46 * 10000) / 100 })) }] };
  return response.body.document;
}
async function enableRehearsal() {
  await db.doc(poller.CONTROL).set({ schemaVersion: 1,
    rehearsal: { enabled: true, documentId: rehearsalPageId, blockId: "results-block" } });
}
async function connectRehearsal(document, mode = "automatic", endpoint = "productionSources", overrides = {}) {
  return call(endpoint, { action: "connect", ...rehearsalAddress, baseVersion: 0, contentVersion: document.version,
    config: { source: { kind: "repo" }, rehearsal: true, mode, raceIds: ["rehearsal-2015-ld1"], maxAgeSeconds: 300 }, ...overrides });
}
async function pollRehearsal(id, extra = {}) {
  return poller.pollConnection({ firestore: productionFirestore, id, now, fetchImpl: providerFetch, ...extra });
}
describe("production historical rehearsal isolation at the real HTTP and Firestore boundaries", () => {
  beforeEach(async () => {
    publicationProject = "njpbs-site";
    vi.stubEnv("CMS_DEPLOYMENT_ENVIRONMENT", "production");
    await db.doc("system/cmsPublicationRuntime").update({ "cloud.serializerId": "cloudflare-publisher" });
    await db.doc("system/noBuildPostAdmission").update({ backgroundBucket: "njpbs-public-artifacts" });
  });
  it("defaults off and refuses another project even when an exact target is enabled", async () => {
    const document = await rehearsalPage();
    expect((await connectRehearsal(document)).status).toBe(400);
    await enableRehearsal();
    expect((await connectRehearsal(document, "automatic", "otherProjectSources")).status).toBe(400);
    expect((await db.collection("cmsElectionResultConnections").get()).empty).toBe(true);
  });
  it.each(["automatic", "approve-once", "counts-auto"])("publishes only the allowlisted labeled historical Page in %s mode", async mode => {
    const document = await rehearsalPage(); await enableRehearsal();
    const connected = await connectRehearsal(document, mode);
    expect(connected.status, connected.body.error).toBe(200);
    const id = refresh.connectionId("cmsPages", rehearsalPageId, "results-block");
    const first = await pollRehearsal(id);
    if (mode === "approve-once") {
      expect(first).toMatchObject({ pendingApproval: true });
      const row = await connection(id);
      expect((await call("productionSources", { action: "approve", ...rehearsalAddress, baseVersion: row.version })).status).toBe(200);
      expect(await pollRehearsal(id)).toMatchObject({ published: true });
    } else expect(first).toMatchObject({ published: true });
    const result = (await db.doc(`cmsPages/${rehearsalPageId}`).get()).data();
    expect(result.published.blocks[0].data.races[0]).toMatchObject({ id: "rehearsal-2015-ld1",
      office: "REHEARSAL: New Jersey General Assembly (2015)", candidates: [{ name: "Bob Andrzejczak", votes: 10 }, {}, {}, {}] });
    expect(result.published.metadata.seo.noindex).toBe(true);
    expect(result.blocks[0].data.races[0].candidates[0].votes).toBeNull();
    expect(providerCalls.some(call => call.url === provider.RESULTS_URL)).toBe(false);
  });
  it("refuses another target and a Page without the published visible label", async () => {
    const document = await rehearsalPage(); await enableRehearsal();
    await db.doc(poller.CONTROL).update({ "rehearsal.documentId": "contact" });
    expect((await connectRehearsal(document)).status).toBe(400);
    await enableRehearsal();
    await db.doc(`cmsPages/${rehearsalPageId}`).update({ "published.metadata.title": "Historical results" });
    expect((await connectRehearsal(document)).status).toBe(400);
  });
  it("rechecks noindex before provider access and discards an update if the gate closes during fetch", async () => {
    const document = await rehearsalPage(); await enableRehearsal();
    expect((await connectRehearsal(document)).status).toBe(200);
    const id = refresh.connectionId("cmsPages", rehearsalPageId, "results-block");
    await db.doc(`cmsPages/${rehearsalPageId}`).update({ "seo.noindex": false });
    providerCalls = [];
    expect(await pollRehearsal(id)).toMatchObject({ held: true, code: "rehearsal" });
    expect(providerCalls).toEqual([]);
    await db.doc(`cmsPages/${rehearsalPageId}`).update({ "seo.noindex": true });
    await makeDue(id);
    const fetchImpl = async (url, options) => {
      if (String(url) === rehearsal.RESULTS_URL) await db.doc(poller.CONTROL).update({ "rehearsal.enabled": false });
      return providerFetch(url, options);
    };
    expect(await pollRehearsal(id, { fetchImpl })).toMatchObject({ held: true, code: "rehearsal" });
    expect((await db.doc(`cmsPages/${rehearsalPageId}`).get()).data().published.blocks[0].data.races[0].status).toBe("awaiting");
  });
  it("returns a normal conflict instead of an unexpected error when a publication removes noindex", async () => {
    const document = await rehearsalPage(); await enableRehearsal();
    expect((await connectRehearsal(document)).status).toBe(200);
    const revised = await transition("cmsPages", document, "revise");
    expect(revised.status, revised.body.error).toBe(200);
    const edited = await call("save", { collection: "cmsPages", id: rehearsalPageId,
      baseVersion: revised.body.document.version, document: { seo: { noindex: false } } });
    expect(edited.status, edited.body.error).toBe(200);
    const approved = await approve("cmsPages", edited.body.document);
    const refused = await call("save", { collection: "cmsPages", id: rehearsalPageId,
      baseVersion: approved.version, publish: true, document: {} });
    expect(refused.status, refused.body.error).toBe(409);
    expect(saveLog.error).not.toHaveBeenCalled();
    expect((await db.doc(`cmsPages/${rehearsalPageId}`).get()).data().published.metadata.seo.noindex).toBe(true);
  });
  it("keeps live 2026 sources refusing sample data", async () => {
    const current = await connect(); sourceData.sample = true;
    expect(await poll(current.id)).toMatchObject({ held: true, code: "envelope" });
    expect((await connection(current.id)).lastGoodData).toBeNull();
  });
  it("holds an incoming rehearsal row with no visible rehearsal attribution", async () => {
    const document = await rehearsalPage(); await enableRehearsal();
    expect((await connectRehearsal(document)).status).toBe(200);
    sourceData.races[0].sourceLabel = "Historical totals";
    const id = refresh.connectionId("cmsPages", rehearsalPageId, "results-block");
    expect(await pollRehearsal(id)).toMatchObject({ held: true, code: "rehearsal" });
  });
});


const apRehearsalPageId = `page-${"d".repeat(32)}`;
const apRehearsalAddress = { collection: "cmsPages", documentId: apRehearsalPageId, blockId: "results-block" };
const apRehearsalClock = { sourceTimeOrigin: "2026-11-04T04:00:00Z", replayTimeOrigin: "2026-11-04T02:59:00Z" };
async function apRehearsalPage() {
  const data = { races: roster.races.slice(0, 2).map(race => ({ id: race.id, office: race.office, district: race.district,
    status: "awaiting", asOf: "2026-11-04T02:58:00Z", reportingShare: null, sourceKind: "ap",
    sourceLabel: "REHEARSAL: AP 2026 test data; replay time", sourceUrl: "https://apnews.com/hub/election-2026",
    candidates: race.candidateIds.map(id => { const c = roster.candidates.find(c => c.id === id);
      return { id, name: c.name, party: c.ballotLabel, votes: null, share: null }; }) })) };
  let current = { ...document("cmsPages"), id: apRehearsalPageId, slug: `rehearsal-${"f".repeat(32)}`,
    title: "REHEARSAL: AP 2026 test results", seo: { noindex: true }, blocks: [{ ...electionBlock(), data }] };
  await db.doc("system/noBuildPostAdmission").update({ "families.pages.ids": ["contact", apRehearsalPageId] });
  await db.doc(`cmsPages/${apRehearsalPageId}`).set(current);
  current = await approve("cmsPages", current);
  const response = await call("save", { collection: "cmsPages", id: current.id, baseVersion: current.version, publish: true, document: {} });
  expect(response.status, response.body.error).toBe(200);
  sourceData = apFixture();
  for (const race of sourceData.races) {
    race.resultsType = "test"; race.reportingUnits[0].lastUpdated = "2026-11-04T04:00:00Z";
  }
  sourceData.nextrequest += "&level=state&resultsType=t&candidateInfo=brief&format=json";
  return response.body.document;
}
async function pollApRehearsal(id, extra = {}) {
  const at = endpointNow;
  const result = await pollRehearsal(id, { now: () => at, ...extra });
  endpointNow = new Date(Date.parse(at) + 6000).toISOString();
  return result;
}
async function enableApRehearsal() {
  await db.doc(poller.CONTROL).set({ schemaVersion: 1, ap: { enabled: true, requestsPerMinute: 2 },
    apRehearsal: { enabled: true, documentId: apRehearsalPageId, blockId: "results-block", ...apRehearsalClock } });
}
async function connectApRehearsal(document, mode = "automatic", overrides = {}) {
  return call("productionSources", { action: "connect", ...apRehearsalAddress, baseVersion: 0, contentVersion: document.version,
    config: { ...config(mode, { kind: "ap", mapping: apMapping }), apRehearsal: apRehearsalClock }, ...overrides });
}
const apRehearsalId = () => refresh.connectionId("cmsPages", apRehearsalPageId, "results-block");
describe("isolated AP 2026 rehearsal through real Auth, HTTP and Firestore boundaries", () => {
  beforeEach(async () => {
    publicationProject = "njpbs-site";
    vi.stubEnv("CMS_DEPLOYMENT_ENVIRONMENT", "production");
    await db.doc("system/cmsPublicationRuntime").update({ "cloud.serializerId": "cloudflare-publisher" });
    await db.doc("system/noBuildPostAdmission").update({ backgroundBucket: "njpbs-public-artifacts" });
  });
  it("publishes a capture-shaped test replay and retains normalized virtual/cache/source times", async () => {
    const document = await apRehearsalPage(); await enableApRehearsal();
    sourceData = apV3Fixture("test");
    const response = await connectApRehearsal(document);
    expect(response.status, response.body.error).toBe(200);
    expect(await pollApRehearsal(apRehearsalId())).toMatchObject({ published: true });
    const stored = await connection(apRehearsalId());
    expect(stored.lastGoodData.races[0]).toMatchObject({ status: "counting", asOf: "2026-11-04T02:59:00.258Z" });
    expect(stored.apVirtualAsOf["us-senate"]).toBe("2026-11-04T04:00:00.258Z");
    expect(stored.sourceCache.data).toEqual(stored.lastGoodData);
    expect(stored.apCursor).toBe(sourceData.nextrequest);
  });
  it("defaults off and requires the exact target, visible labels, and matching simulation origins", async () => {
    const document = await apRehearsalPage();
    expect((await connectApRehearsal(document)).status).toBe(400);
    await enableApRehearsal();
    expect((await call("otherProjectSources", { action: "connect", ...apRehearsalAddress, baseVersion: 0,
      contentVersion: document.version, config: { ...config("automatic", { kind: "ap", mapping: apMapping }), apRehearsal: apRehearsalClock } })).status).toBe(400);
    for (const mutation of [ { "apRehearsal.documentId": "contact" },
      { "apRehearsal.sourceTimeOrigin": "2026-11-04T04:01:00Z" } ]) {
      await db.doc(poller.CONTROL).update(mutation);
      expect((await connectApRehearsal(document)).status).toBe(400);
      await enableApRehearsal();
    }
    await db.doc(`cmsPages/${apRehearsalPageId}`).update({ "published.metadata.title": "REHEARSAL: 2015 results" });
    expect((await connectApRehearsal(document)).status).toBe(400);
    expect(providerCalls.some(call => call.url.startsWith("http://metadata.google.internal/") || call.url.startsWith("https://api.ap.org/"))).toBe(false);
  });
  it.each(["automatic", "approve-once", "counts-auto"])("uses normal authorization and a labeled replay in %s mode", async mode => {
    const document = await apRehearsalPage(); await enableApRehearsal();
    await db.doc(pageOwnership.PAGE_CAPABILITY_PATH).update({ electionResultsVersion: 2 });
    sourceData.races[0].eevp = 85;
    sourceData.races[0].reportingUnits[0].candidates[0].winner = "X";
    const connected = await connectApRehearsal(document, mode);
    expect(connected.status, connected.body.error).toBe(200);
    const id = apRehearsalId();
    const first = await pollApRehearsal(id);
    if (mode === "approve-once") {
      expect(first).toMatchObject({ pendingApproval: true });
      expect((await call("productionSources", { action: "approve", ...apRehearsalAddress, baseVersion: 1 })).status).toBe(200);
      expect(await pollApRehearsal(id)).toMatchObject({ published: true });
    } else expect(first).toMatchObject({ published: true });
    if (mode === "counts-auto") {
      const before = (await db.doc(`cmsPages/${apRehearsalPageId}`).get()).data();
      expect(before.published.blocks[0].data.races[0].status).toBe("counting");
      const row = await connection(id);
      expect((await call("productionSources", { action: "status", ...apRehearsalAddress,
        baseVersion: row.version, pendingDigest: row.pendingDigest })).status).toBe(200);
      expect(await pollApRehearsal(id)).toMatchObject({ published: true });
    }
    const result = (await db.doc(`cmsPages/${apRehearsalPageId}`).get()).data();
    expect(result.published.blocks[0].data.races[0]).toMatchObject({ id: "us-senate", status: "called",
      asOf: "2026-11-04T02:59:00.000Z", sourceLabel: "REHEARSAL: AP 2026 test data; replay time",
      expectedVoteShare: 0.85, reportingShare: null });
    expect(result.published.metadata.seo.noindex).toBe(true);
    expect(result.blocks[0].data.races[0].candidates[0].votes).toBeNull();
    expect((await connection(id)).apVirtualAsOf["us-senate"]).toBe("2026-11-04T04:00:00.000Z");
    expect(providerCalls.filter(call => call.url.startsWith("https://api.ap.org/")).every(call => new URL(call.url).searchParams.get("resultsType") === "t")).toBe(true);
  });
  it("keeps live AP connections refusing test data", async () => {
    const current = await connect("cmsPages", "automatic", { kind: "ap", mapping: apMapping });
    await db.doc(poller.CONTROL).set({ schemaVersion: 1, ap: { enabled: true, requestsPerMinute: 2 } });
    sourceData = apFixture(); sourceData.races[0].resultsType = "test";
    expect(await poll(current.id)).toMatchObject({ held: true, code: "ap" });
    expect((await connection(current.id)).sourceCache).toBeNull();
  });
  it("holds before key access on lost noindex and discards data if the gate closes during fetch", async () => {
    const document = await apRehearsalPage(); await enableApRehearsal();
    expect((await connectApRehearsal(document)).status).toBe(200);
    const id = apRehearsalId(); providerCalls = [];
    await db.doc(`cmsPages/${apRehearsalPageId}`).update({ "seo.noindex": false });
    expect(await pollApRehearsal(id)).toMatchObject({ held: true, code: "rehearsal" });
    expect(providerCalls).toEqual([]);
    await db.doc(`cmsPages/${apRehearsalPageId}`).update({ "seo.noindex": true });
    const held = await connection(id);
    expect((await call("productionSources", { action: "resume", ...apRehearsalAddress, baseVersion: held.version })).status).toBe(200);
    await makeDue(id);
    const fetchImpl = async (url, options) => {
      if (String(url).startsWith("https://api.ap.org/")) await db.doc(poller.CONTROL).update({ "apRehearsal.enabled": false });
      return providerFetch(url, options);
    };
    expect(await pollApRehearsal(id, { fetchImpl })).toMatchObject({ held: true, code: "rehearsal" });
    const after = (await db.doc(`cmsPages/${apRehearsalPageId}`).get()).data();
    expect(after.published.blocks[0].data.races[0].status).toBe("awaiting");
    expect((await connection(id)).sourceCache).toBeNull();
  });
  it("does not allow a test connection to be reconfigured as an ordinary live source", async () => {
    const document = await apRehearsalPage(); await enableApRehearsal();
    expect((await connectApRehearsal(document)).status).toBe(200);
    expect((await connectApRehearsal(document, "automatic", { baseVersion: 1,
      config: config("automatic", { kind: "ap", mapping: apMapping }) })).status).toBe(400);
    expect((await connection(apRehearsalId())).config.apRehearsal).toEqual(apRehearsalClock);
  });
  it("refuses ordinary publication that removes test Page search exclusion", async () => {
    const document = await apRehearsalPage(); await enableApRehearsal();
    expect((await connectApRehearsal(document)).status).toBe(200);
    const revised = await call("transition", { action: "revise", collection: "cmsPages", id: apRehearsalPageId,
      baseVersion: document.version, requestId: randomUUID() });
    expect(revised.status, revised.body.error).toBe(200);
    const edited = await call("save", { collection: "cmsPages", id: apRehearsalPageId,
      baseVersion: revised.body.document.version, document: { seo: { noindex: false } } });
    expect(edited.status, edited.body.error).toBe(200);
    const approved = await approve("cmsPages", edited.body.document);
    const refused = await call("save", { collection: "cmsPages", id: apRehearsalPageId,
      baseVersion: approved.version, publish: true, document: {} });
    expect(refused.status).toBe(409);
    expect((await db.doc(`cmsPages/${apRehearsalPageId}`).get()).data().published.metadata.seo.noindex).toBe(true);
  });
  it.each(["pause", "reconfigure"])("discards a test response fetched before a concurrent %s", async action => {
    const document = await apRehearsalPage(); await enableApRehearsal();
    expect((await connectApRehearsal(document)).status).toBe(200);
    const id = apRehearsalId();
    const fetchImpl = async (url, options) => {
      if (String(url).startsWith("https://api.ap.org/")) {
        const result = action === "pause"
          ? await call("productionSources", { action: "pause", ...apRehearsalAddress, baseVersion: 1 })
          : await connectApRehearsal(document, "approve-once", { baseVersion: 1 });
        expect(result.status, result.body.error).toBe(200);
      }
      return providerFetch(url, options);
    };
    expect(await pollApRehearsal(id, { fetchImpl })).toMatchObject({ discarded: true });
    expect((await connection(id)).sourceCache).toBeNull();
    const page = (await db.doc(`cmsPages/${apRehearsalPageId}`).get()).data();
    expect(page.published.blocks[0].data.races[0].status).toBe("awaiting");
    if (action === "pause") expect(await pollApRehearsal(id)).toMatchObject({ skipped: true });
    else {
      expect((await connection(id)).authorizedConfigRevision).toBeNull();
      expect(await pollApRehearsal(id)).toMatchObject({ pendingApproval: true });
    }
  });
  it("retains last-good public values on stale failure and recovers on a normal valid poll", async () => {
    const document = await apRehearsalPage(); await enableApRehearsal();
    expect((await connectApRehearsal(document)).status).toBe(200);
    const id = apRehearsalId(); expect(await pollApRehearsal(id)).toMatchObject({ published: true });
    const before = (await db.doc(`cmsPages/${apRehearsalPageId}`).get()).data().published;
    endpointNow = "2026-11-04T03:06:00.000Z"; providerFailure = 503; await makeDue(id);
    expect(await pollApRehearsal(id)).toMatchObject({ held: true });
    expect((await connection(id)).lastHoldReason.code).toBe("stale");
    expect((await db.doc(`cmsPages/${apRehearsalPageId}`).get()).data().published).toEqual(before);
    providerFailure = null; await makeDue(id);
    expect(await pollApRehearsal(id)).toMatchObject({ unchanged: true });
    expect((await connection(id)).lastHoldReason).toBeNull();
  });
  it("restores blank values through normal review before unpublishing and disabling the exact gate", async () => {
    const document = await apRehearsalPage(); await enableApRehearsal();
    expect((await connectApRehearsal(document)).status).toBe(200);
    const id = apRehearsalId(); expect(await pollApRehearsal(id)).toMatchObject({ published: true });
    expect((await call("productionSources", { action: "pause", ...apRehearsalAddress, baseVersion: 1 })).status).toBe(200);
    const current = (await db.doc(`cmsPages/${apRehearsalPageId}`).get()).data();
    const revised = await transition("cmsPages", current, "revise");
    expect(revised.status, revised.body.error).toBe(200);
    const blocks = structuredClone(document.blocks); blocks[0].data.races.forEach(race => { race.asOf = endpointNow; });
    const edited = await call("save", { collection: "cmsPages", id: apRehearsalPageId,
      baseVersion: revised.body.document.version, document: { blocks } });
    expect(edited.status, edited.body.error).toBe(200);
    const approved = await approve("cmsPages", edited.body.document);
    const restored = await call("save", { collection: "cmsPages", id: apRehearsalPageId,
      baseVersion: approved.version, publish: true, document: {} });
    expect(restored.status, restored.body.error).toBe(200);
    expect(restored.body.document.published.blocks[0].data.races.every(race => race.status === "awaiting" &&
      race.candidates.every(candidate => candidate.votes === null))).toBe(true);
    const unpublished = await transition("cmsPages", restored.body.document, "unpublish");
    expect(unpublished.status, unpublished.body.error).toBe(200);
    await db.doc(poller.CONTROL).update({ "apRehearsal.enabled": false });
    expect(await pollApRehearsal(id)).toMatchObject({ skipped: true });
    expect((await connection(id)).paused).toBe(true);
  });

  it("pauses an expired simulation before any key lookup or shared quota reservation", async () => {
    const document = await apRehearsalPage(); await enableApRehearsal();
    expect((await connectApRehearsal(document)).status).toBe(200);
    const id = apRehearsalId(); expect(await pollApRehearsal(id)).toMatchObject({ published: true });
    const budget = (await db.doc("system/electionResultApBudget").get()).data();
    endpointNow = "2026-11-05T04:00:00.000Z"; providerCalls = []; await makeDue(id);
    expect(await pollApRehearsal(id)).toMatchObject({ held: true, code: "rehearsal" });
    expect(providerCalls).toEqual([]);
    expect((await db.doc("system/electionResultApBudget").get()).data()).toEqual(budget);
    const row = await connection(id); expect(row.paused).toBe(true); expect(row.nextPollAt).toBeNull();
    expect((await call("productionSources", { action: "resume", ...apRehearsalAddress, baseVersion: row.version })).status).toBe(400);
  });

});
