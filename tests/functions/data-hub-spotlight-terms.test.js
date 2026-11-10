import { beforeEach, describe, expect, it } from "vitest";
import { readSpotlightTerms } from "../../functions/lib/data-hub-spotlight.js";

// Public WordPress IDs, names and slugs recorded in #3919 on October 22, 2026.
const verified = [
  { id: 22325, name: "unemployment", slug: "unemployment" },
  { id: 22322, name: "jobs", slug: "jobs" },
  { id: 25153, name: "rent", slug: "rent" },
  { id: 117639, name: "rents", slug: "rents" },
  { id: 59114, name: "housing", slug: "housing" },
];
const unemploymentMatches = [
  [105133, "$600 unemployment subsidy", "600-unemployment-subsidy"],
  [75595, "ac unemployment", "ac-unemployment"],
  [126144, "Black unemployment", "black-unemployment"],
  [120776, "COVID-19 unemployment", "covid-19-unemployment"],
  [108023, "Disaster Unemployment Assistance", "disaster-unemployment-assistance"],
  [60781, "extended unemployment benefits", "extended-unemployment-benefits"],
  [66434, "federal emergency unemployment compensation", "federal-emergency-unemployment-compensation"],
  [107808, "federal pandemic unemployment program", "federal-pandemic-unemployment-program"],
  [24269, "federal unemployment", "federal-unemployment"],
  [25745, "federal unemployment benefits", "federal-unemployment-benefits"],
  [108856, "improve unemployment", "improve-unemployment"],
  [109565, "in unemployment insurance tax", "in-unemployment-insurance-tax"],
  [78331, "new jersey unemployment", "new-jersey-unemployment"],
  [111591, "New Jersey unemployment system", "new-jersey-unemployment-system"],
  [106145, "New Jersey's unemployment rate", "new-jerseys-unemployment-rate"],
  [24280, "New Jersey’s unemployment", "new-jerseys-unemployment"],
  [111587, "New Jersey’s unemployment system", "new-jerseys-unemployment-system"],
  [78332, "nj unemployment", "nj-unemployment"],
  [120783, "NJ unemployment applications", "nj-unemployment-applications"],
  [120778, "NJ unemployment benefits", "nj-unemployment-benefits"],
].map(([id, name, slug]) => ({ id, name, slug }));
const ordinaryMatches = [
  unemploymentMatches,
  [{ id: 94970, name: "Amazon Jobs Day", slug: "amazon-jobs-day" }],
  [{ id: 117311, name: '"Parent rights"', slug: "parent-rights" }],
  [{ id: 88815, name: "adoptive parents", slug: "adoptive-parents" }],
  [{ id: 118693, name: "$1 housing lottery", slug: "1-housing-lottery" }],
];
const term = ({ id, name, slug }) => ({ id, label: name, slug });
let searchTime = Date.parse("2026-10-22T12:00:00Z");
beforeEach(() => { searchTime += 20 * 60_000; });
const clock = () => searchTime;

describe("Spotlight term lookup network contract", () => {
  it.each(verified.map((exact, index) => [exact.slug, exact, ordinaryMatches[index]]))(
    "puts exact %s before the alphabetical substring results, capped at 20", async (_slug, exact, ordinary) => {
      const requests = [];
      const terms = await readSpotlightTerms("tags", ` ${exact.slug.toUpperCase()} `, { clock, fetchImpl: async (url, options) => {
        requests.push(new URL(url));
        expect(options).toMatchObject({ method: "GET", redirect: "error" });
        expect(options.signal).toBeInstanceOf(AbortSignal);
        expect(options.headers.Authorization).toBeUndefined();
        return Response.json(url.searchParams.has("slug") ? [exact] : ordinary);
      } });
      expect(terms).toEqual([term(exact), ...ordinary.slice(0, 19).map(term)]);
      expect(requests).toHaveLength(2);
      expect(requests.map(url => url.searchParams.get("slug"))).toContain(exact.slug);
      expect(requests.map(url => url.searchParams.get("search"))).toContain(exact.slug.toUpperCase());
      for (const url of requests) {
        expect(url.origin).toBe("https://www.njspotlightnews.org");
        expect(url.pathname).toBe("/wp-json/wp/v2/tags");
        expect(url.searchParams.get("per_page")).toBe("20");
        expect(url.searchParams.get("_fields")).toBe("id,name,slug");
      }
    });

  it.each(verified.map(exact => [exact.id, exact]))("finds numeric ID %s when ordinary search is empty", async (id, exact) => {
    const requests = [];
    const terms = await readSpotlightTerms("tags", String(id), { clock, fetchImpl: async url => {
      requests.push(new URL(url));
      return Response.json(url.searchParams.get("include") === String(id) ? [exact] : []);
    } });
    expect(terms).toEqual([term(exact)]);
    expect(requests).toHaveLength(3);
    expect(requests.map(url => Object.fromEntries(url.searchParams))).toEqual(expect.arrayContaining([
      expect.objectContaining({ include: String(id) }),
      expect.objectContaining({ slug: String(id) }),
      expect.objectContaining({ search: String(id) }),
    ]));
  });

  it("de-duplicates exact and ordinary matches by ID and preserves the other results", async () => {
    const exact = verified[1];
    const ordinary = ordinaryMatches[1][0];
    const terms = await readSpotlightTerms("categories", "jobs", { clock, fetchImpl: async url => {
      expect(url.pathname).toBe("/wp-json/wp/v2/categories");
      return Response.json(url.searchParams.has("slug") ? [exact, exact] : [ordinary, exact, ordinary]);
    } });
    expect(terms).toEqual([term(exact), term(ordinary)]);
  });

  it.each(["rent", "25153"])("uses ordinary search if the exact requests fail for %s", async query => {
    const ordinary = ordinaryMatches[2];
    const terms = await readSpotlightTerms("tags", query, { clock, fetchImpl: async url =>
      url.searchParams.has("search") ? Response.json(ordinary) : new Response("unavailable", { status: 503 }) });
    expect(terms).toEqual(ordinary.map(term));
  });

  it("retries a failed exact lookup instead of caching incomplete ordinary results", async () => {
    const exact = verified[0];
    let recovering = false;
    let requests = 0;
    const fetchImpl = async url => {
      requests++;
      if (url.searchParams.has("search")) return Response.json(unemploymentMatches);
      return recovering ? Response.json([exact]) : new Response(null, { status: 503 });
    };
    expect(await readSpotlightTerms("tags", "unemployment", { clock, fetchImpl })).toEqual(unemploymentMatches.map(term));
    recovering = true;
    expect(await readSpotlightTerms("tags", "unemployment", { clock, fetchImpl }))
      .toEqual([term(exact), ...unemploymentMatches.slice(0, 19).map(term)]);
    expect(requests).toBe(4);
  });

  it("normalizes spaces and case for exact slugs and reuses the existing cache key", async () => {
    const exact = { id: 120288, name: "building permits", slug: "building-permits" };
    const fetchImpl = async url => Response.json(url.searchParams.get("slug") === "building-permits" ? [exact] : []);
    expect(await readSpotlightTerms("tags", " Building PERMITS ", { clock, fetchImpl })).toEqual([term(exact)]);
    expect(await readSpotlightTerms("tags", "building permits", { clock, fetchImpl: async () => { throw new Error("cache miss"); } }))
      .toEqual([term(exact)]);
  });

  it("validates exact rows and ignores rows that do not match the requested slug or ID", async () => {
    const exact = verified[0];
    const invalid = [{ ...exact, id: "22325" }, { ...exact, name: "" }, { ...exact, slug: "bad/slug" }];
    const terms = await readSpotlightTerms("tags", "unemployment", { clock, fetchImpl: async url =>
      Response.json(url.searchParams.has("slug") ? [...invalid, verified[1], exact] : invalid) });
    expect(terms).toEqual([term(exact)]);
    expect(await readSpotlightTerms("tags", "22325", { clock, fetchImpl: async url =>
      Response.json(url.searchParams.has("search") ? [] : [verified[1]]) })).toEqual([]);
  });

  it.each(["00", "9007199254740993"])("does not send an unsafe exact ID for %s", async query => {
    const requests = [];
    await readSpotlightTerms("tags", query, { clock, fetchImpl: async url => {
      requests.push(new URL(url));
      return Response.json([]);
    } });
    expect(requests).toHaveLength(2);
    expect(requests.every(url => !url.searchParams.has("include"))).toBe(true);
  });

  it("keeps ordinary-search failure visible even when the exact lookup succeeds", async () => {
    await expect(readSpotlightTerms("tags", "housing", { clock, fetchImpl: async url =>
      url.searchParams.has("search") ? new Response(null, { status: 503 }) : Response.json([verified[4]]) }))
      .rejects.toThrow("Spotlight reporting is unavailable.");
  });
});
