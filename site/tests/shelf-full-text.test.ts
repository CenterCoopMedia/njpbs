import { describe, expect, it } from "vitest";
import { renderHomeNewsRail, renderHomeProgramRail } from "../../packages/content-core/src/home-rail-render";

import { renderHomeCuratedShelf } from "../../packages/content-core/src/home-curated-render";
import { shelfLayoutFixture } from "../../packages/content-core/fixtures/home-shelf-layouts";

const title = "A program title with enough words to exceed the compact shelf card";
const description = "The complete description continues past the compact card, and this final sentence must still be available.";

describe("full shelf text (#1740)", () => {
  it("provides a native disclosure outside the destination links", () => {
    document.body.innerHTML = renderHomeProgramRail("more", [{ title, description, href: "https://watch.njpbs.org/example/", external: true, index: 0 }], "/watch/");
    const details = document.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")!.textContent).toContain("for More to watch");
    expect(details.closest("a")).toBeNull();
    expect(details.querySelector("li p")!.textContent).toBe(description);
    const link = details.querySelector("li a")!;
    expect(link.textContent).toBe(`${title} (opens in new tab)`);
    expect(link.getAttribute("href")).toBe("https://watch.njpbs.org/example/");
    expect(link.getAttribute("target")).toBe("_blank");
  });
  it("keeps Spotlight dates and categories without inventing supporting copy", () => {
    document.body.innerHTML = renderHomeNewsRail([{ title, category: "Health", dateLabel: "October 25, 2026", href: "https://www.njspotlightnews.org/story/", image: "/image.webp" }]);
    expect(document.querySelector("details li p")!.textContent).toBe("Health · October 25, 2026");
    expect(document.querySelectorAll("details li p")).toHaveLength(1);
  });
  it("exposes the full summaries in curated list shelves too", () => {
    const fixture = shelfLayoutFixture("list", "filled");
    const catalog = fixture.sources.editorial!.catalog;
    const pool = catalog.sources["home-posts"];
    if (pool.status !== "ready") throw new Error("Expected ready fixture");
    pool.cards[0].summary = description;
    document.body.innerHTML = renderHomeCuratedShelf(fixture.block, catalog);
    expect(document.querySelector("details li p")!.textContent).toBe(description);
    expect(document.querySelector("details summary")!.textContent).toContain("for From NJ PBS");
  });
  it("does not add disclosure controls to unclipped grid shelves", () => {
    document.body.innerHTML = renderHomeProgramRail("more", [{ title, description: "", href: "/watch/", index: 0 }], "/watch/", false, { title: "Programs", moreLabel: "More", presentation: "grid", columns: 3 });
    expect(document.querySelector("details")).toBeNull();
    expect(document.querySelector(".home-shelf__title")!.textContent).toBe(title);
  });
});
