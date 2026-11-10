import { describe, expect, it } from "vitest";
import {
  activeAdvancedFilterCount,
  CONTENT_QUERY_VERSION,
  DEFAULT_CONTENT_QUERY,
  contentQueriesEqual,
  encodeContentQuery,
  parseContentQuery,
  resetPage,
  type ContentQuery,
} from "../src/lib/content-query";

describe("parseContentQuery", () => {
  it("returns the default query for an empty input", () => {
    expect(parseContentQuery("")).toEqual(DEFAULT_CONTENT_QUERY);
    expect(parseContentQuery("?")).toEqual(DEFAULT_CONTENT_QUERY);
  });

  it("parses a full valid query", () => {
    const parsed = parseContentQuery(
      "type=post&type=program&status=draft&status=in_review&owner=me&assigned=me&q=Trenton&sort=title&dir=asc&page=3&v=1",
    );
    expect(parsed).toEqual({
      types: ["program", "post"],
      statuses: ["draft", "in_review"],
      ownerMode: "me",
      ownerUid: null,
      assignmentMode: "me",
      assigneeUid: null,
      q: "Trenton",
      sortField: "title",
      sortDirection: "asc",
      sortExplicit: true,
      page: 3,
    });
  });

  it("deduplicates and orders multi-select filters by their vocabulary order", () => {
    // Values arrive out of order and repeated; the result is deduped and canonically ordered.
    const parsed = parseContentQuery("type=post&type=program&type=post");
    expect(parsed.types).toEqual(["program", "post"]);
  });

  it("still accepts a retired kind as a filter, ordered after the live kinds", () => {
    // Article can no longer be created (#1039), but a record stored before the
    // retirement must stay findable by type, so the read vocabulary keeps it.
    const parsed = parseContentQuery("type=article&type=program");
    expect(parsed.types).toEqual(["program", "article"]);
  });

  it("drops unknown filter values rather than trusting them", () => {
    const parsed = parseContentQuery("type=post&type=widget&status=draft&status=bogus");
    expect(parsed.types).toEqual(["post"]);
    expect(parsed.statuses).toEqual(["draft"]);
  });

  it("falls back to safe defaults for invalid sort and direction", () => {
    const parsed = parseContentQuery("sort=nonsense&dir=sideways");
    expect(parsed.sortField).toBe(DEFAULT_CONTENT_QUERY.sortField);
    expect(parsed.sortDirection).toBe(DEFAULT_CONTENT_QUERY.sortDirection);
  });

  it("ignores unknown keys", () => {
    const parsed = parseContentQuery("bogus=1&type=event&injected=drop");
    expect(parsed.types).toEqual(["event"]);
  });

  it("reads a specific owner uid and a me owner distinctly", () => {
    expect(parseContentQuery("owner=me")).toMatchObject({ ownerMode: "me", ownerUid: null });
    expect(parseContentQuery("owner=uid-42")).toMatchObject({
      ownerMode: "specific",
      ownerUid: "uid-42",
    });
    expect(parseContentQuery("owner=any")).toMatchObject({ ownerMode: "any", ownerUid: null });
  });

  it("reads durable assignment independently from last-editor ownership", () => {
    expect(parseContentQuery("assigned=me")).toMatchObject({
      assignmentMode: "me",
      assigneeUid: null,
    });
    expect(parseContentQuery("assigned=uid-42")).toMatchObject({
      assignmentMode: "specific",
      assigneeUid: "uid-42",
    });
    expect(parseContentQuery("assigned=any")).toMatchObject({
      assignmentMode: "any",
      assigneeUid: null,
    });
  });

  it("trims and caps the search text", () => {
    expect(parseContentQuery("q=%20%20hello%20%20").q).toBe("hello");
    const long = "x".repeat(500);
    expect(parseContentQuery(`q=${long}`).q).toHaveLength(200);
  });

  it("clamps a bad page value to 1", () => {
    expect(parseContentQuery("page=0").page).toBe(1);
    expect(parseContentQuery("page=-4").page).toBe(1);
    expect(parseContentQuery("page=2.5").page).toBe(1);
    expect(parseContentQuery("page=abc").page).toBe(1);
    expect(parseContentQuery("page=5").page).toBe(5);
  });

  it("accepts a URLSearchParams instance directly", () => {
    const params = new URLSearchParams();
    params.append("type", "sponsor");
    expect(parseContentQuery(params).types).toEqual(["sponsor"]);
  });
});

describe("encodeContentQuery", () => {
  it("encodes only the codec version for the default query", () => {
    expect(encodeContentQuery(DEFAULT_CONTENT_QUERY)).toBe(`v=${CONTENT_QUERY_VERSION}`);
  });

  it("emits multi-select filters as repeated keys in canonical order", () => {
    const query: ContentQuery = {
      ...DEFAULT_CONTENT_QUERY,
      types: ["post", "program"],
      statuses: ["published", "draft"],
    };
    expect(encodeContentQuery(query)).toBe(
      "type=program&type=post&status=draft&status=published&v=1",
    );
  });

  it("omits values equal to their default", () => {
    const query: ContentQuery = {
      ...DEFAULT_CONTENT_QUERY,
      sortField: "updatedAt",
      sortDirection: "desc",
      page: 1,
    };
    expect(encodeContentQuery(query)).toBe("v=1");
  });

  it("omits page 1 but includes a later page", () => {
    expect(encodeContentQuery({ ...DEFAULT_CONTENT_QUERY, page: 1 })).toBe("v=1");
    expect(encodeContentQuery({ ...DEFAULT_CONTENT_QUERY, page: 4 })).toBe("page=4&v=1");
  });

  it("emits a specific owner uid and a me owner", () => {
    expect(
      encodeContentQuery({ ...DEFAULT_CONTENT_QUERY, ownerMode: "me" }),
    ).toBe("owner=me&v=1");
    expect(
      encodeContentQuery({ ...DEFAULT_CONTENT_QUERY, ownerMode: "specific", ownerUid: "u7" }),
    ).toBe("owner=u7&v=1");
  });

  it("emits assignment separately from last-editor ownership", () => {
    expect(
      encodeContentQuery({ ...DEFAULT_CONTENT_QUERY, assignmentMode: "me" }),
    ).toBe("assigned=me&v=1");
    expect(
      encodeContentQuery({
        ...DEFAULT_CONTENT_QUERY,
        assignmentMode: "specific",
        assigneeUid: "u9",
      }),
    ).toBe("assigned=u9&v=1");
  });
});

describe("codec round-trip", () => {
  it("is stable: parse(encode(x)) equals x for a normalized query", () => {
    const query: ContentQuery = {
      types: ["event", "post"],
      statuses: ["draft", "scheduled"],
      ownerMode: "specific",
      ownerUid: "uid-9",
      assignmentMode: "specific",
      assigneeUid: "uid-4",
      q: "shore report",
      sortField: "publishAt",
      sortDirection: "asc",
      sortExplicit: true,
      page: 2,
    };
    expect(parseContentQuery(encodeContentQuery(query))).toEqual(query);
  });

  it("is idempotent on the default query", () => {
    expect(parseContentQuery(encodeContentQuery(DEFAULT_CONTENT_QUERY))).toEqual(
      DEFAULT_CONTENT_QUERY,
    );
  });
});

describe("saved-view helpers", () => {
  it("resets paging for a saved view", () => {
    expect(resetPage({ ...DEFAULT_CONTENT_QUERY, page: 7 }).page).toBe(1);
  });

  it("treats two queries as equal when they differ only by page", () => {
    const a: ContentQuery = { ...DEFAULT_CONTENT_QUERY, statuses: ["draft"], page: 1 };
    const b: ContentQuery = { ...DEFAULT_CONTENT_QUERY, statuses: ["draft"], page: 5 };
    expect(contentQueriesEqual(a, b)).toBe(true);
  });

  it("distinguishes queries that differ by a real filter", () => {
    const a: ContentQuery = { ...DEFAULT_CONTENT_QUERY, statuses: ["draft"] };
    const b: ContentQuery = { ...DEFAULT_CONTENT_QUERY, statuses: ["published"] };
    expect(contentQueriesEqual(a, b)).toBe(false);
  });
});

describe("activeAdvancedFilterCount", () => {
  it("counts only the disclosed axes that differ from the default", () => {
    expect(activeAdvancedFilterCount(DEFAULT_CONTENT_QUERY)).toBe(0);
    expect(
      activeAdvancedFilterCount({ ...DEFAULT_CONTENT_QUERY, q: "garden", page: 3, sortField: "publishAt" }),
    ).toBe(0);
    expect(
      activeAdvancedFilterCount({
        ...DEFAULT_CONTENT_QUERY,
        types: ["post", "event"],
        statuses: ["draft"],
      }),
    ).toBe(2);
    expect(
      activeAdvancedFilterCount({
        ...DEFAULT_CONTENT_QUERY,
        ownerMode: "me",
        assignmentMode: "me",
      }),
    ).toBe(2);
  });
});
