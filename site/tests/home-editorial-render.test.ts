import { afterEach, describe, expect, it, vi } from "vitest";

import { renderHomeEditorialHero } from "../../packages/content-core/src/home-editorial-render";
import type { HomeHeroCard } from "../../packages/content-core/src/home-hero";
import { mountHomeHeroes } from "../src/lib/home-hero-client";

const story = (index: number): HomeHeroCard => ({
  id: `story-${index}`, title: `Story ${index}`, summary: `Summary ${index}`,
  href: `/posts/story-${index}/`, displayDate: "2026-10-08",
  image: { url: `/media/story-${index}.webp`, alt: `Scene ${index}`, width: 1200, height: 675 },
});

function fragment(markup: string): HTMLDivElement {
  const root = document.createElement("div");
  root.innerHTML = markup;
  return root;
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("the shared static Home opening", () => {
  it("lets the caller retain the branded fallback when no story resolves", () => {
    expect(renderHomeEditorialHero([])).toBe("");
  });

  it("renders one lead and the existing date, summary and image description", () => {
    const root = fragment(renderHomeEditorialHero([story(0)]));
    expect(root.querySelectorAll("h1")).toHaveLength(1);
    expect(root.querySelector("#hero-h")?.textContent).toBe("Story 0");
    expect(root.querySelector("time")?.textContent).toBe("Oct. 8, 2026");
    expect(root.querySelector("time")?.getAttribute("datetime")).toBe("2026-10-08");
    expect(root.querySelector(".home-editorial__summary")?.textContent).toBe("Summary 0");
    expect(root.querySelector("img")?.getAttribute("alt")).toBe("Scene 0");
    expect(root.querySelector("img")?.getAttribute("fetchpriority")).toBe("high");
    expect(root.querySelector(".home-editorial__support, .home-editorial__overflow")).toBeNull();
  });

  it("shows a lead and three supporting links without a carousel or hidden content", () => {
    const cards = Array.from({ length: 4 }, (_, index) => story(index));
    const root = fragment(renderHomeEditorialHero(cards));
    expect(root.querySelector(".home-editorial__support h2")?.textContent).toBe("Latest stories");
    expect(root.querySelectorAll(".home-editorial__support li")).toHaveLength(3);
    expect([...root.querySelectorAll<HTMLAnchorElement>("a")].map(link => link.getAttribute("href")))
      .toEqual(cards.map(card => card.href));
    expect(root.querySelector("[hidden], [inert], [aria-roledescription], button, script, .rail__track")).toBeNull();
    expect(root.querySelectorAll("img")).toHaveLength(4);
  });

  it("retains every selected story in order when fewer supports are chosen", () => {
    const cards = Array.from({ length: 10 }, (_, index) => story(index));
    const root = fragment(renderHomeEditorialHero(cards, {
      supportingCount: 2, supportingHeading: "Around New Jersey", overflowHeading: "Keep reading",
    }));
    expect(root.querySelector(".home-editorial__support h2")?.textContent).toBe("Around New Jersey");
    expect(root.querySelectorAll(".home-editorial__support li")).toHaveLength(2);
    expect(root.querySelector(".home-editorial__overflow h2")?.textContent).toBe("Keep reading");
    expect(root.querySelectorAll(".home-editorial__overflow li")).toHaveLength(7);
    expect([...root.querySelectorAll<HTMLAnchorElement>("a")].map(link => link.getAttribute("href")))
      .toEqual(cards.map(card => card.href));
    expect(root.querySelectorAll("h1")).toHaveLength(1);
  });

  it("retains admitted Spotlight publication attribution in every editorial role", () => {
    const root = fragment(renderHomeEditorialHero([
      { ...story(0), spotlightNews: true },
      { ...story(1), spotlightNews: true },
      { ...story(2), spotlightNews: false },
      { ...story(3), spotlightNews: true },
      { ...story(4), href: "https://www.njspotlightnews.org/story/", eyebrow: "NJ Spotlight News" },
    ], { supportingCount: 2 }));
    const labeledLinks = [...root.querySelectorAll<HTMLAnchorElement>("a")]
      .filter(link => link.querySelector('[data-publication="nj-spotlight-news"]'));
    expect(labeledLinks.map(link => link.getAttribute("href")))
      .toEqual([story(0).href, story(1).href, story(3).href]);
    expect(root.querySelector(".home-editorial__lead .post-publication--headline")?.textContent)
      .toBe("NJ Spotlight News");
    expect(root.querySelectorAll(".home-editorial__support .post-publication--card")).toHaveLength(1);
    expect(root.querySelectorAll(".home-editorial__overflow .post-publication--card")).toHaveLength(1);
  });

  it("uses safe default headings for blank draft labels and preserves the selected count", () => {
    const root = fragment(renderHomeEditorialHero([story(0), story(1), story(2)], {
      supportingCount: 1, leadHeading: "\t", supportingHeading: "  ", overflowHeading: "\n",
    }));
    expect(root.querySelector(".home-editorial__label")?.textContent).toBe("Top story");
    expect(root.querySelector(".home-editorial__support h2")?.textContent).toBe("Latest stories");
    expect(root.querySelector(".home-editorial__overflow h2")?.textContent).toBe("More stories");
  });

  it("escapes editorial text and rejects unsafe links and artwork at the rendering boundary", () => {
    const attack = '<script>alert("bad")</script>';
    const root = fragment(renderHomeEditorialHero([
      { ...story(0), title: attack, summary: attack, image: { url: "javascript:bad()", alt: attack } },
      { ...story(1), href: "javascript:bad()" },
      { ...story(2), href: "https://www.njspotlightnews.org/story/" },
    ], { leadHeading: attack, supportingHeading: attack, fallbackImage: { url: "javascript:bad()" } }));
    expect(root.querySelector("script, [onerror], [onclick]")).toBeNull();
    expect(root.querySelector("#hero-h")?.textContent).toBe(attack);
    expect(root.querySelector(".home-editorial__label")?.textContent).toBe(attack);
    expect(root.querySelector(".home-editorial__support h2")?.textContent).toBe(attack);
    expect(root.innerHTML).not.toContain("javascript:");
    expect(root.querySelector("img")?.getAttribute("src")).toBe("/brand/home/new-jersey-blue.webp");
    const external = root.querySelector<HTMLAnchorElement>('a[href^="https:"]')!;
    expect(external.target).toBe("_blank");
    expect(external.rel).toBe("noopener");
    expect(external.querySelector(".sr-only")?.textContent).toContain("opens in new tab");
  });

  it("retains the configured page image when the lead has no artwork", () => {
    const root = fragment(renderHomeEditorialHero([{ ...story(0), image: undefined }], {
      fallbackImage: { url: "/media/home.webp", width: 1600, height: 900 }, fallbackPosition: "top",
    }));
    const image = root.querySelector("img")!;
    expect(image.getAttribute("src")).toBe("/media/home.webp");
    expect(image.getAttribute("alt")).toBe("");
    expect(image.getAttribute("data-fallback-position")).toBe("top");
  });

  it("does not start rotation when the existing Home initializer sees editorial markup", () => {
    vi.useFakeTimers();
    const cards = Array.from({ length: 10 }, (_, index) => story(index));
    document.body.innerHTML = renderHomeEditorialHero(cards);
    mountHomeHeroes();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(24_000);
    expect([...document.querySelectorAll<HTMLAnchorElement>("a")].map(link => link.getAttribute("href")))
      .toEqual(cards.map(card => card.href));
    expect(document.querySelector("[hidden], [inert]")).toBeNull();
  });
});
