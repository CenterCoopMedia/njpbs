import { describe, it, expect } from "vitest";
import {
  idToSlug,
  slugToPath,
  idToPath,
  dirOf,
  normalizePath,
  resolveWikiHref,
  groupPublicPages,
  type WikiPageMeta,
} from "../src/lib/wiki";

// The wiki render turns an OKF bundle into a curated public site. These pin the
// two things that are easy to get wrong: the id->URL slug math, and the link
// rewriting that decides whether a concept-to-concept .md link becomes a /wiki/
// route, a section anchor, or redacted plain text.

describe("idToSlug / slugToPath", () => {
  it("maps the root index to the wiki root", () => {
    expect(idToSlug("index")).toBe("");
    expect(slugToPath("")).toBe("/wiki/");
    expect(idToPath("index")).toBe("/wiki/");
  });

  it("maps a directory index to its section slug", () => {
    expect(idToSlug("org/index")).toBe("org");
    expect(slugToPath("org")).toBe("/wiki/org/");
  });

  it("maps a concept to its nested route", () => {
    expect(idToSlug("org/nj-pbs")).toBe("org/nj-pbs");
    expect(idToPath("org/nj-pbs")).toBe("/wiki/org/nj-pbs/");
  });
});

describe("dirOf", () => {
  it("returns the directory or empty string", () => {
    expect(dirOf("org/nj-pbs")).toBe("org");
    expect(dirOf("index")).toBe("");
  });
});

describe("normalizePath", () => {
  it("resolves . and .. against a base directory", () => {
    expect(normalizePath("wiki/web", "../org/nj-pbs.md")).toBe("wiki/org/nj-pbs.md");
    expect(normalizePath("wiki/donations", "private-concept.md")).toBe(
      "wiki/donations/private-concept.md",
    );
    expect(normalizePath("wiki/web", "../../docs/research/x.md")).toBe(
      "docs/research/x.md",
    );
  });
});

describe("resolveWikiHref", () => {
  const publics = new Set(["org/nj-pbs", "systems/passport"]);

  it("rewrites a link to a public concept into its route", () => {
    const r = resolveWikiHref("nj-pbs.md", "org/selection-2026", publics);
    expect(r).toEqual({ href: "/wiki/org/nj-pbs/", kind: "internal" });
  });

  it("preserves a fragment on a public link", () => {
    const r = resolveWikiHref("../org/nj-pbs.md#related", "systems/passport", publics);
    expect(r.href).toBe("/wiki/org/nj-pbs/#related");
    expect(r.kind).toBe("internal");
  });

  it("redacts a link to a non-public concept (no GitHub source leak)", () => {
    const r = resolveWikiHref("../people/key-contacts.md", "systems/passport", publics);
    expect(r.kind).toBe("redact");
  });

  it("redacts an out-of-bundle docs link", () => {
    const r = resolveWikiHref(
      "../../docs/research/membership-passport-mvault.md",
      "systems/passport",
      publics,
    );
    expect(r.kind).toBe("redact");
  });

  it("maps a directory index link to its section anchor", () => {
    const r = resolveWikiHref("../systems/index.md", "org/wnet-pmnj", publics);
    expect(r).toEqual({ href: "/wiki/#systems", kind: "internal" });
  });

  it("maps the root index link to the wiki root", () => {
    const r = resolveWikiHref("../index.md", "org/nj-pbs", publics);
    expect(r).toEqual({ href: "/wiki/", kind: "internal" });
  });

  it("leaves real external links untouched but flagged external", () => {
    expect(resolveWikiHref("https://docs.pbs.org/x", "systems/passport", publics)).toEqual({
      href: "https://docs.pbs.org/x",
      kind: "external",
    });
    expect(resolveWikiHref("mailto:a@b.org", "systems/passport", publics).kind).toBe(
      "external",
    );
  });

  it("leaves a same-page anchor alone", () => {
    expect(resolveWikiHref("#open-questions", "systems/passport", publics)).toEqual({
      href: "#open-questions",
      kind: "internal",
    });
  });

  it("leaves a non-.md relative link alone", () => {
    expect(resolveWikiHref("./image.png", "systems/passport", publics)).toEqual({
      href: "./image.png",
      kind: "internal",
    });
  });
});

describe("groupPublicPages", () => {
  const pages: WikiPageMeta[] = [
    { id: "org/nj-pbs", slug: "org/nj-pbs", path: "/wiki/org/nj-pbs/", title: "NJ PBS", description: "" },
    { id: "org/selection-2026", slug: "org/selection-2026", path: "/wiki/org/selection-2026/", title: "2026 selection", description: "" },
    { id: "people/ashlee-smith", slug: "people/ashlee-smith", path: "/wiki/people/ashlee-smith/", title: "Ashlee Smith", description: "" },
    { id: "timeline/key-dates", slug: "timeline/key-dates", path: "/wiki/timeline/key-dates/", title: "NJ PBS key dates", description: "" },
    { id: "org/index", slug: "org", path: "/wiki/org/", title: "Organization", description: "" },
  ];

  it("groups by section in canonical order, excludes index files, sorts by title", () => {
    const groups = groupPublicPages(pages);
    expect(groups.map((g) => g.section.dir)).toEqual(["org", "people", "timeline"]);
    const org = groups.find((g) => g.section.dir === "org")!;
    expect(org.pages.map((p) => p.id)).toEqual(["org/selection-2026", "org/nj-pbs"]);
  });

  it("drops sections with no public pages", () => {
    const groups = groupPublicPages([pages[3]]); // only timeline/key-dates
    expect(groups.map((g) => g.section.dir)).toEqual(["timeline"]);
  });
});
