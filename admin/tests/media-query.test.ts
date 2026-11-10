import { describe, expect, it } from "vitest";
import {
  DEFAULT_COLLECTIONS_MEDIA_LOCATION,
  DEFAULT_FAVORITES_MEDIA_LOCATION,
  DEFAULT_MEDIA_QUERY,
  DEFAULT_VIDEO_MEDIA_QUERY,
  encodeCollectionsMediaLocation,
  encodeFavoritesMediaLocation,
  encodeMediaLocation,
  encodeVideoMediaLocation,
  parseCollectionsMediaLocation,
  parseFavoritesMediaLocation,
  parseMediaLocation,
  parseVideoMediaLocation,
} from "../src/lib/media-query";

describe("media location query", () => {
  it("round-trips shareable filters and selection", () => {
    const query = {
      ...DEFAULT_MEDIA_QUERY,
      q: "studio",
      categories: ["news", "arts"],
      kinds: ["image" as const],
      sort: "name" as const,
      direction: "asc" as const,
      page: 3,
    };

    const encoded = encodeMediaLocation(query, "asset-one").toString();
    expect(parseMediaLocation(encoded)).toEqual({
      query,
      selectedId: "asset-one",
    });
  });

  it("drops unsupported values and bounds the request", () => {
    const parsed = parseMediaLocation(
      "q=studio&category=News&category=news&kind=video&sort=secret&direction=sideways&page=-2&selected=bad%2Fid",
    );

    expect(parsed).toEqual({
      query: { ...DEFAULT_MEDIA_QUERY, q: "studio", categories: ["news"] },
      selectedId: null,
    });
  });

  it("omits default values from a clean URL", () => {
    expect(encodeMediaLocation({ ...DEFAULT_MEDIA_QUERY }, null).toString()).toBe("");
  });

  it("round-trips a saved view id with filters and selection", () => {
    const query = { ...DEFAULT_MEDIA_QUERY, categories: ["news"] };
    const encoded = encodeMediaLocation(query, "asset-one", "recent-news").toString();
    expect(encoded).toContain("view=recent-news");
    expect(parseMediaLocation(encoded)).toEqual({ query, selectedId: "asset-one", view: "recent-news" });
  });

  it("drops a view id that is empty, over 128 characters or outside [A-Za-z0-9_-]", () => {
    for (const bad of ["", "a".repeat(129), "bad/id", "has space"]) {
      const parsed = parseMediaLocation(`view=${encodeURIComponent(bad)}`);
      expect(parsed).not.toHaveProperty("view");
    }
    expect(parseMediaLocation(`view=${"a".repeat(128)}`).view).toBe("a".repeat(128));
  });

  it("never puts the view id inside the list query", () => {
    const parsed = parseMediaLocation("view=recent-news&q=studio");
    expect(parsed.query).not.toHaveProperty("view");
    const query = { ...DEFAULT_MEDIA_QUERY, q: "studio" };
    expect(encodeMediaLocation(query, "a1").toString()).toBe(encodeMediaLocation(query, "a1", null).toString());
    expect(encodeMediaLocation(query, "a1").toString()).toBe("q=studio&selected=a1");
  });
});

describe("video media location query", () => {
  it.each([
    ["tag", "Interview"],
    ["by", "staff-one"],
    ["rights", "pending"],
  ] as const)("round-trips search with one %s filter, sort, limit and an opened item", (field, value) => {
    const query = {
      ...DEFAULT_VIDEO_MEDIA_QUERY,
      q: "news",
      [field]: value,
      sort: "updated_asc" as const,
      limit: 48 as const,
    };

    const encoded = encodeVideoMediaLocation(query, "video-one").toString();
    expect(parseVideoMediaLocation(encoded)).toEqual({ query, selectedId: "video-one" });
  });

  it("drops every structured filter when an untrusted URL supplies more than one", () => {
    expect(parseVideoMediaLocation("tag=Interview&by=staff-one&rights=pending")).toEqual({
      query: DEFAULT_VIDEO_MEDIA_QUERY,
      selectedId: null,
    });
  });

  it("accepts only listed sorts and page sizes and never restores a cursor from the URL", () => {
    expect(parseVideoMediaLocation("sort=secret&limit=47&cursor=opaque&asset=bad%2Fid")).toEqual({
      query: DEFAULT_VIDEO_MEDIA_QUERY,
      selectedId: null,
    });
    expect(parseVideoMediaLocation("sort=name_asc&limit=96").query).toMatchObject({ sort: "name_asc", limit: 96 });
    expect(parseVideoMediaLocation("sort=size_desc").query.sort).toBe("size_desc");
    expect(parseVideoMediaLocation("sort=size_asc").query.sort).toBe("size_asc");
    expect(encodeVideoMediaLocation({ ...DEFAULT_VIDEO_MEDIA_QUERY, cursor: "opaque" }, null).toString()).toBe("");
  });

  it("bounds search and structured filter values before they can reach the list request", () => {
    expect(parseVideoMediaLocation(`q=${"a".repeat(200)}`).query.q).toHaveLength(160);
    expect(parseVideoMediaLocation(`q=${"İ".repeat(160)}`).query.q).toHaveLength(80);
    expect(parseVideoMediaLocation(`tag=${"a".repeat(81)}`).query).toEqual(DEFAULT_VIDEO_MEDIA_QUERY);
    expect(parseVideoMediaLocation(`by=${"a".repeat(129)}`).query).toEqual(DEFAULT_VIDEO_MEDIA_QUERY);
  });

  it("keeps a bounded saved view id outside the video list query", () => {
    const query = { ...DEFAULT_VIDEO_MEDIA_QUERY, tag: "Interview" };
    const encoded = encodeVideoMediaLocation(query, null, "interviews").toString();
    expect(parseVideoMediaLocation(encoded)).toEqual({ query, selectedId: null, view: "interviews" });
    expect(parseVideoMediaLocation("view=bad%2Fid")).not.toHaveProperty("view");
  });
});

describe("Favorites and Collections media location queries", () => {
  it("keeps equal backend ids distinct by round-tripping the full reference", () => {
    const favoriteR2 = parseFavoritesMediaLocation(
      encodeFavoritesMediaLocation("image", { backend: "r2", id: "same-id" }).toString(),
    );
    const favoriteS3 = parseFavoritesMediaLocation(
      encodeFavoritesMediaLocation("video", { backend: "s3", sourceId: "source-one", id: "same-id" }).toString(),
    );
    expect(favoriteR2.selectedRef).toEqual({ backend: "r2", id: "same-id" });
    expect(favoriteS3.selectedRef).toEqual({ backend: "s3", sourceId: "source-one", id: "same-id" });

    const collectionS3 = parseCollectionsMediaLocation(
      encodeCollectionsMediaLocation("archived", "all_staff", favoriteS3.selectedRef).toString(),
    );
    expect(collectionS3).toEqual({
      show: "archived",
      scope: "all_staff",
      selectedRef: { backend: "s3", sourceId: "source-one", id: "same-id" },
    });
  });

  it("drops malformed or oversized full references and unsupported filters", () => {
    for (const asset of ["same-id", "r2:bad/id", `r2:${"a".repeat(129)}`, "s3:source-only", "s3:source:bad/id"]) {
      expect(parseFavoritesMediaLocation(`asset=${encodeURIComponent(asset)}`).selectedRef).toBeNull();
      expect(parseCollectionsMediaLocation(`asset=${encodeURIComponent(asset)}`).selectedRef).toBeNull();
    }
    expect(parseFavoritesMediaLocation("kind=unsupported")).toEqual(DEFAULT_FAVORITES_MEDIA_LOCATION);
    expect(parseFavoritesMediaLocation("kind=audio")).toEqual({ kind: "audio", selectedRef: null });
    expect(parseCollectionsMediaLocation("show=deleted&scope=public")).toEqual(DEFAULT_COLLECTIONS_MEDIA_LOCATION);
  });

  it("omits default values from clean URLs", () => {
    expect(encodeFavoritesMediaLocation(null, null).toString()).toBe("");
    expect(encodeCollectionsMediaLocation("active", null, null).toString()).toBe("");
  });

  it("keeps bounded personal view references outside Favorites and Collections filters", () => {
    expect(parseFavoritesMediaLocation(encodeFavoritesMediaLocation("video", null, "videos").toString()))
      .toEqual({ kind: "video", selectedRef: null, view: "videos" });
    expect(parseCollectionsMediaLocation(encodeCollectionsMediaLocation("archived", "private", null, "mine").toString()))
      .toEqual({ show: "archived", scope: "private", selectedRef: null, view: "mine" });
    expect(parseFavoritesMediaLocation("view=bad%2Fid")).not.toHaveProperty("view");
    expect(parseCollectionsMediaLocation("view=bad%2Fid")).not.toHaveProperty("view");
  });
});
