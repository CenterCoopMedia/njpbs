import { describe, expect, it } from "vitest";
import { isPublishable, selectPublishable } from "../src/lib/publish-gate";
import type { ContentStatus, EditorialBase, PostRecord } from "../../packages/content-core/src/content-model";

const NOW = new Date("2026-07-14T00:00:00.000Z");
const PAST = "2026-07-01T00:00:00.000Z";
const FUTURE = "2026-08-01T00:00:00.000Z";

function base(overrides: Partial<EditorialBase> = {}): EditorialBase {
  return {
    id: "r1",
    slug: "about",
    previousSlugs: [],
    locale: "en",
    status: "published",
    publishAt: PAST,
    ...overrides,
  };
}

describe("isPublishable", () => {
  it("emits a published, past-dated, not-deleted record", () => {
    expect(isPublishable(base(), NOW)).toBe(true);
  });

  it("keeps the prior snapshot public while a visible working revision is reviewed", () => {
    expect(isPublishable({
      ...base({ status: "in_review", publishAt: FUTURE }),
      publiclyVisible: true,
      published: { publishedAt: PAST },
    }, NOW)).toBe(true);
  });

  it("fails closed when a visible working revision has a non-string snapshot time", () => {
    expect(isPublishable({
      ...base({ status: "draft" }),
      publiclyVisible: true,
      published: { publishedAt: 42 },
    }, NOW)).toBe(false);
  });

  it.each<ContentStatus>(["draft", "scheduled", "archived"])(
    "skips a %s record even when past-dated and not deleted",
    (status) => {
      expect(isPublishable(base({ status }), NOW)).toBe(false);
    },
  );

  it("skips a soft-deleted record that still reads as published (#465)", () => {
    // The delete is a soft marker; status stays "published" and the published
    // snapshot survives for recovery, so the gate must exclude it explicitly.
    expect(isPublishable(base({ deleted: true }), NOW)).toBe(false);
  });

  it("treats an explicit deleted:false as active", () => {
    expect(isPublishable(base({ deleted: false }), NOW)).toBe(true);
  });

  it("fails closed on a non-boolean truthy deleted marker (a legacy value must not slip past)", () => {
    // A `=== true` check would read a stored "true" string as not-deleted and ship
    // the page; the truthy guard excludes any soft-delete marker.
    const record = { ...base(), deleted: "true" as unknown as boolean };
    expect(isPublishable(record, NOW)).toBe(false);
  });

  it("skips a published record whose publishAt is still in the future", () => {
    expect(isPublishable(base({ publishAt: FUTURE }), NOW)).toBe(false);
  });

  it("emits a record whose publishAt is exactly now (inclusive boundary)", () => {
    expect(isPublishable(base({ publishAt: NOW.toISOString() }), NOW)).toBe(true);
  });

  it.each([
    "", // empty
    "not-a-date", // unparseable
    "2026-13-40T99:99:99Z", // out-of-range fields
    "2026-02-30T00:00:00.000Z", // impossible calendar date (Date.parse would roll it forward)
    "2026-07-01T00:00:00", // zone-less: would be read in the build machine's local timezone
    "2026-07-01T00:00:00.000", // zone-less with millis
    "2026-07-01T00:00:00.000+05:00", // explicit offset, not the canonical UTC form
  ])("fails closed on a non-absolute or malformed publishAt (%j)", (publishAt) => {
    expect(isPublishable(base({ publishAt }), NOW)).toBe(false);
  });
});

describe("selectPublishable", () => {
  it("keeps only the emittable records and preserves input order", () => {
    const records = [
      base({ id: "keep-1" }),
      base({ id: "draft", status: "draft" }),
      base({ id: "future", publishAt: FUTURE }),
      base({ id: "keep-2" }),
    ];
    expect(selectPublishable(records, NOW).map((r) => r.id)).toEqual(["keep-1", "keep-2"]);
  });

  it("excludes a soft-deleted post that still carries a published snapshot", () => {
    const post: PostRecord = {
      id: "obituary",
      type: "post",
      slug: "old-news",
      previousSlugs: [],
      locale: "en",
      status: "published",
      publishAt: PAST,
      deleted: true,
      title: "Old news",
      date: PAST,
      tags: [],
      blocks: [],
      published: {
        blocks: [],
        metadata: {
          type: "post",
          title: "Old news",
          date: PAST,
          tags: [],
          slug: "old-news",
          previousSlugs: [],
          locale: "en",
        },
        publishedAt: PAST,
        publishedBy: "user-c6fb27c061@example.org",
        sourceVersion: 1,
      },
    };
    expect(selectPublishable([post], NOW)).toEqual([]);
  });
});
