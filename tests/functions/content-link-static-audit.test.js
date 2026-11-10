import { afterAll, beforeEach, expect, it } from "vitest";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { createHash } from "node:crypto";
import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import staticReturn from "../../functions/lib/no-build-post-static-return.js";
import recovery from "../../functions/lib/no-build-post-recovery.js";
import ownership from "../../functions/lib/no-build-post-ownership.js";
import save from "../../functions/save.js";
import { createNoBuildPostWorker } from "../../workers/src/no-build-post-worker";
const projectId = "demo-njpbs-extlink-static-audit";
const app = initializeApp({ projectId }, "extlink-static-audit");
const firestore = getFirestore(app);
const rendererSha = "a".repeat(40), oldUrl = "https://example.test/old", nextUrl = "https://example.test/current";
const body = "<!doctype html><html><body>Retained current article</body></html>";
const digest = createHash("sha256").update(body).digest("hex");
beforeEach(async () => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "")) throw new Error("Use a local demo Firestore emulator");
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${projectId}/databases/(default)/documents`, { method: "DELETE" });
  await firestore.doc("system/publicDeployment/contexts/public").set({ schemaVersion: 1, revision: 1 });
});
afterAll(() => deleteApp(app));
it.each([
  { mode: "normal", oldLink: oldUrl }, { mode: "custom", oldLink: oldUrl }, { mode: "custom", oldLink: undefined },
])("binds a static Post redirect to its current sealed publication ($mode, retained $oldLink)", async ({ mode, oldLink }) => {
  await firestore.doc("cmsPosts/story").set({ version: 2, publiclyVisible: true, published: {
    sourceVersion: 2, publishedAt: "2026-11-02T12:00:00.000Z", blocks: [], metadata: {
      type: "post", title: "Current story", slug: "story", previousSlugs: [], contentLinkMode: mode, contentLinkUrl: nextUrl,
    },
  } });
  const state = { schemaVersion: 1, postId: "story", operationId: "A".repeat(20), sourceVersion: 1,
    visible: true, slug: "story", ownedSlugs: ["story"], mode: "static", servingEnabled: false, generation: 1, rendererSha,
    ...(oldLink ? { contentRedirectUrl: oldLink } : {}) };
  const input = await firestore.runTransaction(transaction => staticReturn.currentStaticInput({ firestore, transaction, state }));
  state.staticProof = { ...input, files: ["/posts/story/", "/posts/", "/feeds/news.xml", "/api/v1/content.json", "/pagefind/pagefind.js",
    "/search/meaning-index.json", "/_publication.json", "/_content-status.json", "/sitemap.xml"].map(path => ({ path, bytes: Buffer.byteLength(body), digest })) };
  const getDecision = path => firestore.runTransaction(transaction => staticReturn.readStaticDecision({ firestore, transaction, state,
    pointer: { state: "idle", activeCommitSha: rendererSha }, rendererSha, path }));
  const reply = await getDecision("/posts/story/");
  expect(reply.receipt.contentRedirectUrl).toBe(mode === "custom" ? nextUrl : undefined);
  expect(reply.receipt.sourceVersion).toBe(2);
  const worker = createNoBuildPostWorker({ rendererSha, getDecision, render: async () => "unused",
    cache: { async match() {}, async put() {} }, fetchAsset: async () => new Response(body, { headers: { "content-type": "text/html" } }) });
  for (const method of ["GET", "HEAD"]) {
    const response = await worker.fetch(new Request("https://njpbs.org/posts/story/", { method }));
    expect(response.status).toBe(mode === "custom" ? 302 : 200);
    expect(response.headers.get("location")).toBe(mode === "custom" ? nextUrl : null);
    expect(await response.text()).toBe(method === "HEAD" || mode === "custom" ? "" : body);
  }
  await firestore.doc(`${ownership.OWNER_COLLECTION}/story`).set(state);
  const candidate = { commitSha: rendererSha, workerVersionId: "11111111-1111-4111-8111-111111111111", noBuildPost: { enabled: true } };
  const verify = fetchPublic => recovery.verifyNoBuildPostPublicRoute({ firestore, candidate, fetchPublic });
  await expect(verify((url, options) => worker.fetch(new Request(url, options)))).resolves.toBeUndefined();
  await expect(verify(async (url, options) => {
    const response = await worker.fetch(new Request(url, options));
    if (new URL(url).pathname !== "/posts/story/") return response;
    if (mode === "custom") { response.headers.set("location", oldUrl); return response; }
    await response.body?.cancel();
    return new Response(null, { status: 302, headers: { ...Object.fromEntries(response.headers), location: nextUrl } });
  })).rejects.toThrow("did not preserve");
  await firestore.doc("cmsPosts/story").update({ "published.metadata.contentLinkUrl": "https://example.test/unproved" });
  await expect(getDecision("/posts/story/")).rejects.toThrow("no longer matches");
});
it.each(["cmsPosts", "cmsPages"])("logs only real content-link changes when saving %s", async collection => {
  const id = collection === "cmsPosts" ? "story" : "contact";
  await firestore.doc("sections/station").set({ id: "station", label: "Station", order: 1 });
  const stored = { title: "Existing content", status: "draft", publiclyVisible: false, version: 1, createdBy: "editor", blocks: [],
    ...(collection === "cmsPosts" ? { type: "post", section: "station", slug: "story", previousSlugs: [], locale: "en-US", date: "2026-11-02", tags: [], categories: [] } : {}) };
  await firestore.doc(`${collection}/${id}`).set(stored);
  const handler = save.createCmsSaveHandler({ firestore,
    requirePrincipalFn: async () => ({ uid: "editor", email: "editor@example.test", principal: { id: "editor", grants: [{ role: "admin" }] } }) });
  const invoke = async (baseVersion, document) => {
    const res = { statusCode: null, body: null, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
    await handler({ method: "POST", headers: {}, body: { collection, id, baseVersion, document } }, res);
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    const logs = await firestore.collection("admin_logs").get();
    return logs.docs.map(row => row.data());
  };
  const defaults = { contentLinkMode: "normal", contentLinkUrl: "", contentLinkNewTab: true };
  let logs = await invoke(1, defaults);
  expect(logs).toHaveLength(1);
  expect(logs[0].before).not.toHaveProperty("contentLink");
  expect(logs[0].after).not.toHaveProperty("contentLink");
  await invoke(2, { ...defaults, contentLinkMode: "custom", contentLinkUrl: nextUrl });
  logs = (await firestore.collection("admin_logs").get()).docs.map(row => row.data());
  const changed = logs.find(row => row.after.contentLink?.mode === "custom");
  expect(changed).toMatchObject({ before: { contentLink: { mode: "normal", url: "", newTab: true } },
    after: { contentLink: { mode: "custom", url: nextUrl, newTab: true } } });
  await invoke(3, defaults);
  logs = (await firestore.collection("admin_logs").get()).docs.map(row => row.data());
  expect(logs.find(row => row.before?.contentLink?.mode === "custom")).toMatchObject({
    before: { contentLink: { mode: "custom", url: nextUrl, newTab: true } }, after: { contentLink: { mode: "normal", url: "", newTab: true } } });
});
