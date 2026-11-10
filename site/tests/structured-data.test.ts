// @vitest-environment node
// Pins the JSON-LD builders (issue #222) and their wiring in the public layout.
// The dist-side companion (scripts/structured-data-dist.test.ts) validates what
// a build actually emits; these lock the shapes and the layout gating at the
// source so a refactor cannot quietly change what the builders claim.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  breadcrumbJsonLd,
  jsonLdHtml,
  newsArticleJsonLd,
  organizationJsonLd,
  profilePageJsonLd,
  tvSeriesJsonLd,
} from "../src/lib/structured-data";

const SITE = "https://njpbs.org";

describe("organization JSON-LD (#222)", () => {
  it("claims only site-stated facts, on the njpbs.org origin", () => {
    expect(organizationJsonLd(SITE)).toEqual({
      "@context": "https://schema.org",
      "@type": "Organization",
      name: "NJ PBS",
      alternateName: "New Jersey PBS",
      url: "https://njpbs.org/",
      logo: "https://njpbs.org/brand/njpbs-horizontal-white-navy.png",
    });
  });
});

describe("breadcrumb JSON-LD (#222)", () => {
  it("builds a two-level home-to-page trail with absolute urls", () => {
    expect(breadcrumbJsonLd("About", "/about/", SITE)).toEqual({
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        {
          "@type": "ListItem",
          position: 1,
          name: "Home",
          item: "https://njpbs.org/",
        },
        {
          "@type": "ListItem",
          position: 2,
          name: "About",
          item: "https://njpbs.org/about/",
        },
      ],
    });
  });
});

describe("news article JSON-LD (#1044)", () => {
  const credits = [
    { name: "Ada Reporter", slug: "ada-reporter" },
    { name: "NJ PBS staff" },
  ];

  it("states the ordered credits, linking only a public profile", () => {
    const data = newsArticleJsonLd({
      title: "Trenton budget hearing draws a crowd",
      description: "Residents filled the room.",
      canonicalPath: "/posts/trenton-budget-hearing/",
      datePublished: "2026-08-20",
      dateModified: null,
      credits,
      site: SITE,
    });
    expect(data["@type"]).toBe("NewsArticle");
    expect(data.author).toEqual([
      {
        "@type": "Person",
        name: "Ada Reporter",
        url: "https://njpbs.org/authors/ada-reporter/",
      },
      // A custom credit names no person with a page, so it carries no url.
      { "@type": "Person", name: "NJ PBS staff" },
    ]);
    expect(data.url).toBe("https://njpbs.org/posts/trenton-budget-hearing/");
  });

  it("omits the modified date unless the newsroom chose to show one", () => {
    const silent = newsArticleJsonLd({
      title: "A story",
      description: "",
      canonicalPath: "/posts/a-story/",
      datePublished: "2026-08-20",
      dateModified: null,
      credits: [],
      site: SITE,
    });
    expect(silent.dateModified).toBeUndefined();
    expect(silent.description).toBeUndefined();
    expect(silent.author).toBeUndefined();

    const shown = newsArticleJsonLd({
      title: "A story",
      description: "",
      canonicalPath: "/posts/a-story/",
      datePublished: "2026-08-20",
      dateModified: "2026-08-21",
      credits: [],
      site: SITE,
    });
    expect(shown.dateModified).toBe("2026-08-21");
  });

  it("stays parseable through the serializer", () => {
    const html = jsonLdHtml(
      newsArticleJsonLd({
        title: "A </script> title",
        description: "",
        canonicalPath: "/posts/a-story/",
        datePublished: "2026-08-20",
        dateModified: null,
        credits,
        site: SITE,
      }),
    );
    expect(html).not.toContain("</script>");
    expect(JSON.parse(html.replaceAll("\\u003c", "<"))).toMatchObject({
      "@type": "NewsArticle",
    });
  });
});

describe("profile page JSON-LD (#1044)", () => {
  it("describes the person and only the profiles the page links", () => {
    const data = profilePageJsonLd({
      displayName: "Ada Reporter",
      jobTitle: "Statehouse reporter",
      bio: "Covers the Legislature.",
      canonicalPath: "/authors/ada-reporter/",
      sameAs: ["https://x.com/adareporter"],
      site: SITE,
    });
    expect(data["@type"]).toBe("ProfilePage");
    expect(data.mainEntity).toMatchObject({
      "@type": "Person",
      name: "Ada Reporter",
      jobTitle: "Statehouse reporter",
      url: "https://njpbs.org/authors/ada-reporter/",
      sameAs: ["https://x.com/adareporter"],
    });
  });

  it("claims no account for an author who entered none", () => {
    const data = profilePageJsonLd({
      displayName: "Ada Reporter",
      jobTitle: null,
      bio: null,
      canonicalPath: "/authors/ada-reporter/",
      sameAs: [],
      site: SITE,
    });
    expect((data.mainEntity as Record<string, unknown>).sameAs).toBeUndefined();
    expect((data.mainEntity as Record<string, unknown>).jobTitle).toBeUndefined();
  });
});

describe("TV series JSON-LD (#923)", () => {
  it("describes the program with only what the page itself prints", () => {
    const data = tvSeriesJsonLd({
      title: "Due Process",
      genre: "public affairs",
      canonicalPath: "/programs/due-process/",
      site: SITE,
    });
    expect(data).toEqual({
      "@context": "https://schema.org",
      "@type": "TVSeries",
      name: "Due Process",
      url: "https://njpbs.org/programs/due-process/",
      genre: "public affairs",
      publisher: {
        "@type": "Organization",
        name: "NJ PBS",
        url: "https://njpbs.org/",
      },
    });
  });

  it("claims no genre for a program whose editor left it blank", () => {
    const data = tvSeriesJsonLd({
      title: "Due Process",
      genre: null,
      canonicalPath: "/programs/due-process/",
      site: SITE,
    });
    expect(data.genre).toBeUndefined();
  });
});

describe("jsonLdHtml serializer", () => {
  it("escapes < so no value can close the script tag early", () => {
    const html = jsonLdHtml({
      "@context": "https://schema.org",
      "@type": "Organization",
      name: "bad </script> title",
    });
    expect(html).not.toContain("</script>");
    expect(html).toContain("\\u003c/script>");
    // Round-trips to the same value for JSON readers.
    expect(JSON.parse(html).name).toBe("bad </script> title");
  });
});

describe("public layout wiring", () => {
  const layout = readFileSync(
    new URL("../src/layouts/PublicSiteLayout.astro", import.meta.url),
    "utf8",
  );

  it("gates structured data on indexed pages and splits home from subpages", () => {
    expect(layout).toContain("const structuredData = noindex");
    expect(layout).toContain("organizationJsonLd(Astro.site!)");
    // canonicalPath first: an alias route's breadcrumb must advertise the same
    // URL as its canonical tag, never the alias it happens to render under.
    expect(layout).toContain(
      "breadcrumbJsonLd(title, canonicalPath ?? path, Astro.site!)",
    );
  });

  it("emits through the escaping serializer, inline", () => {
    expect(layout).toContain(
      'script is:inline type="application/ld+json" set:html={jsonLdHtml(structuredData)}',
    );
    // Never raw-stringified into the tag.
    expect(layout).not.toContain("JSON.stringify(structuredData)");
  });
});
