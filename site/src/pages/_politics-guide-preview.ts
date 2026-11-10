import type { APIRoute } from "astro";
import { politicsGuidePreviewEnabled, politicsGuidePreviewHtml } from "../lib/politics-guide-preview";

export const GET: APIRoute = () => {
  if (!politicsGuidePreviewEnabled(process.env)) return new Response(null, { status: 404 });
  return new Response(politicsGuidePreviewHtml(), { headers: { "Content-Type": "text/html; charset=utf-8", "X-Robots-Tag": "noindex, nofollow, noarchive" } });
};
