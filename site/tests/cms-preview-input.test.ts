// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cmsPagesLoader, type CmsPageBuildData } from "../src/lib/cms-loader";
import { readCmsPreviewInput, resolveCmsPreviewInput } from "../src/lib/cms-preview-input";
import { cmsPostsLoader } from "../src/lib/cms-posts-loader";
import { cmsProgramsLoader } from "../src/lib/cms-programs-loader";
import { cmsAuthorsLoader } from "../src/lib/cms-authors-loader";
import { publicHomepageBannerLoader } from "../src/lib/public-homepage-banner";
import { createPublicArtifactInventoryReceipt } from "../src/lib/public-artifact-inventory";

const directories: string[] = [];
const queueId = "11111111111111111111";
const rendererSha = "a".repeat(40);
const now = new Date("2026-09-06T04:00:00Z");
const cutoffAt = { seconds: Math.floor(now.getTime() / 1000), nanoseconds: 0,
  toMillis: () => now.getTime() };
const reservation = {
  schemaVersion: 1 as const, buildBatchId: "released-build", generation: 1,
  status: "reserved" as const, commitSha: "b".repeat(40),
  reservedAgainstGeneration: 0, reservedAgainstDeploymentId: null,
  reservedAgainstCommitSha: null, cutoffAt, reservedAt: cutoffAt,
};
const publicContext = { schemaVersion: 3, pages: [], posts: [], programs: [], authors: [], settings: [],
  receipt: createPublicArtifactInventoryReceipt({ reservation, pages: [], posts: [], programs: [], authors: [], settings: [] }) };
const input = {
  schemaVersion: 2, queueId, rendererSha, pageId: "contact", sourceVersion: 7,
  expiresAtMs: now.getTime() + 7 * 86_400_000,
  snapshot: {
    id: "contact", title: "Exact saved contact", template: "genericPage", version: 7,
    blocks: [{ id: "body", type: "prose", visible: true, order: 0,
      data: { content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Only this revision" }] }] } } }],
  },
  assets: [],
  publicContext,
};

async function fixture(value: unknown = input, envOverrides: Record<string, string> = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "cms-preview-input-"));
  directories.push(directory);
  const file = path.join(directory, "input.json");
  const bytes = JSON.stringify(value);
  await writeFile(file, bytes);
  const env = {
    CMS_CONTENT_MODE: "draft", CMS_PREVIEW_PAGE_ID: "contact", CMS_PREVIEW_QUEUE_ID: queueId,
    CMS_PREVIEW_RENDERER_SHA: rendererSha, CMS_PREVIEW_INPUT_PATH: file,
    CMS_PREVIEW_INPUT_SHA256: createHash("sha256").update(bytes).digest("hex"),
    ...envOverrides,
  };
  return { env, request: resolveCmsPreviewInput(env)!, file, bytes };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("private preview input", () => {
  it("overrides the published page with the frozen draft without a credential", async () => {
    const releasedPage = { pageId: "contact", path: "/contact/", sourceVersion: 6, title: "Older published contact" };
    const { env, request } = await fixture({ ...input, publicContext: {
      ...publicContext, pages: [releasedPage],
      receipt: createPublicArtifactInventoryReceipt({ reservation,
        pages: [{ documentId: "contact", sourceVersion: 6, publishedSnapshot: { sourceVersion: 6, blocks: [], metadata: {} } }],
        posts: [], programs: [], authors: [], settings: [] }),
    } });
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    vi.stubEnv("CMS_LOADER_STRICT", "1");
    vi.stubEnv("FIREBASE_PROJECT_ID", undefined);
    vi.stubEnv("FIRESTORE_EMULATOR_HOST", undefined);
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", undefined);
    const entries: { id: string; data: CmsPageBuildData }[] = [];
    const store = { clear: vi.fn(), set: (entry: typeof entries[number]) => entries.push(entry) };
    const loader = cmsPagesLoader();
    await loader.load({ store, logger: { info: vi.fn() }, parseData: async ({ data }: { data: unknown }) => data } as never);
    expect(loader.name).toContain(request.sha256);
    expect(store.clear).toHaveBeenCalledOnce();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: "contact", data: {
      pageId: "contact", path: "/contact/", contentMode: "draft", noindex: true,
      title: "Exact saved contact", sourceVersion: 7, blocks: input.snapshot.blocks,
    } });
  });

  it("binds the saved preview base flag to the frozen input", async () => {
    const test = await fixture({ ...input, persistent: true }, { CMS_PREVIEW_PERSISTENT: "1" });
    expect(test.request.persistent).toBe(true);
    await expect(readCmsPreviewInput(test.request, now)).resolves.toMatchObject({ page: input.snapshot });
    await expect(readCmsPreviewInput({ ...test.request, persistent: undefined }, now)).rejects.toThrow("identity");
    expect(() => resolveCmsPreviewInput({ ...test.env, CMS_PREVIEW_PERSISTENT: "false" })).toThrow();
  });

  it("overrides only the matching post and preserves the released context without a credential", async () => {
    const postId = "post-one";
    const sourceVersion = 9;
    const savedSlug = "saved-draft-story";
    const blocks = [{ id: "table", type: "data_table", visible: true, order: 0,
      data: { title: "", csv: "", source: "", sourceHref: "" } }];
    const snapshot = {
      id: postId,
      version: sourceVersion,
      blocks,
      published: {
        blocks,
        metadata: {
          type: "post", title: "Exact saved post", slug: savedSlug,
          previousSlugs: [], locale: "en", categories: ["News"], tags: [],
          summary: "The saved summary.", editorialDateSource: "editorial",
          date: "2026-09-06", seo: { noindex: false },
        },
        publishedAt: "2026-09-06T04:00:00.000Z",
        sourceVersion,
      },
    };
    const releasedPage = {
      pageId: "contact", path: "/contact/", sourceVersion: 6,
      title: "Released contact",
    };
    const releasedPosts = [
      { postId, slug: "older-story", path: "/posts/older-story/",
        previousSlugs: [], sourceVersion: 6, title: "Older saved post" },
      { postId: "related-post", slug: "related-story", path: "/posts/related-story/",
        previousSlugs: [], sourceVersion: 4, title: "Related released post" },
    ];
    const postOwners = [
      { kind: "post" as const, documentId: postId, sourceVersion: 6,
        canonicalPath: "/posts/older-story/", aliases: [],
        publishedSnapshot: { sourceVersion: 6, blocks: [], metadata: { type: "post" } } },
      { kind: "post" as const, documentId: "related-post", sourceVersion: 4,
        canonicalPath: "/posts/related-story/", aliases: [],
        publishedSnapshot: { sourceVersion: 4, blocks: [], metadata: { type: "post" } } },
    ];
    const related = {
      ...publicContext,
      pages: [releasedPage],
      posts: releasedPosts,
      receipt: createPublicArtifactInventoryReceipt({
        reservation,
        pages: [{ documentId: "contact", sourceVersion: 6,
          publishedSnapshot: { sourceVersion: 6, blocks: [], metadata: {} } }],
        posts: postOwners,
        programs: [], authors: [], settings: [],
      }),
    };
    const postInput = {
      ...input,
      collection: "cmsPosts",
      pageId: postId,
      sourceVersion,
      snapshot,
      publicContext: related,
    };
    const { env, request } = await fixture(postInput, {
      CMS_PREVIEW_COLLECTION: "cmsPosts",
      CMS_PREVIEW_PAGE_ID: postId,
    });
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    vi.stubEnv("CMS_LOADER_STRICT", "1");
    vi.stubEnv("FIREBASE_PROJECT_ID", undefined);
    vi.stubEnv("FIRESTORE_EMULATOR_HOST", undefined);
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", undefined);

    const postEntries: Array<{ id: string; data: Record<string, unknown> }> = [];
    const postLoader = cmsPostsLoader();
    await postLoader.load({
      store: { clear: vi.fn(), set: (entry: typeof postEntries[number]) => postEntries.push(entry) },
      logger: { info: vi.fn() },
      parseData: async ({ data }: { data: unknown }) => data,
    } as never);

    expect(request.collection).toBe("cmsPosts");
    expect(postLoader.name).toContain(request.sha256);
    expect(postEntries.map(entry => entry.id).sort()).toEqual([postId, "related-post"]);
    expect(postEntries.find(entry => entry.id === postId)?.data).toMatchObject({
      postId,
      path: `/posts/${savedSlug}/`,
      title: "Exact saved post",
      summary: "The saved summary.",
      blocks,
      sourceVersion,
      noindex: true,
    });
    expect(postEntries.find(entry => entry.id === "related-post")?.data)
      .toEqual(releasedPosts[1]);

    const pageEntries: unknown[] = [];
    await cmsPagesLoader().load({
      store: { clear: vi.fn(), set: (entry: { data: unknown }) => pageEntries.push(entry.data) },
      logger: { info: vi.fn() },
      parseData: async ({ data }: { data: unknown }) => data,
    } as never);
    expect(pageEntries).toEqual([releasedPage]);
  });

  it("refuses changed bytes even when they are valid JSON", async () => {
    const { request, file, bytes } = await fixture();
    await writeFile(file, `${bytes}\n`);
    await expect(readCmsPreviewInput(request, now)).rejects.toThrow(/digest does not match/);
  });

  it.each([
    { schemaVersion: 1 }, { queueId: "22222222222222222222" }, { pageId: "home" },
    { rendererSha: "b".repeat(40) }, { sourceVersion: 8 }, { collection: "cmsPosts" },
    { snapshot: { ...input.snapshot, id: "home" } },
    { expiresAtMs: now.getTime() },
  ])("refuses mismatched or expired input %j", async override => {
    const { request } = await fixture({ ...input, ...override });
    await expect(readCmsPreviewInput(request, now)).rejects.toThrow(/identity or expiry/);
  });

  it("keeps malformed content fail-closed even without the strict-loader flag", async () => {
    const { env } = await fixture({ ...input, snapshot: { ...input.snapshot, blocks: [{ type: "unknown" }] } });
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    vi.stubEnv("CMS_LOADER_STRICT", "0");
    const store = { clear: vi.fn(), set: vi.fn() };
    await expect(cmsPagesLoader().load({ store, logger: { info: vi.fn() }, parseData: vi.fn() } as never))
      .rejects.toThrow(/block/i);
    expect(store.set).not.toHaveBeenCalled();
  });

  it("rejects duplicate frozen media identities", async () => {
    const asset = { id: "photo", url: "https://media.njpbs.org/cms-media/photo.png", mimeType: "image/png", width: 100, height: 100 };
    const { request } = await fixture({ ...input, assets: [asset, asset] });
    await expect(readCmsPreviewInput(request, now)).rejects.toThrow(/invalid media snapshot/);
  });

  it("requires the complete local handoff and never admits it as a public build", async () => {
    expect(resolveCmsPreviewInput({})).toBeNull();
    const { env } = await fixture();
    for (const override of [
      { CMS_CONTENT_MODE: "published" }, { CMS_PREVIEW_INPUT_SHA256: "" },
      { CMS_PREVIEW_INPUT_PATH: "relative.json" }, { CMS_PREVIEW_QUEUE_ID: "wrong" },
      { PUBLIC_ARTIFACT_BUNDLE_PATH: "/tmp/public.json" }, { PUBLIC_BUILD_BATCH_ID: "public-build" },
    ]) expect(() => resolveCmsPreviewInput({ ...env, ...override })).toThrow(/exact draft queue/);
  });

  it("loads frozen related content through each real loader without database credentials", async () => {
    const version = 3;
    const publishedSnapshot = { sourceVersion: version, blocks: [], metadata: {} };
    const posts = [{ kind: "post" as const, documentId: "post-one", sourceVersion: version,
      canonicalPath: "/posts/public-story/", aliases: [], publishedSnapshot: { ...publishedSnapshot, metadata: { type: "post" } } }];
    const programs = [{ kind: "program" as const, documentId: "program-one", sourceVersion: version,
      canonicalPath: "/programs/public-show/", aliases: [], publishedSnapshot: { ...publishedSnapshot, metadata: { type: "program" } } }];
    const authors = [{ documentId: "author-one", sourceVersion: version,
      canonicalPath: "/authors/public-author/", aliases: [], publishedSnapshot: { snapshotVersion: version } }];
    const publishedAt = "2026-09-06T03:00:00.000Z";
    const settingId = "public-homepage-banner";
    const settings = [{ documentId: settingId as typeof settingId, sourceVersion: version,
      publishedSnapshot: { schemaVersion: 1, sourceVersion: version, publishedAt,
        values: { enabled: true, message: "Published announcement" } } }];
    const related = { ...publicContext,
      posts: [{ postId: "post-one", slug: "public-story", path: "/posts/public-story/",
        previousSlugs: [], sourceVersion: version, title: "Public story" }],
      programs: [{ programId: "program-one", slug: "public-show", path: "/programs/public-show/",
        previousSlugs: [], sourceVersion: version, title: "Public program" }],
      authors: [{ authorId: "author-one", slug: "public-author", path: "/authors/public-author/",
        previousSlugs: [], sourceVersion: version, displayName: "Public author" }],
      settings: [{ settingId, sourceVersion: version, enabled: true, message: "Published announcement", publishedAt }],
      receipt: createPublicArtifactInventoryReceipt({ reservation, pages: [], posts, programs, authors, settings }),
    };
    const { env, request } = await fixture({ ...input, publicContext: related });
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    vi.stubEnv("CMS_LOADER_STRICT", "1");
    vi.stubEnv("FIREBASE_PROJECT_ID", undefined);
    vi.stubEnv("FIRESTORE_EMULATOR_HOST", undefined);
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", undefined);
    const expected = [related.posts, related.programs.map(program => ({ ...program, keyArt: null, keyArtAlt: "", keyArtDecorative: false, watchUrl: null })), related.authors, related.settings];
    const loaders = [cmsPostsLoader(), cmsProgramsLoader(), cmsAuthorsLoader(), publicHomepageBannerLoader()];
    for (const [index, loader] of loaders.entries()) {
      const entries: unknown[] = [];
      const context = { store: { clear: vi.fn(), set: (entry: { data: unknown }) => entries.push(entry.data) },
        logger: { info: vi.fn() }, parseData: async ({ data }: { data: unknown }) => data };
      await loader.load(context as never);
      expect(loader.name).toContain(request.sha256);
      expect(context.store.clear).toHaveBeenCalledOnce();
      expect(entries).toEqual(expected[index]);
    }
  });

  it.each([undefined, {}, { ...publicContext, posts: [{ postId: "unreceipted" }] }])(
    "refuses missing or incomplete published context in every related loader", async publicContext => {
      const { env } = await fixture({ ...input, publicContext });
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
      vi.stubEnv("CMS_LOADER_STRICT", "0");
      for (const loader of [cmsPagesLoader(), cmsPostsLoader(), cmsProgramsLoader(), cmsAuthorsLoader(), publicHomepageBannerLoader()]) {
        const store = { clear: vi.fn(), set: vi.fn() };
        await expect(loader.load({ store, logger: { info: vi.fn() }, parseData: vi.fn() } as never))
          .rejects.toThrow(/public artifact bundle/);
        expect(store.set).not.toHaveBeenCalled();
      }
    },
  );
});
