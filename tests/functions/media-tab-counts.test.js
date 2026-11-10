import { describe, expect, it, vi } from "vitest";
import tabCounts from "../../functions/lib/media-tab-counts.js";
import mediaSources from "../../functions/lib/media-sources.js";

const { computeMediaTabCounts } = tabCounts;
const { MediaSourceAccessError } = mediaSources;

// A small Firestore double: records every count() and document read, and answers counts from
// a caller-supplied function so each test states exactly which query it expects.
function fakeFirestore({ count = () => 0, docs = {} } = {}) {
  const calls = [];
  function query(path, filters = [], order = []) {
    return {
      where: (field, op, value) => query(path, [...filters, [field, op, value]], order),
      orderBy: (field, direction = "asc") => query(path, filters, [...order, [field, direction]]),
      count: () => ({
        get: async () => {
          const call = { type: "count", path, filters, order };
          calls.push(call);
          const value = await count(call);
          return { data: () => ({ count: value }) };
        },
      }),
    };
  }
  function collection(path) {
    return {
      ...query(path),
      doc: (id) => ({
        get: async () => {
          calls.push({ type: "get", path: `${path}/${id}` });
          const data = docs[`${path}/${id}`];
          return { exists: data !== undefined, data: () => data };
        },
        collection: (child) => collection(`${path}/${id}/${child}`),
      }),
    };
  }
  return { calls, collection };
}

function videoSource(overrides = {}) {
  return {
    id: "video-library",
    label: "Shared video library",
    access: "active_staff",
    writable: true,
    ...overrides,
  };
}

function archiveSource(id) {
  return videoSource({ id, label: id, access: "archive", writable: false });
}

function actor(grants, overrides = {}) {
  return {
    uid: "staff-1",
    emailVerified: true,
    principal: { id: "staff-1", grants },
    ...overrides,
  };
}

function counted(call) {
  if (call.path === "media_assets") return call.filters.some(([field]) => field === "kind") ? 4 : 1204;
  if (call.path === "mediaSourceAssets") return 412;
  if (call.path === "mediaFavorites/staff-1/items") return 9;
  throw new Error(`unexpected count ${call.path}`);
}

describe("computeMediaTabCounts", () => {
  it("aliases the canonical Audio count without reading the legacy take count", async () => {
    const firestore = fakeFirestore({
      count: counted,
      docs: { "voiceoverLibrary/current": { takeCount: 999 } },
    });
    const counts = await computeMediaTabCounts({
      firestore,
      actor: actor([{ role: "editor" }]),
      approvedActive: true,
      registry: new Map([["video-library", videoSource()]]),
    });

    expect(counts).toEqual({
      images: 1200,
      audio: 4,
      favorites: 9,
      voiceovers: 4,
      sources: { "video-library": 412 },
    });
    expect(firestore.calls).toContainEqual({
      type: "count",
      path: "media_assets",
      filters: [["lifecycle", "==", "active"]],
      order: [],
    });
    // The video count uses the list's own base query, so it matches what the tab can page to.
    expect(firestore.calls).toContainEqual({
      type: "count",
      path: "mediaSourceAssets",
      filters: [["sourceId", "==", "video-library"], ["lifecycle", "==", "active"]],
      order: [["updatedAtSort", "desc"]],
    });
    expect(firestore.calls).toContainEqual({
      type: "count",
      path: "mediaFavorites/staff-1/items",
      filters: [],
      order: [],
    });
    expect(firestore.calls.filter((call) => call.type === "get")).toEqual([]);
    expect(firestore.calls.filter((call) =>
      call.path === "media_assets" &&
      call.filters.some(([field]) => field === "kind"))).toHaveLength(1);
  });

  it("uses an Images total already in hand instead of counting media again", async () => {
    const firestore = fakeFirestore({ count: counted });
    const counts = await computeMediaTabCounts({
      firestore,
      actor: actor([{ role: "editor" }]),
      approvedActive: true,
      registry: new Map(),
      imagesCount: 37,
    });
    expect(counts.images).toBe(37);
    expect(firestore.calls.filter((call) => call.path === "media_assets")).toEqual([
      { type: "count", path: "media_assets", filters: [["lifecycle", "==", "active"], ["kind", "==", "audio"]], order: [] },
    ]);
  });

  it("counts site-wide media with one query even for 31 content areas", async () => {
    const sections = Array.from({ length: 31 }, (_, index) => `section-${index}`);
    const firestore = fakeFirestore({
      count: (call) => call.path === "media_assets" && !call.filters.some(([field]) => field === "kind") ? 31 : 0,
    });
    const counts = await computeMediaTabCounts({
      firestore,
      actor: actor([
        { role: "editor", sections, registeredMediaSections: sections },
        { role: "contributor", sections: ["contributor-only"], registeredMediaSections: ["contributor-only"] },
      ]),
      approvedActive: true,
      registry: new Map(),
    });
    const imageCalls = firestore.calls.filter((call) => call.path === "media_assets" && !call.filters.some(([field]) => field === "kind"));
    expect(imageCalls).toEqual([{
      type: "count", path: "media_assets", filters: [["lifecycle", "==", "active"]], order: [],
    }]);
    expect(counts.images).toBe(31);
  });

  it("counts Audio but leaves out Images for read-only staff and skips inactive account features", async () => {
    const firestore = fakeFirestore({ count: counted });
    const staff = await computeMediaTabCounts({
      firestore,
      actor: actor([{ role: "staff" }]),
      approvedActive: true,
      registry: new Map([["video-library", videoSource()]]),
    });
    expect(staff).toEqual({ audio: 4, favorites: 9, voiceovers: 4, sources: { "video-library": 412 } });

    const inactiveStore = fakeFirestore({ count: counted });
    const inactive = await computeMediaTabCounts({
      firestore: inactiveStore,
      actor: actor([{ role: "editor" }]),
      approvedActive: false,
      registry: new Map([["video-library", videoSource()]]),
    });
    expect(inactive).not.toHaveProperty("favorites");
    expect(inactive).not.toHaveProperty("sources");
    expect(inactiveStore.calls.some((call) => call.path === "mediaSourceAssets")).toBe(false);
    expect(inactiveStore.calls.some((call) => call.path.startsWith("mediaFavorites"))).toBe(false);
  });

  it("counts only audio site-wide for a read-only contributor", async () => {
    const firestore = fakeFirestore({
      count: (call) => {
        if (call.path === "media_assets") {
          expect(call.filters).toContainEqual(["kind", "==", "audio"]);
          return 2;
        }
        if (call.path === "mediaFavorites/staff-1/items") return 0;
        throw new Error(`unexpected count ${call.path}`);
      },
    });
    const counts = await computeMediaTabCounts({
      firestore,
      actor: actor([{ role: "contributor", sections: ["news", "arts"], registeredMediaSections: ["news", "arts"] }]),
      approvedActive: true,
      registry: new Map(),
    });
    expect(counts.audio).toBe(2);
    expect(counts.voiceovers).toBe(2);
    expect(counts).not.toHaveProperty("images");
    expect(firestore.calls.filter((call) => call.path === "media_assets")).toEqual([{
      type: "count",
      path: "media_assets",
      filters: [
        ["lifecycle", "==", "active"],
        ["kind", "==", "audio"],
      ],
      order: [],
    }]);
  });

  it("keeps the compatibility alias on the canonical Audio scope without a legacy read", async () => {
    const firestore = fakeFirestore({ count: counted, docs: { "voiceoverLibrary/current": { takeCount: 999 } } });
    const counts = await computeMediaTabCounts({
      firestore,
      actor: actor([{ role: "editor" }], { emailVerified: false }),
      approvedActive: true,
      registry: new Map(),
    });
    expect(counts.audio).toBe(4);
    expect(counts.voiceovers).toBe(4);
    expect(firestore.calls.some((call) => call.path === "voiceoverLibrary/current")).toBe(false);
  });

  it("does not count Audio for an unverified read-only account", async () => {
    const firestore = fakeFirestore({ count: counted });
    const counts = await computeMediaTabCounts({
      firestore,
      actor: actor([{ role: "staff" }], { emailVerified: false }),
      approvedActive: true,
      registry: new Map(),
    });
    expect(counts).not.toHaveProperty("audio");
    expect(counts).not.toHaveProperty("voiceovers");
    expect(firestore.calls.some((call) => call.path === "media_assets")).toBe(false);
  });

  it("uses site-wide Editor media rights independently of an unverified staff grant", async () => {
    const firestore = fakeFirestore({
      count: (call) => {
        if (call.path === "mediaFavorites/staff-1/items") return 0;
        if (call.path !== "media_assets") throw new Error(`unexpected count ${call.path}`);
        expect(call.filters.some(([field]) => field === "category")).toBe(false);
        return call.filters.some(([field]) => field === "kind") ? 2 : 10;
      },
    });
    const counts = await computeMediaTabCounts({
      firestore,
      actor: actor([
        { role: "editor", sections: ["news"], registeredMediaSections: ["news"] },
        { role: "staff" },
      ], { emailVerified: false }),
      approvedActive: true,
      registry: new Map(),
    });
    expect(counts).toEqual({ audio: 2, voiceovers: 2, images: 8, favorites: 0 });
    expect(firestore.calls.filter((call) => call.path === "media_assets"))
      .toHaveLength(2);
  });

  it("counts archive sources only with the active category and a grant, reading the category once", async () => {
    const registry = new Map([
      ["archive-originals", archiveSource("archive-originals")],
      ["archive-working", archiveSource("archive-working")],
    ]);
    const withoutCategory = fakeFirestore({ count: counted });
    const hidden = await computeMediaTabCounts({
      firestore: withoutCategory,
      actor: actor([{ role: "editor" }]),
      approvedActive: true,
      registry,
    });
    expect(hidden).not.toHaveProperty("sources");
    expect(withoutCategory.calls.filter((call) => call.path === "mediaCategories/archive")).toHaveLength(1);

    const withCategory = fakeFirestore({
      count: counted,
      docs: { "mediaCategories/archive": { id: "archive", label: "Archive", order: 30, active: true, version: 1 } },
    });
    const staffOnly = await computeMediaTabCounts({
      firestore: withCategory,
      actor: actor([{ role: "staff" }]),
      approvedActive: true,
      registry,
    });
    expect(staffOnly).not.toHaveProperty("sources");

    const granted = await computeMediaTabCounts({
      firestore: withCategory,
      actor: actor([{ role: "editor", sections: ["archive"], registeredMediaSections: ["archive"] }]),
      approvedActive: true,
      registry,
    });
    expect(granted.sources).toEqual({ "archive-originals": 412, "archive-working": 412 });
    expect(withCategory.calls.filter((call) => call.path === "mediaCategories/archive")).toHaveLength(2);
  });

  it("counts only sources the caller already authorized when it passes their ids", async () => {
    const firestore = fakeFirestore({ count: counted });
    const authorizeFn = vi.fn();
    const counts = await computeMediaTabCounts({
      firestore,
      actor: actor([{ role: "staff" }]),
      approvedActive: true,
      registry: new Map([
        ["video-library", videoSource()],
        ["archive-originals", archiveSource("archive-originals")],
      ]),
      browseSourceIds: ["video-library"],
      authorizeFn,
    });
    expect(authorizeFn).not.toHaveBeenCalled();
    expect(counts.sources).toEqual({ "video-library": 412 });
  });

  it("leaves out a failed or invalid count, logs once and never throws", async () => {
    const log = { warn: vi.fn() };
    const firestore = fakeFirestore({
      count: (call) => {
        if (call.path === "mediaSourceAssets") throw new Error("index missing");
        if (call.path === "media_assets") return -1;
        return 3;
      },
    });
    const counts = await computeMediaTabCounts({
      firestore,
      actor: actor([{ role: "editor" }]),
      approvedActive: true,
      registry: new Map([["video-library", videoSource()]]),
      log,
    });
    expect(counts).toEqual({ favorites: 3 });
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][1]).toMatchObject({
      failed: expect.arrayContaining(["audio", "images", "voiceovers", "sources.video-library"]),
    });
  });

  it("keeps an unexpected authorization failure out of the counts", async () => {
    const log = { warn: vi.fn() };
    const counts = await computeMediaTabCounts({
      firestore: fakeFirestore({ count: counted }),
      actor: actor([{ role: "staff" }]),
      approvedActive: true,
      registry: new Map([["video-library", videoSource()]]),
      authorizeFn: async () => { throw new MediaSourceAccessError(500, "boom"); },
      log,
    });
    expect(counts).not.toHaveProperty("sources");
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});
