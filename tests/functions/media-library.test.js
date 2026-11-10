import { describe, expect, it } from "vitest";
import mediaLibrary from "../../functions/lib/media-library.js";

const {
  MAX_MEDIA_ASSET_IDS,
  MAX_MEDIA_LIBRARY_PAGE_SIZE,
  MEDIA_LIBRARY_PAGE_SIZE,
  MediaLibraryValidationError,
  formatMediaEtag,
  mediaAssetSummary,
  mediaDisplayUrl,
  parseMediaListRequest,
  parseMediaIfMatch,
  selectMediaLibrary,
} = mediaLibrary;

const assets = [
  {
    id: "studio-one",
    name: "Studio control room",
    originalName: "studio.png",
    category: "news",
    tags: ["studio", "control room"],
    description: "The main NJ PBS control room.",
    altText: "Monitors in the control room",
    license: "NJ PBS owned",
    credit: "NJ PBS",
    mimeType: "image/png",
    kind: "image",
    sizeBytes: 1024,
    width: 1200,
    height: 800,
    url: "https://media.njpbs.org/cms-media/news/studio-one/hash.png",
    lifecycle: "active",
    version: 2,
    createdAt: "2026-08-12T12:00:00.000Z",
    createdBy: "editor-1",
    updatedAt: "2026-08-13T12:00:00.000Z",
    updatedBy: "editor-2",
  },
  {
    id: "annual-report",
    name: "Annual report",
    originalName: "annual-report.pdf",
    category: "development",
    tags: ["annual", "report"],
    description: "The 2025 annual report.",
    altText: null,
    license: "NJ PBS owned",
    credit: null,
    mimeType: "application/pdf",
    kind: "document",
    sizeBytes: 2048,
    width: null,
    height: null,
    url: "https://media.njpbs.org/cms-media/development/annual-report/hash.pdf",
    lifecycle: "active",
    version: 1,
    createdAt: "2026-08-11T12:00:00.000Z",
    createdBy: "editor-1",
    updatedAt: "2026-08-11T12:00:00.000Z",
    updatedBy: "editor-1",
  },
  {
    id: "studio-two",
    name: "Studio portrait",
    originalName: "portrait.jpg",
    category: "arts",
    tags: ["portrait"],
    description: "A guest portrait.",
    altText: "A guest in the studio",
    license: "Editorial use",
    credit: "Staff photographer",
    mimeType: "image/jpeg",
    kind: "image",
    sizeBytes: 512,
    width: 600,
    height: 900,
    url: "https://media.njpbs.org/cms-media/arts/studio-two/hash.jpg",
    lifecycle: "active",
    version: 3,
    createdAt: "2026-08-10T12:00:00.000Z",
    createdBy: "editor-2",
    updatedAt: "2026-08-12T12:00:00.000Z",
    updatedBy: "editor-2",
  },
];

describe("media library contract", () => {
  it("projects only original availability and preserves it through a second list projection", () => {
    const contentHash = "b".repeat(64);
    const master = { retained: true, contentHash, key: `masters/bb/${contentHash}.jpg`,
      mimeType: "image/jpeg", sizeBytes: 8_000_000, width: 6000, height: 4000 };
    const raw = { ...assets[0], source: "upload", master, contentHash, storageKey: "private" };
    const summary = mediaAssetSummary(raw.id, raw);
    expect(summary.originalAvailable).toBe(true);
    expect(summary.originalFormat).toBe("JPG");
    expect(mediaAssetSummary(summary.id, summary)).toEqual(summary);
    const pngHash = "c".repeat(64);
    const png = { ...master, contentHash: pngHash, key: `masters/cc/${pngHash}.png`, mimeType: "image/png" };
    expect(mediaAssetSummary(raw.id, { ...raw, master: png }).originalFormat).toBe("PNG");
    expect(mediaAssetSummary(summary.id, { ...summary, originalFormat: "masters/x" })).not.toHaveProperty("originalFormat");
    expect(summary).not.toHaveProperty("master");
    expect(summary).not.toHaveProperty("storageKey");
    expect(summary).not.toHaveProperty("contentHash");
    expect(JSON.stringify(summary)).not.toContain("masters/");
    for (const invalid of [null, { ...master, retained: false }, { ...master, key: "wrong" }]) {
      expect(mediaAssetSummary(raw.id, { ...raw, master: invalid, originalAvailable: true }))
        .not.toHaveProperty("originalAvailable");
    }
    expect(mediaAssetSummary(raw.id, { ...raw, source: "site_seed" })).not.toHaveProperty("originalAvailable");
  });
  it("keeps uploaded audio out of Images and admits it only to Audio or exact-id reads", () => {
    const audio = { ...assets[0], id: "interview", kind: "audio", mimeType: "audio/wav", width: null, height: null };
    expect(mediaAssetSummary(audio.id, audio)?.kind).toBe("audio");
    expect(selectMediaLibrary([...assets, audio], parseMediaListRequest({})).records.map(asset => asset.id).sort())
      .toEqual(["annual-report", "studio-one", "studio-two"]);
    expect(selectMediaLibrary([...assets, audio], parseMediaListRequest({ kinds: ["audio"] })).records).toEqual([audio]);
    expect(selectMediaLibrary([audio], parseMediaListRequest({ assetIds: ["interview"] })).records).toEqual([audio]);
  });
  it("parses a strict bounded request with a fixed server page size", () => {
    expect(
      parseMediaListRequest({
        q: "  Studio  ",
        assetIds: ["studio-two", "studio-one", "studio-two"],
        categories: ["arts", "news", "arts"],
        kinds: ["image"],
        sort: "name",
        direction: "asc",
        page: 3,
      }),
    ).toEqual({
      q: "Studio",
      assetIds: ["studio-two", "studio-one"],
      categories: ["arts", "news"],
      kinds: ["image"],
      sort: "name",
      direction: "asc",
      page: 3,
    });
    expect(MEDIA_LIBRARY_PAGE_SIZE).toBe(30);
    expect(parseMediaListRequest({ pageSize: MAX_MEDIA_LIBRARY_PAGE_SIZE })).toMatchObject({
      page: 1,
      pageSize: MAX_MEDIA_LIBRARY_PAGE_SIZE,
    });
    expect(parseMediaListRequest({})).not.toHaveProperty("pageSize");
  });

  it("rejects unknown, malformed, repeated, and oversized request properties", () => {
    const invalid = [
      null,
      { unknown: true },
      { q: ["studio"] },
      { q: "x".repeat(201) },
      { assetIds: "studio-one" },
      { assetIds: [""] },
      { assetIds: ["studio/one"] },
      {
        assetIds: Array.from(
          { length: MAX_MEDIA_ASSET_IDS + 1 },
          (_, index) => `asset-${index}`,
        ),
      },
      { categories: "news" },
      { categories: Array.from({ length: 21 }, (_, index) => `desk-${index}`) },
      { categories: ["News/local"] },
      { kinds: ["video"] },
      { sort: "contentHash" },
      { direction: "sideways" },
      { page: 0 },
      { pageSize: 0 },
      { pageSize: 1.5 },
      { pageSize: MAX_MEDIA_LIBRARY_PAGE_SIZE + 1 },
      { profilePhotoScope: true },
      { profilePhotoScope: "other" },
    ];
    for (const body of invalid) {
      expect(() => parseMediaListRequest(body), JSON.stringify(body)).toThrow(
        MediaLibraryValidationError,
      );
    }
  });

  it("admits the explicit self profile-photo scope", () => {
    expect(
      parseMediaListRequest({
        categories: ["staff-profile"],
        kinds: ["image"],
        profilePhotoScope: "self",
      }),
    ).toMatchObject({
      categories: ["staff-profile"],
      kinds: ["image"],
      profilePhotoScope: "self",
    });
  });

  it("projects only the explicit private-library response fields", () => {
    const summary = mediaAssetSummary("studio-one", {
      ...assets[0],
      id: "spoofed",
      contentHash: "secret-hash",
      storageKey: "cms-media/news/secret.png",
      source: "upload",
      recoveryCount: 4,
    });

    expect(summary).toEqual({
      ...assets[0],
      altTextGenerated: false,
      metadataUpdateRequested: false,
      categories: ["news"],
      source: "upload",
      etag: formatMediaEtag("studio-one", 2),
    });
    expect(summary).not.toHaveProperty("contentHash");
    expect(summary).not.toHaveProperty("storageKey");
    expect(summary).toHaveProperty("source", "upload");
    expect(summary).not.toHaveProperty("thumbnails");
    const withThumbnail = mediaAssetSummary("studio-one", {
      ...assets[0],
      thumbnails: [{
        width: 480,
        height: 270,
        storageKey: "cms-media/news/studio-one/thumbs/hash-w480.webp",
        url: "https://media.njpbs.org/cms-media/news/studio-one/thumbs/hash-w480.webp",
      }],
    });
    expect(withThumbnail.thumbnails).toEqual([{
      width: 480,
      height: 270,
      url: "https://media.njpbs.org/cms-media/news/studio-one/thumbs/hash-w480.webp",
    }]);
    // cmsListMedia projects its reader's summaries again at the response boundary.
    expect(mediaAssetSummary("studio-one", withThumbnail)).toEqual(withThumbnail);
    expect(mediaDisplayUrl(withThumbnail, 104, 104)).toBe(withThumbnail.thumbnails[0].url);
    expect(mediaDisplayUrl(withThumbnail, 2000)).toBe(withThumbnail.url);
    expect(mediaDisplayUrl({
      ...withThumbnail,
      thumbnails: [{ url: "https://media.njpbs.org/wide.webp", width: 480, height: 40 }],
    }, 104, 104)).toBe(withThumbnail.url);
    expect(mediaDisplayUrl({ ...assets[0], thumbnails: [{ url: "http://evil.test/a.webp", width: 480, height: 270 }] }, 104))
      .toBe(assets[0].url);
    expect(mediaAssetSummary("studio-one", { ...withThumbnail, animated: true }).animated).toBe(true);
    expect(mediaAssetSummary("studio-one", { ...withThumbnail, animated: false }).animated).toBe(false);
    expect(
      mediaAssetSummary("gone", { ...assets[0], lifecycle: "tombstoned" }),
    ).toBeNull();
    expect(mediaAssetSummary("bad", { ...assets[0], version: "2" })).toBeNull();
    expect(
      mediaAssetSummary("bad-categories", {
        ...assets[0],
        categories: ["arts", "arts"],
      }),
    ).toBeNull();
    expect(
      mediaAssetSummary("no-license", { ...assets[0], license: null }),
    ).toHaveProperty("license", null);
    expect(
      mediaAssetSummary("blank-license", { ...assets[0], license: " " }),
    ).toHaveProperty("license", null);
    expect(mediaAssetSummary("bad-license", { ...assets[0], license: 7 })).toBeNull();
  });

  it("filters, counts, and searches every descriptive category assignment", () => {
    const assigned = {
      ...assets[0],
      categories: ["news", "arts"],
    };
    const query = parseMediaListRequest({
      q: "Arts desk",
      categories: ["arts"],
    });

    expect(
      selectMediaLibrary([assigned], query, 30, { arts: "Arts desk" }),
    ).toMatchObject({
      records: [assigned],
      total: 1,
      categoryCounts: { arts: 1, news: 1 },
    });
  });

  it("searches editorial fields, calculates faceted counts, and clamps paging", () => {
    const query = parseMediaListRequest({
      q: "studio",
      categories: ["news"],
      kinds: ["image"],
      sort: "name",
      direction: "asc",
      page: 99,
    });
    const selected = selectMediaLibrary(assets, query, 1);

    expect(selected.records.map((asset) => asset.id)).toEqual(["studio-one"]);
    expect(selected).toMatchObject({
      total: 1,
      allCount: 3,
      page: 1,
      pageCount: 1,
      categoryCounts: { arts: 1, news: 1 },
      kindCounts: { image: 1, document: 0 },
    });
  });

  it("finds an exact asset id first so a saved image can hydrate", () => {
    const distractor = {
      ...assets[2],
      id: "newer-image",
      name: "A newer image",
      description: "Related to studio-one",
      updatedAt: "2026-08-14T12:00:00.000Z",
    };
    const query = parseMediaListRequest({
      q: "studio-one",
      kinds: ["image"],
      sort: "updatedAt",
      direction: "desc",
      page: 1,
    });

    const selected = selectMediaLibrary([...assets, distractor], query, 1);

    expect(selected.records.map((asset) => asset.id)).toEqual(["studio-one"]);
  });

  it("binds a strong If-Match value to one asset and version", () => {
    const etag = formatMediaEtag("studio-one", 2);
    expect(etag).toMatch(/^"media\.[A-Za-z0-9_-]+\.2"$/);
    expect(parseMediaIfMatch(etag, "studio-one")).toBe(2);
    expect(parseMediaIfMatch(etag, "annual-report")).toBeNull();
    expect(parseMediaIfMatch(`W/${etag}`, "studio-one")).toBeNull();
    expect(parseMediaIfMatch("*", "studio-one")).toBeNull();
    expect(parseMediaIfMatch(`${etag}, ${etag}`, "studio-one")).toBeNull();
  });
});
