// Map baked Media Manager catalog models to canonical paths and page-head props.
// Shared path construction keeps static routes, canonical URLs and cross-links
// consistent for programs and episodes. This module performs no fetch or I/O.

import type { CatalogEpisode, CatalogProgram } from "./media-manager-catalog";

/** The public catalog's route prefix. Programs and episodes hang off it. */
export const CATALOG_BASE = "/watch";

/** Canonical site-relative path for a program page: /watch/<program-slug>/ */
export function programPath(program: CatalogProgram): string {
  return `${CATALOG_BASE}/${program.slug}/`;
}

/**
 * Canonical site-relative path for an episode page, nested under its program:
 * /watch/<program-slug>/<episode-slug>/ . An episode is addressed within its
 * program, so the same episode slug under two programs stays distinct.
 */
export function episodePath(
  program: CatalogProgram,
  episode: CatalogEpisode,
): string {
  return `${CATALOG_BASE}/${program.slug}/${episode.slug}/`;
}

/**
 * The <head> props a static catalog page hands to Base.astro: a plain-language
 * title and description plus the page's own canonical path. Base.astro resolves
 * the path against the site origin and fills the canonical, Open Graph, and
 * Twitter tags, so this carries exactly what those pages need and no origin or
 * tag detail they should not have to know.
 */
export interface CatalogPageMeta {
  title: string;
  description: string;
  canonicalPath: string;
}

export function programPageMeta(program: CatalogProgram): CatalogPageMeta {
  return {
    title: program.title,
    description: program.description,
    canonicalPath: programPath(program),
  };
}

export function episodePageMeta(
  program: CatalogProgram,
  episode: CatalogEpisode,
): CatalogPageMeta {
  // Carry the program in the title so an episode called "Episode 1" is still
  // distinct in a search result and a browser tab. og:site_name (set in
  // Base.astro) supplies the "NJ PBS" brand, so there is no suffix here. When an
  // episode shares its program's title (a one-off special), the program context
  // would only repeat it, so use the bare title.
  const title =
    episode.title === program.title
      ? episode.title
      : `${episode.title}, ${program.title}`;
  return {
    title,
    description: episode.description,
    canonicalPath: episodePath(program, episode),
  };
}
