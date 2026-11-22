import { readFile, writeFile } from "node:fs/promises";
import { fetchPublicVideoCatalog } from "../../scripts/fetch-public-video-catalog";
import { catalogAsset, riverShow } from "./public-video-catalog";

const destination = process.argv[2];
if (!destination) throw new Error("Supply a destination for the synthetic launch input");
const config = { url: new URL("https://example.org/api/v1/shows/"), authorization: "Basic fixture" };
const videoCatalog = await fetchPublicVideoCatalog(config, async input => Response.json({
  data: new URL(input.toString()).pathname.endsWith("/shows/") ? [riverShow] : [
    catalogAsset("river-crossing"),
    catalogAsset("river-special", { special: true, title: "River voices" }),
    catalogAsset("expired", { attributes: { availabilities: { public: { end: "2020-01-02" } } } }),
    catalogAsset("member-only", { attributes: { availabilities: { station_members: { start: null } } } }),
  ],
  links: { next: null },
}), new Date("2020-01-01T12:00:00.000Z"));
const source = JSON.parse(await readFile(new URL("../../src/data/launch-media-manager.json", import.meta.url), "utf8"));
await writeFile(destination, JSON.stringify({ ...source, videoCatalog }), { flag: "wx" });
