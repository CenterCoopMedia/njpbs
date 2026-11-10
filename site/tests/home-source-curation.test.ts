// @vitest-environment node
import { describe, expect, it } from "vitest";
import media from "../src/data/launch-media-manager.json";
import { curateHomeSource, homeSourceDuplicates, type HomeSourceCard } from "../../packages/content-core/src/home-source-curation";

const cards: HomeSourceCard[] = media.cards.map(card => ({
  id: card.id, source: "pbs_featured", title: card.title, summary: card.description,
  href: card.href, image: { url: card.image, alt: "" },
}));
const snapshot = { status: "ready" as const, checkedAt: media.checkedAt, cards };
const cutoffAt = "2026-06-30T00:00:00Z";

describe("protected Home source curation", () => {
  it("preserves the selected order from the recorded Media Manager show list", () => {
    const selectedIds = ["4117eb9d-765f-4a24-90b7-f82a73434bbd", "050acb51-e20b-4995-bc91-95f93b2178e4"];
    const result = curateHomeSource("home-featured", snapshot, { cutoffAt, selectedIds });
    expect(result.cards.map(card => card.title)).toEqual([
      "From That Small Island: The Story of the Irish Feature Film", "Painting Community",
    ]);
    expect(result).toMatchObject({ source: "pbs_featured", browseHref: "https://watch.njpbs.org/", missingIds: [], emptyReason: null });
    result.cards[0].image!.alt = "changed preview";
    expect(cards[1].image!.alt).toBe("");
  });

  it("cannot widen the protected source or replace a withdrawn selection", () => {
    const result = curateHomeSource("home-featured", { ...snapshot, cards: [
      { ...cards[0], source: "pbs_more" }, cards[1],
    ] }, { cutoffAt, selectedIds: [cards[0].id] });
    expect(result.cards).toEqual([]);
    expect(result.missingIds).toEqual(["050acb51-e20b-4995-bc91-95f93b2178e4"]);
    expect(result.emptyReason).toBe("selection_unavailable");
    expect(curateHomeSource("home-featured", snapshot, { cutoffAt, selectedIds: [] }).cards).toEqual([]);
  });

  it("enforces source caps and rejects malformed choices", () => {
    expect(curateHomeSource("home-featured", snapshot, { cutoffAt }).cards).toHaveLength(8);
    const more = { ...snapshot, cards: cards.map(card => ({ ...card, source: "pbs_more" as const })) };
    expect(curateHomeSource("home-more", more, { cutoffAt }).cards).toHaveLength(16);
    for (const options of [
      { cutoffAt, selectedIds: [cards[0].id, cards[0].id] },
      { cutoffAt, selectedIds: cards.slice(0, 9).map(card => card.id) },
      { cutoffAt, limit: 9 }, { cutoffAt: "2026-02-30T00:00:00Z" },
      { cutoffAt, source: "pbs_more" },
    ]) expect(() => curateHomeSource("home-featured", snapshot, options as never)).toThrow();
  });

  it("rejects inherited object keys instead of treating them as source identities", () => {
    for (const section of ["constructor", "toString", "__proto__", "hasOwnProperty", "unknown-section"]) {
      expect(() => curateHomeSource(section as never, snapshot, { cutoffAt, limit: 3 }))
        .toThrow("Home source selection is invalid.");
    }
  });

  it("keeps source failure distinct and strips fields outside the public model", () => {
    expect(curateHomeSource("home-featured", { status: "error" }, { cutoffAt })).toMatchObject({
      cards: [], checkedAt: null, emptyReason: "source_error",
    });
    expect(curateHomeSource("home-featured", { ...snapshot, cards: [] }, { cutoffAt }).emptyReason).toBe("source_empty");
    const result = curateHomeSource("home-featured", { ...snapshot, cards: [
      { ...cards[0], privateNote: "discard", image: { ...cards[0].image, secret: "discard" } },
      { ...cards[1], href: "https://watch.njpbs.org.evil.test/show/x/" },
    ] } as never, { cutoffAt });
    expect(result.cards).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("discard");
    expect(() => curateHomeSource("home-featured", { ...snapshot, checkedAt: "2027-01-01T00:00:00Z" }, { cutoffAt })).toThrow();
  });

  it("reports cross-section duplicates without redistributing a legitimate small pool", () => {
    const featured = curateHomeSource("home-featured", { ...snapshot, cards: cards.slice(0, 1) }, { cutoffAt });
    const more = curateHomeSource("home-more", { ...snapshot, cards: [{ ...cards[0], source: "pbs_more" }] }, { cutoffAt });
    expect(homeSourceDuplicates([featured, more])).toEqual([{
      href: "https://watch.njpbs.org/show/painting-community/", sections: ["home-featured", "home-more"],
    }]);
    expect(more.cards).toHaveLength(1);
    const ambiguous = curateHomeSource("home-featured", { ...snapshot, cards: [cards[0], cards[0]] }, { cutoffAt, selectedIds: [cards[0].id] });
    expect(ambiguous.missingIds).toEqual(["050acb51-e20b-4995-bc91-95f93b2178e4"]);
  });
});
