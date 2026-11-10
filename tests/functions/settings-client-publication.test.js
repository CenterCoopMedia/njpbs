import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { createServer } from "node:http";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import "../../functions/lib/firebase.js";
import settings from "../../functions/settings.js";
import deployment from "../../functions/lib/public-deployment.js";
import context from "../../functions/lib/public-context-revision.js";
import { DEFAULT_SITE_NAVIGATION, DEFAULT_PUBLIC_SITE_CHROME_SETTINGS, DEFAULT_PUBLIC_HOMEPAGE_BANNER_SETTINGS } from "../../packages/content-core/src/cms-settings";

// Keep browser identity initialization out of this local transport/transaction
// proof. The server still rechecks the fixture's stored settings.manage role.
vi.mock("../../admin/src/lib/firebase", () => ({ firebaseConfig: { projectId: "demo-njpbs" }, getRequiredAppCheckToken: vi.fn() }));
import { cmsPublishSettings, cmsSaveSettings } from "../../admin/src/lib/functions";
const db = isolatedFirestore("settings-client-publication.test.js");

const sha = "a".repeat(40);
const actor = { uid: "settings-client-fixture", principal: { id: "settings-client-fixture", grants: [{ role: "admin" }] } };
const fixtures = { "site-navigation": DEFAULT_SITE_NAVIGATION, "public-site-chrome": DEFAULT_PUBLIC_SITE_CHROME_SETTINGS,
  "public-homepage-banner": DEFAULT_PUBLIC_HOMEPAGE_BANNER_SETTINGS };
const deps = { firestore: db, requirePrincipalFn: async () => actor, log: { error() {} } };
const handlers = { cmsPublishSettings: settings.createCmsPublishSettingsHandler(deps), cmsSaveSettings: settings.createCmsSaveSettingsHandler(deps) };
const requests = [];
let server;
let endpoint;
let nativeFetch;

beforeAll(async () => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") ||
      !/^demo-njpbs(?:-[a-z0-9-]+)?$/.test(process.env.GCLOUD_PROJECT ?? "")) throw new Error("Use local demo Firestore");
  nativeFetch = globalThis.fetch;
  server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const rawBody = Buffer.concat(chunks);
      const body = JSON.parse(rawBody.toString());
      const name = new URL(request.url, "http://127.0.0.1").pathname.split("/").pop();
      if (!handlers[name]) throw new Error("Unknown fixture endpoint");
      requests.push({ name, body });
      const bridge = { get headersSent() { return response.headersSent; },
        set(key, value) { response.setHeader(key, value); return this; },
        status(code) { response.statusCode = code; return this; },
        json(value) { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(value)); return this; } };
      await handlers[name]({ method: request.method, headers: request.headers, body, rawBody }, bridge);
    } catch { response.statusCode = 500; response.end("Fixture request failed"); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${server.address().port}`;
  vi.stubGlobal("fetch", (url, options) => {
    const parsed = new URL(url);
    if (parsed.origin === "http://127.0.0.1:5001") return nativeFetch(`${endpoint}${parsed.pathname}`, options);
    if (parsed.hostname !== "127.0.0.1") throw new Error("Only local fixture requests are allowed");
    return nativeFetch(url, options);
  });
});
afterAll(async () => { vi.unstubAllGlobals(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
beforeEach(async () => {
  requests.length = 0;
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${process.env.GCLOUD_PROJECT}/databases/(default)/documents`, { method: "DELETE" }, db, nativeFetch);
  await db.doc(`users/${actor.uid}`).set({ role: "admin", active: true });
  await db.doc("system/publicDeployment").set({ ...deployment.initialPublicDeploymentPointer(), activeGeneration: 1,
    activeCommitSha: sha, activeDeploymentId: "fixture-deployment", lastReservedGeneration: 1,
    newestEligibleGeneration: 1, newestEligibleBuildBatchId: "fixture-build", mediaLifecycleReady: true });
  await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: "ready", commitSha: sha,
    serializerId: "node-compute", cloud: { phase: "ready", commitSha: sha, serializerId: "cloudflare-publisher" } });
  await db.doc(context.PUBLIC_CONTEXT_PATH).set({ schemaVersion: 1, revision: 1 });
  for (const [id, values] of Object.entries(fixtures)) await db.doc(`cmsSettings/${id}`).set({ schemaVersion: 1, values, version: 1 });
});

it.each(Object.keys(fixtures))("keeps the actual marked %s client publish and retry on one atomic operation", async id => {
  const accepted = await cmsPublishSettings(null, { id, baseVersion: 1 });
  expect(accepted.publication).toMatchObject({ status: "pending", sourceVersion: 1, contextRevision: 2 });
  const values = structuredClone(fixtures[id]);
  if (id === "site-navigation") values.header[0].label = "Private navigation";
  if (id === "public-site-chrome") values.newsletterLabel = "Private header";
  if (id === "public-homepage-banner") values.message = "Private banner";
  const saved = await cmsSaveSettings(null, { id, baseVersion: 2, values });
  const ref = db.doc(`cmsPublishQueue/${accepted.publication.queueId}`);
  await ref.update({ status: "failed" });
  await ref.collection("backgroundPreparation").doc(accepted.publication.contextDigest).set({ runtime: { owner: "cloudflare", release: sha },
    status: "failed", attempts: 4, nextAttemptAt: null, claim: null, inputDigest: "c".repeat(64), preparedDigest: "d".repeat(64) });
  await ref.collection("backgroundOutputs").doc("feed").update({ status: "failed", attempts: 4, nextAttemptAt: null });
  const retried = await cmsPublishSettings(null, { id, baseVersion: accepted.publication.sourceVersion });
  expect(retried.publication).toMatchObject({ queueId: ref.id, status: "pending", sourceVersion: 1, contextRevision: 2 });
  expect(retried.settings).toEqual(saved.settings);
  expect(retried.settings.published).toEqual(accepted.settings.published);
  expect((await db.doc(context.PUBLIC_CONTEXT_PATH).get()).data().revision).toBe(2);
  expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
  expect((await ref.get()).data().changes).toEqual([]);
  expect(requests.map(row => row.name)).toEqual(["cmsPublishSettings", "cmsSaveSettings", "cmsPublishSettings"]);
  for (const row of requests.filter(row => row.name === "cmsPublishSettings")) expect(row.body).toEqual({ id, baseVersion: 1,
    publicationTransport: "public-context-no-build-v1" });
});
