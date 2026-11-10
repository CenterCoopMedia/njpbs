// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  homepageNewsTopicHref,
  STAGED_HOMEPAGE_NEWS_TOPICS,
} from "../src/lib/homepage-news-topics";

const read = (relativePath: string) =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");

const COMPONENT = read("../src/components/HomepageNewsTopicBar.astro");
const HOMEPAGE = read("../src/components/CinematicHomePage.astro");
const INDEX = read("../src/pages/index.astro");

describe("the staged homepage news-topic bar", () => {
  it("preserves the representative editorial order", () => {
    expect(STAGED_HOMEPAGE_NEWS_TOPICS.map(({ label }) => label)).toEqual([
      "Politics",
      "Education",
      "Health",
      "Environment",
      "Transportation",
      "Business",
      "Elections",
    ]);
  });

  it("uses the existing exact Post-category filter without moving Posts", () => {
    expect(homepageNewsTopicHref(STAGED_HOMEPAGE_NEWS_TOPICS[0])).toBe(
      "/posts/?category=Politics",
    );
    expect(homepageNewsTopicHref(STAGED_HOMEPAGE_NEWS_TOPICS[6])).toBe(
      "/posts/?category=Elections",
    );
  });

  it("renders a labelled navigation landmark before the announcement", () => {
    expect(COMPONENT).toContain(
      '<nav class="news-topics" aria-label="News topics"',
    );
    expect(COMPONENT).toContain("topics.map");
    expect(HOMEPAGE).toContain("<HomepageNewsTopicBar");
    expect(HOMEPAGE.indexOf("<HomepageNewsTopicBar")).toBeLessThan(
      HOMEPAGE.indexOf("<HomepageAnnouncement"),
    );
  });

  it("keeps the staged row out of ordinary public builds", () => {
    expect(INDEX).toContain("internalSurfaceRoutesEnabled(process.env)");
    expect(INDEX).toContain("? STAGED_HOMEPAGE_NEWS_TOPICS");
    expect(INDEX).toContain("newsTopics={stagedNewsTopics}");
  });

  it("keeps every topic reachable in one horizontal, touch-friendly row", () => {
    expect(COMPONENT).toContain("overflow-x: auto");
    expect(COMPONENT).toContain("overscroll-behavior-inline: contain");
    expect(COMPONENT).toContain("white-space: nowrap");
    expect(COMPONENT).toContain("min-height: var(--target-comfortable)");
    expect(COMPONENT).toContain("padding-block: var(--space-2)");
    expect(COMPONENT).toContain("outline: var(--focus-outline)");
  });
});
