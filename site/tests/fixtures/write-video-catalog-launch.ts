import { readFile, writeFile } from "node:fs/promises";
import { fetchPublicVideoCatalog } from "../../scripts/fetch-public-video-catalog";
import { catalogAsset, coastShow, riverShow } from "./public-video-catalog";

const destination = process.argv[2];
if (!destination) throw new Error("Supply a destination for the synthetic launch input");
const config = { url: new URL("https://example.org/api/v1/shows/"), authorization: "Basic fixture" };
const river = { ...riverShow, attributes: { ...riverShow.attributes,
  description_short: "Explore the people and places along New Jersey’s waterways.",
  images: [{ profile: "show-mezzanine16x9", image: "https://image.pbs.org/contentchannels/catalog-fixture-show.jpg" }],
} };
const coast = { ...coastShow, attributes: { ...coastShow.attributes, slug: "shore-stories", title: "Shore stories",
  description_short: "Meet the communities along the Jersey Shore.",
  images: [{ profile: "show-mezzanine16x9", image: "https://image.pbs.org/contentchannels/catalog-fixture-unavailable.jpg" }],
} };
const videoCatalog = await fetchPublicVideoCatalog(config, async input => Response.json({
  data: new URL(input.toString()).pathname.endsWith("/shows/") ? [river, coast] : [
    catalogAsset("river-crossing", { parentShow: river, attributes: { premiered_on: "2020-01-01",
      images: [{ profile: "asset-mezzanine-16x9", image: "https://image.pbs.org/video-assets/catalog-fixture-episode.jpg" }],
    } }),
    catalogAsset("river-special", { parentShow: river, special: true, title: "River voices" }),
    catalogAsset("shore-special", { parentShow: coast, special: true, title: "Along the coast" }),
    catalogAsset("expired", { attributes: { availabilities: { public: { end: "2020-01-02" } } } }),
    catalogAsset("member-only", { attributes: { availabilities: { station_members: { start: null } } } }),
  ],
  links: { next: null },
}), new Date("2020-01-01T12:00:00.000Z"));
const source = JSON.parse(await readFile(new URL("../../src/data/launch-media-manager.json", import.meta.url), "utf8"));
await writeFile(destination, JSON.stringify({ ...source, videoCatalog }), { flag: "wx" });
