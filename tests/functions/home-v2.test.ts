import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import { getApps, initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import save from "../../functions/save.js";
import restore from "../../functions/restore-revision.js";
import { HOME_OPTIONAL_REGIONS } from "../../packages/content-core/src/home-composition-contract";
import projection from "../../functions/lib/public-content-projection.js";
import v1 from "../../site/tests/fixtures/home-composition-v1.json";

const project = process.env.GCLOUD_PROJECT || "demo-njpbs";
const host = process.env.FIRESTORE_EMULATOR_HOST;
const editor = () => ({ uid: "home-editor", email: "home-editor@example.test", principal: { id: "home-editor", grants: [{ role: "editor" }] } });
let db: ReturnType<typeof getFirestore>;

async function call(handler: ReturnType<typeof save.createCmsSaveHandler>, body: object) {
  const response = {
    code: 0, body: null as any,
    status(code: number) { this.code = code; return this; },
    json(value: unknown) { this.body = value; return this; },
  };
  await handler({ method: "POST", body, headers: {}, ip: "203.0.113.7" }, response);
  return response;
}
// Jules's October 14 editorial preset; Start is retained recovery data.
const hasNewscast = HOME_OPTIONAL_REGIONS.some(([section]) => String(section) === "home-newscast");
const editorialSections = ["home-start", "home-start-action", "home-spotlight", ...(hasNewscast ? ["home-newscast"] : []), "home-featured", "home-more", "home-newsletter", "home-passport-copy", "home-passport-action"];
const emptyNewsletter = { id: expect.any(String), section: "home-newsletter", type: "newsletter_signup", visible: true,
  data: { newsletterIds: [], actionLabel: "Sign up by email" } };
const emptyNewscast = { id: expect.any(String), section: "home-newscast", type: "home_newscast", visible: true,
  data: { showId: "ad1f378e-9779-4ef1-a629-40a8a6f8f8d5", heading: "Latest newscast", summary: "", layout: "feature", watchLabel: "Watch the latest", pastLabel: "Past newscasts", liveLabel: "Watch live" } };
const editorialBlocks = editorialSections.map(section => section === "home-newsletter" ? emptyNewsletter : section === "home-newscast" ? emptyNewscast : v1.blocks.find(block => block.section === section)!).map((block, order) => ({ ...block, order }));
const target = () => db.collection("cmsPages").doc("home");
const rows = async (collection: string) => (await db.collection(collection).get()).docs.map(doc => doc.data());

// Real Firestore transactions and serialization; only the authenticated caller
// boundary is supplied. The committed v1 characterization fixture is the oracle.
describe("Home v2 save and recovery boundaries", () => {
  beforeAll(() => {
    if (!host || !project.startsWith("demo-")) throw new Error("Home v2 tests require a demo-* Firestore emulator");
    const app = getApps()[0] || initializeApp({ projectId: project });
    db = isolatedFirestore("home-v2.test.ts");
  });
  beforeEach(async () => {
    const response = await clearEmulatorFirestore(`http://${host}/emulator/v1/projects/${project}/databases/(default)/documents`, { method: "DELETE" }, db);
    expect(response.ok).toBe(true);
  });
  afterAll(async () => { await Promise.all(getApps().map(app => deleteApp(app))); });

  it.each(["cmsPages", "cmsPosts"])("refuses a forged Home Newsletter marker in %s on block save and retained publication", async collection => {
    const id = collection === "cmsPages" ? "faq" : "newsletter-boundary-post";
    const newsletter = { id: "forged-home-slot", type: "newsletter_signup", section: "home-newsletter", order: 0,
      visible: true, data: { newsletterIds: [], actionLabel: "Sign up by email" } };
    const current = { id, title: "Existing draft", slug: id, status: "draft", version: 7, section: "station", blocks: [],
      ...(collection === "cmsPages" ? { template: "genericPage" } : { type: "post", tags: [] }) };
    const ref = db.collection(collection).doc(id);
    await ref.set(current);
    const handler = save.createCmsSaveHandler({ firestore: db, requirePrincipalFn: () => ({ ...editor(), principal: { id: "home-editor", grants: [{ role: "admin" }] } }) });
    const explicit = await call(handler, { collection, id, baseVersion: 7, document: { blocks: [newsletter] } });
    expect(explicit.code, JSON.stringify(explicit.body)).toBe(400);
    expect(explicit.body.error).toContain("Home Newsletter bar belongs only on Home");
    expect((await ref.get()).data()).toEqual(current);
    const imported = { ...current, blocks: [newsletter] };
    await ref.set(imported);
    const retained = await call(handler, { collection, id, baseVersion: 7, publish: true, document: {} });
    expect(retained.code, JSON.stringify(retained.body)).toBe(400);
    expect(retained.body.error).toContain("Home Newsletter bar belongs only on Home");
    expect((await ref.get()).data()).toEqual(imported);
    expect(await rows("cmsVersionHistory")).toEqual([]);
    expect(await rows("cmsPublishQueue")).toEqual([]);
  });

  it.each([{ title: "Metadata change" }, { blocks: v1.blocks.map(block => block.section === "home-featured" ? { ...block, data: { ...block.data, title: "Updated shelf heading" } } : block) }])("saves v2 with exact IDs, full history and unchanged publication", async document => {
    const published = { metadata: { title: "Live Home", homeCompositionVersion: 1 }, blocks: v1.blocks, sourceVersion: 5, publishedAt: "2026-09-05T12:00:00.000Z", publishedBy: "publisher" };
    const homeConversionReceipt = { fingerprint: "a".repeat(64), version: 7, targetVersion: 2, mintedIds: {} };
    const current = { ...v1, homeCompositionVersion: 2, published, homeConversionReceipt };
    await target().set(current);
    const response = await call(save.createCmsSaveHandler({ firestore: db, requirePrincipalFn: editor }), {
      collection: "cmsPages", id: "home", baseVersion: current.version, document,
    });
    expect(response.code, JSON.stringify(response.body)).toBe(200);
    expect(response.body.mintedIds).toEqual({});
    const saved = (await target().get()).data()!;
    expect(saved).toMatchObject({ ...current, ...document, version: 8 });
    const history = await rows("cmsVersionHistory");
    expect(history).toHaveLength(1);
    expect(history[0].before).toEqual(current);
    expect(history[0].after).toEqual(saved);
    expect(await rows("admin_logs")).toHaveLength(1);
    expect(await rows("cmsPublishQueue")).toEqual([]);
  });

  it.each([
    ["missing base", { baseVersion: undefined }],
    ["stale base", { baseVersion: 6 }],
    ["future marker", { document: { homeCompositionVersion: 3 } }],
    ["replaced named ID", { document: { blocks: v1.blocks.map(block => block.section === "home-featured" ? { ...block, id: "forged-featured" } : block) } }],
    ["replaced Start recovery", { document: { blocks: v1.blocks.map(block => block.section === "home-start" ? { ...block, visible: false } : block) } }],
    ["changed automatic source", { document: { blocks: v1.blocks.map(block => block.section === "home-featured" ? { ...block, data: { ...block.data, source: "pbs_more" } } : block) } }],
    ["changed approved link", { document: { blocks: v1.blocks.map(block => block.section === "home-more" ? { ...block, data: { ...block.data, moreHref: "https://example.test/" } } : block) } }],
    ["removed Passport action", { document: { blocks: v1.blocks.filter(block => block.section !== "home-passport-action") } }],
  ])("refuses v2 %s without partial writes", async (_name, overrides) => {
    const current = { ...v1, homeCompositionVersion: 2 };
    await target().set(current);
    const response = await call(save.createCmsSaveHandler({ firestore: db, requirePrincipalFn: editor }), {
      collection: "cmsPages", id: "home", baseVersion: 7, document: { blocks: v1.blocks }, ...overrides as object,
    });
    expect([400, 409]).toContain(response.code);
    await unchanged(current);
  });

  it("saves v2 array order while preserving IDs and retained withdrawal data", async () => {
    const current = { ...v1, homeCompositionVersion: 2 };
    await target().set(current);
    const reordered = [...v1.blocks.slice(3, 5), ...v1.blocks.slice(0, 3), ...v1.blocks.slice(5)]
      .map((block, order) => ({ ...block, order, ...(block.section.startsWith("home-passport") ? { visible: false } : {}) }));
    const response = await call(save.createCmsSaveHandler({ firestore: db, requirePrincipalFn: editor }), {
      collection: "cmsPages", id: "home", baseVersion: 7, document: { blocks: reordered },
    });
    expect(response.code, JSON.stringify(response.body)).toBe(200);
    expect(response.body.document.blocks).toEqual(reordered);
    expect(response.body.mintedIds).toEqual({});
    expect(await rows("cmsPublishQueue")).toEqual([]);
  });

  it("mints only newly inserted v2 row content and retains saved shelf provenance", async () => {
    const shelf = { id: "seed-retained-shelf", type: "promotion_playlist", order: 7, visible: false, data: { title: "Frozen story", placement: "before_featured", cards: [{ itemId: "post-public-v4", title: "Saved title", summary: "Saved summary", imageAssetId: "", alt: "", href: "/about/" }] } };
    const current = { ...v1, homeCompositionVersion: 2, blocks: [...v1.blocks, shelf] };
    await target().set(current);
    let nextId = 0;
    const handler = save.createCmsSaveHandler({ firestore: db, requirePrincipalFn: editor, mintId: () => `canonical-${++nextId}` });
    const blocks = [...current.blocks,
      { id: "new-row", type: "row", visible: true, data: { columns: [12] } },
      { id: "new-copy", type: "prose", visible: true, layout: { rowId: "new-row", column: 0 }, data: { content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Added local copy" }] }] } } },
    ].map((block, order) => ({ ...block, order }));
    const response = await call(handler, { collection: "cmsPages", id: "home", baseVersion: 7, document: { blocks } });
    expect(response.code, JSON.stringify(response.body)).toBe(200);
    expect(response.body.mintedIds).toEqual({ "new-row": "canonical-1", "new-copy": "canonical-2" });
    expect(response.body.document.blocks.slice(0, 8)).toEqual(current.blocks);
    expect(response.body.document.blocks.slice(8)).toEqual([
      { ...blocks[8], id: "canonical-1" },
      { ...blocks[9], id: "canonical-2", layout: { rowId: "canonical-1", column: 0 } },
    ]);
    const second = await call(handler, { collection: "cmsPages", id: "home", baseVersion: 8, document: { blocks: response.body.document.blocks } });
    expect(second.code, JSON.stringify(second.body)).toBe(200);
    expect(second.body.document.blocks).toEqual(response.body.document.blocks);
    expect(second.body.mintedIds).toEqual({});
  });

  it("refuses a v2 save whose complete history cannot fit without discarding recovery data", async () => {
    const current = { ...v1, homeCompositionVersion: 2 };
    await target().set(current);
    const handler = save.createCmsSaveHandler({ firestore: db, requirePrincipalFn: editor,
      documentSizeErrorFn: (_value: unknown, path: string) => path.startsWith("cmsVersionHistory/") ? { reason: "History budget exceeded", detail: "Complete history required" } : null });
    const response = await call(handler, { collection: "cmsPages", id: "home", baseVersion: 7, document: { title: "Changed draft", blocks: v1.blocks } });
    expect(response.code).toBe(413);
    await unchanged(current);
  });

  it.each([{ publish: true }, { scheduleAt: "2026-10-12T16:00:00.000Z" }])("refuses v2 publication and scheduling without changing the draft or public state", async intent => {
    const current = { ...v1, homeCompositionVersion: 2 };
    await target().set(current);
    const publisher = () => ({ ...editor(), principal: { id: "home-editor", grants: [{ role: "admin" }] } });
    const handler = save.createCmsSaveHandler({ firestore: db, requirePrincipalFn: publisher, now: () => "2026-10-11T16:00:00.000Z" });
    const response = await call(handler, { collection: "cmsPages", id: "home", baseVersion: 7, document: {}, ...intent });
    expect(response.code).toBe(400);
    expect(response.body.error).toContain("Version 2 Home publication is not enabled");
    await unchanged(current);
  });

  it.each([[1, 2], [2, 1], [2, 2]])("restores v%s to v%s while retaining detached publication and the current receipt", async (currentVersion, historicalVersion) => {
    const published = { metadata: { title: "Frozen published Home", homeCompositionVersion: 1 }, blocks: v1.blocks, sourceVersion: 5, publishedAt: "2026-09-05T12:00:00.000Z", publishedBy: "publisher" };
    const receipt = { fingerprint: "a".repeat(64), version: 7, mintedIds: {} };
    const current = { ...v1, version: 8, homeCompositionVersion: currentVersion, published, homeConversionReceipt: receipt };
    const historical = { ...v1, homeCompositionVersion: historicalVersion, homeConversionReceipt: { ...receipt, fingerprint: "b".repeat(64) } };
    await target().set(current);
    await db.collection("cmsVersionHistory").doc("historical").set({ collection: "cmsPages", documentId: "home", action: "update", after: historical });
    const handler = restore.createCmsRestoreRevisionHandler({ firestore: db, requirePrincipalFn: editor });
    const stale = await call(handler, { collection: "cmsPages", id: "home", revisionId: "historical", baseVersion: 7 });
    expect(stale.code).toBe(409);
    expect((await target().get()).data()).toEqual(current);
    const response = await call(handler, { collection: "cmsPages", id: "home", revisionId: "historical", baseVersion: 8 });
    expect(response.code, JSON.stringify(response.body)).toBe(200);
    const restored = (await target().get()).data()!;
    expect(restored).toMatchObject({ version: 9, homeCompositionVersion: historicalVersion, blocks: v1.blocks, published, homeConversionReceipt: receipt });
    const history = await rows("cmsVersionHistory");
    expect(history).toHaveLength(2);
    expect(history.find(row => row.action === "restore")!.before).toEqual(current);
    expect(await rows("cmsPublishQueue")).toEqual([]);
  });
  const conversion = (overrides: Record<string, unknown> = {}) => ({ collection: "cmsPages", id: "home", baseVersion: 7, convertHomeV2: "home-v2-stable-request", document: {}, ...overrides });
  const saveHandler = () => save.createCmsSaveHandler({ firestore: db, requirePrincipalFn: editor });
  it("retains the existing legacy-to-v1 conversion and exact replay behavior", async () => {
    const current = { ...v1, blocks: [] } as Record<string, unknown>;
    delete current.homeCompositionVersion;
    await target().set(current);
    let nextId = 0;
    const handler = save.createCmsSaveHandler({ firestore: db, requirePrincipalFn: editor, mintId: () => `canonical-${nextId++}` });
    const request = { collection: "cmsPages", id: "home", baseVersion: 7, convertHome: "stable-legacy-request", document: { blocks: v1.blocks } };
    const response = await call(handler, request);
    expect(response.code, JSON.stringify(response.body)).toBe(200);
    expect(response.body.document).toMatchObject({ homeCompositionVersion: 1, version: 8, blocks: v1.blocks.map((block, index) => ({ ...block, id: `canonical-${index}` })) });
    const history = await rows("cmsVersionHistory");
    expect(history).toHaveLength(1);
    expect(history[0].before).toEqual(current);
    const retry = await call(handler, request);
    expect(retry.code).toBe(200);
    expect(retry.body.replayed).toBe(true);
    expect(retry.body.document).toEqual(response.body.document);
    expect(await rows("cmsVersionHistory")).toEqual(history);
  });
  async function unchanged(current: object) {
    expect((await target().get()).data()).toEqual(current);
    for (const collection of ["cmsVersionHistory", "admin_logs", "cmsPages/home/mediaUsage", "cmsPublishQueue"]) expect(await rows(collection)).toEqual([]);
  }

  it("converts only the saved draft once, retaining exact IDs, frozen references, history and media usage", async () => {
    const artwork = { lifecycle: "active", source: "site_seed", url: "https://media.njpbs.org/cms-media/story-art/hash.webp", mimeType: "image/webp", width: 640, height: 360, altText: null };
    await db.collection("media_assets").doc("story-art").set(artwork);
    const { lifecycle, source, ...projection } = artwork;
    await db.collection("media_assets_public").doc("story-art").set(projection);
    const shelf = { id: "saved-local-shelf", section: "home-local-promotions", type: "promotion_playlist", order: 7, visible: true, data: { title: "Station story", placement: "before_start", cards: [{ itemId: "published-post-v4", title: "Frozen title", summary: "Frozen summary", imageAssetId: "story-art", alt: "Local scene", href: "/about/" }] } };
    const published = { metadata: { title: "Live Home", homeCompositionVersion: 1 }, blocks: v1.blocks, sourceVersion: 5, publishedAt: "2026-09-05T12:00:00.000Z", publishedBy: "publisher" };
    const current = { ...v1, createdAt: "2026-07-01T00:00:00.000Z", createdBy: "original-editor", publiclyVisible: true, published, blocks: [...v1.blocks, shelf] };
    await target().set(current);
    const handler = saveHandler();
    const response = await call(handler, conversion());
    expect(response.code, JSON.stringify(response.body)).toBe(200);
    const converted = (await target().get()).data()!;
    const expected = [...editorialBlocks, shelf].map((block, order) => ({ ...block, order }));
    expect(converted).toMatchObject({ homeCompositionVersion: 2, version: 8, blocks: expected, published, createdAt: current.createdAt, createdBy: current.createdBy });
    expect(response.body.mintedIds).toEqual({});
    expect(response.body.warnings).toContain("The standard newsletter band appears until a newsletter is chosen.");
    expect(converted.homeConversionReceipt).toMatchObject({ version: 8, targetVersion: 2, mintedIds: {} });
    const history = await rows("cmsVersionHistory");
    expect(history).toHaveLength(1);
    expect(history[0].before).toEqual(current);
    expect(history[0].after).toEqual(converted);
    expect(await rows("cmsPages/home/mediaUsage")).toEqual([expect.objectContaining({ state: "working", sourceVersion: 8, assetIds: ["story-art"], occurrenceCount: 1 })]);
    expect(await rows("cmsPublishQueue")).toEqual([]);
    const replay = await call(handler, conversion());
    expect(replay.code).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.document).toEqual(response.body.document);
    expect((await target().get()).data()).toEqual(converted);
    expect(await rows("cmsVersionHistory")).toEqual(history);
    expect(await rows("admin_logs")).toHaveLength(1);
    const different = await call(handler, conversion({ convertHomeV2: "different-v2-request" }));
    expect(different.code).toBe(409);
    expect(await rows("cmsVersionHistory")).toEqual(history);
  });

  it("converts a published v1 into a private editorial draft and restores its previous working copy", async () => {
    const published = { metadata: { title: "Live Home", homeCompositionVersion: 1 }, blocks: v1.blocks, sourceVersion: 5, publishedAt: "2026-09-05T12:00:00.000Z", publishedBy: "publisher" };
    const hero = { mode: "tag", source: "cms_posts", value: "announcement", limit: 10 };
    const current = { ...v1, status: "published", publishAt: "2026-09-05T12:00:00.000Z", homeHero: hero, publiclyVisible: true, publicSourceVersion: 5, published };
    await target().set(current);
    const handler = saveHandler();
    const response = await call(handler, conversion());
    expect(response.code, JSON.stringify(response.body)).toBe(200);
    const converted = (await target().get()).data()!;
    const publicRead = (document: any) => projection.projectPublicPageDocument({ pageId: "home", document, assets: new Map(), now: new Date("2026-10-14T12:00:00.000Z") });
    expect(publicRead(converted)).toEqual(publicRead(current));
    expect(publicRead(converted)).toMatchObject({ state: "live", page: { homeCompositionVersion: 1, sourceVersion: 5 } });
    expect(converted).toMatchObject({ status: "draft", homeCompositionVersion: 2, blocks: editorialBlocks, homeHero: { ...hero, presentation: "editorial" }, published, publiclyVisible: true, publicSourceVersion: 5 });
    expect(converted.published).toEqual(published);
    expect(await rows("cmsPublishQueue")).toEqual([]);
    const retry = await call(handler, conversion());
    expect(retry.code).toBe(200);
    expect(retry.body.replayed).toBe(true);
    const history = await db.collection("cmsVersionHistory").get();
    expect(history.size).toBe(1);
    // Restore the before snapshot through real immutable revision history.
    await db.collection("cmsVersionHistory").doc("published-v1").set({ collection: "cmsPages", documentId: "home", after: history.docs[0].data().before });
    const restored = await call(restore.createCmsRestoreRevisionHandler({ firestore: db, requirePrincipalFn: editor }), { collection: "cmsPages", id: "home", revisionId: "published-v1", baseVersion: 8 });
    expect(restored.code, JSON.stringify(restored.body)).toBe(200);
    expect((await target().get()).data()).toMatchObject({ status: "draft", homeCompositionVersion: 1, blocks: v1.blocks, homeHero: hero, published, publiclyVisible: true });
  });

  it("places existing source sections before added content and manual shelves without inventing absent sources", async () => {
    const manual = { id: "saved-manual", type: "promotion_playlist", order: 8, visible: true, data: { title: "Station", placement: "before_featured", cards: [] } };
    const extra = { id: "saved-text", type: "prose", order: 2, visible: true, data: { content: { type: "doc", content: [] } } };
    const blocks = [...v1.blocks.slice(0, 2), extra, ...v1.blocks.slice(2), manual].map((block, order) => ({ ...block, order }));
    await target().set({ ...v1, blocks });
    const response = await call(saveHandler(), conversion());
    expect(response.code, JSON.stringify(response.body)).toBe(200);
    const saved = response.body.document.blocks;
    expect(saved.slice(0, editorialBlocks.length)).toEqual(editorialBlocks);
    // The v1 visual order places this manual shelf after the added introduction.
    expect(saved.slice(editorialBlocks.length)).toEqual([{ ...extra, order: editorialBlocks.length }, { ...manual, order: editorialBlocks.length + 1 }]);
    expect(saved.filter((block: any) => !["home-newsletter", "home-newscast"].includes(block.section)).map((block: any) => block.id).sort()).toEqual(blocks.map(block => block.id).sort());
    expect(saved.some((block: any) => block.section === "home-newscast")).toBe(hasNewscast);
    expect(saved.some((block: any) => ["home-posts", "home-donor"].includes(block.section))).toBe(false);
  });

  it.each([
    ["missing base", { baseVersion: undefined }], ["short key", { convertHomeV2: "short" }],
    ["different page", { id: "about" }], ["two conversions", { convertHome: "another-conversion" }],
    ["publish", { publish: true }], ["schedule", { scheduleAt: "2026-11-01T12:00:00.000Z" }],
    ["forced overwrite", { createOnly: false }], ["replacement blocks", { document: { blocks: v1.blocks } }],
    ["replacement metadata", { document: { title: "Replacement" } }],
  ])("rejects a conversion request with %s before writing", async (_label, override) => {
    await target().set(v1);
    const response = await call(saveHandler(), conversion(override as Record<string, unknown>));
    expect(response.code).toBe(400);
    await unchanged(v1);
  });

  it.each([undefined, 2, 3, "2"])("rejects conversion from stored version %s", async version => {
    const current: Record<string, unknown> = { ...v1 };
    if (version === undefined) delete current.homeCompositionVersion;
    else current.homeCompositionVersion = version;
    await target().set(current);
    const response = await call(saveHandler(), conversion());
    expect(response.code).toBe(409);
    await unchanged(current);
  });

  it.each(["stale", "scheduled", "pending", "scheduled draft", "future published", "published without snapshot", "source", "link"])("rejects %s stored input with no partial transaction", async kind => {
    const current: any = structuredClone(v1);
    if (kind === "scheduled") current.status = "scheduled";
    if (kind === "pending") current.publishBuildPending = true;
    if (kind === "scheduled draft") current.publishAt = "2026-10-15T12:00:00.000Z";
    if (kind === "future published") { current.status = "published"; current.publishAt = "2099-01-01T12:00:00.000Z"; }
    if (kind === "published without snapshot") current.status = "published";
    if (kind === "source") current.blocks[2].data.source = "pbs_more";
    if (kind === "link") current.blocks[4].data.ctas[0].href = "/support/";
    await target().set(current);
    const response = await call(saveHandler(), conversion(kind === "stale" ? { baseVersion: 6 } : {}));
    expect(response.code).toBe(["source", "link"].includes(kind) ? 400 : 409);
    await unchanged(current);
  });

  it("allows one winning request when distinct conversions race", async () => {
    await target().set(v1);
    const handler = saveHandler();
    const responses = await Promise.all([call(handler, conversion()), call(handler, conversion({ convertHomeV2: "racing-request-two" }))]);
    expect(responses.map(response => response.code).sort()).toEqual([200, 409]);
    expect((await target().get()).data()!.version).toBe(8);
    expect(await rows("cmsVersionHistory")).toHaveLength(1);
  });

  it("restores the pre-conversion draft and refuses an old retry while allowing a new exact-base conversion", async () => {
    await target().set(v1);
    const handler = saveHandler();
    expect((await call(handler, conversion())).code).toBe(200);
    const receipt = (await target().get()).data()!.homeConversionReceipt;
    await db.collection("cmsVersionHistory").doc("v1-saved").set({ collection: "cmsPages", documentId: "home", after: v1 });
    const recovery = restore.createCmsRestoreRevisionHandler({ firestore: db, requirePrincipalFn: editor });
    expect((await call(recovery, { collection: "cmsPages", id: "home", revisionId: "v1-saved", baseVersion: 8 })).code).toBe(200);
    expect((await target().get()).data()).toMatchObject({ homeCompositionVersion: 1, version: 9, blocks: v1.blocks, homeConversionReceipt: receipt });
    expect((await call(handler, conversion())).code).toBe(409);
    const converted = await call(handler, conversion({ baseVersion: 9, convertHomeV2: "fresh-after-rollback" }));
    expect(converted.code, JSON.stringify(converted.body)).toBe(200);
    expect(converted.body.document).toMatchObject({ homeCompositionVersion: 2, version: 10, blocks: editorialBlocks });
  });

  it("refuses conversion rather than trimming its complete history", async () => {
    await target().set(v1);
    let attempted: any;
    const handler = save.createCmsSaveHandler({ firestore: db, requirePrincipalFn: editor,
      documentSizeErrorFn: (document: unknown, _path: string, context: any = {}) => {
        if (context.label !== "the version-history row for this save") return null;
        attempted = document;
        return { reason: "Complete conversion history exceeds the budget", detail: "Deterministic history budget" };
      },
    });
    expect((await call(handler, conversion())).code).toBe(413);
    expect(attempted.before).toEqual(v1);
    expect(attempted.after).toMatchObject({ blocks: editorialBlocks, homeCompositionVersion: 2 });
    await unchanged(v1);
  });
});
