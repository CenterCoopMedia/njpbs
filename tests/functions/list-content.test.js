import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import adminPkg from "../helpers/firebase-admin.js";
import { deleteApp, initializeApp as initClient } from "firebase/app";
import {
  connectAuthEmulator,
  signInWithEmailAndPassword,
  getAuth,
  signOut,
} from "firebase/auth";
import contentLibrary from "../../functions/lib/content-library.js";
import listContent from "../../functions/list-content.js";

const { contentRecordSummary, parseContentQuery, selectContentLibrary } =
  contentLibrary;
const {
  MAX_UNPAGED_RECORDS,
  attachThumbnailUrls,
  thumbnailAssetIds,
  createCmsListContentHandler,
} = listContent;

const admin = adminPkg;
const PROJECT = "demo-njpbs";
const REGION = "us-central1";
const FUNCTIONS_HOST = process.env.FUNCTIONS_EMULATOR_HOST || "127.0.0.1:5001";
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9099";
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
const fnUrl = (name) => `http://${FUNCTIONS_HOST}/${PROJECT}/${REGION}/${name}`;

function makeReq({ method = "POST", body = {}, headers = {} } = {}) {
  return { method, body, headers, ip: "203.0.113.9" };
}

function makeRes() {
  const res = { statusCode: null, body: null, headersSent: false };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    res.headersSent = true;
    return res;
  };
  return res;
}

const summaries = [
  {
    id: "a-1",
    kind: "article",
    title: "Shore report",
    status: "draft",
    updatedAt: "2026-07-20T15:00:00.000Z",
    updatedBy: "editor-1",
    assignee: "editor-2",
    version: 2,
  },
  {
    id: "p-1",
    kind: "program",
    title: "Garden State",
    status: "published",
    updatedAt: "2026-07-20T14:00:00.000Z",
    updatedBy: "editor-2",
    assignee: "editor-1",
    version: 5,
  },
  {
    id: "a-2",
    kind: "article",
    title: "Trenton tonight",
    status: "in_review",
    updatedAt: "2026-07-20T13:00:00.000Z",
    updatedBy: "editor-1",
    assignee: "editor-1",
    version: 3,
  },
];

const storedSummaries = [
  { ...summaries[0], createdBy: "contributor-1" },
  { ...summaries[1], createdBy: "editor-2" },
  { ...summaries[2], createdBy: "contributor-1" },
];

const siteWide = (role, uid = "editor-1") => ({
  uid,
  email: `${uid}@example.org`,
  principal: { id: uid, grants: [{ role }] },
});

const scoped = (role, uid = "editor-1") => ({
  uid,
  email: `${uid}@example.org`,
  principal: { id: uid, grants: [{ role, sections: ["news"] }] },
});

const noGrants = (uid = "viewer-1") => ({
  uid,
  email: `${uid}@example.org`,
  principal: { id: uid, grants: [] },
});

describe("content-library server domain", () => {
  it("uses lead media posters for Posts without reviving stale images or decorative backgrounds", () => {
    expect(thumbnailAssetIds({ heroImage: "legacy", leadMedia: { kind: "embed", data: { url: "https://youtu.be/abcdefghijk", title: "Video" }, posterAssetId: "poster" }, heroBackgroundImage: "background" }, { post: true })).toEqual(["poster"]);
    expect(thumbnailAssetIds({ heroImage: "legacy", leadMedia: { kind: "linked-video", data: { url: "https://example.org/watch", title: "Video" } }, heroBackgroundImage: "background" }, { post: true })).toEqual([]);
    expect(thumbnailAssetIds({ heroImage: "legacy" }, { post: true })).toEqual(["legacy"]);
    expect(thumbnailAssetIds({ heroImage: "legacy", leadMedia: null }, { post: true })).toEqual([]);
  });
  it("uses a sponsor logo as a picker thumbnail candidate", () => {
    expect(thumbnailAssetIds({ type: "sponsor", logoAssetId: "asset-sponsor" }))
      .toContain("asset-sponsor");
  });
  it("resolves visible image candidates in priority order without exposing their ids", async () => {
    const readRecordsByIdsFn = vi.fn(async (_firestore, ids) => ({
      records: ids.flatMap((id) => id === "asset-missing"
        ? []
        : [{ id, kind: id === "asset-document" ? "document" : "image", url: `https://media.example.org/${id}.jpg` }]),
    }));
    const visibleRecordsFn = vi.fn((_principal, assets) =>
      assets.filter((asset) => asset.id !== "asset-forbidden"));

    const records = await attachThumbnailUrls({}, {}, [
      { id: "missing", thumbnailAssetIds: ["asset-missing", "asset-background"] },
      { id: "forbidden", thumbnailAssetIds: ["asset-forbidden", "asset-social"] },
      { id: "document", thumbnailAssetIds: ["asset-document", "asset-fallback"] },
      { id: "lead", thumbnailAssetIds: ["asset-lead", "asset-unused"] },
    ], { readRecordsByIdsFn, visibleRecordsFn });

    expect(records).toEqual([
      { id: "missing", thumbnailUrl: "https://media.example.org/asset-background.jpg" },
      { id: "forbidden", thumbnailUrl: "https://media.example.org/asset-social.jpg" },
      { id: "document", thumbnailUrl: "https://media.example.org/asset-fallback.jpg" },
      { id: "lead", thumbnailUrl: "https://media.example.org/asset-lead.jpg" },
    ]);
    expect(readRecordsByIdsFn.mock.calls.flatMap(([, ids]) => ids)).not.toContain("asset-unused");
  });

  it("uses a generated thumbnail for a content row and keeps the original when none exists", async () => {
    const readRecordsByIdsFn = vi.fn(async (_firestore, ids) => ({
      records: ids.map((id) => ({
        id,
        kind: "image",
        url: `https://media.example.org/${id}.jpg`,
        ...(id === "asset-original" ? {} : {
          thumbnails: [
            { url: `https://media.example.org/${id}-960.webp`, width: 960, height: 540 },
            { url: `https://media.example.org/${id}-480.webp`, width: 480, height: 270, storageKey: "private" },
          ],
        }),
      })),
    }));
    const records = await attachThumbnailUrls({}, {}, [
      { id: "thumb", thumbnailAssetIds: ["asset-thumb"] },
      { id: "plain", thumbnailAssetIds: ["asset-original"] },
    ], {
      readRecordsByIdsFn,
      visibleRecordsFn: (_principal, assets) => assets,
    });

    expect(records[0].thumbnailUrl).toBe("https://media.example.org/asset-thumb-480.webp");
    expect(records[1].thumbnailUrl).toBe("https://media.example.org/asset-original.jpg");
  });

  it("deduplicates and bounds concurrent thumbnail reads while preserving fallback priority", async () => {
    const records = Array.from({ length: 62 }, (_, index) => ({
      id: `post-${index}`,
      thumbnailAssetIds: [
        `asset-primary-${index % 61}`,
        `asset-fallback-${index % 61}`,
      ],
    }));
    let activeReads = 0;
    let maximumActiveReads = 0;
    const readRecordsByIdsFn = vi.fn(async (_firestore, ids) => {
      activeReads += 1;
      maximumActiveReads = Math.max(maximumActiveReads, activeReads);
      await Promise.resolve();
      activeReads -= 1;
      if (ids.includes("asset-primary-12")) throw new Error("one media batch failed");
      return {
        records: ids.map((id) => ({
          id,
          kind: "image",
          url: `https://media.example.org/${id}.jpg`,
        })),
      };
    });

    const hydrated = await attachThumbnailUrls({}, {}, records, {
      readRecordsByIdsFn,
      visibleRecordsFn: (_principal, assets) => assets,
    });

    const batches = readRecordsByIdsFn.mock.calls.map(([, ids]) => ids);
    expect(batches.every((ids) => ids.length <= 12)).toBe(true);
    expect(maximumActiveReads).toBe(4);
    expect(batches.flat().filter((id) => id === "asset-primary-0")).toHaveLength(1);
    expect(batches.slice(0, 6).every((ids) =>
      ids.every((id) => id.startsWith("asset-primary-")))).toBe(true);
    expect(batches.slice(6)).toEqual([
      Array.from({ length: 12 }, (_, index) => `asset-fallback-${index + 12}`),
    ]);
    expect(hydrated[0].thumbnailUrl).toBe(
      "https://media.example.org/asset-primary-0.jpg",
    );
    expect(hydrated[12].thumbnailUrl).toBe(
      "https://media.example.org/asset-fallback-12.jpg",
    );
    expect(hydrated[60].thumbnailUrl).toBe(
      "https://media.example.org/asset-primary-60.jpg",
    );
    expect(hydrated[61].thumbnailUrl).toBe(
      "https://media.example.org/asset-primary-0.jpg",
    );
  });

  it("normalizes the browser query contract independently", () => {
    expect(
      parseContentQuery(
        "?type=unknown&type=program&type=program&status=draft&owner=me&assigned=me&q=%20Garden%20&sort=nope&dir=sideways&page=3.5&v=1",
      ),
    ).toEqual({
      types: ["program"],
      statuses: ["draft"],
      ownerMode: "me",
      ownerUid: null,
      assignmentMode: "me",
      assigneeUid: null,
      q: "Garden",
      sortField: "updatedAt",
      sortDirection: "desc",
      sortExplicit: false,
      page: 1,
    });
  });

  it("derives safe summaries from snapshot identity and excludes invalid records", () => {
    expect(
      contentRecordSummary("staff-1", {
        id: "spoofed",
        type: "staff",
        name: "  Pat Producer  ",
        status: "draft",
        updatedAt: { toDate: () => new Date("2026-07-20T15:00:00.000Z") },
        updatedBy: "editor-1",
        assignee: "editor-2",
        version: 4,
      }),
    ).toEqual({
      id: "staff-1",
      kind: "staff",
      title: "Pat Producer",
      status: "draft",
      updatedAt: "2026-07-20T15:00:00.000Z",
      updatedBy: "editor-1",
      assignee: "editor-2",
      version: 4,
      contentVersion: 4,
    });
    expect(
      contentRecordSummary("gone", { type: "article", deleted: true }),
    ).toBeNull();
    expect(contentRecordSummary("mystery", { type: "mystery" })).toBeNull();
    expect(
      contentRecordSummary("unsafe-version", {
        type: "article",
        title: "Unsafe version",
        status: "draft",
        version: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toEqual({
      id: "unsafe-version",
      kind: "article",
      title: "Unsafe version",
      status: "draft",
    });
  });

  it.each(["draft", "in_review", "approved"])(
    "projects the live snapshot beside a %s working revision",
    (status) => {
      expect(
        contentRecordSummary(`post-${status}`, {
          type: "post",
          title: "Station appointments",
          status,
          version: 12,
          contentVersion: 5,
          publiclyVisible: true,
          published: { sourceVersion: 8, contentVersion: 4 },
        }),
      ).toMatchObject({
        status,
        version: 12,
        contentVersion: 5,
        publishedSourceVersion: 8,
        publishedContentVersion: 4,
        liveSourceVersion: 8,
      });
    },
  );

  it("does not call a retained or malformed snapshot live", () => {
    expect(
      contentRecordSummary("post-withdrawn", {
        type: "post",
        title: "Withdrawn update",
        status: "draft",
        version: 12,
        publiclyVisible: false,
        publicSourceVersion: 8,
        published: { sourceVersion: 8 },
      }),
    ).not.toHaveProperty("liveSourceVersion");
    expect(
      contentRecordSummary("post-drifted", {
        type: "post",
        title: "Drifted update",
        status: "published",
        version: 12,
        published: { sourceVersion: 0 },
      }),
    ).not.toHaveProperty("liveSourceVersion");
  });

  it("keeps an unconfirmed public build separate from the live snapshot", () => {
    const summary = contentRecordSummary("post-publishing", {
      type: "post",
      title: "Publishing update",
      status: "published",
      version: 12,
      publiclyVisible: true,
      publishBuildPending: true,
      published: { sourceVersion: 12 },
    });
    expect(summary).toMatchObject({
      publicUpdatePending: true,
      pendingSourceVersion: 12,
    });
    expect(summary).not.toHaveProperty("liveSourceVersion");
  });

  it("returns one filtered page with neighboring status and global quick-view counts", () => {
    const query = parseContentQuery(
      "type=article&status=in_review&owner=me&q=Trenton&v=1",
    );
    const result = selectContentLibrary(summaries, query, "editor-1", 1);

    expect(result.records.map((record) => record.id)).toEqual(["a-2"]);
    expect(result).toMatchObject({
      total: 1,
      allCount: 3,
      mineCount: 2,
      assignedCount: 2,
      page: 1,
      pageCount: 1,
      statusCounts: { draft: 0, in_review: 1, published: 0 },
    });
  });

  it("excludes archived records by default and selects them explicitly", () => {
    const records = [
      ...summaries,
      {
        id: "a-archived",
        kind: "article",
        title: "Archived report",
        status: "archived",
        updatedAt: "2026-07-20T16:00:00.000Z",
        updatedBy: "editor-1",
        version: 4,
      },
    ];

    const activeResult = selectContentLibrary(
      records,
      parseContentQuery("v=1"),
      "editor-1",
      25,
    );
    const archivedResult = selectContentLibrary(
      records,
      parseContentQuery("status=archived&v=1"),
      "editor-1",
      25,
    );

    expect(activeResult.records.map((record) => record.id)).not.toContain("a-archived");
    expect(activeResult.total).toBe(3);
    expect(activeResult.statusCounts.archived).toBe(1);
    expect(archivedResult.records.map((record) => record.id)).toEqual(["a-archived"]);
  });

  it("selects the signed-in user's true assignments, not their recent edits", () => {
    const query = parseContentQuery("assigned=me&v=1");
    const result = selectContentLibrary(summaries, query, "editor-1", 25);

    expect(result.records.map((record) => record.id)).toEqual(["p-1", "a-2"]);
    expect(result.assignedCount).toBe(2);
    expect(result.mineCount).toBe(2);
  });

  it("sorts deterministically and clamps an out-of-range page", () => {
    const query = parseContentQuery("sort=title&dir=asc&page=99&v=1");
    const result = selectContentLibrary(summaries, query, "editor-1", 2);

    expect(result.page).toBe(2);
    expect(result.pageCount).toBe(2);
    expect(result.records.map((record) => record.title)).toEqual([
      "Trenton tonight",
    ]);
  });
});

describe("cmsListContent handler", () => {
  it("lists only authorized page metadata and keeps draft URLs separate from published URLs", async () => {
    const customId = `page-${"a".repeat(32)}`;
    const hiddenId = `page-${"b".repeat(32)}`;
    const scheduledId = `page-${"c".repeat(32)}`;
    const documents = [
      { id: customId, data: () => ({ title: "Community draft", slug: "community-draft", section: "news",
        status: "draft", publiclyVisible: true, publicSourceVersion: 2, published: { sourceVersion: 2, metadata: { slug: "community" } } }) },
      { id: hiddenId, data: () => ({ title: "Private other desk", slug: "private", section: "support", status: "draft" }) },
      { id: "genericPage", data: () => ({ title: "Legacy seed", section: "news" }) },
      { id: scheduledId, data: () => ({ title: "Scheduled guide", slug: "scheduled-guide", section: "news",
        status: "scheduled", publishAt: "2026-10-14T10:00:00.000Z" }) },
    ];
    const select = vi.fn(() => ({ get: async () => ({ docs: documents }) }));
    const firestore = { collection: vi.fn(() => ({ select })) };
    const handler = createCmsListContentHandler({ firestore,
      requirePrincipalFn: async () => scoped("editor") });
    const res = makeRes();
    await handler(makeReq({ body: { view: "pages" } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.pages).toEqual([{ id: customId, title: "Community draft", path: "/community-draft/",
      section: "news", status: "draft", published: true, livePath: "/community/",
      publishedSourceVersion: 2, liveSourceVersion: 2 },
      { id: scheduledId, title: "Scheduled guide", path: "/scheduled-guide/", section: "news",
        status: "scheduled", publishAt: "2026-10-14T10:00:00.000Z", published: false }]);
    expect(select.mock.calls[0]).toContain("publishAt");
    expect(firestore.collection).toHaveBeenCalledExactlyOnceWith("cmsPages");
    expect(JSON.stringify(res.body)).not.toMatch(/Private other desk|Legacy seed/);
  });

  it.each([
    ["first publication pending", { publishBuildPending: true }],
    ["first publication failed", { publishBuildPending: false }],
    ["renamed URL pending", { publicSourceVersion: 1, publishBuildPending: true }],
    ["renamed URL failed", { publicSourceVersion: 1, publishBuildPending: false }],
    ["queue still settling", { publicSourceVersion: 2, publishBuildPending: true }],
  ])("does not expose a live page URL for %s", async (_case, deployment) => {
    const id = `page-${"a".repeat(32)}`;
    const stored = { title: "Community", slug: "community", section: "news",
      status: "published", publiclyVisible: true,
      published: { sourceVersion: 2, metadata: { slug: "community" } }, ...deployment };
    const firestore = { collection: vi.fn(() => ({ select: () => ({
      get: async () => ({ docs: [{ id, data: () => stored }] }),
    }) })) };
    const handler = createCmsListContentHandler({ firestore,
      requirePrincipalFn: async () => scoped("editor") });
    const res = makeRes();
    await handler(makeReq({ body: { view: "pages" } }), res);
    expect(res.statusCode).toBe(200);
    const page = res.body.pages[0];
    expect(page).toMatchObject({ id, title: "Community", path: "/community/",
      section: "news", status: "published", published: false, publishedSourceVersion: 2 });
    expect(page.livePath).toBeUndefined();
    if (deployment.publishBuildPending === true) {
      expect(page.publicUpdatePending).toBe(true);
      expect(page.publicBuildQueueId).toBeNull();
      expect(page.pendingSourceVersion).toBe(2);
    } else {
      expect(page.publicUpdatePending).toBeUndefined();
    }
    if (deployment.publicSourceVersion) {
      expect(page.liveSourceVersion).toBe(deployment.publicSourceVersion);
    } else {
      expect(page.liveSourceVersion).toBeUndefined();
    }
  });

  it("rejects unsupported methods without authenticating", async () => {
    const requirePrincipalFn = vi.fn();
    const handler = createCmsListContentHandler({ requirePrincipalFn });
    const res = makeRes();

    await handler(makeReq({ method: "GET" }), res);

    expect(res.statusCode).toBe(405);
    expect(requirePrincipalFn).not.toHaveBeenCalled();
  });

  it("validates the bounded query after authentication", async () => {
    const readRecordsFn = vi.fn();
    const handler = createCmsListContentHandler({
      requirePrincipalFn: vi.fn(async () => siteWide("editor")),
      readRecordsFn,
    });
    const res = makeRes();

    await handler(makeReq({ body: { query: 17 } }), res);

    expect(res.statusCode).toBe(400);
    expect(readRecordsFn).not.toHaveBeenCalled();
  });

  it("validates the legacy unpaged mode before reading records", async () => {
    const readRecordsFn = vi.fn();
    const handler = createCmsListContentHandler({
      requirePrincipalFn: vi.fn(async () => siteWide("editor")),
      readRecordsFn,
    });
    const res = makeRes();

    await handler(makeReq({ body: { query: "v=1", unpaged: "yes" } }), res);

    expect(res.statusCode).toBe(400);
    expect(readRecordsFn).not.toHaveBeenCalled();
  });

  it("keeps the bounded legacy unpaged response during the staged admin rollout", async () => {
    const records = Array.from({ length: 30 }, (_, index) => ({
      id: `article-${String(index).padStart(2, "0")}`,
      kind: "article",
      title: `Article ${String(index).padStart(2, "0")}`,
      status: "draft",
      createdBy: "editor-1",
      updatedAt: `2026-07-20T12:${String(index).padStart(2, "0")}:00.000Z`,
    }));
    const handler = createCmsListContentHandler({
      requirePrincipalFn: vi.fn(async () => siteWide("editor")),
      readRecordsFn: vi.fn(async () => records),
    });
    const res = makeRes();

    await handler(makeReq({ body: { query: "type=article&v=1", unpaged: true } }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.records).toHaveLength(30);
    expect(res.body).toMatchObject({ total: 30, page: 1, pageCount: 1 });
  });

  it("keeps the legacy unpaged response within its explicit summary cap", async () => {
    const records = Array.from({ length: MAX_UNPAGED_RECORDS + 1 }, (_, index) => ({
      id: `article-${index}`,
      kind: "article",
      title: `Article ${index}`,
      status: "draft",
      createdBy: "editor-1",
    }));
    const handler = createCmsListContentHandler({
      requirePrincipalFn: vi.fn(async () => siteWide("editor")),
      readRecordsFn: vi.fn(async () => records),
    });
    const res = makeRes();

    await handler(makeReq({ body: { query: "v=1", unpaged: true } }), res);

    expect(res.statusCode).toBe(413);
    expect(res.body.error).toMatch(/too many authorized summaries/i);
  });

  it.each([
    { query: "q=Owned&v=1" },
    { query: "v=1", unpaged: true },
  ])("does not apply the summary cap to inaccessible records", async (body) => {
    const documents = [
      ...Array.from({ length: MAX_UNPAGED_RECORDS + 1 }, (_, index) => ({
        id: `inaccessible-${index}`,
        data: {
          type: "article",
          title: `Inaccessible article ${index}`,
          status: "draft",
          createdBy: "someone-else",
        },
      })),
      {
        id: "owned",
        data: {
          type: "article",
          title: "Owned article",
          status: "draft",
          createdBy: "contributor-1",
        },
      },
    ];
    const firestore = fakeAddressedFirestore(documents);
    const handler = createCmsListContentHandler({
      firestore,
      requirePrincipalFn: vi.fn(async () => siteWide("contributor", "contributor-1")),
    });
    const res = makeRes();

    await handler(makeReq({ body }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.records).toEqual([
      expect.objectContaining({ id: "owned", title: "Owned article" }),
    ]);
    expect(res.body.total).toBe(1);
    expect(firestore.pageReads.every((read) => read.limit === 100)).toBe(true);
  });

  it.each([
    { query: "q=Owned&v=1" },
    { query: "v=1", unpaged: true },
  ])("bounds scanned documents even when summaries are inaccessible or malformed: %j", async (body) => {
    const documents = Array.from({ length: 6000 }, (_, index) => ({
      id: `record-${String(index).padStart(5, "0")}`,
      data: index % 2 ? { type: "invalid" } : {
        type: "post", title: "Owned post", status: "draft",
        createdBy: index === 0 ? "contributor-1" : "someone-else",
      },
    }));
    const firestore = fakeAddressedFirestore(documents);
    const handler = createCmsListContentHandler({
      firestore,
      requirePrincipalFn: async () => siteWide("contributor", "contributor-1"),
    });
    const res = makeRes();

    await handler(makeReq({ body }), res);

    expect(res.statusCode).toBe(413);
    expect(res.body.error).toMatch(/scan limit/i);
    expect(res.body).not.toHaveProperty("records");
    expect(res.body).not.toHaveProperty("total");
    // The read budget includes one sentinel, regardless of authorization or shape.
    expect(firestore.pageReads.reduce((sum, read) => sum + read.limit, 0)).toBe(5001);
    expect(firestore.pageReads.at(-1).limit).toBe(1);
  });

  it.each([4999, 5000])("returns a complete result when %i documents fit the scan budget", async (size) => {
    const documents = Array.from({ length: size }, (_, index) => ({
      id: `record-${String(index).padStart(5, "0")}`,
      data: {
        type: "post", title: "Owned post", status: "draft",
        createdBy: index === size - 1 ? "contributor-1" : "someone-else",
      },
    }));
    const firestore = fakeAddressedFirestore(documents);
    const handler = createCmsListContentHandler({
      firestore,
      requirePrincipalFn: async () => siteWide("contributor", "contributor-1"),
    });
    const res = makeRes();

    await handler(makeReq({ body: { query: "q=Owned&v=1" } }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.records).toEqual([
      expect.objectContaining({ id: documents.at(-1).id }),
    ]);
    expect(firestore.pageReads.reduce((sum, read) => sum + read.limit, 0)).toBeLessThanOrEqual(5001);
  });

  it("stops a bounded search after finding 501 authorized summaries", async () => {
    const documents = Array.from({ length: 1000 }, (_, index) => ({
      id: `article-${String(index).padStart(4, "0")}`,
      data: {
        type: "article",
        title: `Article ${index}`,
        status: "draft",
        createdBy: "editor-1",
      },
    }));
    const firestore = fakeAddressedFirestore(documents);
    const handler = createCmsListContentHandler({
      firestore,
      requirePrincipalFn: vi.fn(async () => siteWide("editor")),
    });
    const res = makeRes();

    await handler(makeReq({ body: { query: "q=Article&v=1" } }), res);

    expect(res.statusCode).toBe(413);
    expect(firestore.pageReads).toHaveLength(6);
    expect(firestore.pageReads.every((read) => read.limit === 100)).toBe(true);
  });

  it("resolves owner=me on the authenticated server and returns only the requested page", async () => {
    const handler = createCmsListContentHandler({
      requirePrincipalFn: vi.fn(async () => siteWide("editor")),
      readRecordsFn: vi.fn(async () => storedSummaries),
    });
    const res = makeRes();

    await handler(
      makeReq({ body: { query: "owner=me&status=draft&v=1" } }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      total: 1,
      allCount: 3,
      mineCount: 2,
      assignedCount: 2,
      records: [{ id: "a-1", version: 2 }],
    });
    expect(res.body.records[0]).not.toHaveProperty("createdBy");
  });

  it("keeps list rows usable and private when thumbnail media cannot be read", async () => {
    const handler = createCmsListContentHandler({
      requirePrincipalFn: vi.fn(async () => siteWide("editor")),
      readRecordsFn: vi.fn(async () => [{
        ...storedSummaries[0],
        thumbnailAssetIds: ["asset-lead", "asset-social"],
      }]),
      readMediaRecordsByIdsFn: vi.fn(async () => {
        throw new Error("media unavailable");
      }),
    });
    const res = makeRes();

    await handler(makeReq({ body: { query: "v=1" } }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.records).toEqual([
      expect.objectContaining({ id: "a-1", title: "Shore report" }),
    ]);
    expect(res.body.records[0]).not.toHaveProperty("thumbnailAssetIds");
    expect(res.body.records[0]).not.toHaveProperty("thumbnailUrl");
  });

  it("preserves the admin library view while resolving access through capabilities", async () => {
    const handler = createCmsListContentHandler({
      requirePrincipalFn: vi.fn(async () => siteWide("admin", "admin-1")),
      readRecordsFn: vi.fn(async () => storedSummaries),
    });
    const res = makeRes();

    await handler(makeReq({ body: { query: "v=1" } }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.allCount).toBe(3);
    expect(res.body.records.map((record) => record.id)).toEqual([
      "a-1",
      "p-1",
      "a-2",
    ]);
    expect(res.body.records.every((record) => !("createdBy" in record))).toBe(
      true,
    );
  });

  it("shows a contributor only records they created and derives every count from that set", async () => {
    const handler = createCmsListContentHandler({
      requirePrincipalFn: vi.fn(async () =>
        siteWide("contributor", "contributor-1"),
      ),
      readRecordsFn: vi.fn(async () => storedSummaries),
    });
    const res = makeRes();

    await handler(makeReq({ body: { query: "v=1" } }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      allCount: 2,
      total: 2,
      assignedCount: 0,
      mineCount: 0,
      statusCounts: { draft: 1, in_review: 1, published: 0 },
    });
    expect(res.body.records.map((record) => record.id)).toEqual(["a-1", "a-2"]);
    expect(res.body.records.every((record) => !("createdBy" in record))).toBe(
      true,
    );
  });

  it("does not expose another author's existence through filters or counts", async () => {
    const handler = createCmsListContentHandler({
      requirePrincipalFn: vi.fn(async () =>
        siteWide("contributor", "contributor-1"),
      ),
      readRecordsFn: vi.fn(async () => storedSummaries),
    });
    const res = makeRes();

    await handler(
      makeReq({
        body: { query: "type=program&status=published&owner=editor-2&v=1" },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      records: [],
      total: 0,
      allCount: 2,
      assignedCount: 0,
      mineCount: 0,
      statusCounts: {
        draft: 0,
        in_review: 0,
        scheduled: 0,
        published: 0,
        archived: 0,
      },
    });
  });

  it("lists a section-scoped grant's own desks and nothing else (#845)", async () => {
    // The precheck used to ask whether the caller could read an *unsectioned* record,
    // which was the same question only while no record carried a desk. Now that records do,
    // asking it would 403 the endpoint for exactly the scoped editors this enforcement
    // exists to serve. The caller reaches the collection, and the per-row filter is what
    // narrows the answer to their desks.
    const readRecordsFn = vi.fn(async () => [
      { ...storedSummaries[0], section: "news" },
      { ...storedSummaries[1], section: "watch" },
      // Stored before the registry existed: outside every scope until a backfill moves it.
      storedSummaries[2],
    ]);
    const handler = createCmsListContentHandler({
      requirePrincipalFn: vi.fn(async () => scoped("editor")),
      readRecordsFn,
      log: { warn: vi.fn(), error: vi.fn() },
    });
    const res = makeRes();

    await handler(makeReq({ body: { query: "v=1" } }), res);

    expect(res.statusCode).toBe(200);
    expect(readRecordsFn).toHaveBeenCalled();
    expect(res.body.records.map((record) => record.id)).toEqual([
      storedSummaries[0].id,
    ]);
    // Every derived value is computed after authorization, so a count cannot become an
    // existence oracle for the desks this caller may not see.
    expect(res.body.allCount).toBe(1);
    expect(res.body.total).toBe(1);
    // The desk is read for the decision only and never becomes a response field.
    for (const record of res.body.records) {
      expect(record).not.toHaveProperty("section");
    }
  });

  function documentSnapshot(id, data) {
    return { id, data: () => data };
  }

  function fakeAddressedFirestore(documents) {
    const pageReads = [];
    const makeQuery = (name) => {
      const local = {
        collection: name,
        offset: 0,
        limit: null,
        startAfter: null,
        orders: [],
        wheres: [],
        select: null,
      };
      const query = {
        select(...fields) {
          local.select = fields;
          return query;
        },
        where(field, op, value) {
          local.wheres.push({ field, op, value });
          return query;
        },
        orderBy(field, direction) {
          local.orders.push({ field, direction });
          return query;
        },
        offset(value) {
          local.offset = value;
          return query;
        },
        limit(value) {
          local.limit = value;
          return query;
        },
        startAfter(id) {
          local.startAfter = id;
          return query;
        },
        count() {
          return {
            async get() {
              return { data: () => ({ count: documents.length }) };
            },
          };
        },
        async get() {
          pageReads.push({ ...local, orders: [...local.orders], wheres: [...local.wheres] });
          const order = local.orders[0];
          const sorted = [...documents].sort((left, right) => {
            if (!order) return 0;
            if (typeof order.field !== "string" || order.field === "__name__") {
              return left.id.localeCompare(right.id);
            }
            const result = String(left.data[order.field] ?? "").localeCompare(
              String(right.data[order.field] ?? ""),
            );
            return order.direction === "asc" ? result : -result;
          });
          const afterCursor = local.startAfter === null
            ? sorted
            : sorted.filter((entry) => entry.id > local.startAfter);
          const sliced = afterCursor.slice(
            local.offset,
            local.limit == null ? undefined : local.offset + local.limit,
          );
          return { docs: sliced.map((entry) => documentSnapshot(entry.id, entry.data)) };
        },
      };
      return query;
    };
    return {
      pageReads,
      get state() {
        return pageReads.at(-1) ?? {};
      },
      collection(name) {
        return makeQuery(name);
      },
    };
  }

  it("pages authorized projected summaries instead of a Firestore offset window", async () => {
    const documents = Array.from({ length: 40 }, (_, index) => ({
      id: `post-${String(index).padStart(2, "0")}`,
      data: {
        type: "post",
        status: "draft",
        title: `Post ${index}`,
        updatedAt: `2026-07-20T12:${String(index).padStart(2, "0")}:00.000Z`,
        createdBy: "editor-1",
      },
    }));
    const firestore = fakeAddressedFirestore(documents);
    const handler = createCmsListContentHandler({
      firestore,
      requirePrincipalFn: vi.fn(async () => siteWide("editor")),
    });
    const first = makeRes();
    await handler(makeReq({ body: { query: "v=1" } }), first);
    expect(first.statusCode).toBe(200);
    expect(firestore.state.collection).toBe("cmsPosts");
    expect(firestore.state.offset).toBe(0);
    expect(firestore.state.limit).toBeNull();
    expect(firestore.state.orders).toEqual([]);
    expect(first.body.records).toHaveLength(25);
    expect(first.body.records[0].id).toBe("post-39");
    expect(first.body.page).toBe(1);
    expect(first.body.total).toBe(40);
    expect(first.body.pageCount).toBe(2);

    const second = makeRes();
    await handler(makeReq({ body: { query: "page=2&v=1" } }), second);
    expect(second.statusCode).toBe(200);
    expect(second.body.records).toHaveLength(15);
    expect(second.body.records[0].id).toBe("post-14");
    expect(second.body.page).toBe(2);
  });

  it("returns an empty authorized page from the projected snapshot", async () => {
    const firestore = fakeAddressedFirestore([]);
    const handler = createCmsListContentHandler({
      firestore,
      requirePrincipalFn: vi.fn(async () => siteWide("editor")),
    });
    const res = makeRes();
    await handler(makeReq({ body: { query: "v=1" } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.records).toEqual([]);
    expect(res.body.total).toBe(0);
    expect(firestore.state.limit).toBeNull();
  });

  it("authorizes scoped desks after the addressed page read", async () => {
    const firestore = fakeAddressedFirestore([
      {
        id: "news-one",
        data: {
          type: "post",
          status: "draft",
          title: "News desk",
          section: "news",
          updatedAt: "2026-07-20T12:00:00.000Z",
          createdBy: "editor-1",
        },
      },
      {
        id: "watch-one",
        data: {
          type: "post",
          status: "draft",
          title: "Watch desk",
          section: "watch",
          updatedAt: "2026-07-20T11:00:00.000Z",
          createdBy: "editor-1",
        },
      },
    ]);
    const handler = createCmsListContentHandler({
      firestore,
      requirePrincipalFn: vi.fn(async () => scoped("editor")),
    });
    const res = makeRes();
    await handler(makeReq({ body: { query: "v=1" } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.records.map((record) => record.id)).toEqual(["news-one"]);
    expect(res.body.allCount).toBe(1);
    expect(res.body.total).toBe(1);
    expect(res.body.records[0]).not.toHaveProperty("section");
  });

  it("refuses a malformed section-scoped grant before reading Firestore", async () => {
    // `sections` present but empty or not an array confers nothing -- it is a broken grant,
    // never a site-wide one -- so the caller could not be shown a single row.
    for (const sections of [[], null, "news", 7]) {
      const readRecordsFn = vi.fn(async () => storedSummaries);
      const handler = createCmsListContentHandler({
        requirePrincipalFn: vi.fn(async () => ({
          uid: "editor-1",
          email: "editor-1@example.org",
          principal: { id: "editor-1", grants: [{ role: "editor", sections }] },
        })),
        readRecordsFn,
        log: { warn: vi.fn(), error: vi.fn() },
      });
      const res = makeRes();

      await handler(makeReq({ body: { query: "v=1" } }), res);

      expect(res.statusCode, String(sections)).toBe(403);
      expect(res.body.error).toBe("You do not have permission to list content.");
      expect(readRecordsFn).not.toHaveBeenCalled();
    }
  });

  it("refuses a caller with no content capability before reading Firestore", async () => {
    const readRecordsFn = vi.fn();
    const handler = createCmsListContentHandler({
      requirePrincipalFn: vi.fn(async () => noGrants()),
      readRecordsFn,
      log: { warn: vi.fn(), error: vi.fn() },
    });
    const res = makeRes();

    await handler(makeReq({ body: { query: "v=1" } }), res);

    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe("You do not have permission to list content.");
    expect(readRecordsFn).not.toHaveBeenCalled();
  });
});

describe("cmsListContent emulator wiring", () => {
  let db;
  let clientApp;
  let clientAuth;

  beforeAll(() => {
    if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
    db = admin.firestore();
    clientApp = initClient(
      { apiKey: "demo-key", projectId: PROJECT },
      "list-content-test",
    );
    clientAuth = getAuth(clientApp);
    connectAuthEmulator(clientAuth, `http://${AUTH_HOST}`, {
      disableWarnings: true,
    });
  });

  beforeEach(async () => {
    await clearEmulatorFirestore(
      `http://${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
      { method: "DELETE" },
    );
    await fetch(
      `http://${AUTH_HOST}/emulator/v1/projects/${PROJECT}/accounts`,
      {
        method: "DELETE",
      },
    );
  });

  afterAll(async () => {
    await deleteApp(clientApp);
    await Promise.all(admin.apps.map((app) => app.delete()));
  });

  it("serves the exported endpoint with real auth and Firestore", async () => {
    // Finish account creation before password sign-in: refreshing a signup token
    // retains auth_time, which can precede the emulator's validSince.
    await admin.auth().createUser({
      email: "library-admin@example.com",
      password: "password123",
      emailVerified: true,
    });
    const credential = await signInWithEmailAndPassword(
      clientAuth, "library-admin@example.com", "password123",
    );
    const uid = credential.user.uid;
    await db.collection("users").doc(uid).set({ role: "admin", grants: [] });
    await Promise.all([
      db.collection("cmsPosts").doc("mine").set({
        type: "article",
        title: "My draft",
        status: "draft",
        createdBy: uid,
        updatedAt: "2026-07-20T15:00:00.000Z",
        updatedBy: uid,
        assignee: "someone-else",
        version: 7,
      }),
      db.collection("cmsPosts").doc("theirs").set({
        type: "program",
        title: "Their program",
        status: "published",
        publiclyVisible: true,
        publishBuildPending: true,
        published: { sourceVersion: 8, contentVersion: 4 },
        createdBy: "someone-else",
        updatedAt: "2026-07-20T14:00:00.000Z",
        updatedBy: "someone-else",
        assignee: uid,
        version: 12,
        contentVersion: 5,
      }),
      db.collection("cmsPosts").doc("deleted").set({
        type: "article",
        title: "Deleted",
        status: "draft",
        deleted: true,
      }),
    ]);
    const token = await credential.user.getIdToken();
    await signOut(clientAuth);

    const response = await fetch(fnUrl("cmsListContent"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: "assigned=me&v=1" }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      success: true,
      total: 1,
      allCount: 2,
      mineCount: 1,
      assignedCount: 1,
      records: [
        {
          id: "theirs",
          title: "Their program",
          version: 12,
          contentVersion: 5,
          publishedSourceVersion: 8,
          publishedContentVersion: 4,
          publicUpdatePending: true,
        },
      ],
    });
    expect(body.records[0]).not.toHaveProperty("liveSourceVersion");
  }, 20_000);

  it("projects Page editorial counters independently of lifecycle transactions", async () => {
    await admin.auth().createUser({
      email: "page-status@example.test",
      password: "local-status-fixture-password",
      emailVerified: true,
    });
    const credential = await signInWithEmailAndPassword(
      clientAuth, "page-status@example.test", "local-status-fixture-password",
    );
    const uid = credential.user.uid;
    await db.collection("users").doc(uid).set({ role: "admin", grants: [] });
    await Promise.all([
      db.collection("cmsPages").doc("contact").set({ title: "Contact", status: "draft", section: "station",
        version: 44, contentVersion: 3, publiclyVisible: true, publicSourceVersion: 8,
        published: { sourceVersion: 8, contentVersion: 2, metadata: { title: "Contact" } } }),
      db.collection("cmsPages").doc("about").set({ title: "About", status: "approved", section: "station",
        version: 44, contentVersion: 2, publiclyVisible: true, publicSourceVersion: 8,
        published: { sourceVersion: 8, contentVersion: 2, metadata: { title: "About" } } }),
      db.collection("cmsPages").doc("faq").set({ title: "FAQ", status: "draft", section: "station",
        version: 44, publiclyVisible: true, publicSourceVersion: 8,
        published: { sourceVersion: 8, metadata: { title: "FAQ" } } }),
    ]);
    const token = await credential.user.getIdToken();
    await signOut(clientAuth);
    const response = await fetch(fnUrl("cmsListContent"), {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ view: "pages" }),
    });
    expect(response.status).toBe(200);
    const { pages } = await response.json();
    expect(pages.find(page => page.id === "contact")).toMatchObject({
      version: 44, contentVersion: 3, publishedContentVersion: 2, liveSourceVersion: 8,
    });
    expect(pages.find(page => page.id === "about")).toMatchObject({
      version: 44, contentVersion: 2, publishedContentVersion: 2, liveSourceVersion: 8,
    });
    const legacy = pages.find(page => page.id === "faq");
    expect(legacy).toMatchObject({ version: 44, liveSourceVersion: 8 });
    expect(legacy).not.toHaveProperty("contentVersion");
    expect(legacy).not.toHaveProperty("publishedContentVersion");
  });

  it("serves a contributor only their records through the real principal resolver", async () => {
    await admin.auth().createUser({
      email: "library-contributor@example.com",
      password: "password123",
      emailVerified: true,
    });
    const credential = await signInWithEmailAndPassword(
      clientAuth, "library-contributor@example.com", "password123",
    );
    const uid = credential.user.uid;
    await db
      .collection("users")
      .doc(uid)
      .set({
        role: null,
        grants: [{ role: "contributor" }],
      });
    await Promise.all([
      db.collection("cmsPosts").doc("owned").set({
        type: "post",
        title: "My post",
        status: "draft",
        createdBy: uid,
        updatedBy: uid,
        updatedAt: "2026-07-20T15:00:00.000Z",
      }),
      db.collection("cmsPosts").doc("private-to-other").set({
        type: "program",
        title: "Their program",
        status: "published",
        createdBy: "someone-else",
        updatedBy: "someone-else",
        updatedAt: "2026-07-20T14:00:00.000Z",
      }),
    ]);
    const token = await credential.user.getIdToken();
    await signOut(clientAuth);

    const response = await fetch(fnUrl("cmsListContent"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: "v=1" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      total: 1,
      allCount: 1,
      mineCount: 1,
      records: [{ id: "owned", title: "My post" }],
      statusCounts: { draft: 1, published: 0 },
    });
  }, 20_000);
});
