import { describe, expect, it } from "vitest";
import { findSlugConflicts, routesOf, type SluggedRecord } from "../src/lib/slug-routes";

// A minimal slugged record. findSlugConflicts reads id, slug, previousSlugs, and
// locale; routesOf reads only slug and previousSlugs. Locale defaults to "en" so
// the same-locale cases stay terse and the cross-locale cases opt in explicitly.
const rec = (
  id: string,
  slug: string,
  previousSlugs: string[] = [],
  locale = "en",
): SluggedRecord => ({ id, slug, previousSlugs, locale });

describe("routesOf", () => {
  it("returns the canonical slug and each previous slug as a redirect", () => {
    expect(routesOf(rec("r1", "about", ["about-us", "who-we-are"]))).toEqual({
      canonical: "about",
      redirects: ["about-us", "who-we-are"],
    });
  });

  it("drops a previous slug equal to the current slug (a renamed-back no-op redirect)", () => {
    // A page renamed away and back would otherwise 301 its own live route to itself.
    expect(routesOf(rec("r1", "about", ["about"]))).toEqual({
      canonical: "about",
      redirects: [],
    });
  });

  it("dedupes repeated previous slugs and drops empty or whitespace-only ones", () => {
    expect(routesOf(rec("r1", "about", ["old", "old", "", "   "]))).toEqual({
      canonical: "about",
      redirects: ["old"],
    });
  });

  it("treats a missing previousSlugs array as no redirects", () => {
    expect(routesOf({ slug: "about" } as SluggedRecord)).toEqual({
      canonical: "about",
      redirects: [],
    });
  });
});

describe("findSlugConflicts", () => {
  it("reports no conflicts when every route is distinct", () => {
    expect(
      findSlugConflicts([
        rec("r1", "about", ["about-us"]),
        rec("r2", "programs", ["shows"]),
        rec("r3", "schedule"),
      ]),
    ).toEqual([]);
  });

  it("flags two records that share the same current slug", () => {
    expect(findSlugConflicts([rec("r2", "about"), rec("r1", "about")])).toEqual([
      { slug: "about", locale: "en", kind: "duplicate-canonical", recordIds: ["r1", "r2"] },
    ]);
  });

  it("flags a current slug that collides with another record's previous slug", () => {
    // r2's live route is `donate`; r1 wants a 301 from `donate` to its own page.
    // The build cannot both serve and redirect the same path.
    expect(
      findSlugConflicts([rec("r1", "give", ["donate"]), rec("r2", "donate")]),
    ).toEqual([
      { slug: "donate", locale: "en", kind: "canonical-vs-previous", recordIds: ["r1", "r2"] },
    ]);
  });

  it("flags two records that claim the same previous slug (conflicting 301 targets)", () => {
    expect(
      findSlugConflicts([rec("r1", "give", ["donate"]), rec("r2", "support", ["donate"])]),
    ).toEqual([
      { slug: "donate", locale: "en", kind: "duplicate-previous", recordIds: ["r1", "r2"] },
    ]);
  });

  it("does not flag a record that lists its own current slug in previousSlugs", () => {
    expect(findSlugConflicts([rec("r1", "about", ["about"])])).toEqual([]);
  });

  it("does not flag the same slug across different locales (distinct routes)", () => {
    // An English and a Spanish `about` page resolve to different URLs, so a shared
    // slug string is not a collision.
    expect(
      findSlugConflicts([rec("en1", "about", [], "en"), rec("es1", "about", [], "es")]),
    ).toEqual([]);
  });

  it("flags a duplicate slug only within its own locale", () => {
    expect(
      findSlugConflicts([
        rec("en1", "about", [], "en"),
        rec("en2", "about", [], "en"),
        rec("es1", "about", [], "es"),
      ]),
    ).toEqual([
      { slug: "about", locale: "en", kind: "duplicate-canonical", recordIds: ["en1", "en2"] },
    ]);
  });

  it("reports every conflict kind a single slug trips, ordered by kind", () => {
    // Slug "x" is claimed by two live pages (a, b) and is also the redirect source
    // of a third (c) — two distinct problems on one route, both reported and
    // ordered by the comparator's kind tiebreak within the shared slug.
    expect(
      findSlugConflicts([rec("a", "x"), rec("b", "x"), rec("c", "y", ["x"])]),
    ).toEqual([
      { slug: "x", locale: "en", kind: "canonical-vs-previous", recordIds: ["a", "b", "c"] },
      { slug: "x", locale: "en", kind: "duplicate-canonical", recordIds: ["a", "b"] },
    ]);
  });

  it("orders conflicts by slug then kind, with sorted record ids, for a stable report", () => {
    const conflicts = findSlugConflicts([
      rec("b", "team", ["staff"]),
      rec("a", "team"),
      rec("c", "leadership", ["staff"]),
    ]);
    expect(conflicts).toEqual([
      { slug: "staff", locale: "en", kind: "duplicate-previous", recordIds: ["b", "c"] },
      { slug: "team", locale: "en", kind: "duplicate-canonical", recordIds: ["a", "b"] },
    ]);
  });
});
