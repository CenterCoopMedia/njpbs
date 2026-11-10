import { beforeEach, expect, it } from "vitest";
import { isolatedFirestore, clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { seedSwitch } from "../helpers/public-release-switch.js";
import a from "../../functions/lib/public-release-admission.js";
import p from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";

import compatibility from "../../functions/lib/live-blog-compatibility.js";
import save from "../../functions/save.js";

// Direct live updates go through the schema-two pair publication request path
// exactly like a normal publish, including replay of a lost response.
const db = isolatedFirestore("live-blog-direct-update-pair.test.ts");
const firestore = new Proxy(db, { get(target, key) { if (key === "projectId") return "njpbs-site-dev";
  const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value; } });
const staff = (uid: string, grant: Record<string, unknown>) => ({ uid, email: `${uid}@example.test`, principal: { id: uid, grants: [grant] } });
const manager = staff("pair-manager", { role: "admin" });
const editor = staff("pair-editor", { tier: "editor" });
const contract = { schemaVersion: 2, families: ["posts", "pages", "programs", "events", "settings", "context"], features: ["liveBlogVersion:1"] };
const quiet = { info() {}, warn() {}, error(...args: unknown[]) { console.error(...args); } };
let time = "2026-11-03T23:00:00.000Z";
const text = (value: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: value }] }] });
const blog = () => ({ schemaVersion: 1, coverageState: "ongoing", updates: [{ id: "entry-one", headline: "Polls close",
  body: text("Polls closed at 8 p.m."), credits: [{ kind: "custom", name: "NJ PBS staff" }], keyUpdate: true }] });
const current = async () => (await db.doc("cmsPosts/post-one").get()).data()!;
async function seed(admitted = contract, old?: unknown) {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
  await seedSwitch(firestore, { admittedContract: admitted, old });
  await db.doc(`${a.CONTRACTS}/${p.publicReleaseDigest(admitted)}`).set(admitted);
  await db.doc(`${a.ADMISSIONS}/controls/adoption`).set({ schemaVersion: 2, enabled: true });
  await db.doc("sections/news").set({ label: "News" });
  await db.doc("cmsPosts/post-one").set({ id: "post-one", type: "post", title: "Election night", summary: "Live results coverage.",
    status: "draft", createdBy: "pair-manager", section: "news", slug: "election-night", previousSlugs: [], locale: "en", tags: [],
    categories: [], date: "2026-11-03", credits: [{ kind: "custom", name: "NJ PBS staff" }], blocks: [], liveBlog: blog(),
    version: 3, updatedAt: "2026-11-03T23:00:00.000Z" });
  time = "2026-11-03T23:00:00.000Z";
}
beforeEach(() => seed());
async function invoke(user: unknown, body: unknown) {
  const handler = save.createCmsSaveHandler({ firestore, requirePrincipalFn: async () => user, enablePublishSnapshot: true,
    now: () => time, assertPublishReadyFn: async () => { throw new Error("Legacy readiness must not run"); }, log: quiet });
  const res: any = { code: 200, headersSent: false, status(code: number) { this.code = code; return this; },
    set() { return this; }, json(value: any) { this.body = value; this.headersSent = true; return this; } };
  await handler({ method: "POST", body, headers: {}, ip: "127.0.0.1" }, res); return res;
}
async function publishedLiveBlog() {
  const first = await invoke(manager, { collection: "cmsPosts", id: "post-one", baseVersion: 3, publish: true, document: {} });
  expect(first.code, JSON.stringify(first.body)).toBe(200);
  time = "2026-11-03T23:05:00.000Z";
  const stored = await current();
  const liveBlog = structuredClone(stored.liveBlog);
  liveBlog.updates.unshift({ id: "", headline: "First results", body: text("Early returns are in."),
    credits: [{ kind: "custom", name: "Election desk" }], keyUpdate: false });
  return { collection: "cmsPosts", id: "post-one", baseVersion: stored.version, publish: true, liveBlogUpdate: true, document: { liveBlog } };
}

it("dispatches an Editor's direct live update through the pair owner and replays a lost response", async () => {
  const body = await publishedLiveBlog();
  const direct = await invoke(editor, body);
  expect(direct.code, JSON.stringify(direct.body)).toBe(200);
  expect(direct.body.publication.transport).toBe(a.TRANSPORT);
  expect(direct.body.document.published.metadata.liveBlog.updates[0].headline).toBe("First results");
  const operationId = direct.body.publication.queueId;
  const history = (await db.collection("cmsVersionHistory").get()).size;
  time = "2026-11-03T23:10:00.000Z";
  const replay = await invoke(editor, body);
  expect(replay.code, JSON.stringify(replay.body)).toBe(200);
  expect(replay.body.replayed).toBe(true);
  expect(replay.body.document).toEqual(direct.body.document);
  expect(replay.body.publication).toEqual(direct.body.publication);
  expect((await db.collection("cmsVersionHistory").get()).size).toBe(history);
  expect((await db.collection(`${a.ADMISSIONS}/operations`).get()).docs.map(doc => doc.id)).toContain(operationId);
});

it("refuses a replay of a direct live update by the same account after it becomes a Writer", async () => {
  const body = await publishedLiveBlog();
  expect((await invoke(editor, body)).code).toBe(200);
  const after = await current();
  const writer = { ...editor, principal: { id: editor.uid, grants: [{ role: "contributor" }] } };
  const replay = await invoke(writer, body);
  expect(replay.code).toBe(403);
  expect(await current()).toEqual(after);
});

it("replays an Editor's direct live update whose history kept only a bounded before receipt", async () => {
  const body = await publishedLiveBlog();
  const direct = await invoke(editor, body);
  expect(direct.code, JSON.stringify(direct.body)).toBe(200);
  // A size repair on a large Post stores this receipt in place of the full before-state.
  const rows = await db.collection("cmsVersionHistory").where("action", "==", "live-blog-update").get();
  expect(rows.size).toBe(1);
  await rows.docs[0].ref.update({ before: { id: "post-one", status: "published", version: body.baseVersion,
    beforeTruncated: true, beforeEstimatedBytes: 900_000 } });
  const replay = await invoke(editor, body);
  expect(replay.code, JSON.stringify(replay.body)).toBe(200);
  expect(replay.body.replayed).toBe(true);
  expect(replay.body.publication).toEqual(direct.body.publication);
});

it("keeps every other replay on Publish access", async () => {
  const body = { collection: "cmsPosts", id: "post-one", baseVersion: 3, publish: true, document: {} };
  const editorAsManager = staff("pair-editor", { role: "admin" });
  expect((await invoke(editorAsManager, body)).code).toBe(200);
  // The same account loses Publish access but keeps Editor access.
  const replay = await invoke(editor, body);
  expect(replay.code).toBe(403);
});

it("still refuses a live blog when the admitted pair contract lacks live blog support", async () => {
  await seed({ ...contract, features: [] });
  const before = await current();
  const res = await invoke(manager, { collection: "cmsPosts", id: "post-one", baseVersion: 3, publish: true, document: {} });
  expect(res.code).not.toBe(200);
  expect(await current()).toEqual(before);
  expect((await db.collection(`${a.ADMISSIONS}/operations`).get()).empty).toBe(true);
});

it("publishes presentation only with the exact selected pair’s companion marker", async () => {
  const root = (await db.doc("system/publicDeployment").get()).data()!;
  const pair = (await db.doc(work.publicReleasePairPath(root.selectedPair.pairId)).get()).data()!;
  const marker = db.doc(`${compatibility.LIVE_BLOG_CONTRACTS}/${pair.commitSha}`);
  await marker.set({ schemaVersion: 1, rendererSha: pair.commitSha, liveBlogContractVersion: 2 });
  expect(await db.runTransaction(transaction => compatibility.readLiveBlogContractVersion({ firestore, transaction }))).toBe(2);
  const body = await publishedLiveBlog();
  body.document.liveBlog.presentation = { playful: true };
  const result = await invoke(editor, body);
  expect(result.code, JSON.stringify(result.body)).toBe(200);
  expect(result.body.document.published.metadata.liveBlog.presentation).toEqual({ playful: true });
  await marker.update({ rendererSha: "f".repeat(40) });
  expect(await db.runTransaction(transaction => compatibility.readLiveBlogContractVersion({ firestore, transaction }))).toBe(1);
});

it("gates follow-up writes on the exact selected pair companion before any draft or publication write", async () => {
  const body = await publishedLiveBlog();
  const root = (await db.doc("system/publicDeployment").get()).data()!;
  const pair = (await db.doc(work.publicReleasePairPath(root.selectedPair.pairId)).get()).data()!;
  const stored = await current();
  const liveBlog = structuredClone(stored.liveBlog);
  liveBlog.updates[0].followUps = [{ id: "tmp-follow", body: text("Nested detail."), credits: [{ kind: "custom", name: "Reporter" }] }];
  body.document.liveBlog = liveBlog;
  const marker = db.doc(`${compatibility.LIVE_BLOG_CONTRACTS}/${pair.commitSha}`);
  for (const liveBlogContractVersion of [2, 3]) {
    await marker.set({ schemaVersion: 1, rendererSha: pair.commitSha, liveBlogContractVersion });
    const result = await invoke(editor, body);
    expect(result.code, JSON.stringify(result.body)).toBe(liveBlogContractVersion === 2 ? 409 : 200);
    if (liveBlogContractVersion === 2) expect(await current()).toEqual(stored);
    else expect(result.body.document.published.metadata.liveBlog.updates[0].followUps[0].body).toEqual(text("Nested detail."));
  }
});
