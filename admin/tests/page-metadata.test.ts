import { describe, expect, it } from "vitest";
import {
  pageMetadataFromDocument,
  pageMetadataSaveDocument,
} from "../src/lib/page-metadata";

describe("page metadata projection", () => {
  it("defaults an uncreated page to its registry title", () => {
    expect(pageMetadataFromDocument("watch", {})).toEqual({ title: "Watch NJ PBS", slug: "watch" });
  });

  it("preserves unknown nested metadata while projecting editable groups", () => {
    expect(pageMetadataFromDocument("about", {
      title: "About us",
      pageTheme: "nj-decides",
      homeHeroTitle: "Watch what matters",
      homeHeroSubtitle: "Stories from across New Jersey.",
      ignoredTopLevel: "not part of the form",
      seo: { title: "Search title", legacyPluginValue: "keep" },
      social: { description: "Share copy", vendorValue: 7 },
    })).toEqual({
      title: "About us",
      slug: "about",
      pageTheme: "nj-decides",
      homeHeroTitle: "Watch what matters",
      homeHeroSubtitle: "Stories from across New Jersey.",
      seo: { title: "Search title", legacyPluginValue: "keep" },
      social: { description: "Share copy", vendorValue: 7 },
    });
  });

  it("sends only client-owned page metadata fields", () => {
    expect(pageMetadataSaveDocument({
      id: "forged",
      version: 99,
      status: "published",
      blocks: ["do not send"],
      title: "About NJ PBS",
      pageTheme: "default",
      description: "Station summary",
      homeHeroTitle: "Watch what matters",
      homeHeroSubtitle: "Stories from across New Jersey.",
      seo: { title: "Search title" },
      social: { imageAssetId: "asset-1" },
    })).toEqual({
      title: "About NJ PBS",
      pageTheme: "default",
      description: "Station summary",
      homeHeroTitle: "Watch what matters",
      homeHeroSubtitle: "Stories from across New Jersey.",
      seo: { title: "Search title" },
      social: { imageAssetId: "asset-1" },
    });
  });

  it("drops a malformed historical theme when loading but leaves new input for server validation", () => {
    expect(pageMetadataFromDocument("contact", {
      title: "Contact",
      pageTheme: "retired-campaign-theme",
    })).toEqual({ title: "Contact", slug: "contact" });
    expect(pageMetadataSaveDocument({
      title: "Contact",
      pageTheme: "retired-campaign-theme",
    })).toEqual({
      title: "Contact",
      pageTheme: "retired-campaign-theme",
    });
  });
});

it("round-trips optional Home slides without altering legacy fallback values or sharing nested drafts", () => {
  const document = { title: "Home", homeHeroTitle: "Keep heading", homeHeroSubtitle: "Keep subtitle", heroBackgroundImage: "existing-image",
    homeHero: { mode: "manual", items: [{ itemId: "one", title: "Chosen", summary: "Summary", href: "/watch/" }] } };
  const metadata = pageMetadataFromDocument("home", document);
  const saved = pageMetadataSaveDocument(metadata);
  expect(saved).toEqual(document);
  (metadata.homeHero as typeof document.homeHero).items[0].title = "Changed draft";
  expect(document.homeHero.items[0].title).toBe("Chosen");
  expect((saved.homeHero as typeof document.homeHero).items[0].title).toBe("Chosen");
});

it("keeps Contact's live header out of the editable theme metadata", () => {
  expect(pageMetadataFromDocument("contact", { title: "Contact", pageTheme: "nj-decides" }))
    .toEqual({ title: "Contact", slug: "contact" });
});
