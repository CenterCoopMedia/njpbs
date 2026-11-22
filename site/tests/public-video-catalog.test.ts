import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fetchPublicVideoCatalog } from "../scripts/fetch-public-video-catalog";
import { main } from "../scripts/sync-launch-content.mjs";
import { readPublicVideoCatalog } from "../src/lib/public-video-catalog";
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
      return second ? result([noCaptions, duplicate, catalogAsset("river-episode")]) : result([publicEpisode, ...denied], nextPage(url));
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

  it("preserves the last valid catalog when a later asset page fails", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "video-catalog-"));
    const output = path.join(directory, "launch.json");
    const initial = await fetchPublicVideoCatalog(config, async input => new URL(input.toString()).pathname.endsWith("/shows/")
      ? result([riverShow]) : result([catalogAsset("river-episode")]), now);
    const original = JSON.stringify({ videoCatalog: initial });
    const env = { MEDIA_MANAGER_BASE_URL: baseUrl, MEDIA_MANAGER_API_KEY: "fixture", MEDIA_MANAGER_API_SECRET: "fixture",
      LAUNCH_CONTENT_OUTPUT: output };
    const fetch = async (input: URL | string | Request) => {
      const url = new URL(input.toString());
      if (url.pathname.endsWith("/shows/")) return result([{ ...riverShow, attributes: { ...riverShow.attributes,
        description: "A documentary about waterways.", image: "https://example.org/river.jpg" } }]);
      if (!url.searchParams.has("platform-slug")) return result([]);
      return url.searchParams.has("page") ? new Response(null, { status: 503 }) : result([catalogAsset("replacement")], nextPage(url));
    };
    try {
      await writeFile(output, original);
      await main({ ...env, REQUIRE_FRESH_CONTENT: "1" }, fetch);
      expect(JSON.parse(await readFile(output, "utf8")).videoCatalog).toEqual(initial);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
