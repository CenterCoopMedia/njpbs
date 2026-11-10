import { escapeHtml } from "./content-model.ts";
import { isCmsImageUrl } from "./media-origin.ts";

export type HomeBandAssets = Readonly<Record<string, { url: string }>>;

/** The id is admitted with the block; the image crosses the normal media boundary. */
export function homeBandBackground(id: string | undefined, assets: HomeBandAssets = {}): string | undefined {
  if (!id) return undefined;
  const image = assets[id];
  if (!image || !isCmsImageUrl(new URL(image.url))) throw new Error("Home band background requires an approved image.");
  return image.url;
}

export function renderHomeBandBackground(url: string | undefined): string {
  if (url && !isCmsImageUrl(new URL(url))) throw new Error("Home band background requires an approved image.");
  return url ? `<img class="home-band__background" src="${escapeHtml(url)}" alt="" loading="lazy" fetchpriority="low" decoding="async" />` : "";
}
