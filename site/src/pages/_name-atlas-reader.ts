import type { APIRoute } from "astro";
import snapshot from "../internal/name-atlas/reader.html?raw";
import bridge from "../internal/name-atlas/bridge.js?raw";
import { renderNameAtlasReader } from "../lib/name-atlas-reader";

// Only astro.config.mjs may inject this endpoint into an internal build.
export const GET: APIRoute = () => new Response(renderNameAtlasReader(snapshot, bridge), {
  headers: { "Content-Type": "text/html; charset=utf-8" },
});
