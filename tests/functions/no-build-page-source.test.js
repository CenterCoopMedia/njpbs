import { describe, expect, it, vi } from "vitest";
import fixture from "../../site/tests/fixtures/home-composition-v1.json";
import snapshots from "../../functions/lib/publish-snapshot.js";
import projection from "../../functions/lib/public-content-projection.js";
import contract from "../../functions/lib/no-build-page-contract.js";
import source from "../../functions/lib/no-build-page-source.js";
import media from "../../functions/lib/media-contract.js";
import publicContent from "../../functions/public-content.js";
import deployment from "../../functions/lib/public-deployment.js";

const instant = "2026-10-12T05:00:00.000Z";
const now = new Date(instant);
const copy = value => structuredClone(value);
function snapshot(pageId = "contact") {
  const document = pageId === "home" ? copy(fixture) : {
    id: pageId, version: 7, title: "Published Page", blocks: [
      { id: "heading", type: "headline", order: 0, visible: true, data: { text: "Published heading", level: 2 } },
    ],
  };
  return snapshots.createPublishedSnapshot({ collection: "cmsPages", document, publishedAt: instant, publishedBy: "editor" });
}
function v2() {
  const result = snapshot("home");
  result.metadata.homeCompositionVersion = 2;
  const blocks = result.blocks;
  result.blocks = [blocks[6], blocks[3], blocks[4], blocks[0], blocks[1], blocks[5], blocks[2]]
    .map((block, order) => ({ ...block, order }));
  return result;
}
function database(page = snapshot(), extras = {}, projectId = "njpbs-site-dev") {
  const documents = {
    "system/noBuildPostAdmission": { schemaVersion: 2, revision: 4, enabled: true,
      families: { pages: { mode: "all" } }, backgroundBucket: "njpbs-dev-public-artifacts" },
    "cmsPages/contact": { status: "draft", publiclyVisible: true, version: 8,
      title: "PRIVATE working copy", blocks: [], privateNote: "PRIVATE", published: page },
    ...extras,
  };
  const reads = [];
  const read = async ref => {
    reads.push(ref.path);
    const data = documents[ref.path];
    return { exists: data !== undefined, id: ref.path.split("/").at(-1), data: () => copy(data) };
  };
  const transaction = { get: read, getAll: async (...refs) => Promise.all(refs.map(read)) };
  const firestore = { projectId, doc: path => ({ path }),
    collection: path => ({ doc: id => ({ path: `${path}/${id}` }) }),
    runTransaction: vi.fn(work => work(transaction)) };
  return { firestore, documents, reads, transaction };
}

describe("strict Page source contract", () => {
  it("maps canonical Page ownership without accepting arbitrary paths", () => {
    expect(contract.noBuildPageOwnerPath("home")).toBe("system/publicDeployment/noBuildPageOwners/home");
    expect(contract.noBuildPageOwnerPath(`page-${"a".repeat(32)}`)).toContain("noBuildPageOwners/page-");
    for (const id of ["unknown", "cmsPages/home", "__proto__", "*", "/", ["home"], { toString: () => "home" }]) {
      expect(() => contract.noBuildPageOwnerPath(id)).toThrow();
    }
  });

  it("admits complete Home v1 and whole reordered/withdrawn Home v2 sections", () => {
    expect(contract.validateNoBuildPageSnapshot({ pageId: "home", snapshot: snapshot("home") }))
      .toMatchObject({ pageId: "home", path: "/", homeSources: true });
    const value = v2();
    value.blocks.filter(block => ["home-passport-copy", "home-passport-action"].includes(block.section))
      .forEach(block => { block.visible = false; });
    expect(contract.validateNoBuildPageSnapshot({ pageId: "home", snapshot: value }).path).toBe("/");
    expect(value.blocks[0].section).toBe("home-spotlight");
  });

  it.each([
    ["missing region", value => value.blocks.pop()],
    ["duplicate region", value => value.blocks.push({ ...copy(value.blocks[0]), id: "duplicate", order: 7 })],
    ["split pair", value => { [value.blocks[2], value.blocks[3]] = [value.blocks[3], value.blocks[2]]; }],
    ["partial visibility", value => { value.blocks[1].visible = false; }],
    ["changed source", value => { value.blocks[0].data.source = "pbs_more"; }],
    ["wrong order", value => { value.blocks[0].order = 99; }],
    ["missing composition", value => { delete value.metadata.homeCompositionVersion; }],
  ])("refuses unsafe Home arrangement: %s", (_label, mutate) => {
    const value = v2(); mutate(value);
    expect(() => contract.validateNoBuildPageSnapshot({ pageId: "home", snapshot: value })).toThrow();
  });

  it("accepts valid row arrangements and refuses missing rows and template substitutions", () => {
    const value = snapshot();
    value.blocks.unshift({ id: "row", type: "row", order: 0, visible: true, data: { columns: [6, 6] } });
    value.blocks[1].order = 1;
    value.blocks[1].layout = { rowId: "row", column: 0 };
    expect(contract.validateNoBuildPageSnapshot({ pageId: "contact", snapshot: value }).path).toBe("/contact/");
    value.blocks[1].layout.rowId = "missing";
    expect(() => contract.validateNoBuildPageSnapshot({ pageId: "contact", snapshot: value })).toThrow();
    const homeShelf = copy(fixture.blocks[2]);
    expect(() => contract.validateNoBuildPageSnapshot({ pageId: "contact", snapshot: { ...snapshot(), blocks: [homeShelf] } })).toThrow();
  });

  it("bounds metadata, aliases, source versions and serialized input before projection", () => {
    for (const mutate of [
      value => { value.sourceVersion = Number.MAX_SAFE_INTEGER + 1; },
      value => { value.contentVersion = 0; },
      value => { value.metadata.renderer = "arbitrary"; },
      value => { value.metadata.seo = { noindex: "yes" }; },
      value => { value.metadata.social = { title: false }; },
      value => { value.metadata.slug = "posts"; },
      value => { value.metadata.previousSlugs = ["contact", "contact"]; },
      value => { value.metadata.previousSlugs = ["api"]; },
      value => { value.metadata.description = "x".repeat(600_000); },
      value => { value.blocks[0].layout = { rowId: "missing", column: 0 }; },
      value => { value.blocks[0].data = new Map(); },
      value => { value.blocks = Array(2); },
      value => { value.metadata.previousSlugs = Array(1); },
      value => { value.metadata.title = new Date(); },
      value => { value.metadata.title = ""; },
      value => { value.publishedAt = "2026-02-31T00:00:00Z"; },
    ]) {
      const value = snapshot(); mutate(value);
      expect(() => contract.validateNoBuildPageSnapshot({ pageId: "contact", snapshot: value })).toThrow();
    }
  });

  it("declares visible joined-record and native Home dependencies with safe stable IDs", () => {
    const value = snapshot();
    value.blocks.push({ id: "card", type: "record_card", visible: true, order: 1,
      data: { recordKind: "program", recordId: "program-a" } });
    expect(contract.validateNoBuildPageSnapshot({ pageId: "contact", snapshot: value }).recordIds).toEqual(["program-a"]);
    value.blocks[1].data.recordId = "cmsPosts/private";
    expect(() => contract.validateNoBuildPageSnapshot({ pageId: "contact", snapshot: value })).toThrow();
    const home = v2();
    home.metadata.homeHero = { mode: "manual", items: [{ itemId: "lead", source: "cms_posts", sourceId: "native-post" }] };
    expect(contract.validateNoBuildPageSnapshot({ pageId: "home", snapshot: home }).homePostIds).toEqual(["native-post"]);
  });
});

describe("development Page source reader", () => {
  it("retains unmanaged legacy snapshots and safely drops saved vendor metadata siblings", async () => {
    const legacy = database({ blocks: [{ data: { assetId: "private-legacy-asset" } }] });
    expect(await publicContent.readPublicPageProjection({ firestore: legacy.firestore, pageId: "contact", now }))
      .toEqual({ apiVersion: 1, state: "unmanaged", pageId: "contact" });
    expect(legacy.reads).toHaveLength(2);
    const value = snapshot();
    value.metadata.seo = { title: "Published SEO", vendor: { privateNote: "PRIVATE vendor value" } };
    value.metadata.social = { title: "Published share title", integration: "PRIVATE sibling" };
    const db = database(value);
    expect(contract.validateNoBuildPageSnapshot({ pageId: "contact", snapshot: value }).path).toBe("/contact/");
    const result = await publicContent.readPublicPageProjection({ firestore: db.firestore, pageId: "contact", now });
    expect(result.page.seo).toEqual({ title: "Published SEO" });
    expect(result.page.social).toEqual({ title: "Published share title" });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|vendor|integration/);
  });
  it("connects the strict selected transaction to the existing Page reader", async () => {
    const db = database();
    // Direct collection reads intentionally have no get() method. The selected
    // dev Page must reach the transaction reader through the existing endpoint.
    const result = await publicContent.readPublicPageProjection({ firestore: db.firestore, pageId: "contact", now });
    expect(result.page.title).toBe("Published Page");
    expect(db.firestore.runTransaction).toHaveBeenCalledTimes(1);
    db.documents["cmsPages/contact"].published.metadata.title = "";
    await expect(publicContent.readPublicPageProjection({ firestore: db.firestore, pageId: "contact", now })).rejects.toThrow();
  });
  it("reads admission, Page and media in one fresh transaction, exposing only published values", async () => {
    const db = database();
    const first = await source.readSelectedNoBuildPageProjection({ firestore: db.firestore, pageId: "contact", now, env: {} });
    expect(first).toEqual(projection.projectPublicPageDocument({ pageId: "contact", document: db.documents["cmsPages/contact"], assets: new Map(), now }));
    expect(JSON.stringify(first)).not.toMatch(/PRIVATE|publishedBy|families|backgroundBucket/);
    db.documents["cmsPages/contact"].published.metadata.title = "New published title";
    expect((await source.readSelectedNoBuildPageProjection({ firestore: db.firestore, pageId: "contact", now, env: {} })).page.title)
      .toBe("New published title");
    expect(db.firestore.runTransaction).toHaveBeenCalledTimes(2);
    expect(db.reads).toEqual(["system/noBuildPostAdmission", "cmsPages/contact", "system/noBuildPostAdmission", "cmsPages/contact"]);
  });

  it("preserves legacy fallback for unknown projects and keeps explicit native targets closed", async () => {
    for (const projectId of [undefined, "demo-njpbs", "other-project"]) {
      const db = database(undefined, {}, projectId);
      if (projectId === undefined) delete db.firestore.projectId;
      expect(await source.readSelectedNoBuildPageProjection({ firestore: db.firestore, pageId: "contact", now, env: {} })).toBeNull();
      expect(db.firestore.runTransaction).not.toHaveBeenCalled();
      await expect(source.readSelectedNoBuildPageProjection({ firestore: db.firestore, pageId: "contact", now, env: {},
        target: (await import("../../functions/lib/publication-target.js")).default.publicationTarget("production") })).rejects.toThrow("mixed publication database");
    }
    const production = database(undefined, {}, "njpbs-site");
    expect(await source.readSelectedNoBuildPageProjection({ firestore: production.firestore, pageId: "contact", now, env: {} })).toBeNull();
    production.documents["system/noBuildPostAdmission"].backgroundBucket = "njpbs-public-artifacts";
    expect((await source.readSelectedNoBuildPageProjection({ firestore: production.firestore, pageId: "contact", now, env: {} })).page.title).toBe("Published Page");
    for (const fields of [{ enabled: false }, { families: { pages: { mode: "ids", ids: ["home"] } } }, { revision: 0 }]) {
      const db = database(); Object.assign(db.documents["system/noBuildPostAdmission"], fields);
      expect(await source.readSelectedNoBuildPageProjection({ firestore: db.firestore, pageId: "contact", now, env: {} })).toBeNull();
      expect(db.reads).toEqual(["system/noBuildPostAdmission"]);
    }
  });

  it("preserves unmanaged and withdrawn states without reading working media", async () => {
    for (const doc of [undefined, { status: "draft", blocks: [{ data: { assetId: "private-asset" } }] },
      { publiclyVisible: false, published: snapshot() }]) {
      const db = database(undefined, { "cmsPages/contact": doc });
      const result = await source.readSelectedNoBuildPageProjection({ firestore: db.firestore, pageId: "contact", now, env: {} });
      expect(result.state).toBe(doc?.published ? "withdrawn" : "unmanaged");
      expect(db.reads).toHaveLength(2);
    }
  });

  it("requires exact public media and rejects lifecycle or in-flight replacement changes", async () => {
    const value = snapshot();
    value.metadata.heroBackgroundImage = "hero";
    const asset = { id: "hero", source: "site_seed", lifecycle: "active", kind: "image",
      url: "https://media.njpbs.org/cms-media/hero.webp", mimeType: "image/webp", width: 640, height: 360 };
    const db = database(value, { "media_assets/hero": asset, "media_assets_public/hero": media.mediaProjection(asset) });
    expect((await source.readSelectedNoBuildPageProjection({ firestore: db.firestore, pageId: "contact", now, env: {} })).page.assets.hero.url).toBe(asset.url);
    expect(db.reads).toContain("system/media/replacements/hero");
    db.documents["system/media/replacements/hero"] = { state: "pending" };
    await expect(source.readSelectedNoBuildPageProjection({ firestore: db.firestore, pageId: "contact", now, env: {} })).rejects.toThrow();
    delete db.documents["system/media/replacements/hero"];
    db.documents["media_assets_public/hero"].width = 999;
    await expect(source.readSelectedNoBuildPageProjection({ firestore: db.firestore, pageId: "contact", now, env: {} })).rejects.toThrow();
  });

  it("checks the upload deployment fence in the same transaction before exposing media", async () => {
    const value = snapshot(); value.metadata.heroBackgroundImage = "upload";
    const asset = { id: "upload", source: "upload", lifecycle: "active", kind: "image",
      url: "https://media.njpbs.org/cms-media/upload.webp", mimeType: "image/webp", width: 640, height: 360 };
    const db = database(value, { "media_assets/upload": asset, "media_assets_public/upload": media.mediaProjection(asset),
      "system/publicDeployment": { ...deployment.initialPublicDeploymentPointer(), mediaLifecycleReady: true,
        activeGeneration: 1, activeDeploymentId: "dev-baseline", activeCommitSha: "a".repeat(40),
        newestEligibleGeneration: 1, lastReservedGeneration: 1, newestEligibleBuildBatchId: "baseline" } });
    expect((await source.readSelectedNoBuildPageProjection({ firestore: db.firestore, pageId: "contact", now, env: {} })).page.assets.upload.url).toBe(asset.url);
    expect(db.reads.at(-1)).toBe("system/publicDeployment");
    db.documents["system/publicDeployment"].mediaLifecycleReady = false;
    await expect(source.readSelectedNoBuildPageProjection({ firestore: db.firestore, pageId: "contact", now, env: {} })).rejects.toThrow();
  });

  it("does not hide an invalid selected snapshot behind the ordinary reader", async () => {
    const db = database(); db.documents["cmsPages/contact"].published.metadata.title = "";
    await expect(source.readSelectedNoBuildPageProjection({ firestore: db.firestore, pageId: "contact", now, env: {} })).rejects.toThrow();
  });
});
