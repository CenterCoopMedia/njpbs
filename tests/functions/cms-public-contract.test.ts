import { beforeAll, afterAll, beforeEach, afterEach, expect, it } from "vitest";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, readdir, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { initializeApp as initializeAdmin, getApps as adminApps, deleteApp as deleteAdmin } from "firebase-admin/app";
import { getFirestore, Timestamp as CaptureTimestamp } from "firebase-admin/firestore";
import { getAuth as adminAuth } from "firebase-admin/auth";
import { initializeApp as initializeClient, deleteApp as deleteClient } from "firebase/app";
import { getAuth, connectAuthEmulator, signInWithCustomToken } from "firebase/auth";
import { getFirestore as clientFirestore, connectFirestoreEmulator, updateDoc, doc, terminate } from "firebase/firestore";
import { CONTRACT_SETTINGS, contractDigest, contractTarget, contractIdentity, decodeContractValue, captureNativeContract, compareContractInputs, discoverAdminWrites,
  contractSummary, recheckContractSummary } from "../../scripts/lib/cms-public-contract.mjs";
import { prepareContractRuntime, replay } from "../../scripts/check-cms-public-contract.mjs";
import postFixture from "../../site/tests/fixtures/shadow-posts/post.json";
import { chromeSettings } from "../../site/tests/fixtures/shadow-posts/chrome";
import { DEFAULT_SITE_NAVIGATION, DEFAULT_PUBLIC_SITE_CHROME_SETTINGS, DEFAULT_PUBLIC_HOMEPAGE_BANNER_SETTINGS,
  DEFAULT_NJ_DECIDES_SETTINGS } from "../../packages/content-core/src/cms-settings";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../..", import.meta.url));
const inputs = process.env.CMS_PUBLIC_CONTRACT_INPUTS;
const fixedSha = "a".repeat(40);
const quiet = { info() {}, error() {}, warn() {} };
const evidence: any[] = [];
const apiReplies: Record<string, any[]> = { postChrome: [], capabilities: [] };
let scratch: string, c0: string, c1: string, rSource: string, artifact: string;
let rendererSha: string, candidateSha: string, baselineSha: string, invocation: any, capsule: any;
let server: Server, origin: string, db: ReturnType<typeof getFirestore>, app: any, handlerApp: any, client: any, clientDb: any;
let Timestamp = CaptureTimestamp;
let authServer: Server, priorAuthHost: string | undefined;
let token: string, actorId: string, native: NodeRequire, c0Client: any, c1Client: any, reader: any, compiled: any;
let dom: JSDOM, ui: any, React: any, nativeFetch: typeof fetch, requests: any[] = [];
let initialRoot: any, target: any;
let postId = "shadow-fixture", postSlug = "shadow-fixture", pageId = "contact";
let unsupportedReader: any, unsupportedArtifact: any, unsupportedSha: string;
const globals = new Map<string, PropertyDescriptor | undefined>();

function rememberGlobal(name: string, value: unknown) {
  globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

async function localClone(destination: string, revision: string) {
  await execute("git", ["clone", "--shared", "--no-checkout", root, destination]);
  await execute("git", ["checkout", "--detach", revision], { cwd: destination });
  for (const relative of ["node_modules", "site/node_modules", "functions/node_modules", "admin/node_modules", "cms-api/node_modules"]) {
    await mkdir(join(destination, relative), { recursive: true });
    for (const name of await readdir(join(root, relative)).catch(() => [])) {
      const workspace = relative === "node_modules" && { "njpbs-functions": "functions", "njpbs-admin": "admin", "njpbs-cms-api": "cms-api" }[name];
      await symlink(workspace ? join(destination, workspace) : join(root, relative, name), join(destination, relative, name));
    }
  }
}

async function clientApiOrigin(source: string) {
  const config = target.environment === "development" ? "cms-api/wrangler.dev.jsonc" : "cms-api/wrangler.jsonc";
  const { routes } = JSON.parse(await readFile(join(source, config), "utf8"));
  return `https://${routes[0].pattern}`;
}

async function bundleClient(source: string, revision: string, name: string) {
  const file = join(scratch, `${name}.mjs`);
  const project = target.projectId;
  const development = target.environment === "development";
  const appId = development ? "1:123456789012:web:0123456789abcdef012345" : "synthetic-emulator-app";
  const env = { DEV: false, VITE_USE_EMULATORS: "false", VITE_FIREBASE_API_KEY: "synthetic-emulator-key",
    VITE_FIREBASE_AUTH_DOMAIN: `${project}.firebaseapp.com`, VITE_FIREBASE_PROJECT_ID: project,
    VITE_FIREBASE_APP_ID: appId, VITE_FIREBASE_EXPECTED_DEV_APP_ID: development ? appId : undefined,
    VITE_CMS_DEPLOYMENT_ENVIRONMENT: target.environment, VITE_FUNCTIONS_BASE_URL: await clientApiOrigin(source) };
  await build({ stdin: { resolveDir: source, contents: `
    export * from './admin/src/lib/functions.ts';
    export * from './admin/src/lib/content-save-request.ts';
    export {SiteNavigationSettings} from './admin/src/components/SiteNavigationSettings.tsx';
    export {PublicSiteChromeSettings} from './admin/src/components/PublicSiteChromeSettings.tsx';
    export {PublicHomepageBannerSettings} from './admin/src/components/PublicHomepageBannerSettings.tsx';
    export {NjDecidesSettings} from './admin/src/components/NjDecidesSettings.tsx';
    export {CoverageLabelsSettings, DEFAULT_COVERAGE_LABELS} from './admin/src/components/CoverageLabelsSettings.tsx';
    export * from './admin/src/lib/control-presentation-store.ts';
    export * from './admin/src/lib/home-shortcuts-store.ts';
    export * from './admin/src/lib/media-collection-pins-store.ts';
    export * from './admin/src/lib/saved-content-view-store.ts';
    export * from './admin/src/lib/saved-media-view-store.ts';
    export {editorLockClient} from './admin/src/lib/editor-lock-store.ts';
    export {createBlock} from './admin/src/lib/block-factory.ts';
  ` }, outfile: file, bundle: true, platform: "node", format: "esm", target: "node22", packages: "external",
    loader: { ".css": "empty", ".svg": "dataurl" }, jsx: "automatic",
    define: { "import.meta.env": JSON.stringify(env), __ADMIN_BUILD_REVISION__: JSON.stringify(revision) } });
  return import(/* @vite-ignore */ pathToFileURL(file).href);
}

async function bundleReader(source: string, name = "reader") {
  const file = join(scratch, `${name}.mjs`);
  await build({ stdin: { resolveDir: source, contents: `
    export {projectPublishedPostRead, projectChrome} from './site/src/lib/published-post-shadow.ts';
    export {projectPublishedPageRead} from './site/src/lib/published-page-render.ts';
    export {projectPublicPageContextRead} from './site/src/lib/public-page-context-render.ts';
  ` }, outfile: file, bundle: true, platform: "node", format: "esm", target: "node22", packages: "external" });
  return import(/* @vite-ignore */ pathToFileURL(file).href);
}

async function signedToken(uid = actorId) {
  const credential = await adminAuth(app).createCustomToken(uid);
  const response = await nativeFetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=synthetic`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: credential, returnSecureToken: true }),
  });
  if (!response.ok) throw new Error("Synthetic emulator sign-in failed");
  return (await response.json()).idToken;
}

async function serve() {
  const settings = native("./functions/settings.js"), preview = native("./functions/preview.js"), save = native("./functions/save.js"), publish = native("./functions/publish.js");
  const handlers: Record<string, any> = {
    cmsGetSettings: settings.createCmsGetSettingsHandler({ firestore: db, log: quiet }),
    cmsGetCoverageLabels: settings.createCmsGetCoverageLabelsHandler({ firestore: db, log: quiet }),
    cmsSaveSettings: settings.createCmsSaveSettingsHandler({ firestore: db, log: quiet }),
    cmsPublishSettings: settings.createCmsPublishSettingsHandler({ firestore: db, log: quiet }),
    cmsPreview: preview.createCmsPreviewHandler({ firestore: db, log: quiet }),
    cmsPreviewStatus: preview.createCmsPreviewStatusHandler({ firestore: db, log: quiet }),
    cmsSaveContent: save.createCmsSaveHandler({ firestore: db, log: quiet, enablePublishSnapshot: true, assertPublishReadyFn: publish.assertPublishReady }),
    cmsTransitionContent: native("./functions/lifecycle-transition.js").createCmsTransitionContentHandler({ firestore: db, log: quiet }),
  };
  const { withCmsEdge } = native("./functions/lib/cms-edge.js");
  server = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const rawBody = Buffer.concat(chunks);
      const body = JSON.parse(rawBody.toString("utf8"));
      const endpoint = new URL(request.url!, "http://127.0.0.1").pathname.split("/").at(-1)!;
      if (!handlers[endpoint]) { response.statusCode = 404; response.end(); return; }
      requests.push({ endpoint, body, candidate: request.headers["x-njpbs-contract-probe"] === "C1" });
      const reply = { get headersSent() { return response.headersSent; }, get statusCode() { return response.statusCode; },
        set(key: string, value: string) { response.setHeader(key, value); return this; },
        status(code: number) { response.statusCode = code; return this; },
        json(value: unknown) { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(value)); return this; } };
      const run = withCmsEdge(handlers[endpoint], { readSecret: () => "local-cms-edge-only", logger: quiet });
      await run({ method: request.method, headers: request.headers, body, rawBody, ip: "127.0.0.1" }, reply);
    } catch { response.statusCode = 500; response.end('{"error":"Emulator contract request failed"}'); }
  });
  await new Promise<void>(accept => server.listen(0, "127.0.0.1", accept));
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
}

async function seed() {
  const base = native("./functions/lib/public-deployment.js").initialPublicDeploymentPointer();
  initialRoot = { ...base, activeGeneration: 1, activeCommitSha: rendererSha, activeDeploymentId: "contract-original-worker",
    lastReservedGeneration: 1, newestEligibleGeneration: 1, newestEligibleBuildBatchId: "contract-original", mediaLifecycleReady: true };
  await db.doc("system/publicDeployment").set(initialRoot);
  await db.doc("system/publicDeployment/contexts/public").set({ schemaVersion: 1, revision: 1 });
  await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: "ready", commitSha: rendererSha, serializerId: "node-compute",
    cloud: { phase: "ready", commitSha: rendererSha, serializerId: target.serializerId } });
  await db.doc("system/cmsPreviewRuntime").set({ schemaVersion: 1, phase: "ready", rendererSha, serializerId: "cloudflare-preview" });
  await db.doc("system/noBuildPostAdmission").set({ schemaVersion: 2, enabled: true, revision: 1,
    families: { posts: { mode: "all" }, pages: { mode: "all" } }, backgroundBucket: target.backgroundBucket });
  const document = { ...structuredClone(postFixture.document.published.metadata), ...structuredClone(postFixture.document), type: "post", version: 8, status: "approved", createdBy: actorId,
    section: "news", slug: "shadow-fixture", tags: [], categories: [], credits: [], blocks: postFixture.document.published.blocks };
  await db.doc("cmsPosts/shadow-fixture").set(document);
  await db.doc("sections/news").set({ label: "News" });
  await db.doc("system/publicDeployment/noBuildPostOwners/shadow-fixture").set({ schemaVersion: 1, postId: "shadow-fixture", rendererSha,
    servingEnabled: true, generation: 1, operationId: "P".repeat(20), sourceVersion: 7, slug: "shadow-fixture", visible: true, ownedSlugs: ["shadow-fixture"],
    snapshotDigest: native("./functions/lib/no-build-page-ownership.js").digest(document.published) });
  await db.doc("system/publicDeployment/noBuildPosts/capability").set({ schemaVersion: 2, rendererSha, servingEnabled: true, generation: 1 });
  await db.doc(`cmsPublishQueue/${"P".repeat(20)}`).set({ transport: "post-no-build-v1", status: "success" });
  await db.doc("system/publicDeployment/noBuildPages/capability").set({ schemaVersion: 1, rendererSha, servingEnabled: true, generation: 1,
    terminalOwner: { schemaVersion: 1, transport: "page-no-build-v1", rendererSha } });
  const page = { id: "contact", version: 7, title: "Contact fixture", blocks: [], status: "draft", template: "genericPage" };
  await db.doc("cmsPages/contact").set({ ...page, publiclyVisible: true, published: native("./functions/lib/publish-snapshot.js").createPublishedSnapshot({
    collection: "cmsPages", document: page, publishedAt: "2026-10-07T12:00:00.000Z", publishedBy: actorId }) });
  const values = { "site-navigation": DEFAULT_SITE_NAVIGATION, "public-site-chrome": DEFAULT_PUBLIC_SITE_CHROME_SETTINGS,
    "public-homepage-banner": DEFAULT_PUBLIC_HOMEPAGE_BANNER_SETTINGS, "nj-decides-brand": DEFAULT_NJ_DECIDES_SETTINGS,
    "coverage-labels": c0Client.DEFAULT_COVERAGE_LABELS };
  const schemas = native("./functions/lib/cms-settings-contract.js");
  for (const id of CONTRACT_SETTINGS) {
    await db.doc(`cmsSettings/${id}`).set({ schemaVersion: schemas.currentCmsSettingsSchemaFor(id).schemaVersion,
      values: structuredClone(values[id as keyof typeof values]), version: 1 });
  }
  await db.doc(`users/${actorId}`).set({ role: "admin", active: true, email: `${actorId}@example.test` });
}

async function nativePost() {
  return db.runTransaction(transaction => native("./functions/lib/no-build-post-publication.js").readNoBuildPostDecisionInTransaction({
    firestore: db, transaction, path: `/posts/${postSlug}/`, rendererSha }), { readOnly: true });
}
async function renderAcceptedPost() {
  const reply = await nativePost();
  expect(reply.kind).toBe("post");
  const content = reader.projectPublishedPostRead(reply.published, postSlug, rendererSha, new Date());
  expect(content).not.toBeNull();
  const html = await compiled.renderPublishedPost(content);
  expect(html).toContain("<main");
  return { reply, content, html };
}
function record(feature: string, writer: string, nativeValue: unknown, rendered: string, extra = {}) {
  if (apiReplies[feature]) apiReplies[feature].push({ writer, value: nativeValue });
  evidence.push({ feature, writer, passed: true, nativeDigest: contractDigest(nativeValue), renderedDigest: contractDigest(rendered), ...extra });
}

beforeAll(async () => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "")) throw new Error("Local Firestore emulator is required");
  scratch = await mkdtemp(join(tmpdir(), "cms-contract-corpus-"));
  await symlink(join(root, "node_modules"), join(scratch, "node_modules"));
  if (inputs) {
    invocation = JSON.parse(await readFile(join(inputs, "invocation.json"), "utf8"));
    capsule = JSON.parse(await readFile(join(inputs, "capsule.json"), "utf8"));
    ({ candidateSha, baselineSha, rendererSha } = invocation);
    c0 = join(inputs, "C0"); c1 = join(inputs, "C1"); rSource = join(inputs, "R-source"); artifact = join(inputs, "R-artifact/renderer");
    target = createRequire(import.meta.url)("../../functions/lib/publication-target.js").publicationTarget(capsule.identity.environment);
    postSlug = /^\/posts\/([^/]+)\/$/.exec(capsule.requests.postChrome.path)![1];
    const owner = capsule.documents.find((row: any) => row.path.startsWith("system/publicDeployment/noBuildPostOwners/") &&
      row.data && decodeContractValue(row.data, { Timestamp }).slug === postSlug);
    if (!owner) throw new Error("Captured Post owner is unavailable");
    postId = decodeContractValue(owner.data, { Timestamp }).postId;
    pageId = capsule.requests.capabilities.path === "/" ? "home" : capsule.requests.capabilities.path.split("/")[1];
  } else {
    const { stdout } = await execute("git", ["rev-parse", "HEAD"], { cwd: root });
    baselineSha = rendererSha = stdout.trim();
    c0 = join(scratch, "C0"); c1 = join(scratch, "C1"); rSource = c0;
    await localClone(c0, baselineSha); await localClone(c1, baselineSha);
    const file = join(c1, "admin/src/lib/functions.ts");
    const original = await readFile(file, "utf8");
    const changed = original.replace('"Content-Type": "application/json",', '"Content-Type": "application/json",\n          "x-njpbs-contract-probe": "C1",');
    if (changed === original) throw new Error("Candidate request fixture source unavailable");
    await writeFile(file, changed);
    await execute("git", ["add", "admin/src/lib/functions.ts"], { cwd: c1 });
    await execute("git", ["-c", "user.name=Contract fixture", "-c", "user.email=contract@example.test", "commit", "--quiet", "-m", "Exercise a candidate Admin request"], { cwd: c1 });
    candidateSha = (await execute("git", ["rev-parse", "HEAD"], { cwd: c1 })).stdout.trim();
    target = createRequire(import.meta.url)("../../functions/lib/publication-target.js").publicationTarget("development");
    await execute(process.execPath, ["--import", join(c0, "site/node_modules/tsx/dist/loader.mjs"), join(c0, "site/scripts/build-public-post-renderer.ts"), "--test-pages"],
      { cwd: c0, timeout: 90_000, maxBuffer: 8 * 1024 * 1024 });
    artifact = join(c0, "site/.public-page-renderer");
    await compareContractInputs({ candidateSha, baselineSha, cwd: c1 });
    const older = join(scratch, "R-without-banner-four");
    await localClone(older, baselineSha);
    const schemaFile = join(older, "packages/content-core/src/cms-settings.ts");
    const schema = await readFile(schemaFile, "utf8");
    const needle = "): CmsSettingsSchema | null {\n  if (!positiveVersion(schemaVersion))";
    if (!schema.includes(needle)) throw new Error("Native renderer schema fixture unavailable");
    // A genuine fixture commit/build models R without banner v4. C0 and C1
    // retain identical full backend inputs; no module or successful reply is mocked.
    await writeFile(schemaFile, schema.replace(needle, "): CmsSettingsSchema | null {\n  if (documentId === PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID && schemaVersion === 4) return null;\n  if (!positiveVersion(schemaVersion))"));
    await execute("git", ["add", "packages/content-core/src/cms-settings.ts"], { cwd: older });
    await execute("git", ["-c", "user.name=Contract fixture", "-c", "user.email=contract@example.test", "commit", "--quiet", "-m", "Model a renderer without banner four"], { cwd: older });
    unsupportedSha = (await execute("git", ["rev-parse", "HEAD"], { cwd: older })).stdout.trim();
    await execute(process.execPath, ["--import", join(older, "site/node_modules/tsx/dist/loader.mjs"), join(older, "site/scripts/build-public-post-renderer.ts"), "--test-pages"],
      { cwd: older, timeout: 90_000, maxBuffer: 8 * 1024 * 1024 });
    unsupportedReader = await bundleReader(older, "unsupported-reader");
    unsupportedArtifact = await import(/* @vite-ignore */ pathToFileURL(join(older, "site/.public-page-renderer/server/entry.mjs")).href);
    expect(unsupportedArtifact.rendererSha).toBe(unsupportedSha);
  }
  if (!/^[a-f0-9]{40}$/.test(candidateSha) || !/^[a-f0-9]{40}$/.test(rendererSha)) throw new Error("Exact source revisions are required");
  const apiOrigins = new Set(await Promise.all([c0, c1].map(clientApiOrigin)));
  nativeFetch = globalThis.fetch;
  const { createApp } = createRequire(import.meta.url)("firebase-tools/lib/emulator/auth/server.js");
  const authApp = await createApp(target.projectId);
  authServer = await new Promise<Server>(accept => { const listening = authApp.listen(0, "127.0.0.1", () => accept(listening)); });
  priorAuthHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  process.env.FIREBASE_AUTH_EMULATOR_HOST = `127.0.0.1:${(authServer.address() as any).port}`;
  process.env.GCLOUD_PROJECT = target.projectId;
  process.env.GOOGLE_CLOUD_PROJECT = target.projectId;
  process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: target.projectId });
  process.env.CMS_DEPLOYMENT_ENVIRONMENT = target.environment;
  process.env.CMS_PUBLISH_TRANSPORT = "serializer";
  process.env.CMS_WRITEBACK_CONFIGURED = "true";
  process.env.CMS_PREVIEW_TRANSPORT = "serializer";
  process.env.CMS_PREVIEW_SERIALIZER_READY = "true";
  process.env.CMS_PREVIEW_RENDERER_SHA = rendererSha;
  if (adminApps().length) throw new Error("Contract corpus requires an isolated Admin SDK process");
  app = initializeAdmin({ projectId: target.projectId });
  native = createRequire(join(c1, "package.json"));
  const handlerFirebase = native("./functions/lib/firebase.js");
  handlerApp = handlerFirebase.app; db = handlerFirebase.db;
  Timestamp = native("firebase-admin/firestore").Timestamp;
  actorId = `contract-${randomUUID()}`;
  await adminAuth(app).createUser({ uid: actorId, email: `${actorId}@example.test`, emailVerified: true });
  token = await signedToken();
  await adminAuth(app).verifyIdToken(token, true);
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://127.0.0.1/", pretendToBeVisual: true });
  for (const name of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "MutationObserver", "Event", "MouseEvent", "getComputedStyle", "localStorage"])
    rememberGlobal(name, (dom.window as any)[name]);
  rememberGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  React = await import("react"); ui = await import("@testing-library/react");
  client = initializeClient({ apiKey: "synthetic-emulator-key", projectId: target.projectId, authDomain: `${target.projectId}.firebaseapp.com`, appId: "synthetic-emulator-app" });
  connectAuthEmulator(getAuth(client), `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`, { disableWarnings: true });
  clientDb = clientFirestore(client);
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST!.split(":");
  connectFirestoreEmulator(clientDb, host, Number(port));
  await signInWithCustomToken(getAuth(client), await adminAuth(app).createCustomToken(actorId));
  await serve();
  if (handlerFirebase.db.projectId !== target.projectId) throw new Error("handler-project-mismatch");
  try { await handlerFirebase.admin.auth().verifyIdToken(token, true); }
  catch (error: any) {
    const code = ["auth/argument-error", "auth/invalid-id-token", "auth/id-token-revoked", "auth/internal-error", "app/invalid-credential"].includes(error?.code) ? error.code : "unknown";
    throw new Error(`handler-auth-refused:${code}`);
  }
  rememberGlobal("fetch", async (url: any, init?: any) => {
    const selected = new URL(typeof url === "string" ? url : url.url ?? String(url));
    if (apiOrigins.has(selected.origin)) {
      return nativeFetch(`${origin}${selected.pathname}`, { ...init, headers: { ...init?.headers, "x-njpbs-cms-edge": "local-cms-edge-only" } });
    }
    if (selected.hostname !== "127.0.0.1" && selected.hostname !== "localhost") throw new Error("External network is forbidden in the contract corpus");
    return nativeFetch(url, init);
  });
  c0Client = await bundleClient(c0, baselineSha, "client-C0"); c1Client = await bundleClient(c1, candidateSha, "client-C1");
  await discoverAdminWrites({ candidateRoot: c1, baselineRoot: c0 });
  reader = await bundleReader(rSource);
  compiled = await import(/* @vite-ignore */ pathToFileURL(join(artifact, "server/entry.mjs")).href);
  expect(compiled.rendererSha).toBe(rendererSha);
}, 120_000);

beforeEach(async () => {
  requests = [];
  const response = await nativeFetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${target.projectId}/databases/(default)/documents`, { method: "DELETE" });
  if (!response.ok) throw new Error("Could not clear the isolated contract database");
  if (capsule) {
    for (const row of capsule.documents) if (row.data !== null) await db.doc(row.path).set(decodeContractValue(row.data, { Timestamp }));
    initialRoot = (await db.doc("system/publicDeployment").get()).data();
    await db.doc(`users/${actorId}`).set({ role: "admin", active: true, email: `${actorId}@example.test` });
  } else await seed();
});
afterEach(() => { ui?.cleanup(); });
afterAll(async () => {
  if (process.env.CMS_PUBLIC_CONTRACT_API_REPLIES) await writeFile(process.env.CMS_PUBLIC_CONTRACT_API_REPLIES, JSON.stringify(apiReplies), { mode: 0o600 });
  if (process.env.CMS_PUBLIC_CONTRACT_RESULT) await writeFile(process.env.CMS_PUBLIC_CONTRACT_RESULT, JSON.stringify({ schemaVersion: 1,
    ...invocation, cases: evidence }), { mode: 0o600 });
  if (server) await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()));
  if (clientDb) await terminate(clientDb); if (client) await deleteClient(client);
  if (handlerApp && handlerApp !== app) await native("firebase-admin/app").deleteApp(handlerApp);
  if (app) await deleteAdmin(app);
  if (authServer) await new Promise<void>((accept, reject) => authServer.close(error => error ? reject(error) : accept()));
  if (priorAuthHost === undefined) delete process.env.FIREBASE_AUTH_EMULATOR_HOST; else process.env.FIREBASE_AUTH_EMULATOR_HOST = priorAuthHost;
  dom?.window.close();
  for (const [name, descriptor] of globals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete (globalThis as any)[name]; }
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

it("executes a CMS-ahead C1 publication, R rendering and a real C0 write afterward without moving public authority", async () => {
  if (!inputs) await expect(execute("git", ["merge-base", "--is-ancestor", candidateSha, rendererSha], { cwd: c1 })).rejects.toBeDefined();
  const publishSaved = async (client: any, title: string) => {
    let document = (await db.doc(`cmsPosts/${postId}`).get()).data()!;
    if (document.status !== "draft") {
      await client.cmsTransitionContent(token, { collection: "cmsPosts", id: postId, baseVersion: document.version, action: "edit" });
      document = (await db.doc(`cmsPosts/${postId}`).get()).data()!;
    }
    const request = client.recordSaveRequest("post", { id: postId, version: document.version, section: document.section, slug: document.slug,
      title, date: document.date, categories: document.categories ?? [], tags: document.tags ?? [], credits: document.credits ?? [], blocks: document.blocks ?? [] });
    await client.cmsSaveContent(token, request);
    const saved = (await db.doc(`cmsPosts/${postId}`).get()).data()!;
    await client.cmsSaveContent(token, { collection: "cmsPosts", id: postId, baseVersion: saved.version, document: {}, publish: true });
  };
  await publishSaved(c1Client, "Route D accepted content");
  const first = await renderAcceptedPost();
  expect(first.html).toContain("Route D accepted content");
  await publishSaved(c0Client, "Route D prior CMS");
  const second = await renderAcceptedPost();
  expect(second.html).toContain("Route D prior CMS");
  expect((await db.doc("system/publicDeployment").get()).data()).toEqual(initialRoot);
  expect((await db.doc("system/cmsPreviewRuntime").get()).data().phase).toBe("ready");
  record("postChrome", "C1", first.reply, first.html); record("postChrome", "C0-after-C1", second.reply, second.html);
});

it.each(CONTRACT_SETTINGS)("runs real C1 settings publication and a C0 read/write afterward through R: %s", async id => {
  for (const [writer, client] of [["C1", c1Client], ["C0-after-C1", c0Client]] as const) {
    if (writer === "C0-after-C1") {
      const read = await client.cmsGetSettings(token, { id });
      expect(read.settings.version).toBeGreaterThan(1);
    }
    const names = { "site-navigation": "SiteNavigationSettings", "public-site-chrome": "PublicSiteChromeSettings",
      "public-homepage-banner": "PublicHomepageBannerSettings", "nj-decides-brand": "NjDecidesSettings", "coverage-labels": "CoverageLabelsSettings" };
    const transport = { load: () => client.cmsGetSettings(token, { id }), save: (request: unknown) => client.cmsSaveSettings(token, request),
      publish: (request: unknown) => client.cmsPublishSettings(token, request), loadPages: async () => [] };
    const mounted = ui.render(React.createElement(client[names[id as keyof typeof names]], transport));
    const save = await ui.waitFor(() => ui.within(mounted.container).getByRole("button", { name: "Save draft" }));
    if (id === "site-navigation") {
      const edit = ui.within(mounted.container).getAllByRole("button", { name: /^Edit / })[0];
      ui.fireEvent.click(edit);
      ui.fireEvent.change(ui.within(mounted.container).getByLabelText("Label"), { target: { value: `Route D ${writer} navigation` } });
    } else if (id === "nj-decides-brand") ui.fireEvent.click(ui.within(mounted.container).getByLabelText("Show the diagonal flag"));
    else {
      const field = id === "public-site-chrome" ? mounted.container.querySelector("#public-newsletter-label") :
        id === "public-homepage-banner" ? mounted.container.querySelector("#public-banner-message") : ui.within(mounted.container).getByLabelText("Name");
      ui.fireEvent.change(field, { target: { value: `Route D ${writer} public value` } });
    }
    const priorVersion = (await db.doc(`cmsSettings/${id}`).get()).data()!.version;
    await ui.waitFor(() => expect(save.disabled).toBe(false)); ui.fireEvent.click(save);
    await ui.waitFor(async () => expect((await db.doc(`cmsSettings/${id}`).get()).data()?.version).toBeGreaterThan(priorVersion));
    const savedVersion = (await db.doc(`cmsSettings/${id}`).get()).data()!.version;
    const publish = ui.within(mounted.container).getByRole("button", { name: "Publish", exact: true });
    await ui.waitFor(() => expect(publish.disabled).toBe(false)); ui.fireEvent.click(publish);
    await ui.waitFor(async () => expect((await db.doc(`cmsSettings/${id}`).get()).data()?.published?.sourceVersion).toBe(savedVersion));
    const document = (await db.doc(`cmsSettings/${id}`).get()).data()!;
    const nativeReply = native("./functions/lib/cms-published-settings-reply.js").publishedSettingsReply({ id, document });
    expect(nativeReply.found).toBe(true); expect(nativeReply.published.sourceVersion).toBe(document.published.sourceVersion);
    const rendered = await renderAcceptedPost();
    expect(rendered.content.settings.some((row: any) => row.settingId === id)).toBe(true);
    if (id !== "nj-decides-brand") expect(JSON.stringify(rendered.content.settings)).toContain(`Route D ${writer}`);
    record("settings", writer, nativeReply, rendered.html, { settingId: id });
    ui.cleanup();
  }
});

// Fixture-identity acceptance is a separate mode from the sealed live corpus:
// it builds its own incompatible R and never substitutes it for a live archive.
if (!inputs) it("refuses accepted C1 banner output only at R semantics while C1/C0 backend inputs stay equal", async () => {
  const mounted = ui.render(React.createElement(c1Client.PublicHomepageBannerSettings, {
    load: () => c1Client.cmsGetSettings(token, { id: "public-homepage-banner" }),
    save: (request: unknown) => c1Client.cmsSaveSettings(token, request), publish: (request: unknown) => c1Client.cmsPublishSettings(token, request),
  }));
  const save = await ui.waitFor(() => ui.within(mounted.container).getByRole("button", { name: "Save draft" }));
  ui.fireEvent.change(mounted.container.querySelector("#public-banner-message"), { target: { value: "Accepted candidate banner" } });
  await ui.waitFor(() => expect(save.disabled).toBe(false)); ui.fireEvent.click(save);
  const publish = ui.within(mounted.container).getByRole("button", { name: "Publish", exact: true });
  await ui.waitFor(() => expect(publish.disabled).toBe(false)); ui.fireEvent.click(publish);
  await ui.waitFor(async () => expect((await db.doc("cmsSettings/public-homepage-banner").get()).data()?.published?.schemaVersion).toBe(4));
  const accepted = await nativePost();
  expect(accepted.kind).toBe("post");
  expect(accepted.published.settings.find((row: any) => row.id === "public-homepage-banner").published.values.message).toBe("Accepted candidate banner");
  expect(() => unsupportedReader.projectPublishedPostRead(accepted.published, postSlug, unsupportedSha, new Date())).toThrow();
});

async function capturedFixture() {
  const selected = capsule?.requests.previewRequest ?? { collection: "cmsPages", pageId };
  const saved = (await db.doc(`${selected.collection}/${selected.pageId}`).get()).data()!;
  const preview = native("./functions/preview.js");
  const admitted = await preview.enqueuePreview({ actor: { uid: actorId, principal: { id: actorId, grants: [{ role: "admin" }] } },
    ...selected, persistent: true, sourceVersion: saved.version }, { firestore: db, getTransport: () => "serializer", serializerReady: () => true,
    getRendererSha: () => capsule?.identity.backend.previewRendererSha ?? rendererSha });
  // Same documented renderer-completion boundary as the existing retained-read
  // fixture. The native admission above owns the queue and frozen source.
  await db.doc(`cmsPreviewQueue/${admitted.queueId}`).update({ status: "ready", completedAt: Timestamp.now(),
    previewUrl: `https://preview.example.test/p/${admitted.queueId}/` });
  const head = native("./functions/lib/preview-target.js").previewContentKey(selected.collection, selected.pageId);
  await db.doc(`cmsPreviewHeads/${head}`).set({ ...selected, readyQueueId: admitted.queueId, latestQueueId: admitted.queueId });
  const identity = capsule?.identity ?? { publicReader: { rendererSha, codeGeneration: 1 }, backend: { previewRendererSha: rendererSha } };
  const requests = capsule?.requests ?? { settings: [...CONTRACT_SETTINGS], postChrome: { path: `/posts/${postSlug}/`, rendererSha },
    capabilities: { path: `/${pageId}/`, rendererSha }, previewRequest: selected };
  return { identity, requests, admitted };
}

it("captures native replies with server read-only transactions, query absence and complete source rows", async () => {
  const fixture = await capturedFixture();
  const captureApp = initializeAdmin({ projectId: target.projectId }, `capture-${randomUUID()}`);
  const captureDb = getFirestore(captureApp);
  const original = new Map<string, any>();
  // Native modules have the first/default SDK app. Any accidental database use
  // outside the supplied recorded facade must fail this proof.
  for (const name of ["doc", "collection", "runTransaction", "getAll"]) {
    original.set(name, (db as any)[name]);
    (db as any)[name] = () => { throw new Error("Default-app database request is forbidden"); };
  }
  let captured: any;
  try {
    captured = await captureNativeContract({ firestore: captureDb, baselineRoot: c0, target: contractTarget(target.environment), ...fixture });
  } finally {
    for (const [name, method] of original) (db as any)[name] = method;
    await deleteAdmin(captureApp);
  }
  expect(JSON.parse(captured.replies.postChrome).kind).toBe("post");
  expect(JSON.parse(captured.replies.previewRequest).ready.status).toBe("ready");
  expect(captured.documents.some((row: any) => row.path === `cmsPosts/${postId}`)).toBe(true);
  expect(captured.documents.some((row: any) => row.path === "system/cmsPublicationRuntime")).toBe(true);
  const owner = (await db.doc(`system/publicDeployment/noBuildPostOwners/${postId}`).get()).data()!;
  expect(captured.documents.some((row: any) => row.path === `cmsPublishQueue/${owner.operationId}`)).toBe(true);
  expect(captured.readset.some((row: any) => row.target.kind === "query")).toBe(true);
  expect(captured.readset.some((row: any) => row.target.kind === "document" && row.digest === native("./functions/lib/public-release-pair.js").publicReleaseDigest(null))).toBe(true);
  const before = contractDigest(captured.readset);
  await db.doc("system/publicDeployment/noBuildPostOwners/competing-contract").set({ ...owner, postId: "competing-contract" });
  await expect(captureNativeContract({ firestore: db, baselineRoot: c0, target: contractTarget(target.environment), ...fixture })).rejects.toThrow();
  expect(contractDigest(captured.readset)).toBe(before);
});

it("refuses missing current capability and a saved preview that expires at recapture", async () => {
  const fixture = await capturedFixture();
  const capability = (await db.doc("system/publicDeployment/noBuildPosts/capability").get()).data()!;
  await db.doc("system/publicDeployment/noBuildPosts/capability").delete();
  await expect(captureNativeContract({ firestore: db, baselineRoot: c0, target: contractTarget(target.environment), ...fixture })).rejects.toMatchObject({ code: "capability-unavailable" });
  await db.doc("system/publicDeployment/noBuildPosts/capability").set(capability);
  const fresh = await capturedFixture();
  await db.doc(`cmsPreviewQueue/${fresh.admitted.queueId}`).update({ expiresAt: Timestamp.fromMillis(Date.now() - 1) });
  await expect(captureNativeContract({ firestore: db, baselineRoot: c0, target: contractTarget(target.environment), ...fresh })).rejects.toMatchObject({ code: "preview-unavailable" });
});

it("preserves real staff permissions and revocation instead of accepting an old tab's token blindly", async () => {
  await db.doc(`users/${actorId}`).update({ tokensValidAfter: Math.floor(Date.now() / 1000) });
  await expect(c0Client.cmsGetSettings(token, { id: "public-site-chrome" })).rejects.toMatchObject({ status: 401 });
  await expect(c1Client.cmsGetSettings(token, { id: "public-site-chrome" })).rejects.toMatchObject({ status: 401 });
  record("adminSession", "C0", { refused: 401 }, "revoked"); record("adminSession", "C1", { refused: 401 }, "revoked");
});

it("uses the real Firebase client SDK and unchanged rules to refuse direct public-settings writes", async () => {
  await expect(updateDoc(doc(clientDb, "cmsSettings/public-site-chrome"), { "values.newsletterLabel": "Unadmitted direct write" })).rejects.toBeDefined();
  expect((await db.doc("cmsSettings/public-site-chrome").get()).data()!.values.newsletterLabel).not.toBe("Unadmitted direct write");
});

it("refuses invalid known settings rather than treating native omission as reader compatibility", async () => {
  const source = { ...chromeSettings()[0], published: { schemaVersion: 1, sourceVersion: 0, values: {} } };
  const result = native("./functions/lib/cms-published-settings-reply.js").publishedSettingsReply({ id: source.id, document: source });
  expect(result.found).toBe(false);
  expect(() => reader.projectChrome({ settings: [source] })).toThrow();
});

it("publishes a candidate Page save, then reads capability markers and its native content rather than a fallback success", async () => {
  // C1 composes the save with the Admin's own Page request builder, as ContentTab.savePage does.
  const marker = "Route D candidate Page";
  let current = (await db.doc(`cmsPages/${pageId}`).get()).data()!;
  if (current.status !== "draft") {
    await c1Client.cmsTransitionContent(token, { collection: "cmsPages", id: pageId, baseVersion: current.version, action: "edit" });
    current = (await db.doc(`cmsPages/${pageId}`).get()).data()!;
  }
  const storedPage = c1Client.storedPageContentFromDocument(pageId, current);
  const headline = { ...c1Client.createBlock("headline", "route-d-candidate-headline", storedPage.blocks.length), data: { text: marker } };
  const saved = await c1Client.cmsSaveContent(token, c1Client.pageBlocksSaveRequest({ pageId, section: current.template, storedPage,
    blocks: [...storedPage.blocks, headline], enforcePublicPageOwnership: true, baseVersion: current.version }));
  await c1Client.cmsSaveContent(token, { collection: "cmsPages", id: pageId, baseVersion: saved.document.version, document: {}, publish: true });
  const result = await db.runTransaction(transaction => native("./functions/lib/no-build-page-serving.js").readNoBuildPageDecisionInTransaction({
    firestore: db, transaction, path: `/${pageId}/`, rendererSha, target }), { readOnly: true });
  expect(["page", "context-page"]).toContain(result.kind);
  const content = result.kind === "context-page" ? await reader.projectPublicPageContextRead(result.renderContext, rendererSha, new Date()) :
    await reader.projectPublishedPageRead(result.published, pageId, rendererSha, new Date());
  const html = result.kind === "context-page" ? await compiled.renderPublicPageContext(content) : await compiled.renderPublishedPage(content);
  expect(html).toContain("<main");
  expect(html).toContain(marker);
  record("capabilities", "C1", result, html);
});

it("executes discovered direct SDK preference writers through unchanged real rules for C1 and C0", async () => {
  const before = (await db.doc("system/publicDeployment").get()).data();
  for (const client of [c1Client, c0Client]) {
    await client.saveControlPresentation(actorId, "text");
    await client.saveHomeShortcuts(actorId, null);
    await client.saveMediaCollectionPin(actorId, "contract-collection", true);
    await client.mutateContentLibraryViews(actorId, { type: "delete", id: "contract-view" });
    await client.mutateMediaLibraryViews(actorId, { type: "delete", id: "contract-view" });
    const session = "contract-session-0123456789";
    const lock = await client.editorLockClient.claim(`cmsPosts:${postId}`, { id: actorId, name: "Contract staff" }, session);
    expect(lock.status).toBe("acquired");
    await client.editorLockClient.release(`cmsPosts:${postId}`, actorId, session);
  }
  expect((await db.doc("system/publicDeployment").get()).data()).toEqual(before);
});

it("keeps old and new saved-preview request and result contracts on the retained runtime", async () => {
  const selected = capsule?.requests.previewRequest ?? { collection: "cmsPages", pageId };
  const saved = (await db.doc(`${selected.collection}/${selected.pageId}`).get()).data()!;
  const first = await c1Client.cmsRequestSavedPreview(token, selected.collection, selected.pageId, saved.version);
  expect(first.success).toBe(true);
  const stored = (await db.doc(`cmsPreviewQueue/${first.queueId}`).get()).data()!;
  expect(stored.sourceVersion).toBe(saved.version);
  expect(stored.snapshot.version).toBe(saved.version);
  const previewSha = capsule?.identity.backend.previewRendererSha ?? rendererSha;
  expect(stored.rendererSha).toBe(previewSha);
  // The isolated corpus does not contact a provider. Only the renderer's
  // terminal callback is supplied at that external boundary; admission, frozen
  // source, client request, reuse and authenticated status remain native.
  await db.doc(`cmsPreviewQueue/${first.queueId}`).update({ status: "ready", previewUrl: `https://preview.example.test/p/${first.queueId}/` });
  const oldStatus = await c0Client.cmsLoadPagePreviewStatus(token, first.queueId);
  expect(oldStatus).toMatchObject({ status: "ready", sourceVersion: saved.version, rendererSha: previewSha });
  const reused = await c0Client.cmsRequestSavedPreview(token, selected.collection, selected.pageId, saved.version);
  expect(reused).toMatchObject({ queueId: first.queueId, status: "ready", reused: true });
  record("previewRequest", "C1", stored, JSON.stringify(oldStatus));
  record("previewRequest", "C0-after-C1", reused, JSON.stringify(oldStatus));
});

// The host acceptance case runs the actual sealed executor. The inner corpus
// receives inputs and must not recursively create another Docker boundary.
// Only the hosted functions-sealed CI job selects it; Functions shards run on fleet runners without Docker.
if (!inputs && process.env.CMS_PUBLIC_CONTRACT_SEALED === "1") it("replays a native captured capsule through sealed Docker and the real API RPC contract", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cms-contract-sealed-"));
  const previousTrusted = process.env.CMS_TRUSTED_WORKFLOW_SHA;
  try {
    process.env.CMS_TRUSTED_WORKFLOW_SHA = baselineSha;
    const closure = await compareContractInputs({ candidateSha, baselineSha, cwd: c1 });
    const fixture = await capturedFixture();
    const fingerprints = Object.entries(closure.graph.exports).map(([name, entry]: [string, any]) => ({
      name, state: "ACTIVE", revision: `fixture-${name}`, sourceSha: baselineSha, inputFingerprint: entry.fingerprint,
    }));
    const release = JSON.parse(await readFile(join(artifact, "renderer-release.json"), "utf8"));
    // Provider identities are explicit local fixtures. Capture, writes, native
    // reads, exact renderer bytes and RPC execution below are real local work.
    fixture.identity = contractIdentity({ priorAdminSha: baselineSha,
      publicReader: { worker: target.workerName, rendererSha, codeGeneration: 1, versionId: randomUUID(), percentage: 100,
        artifactDigest: contractDigest(release), checkpointDigest: contractDigest({ release }) },
      backend: { previewRendererSha: rendererSha, previewIdentityDigest: contractDigest({ rendererSha }),
        apiVersionId: randomUUID(), configurationFingerprint: contractDigest({ fixture: true }),
        expectedExports: fingerprints.map(row => row.name), functions: fingerprints } }, contractTarget(target.environment));
    const captured = await captureNativeContract({ firestore: db, baselineRoot: c0, target: contractTarget(target.environment), ...fixture });
    const archive = join(directory, "archive");
    await cp(artifact, join(archive, "renderer"), { recursive: true });
    const result = await replay({ capsule: captured, candidateSha, baselineSha, rendererSha, cwd: c1,
      directory, image: await prepareContractRuntime(join(directory, "runtime")), archive,
      signal: AbortSignal.timeout(60_000), dependencyRoots: { trusted: root, C0: root, C1: root, "R-source": root } });
    const summary = contractSummary({ candidateSha, identity: fixture.identity, capsuleDigest: contractDigest(captured),
      replay: result, capturedAt: captured.capturedAt });
    expect(summary.result).toBe("proved");
    expect(result.apiPassThroughDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(recheckContractSummary(summary, summary, { candidateSha, settlement: true })).toBe(summary);
  } catch (error) {
    const lines = (await readFile(join(directory, "replay.stderr"), "utf8").catch(() => "")).split("\n");
    for (const line of lines) {
      try {
        const diagnostic = JSON.parse(line);
        if (["sdk-replay-refused", "api-replay-refused"].includes(diagnostic.code) && Array.isArray(diagnostic.failedTests) &&
          diagnostic.failedTests.every((digest: unknown) => typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest))) {
          const counts = Array.isArray(diagnostic.counts) && diagnostic.counts.every((value: unknown) => value === null ||
            typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 100_000) ? diagnostic.counts : null;
          const kind = ["startup", "filesystem", "dependency", "timeout", "process", "test", "handler-project-mismatch",
            "handler-auth-refused:auth/argument-error", "handler-auth-refused:auth/invalid-id-token", "handler-auth-refused:auth/id-token-revoked",
            "handler-auth-refused:auth/internal-error", "handler-auth-refused:app/invalid-credential", "handler-auth-refused:unknown"].includes(diagnostic.failureKind) ? diagnostic.failureKind : "unknown";
          throw new Error(`${diagnostic.code}: ${kind} ${JSON.stringify(counts)} ${diagnostic.failedTests.join(",")}`, { cause: error });
        }
      } catch (diagnosticError) {
        if (diagnosticError instanceof SyntaxError) continue;
        throw diagnosticError;
      }
    }
    throw error;
  } finally {
    if (previousTrusted === undefined) delete process.env.CMS_TRUSTED_WORKFLOW_SHA;
    else process.env.CMS_TRUSTED_WORKFLOW_SHA = previousTrusted;
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
