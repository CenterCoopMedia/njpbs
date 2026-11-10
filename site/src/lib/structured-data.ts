// Schema.org JSON-LD builders. Four shapes ship:
// Organization on the public homepage, BreadcrumbList on every other indexed
// public page, NewsArticle on a published Post, and ProfilePage on an author
// page. The last two arrived with the public Post and author routes; before
// those existed there was no original article or person page to describe.
// Everything here states only facts the site itself already claims (name,
// origin, logo, the byline and dates already printed on the page) — no invented
// socials, founding dates or other claims absent from the public page.

export interface JsonLd {
  "@context": "https://schema.org";
  "@type": string;
  [key: string]: unknown;
}

// Serialize for a <script type="application/ld+json"> body. Escaping "<" keeps
// any value (a page title, say) from ever forming a "</script>" that would
// close the tag early; JSON readers see the same string either way.
export function jsonLdHtml(data: JsonLd): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

export function eventJsonLd(input: {
  title: string; startsAt: string; endsAt: string | null; canonicalPath: string;
  location: string | null; venueAddress: string | null; onlineUrl: string | null;
  image: { url: string } | null; registrationUrl: string | null;
  isFree: boolean; priceText: string | null; site: string | URL;
}): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "Event",
    name: input.title,
    url: new URL(input.canonicalPath, input.site).href,
    startDate: input.startsAt,
    ...(input.endsAt ? { endDate: input.endsAt } : {}),
    ...(input.image ? { image: input.image.url } : {}),
    ...(input.location || input.venueAddress ? { location: { "@type": "Place", name: input.location ?? input.venueAddress, ...(input.venueAddress ? { address: input.venueAddress } : {}) } } : input.onlineUrl ? { eventAttendanceMode: "https://schema.org/OnlineEventAttendanceMode", location: { "@type": "VirtualLocation", url: input.onlineUrl } } : {}),
    ...(input.registrationUrl ? { offers: { "@type": "Offer", url: input.registrationUrl, ...(input.isFree ? { price: "0", priceCurrency: "USD" } : {}) } } : {}),
  };
}

// The homepage Organization entity. Google reads this from the homepage only,
// so the layout emits it there and nowhere else.
export function organizationJsonLd(site: string | URL): JsonLd {
  const abs = (p: string) => new URL(p, site).href;
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "NJ PBS",
    alternateName: "New Jersey PBS",
    url: abs("/"),
    logo: abs("/brand/njpbs-horizontal-white-navy.png"),
  };
}

/**
 * A published Post. `NewsArticle` rather than the looser `Article` because that
 * is what this station publishes and what news surfaces read.
 *
 * Every value is a fact the page itself already states. `datePublished` is the
 * editorial display date resolved through the dates contract, never the instant
 * this particular revision was rebuilt; `dateModified` appears only when the
 * newsroom decided to show an update, so the structured data cannot contradict
 * the visible byline. Authors use the same ordered credits and resolved public
 * names as the page. A registered credit with a public profile gains a `url`;
 * a custom credit has only a name, because "NJ PBS staff" has no profile page.
 */
export function newsArticleJsonLd(input: {
  title: string;
  description: string;
  canonicalPath: string;
  datePublished: string | null;
  dateModified: string | null;
  imageUrl?: string | null;
  credits: readonly { name: string; slug?: string }[];
  site: string | URL;
}): JsonLd {
  const abs = (p: string) => new URL(p, input.site).href;
  const authors = input.credits.map((credit) => ({
    "@type": "Person",
    name: credit.name,
    ...(credit.slug ? { url: abs(`/authors/${credit.slug}/`) } : {}),
  }));
  return {
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    headline: input.title,
    ...(input.description ? { description: input.description } : {}),
    mainEntityOfPage: abs(input.canonicalPath),
    url: abs(input.canonicalPath),
    ...(input.datePublished ? { datePublished: input.datePublished } : {}),
    ...(input.dateModified ? { dateModified: input.dateModified } : {}),
    ...(input.imageUrl ? { image: input.imageUrl } : {}),
    ...(authors.length > 0 ? { author: authors } : {}),
    publisher: {
      "@type": "Organization",
      name: "NJ PBS",
      url: abs("/"),
      logo: abs("/brand/njpbs-horizontal-white-navy.png"),
    },
  };
}

/**
 * An author page: a `ProfilePage` whose main entity is the Person.
 *
 * `sameAs` carries only the social profiles the page already links, and only
 * the three platforms the profile contract allows, so nothing here claims an
 * account the author did not enter.
 */
export function profilePageJsonLd(input: {
  displayName: string;
  jobTitle: string | null;
  bio: string | null;
  canonicalPath: string;
  imageUrl?: string | null;
  sameAs: readonly string[];
  site: string | URL;
}): JsonLd {
  const abs = (p: string) => new URL(p, input.site).href;
  return {
    "@context": "https://schema.org",
    "@type": "ProfilePage",
    mainEntity: {
      "@type": "Person",
      name: input.displayName,
      url: abs(input.canonicalPath),
      ...(input.jobTitle ? { jobTitle: input.jobTitle } : {}),
      ...(input.bio ? { description: input.bio } : {}),
      ...(input.imageUrl ? { image: input.imageUrl } : {}),
      ...(input.sameAs.length > 0 ? { sameAs: [...input.sameAs] } : {}),
      worksFor: { "@type": "Organization", name: "NJ PBS", url: abs("/") },
    },
  };
}

/**
 * A published Program. `TVSeries` because that is what a station program
 * page describes: a standing show, not one dated story.
 *
 * Deliberately thin. Name, canonical URL, and genre are printed on the page, and
 * NJ PBS is the publisher by the same fact the page's own chrome states. The
 * synopsis is not copied in: it is rich text, and flattening it would mean
 * deciding what a link or a list becomes in a plain string. Air dates, episode
 * counts, and cast are not claimed at all — the CMS does not hold them, and a
 * schema validator accepting an invented value is not a reason to invent one.
 */
export function tvSeriesJsonLd(input: {
  title: string;
  genre: string | null;
  canonicalPath: string;
  site: string | URL;
}): JsonLd {
  const abs = (p: string) => new URL(p, input.site).href;
  return {
    "@context": "https://schema.org",
    "@type": "TVSeries",
    name: input.title,
    url: abs(input.canonicalPath),
    ...(input.genre ? { genre: input.genre } : {}),
    publisher: { "@type": "Organization", name: "NJ PBS", url: abs("/") },
  };
}

// A two-level trail (home, then the current page). The launch site is flat, so
// deeper trails wait until a nested section exists to describe.
export function breadcrumbJsonLd(
  title: string,
  path: string,
  site: string | URL,
): JsonLd {
  const abs = (p: string) => new URL(p, site).href;
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: abs("/") },
      { "@type": "ListItem", position: 2, name: title, item: abs(path) },
    ],
  };
}
