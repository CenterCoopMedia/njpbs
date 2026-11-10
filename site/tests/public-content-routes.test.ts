import { describe, expect, it } from "vitest";
import {
  POST_PUBLIC_ROUTE_BASE,
  PROGRAM_PUBLIC_ROUTE_BASE,
  isPublicContentSlug,
  postPublicPath,
  programPublicPath,
} from "../src/lib/public-content-routes";
import {
  AUTHOR_PUBLIC_ROUTE_BASE,
  authorPublicPath,
} from "../../packages/content-core/src/author-profiles";
import { formatEditorialDate } from "../src/lib/editorial-date-format";
import {
  distFileForPage,
  pageDeclaresNoindex,
} from "../src/lib/sitemap-noindex";

describe("the ratified route bases", () => {
  it("are exactly /posts/{slug}/ and /authors/{slug}/", () => {
    expect(POST_PUBLIC_ROUTE_BASE).toBe("/posts/");
    expect(AUTHOR_PUBLIC_ROUTE_BASE).toBe("/authors/");
    expect(postPublicPath("trenton-budget")).toBe("/posts/trenton-budget/");
    expect(authorPublicPath("ada-reporter")).toBe("/authors/ada-reporter/");
  });

  it("accepts exactly the lowercase hyphen-joined shape the Post writer mints", () => {
    expect(isPublicContentSlug("trenton-budget-hearing")).toBe(true);
    expect(isPublicContentSlug("post-2026")).toBe(true);
    expect(isPublicContentSlug("new")).toBe(true);
    expect(isPublicContentSlug("a".repeat(240))).toBe(true);
    expect(isPublicContentSlug("Trenton")).toBe(false);
    expect(isPublicContentSlug("two--hyphens")).toBe(false);
    expect(isPublicContentSlug("-leading")).toBe(false);
    expect(isPublicContentSlug("trailing-")).toBe(false);
    expect(isPublicContentSlug("has/slash")).toBe(false);
    expect(isPublicContentSlug("")).toBe(false);
  });

  it("adds /programs/{slug}/ for Program records, in its own namespace", () => {
    expect(PROGRAM_PUBLIC_ROUTE_BASE).toBe("/programs/");
    expect(programPublicPath("due-process")).toBe("/programs/due-process/");
    // A program and a post that somehow shared a slug still claim two different
    // routes, so opening a second kind cannot overwrite a live post's page.
    expect(programPublicPath("due-process")).not.toBe(postPublicPath("due-process"));
  });

  it("throws rather than building a route from a shape the writer cannot mint", () => {
    expect(() => postPublicPath("../escape")).toThrow();
    expect(() => programPublicPath("../escape")).toThrow();
    expect(() => programPublicPath("Due Process")).toThrow();
  });
});

describe("the printed date", () => {
  it("abbreviates the AP way and spells out the short months", () => {
    expect(formatEditorialDate("2026-08-21")).toBe("Aug. 21, 2026");
    expect(formatEditorialDate("2026-09-01")).toBe("Sept. 1, 2026");
    expect(formatEditorialDate("2026-03-04")).toBe("March 4, 2026");
    expect(formatEditorialDate("2026-05-30")).toBe("May 30, 2026");
    expect(formatEditorialDate("2026-07-04")).toBe("July 4, 2026");
  });

  it("prints nothing rather than a placeholder for a value it cannot read", () => {
    expect(formatEditorialDate(null)).toBeNull();
    expect(formatEditorialDate("")).toBeNull();
    expect(formatEditorialDate("2026-13-01")).toBeNull();
    expect(formatEditorialDate("2026-08-21T14:00:00Z")).toBeNull();
  });

  it("does not shift the day through the build machine's time zone", () => {
    // Parsed by hand, never through Date: a UTC-boundary day must print as the
    // day the newsroom published on wherever the build runs.
    expect(formatEditorialDate("2026-01-01")).toBe("Jan. 1, 2026");
    expect(formatEditorialDate("2026-12-31")).toBe("Dec. 31, 2026");
  });
});

describe("keeping noindex pages out of the sitemap", () => {
  const dist = "/build/dist";

  it("maps a route to the file that backs it", () => {
    expect(distFileForPage("https://njpbs.org/posts/a-story/", dist)).toBe(
      "/build/dist/posts/a-story/index.html",
    );
  });

  it("never resolves outside dist, whatever the route says", () => {
    // The URL parser normalizes dot segments away before this sees them, so a
    // traversal attempt lands on an ordinary in-dist path rather than escaping.
    // The relative-path guard stays as the second line of defence for any input
    // shape that does not normalize.
    expect(distFileForPage("https://njpbs.org/../../etc/", dist)).toBe(
      "/build/dist/etc/index.html",
    );
    expect(distFileForPage("not a url", dist)).toBeNull();
    // A non-directory route is not a page this build emits as an index file.
    expect(distFileForPage("https://njpbs.org/posts/a-story", dist)).toBeNull();
  });

  it("ignores robots examples inside portable HTML export scripts", () => {
    const template = `<script>const figure = '<meta name="robots" content="noindex,nofollow">';</script>`;
    for (const html of [
      `<html><head>${template}</head><body>Data Hub</body></html>`,
      `<html><head></head><body>${template}Data Hub</body></html>`,
    ]) {
      expect(pageDeclaresNoindex("https://njpbs.org/data-hub/", dist, () => html)).toBe(false);
    }
  });

  it("drops a page that declares robots noindex", () => {
    const read = () => '<meta name="robots" content="noindex, nofollow" />';
    expect(pageDeclaresNoindex("https://njpbs.org/posts/old-slug/", dist, read)).toBe(
      true,
    );
  });

  it("keeps a canonical donate page and drops a noindex donate alias", () => {
    const page = "https://njpbs.org/donate/";
    const canonical = () =>
      '<link rel="canonical" href="https://njpbs.org/donate/" />';
    const alias = () =>
      '<link rel="canonical" href="https://njpbs.org/give/" /><meta name="robots" content="noindex, nofollow" />';

    expect(pageDeclaresNoindex(page, dist, canonical)).toBe(false);
    expect(pageDeclaresNoindex(page, dist, alias)).toBe(true);
  });

  it("keeps an ordinary indexed page", () => {
    const read = () => "<link rel=\"canonical\" href=\"https://njpbs.org/posts/a/\" />";
    expect(pageDeclaresNoindex("https://njpbs.org/posts/a/", dist, read)).toBe(false);
  });

  it("keeps a page it cannot read rather than dropping a real route", () => {
    const read = () => {
      throw new Error("ENOENT");
    };
    expect(pageDeclaresNoindex("https://njpbs.org/posts/a/", dist, read)).toBe(false);
  });
});
