import { describe, expect, it } from "vitest";
import { DEFAULT_MEDIA_DISPLAY, DEFAULT_VIDEO_MEDIA_DISPLAY } from "../src/lib/media-display";
import { parseMediaLocation, parseVideoMediaLocation } from "../src/lib/media-query";
import {
  MAX_SAVED_MEDIA_VIEWS,
  SavedMediaViewValidationError,
  applySavedMediaViewMutation,
  createSavedMediaView,
  parseSavedMediaViews,
} from "../src/lib/saved-media-views";

describe("saved media views", () => {
  it("canonicalizes each surface query without transient route state", () => {
    expect(
      createSavedMediaView(
        "images-one",
        "  News images  ",
        "images",
        "selected=asset-one&page=4&category=news&sort=name&direction=asc&view=old",
      ),
    ).toEqual({
      id: "images-one",
      name: "News images",
      surface: "images",
      query: "category=news&sort=name&direction=asc",
    });
    expect(
      createSavedMediaView(
        "video-one",
        "Interviews",
        "video:archive",
        "q=news&tag=Interview&cursor=opaque&asset=asset-one&sort=name_asc&limit=48",
      ).query,
    ).toBe("q=news&tag=Interview&sort=name_asc&limit=48");
    expect(createSavedMediaView("favorites-one", "Videos", "favorites", "kind=video&asset=r2%3Aa1").query)
      .toBe("kind=video");
    expect(createSavedMediaView("collections-one", "Archived", "collections", "show=archived&scope=all_staff&asset=r2%3Aa1").query)
      .toBe("show=archived&scope=all_staff");
  });

  it("keeps Audio views distinct from Images while preserving shared media query and display settings", () => {
    const audio = createSavedMediaView("audio-one", "Station reads", "audio", "q=station&category=news&asset=voiceover-one&page=4", DEFAULT_MEDIA_DISPLAY);
    expect(audio).toMatchObject({ surface: "audio", query: "q=station&category=news", display: DEFAULT_MEDIA_DISPLAY });
    const images = createSavedMediaView("images-one", "Station reads", "images", "q=station&category=news", DEFAULT_MEDIA_DISPLAY);
    const stored = applySavedMediaViewMutation([images], {type:"add",view:audio});
    expect(parseSavedMediaViews(stored).map(view => view.surface)).toEqual(["images", "audio"]);
  });

  it("restores the source-specific metadata review filter from a saved view without its previous cursor", () => {
    const view = createSavedMediaView("review", "Review queue", "video:archive",
      "q=news&metadata=requested&sort=updated_asc&limit=48&cursor=opaque&asset=asset-one");
    const [restored] = parseSavedMediaViews([view]);
    expect(restored.surface).toBe("video:archive");
    expect(parseVideoMediaLocation(restored.query)).toEqual({
      query: { q: "news", metadata: "requested", sort: "updated_asc", limit: 48 },
      selectedId: null,
    });
    expect(parseVideoMediaLocation("metadata=requested&tag=Interview").query).not.toHaveProperty("metadata");
  });

  it("round-trips each surface's metadata bounds and removes unsupported filters", () => {
    const images = createSavedMediaView("images", "Latest portraits", "images",
      "updatedFrom=2026-11-22&aspect=portrait&metadata=requested&minDuration=12&page=2");
    const audio = createSavedMediaView("audio", "Short requests", "audio",
      "aspect=square&minDuration=0&maxDuration=30&metadata=requested&cursor=opaque");
    const videos = createSavedMediaView("videos", "Timed videos", "video:archive",
      "q=town&minDuration=30&maxDuration=60&cursor=opaque");
    const restored = parseSavedMediaViews([images, audio, videos]);
    expect(parseMediaLocation(restored[0].query).query).toMatchObject({
      updatedFrom: "2026-11-22", aspect: "portrait", metadataUpdateRequested: true, page: 1,
    });
    expect(restored[0].query).not.toContain("minDuration");
    expect(parseMediaLocation(restored[1].query, true).query).toMatchObject({
      minDuration: 0, maxDuration: 30, metadataUpdateRequested: true,
    });
    expect(restored[1].query).not.toContain("aspect");
    expect(parseVideoMediaLocation(restored[2].query).query).toMatchObject({ q: "town", minDuration: 30, maxDuration: 60 });
    expect(parseVideoMediaLocation("updatedTo=2026-02-30").query).not.toHaveProperty("updatedTo");
    expect(parseVideoMediaLocation("aspect=square&minDuration=10").query).not.toHaveProperty("aspect");
  });

  it("accepts only bounded ids, names, and known source-isolated surfaces", () => {
    for (const create of [
      () => createSavedMediaView("bad/id", "News", "images", ""),
      () => createSavedMediaView("a".repeat(101), "News", "images", ""),
      () => createSavedMediaView("one", " ", "images", ""),
      () => createSavedMediaView("one", "a".repeat(61), "images", ""),
      () => createSavedMediaView("one", "News", "voiceovers", ""),
      () => createSavedMediaView("one", "News", "video:bad/source", ""),
    ]) {
      expect(create).toThrow(SavedMediaViewValidationError);
    }
    expect(createSavedMediaView("one", "News", "video:archive-one", "").surface)
      .toBe("video:archive-one");
  });

  it("normalizes optional display settings through the surface display codec", () => {
    expect(
      createSavedMediaView("one", "News", "images", "", {
        ...DEFAULT_MEDIA_DISPLAY,
        layout: "list",
        density: "invalid",
        fields: { ...DEFAULT_MEDIA_DISPLAY.fields, category: true, size: "yes" },
        unknown: true,
      }).display,
    ).toEqual({
      ...DEFAULT_MEDIA_DISPLAY,
      layout: "list",
      fields: { ...DEFAULT_MEDIA_DISPLAY.fields, category: true },
    });
    expect(
      createSavedMediaView("two", "Video", "video:archive", "limit=96", {
        ...DEFAULT_VIDEO_MEDIA_DISPLAY,
        pageSize: 96,
        fields: { ...DEFAULT_VIDEO_MEDIA_DISPLAY.fields, uploader: true },
      }).display,
    ).toEqual({
      ...DEFAULT_VIDEO_MEDIA_DISPLAY,
      fields: { ...DEFAULT_VIDEO_MEDIA_DISPLAY.fields, uploader: true },
    });
    expect(() => createSavedMediaView("bad", "Bad", "images", "", "list"))
      .toThrow("display settings are invalid");
  });

  it("parses untrusted profile data, keeps the first valid id, and enforces the cap", () => {
    const parsed = parseSavedMediaViews([
      { id: "one", name: " One ", surface: "images", query: "page=9&kind=image" },
      { id: "one", name: "Duplicate", surface: "favorites", query: "kind=video" },
      { id: "broken", name: "", surface: "images", query: "" },
      ...Array.from({ length: MAX_SAVED_MEDIA_VIEWS }, (_, index) => ({
        id: `view-${index}`,
        name: `View ${index}`,
        surface: "collections",
        query: index % 2 === 0 ? "show=archived" : "",
      })),
    ]);

    expect(parsed).toHaveLength(MAX_SAVED_MEDIA_VIEWS);
    expect(parsed[0]).toEqual({
      id: "one",
      name: "One",
      surface: "images",
      query: "kind=image",
    });
    expect(parsed.filter((view) => view.id === "one")).toHaveLength(1);
  });

  it("applies one add or delete and checks duplicates within a surface", () => {
    const current = [
      { id: "images", name: "Recent", surface: "images", query: "sort=createdAt" },
      { id: "video", name: "Recent", surface: "video:archive", query: "sort=name_asc" },
    ];
    expect(
      applySavedMediaViewMutation(current, {
        type: "add",
        view: { id: "favorites", name: "Recent", surface: "favorites", query: "kind=video" },
      }),
    ).toHaveLength(3);
    expect(applySavedMediaViewMutation(current, { type: "delete", id: "images" }))
      .toEqual([current[1]]);
    expect(() =>
      applySavedMediaViewMutation(current, {
        type: "add",
        view: { id: "duplicate", name: "recent", surface: "images", query: "kind=image" },
      }),
    ).toThrow("already exists");
    expect(() =>
      applySavedMediaViewMutation(current, {
        type: "add",
        view: { id: "duplicate", name: "Different", surface: "images", query: "sort=createdAt&page=7" },
      }),
    ).toThrow("already saved");
  });
});
