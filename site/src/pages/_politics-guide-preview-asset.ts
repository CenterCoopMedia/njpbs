import type { APIRoute, GetStaticPaths } from "astro";
import { POLITICS_PREVIEW_ASSETS, politicsGuidePreviewEnabled, type PoliticsPreviewAsset } from "../lib/politics-guide-preview";
import { readPoliticsPreviewAsset } from "../lib/politics-guide-preview-build";

export const getStaticPaths: GetStaticPaths = () => politicsGuidePreviewEnabled(process.env)
  ? POLITICS_PREVIEW_ASSETS.map(asset => ({ params: { asset } })) : [];

export const GET: APIRoute = async ({ params }) => {
  if (!politicsGuidePreviewEnabled(process.env) || !POLITICS_PREVIEW_ASSETS.includes(params.asset as PoliticsPreviewAsset)) return new Response(null, { status: 404 });
  const asset = params.asset as PoliticsPreviewAsset;
  const source = await readPoliticsPreviewAsset(asset, process.env);
  const mime = asset.endsWith(".js") ? "text/javascript" : asset.endsWith(".css") ? "text/css" : "application/json";
  return new Response(source, { headers: { "Content-Type": `${mime}; charset=utf-8`, "X-Robots-Tag": "noindex, nofollow, noarchive" } });
};
