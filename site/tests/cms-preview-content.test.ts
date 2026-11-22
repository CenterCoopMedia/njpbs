// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { assertPublicArtifactBundle } from "../src/lib/public-artifact-bundle";
import { cmsPagesLoader, projectCmsPage } from "../src/lib/cms-loader";
import { cmsPostsLoader, projectCmsPost } from "../src/lib/cms-posts-loader";
import { cmsAuthorsLoader } from "../src/lib/cms-authors-loader";
import { cmsProgramsLoader } from "../src/lib/cms-programs-loader";
import { publicHomepageBannerLoader } from "../src/lib/public-homepage-banner";
import { resolveHomeHeroItems } from "../src/lib/home-hero-items";
import { createPublicArtifactInventoryReceipt } from "../src/lib/public-artifact-inventory";
import {
  createCmsPreviewContentSource,
  projectCmsPreviewContent,
} from "../src/lib/cms-preview-content";

import { now, rendererSha, blocks, input, fixture, reservation } from "./fixtures/cms-preview-content";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
afterEach(() => vi.unstubAllEnvs());

describe("request-scoped preview content", () => {
  it.each([[true, "contact", false], [false, "contact", false], [true, `page-${"2".repeat(32)}`, false], [false, `page-${"2".repeat(32)}`, false], [true, "contact", true]] as const)("uses fresh Page pin dependencies instead of the retained bundle (available=%s, Page=%s)", (available, pageId, clearedImage) => {
    const config = { mode: "tag", source: "cms_posts", value: "home", pins: [{ source: "cms_pages", sourceId: pageId }] };
    const page = (title: string) => projectCmsPage({ id: pageId, status: "published", publishAt: now.toISOString(),
      published: { sourceVersion: 2, publishedAt: now.toISOString(), blocks: [], metadata: { title, description: "Published summary", slug: "renamed-page" } },
    }, { mode: "published", now, assets: new Map() })!;
    const stale = page("Withdrawn retained title");
    const fresh = page("Newly published title");
    if (clearedImage) fresh.heroBackgroundImage = "";
    const value = input();
    value.pageId = "home";
    value.snapshot = { id: "home", version: 7, template: "home", title: "Home draft", blocks: [], homeHero: config } as typeof value.snapshot;
    const context = { ...value.publicContext, pages: [stale], receipt: createPublicArtifactInventoryReceipt({
      reservation, pages: [{ documentId: pageId, sourceVersion: 2, publishedSnapshot: {
        sourceVersion: 2, publishedAt: now.toISOString(), metadata: { title: stale.title, description: stale.description, slug: "renamed-page" }, blocks: [],
      } }], posts: [], programs: [], authors: [], settings: [],
    }) };
    const current = { ...value, publicContext: context, homeHeroPages: available ? [fresh] : [] };
    const sealed = fixture(current);
    const content = projectCmsPreviewContent(sealed.bytes, sealed.request, now);
    const home = content.pages.find(page => page.pageId === "home")!;
    const cards = resolveHomeHeroItems(home.homeHero, content.homeSources, content.posts, home.assets, content.authors,
      content.homeHeroPages ?? content.pages, now.getTime());
    expect(cards.map(card => card.title)).toEqual(available ? ["Newly published title"] : []);
    expect(content.publicContextReceipt).toEqual(context.receipt);
    expect(Object.isFrozen(content.homeHeroPages)).toBe(true);
  });

  it.each(["draft", "unselected", "duplicate", "version", "destination", "media", "title", "image-dimensions", "pdf-image", "custom-link", "other-target"])("rejects invalid private Home Page pin dependencies: %s", failure => {
    const page = projectCmsPage({ id: "contact", status: "published", publishAt: now.toISOString(),
      published: { sourceVersion: 2, publishedAt: now.toISOString(), blocks: [], metadata: { title: "Contact" } },
    }, { mode: "published", now, assets: new Map() })!;
    const value = input();
    value.pageId = "home";
    value.snapshot = { id: "home", version: 7, template: "home", title: "Home draft", blocks: [], homeHero: {
      mode: "tag", source: "cms_posts", value: "home", pins: [{ source: "cms_pages", sourceId: "contact" }],
    } } as typeof value.snapshot;
    const invalid = { ...value, homeHeroPages: [page] };
    if (failure === "draft") page.contentMode = "draft";
    if (failure === "unselected") page.pageId = "about";
    if (failure === "duplicate") invalid.homeHeroPages.push(page);
    if (failure === "version") page.sourceVersion = 0;
    if (failure === "destination") page.path = "https://private.example.test/";
    if (failure === "media") { page.heroBackgroundImage = "bad"; page.assets.bad = { url: "https://private.example.test/image", mimeType: "image/webp", width: 640, height: 360 }; }
    if (failure === "title") page.title = 7 as unknown as string;
    if (failure === "image-dimensions") page.assets.bad = { url: "https://media.njpbs.org/cms-media/image.webp", mimeType: "image/webp", width: 0, height: 360 };
    if (failure === "pdf-image") { page.heroBackgroundImage = "document"; page.assets.document = { url: "https://media.njpbs.org/cms-media/notice.pdf", mimeType: "application/pdf" }; }
    if (failure === "custom-link") { page.contentLinkMode = "custom"; page.contentLinkUrl = "javascript:alert(1)"; }
    if (failure === "other-target") { invalid.pageId = "contact"; invalid.snapshot.id = "contact"; }
    const sealed = fixture(invalid);
    expect(() => projectCmsPreviewContent(sealed.bytes, sealed.request, now)).toThrow();
  });

  it("overlays only the addressed Program and freezes its key art into the private projection", () => {
    const template = input("cmsPosts");
    const value = { ...template, snapshot: { ...template.snapshot, published: { ...template.snapshot.published!, metadata: {
      type: "program", title: "Draft Program", slug: "draft-program", previousSlugs: [], locale: "en",
      description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Private synopsis" }] }] },
      keyArtAssetId: "draft-art", keyArtAlt: "Draft artwork", memberOnly: false,
    } } }, assets: [{ id: "draft-art", url: "https://media.njpbs.org/cms-media/draft-art.webp", mimeType: "image/webp", width: 640, height: 360 }] };
    const bytes = Buffer.from(JSON.stringify(value));
    const request = { ...fixture(template).request, sha256: createHash("sha256").update(bytes).digest("hex") };
    const result = projectCmsPreviewContent(bytes, request, now);
    expect(result.target.pagePath).toBe("/programs/draft-program/");
    expect(result.programs).toHaveLength(1);
    expect(result.programs[0]).toMatchObject({ programId: "post-one", sourceVersion: 7, title: "Draft Program", keyArt: { url: "https://media.njpbs.org/cms-media/draft-art.webp" } });
    expect(result.posts).toEqual(value.publicContext.posts);
    expect(result.publicContextReceipt).toEqual(value.publicContext.receipt);
    expect(Object.isFrozen(result.programs[0].description)).toBe(true);
  });

  it("renders a private library overlay while preserving the verified public context", () => {
    const card = { kind: "newsletter", id: "newsletter", title: "Draft newsletter", href: null, sourceVersion: 2,
      newsletter: { card: { title: "Draft newsletter", signupUrl: "https://draft.example.test/join" } } };
    const value = { ...input(), draftLibraryCards: { recordIds: ["newsletter"], cards: [card] } };
    const { bytes, request } = fixture(value);
    const result = projectCmsPreviewContent(bytes, request, now);
    expect(result.recordCards).toEqual([card]);
    expect(result.publicContextReceipt).toEqual(value.publicContext.receipt);
    const projected = result.recordCards[0];
    if (projected.kind !== "newsletter") throw new Error("Expected the private newsletter");
    expect(Object.isFrozen(projected.newsletter?.card)).toBe(true);
    expect(value.publicContext).not.toHaveProperty("recordCards");
    expect(() => assertPublicArtifactBundle({ ...value.publicContext, draftLibraryCards: value.draftLibraryCards })).toThrow();
    expect(() => assertPublicArtifactBundle({ ...value.publicContext, recordCards: [card] })).toThrow(/coverage/);
  });

  it.each([
    { recordIds: ["newsletter", "newsletter"], cards: [] },
    { recordIds: ["../private"], cards: [] },
    { recordIds: ["newsletter"], cards: [{ kind: "program", id: "newsletter", title: "Program", href: "/programs/test/" }] },
    { recordIds: [], cards: [{ kind: "newsletter", id: "newsletter", title: "Newsletter", href: null }] },
    { recordIds: ["newsletter"], cards: [{ kind: "newsletter", id: "newsletter", title: "Newsletter", href: null,
      newsletter: { card: { title: "Newsletter", signupUrl: "javascript:alert(1)" } } }] },
  ])("rejects malformed or non-library private card overlays: %j", draftLibraryCards => {
    const value = { ...input(), draftLibraryCards };
    const { bytes, request } = fixture(value);
    expect(() => projectCmsPreviewContent(bytes, request, now)).toThrow();
  });

  it.each(["cmsPages", "cmsPosts"] as const)("reuses the existing %s projection from bytes without a file or environment", kind => {
    const { value, bytes, request } = fixture(input(kind));
    const result = projectCmsPreviewContent(bytes, request, now);
    const expected = kind === "cmsPages"
      ? projectCmsPage(value.snapshot, { mode: "draft", pageId: "contact", now, assets: new Map() })
      : { ...projectCmsPost({ id: value.pageId, status: "published",
        published: value.snapshot.published, publishAt: now.toISOString() },
      { now, assets: new Map(), complete: false }), noindex: true };
    expect(result.kind).toBe("private-preview");
    expect(kind === "cmsPages" ? result.pages : result.posts).toEqual([expected]);
    expect(result.target).toMatchObject({
      collection: kind, documentId: value.pageId, sourceVersion: 7,
      rendererSha, queueId: value.queueId, inputSha256: request.sha256,
      pagePath: kind === "cmsPages" ? "/contact/" : "/posts/exact-story/",
    });
    expect(() => assertPublicArtifactBundle(result)).toThrow();
    expect(JSON.stringify(value.publicContext)).not.toContain("Exact draft");
  });

  it("coalesces overlapping reads only within the source that owns them", async () => {
    const f = fixture();
    const read = vi.fn(async () => f.bytes);
    const source = createCmsPreviewContentSource(f.request, { read, now: () => now })!;
    expect(read).not.toHaveBeenCalled();
    const results = await Promise.all(Array.from({ length: 5 }, () => source.load()));
    expect(read).toHaveBeenCalledExactlyOnceWith("/private/input.json");
    expect(results.every(result => result === results[0])).toBe(true);
    expect(Object.isFrozen(results[0].pages[0].blocks[0].data)).toBe(true);
    expect(() => { results[0].pages[0].title = "Changed"; }).toThrow();
    expect(() => { results[0].pages[0].blocks.push({} as never); }).toThrow();
  });

  it("connects all five existing loaders to one validated input", async () => {
    const f = fixture();
    const read = vi.fn(async () => f.bytes);
    const source = createCmsPreviewContentSource(f.request, { read, now: () => now })!;
    const factories = [cmsPagesLoader, cmsPostsLoader, cmsAuthorsLoader, cmsProgramsLoader, publicHomepageBannerLoader];
    const outputs = await Promise.all(factories.map(async factory => {
      const loader = factory(source);
      const values: Array<{ id: string; data: unknown }> = [];
      await loader.load({
        store: { clear: vi.fn(), set: (entry: typeof values[number]) => values.push(entry) },
        logger: { info: vi.fn() }, parseData: async ({ data }: { data: unknown }) => data,
      } as never);
      expect(loader.name).toContain(f.request.sha256);
      return values;
    }));
    expect(read).toHaveBeenCalledTimes(1);
    expect(outputs[0][0]).toMatchObject({ id: "contact", data: { title: "Exact draft", contentMode: "draft" } });
    expect(outputs.slice(1)).toEqual([[], [], [], []]);
  });

  it("does not share a path-only cache between concurrent documents or versions", async () => {
    const a = fixture(input("cmsPages", "Draft A", "A".repeat(20)));
    const b = fixture(input("cmsPosts", "Draft B", "B".repeat(20)));
    const first = deferred<Uint8Array>();
    const second = deferred<Uint8Array>();
    const sa = createCmsPreviewContentSource(a.request, { read: () => first.promise, now: () => now })!;
    const sb = createCmsPreviewContentSource(b.request, { read: () => second.promise, now: () => now })!;
    const pa = sa.load(); const pb = sb.load();
    second.resolve(b.bytes); first.resolve(a.bytes);
    const [ra, rb] = await Promise.all([pa, pb]);
    expect(ra.pages[0].title).toBe("Draft A");
    expect(rb.posts[0].title).toBe("Draft B");
    expect(ra.posts).toEqual([]);
    expect(rb.pages).toEqual([]);
    expect(JSON.stringify(ra)).not.toContain("Draft B");
    expect(JSON.stringify(rb)).not.toContain("Draft A");
  });

  it("copies request identity before any asynchronous work", async () => {
    const f = fixture();
    const source = createCmsPreviewContentSource(f.request, { read: async () => f.bytes, now: () => now })!;
    f.request.queueId = "Z".repeat(20); f.request.sha256 = "0".repeat(64);
    expect((await source.load()).target.queueId).toBe("Q".repeat(20));
    expect(Object.isFrozen(source.request)).toBe(true);
  });

  it("does not keep a cached draft usable after its expiry", async () => {
    const f = fixture();
    let instant = now;
    const read = vi.fn(async () => f.bytes);
    const source = createCmsPreviewContentSource(f.request, { read, now: () => instant })!;
    await source.load();
    instant = new Date(f.value.expiresAtMs);
    await expect(source.load()).rejects.toThrow(/expiry|expired/i);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("rejects input that expires while its bytes are being read", async () => {
    const f = fixture();
    let instant = now;
    const gate = deferred<Uint8Array>();
    const source = createCmsPreviewContentSource(f.request, { read: () => gate.promise, now: () => instant })!;
    const pending = source.load();
    instant = new Date(f.value.expiresAtMs);
    gate.resolve(f.bytes);
    await expect(pending).rejects.toThrow(/expiry|expired/i);
  });

  it("never substitutes a preceding source after a digest failure", async () => {
    const a = fixture();
    const b = fixture(input("cmsPages", "Different draft", "B".repeat(20)));
    await createCmsPreviewContentSource(a.request, { read: async () => a.bytes, now: () => now })!.load();
    const read = vi.fn(async () => a.bytes);
    const source = createCmsPreviewContentSource(b.request, { read, now: () => now })!;
    const attempts = await Promise.allSettled([source.load(), source.load()]);
    expect(attempts.every(result => result.status === "rejected")).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("preserves an input failure for the owning source without reading a database or another file", async () => {
    const f = fixture();
    const read = vi.fn(async () => { throw new Error("Input unavailable"); });
    const source = createCmsPreviewContentSource(f.request, { read, now: () => now })!;
    await expect(source.load()).rejects.toThrow("Input unavailable");
    await expect(source.load()).rejects.toThrow("Input unavailable");
    expect(read).toHaveBeenCalledExactlyOnceWith(f.request.path);
  });

  it.each(["queueId", "pageId", "rendererSha"] as const)("refuses an input with a different %s", field => {
    const f = fixture();
    const request = { ...f.request, [field]: field === "pageId" ? "about" : "c".repeat(field === "rendererSha" ? 40 : 20) };
    expect(() => projectCmsPreviewContent(f.bytes, request, now)).toThrow(/identity/i);
  });

  it("refuses a Post whose nested projected version differs from the envelope", () => {
    const value = input("cmsPosts");
    value.snapshot.published!.sourceVersion = 6;
    const f = fixture(value);
    expect(() => projectCmsPreviewContent(f.bytes, f.request, now)).toThrow(/version/i);
  });

  it("rejects invalid content instead of caching a partial projection", async () => {
    const value = input();
    value.snapshot.blocks = [{ ...blocks[0], type: "does_not_exist" }];
    const f = fixture(value);
    await expect(createCmsPreviewContentSource(f.request, { read: async () => f.bytes, now: () => now })!.load())
      .rejects.toThrow();
  });

  it.each([
    { queueId: "../invalid" },
    { rendererSha: "not-a-reviewed-sha" },
    { collection: "cmsUsers" },
    { persistent: false },
  ])("validates explicit caller identity before projecting bytes: %j", badIdentity => {
    const f = fixture();
    expect(() => projectCmsPreviewContent(f.bytes, { ...f.request, ...badIdentity } as never, now)).toThrow();
  });

  it("refuses noncanonical identity even when the bytes repeat the same whitespace", () => {
    const f = fixture(input("cmsPages", "Exact draft", " " + "Q".repeat(20)));
    expect(() => projectCmsPreviewContent(f.bytes, {
      ...f.request, queueId: f.value.queueId,
    }, now)).toThrow(/identity/i);
  });

  it("records the test-only template check in ordinary Site CI", async () => {
    const workflow = await readFile(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    expect(workflow).toContain("run: npm run test:preview-content");
    expect(manifest.scripts["test:preview-content"]).toContain("vitest.preview-content.config.ts");
  });

  it("leaves ordinary published builds without a preview source", () => {
    expect(createCmsPreviewContentSource(null)).toBeNull();
  });

  it("requires a valid clock even for previously cached content", async () => {
    const f = fixture();
    let instant = now;
    const source = createCmsPreviewContentSource(f.request, { read: async () => f.bytes, now: () => instant })!;
    await source.load(); instant = new Date(NaN);
    await expect(source.load()).rejects.toThrow();
  });

  it("wires exactly one source into the real content configuration", async () => {
    const config = await readFile(new URL("../src/content.config.ts", import.meta.url), "utf8");
    expect(config.match(/createCmsPreviewContentSource\(\)/g)).toHaveLength(1);
    for (const loader of ["cmsPagesLoader", "cmsPostsLoader", "cmsProgramsLoader", "cmsAuthorsLoader", "publicHomepageBannerLoader"]) {
      expect(config).toContain(`${loader}(previewContent)`);
    }
  });
});

 it("retains the sealed Data Hub source pool for draft query selection",()=>{
   const template=input();
   const dataHubSources={cutoffAt:now.toISOString(),posts:[],spotlight:{schemaVersion:1,queries:{},pins:{key:"",checkedAt:null,failed:false,stories:[]}}};
   const value={...template,pageId:"data-hub",snapshot:{id:"data-hub",version:7,template:"genericPage",title:"Draft Data Hub",blocks:[],
     dataHubReporting:{schemaVersion:1,figures:{},featured:{inheritFigure:true}}},dataHubSources};
   const bytes=Buffer.from(JSON.stringify(value));const request={...fixture(template).request,pageId:"data-hub",sha256:createHash("sha256").update(bytes).digest("hex")};
   const projected=projectCmsPreviewContent(bytes,request,now);
   expect(projected.target.pagePath).toBe("/data-hub/");expect(projected.dataHubSources).toEqual(dataHubSources);
   expect(Object.isFrozen(projected.dataHubSources)).toBe(true);
 });
