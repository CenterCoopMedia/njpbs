import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import firebase from "../../functions/lib/firebase.js";
import save from "../../functions/save.js";
import lifecycle from "../../functions/lifecycle-transition.js";
import deployment from "../../functions/lib/public-deployment.js";
import context from "../../functions/lib/public-context-revision.js";
import postOwnership from "../../functions/lib/no-build-post-ownership.js";
import pageOwnership from "../../functions/lib/no-build-page-ownership.js";
import snapshots from "../../functions/lib/publish-snapshot.js";
import { electionBlock, electionRace } from "../fixtures/election-results.ts";

const { db, admin } = firebase;
const project = process.env.GCLOUD_PROJECT ?? "demo-njpbs";
const sha = "a".repeat(40);
const firestore = new Proxy(db, { get(target, key) {
  if (key === "projectId") return "njpbs-site-dev";
  const value = Reflect.get(target, key);
  return typeof value === "function" ? value.bind(target) : value;
} });
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
  const now = () => "2026-11-04T03:00:00.000Z";
  const handlers = { save: save.createCmsSaveHandler({ firestore, enablePublishSnapshot: true, now, log: { warn() {}, error() {} } }),
    transition: lifecycle.createCmsTransitionContentHandler({ firestore, now, log: { warn() {}, error() {} } }) };
  server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    request.body = JSON.parse(Buffer.concat(chunks).toString());
    response.status = code => { response.statusCode = code; return response; };
    response.json = body => { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(body)); return response; };
    await handlers[request.url.slice(1)](request, response);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
}, 20_000);
beforeEach(async () => {
  vi.stubEnv("CMS_DEPLOYMENT_ENVIRONMENT", "development");
  vi.stubEnv("FUNCTIONS_EMULATOR", "true");
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${project}/databases/(default)/documents`, { method: "DELETE" });
  await db.doc(`users/${actors.editor.uid}`).set({ role: "admin", active: true, email: actors.editor.email, displayName: "Results editor" });
  await db.doc(`users/${actors.writer.uid}`).set({ grants: [{ role: "contributor" }], active: true, email: actors.writer.email, displayName: "Results writer" });
  await seedSystem();
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  for (const actor of Object.values(actors ?? {})) await admin.auth().deleteUser(actor.uid);
});

describe("Election results at the Auth/HTTP/Firestore boundary", () => {
  it.each(["cmsPages", "cmsPosts"])("freezes approved results through the existing %s fast path", async collection => {
    let current = document(collection);
    await db.doc(`${collection}/${current.id}`).set(current);
    const unapproved = await call("save", { collection, id: current.id, baseVersion: current.version, publish: true, document: {} });
    expect(unapproved.status, unapproved.body.error).toBe(400);
    expect((await db.doc(`${collection}/${current.id}`).get()).data()).toEqual(current);
    current = await approve(collection, current);
    expect(current.electionResultsApprovals[0]).toMatchObject({ revision: 1, status: "counting", approvedBy: { uid: actors.editor.uid, displayName: "Results editor" } });
    const published = await call("save", { collection, id: current.id, baseVersion: current.version, publish: true, document: {} });
    expect(published.status, published.body.error).toBe(200);
    expect(published.body.publication.transport).toBe(collection === "cmsPages" ? "page-no-build-v1" : "post-no-build-v1");
    const frozen = published.body.document.published;
    expect(frozen.blocks[0].data.races[0].candidates[0].votes).toBe(620);
    expect(frozen.electionResultsApprovals).toBeUndefined();
    current = published.body.document;
    const revising = await transition(collection, current, "revise");
    expect(revising.status, revising.body.error).toBe(200);
    current = revising.body.document;
    const changed = electionRace({ status: "official" });
    changed.candidates[0].votes = 640;
    const edited = await call("save", { collection, id: current.id, baseVersion: current.version, document: { blocks: [electionBlock(changed)] } });
    expect(edited.status, edited.body.error).toBe(200);
    current = edited.body.document;
    expect(current.published).toEqual(frozen);
    const refused = await call("save", { collection, id: current.id, baseVersion: current.version, publish: true, document: {} });
    expect(refused.status, refused.body.error).toBe(400);
    expect((await db.doc(`${collection}/${current.id}`).get()).data().published).toEqual(frozen);
    current = await approve(collection, current);
    expect(current.electionResultsApprovals[0].statusHistory).toHaveLength(2);
    expect(current.electionResultsApprovals[0].statusHistory[1]).toMatchObject({ revision: 2, status: "official", approvedBy: { uid: actors.editor.uid } });
    expect(snapshots.createPublishedSnapshot({ collection, document: current, publishedAt: "2026-11-04T04:00:00Z", publishedBy: actors.editor.uid }).blocks[0].data.races[0].status).toBe("official");
  });
  it("refuses invalid totals at save, ignores forged approval, and denies a writer's approval", async () => {
    let current = document("cmsPosts");
    await db.doc(`cmsPosts/${current.id}`).set(current);
    const race = electionRace(); race.candidates[0].votes = -1;
    const invalid = await call("save", { collection: "cmsPosts", id: current.id, baseVersion: 1, document: { blocks: [electionBlock(race)] } });
    expect(invalid.status, invalid.body.error).toBe(400);
    const forged = await call("save", { collection: "cmsPosts", id: current.id, baseVersion: 1, document: {
      electionResultsApprovals: [{ blockId: "results-block", raceId: "district-7", approvedBy: { uid: actors.writer.uid }, revision: 99 }],
    } });
    expect(forged.status, forged.body.error).toBe(200);
    expect(forged.body.document.electionResultsApprovals).toBeUndefined();
    current = forged.body.document;
    const submitted = await transition("cmsPosts", current, "submit", actors.writer);
    expect(submitted.status, submitted.body.error).toBe(200);
    current = submitted.body.document;
    const denied = await transition("cmsPosts", current, "approve", actors.writer);
    expect(denied.status).toBe(403);
    expect((await db.doc(`cmsPosts/${current.id}`).get()).data().electionResultsApprovals).toBeUndefined();
    const stale = await transition("cmsPosts", { ...current, version: current.version - 1 }, "approve");
    expect(stale.status).toBe(409);
  });
  it.each(["cmsPages", "cmsPosts"])("refuses %s publication against an unmarked reader", async collection => {
    let current = document(collection);
    await db.doc(`${collection}/${current.id}`).set(current);
    current = await approve(collection, current);
    const path = collection === "cmsPages" ? pageOwnership.PAGE_CAPABILITY_PATH : postOwnership.CAPABILITY_PATH;
    const capability = (await db.doc(path).get()).data();
    delete capability.electionResultsVersion;
    await db.doc(path).set(capability);
    const result = await call("save", { collection, id: current.id, baseVersion: current.version, publish: true, document: {} });
    expect(result.status, result.body.error).toBe(409);
    expect(result.body.error).toMatch(/renderer.*election results/);
    expect((await db.doc(`${collection}/${current.id}`).get()).data().published).toBeUndefined();
  });
});
