// Resolves stored site navigation into the links the public header and footer
// render. The public layout and the Admin preview both call this module, so the
// preview shows the same hrefs, order and new-tab behavior as the site.

import {
  DEFAULT_SITE_NAVIGATION,
  SITE_NAVIGATION_SETTINGS_ID,
  cmsSettingsSchemaFor,
  safeNavigationHref,
  validateCmsSettingsValues,
  type SiteNavigationLaunchKey,
  type SiteNavigationLink,
  type SiteNavigationRouteKey,
  type SiteNavigationSettingsValues,
  type SiteNavigationTarget,
} from "./cms-settings.ts";
import { donateUrl, passportLearnMoreUrl, pbsVideoUrl } from "./launch-fallback.ts";
import { isCustomPageId, publicPage } from "./public-pages.ts";
import { safeHref } from "./safe-href.ts";

export const SITE_NAVIGATION_LAUNCH_URLS: Readonly<Record<SiteNavigationLaunchKey, string>> =
  Object.freeze({
    pbsVideo: pbsVideoUrl,
    donate: donateUrl,
    passportLearnMore: passportLearnMoreUrl,
  });

export const SITE_NAVIGATION_POSTS_INDEX_PATH = "/posts/";

// Routes the build emits only in some states. Posts follows the routed-content
// gate; In the news is a staff-created CMS page, linked only when published.
export const SITE_NAVIGATION_ROUTE_PATHS: Readonly<Record<SiteNavigationRouteKey, string>> =
  Object.freeze({
    postsIndex: SITE_NAVIGATION_POSTS_INDEX_PATH,
    inTheNews: "/in-the-news/",
  });

export interface ResolvedNavigationLink {
  id: string;
  label: string;
  href: string;
  external: boolean;
  opensInNewTab: boolean;
}

export interface ResolvedNavigationColumn {
  id: string;
  heading: string;
  links: ResolvedNavigationLink[];
}

export interface ResolvedSiteNavigation {
  header: ResolvedNavigationLink[];
  footer: ResolvedNavigationColumn[];
}

export interface SiteNavigationResolveOptions {
  /** The layout passes `cmsRoutedContentEnabled`; Posts is omitted when false. */
  postsIndexEnabled: boolean;
  /**
   * The live path of a published CMS page, when this build emits it. A built-in
   * page without one uses its default path. A custom page without one is omitted.
   */
  pagePath?: (pageId: string) => string | undefined;
  /** Whether this build emits a published CMS page at the path. */
  hasPublishedPath?: (path: string) => boolean;
}

/**
 * Return the stored values when they pass the current schema, or null.
 *
 * The layout calls this before rendering so a malformed entry falls back to the
 * seed instead of failing the page.
 */
export function validSiteNavigationValues(value: unknown): SiteNavigationSettingsValues | null {
  const schema = cmsSettingsSchemaFor(SITE_NAVIGATION_SETTINGS_ID, 1);
  if (!schema || validateCmsSettingsValues(schema, value) !== null) return null;
  return value as SiteNavigationSettingsValues;
}

export function resolveNavigationTarget(
  target: SiteNavigationTarget,
  options: SiteNavigationResolveOptions,
): string | null {
  let href: string | undefined;
  switch (target.type) {
    case "page": {
      const publishedPath = options.pagePath?.(target.pageId);
      const builtin = isCustomPageId(target.pageId) ? undefined : publicPage(target.pageId);
      const path = isCustomPageId(target.pageId)
        ? publishedPath
        : builtin && (publishedPath ?? builtin.path);
      href = path && target.hash ? `${path}#${target.hash}` : path;
      break;
    }
    case "route":
      href = (
        target.key === "postsIndex"
          ? options.postsIndexEnabled
          : options.hasPublishedPath?.(SITE_NAVIGATION_ROUTE_PATHS[target.key]) === true
      )
        ? SITE_NAVIGATION_ROUTE_PATHS[target.key]
        : undefined;
      break;
    case "launch":
      href = SITE_NAVIGATION_LAUNCH_URLS[target.key];
      break;
    case "href":
      // A staff-entered address must also be absolute or root-relative.
      return safeNavigationHref(target.href);
  }
  // The save path already rejects unsafe links. The render path checks again
  // so no stored or projected value reaches an href without the shared rule.
  return href === undefined ? null : safeHref(href);
}

/** Whether a resolved navigation link opens in a new tab. */
export function navigationLinkOpensInNewTab(external: boolean, href: string): boolean {
  return external && /^https?:\/\//i.test(href);
}

function resolveLink(
  link: SiteNavigationLink,
  options: SiteNavigationResolveOptions,
): ResolvedNavigationLink | null {
  const href = resolveNavigationTarget(link.target, options);
  if (href === null) return null;
  return {
    id: link.id,
    label: link.label,
    href,
    external: link.external,
    opensInNewTab: navigationLinkOpensInNewTab(link.external, href),
  };
}

function resolveValues(
  values: SiteNavigationSettingsValues,
  options: SiteNavigationResolveOptions,
): ResolvedSiteNavigation {
  const header = values.header
    .map((link) => resolveLink(link, options))
    .filter((link): link is ResolvedNavigationLink => link !== null);
  const footer = values.footer
    .map((column) => ({
      id: column.id,
      heading: column.heading,
      links: column.links
        .map((link) => resolveLink(link, options))
        .filter((link): link is ResolvedNavigationLink => link !== null),
    }))
    .filter((column) => column.links.length > 0);
  return { header, footer };
}

/**
 * Resolve navigation for rendering. A missing or invalid value renders the
 * seed. A header or footer that resolves to nothing also renders the seed's
 * version of that area, so no build ships without navigation.
 */
export function resolveSiteNavigation(
  value: unknown,
  options: SiteNavigationResolveOptions,
): ResolvedSiteNavigation {
  const values = validSiteNavigationValues(value) ?? DEFAULT_SITE_NAVIGATION;
  const resolved = resolveValues(values, options);
  if (resolved.header.length > 0 && resolved.footer.length > 0) return resolved;
  const seed = resolveValues(DEFAULT_SITE_NAVIGATION, options);
  return {
    header: resolved.header.length > 0 ? resolved.header : seed.header,
    footer: resolved.footer.length > 0 ? resolved.footer : seed.footer,
  };
}
