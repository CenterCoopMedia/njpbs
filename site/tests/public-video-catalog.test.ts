import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fetchPublicVideoCatalog } from "../scripts/fetch-public-video-catalog";
import { main } from "../scripts/sync-launch-content.mjs";
import { mediaManagerWindowAt, readPublicVideoCatalog } from "../src/lib/public-video-catalog";
import { catalogAsset, coastShow, duplicateCoastShow, riverShow } from "./fixtures/public-video-catalog";

const now = new Date("2026-11-20T12:00:00.000Z");
const baseUrl = "https://example.org/api/v1/";
const config = { url: new URL("shows/?audience-scope=local&audience=fixture", baseUrl), authorization: "Basic fixture" };
const result = (data: unknown[], next: string | null = null) => Response.json({ data, links: { next } });
const nextPage = (url: URL) => {
  const next = new URL(url);
  next.searchParams.set("page", "2");
  return next.href;
};

describe("public video catalog", () => {
  it.each([
    { window: { start: "2026-07-09" }, at: "2026-07-09T18:00:00Z", result: "open" },
    { window: { end: "2026-07-09" }, at: "2026-07-09T18:00:00Z", result: "open" },
    { window: { end: "2026-07-09" }, at: "2026-07-10T01:00:00Z", result: "open" },
    { window: { end: "2026-07-09" }, at: "2026-07-10T04:00:00Z", result: "after" },
    { window: { start: null, end: null }, at: "2026-07-09T18:00:00Z", result: "open" },
    { window: { start: "2026-07-09T20:00:00Z" }, at: "2026-07-09T18:00:00Z", result: "before" },
    { window: { end: "2026-07-09T17:00:00Z" }, at: "2026-07-09T18:00:00Z", result: "after" },
    { window: { start: "2026-07-09T18:00:00Z", end: "2026-07-09T18:00:00Z" }, at: "2026-07-09T18:00:00Z", result: "open" },
    { window: { start: "2018-07-25T04:00:00Z", end: "2028-07-24T03:59:59Z" }, at: "2026-07-09T18:00:00Z", result: "open" },
    { window: "2026-07-09", at: "2026-07-09T18:00:00Z", result: "invalid" },
    { window: [], at: "2026-07-09T18:00:00Z", result: "invalid" },
    { window: 42, at: "2026-07-09T18:00:00Z", result: "invalid" },
    { window: { start: "not-a-date" }, at: "2026-07-09T18:00:00Z", result: "invalid" },
    { window: { start: "" }, at: "2026-07-09T18:00:00Z", result: "invalid" },
    { window: { start: "   " }, at: "2026-07-09T18:00:00Z", result: "invalid" },
    { window: { start: null }, at: "nonsense", result: "invalid" },
  ])("evaluates $window at $at as $result", ({ window, at, result }) => {
    expect(mediaManagerWindowAt(window, new Date(at))).toBe(result);
  });

  it("walks both paginated collections and publishes only unambiguous, authorized editions", async () => {
    const publicEpisode = catalogAsset("river-crossing");
    const noCaptions = catalogAsset("river-special", { special: true, title: "River voices",
      attributes: { captions_language: [], transcript: null } });
    const denied = [
      catalogAsset("members", { attributes: { availabilities: { all_members: { start: null } } } }),
      catalogAsset("preview", { attributes: { object_type: "preview" } }),
      catalogAsset("future", { attributes: { availabilities: { public: { start: "2026-11-20T12:00:01Z" } } } }),
      catalogAsset("expired", { attributes: { availabilities: { public: { end: "2026-11-19" } } } }),
      catalogAsset("invalid", { attributes: { availabilities: { public: { start: "2026-02-31" } } } }),
      catalogAsset("windowless", { attributes: { availabilities: { public: {} } } }),
      catalogAsset("resolved-member", { attributes: { playable_window: "station_members" } }),
      catalogAsset("external-player", { attributes: { player_code: "https://example.org/partnerplayer/EXAMPLE/" } }),
      catalogAsset("invalid-slug", { attributes: { parent_tree: { id: "no-slug", type: "special",
        attributes: { show: riverShow, slug: "invalid/slug" } } } }),
    ];
    const duplicate = catalogAsset("river-crossing", { special: true });
    duplicate.id = "other-crossing-asset";
    duplicate.attributes.parent_tree.id = "other-crossing-edition";
    const abbreviated = catalogAsset("river-episode", { attributes: { slug: "river-episode" } });
    abbreviated.attributes.parent_tree.attributes.slug = "";
    const fetch = vi.fn(async (input: URL | string | Request, options?: RequestInit) => {
      expect(options?.redirect).toBe("error");
      const url = new URL(input.toString());
      const second = url.searchParams.has("page");
      if (url.pathname.endsWith("/shows/")) {
        expect(url.searchParams.get("audience")).toBe("fixture");
        return second ? result([duplicateCoastShow]) : result([riverShow, coastShow], nextPage(url));
      }
      expect(url.searchParams.getAll("show-id")).toEqual([riverShow.id]);
      expect(url.searchParams.get("available")).toBe("public");
      expect(url.searchParams.get("type")).toBe("full_length");
      return second ? result([noCaptions, duplicate, abbreviated]) : result([publicEpisode, ...denied], nextPage(url));
    });

    const snapshot = await fetchPublicVideoCatalog(config, fetch, now);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(readPublicVideoCatalog(snapshot)).toEqual(snapshot);
    expect(snapshot.programs).toHaveLength(1);
    const [program] = snapshot.programs;
    expect(program).toMatchObject({ slug: "river-stories", description: "Available through PBS video." });
    expect(program.episodes.map(video => video.slug)).toEqual(["river-episode", "river-special"]);
    expect(program.episodes[0]).toMatchObject({ kind: "episode", seasonTitle: "Waterways", seasonNumber: 2, episodeNumber: 3,
      description: "A documentary about a river crossing.", premieredOn: null,
      playerSrc: "https://player.pbs.org/partnerplayer/EXAMPLE==/?autoplay=false", hasCaptions: true, captionLanguages: ["en"] });
    expect(program.episodes[1]).toMatchObject({ kind: "special", seasonNumber: null, episodeNumber: null,
      hasCaptions: false, captionLanguages: [] });
    expect(JSON.stringify(snapshot)).not.toMatch(/example\.org|asset-|edition-|show-river/);
  });

  it.each(["https://example.net/api/v1/shows/?page=2", "?page=2", "?page=3", undefined])(
    "rejects incomplete or changed pagination before the next request (%s)", async next => {
      const fetch = vi.fn(async () => Response.json({ data: [riverShow], links: { next } }));
      await expect(fetchPublicVideoCatalog(config, fetch, now)).rejects.toThrow(/pagination/);
      expect(fetch).toHaveBeenCalledOnce();
    });

  it("refuses an empty snapshot when public assets lack routable slugs", async () => {
    const missingSlug = catalogAsset("river-episode");
    missingSlug.attributes.parent_tree.attributes.slug = "";
    const fetch = async (input: URL | string | Request) => new URL(input.toString()).pathname.endsWith("/shows/")
      ? result([riverShow]) : result([missingSlug]);
    await expect(fetchPublicVideoCatalog(config, fetch, now)).rejects.toThrow("No routable public Media Manager videos");
  });

  it("retains public PBS artwork and drops invalid or signed image URLs", async () => {
    const showImage = "https://image.pbs.org/contentchannels/show-mezzanine16x9.jpg";
    const episodeImage = "https://image.pbs.org/video-assets/asset-mezzanine-16x9.jpg";
    const invalidImages = [
      "https://image.pbs.org.example.org/video-assets/episode.jpg",
      `${episodeImage}?signature=example`,
      `${episodeImage}\n`,
    ];
    const show = { ...riverShow, attributes: { ...riverShow.attributes,
      images: [{ profile: "show-poster2x3", image: "https://image.pbs.org/contentchannels/poster.png" },
        { profile: "show-mezzanine16x9", image: showImage }],
    } };
    const episode = catalogAsset("river-crossing", { attributes: { images: [
      ...invalidImages.map(image => ({ profile: "asset-mezzanine-16x9", image })),
      { profile: "asset-mezzanine-16x9", image: episodeImage },
    ] } });
    const special = catalogAsset("river-special", { special: true, attributes: { thumbnail: invalidImages[0] } });
    const fetch = async (input: URL | string | Request) => new URL(input.toString()).pathname.endsWith("/shows/")
      ? result([show]) : result([episode, special]);
    const snapshot = await fetchPublicVideoCatalog(config, fetch, now);
    const [program] = snapshot.programs;
    expect(program.image).toBe(showImage);
    expect(program.episodes.map(video => video.image)).toEqual([episodeImage, undefined]);
    for (const image of invalidImages) {
      expect(() => readPublicVideoCatalog({ ...snapshot, programs: [{ ...program, image }] })).toThrow(/Invalid public video catalog/);
    }
  });

  it("preserves the last valid catalog when a later asset page fails", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "video-catalog-"));
    const output = path.join(directory, "launch.json");
    const initial = await fetchPublicVideoCatalog(config, async input => new URL(input.toString()).pathname.endsWith("/shows/")
      ? result([riverShow]) : result([catalogAsset("river-episode"), catalogAsset("short-window", {
        attributes: { availabilities: { public: { end: "2026-11-20" } } },
      })]), now);
    const original = JSON.stringify({ videoCatalog: initial });
    const env = { MEDIA_MANAGER_BASE_URL: baseUrl, MEDIA_MANAGER_API_KEY: "fixture", MEDIA_MANAGER_API_SECRET: "fixture",
      LAUNCH_CONTENT_OUTPUT: output };
    const fetch = async (input: URL | string | Request) => {
      const url = new URL(input.toString());
      if (url.pathname.endsWith("/shows/")) return result([{ ...riverShow, attributes: { ...riverShow.attributes,
        description: "A documentary about waterways.", image: "https://example.org/river.jpg" } }]);
      if (url.searchParams.get("platform-slug") !== "partnerplayer") return result([]);
      return url.searchParams.has("page") ? new Response(null, { status: 503 }) : result([catalogAsset("replacement")], nextPage(url));
    };
    try {
      await writeFile(output, original);
      await main({ ...env, REQUIRE_FRESH_CONTENT: "1" }, fetch, undefined, { now });
      expect(JSON.parse(await readFile(output, "utf8")).videoCatalog).toEqual(initial);
      await main(env, fetch, undefined, { now: new Date("2026-11-21T12:00:00.000Z") });
      const retained = JSON.parse(await readFile(output, "utf8")).videoCatalog;
      expect(retained.checkedAt).toBe(initial.checkedAt);
      expect(retained.programs[0].episodes.map((video: { slug: string }) => video.slug)).toEqual(["river-episode"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
