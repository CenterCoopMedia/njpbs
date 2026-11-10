import { describe, expect, it } from "vitest";

import { join } from "node:path";
import { renderHomeNewsRail, renderHomeProgramRail } from "../../packages/content-core/src/home-rail-render";

const cards = Array.from({ length: 6 }, (_, index) => ({
  title: `Program ${index}`, description: `About program ${index}`,
  href: `https://watch.njpbs.org/show/${index}/`, image: `/program-${index}.webp`, index,
}));

function fragment(markup: string): HTMLDivElement {
  const root = document.createElement("div");
  root.innerHTML = markup;
  return root;
}

describe("the named Home shelves in grid presentation", () => {
  it("keeps Featured and More as distinct, labeled source shelves", () => {
    const root = fragment([
      renderHomeProgramRail("featured", cards.slice(0, 3), "https://watch.njpbs.org/", true,
        { title: "Featured on NJ PBS", moreLabel: "Browse all", presentation: "grid" }),
      renderHomeProgramRail("more", cards.slice(3), "https://watch.njpbs.org/", true,
        { title: "More to watch", moreLabel: "More programs", presentation: "grid", columns: 4 }),
    ].join(""));
    expect(root.querySelectorAll("section")).toHaveLength(2);
    expect(root.querySelector("#feat-h")?.textContent).toBe("Featured on NJ PBS");
    expect(root.querySelector("#recent-h")?.textContent).toBe("More to watch");
    expect(root.querySelector("#featured-rail")?.children).toHaveLength(3);
    expect(root.querySelector("#more-rail")?.children).toHaveLength(3);
    expect(root.querySelectorAll(".home-shelf--columns-3")).toHaveLength(1);
    expect(root.querySelectorAll(".home-shelf--columns-4")).toHaveLength(1);
    expect([...root.querySelectorAll<HTMLAnchorElement>(".home-shelf__card")].map(link => link.getAttribute("href")))
      .toEqual(cards.map(card => card.href));
    expect(root.querySelector(".rail__track, .rail__arrow, .card--cta, button, [hidden], [inert]")).toBeNull();
    expect(root.querySelectorAll(".home-shelf__head a")).toHaveLength(2);
  });

  it("supports the same finite grid choice for Spotlight and retains external destinations", () => {
    const news = cards.slice(0, 3).map((card, index) => ({
      title: card.title, category: "New Jersey", image: card.image,
      href: `https://www.njspotlightnews.org/story-${index}/`, dateLabel: "Oct. 8, 2026",
    }));
    const root = fragment(renderHomeNewsRail(news, {
      title: "More from New Jersey", moreLabel: "All news", presentation: "grid", columns: 2,
    }));
    expect(root.querySelector("#spot-h")?.textContent).toBe("More from New Jersey");
    expect(root.querySelector("#spotlight-rail")?.children).toHaveLength(3);
    for (const link of root.querySelectorAll<HTMLAnchorElement>("a")) {
      expect(link.hostname).toBe("www.njspotlightnews.org");
      expect(link.target).toBe("_blank");
      expect(link.querySelector(".sr-only")?.textContent).toContain("opens in new tab");
    }
    expect(root.querySelector(".rail__track, button")).toBeNull();
  });

  it("retains the original rail behavior when presentation is omitted or explicitly rail", () => {
    const settings = { title: "Featured", moreLabel: "Browse all" };
    const omitted = renderHomeProgramRail("featured", cards, "/watch/", false, settings);
    const explicit = renderHomeProgramRail("featured", cards, "/watch/", false, { ...settings, presentation: "rail" });
    expect(explicit).toBe(omitted);
    const root = fragment(omitted);
    expect(root.querySelectorAll(".rail__arrow")).toHaveLength(2);
    expect(root.querySelectorAll(".rail__track .card")).toHaveLength(7);
  });

  it("escapes source copy and keeps the existing brand artwork fallback", () => {
    const attack = '\"><script>alert(1)</script>';
    const root = fragment(renderHomeProgramRail("featured", [{
      ...cards[0], title: attack, image: "javascript:bad()", href: "javascript:bad()", index: NaN,
    }], "/watch/", false, { title: attack, moreLabel: "Browse all", presentation: "grid" }));
    expect(root.querySelector("script, [onclick], [onerror]")).toBeNull();
    expect(root.querySelector(".home-shelf__title")?.textContent).toBe(attack);
    expect(root.innerHTML).not.toContain("javascript:");
    expect(root.innerHTML).toContain("var(--tile-gradient-0)");
  });
});
