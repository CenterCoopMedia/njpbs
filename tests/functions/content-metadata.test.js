import { describe, expect, it } from "vitest";
import metadata from "../../functions/lib/content-metadata.js";

const {
  normalizeLegacyPostDate,
  normalizePublishAt,
  validateKnownMetadata,
} = metadata;

describe("CMS metadata boundary", () => {
  it("validates page themes with the same strict save error", () => {
    expect(validateKnownMetadata({ pageTheme: undefined })).toBeNull();
    expect(validateKnownMetadata({ pageTheme: "default" })).toBeNull();
    expect(validateKnownMetadata({ pageTheme: "nj-decides" })).toBeNull();
    expect(validateKnownMetadata({ pageTheme: "campaign" })).toBe(
      "pageTheme must be default or nj-decides",
    );
    expect(validateKnownMetadata({ pageTheme: false })).toBe(
      "pageTheme must be default or nj-decides",
    );
  });

  it("no longer exports a slug minter of its own", () => {
    // Slug minting moved to the shared post-slug contract, which the public
    // build imports as well. A second, looser minter here is how the writer's
    // rule and the build's route rule drifted apart in the first place.
    expect(metadata.slugBase).toBeUndefined();
  });

  it("normalizes editor dates to EditorialBase instants", () => {
    expect(normalizePublishAt("2026-07-21", "fallback")).toBe(
      "2026-07-21T00:00:00.000Z",
    );
    expect(normalizePublishAt("", "2026-07-21T12:00:00.000Z")).toBe(
      "2026-07-21T12:00:00.000Z",
    );
    expect(() => normalizePublishAt("2026-02-31", "fallback")).toThrow(
      "publishAt must be a valid date",
    );
  });

  it("rejects impossible calendar days in a full instant, not just a bare date", () => {
    // Date rolls a day overflow forward rather than rejecting it, so an unchecked
    // Feb 31 was stored as Mar 3 -- a date the editor never picked.
    for (const value of [
      "2026-02-31T00:00:00Z",
      "2026-02-31t00:00:00Z",
      "2026-04-31T12:00:00Z",
      "2026-02-29T00:00:00Z", // 2026 is not a leap year
    ]) {
      expect(() => normalizePublishAt(value, "fallback")).toThrow(
        "publishAt must be a valid date",
      );
    }
  });

  it("keeps an offset instant that legitimately lands on another UTC day", () => {
    // The guard above validates the date the caller wrote, not the canonicalized
    // one; comparing against the result would reject this valid instant.
    expect(normalizePublishAt("2026-02-28T20:00:00-05:00", "fallback")).toBe(
      "2026-03-01T01:00:00.000Z",
    );
  });

  it("rejects an impossible editorial date instead of accepting any string", () => {
    expect(validateKnownMetadata({ type: "post", date: "2026-02-28" })).toBeNull();
    expect(validateKnownMetadata({ type: "post", date: "2026-02-31" })).toBe(
      "date must be a valid date",
    );
    expect(validateKnownMetadata({ type: "post", date: "not-a-date" })).toBe(
      "date must be a valid date",
    );
    expect(
      validateKnownMetadata({
        type: "post",
        date: "2026-07-24T15:30:00.000Z",
      }),
    ).toBe("date must be a valid date");
    expect(validateKnownMetadata({ type: "post", date: 42 })).toBe(
      "date must be a string",
    );
  });

  it("does not apply the post calendar contract to unrelated root date values", () => {
    expect(validateKnownMetadata({ title: "Legacy page", date: "summer" })).toBeNull();
    expect(
      validateKnownMetadata(
        { type: "event", date: "legacy import label" },
        { descriptionIsString: false },
      ),
    ).toBeNull();
  });

  it("normalizes only real legacy post instants without mutating stored input", () => {
    const legacy = {
      type: "post",
      date: "2026-07-24T15:30:00.000Z",
      title: "Station update",
    };

    expect(normalizeLegacyPostDate(legacy)).toEqual({
      ...legacy,
      date: "2026-07-24",
    });
    expect(legacy.date).toBe("2026-07-24T15:30:00.000Z");

    const crossingOffset = {
      type: "post",
      date: "2026-07-24 23:30:00-04:00",
    };
    expect(normalizeLegacyPostDate(crossingOffset)).toEqual({
      ...crossingOffset,
      date: "2026-07-24",
    });

    const timestamp = {
      type: "post",
      date: {
        toDate: () => new Date("2026-07-25T03:30:00.000Z"),
      },
    };
    expect(normalizeLegacyPostDate(timestamp)).toEqual({
      ...timestamp,
      date: "2026-07-25",
    });

    for (const date of [
      "2026-07-24",
      "2026-02-31T00:00:00.000Z",
      "not-a-date",
    ]) {
      const document = { type: "post", date };
      expect(normalizeLegacyPostDate(document)).toBe(document);
    }
    const event = { type: "event", date: "2026-07-24T15:30:00.000Z" };
    expect(normalizeLegacyPostDate(event)).toBe(event);
  });

  it("validates known nested fields while allowing future siblings", () => {
    expect(
      validateKnownMetadata({
        seo: { title: "Search title", noindex: false, vendorHint: "preserve" },
        social: { imageAssetId: "asset-1", crop: "wide" },
      }),
    ).toBeNull();
    expect(validateKnownMetadata({ seo: { noindex: "yes" } })).toBe(
      "seo.noindex must be a boolean",
    );
    expect(validateKnownMetadata({ tags: ["news", 42] })).toBe(
      "tags must be an array of strings",
    );
    expect(validateKnownMetadata({ type: "post", categories: ["station", 42] })).toBe(
      "categories must be an array of strings",
    );
    expect(validateKnownMetadata({ categories: { legacy: "station" } })).toBeNull();
    expect(validateKnownMetadata({ name: { text: "Broken sponsor" } })).toBe(
      "name must be a string",
    );
    expect(validateKnownMetadata({ homeHeroTitle: 42 })).toBe(
      "homeHeroTitle must be a string",
    );
    expect(
      validateKnownMetadata(
        { description: { type: "doc", content: [] } },
        { descriptionIsString: false },
      ),
    ).toBeNull();
  });

  it("validates PBS Media Manager image references as plain strings", () => {
    expect(
      validateKnownMetadata({
        type: "program",
        keyArt: "pbs-key-art-123",
      }),
    ).toBeNull();
    expect(
      validateKnownMetadata({
        type: "program",
        keyArt: { assetId: "station-library-object" },
      }),
    ).toBe("keyArt must be a string");
  });
});
