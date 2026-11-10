// Hreflang clusters are determined per page from the locales in which that
// page exists. A site-wide locale switch could declare nonexistent alternate
// pages. A page with only one locale needs no alternate cluster.
//
// `hreflangAlternates` takes the locales THIS page exists in and has no
// default: a caller has to say what it has. Registering a locale in
// SITE_LOCALES makes it known to the site; it does not claim any page is in it.

export interface HreflangAlternate {
  hreflang: string;
  href: string;
}

// The first entry is the default locale: it owns the unprefixed URLs and the
// x-default entry. Every other locale serves from /<locale>/ + the same path.
// This is the registry of locales the site knows how to serve, and nothing more.
export const SITE_LOCALES = ["en"] as const;

export const DEFAULT_LOCALE = SITE_LOCALES[0];

/**
 * Build the alternate cluster for one page.
 *
 * @param path        the page's own path, prefixed or not (/about/, /es/about/)
 * @param site        the site origin
 * @param pageLocales the locales THIS page actually exists in, default locale
 *                    first. A page with no translation passes [DEFAULT_LOCALE]
 *                    (or nothing meaningful) and gets no cluster.
 */
export function hreflangAlternates(
  path: string,
  site: string | URL,
  pageLocales: readonly string[],
): HreflangAlternate[] {
  // Fewer than two locales for this page means there is no alternate to point
  // at. Each page explicitly supplies the locales it can serve.
  if (pageLocales.length < 2) return [];

  const [defaultLocale, ...rest] = pageLocales;
  const abs = (p: string) => new URL(p, site).href;

  // Normalize to the default-locale path first: Base runs on every page, so a
  // localized page hands in its own prefixed URL (/es/about/), and each cluster
  // member must be derived from the shared unprefixed path, or the non-default
  // pages would emit doubled prefixes (/es/es/about/).
  let basePath = path;
  for (const locale of rest) {
    if (path === `/${locale}` || path === `/${locale}/`) {
      basePath = "/";
      break;
    }
    if (path.startsWith(`/${locale}/`)) {
      basePath = path.slice(locale.length + 1);
      break;
    }
  }

  const alternates: HreflangAlternate[] = [
    { hreflang: defaultLocale, href: abs(basePath) },
  ];
  for (const locale of rest) {
    alternates.push({ hreflang: locale, href: abs(`/${locale}${basePath}`) });
  }
  // x-default points at the default-locale URL: it is what a searcher with no
  // matching language preference should get.
  alternates.push({ hreflang: "x-default", href: abs(basePath) });
  return alternates;
}
