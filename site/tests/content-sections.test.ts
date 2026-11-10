import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import {
  CONTENT_SECTIONS_COLLECTION,
  SEEDED_CONTENT_SECTIONS,
  contentSectionForPublicPage,
  isSeededContentSectionId,
  parseContentSectionDefinition,
  sortContentSections,
} from "../../packages/content-core/src/content-sections";
import { PUBLIC_PAGES } from "../../packages/content-core/src/public-pages";

const requireModule = createRequire(import.meta.url);
const serverSections = requireModule(
  "../../functions/lib/content-sections.js",
) as {
  CONTENT_SECTIONS_COLLECTION: string;
  REQUIRE_SECTION_ON_RECORD_CREATE: boolean;
  SEEDED_CONTENT_SECTIONS: readonly { id: string }[];
  contentSectionForPage: (pageId: unknown) => string | null;
  isSectionId: (value: unknown) => boolean;
};

describe("content section registry", () => {
  it("seeds News beside the four public areas", () => {
    expect(SEEDED_CONTENT_SECTIONS.map((section) => section.id)).toEqual([
      "watch",
      "support",
      "station",
      "compliance",
      "news",
    ]);
    // The seed must cover every area a canonical page can claim, or a page would be
    // stamped into a desk no grant can name.
    expect(new Set(SEEDED_CONTENT_SECTIONS.map((section) => section.id))).toEqual(
      new Set([...PUBLIC_PAGES.map((page) => page.area), "news"]),
    );
    expect(CONTENT_SECTIONS_COLLECTION).toBe("sections");
  });

  it("keeps the deployed functions mirror in parity with the shared seed", () => {
    expect(serverSections.SEEDED_CONTENT_SECTIONS).toEqual(SEEDED_CONTENT_SECTIONS);
    expect(serverSections.CONTENT_SECTIONS_COLLECTION).toBe(
      CONTENT_SECTIONS_COLLECTION,
    );
  });

  it("takes a canonical page's section from its public area, never from its template", () => {
    for (const page of PUBLIC_PAGES) {
      expect(contentSectionForPublicPage(page.id)).toBe(page.area);
      expect(serverSections.contentSectionForPage(page.id)).toBe(page.area);
    }
    // Two pages sharing one editor template can still sit in different desks.
    expect(contentSectionForPublicPage("watch")).toBe("watch");
    expect(contentSectionForPublicPage("give")).toBe("support");
    expect(contentSectionForPublicPage("faq")).toBe("support");
    expect(contentSectionForPublicPage("eeo")).toBe("compliance");
  });

  it("returns no section for an unknown or non-string page id", () => {
    expect(contentSectionForPublicPage("news")).toBeNull();
    expect(contentSectionForPublicPage(undefined)).toBeNull();
    expect(serverSections.contentSectionForPage("news")).toBeNull();
  });

  it("recognizes only seeded ids, and never a prototype member", () => {
    expect(isSeededContentSectionId("watch")).toBe(true);
    expect(isSeededContentSectionId("news")).toBe(true);
    expect(isSeededContentSectionId("constructor")).toBe(false);
    expect(isSeededContentSectionId("__proto__")).toBe(false);
    expect(isSeededContentSectionId(undefined)).toBe(false);
  });

  it("refuses a section id that is empty or carries surrounding spaces", () => {
    expect(serverSections.isSectionId("watch")).toBe(true);
    expect(serverSections.isSectionId(" watch")).toBe(false);
    expect(serverSections.isSectionId("watch ")).toBe(false);
    expect(serverSections.isSectionId("")).toBe(false);
    expect(serverSections.isSectionId(null)).toBe(false);
  });

  it("drops a malformed registry row instead of rendering it", () => {
    expect(
      parseContentSectionDefinition({
        id: "watch",
        label: "Watch",
        description: "Watch pages.",
        order: 1,
      }),
    ).toEqual({ id: "watch", label: "Watch", description: "Watch pages.", order: 1 });
    expect(parseContentSectionDefinition({ id: "watch", label: "", description: "", order: 1 })).toBeNull();
    expect(parseContentSectionDefinition({ id: " watch", label: "Watch", description: "", order: 1 })).toBeNull();
    expect(parseContentSectionDefinition({ id: "watch", label: "Watch", description: "" })).toBeNull();
    expect(parseContentSectionDefinition({ id: "watch", label: "Watch", description: "", order: "1" })).toBeNull();
    expect(parseContentSectionDefinition(null)).toBeNull();
    expect(parseContentSectionDefinition([])).toBeNull();
  });

  it("orders the picker by explicit order, then label, then id", () => {
    const sorted = sortContentSections([
      { id: "b", label: "Beta", description: "", order: 2 },
      { id: "a", label: "Alpha", description: "", order: 2 },
      { id: "c", label: "Gamma", description: "", order: 1 },
    ]);
    expect(sorted.map((section) => section.id)).toEqual(["c", "a", "b"]);
  });
});
