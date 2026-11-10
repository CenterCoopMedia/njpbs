import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import admin from "../helpers/firebase-admin.js";
import templates from "../../functions/post-templates.js";
import contract from "../../functions/lib/post-templates.js";
import save from "../../functions/save.js";
import getContent from "../../functions/get-content.js";
import previewSnapshot from "../../functions/lib/preview-snapshot.js";
import media from "../../functions/lib/media-contract.js";
import { parseBlocks } from "../../packages/content-core/src/content-model";
import { groupContentRows } from "../../packages/content-core/src/content-layout";

const { capturePost } = contract;
const owner = { uid: "owner", principal: { id: "owner", grants: [{ role: "admin" }] } };
const scoped = (id, section, role = "editor") => ({ uid: id, principal: { id, grants: [{ role, sections: [section], registeredMediaSections: [section] }] } });
const richText = text => ({ type: "doc", content: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text }] }, { type: "paragraph" }] });

function fixture() {
  const blocks = [
    { type: "row", data: { columns: [4, 8] } },
    { type: "prose", layout: { rowId: "source-0", column: 0 }, data: { content: richText("Starter instructions") } },
    { type: "image", layout: { rowId: "source-0", column: 0 }, data: { assetId: "photo", alt: "Photo description", caption: "Photo credit" } },
    { type: "promotion_playlist", layout: { rowId: "source-0", column: 1 }, data: { title: "Watch", placement: "before_more", presentation: "grid", columns: 3, cards: [{ itemId: "card-one", title: "Starter", summary: "Summary", imageAssetId: "photo", alt: "Description", href: "/watch/" }] } },
    { type: "row", data: { columns: [3, 3, 6] } },
    { type: "image_gallery", layout: { rowId: "source-4", column: 0 }, data: { presentation: "carousel", images: [{ itemId: "photo-one", assetId: "photo", alt: "Image one", caption: "Credit" }] } },
    { type: "embed", layout: { rowId: "source-4", column: 2 }, data: { url: "https://example.com/", caption: "Experience", width: 640, height: 360 } },
    { type: "data_table", layout: { rowId: "source-4", column: 2 }, data: { title: "Data", csv: "Name,Value\nOne,1", source: "Source", sourceHref: "https://example.com/" } },
    { type: "cta_row", data: { ctas: [{ label: "Read more", href: "/watch/", variant: "secondary" }] } },
    { type: "topic_shelf", data: { title: "Business", topic: "business", source: "njpbs_related_index", itemLimit: 4, sort: "newest" } },
    { type: "bio_card", data: { profileId: "example-reporter", kind: "person", name: "Example Reporter", role: "Reporter", area: "New Jersey", summary: "Reports on New Jersey.", sourceUrl: "https://example.org/reporter", sourceLabel: "Staff biography", asOf: "2026-10-03", image: { assetId: "photo", alt: "Example Reporter" } } },
    { type: "divider", visible: false, data: {} },
  ].map((block, order) => ({ id: `source-${order}`, order, visible: true, ...block }));
  return {
    type: "post", status: "published", title: "Original story", version: 7,
    section: "watch", createdBy: "author", slug: "original-story", previousSlugs: ["old-story"],
    summary: "Original summary", excerpt: "Original excerpt", credits: [{ kind: "legacy", name: "Reporter" }],
    categories: ["News"], tags: ["story-topic", "format:multimedia"],
    heroImage: "photo", heroImageAlt: "Lead description", heroImageDecorative: false,
    heroBackgroundPosition: "center", blocks,
    published: { sourceVersion: 6 }, publiclyVisible: true, publishAt: "2026-09-09T12:00:00Z",
    previewToken: "private-preview", assigneeUid: "author", reviewRequest: { state: "approved" },
  };
}

describe("Post template field contract", () => {
  it("retains canonical structure and starter content while clearing story and access state", () => {
    const source = fixture();
    const snapshot = capturePost(source, "content");
    expect(snapshot.blocks).toEqual(source.blocks);
    expect(snapshot.tags).toEqual(["format:multimedia"]);
    expect(snapshot.heroImageAlt).toBe("Lead description");
    for (const field of ["id", "slug", "previousSlugs", "summary", "excerpt", "credits", "section", "createdBy", "version", "published", "publiclyVisible", "publishAt", "previewToken", "assigneeUid", "reviewRequest"]) {
      expect(snapshot).not.toHaveProperty(field);
    }
    expect(snapshot).toMatchObject({ status: "draft", title: "", categories: [] });
    snapshot.blocks[0].data.columns[0] = 6;
    expect(source.blocks[0].data.columns).toEqual([4, 8]);
  });

  it("clears type-specific story slots without flattening rows, collections or rich text", () => {
    const snapshot = capturePost(fixture(), "layout");
    expect(parseBlocks(snapshot.blocks, { complete: false }).ok).toBe(true);
    expect(snapshot.blocks.map(block => [block.type, block.layout, block.visible])).toEqual(fixture().blocks.map(block => [block.type, block.layout, block.visible]));
    expect(snapshot.blocks[1].data.content.content[0]).toEqual({ type: "heading", attrs: { level: 2 }, content: [] });
    expect(snapshot.blocks[2].data).toEqual({ assetId: "", alt: "" });
    expect(snapshot.blocks[3].data).toMatchObject({ placement: "before_more", presentation: "grid", columns: 3, title: "", cards: [{ imageAssetId: "", href: "" }] });
    expect(snapshot.blocks[5].data).toEqual({ presentation: "carousel", images: [{ itemId: "photo-one", assetId: "", alt: "" }] });
    expect(snapshot.blocks[6].data).toEqual({ url: "", caption: "", width: 640, height: 360 });
    expect(snapshot.blocks[7].data.csv).toBe("");
    expect(snapshot.blocks[8].data.ctas).toEqual([{ label: "", href: "", variant: "secondary" }]);
    expect(snapshot).not.toHaveProperty("heroImage");
    expect(parseBlocks(snapshot.blocks, { complete: true }).ok).toBe(false);
  });

  it.each([
    ["content", { profileId: "example-reporter", kind: "person", name: "Example Reporter", role: "Reporter", area: "New Jersey", summary: "Reports on New Jersey.", sourceUrl: "https://example.org/reporter", sourceLabel: "Staff biography", asOf: "2026-10-03", image: { assetId: "photo", alt: "Example Reporter" } }],
    ["layout", { profileId: "", kind: "person", name: "", role: "", summary: "", sourceUrl: "", sourceLabel: "", asOf: "" }],
  ])("captures a bio card in %s templates", (mode, expected) => {
    const bio = capturePost(fixture(), mode).blocks.find(block => block.type === "bio_card");
    expect(bio.data).toEqual(expected);
  });

  it.each(["layout", "content"])("freezes %s image slots for private preview without weakening asset checks", mode => {
    const draft = { ...capturePost(fixture(), mode), version: 1, previousSlugs: [], locale: "en" };
    const snapshot = previewSnapshot.createPostPreviewSnapshot("template-draft", draft);
    expect(snapshot.blocks).toEqual(draft.blocks);
    expect(previewSnapshot.referencedPreviewAssetIds(snapshot)).toEqual(mode === "content" ? ["photo"] : []);
    snapshot.blocks.find(block => block.type === "image").data.assetId = "invalid/path";
    expect(() => previewSnapshot.referencedPreviewAssetIds(snapshot)).toThrow(/invalid media asset id/);
    expect(() => previewSnapshot.createPreviewAssetSnapshot("photo", null)).toThrow(/missing/);
  });

  it("refuses invalid row references and retired palette types", () => {
    const broken = fixture();
    broken.blocks[1].layout.rowId = "missing";
    expect(() => capturePost(broken, "content")).toThrow(/row/);
    expect(() => capturePost({ ...fixture(), blocks: [{ id: "old", type: "headline", data: { text: "Title" }, order: 0, visible: true }] }, "content")).toThrow(/post catalog/);
  });
});

describe("Post template list scan bound", () => {
  it("stops after a bounded number of full unread pages", async () => {
    let pages = 0;
    const firestore = {
      collection() {
        return {
          orderBy() { return this; },
          limit() { return this; },
          startAfter() { return this; },
          async get() {
            pages += 1;
            return {
              docs: Array.from({ length: 501 }, (_, index) => ({
                id: `blocked-${pages}-${String(index).padStart(3, "0")}`,
                data: () => ({
                  deleted: false,
                  name: "Blocked",
                  createdBy: "attacker",
                  sourceResource: { ownerId: "attacker", section: "support" },
                }),
              })),
            };
          },
        };
      },
    };

    const result = await templates.listReadableTemplates(
      firestore,
      scoped("author", "watch", "contributor").principal,
      null,
    );

    expect(pages).toBe(3);
    expect(result.templates).toEqual([]);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBe("blocked-3-500");
  });
});

describe("Post template trusted persistence", () => {
  let db;
  const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
  beforeAll(() => {
    if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Use the Firestore emulator for template persistence tests.");
    if (!admin.apps.length) admin.initializeApp({ projectId: "demo-njpbs" });
    db = isolatedFirestore("post-templates.test.js");
  });
  beforeEach(async () => {
    await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
    await db.doc("sections/watch").set({ id: "watch", label: "Watch", order: 1 });
    await db.doc("cmsPosts/source").set(fixture());
    const asset = { lifecycle: "active", category: "general", source: "site_seed", url: "https://media.njpbs.org/photo.png", altText: null, mimeType: "image/png", width: 1600, height: 900 };
    await db.doc("media_assets/photo").set(asset);
    await db.doc("media_assets_public/photo").set(media.mediaProjection(asset));
    log.error.mockClear();
  });
  async function invoke(factory, body, user = owner) {
    const res = { headersSent: false, statusCode: 0, body: null };
    res.status = code => { res.statusCode = code; return res; };
    res.set = () => res;
    res.json = body => { res.body = body; res.headersSent = true; return res; };
    await factory({ firestore: db, requirePrincipalFn: async () => user, log })({ method: "POST", body, headers: { "content-type": "application/json" } }, res);
    return res;
  }
  const api = (body, user) => invoke(templates.createCmsPostTemplatesHandler, body, user);
  const captureRequest = (over = {}) => ({ action: "capture", name: "Reusable layout", description: "Several columns and empty slots", sourceId: "source", sourceVersion: 7, mode: "content", idempotencyKey: randomUUID(), ...over });
  async function captured(over) {
    const result = await api(captureRequest(over));
    expect(result.statusCode, JSON.stringify(result.body)).toBe(200);
    return result.body.template;
  }

  describe("custom HTML authorization", () => {
    const contributor = scoped("author", "watch", "contributor");
    const publisher = scoped("author", "watch");
    const html = { id: "html-one", type: "html", order: 0, visible: true, data: { html: "<p>Results</p>", title: "Results" } };
    const divider = { id: "divider-one", type: "divider", order: 0, visible: true, data: {} };
    const sourcePost = blocks => ({ type: "post", status: "draft", title: "Source", version: 7, createdBy: "author", section: "watch", blocks });

    it.each(["layout", "content"])("refuses contributor %s capture of HTML without any persisted effect", async mode => {
      const source = sourcePost([html]);
      await db.doc("cmsPosts/source").set(source);

      const result = await api(captureRequest({ mode }), contributor);

      expect(result.statusCode, JSON.stringify(result.body)).toBe(403);
      expect(result.body.error).toBe("Only editors and admins can add or change custom HTML.");
      expect((await db.collection("cmsPostTemplates").get()).empty).toBe(true);
      expect((await db.collectionGroup("requests").get()).empty).toBe(true);
      expect((await db.collectionGroup("mediaUsage").get()).empty).toBe(true);
      expect((await db.collection("admin_logs").get()).empty).toBe(true);
      expect((await db.doc("cmsPosts/source").get()).data()).toEqual(source);
    });

    it.each(["add", "html", "title", "recapture content", "recapture layout"])("refuses contributor HTML %s on update atomically", async change => {
      const source = sourcePost(change === "add" ? [divider] : [html]);
      await db.doc("cmsPosts/source").set(source);
      const created = await api(captureRequest(), publisher);
      expect(created.statusCode, JSON.stringify(created.body)).toBe(200);
      const ref = db.doc(`cmsPostTemplates/${created.body.template.id}`);
      const before = (await ref.get()).data();
      const usage = (await ref.collection("mediaUsage").doc("working").get()).data();
      if (change.startsWith("recapture")) {
        await db.doc("cmsPosts/source").set(sourcePost([{ ...html, data: { ...html.data, html: "<script>changed()</script>" } }]));
      }
      const document = { type: "post", blocks: change === "add" ? [html] : [{ ...html, data: {
        ...html.data, ...(change === "html" ? { html: "<script>changed()</script>" } : { title: "Changed title" }),
      } }] };
      const request = { action: "update", id: ref.id, baseVersion: 1, idempotencyKey: randomUUID(),
        ...(change.startsWith("recapture") ? { sourceId: "source", sourceVersion: 7, mode: change.split(" ")[1] } : { document }) };

      const result = await api(request, contributor);

      expect(result.statusCode, JSON.stringify(result.body)).toBe(403);
      expect((await ref.get()).data()).toEqual(before);
      expect((await ref.collection("mediaUsage").doc("working").get()).data()).toEqual(usage);
      expect((await ref.collection("requests").get()).size).toBe(1);
      expect((await db.collection("admin_logs").get()).size).toBe(1);
    });

    it("uses the template's area for publish rights", async () => {
      await db.doc("cmsPosts/source").set(sourcePost([html]));
      const otherAreaPublisher = { ...contributor, principal: { id: "author", grants: [
        ...contributor.principal.grants, { role: "editor", sections: ["support"], registeredMediaSections: ["support"] },
      ] } };
      expect((await api(captureRequest(), otherAreaPublisher)).statusCode).toBe(403);
      expect((await db.collection("cmsPostTemplates").get()).empty).toBe(true);
    });

    it("allows publisher capture and editing while contributors preserve, move, hide or remove existing HTML", async () => {
      await db.doc("cmsPosts/source").set(sourcePost([html]));
      const created = await api(captureRequest(), publisher);
      expect(created.statusCode, JSON.stringify(created.body)).toBe(200);
      const ref = db.doc(`cmsPostTemplates/${created.body.template.id}`);
      const update = (baseVersion, blocks, user) => api({ action: "update", id: ref.id, baseVersion,
        document: { type: "post", blocks }, idempotencyKey: randomUUID() }, user);
      const edited = { ...html, data: { html: "<p>Updated</p>", title: "Updated" } };
      expect((await update(1, [edited], publisher)).statusCode).toBe(200);
      expect((await update(2, [edited], contributor)).statusCode).toBe(200);
      const moved = [divider, { ...edited, order: 1, visible: false }];
      expect((await update(3, moved, contributor)).statusCode).toBe(200);
      expect((await ref.get()).data().blocks).toEqual(moved);
      expect((await update(4, [divider], contributor)).statusCode).toBe(200);
      expect((await ref.get()).data().blocks).toEqual([divider]);
    });

    it("allows contributor capture and update of templates without HTML", async () => {
      await db.doc("cmsPosts/source").set(sourcePost([divider]));
      const created = await api(captureRequest(), contributor);
      expect(created.statusCode, JSON.stringify(created.body)).toBe(200);
      const result = await api({ action: "update", id: created.body.template.id, baseVersion: 1,
        name: "Renamed", document: { type: "post", blocks: [{ ...divider, visible: false }] }, idempotencyKey: randomUUID() }, contributor);
      expect(result.statusCode, JSON.stringify(result.body)).toBe(200);
      expect((await db.doc(`cmsPostTemplates/${created.body.template.id}`).get()).data()).toMatchObject({ name: "Renamed", blocks: [{ ...divider, visible: false }] });
    });
  });

  it.each(["layout", "content"])("round-trips %s capture through trusted draft creation, save and reopen", async mode => {
    const template = await captured({ mode });
    const body = { collection: "cmsPosts", document: { type: "post", title: "New independent story" }, postTemplate: { id: template.id, version: template.version }, idempotencyKey: randomUUID() };
    const created = await invoke(save.createCmsSaveHandler, body);
    expect(created.statusCode, JSON.stringify(created.body)).toBe(200);
    const draft = created.body.document;
    expect(draft).toMatchObject({ status: "draft", createdBy: "owner", version: 1, title: "New independent story", unassignedDraft: true });
    expect(draft.slug).not.toBe("original-story");
    for (const field of ["published", "section", "previewToken", "reviewRequest"]) expect(draft).not.toHaveProperty(field);
    expect(draft.publishAt).not.toBe(fixture().publishAt);
    expect(draft.blocks.every(block => !block.id.startsWith("source-"))).toBe(true);
    const expected = capturePost(fixture(), mode).blocks;
    expect(draft.blocks.map(block => block.data)).toEqual(expected.map(block => block.data));
    expect(groupContentRows(draft.blocks).slice(0, 2).map(row => row.columns.map(column => column.length))).toEqual([[2, 1], [1, 0, 2]]);
    const retry = await invoke(save.createCmsSaveHandler, body);
    expect(retry.statusCode, JSON.stringify(retry.body)).toBe(200);
    expect(retry.body.document.id).toBe(draft.id);
    expect((await invoke(save.createCmsSaveHandler, { ...body, document: { type: "post", title: "Changed retry" } })).statusCode).toBe(409);
    const saved = await invoke(save.createCmsSaveHandler, { collection: "cmsPosts", id: draft.id, baseVersion: 1, document: { type: "post", title: "Edited starter", blocks: draft.blocks } });
    expect(saved.statusCode, JSON.stringify(saved.body)).toBe(200);
    const reopened = await invoke(getContent.createCmsGetContentHandler, { collection: "cmsPosts", id: draft.id });
    expect(reopened.body.document.blocks).toEqual(draft.blocks);
    expect(parseBlocks(reopened.body.document.blocks, { complete: false }).ok).toBe(true);
    expect((await db.doc("cmsPosts/source").get()).data()).toEqual(fixture());
    expect((await db.doc(`cmsPostTemplates/${template.id}`).get()).data().blocks).toEqual(expected);
    expect((await db.doc(`cmsPostTemplates/${template.id}/mediaUsage/working`).get()).data().assetIds).toEqual(mode === "content" ? ["photo"] : []);
  });

  it("duplicates an exact saved Post as one independent draft and replays the request", async () => {
    const source = {
      ...fixture(),
      credits: [{ kind: "custom", name: "Reporter" }],
      date: "2026-09-09",
      recordMeaningfulUpdate: true,
      showUpdatedDate: true,
      lastMeaningfulUpdatedAt: "2026-09-10T12:00:00.000Z",
      lastMeaningfulUpdatedBy: "author",
    };
    await db.doc("cmsPosts/source").set(source);
    const body = {
      collection: "cmsPosts",
      document: { type: "post" },
      postSource: { id: "source", version: 7 },
      idempotencyKey: randomUUID(),
    };

    const created = await invoke(save.createCmsSaveHandler, body);

    expect(created.statusCode, JSON.stringify(created.body)).toBe(200);
    const draft = created.body.document;
    expect(draft).toMatchObject({
      type: "post",
      status: "draft",
      title: "Copy of Original story",
      summary: source.summary,
      excerpt: source.excerpt,
      credits: source.credits,
      categories: source.categories,
      tags: source.tags,
      section: "watch",
      createdBy: "owner",
      version: 1,
      recordMeaningfulUpdate: false,
      showUpdatedDate: false,
    });
    for (const field of ["date", "published", "publiclyVisible", "reviewRequest", "firstPublishedAt", "lastMeaningfulUpdatedAt", "lastMeaningfulUpdatedBy"]) {
      expect(draft).not.toHaveProperty(field);
    }
    expect(draft.slug).not.toBe(source.slug);
    expect(draft.previousSlugs).toEqual([]);
    expect(draft.blocks.map(block => block.data)).toEqual(source.blocks.map(block => block.data));
    expect(draft.blocks.every(block => !block.id.startsWith("source-"))).toBe(true);
    expect((await db.doc("cmsPosts/source").get()).data()).toEqual(source);

    const replay = await invoke(save.createCmsSaveHandler, body);
    expect(replay.statusCode, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.document.id).toBe(draft.id);
    expect((await db.collection("cmsPosts").get()).size).toBe(2);
  });

  it("duplicates a legacy-ID Post that keeps an active author's byline", async () => {
    const credit = { kind: "registered", authorId: "au_00000000000000000000000000000000" };
    await db.doc(`cmsAuthorProfiles/${credit.authorId}`).set({ uid: "reporter", displayName: "Reporter", lifecycle: "active" });
    await db.doc("cmsStaffRecords/reporter").set({ status: "active" });
    await db.doc("cmsPosts/legacy:story-\u00e9").set({ ...fixture(), credits: [credit] });

    const created = await invoke(save.createCmsSaveHandler, {
      collection: "cmsPosts",
      document: { type: "post" },
      postSource: { id: "legacy:story-\u00e9", version: 7 },
      idempotencyKey: randomUUID(),
    });

    expect(created.statusCode, JSON.stringify(created.body)).toBe(200);
    expect(created.body.document.credits).toEqual([credit]);
    expect((await db.doc(`cmsPosts/${created.body.document.id}`).get()).data().credits).toEqual([credit]);
  });

  it.each([
    ["inactive", /no longer active/],
    ["archived", /no longer active/],
    ["missing", /do not recognize/],
  ])("refuses duplicating a Post that credits a registered author who is %s", async (state, error) => {
    const credit = { kind: "registered", authorId: "au_00000000000000000000000000000000" };
    const source = { ...fixture(), credits: [credit] };
    await db.doc("cmsPosts/legacy:story-\u00e9").set(source);
    if (state !== "missing") {
      await db.doc(`cmsAuthorProfiles/${credit.authorId}`).set({ uid: "reporter", displayName: "Reporter", lifecycle: state === "archived" ? "archived" : "active" });
      await db.doc("cmsStaffRecords/reporter").set({ status: state === "inactive" ? "inactive" : "active" });
    }

    const created = await invoke(save.createCmsSaveHandler, {
      collection: "cmsPosts",
      document: { type: "post" },
      postSource: { id: "legacy:story-\u00e9", version: 7 },
      idempotencyKey: randomUUID(),
    });

    expect(created.statusCode, JSON.stringify(created.body)).toBe(400);
    expect(created.body.error).toMatch(error);
    expect((await db.collection("cmsPosts").get()).size).toBe(2);
    expect((await db.doc("cmsPosts/legacy:story-\u00e9").get()).data()).toEqual(source);
  });

  it("refuses stale, unavailable, inaccessible and changed Post duplicate sources", async () => {
    const request = {
      collection: "cmsPosts",
      document: { type: "post" },
      postSource: { id: "source", version: 6 },
      idempotencyKey: randomUUID(),
    };
    expect((await invoke(save.createCmsSaveHandler, request)).statusCode).toBe(409);
    expect((await invoke(save.createCmsSaveHandler, { ...request, postSource: { id: "missing", version: 1 }, idempotencyKey: randomUUID() })).statusCode).toBe(404);
    expect((await invoke(save.createCmsSaveHandler, { ...request, postSource: { id: "source", version: 7 }, idempotencyKey: randomUUID() }, scoped("other", "support"))).statusCode).toBe(403);

    const first = await invoke(save.createCmsSaveHandler, { ...request, postSource: { id: "source", version: 7 }, idempotencyKey: randomUUID() });
    expect(first.statusCode).toBe(200);
    await db.doc("cmsPosts/source").update({ version: 8, title: "Changed source" });
    expect((await invoke(save.createCmsSaveHandler, { ...request, postSource: { id: "source", version: 7 }, idempotencyKey: randomUUID() })).statusCode).toBe(409);
  });

  it("keeps restricted source content out of broader lists and prevents direct use", async () => {
    const template = await captured({ mode: "layout" });
    const outsider = scoped("other", "support");
    expect((await api({ action: "list" }, outsider)).body.templates).toEqual([]);
    expect((await api({ action: "get", id: template.id }, outsider)).statusCode).toBe(403);
    expect((await api(captureRequest(), outsider)).statusCode).toBe(403);
    const result = await invoke(save.createCmsSaveHandler, { collection: "cmsPosts", document: { type: "post", title: "Copy" }, postTemplate: { id: template.id, version: 1 }, idempotencyKey: randomUUID() }, outsider);
    expect(result.statusCode).toBe(403);
    expect((await api({ action: "list" }, scoped("author", "watch", "contributor"))).body.templates).toHaveLength(1);
    expect((await api({ action: "list" }, scoped("stranger", "watch", "contributor"))).body.templates).toEqual([]);
  });

  it("does not let inaccessible templates disable another user's library", async () => {
    let batch = db.batch();
    for (let index = 0; index <= 500; index += 1) {
      batch.set(db.doc(`cmsPostTemplates/private-${String(index).padStart(3, "0")}`), {
        schemaVersion: 1, version: 1, name: `Blocked ${index}`, description: "",
        retired: false, createdBy: "attacker", createdAt: "2026-09-16T00:00:00.000Z",
        updatedBy: "attacker", updatedAt: "2026-09-16T00:00:00.000Z",
        sourceResource: { ownerId: "attacker", section: "support" },
      });
      if (index === 499) {
        await batch.commit();
        batch = db.batch();
      }
    }
    await batch.commit();
    await db.doc("cmsPostTemplates/z-visible").set({
      schemaVersion: 1, version: 1, name: "Visible", description: "", mode: "layout",
      retired: false, createdBy: "author", createdAt: "2026-09-16T00:00:00.000Z",
      updatedBy: "author", updatedAt: "2026-09-16T00:00:00.000Z",
      sourceResource: { ownerId: "author", section: "watch" },
    });

    const result = await api({ action: "list" }, scoped("author", "watch", "contributor"));

    expect(result.statusCode, JSON.stringify(result.body)).toBe(200);
    expect(result.body.templates).toEqual([expect.objectContaining({ id: "z-visible" })]);
    expect(result.body.hasMore).toBe(false);
    expect(log.error).not.toHaveBeenCalled();

    const adminResult = await api({ action: "list" });
    expect(adminResult.statusCode, JSON.stringify(adminResult.body)).toBe(200);
    expect(adminResult.body.templates).toHaveLength(500);
    expect(adminResult.body.hasMore).toBe(true);
    expect(adminResult.body.nextCursor).toBeTypeOf("string");
    const nextPage = await api({ action: "list", cursor: adminResult.body.nextCursor });
    expect(nextPage.statusCode, JSON.stringify(nextPage.body)).toBe(200);
    expect(nextPage.body.templates).toHaveLength(2);
    expect(nextPage.body.hasMore).toBe(false);
    expect(nextPage.body).not.toHaveProperty("nextCursor");
  });

  it("limits each actor's template records without breaking request replay", async () => {
    const request = captureRequest({ mode: "layout" });
    expect((await api(request)).statusCode).toBe(200);
    const batch = db.batch();
    for (let index = 0; index < 98; index += 1) {
      batch.set(db.doc(`cmsPostTemplates/quota-${String(index).padStart(2, "0")}`), {
        schemaVersion: 1, version: 1, name: `Quota ${index}`, description: "",
        retired: false, createdBy: "owner", createdAt: "2026-09-16T00:00:00.000Z",
        updatedBy: "owner", updatedAt: "2026-09-16T00:00:00.000Z",
        sourceResource: { ownerId: "owner", section: "watch" },
      });
    }
    await batch.commit();

    const replay = await api(request);
    expect(replay.statusCode, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body.replayed).toBe(true);
    const attempts = await Promise.all([
      api(captureRequest({ mode: "layout" })),
      api(captureRequest({ mode: "layout" })),
    ]);
    expect(attempts.map(result => result.statusCode).sort()).toEqual([200, 409]);
    const overQuota = attempts.find(result => result.statusCode === 409);
    expect(overQuota.statusCode).toBe(409);
    expect(overQuota.body.error).toMatch(/100 templates/);
    expect((await db.collection("cmsPostTemplates").get()).size).toBe(100);
  });

  it("edits, clears and removes captured lead media from template tombstones", async () => {
    const leadMedia = { kind: "image", data: { assetId: "photo", alt: "Template lead", caption: "Credit" } };
    await db.doc("cmsPosts/source").set({ ...fixture(), leadMedia });
    const template = await captured();
    const loaded = await api({ action: "get", id: template.id });
    expect(loaded.body.document.leadMedia).toEqual(leadMedia);
    const cleared = await api({ action: "update", id: template.id, baseVersion: template.version,
      document: { ...loaded.body.document, leadMedia: null }, idempotencyKey: randomUUID() });
    expect(cleared.statusCode, JSON.stringify(cleared.body)).toBe(200);
    expect((await db.doc(`cmsPostTemplates/${template.id}`).get()).data().leadMedia).toBeNull();
    const restored = await api({ action: "update", id: template.id, baseVersion: cleared.body.template.version,
      document: { ...loaded.body.document, leadMedia }, idempotencyKey: randomUUID() });
    expect(restored.statusCode, JSON.stringify(restored.body)).toBe(200);
    const removed = await api({ action: "remove", id: template.id, baseVersion: restored.body.template.version, idempotencyKey: randomUUID() });
    expect(removed.statusCode, JSON.stringify(removed.body)).toBe(200);
    expect((await db.doc(`cmsPostTemplates/${template.id}`).get()).data()).not.toHaveProperty("leadMedia");
  });

  it.each(["Updated lead image credit", ""])("saves and reuses a template hero caption of %j", async caption => {
    const source = { ...fixture(), heroImageCaption: "Original lead image credit" };
    await db.doc("cmsPosts/source").set(source);
    const template = await captured();
    const loaded = await api({ action: "get", id: template.id });
    expect(loaded.statusCode, JSON.stringify(loaded.body)).toBe(200);
    expect(loaded.body.document.heroImageCaption).toBe(source.heroImageCaption);

    const update = await api({
      action: "update", id: template.id, baseVersion: template.version,
      document: { ...loaded.body.document, heroImageCaption: caption },
      idempotencyKey: randomUUID(),
    });

    expect(update.statusCode, JSON.stringify(update.body)).toBe(200);
    expect(update.body.template.version).toBe(2);
    expect((await db.doc(`cmsPostTemplates/${template.id}`).get()).data().heroImageCaption).toBe(caption);
    const reopened = await api({ action: "get", id: template.id });
    expect(reopened.statusCode, JSON.stringify(reopened.body)).toBe(200);
    expect(reopened.body.document).toEqual({ ...loaded.body.document, heroImageCaption: caption });
    const draft = await invoke(save.createCmsSaveHandler, {
      collection: "cmsPosts", document: { type: "post" },
      postTemplate: { id: template.id, version: update.body.template.version },
      idempotencyKey: randomUUID(),
    });
    expect(draft.statusCode, JSON.stringify(draft.body)).toBe(200);
    expect(draft.body.document.heroImageCaption).toBe(caption);
    expect((await db.doc(`cmsPosts/${draft.body.document.id}`).get()).data().heroImageCaption).toBe(caption);
    const removed = await api({
      action: "remove", id: template.id, baseVersion: update.body.template.version,
      idempotencyKey: randomUUID(),
    });
    expect(removed.statusCode, JSON.stringify(removed.body)).toBe(200);
    expect((await db.doc(`cmsPostTemplates/${template.id}`).get()).data()).not.toHaveProperty("heroImageCaption");
    expect((await db.doc(`cmsPosts/${draft.body.document.id}`).get()).data().heroImageCaption).toBe(caption);
    expect((await db.doc("cmsPosts/source").get()).data()).toEqual(source);
  });

  it.each([
    ["invalid caption", { heroImageCaption: 42 }, 409],
    ["unknown field", { unexpectedCaption: "Credit" }, 400],
  ])("rejects a template %s without saving changes", async (_label, fields, status) => {
    const template = await captured();
    const loaded = await api({ action: "get", id: template.id });
    expect(loaded.statusCode, JSON.stringify(loaded.body)).toBe(200);
    const ref = db.doc(`cmsPostTemplates/${template.id}`);
    const before = (await ref.get()).data();

    const result = await api({
      action: "update", id: template.id, baseVersion: template.version,
      document: { ...loaded.body.document, ...fields }, idempotencyKey: randomUUID(),
    });

    expect(result.statusCode, JSON.stringify(result.body)).toBe(status);
    expect((await ref.get()).data()).toEqual(before);
    expect((await ref.collection("requests").get()).size).toBe(1);
    expect((await db.collection("admin_logs").get()).size).toBe(1);
  });

  it("edits the reusable snapshot with a version check and leaves prior drafts independent", async () => {
    const template = await captured({ mode: "layout" });
    const body = { collection: "cmsPosts", document: { type: "post" }, postTemplate: { id: template.id, version: 1 }, idempotencyKey: randomUUID() };
    const draft = await invoke(save.createCmsSaveHandler, body);
    expect(draft.statusCode, JSON.stringify(draft.body)).toBe(200);
    const loaded = await api({ action: "get", id: template.id });
    const edited = loaded.body.document;
    edited.blocks[1].data.content = richText("Updated reusable heading");
    const update = await api({ action: "update", id: template.id, baseVersion: 1, document: edited, idempotencyKey: randomUUID() });
    expect(update.statusCode, JSON.stringify(update.body)).toBe(200);
    expect(update.body.template).toMatchObject({ version: 2, mode: "content" });
    expect((await db.doc(`cmsPosts/${draft.body.document.id}`).get()).data().blocks[1].data.content).not.toEqual(edited.blocks[1].data.content);
    expect((await invoke(save.createCmsSaveHandler, { ...body, idempotencyKey: randomUUID() })).statusCode).toBe(409);
    // The original request still has one result even after template edits/removal.
    expect((await invoke(save.createCmsSaveHandler, body)).body.document.id).toBe(draft.body.document.id);
    const removed = await api({ action: "remove", id: template.id, baseVersion: 2, idempotencyKey: randomUUID() });
    expect(removed.statusCode).toBe(200);
    expect((await invoke(save.createCmsSaveHandler, body)).body.document.id).toBe(draft.body.document.id);
    expect((await db.doc("cmsPosts/source").get()).data()).toEqual(fixture());
  });

  it("rejects incompatible snapshots and serializes concurrent repeat capture requests", async () => {
    const request = captureRequest({ mode: "layout" });
    const results = await Promise.all([api(request), api(request)]);
    expect(results.map(result => result.statusCode)).toEqual([200, 200]);
    expect((await db.collection("cmsPostTemplates").get()).size).toBe(1);
    const template = results[0].body.template;
    await db.doc(`cmsPostTemplates/${template.id}`).update({ schemaVersion: 2 });
    expect((await api({ action: "get", id: template.id })).statusCode).toBe(409);
    const result = await invoke(save.createCmsSaveHandler, { collection: "cmsPosts", document: { type: "post" }, postTemplate: { id: template.id, version: 1 }, idempotencyKey: randomUUID() });
    expect(result.statusCode).toBe(409);
    expect((await db.collection("cmsPosts").get()).size).toBe(1);
    // The two captures contend for one Firestore transaction. Emulator retry backoff
    // can pass the 5-second default on a busy runner (#2432).
  }, 20_000);

  it("allows scoped Editors' site-wide media and rejects inaccessible, missing and no-longer-ready media during capture and use", async () => {
    expect((await api(captureRequest(), scoped("editor", "watch"))).statusCode).toBe(200);
    const denied = await api(captureRequest(), scoped("author", "watch", "contributor"));
    expect(denied.statusCode).toBe(403);
    expect(denied.body.error).toMatch(/Media asset photo is restricted/);
    const template = await captured();
    const body = { collection: "cmsPosts", document: { type: "post", title: "Copy" }, postTemplate: { id: template.id, version: 1 }, idempotencyKey: randomUUID() };
    await db.doc("media_assets/photo").update({ lifecycle: "binned" });
    expect((await api(captureRequest())).statusCode).toBe(409);
    expect((await invoke(save.createCmsSaveHandler, body)).statusCode).toBe(409);
    await db.doc("media_assets/photo").delete();
    const missingMedia = await api(captureRequest());
    expect(missingMedia.statusCode).toBe(409);
    expect(missingMedia.body).not.toHaveProperty("code");
    const repair = await api({ action: "get", id: template.id });
    expect(repair.statusCode).toBe(200);
    expect(repair.body.mediaWarning).toContain("photo");
    expect(repair.body.document.heroImage).toBe("photo");
    expect((await invoke(save.createCmsSaveHandler, body)).statusCode).toBe(409);
    // Layout-only snapshots no longer refer to these assets.
    expect((await api(captureRequest({ mode: "layout" }))).statusCode).toBe(200);
  });

  it("handles capture retries, source conflicts, edit conflicts, retirement and removal without changing source or assets", async () => {
    const request = captureRequest();
    const first = await api(request);
    expect(first.statusCode, JSON.stringify(first.body)).toBe(200);
    const template = first.body.template;
    expect((await api(request)).body.replayed).toBe(true);
    expect((await api({ ...request, name: "Changed retry" })).statusCode).toBe(409);
    expect((await api(captureRequest({ sourceVersion: 6 }))).statusCode).toBe(409);
    const update = { action: "update", id: template.id, baseVersion: 1, name: "Renamed", retired: true, idempotencyKey: randomUUID() };
    expect((await api(update)).body.template).toMatchObject({ name: "Renamed", retired: true, version: 2 });
    expect((await api(update)).body.replayed).toBe(true);
    const staleUpdate = await api({ ...update, idempotencyKey: randomUUID() });
    expect(staleUpdate.statusCode).toBe(409);
    expect(staleUpdate.body.code).toBe("post_template_conflict");
    const create = { collection: "cmsPosts", document: { type: "post" }, postTemplate: { id: template.id, version: 2 }, idempotencyKey: randomUUID() };
    expect((await invoke(save.createCmsSaveHandler, create)).statusCode).toBe(409);
    const remove = { action: "remove", id: template.id, baseVersion: 2, idempotencyKey: randomUUID() };
    expect((await api(remove)).body.removed).toBe(true);
    expect((await api(remove)).body.replayed).toBe(true);
    expect((await api({ action: "list" })).body.templates).toEqual([]);
    expect((await db.doc(`cmsPostTemplates/${template.id}/mediaUsage/working`).get()).data().assetIds).toEqual([]);
    expect((await db.doc("media_assets/photo").get()).exists).toBe(true);
    expect((await db.doc("cmsPosts/source").get()).data()).toEqual(fixture());
  });
});
