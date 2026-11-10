import { renderCustomShelf } from "../../packages/content-core/src/content-render";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderHomeNewsRail, renderHomeProgramRail } from "../../packages/content-core/src/home-rail-render";

const program = { title: "Program", description: "Description", href: "/watch/", image: "/brand/starthere/ondemand.webp", index: 0 };
const renderedRails = [
  renderHomeProgramRail("featured", [program], "/watch/"),
  renderHomeProgramRail("more", [program], "/watch/"),
  renderHomeNewsRail([{ title: "Headline", category: "News", href: "https://www.njspotlightnews.org/story/", image: "/news.webp" }]),
].join("");

const source = readFileSync(
  join(process.cwd(), "src", "components", "CinematicHomePage.astro"),
  "utf8",
);
const promotionSource = renderCustomShelf({ id: "promotion", type: "promotion_playlist", order: 0, visible: true,
  data: { title: "Local content", placement: "before_featured", cards: [{ itemId: "one", title: "Watch", summary: "Watch NJ PBS", href: "/watch/", imageAssetId: "image", alt: "Artwork" }] },
}, { resolveAsset: () => ({ url: "/brand/starthere/ondemand.webp" }) });

describe("homepage media rails", () => {
  it("uses instant rail scrolling for either reduced-motion preference", () => {
    expect(source).toMatch(
      /var reduceMotion =\s*document\.documentElement\.dataset\.motion === "off" \|\|\s*window\.matchMedia\("\(prefers-reduced-motion: reduce\)"\)\.matches;/,
    );
    expect(source).toContain(
      'track.scrollTo({ left: nextLeft, behavior: reduceMotion ? "auto" : "smooth" });',
    );
  });
});

describe("homepage rail cards survive a pointer slip", () => {
  // A rail is a horizontal scroller, so viewers push it sideways. Native HTML
  // drag on a link or an image starts on a few pixels of movement and cancels
  // the click, so a card that stays draggable swallows the tap that was meant
  // to open the programme. Report njpbs-20260902-7b7e90b9.
  const railSources = [renderedRails, promotionSource];
  const LINK = /<a\b[^>]*\bclass="(?:card|spotlight-card|custom-shelf__card)\b[^"]*"[^>]*>/g;
  const IMAGE = /<img\b[^>]*\bclass="(?:card__image|spotlight-card__image|custom-shelf__image)\b[^"]*"[^>]*>/g;
  const matchAll = (pattern: RegExp) =>
    railSources.flatMap((text) => text.match(pattern) ?? []);

  it("marks every rail card link as not draggable", () => {
    expect(matchAll(LINK).length).toBeGreaterThanOrEqual(7);
    for (const tag of matchAll(LINK)) {
      expect(tag).toContain('draggable="false"');
    }
  });

  it("marks every rail card image as not draggable", () => {
    expect(matchAll(IMAGE).length).toBeGreaterThanOrEqual(4);
    for (const tag of matchAll(IMAGE)) {
      expect(tag).toContain('draggable="false"');
    }
  });
});

describe("shared Home rail content boundary", () => {
  it("drops untrusted feed images in both shelf layouts while retaining the linked card", () => {
    for (const presentation of ["rail", "grid"] as const) {
      const html = renderHomeProgramRail("featured", [{ ...program, image: "https://tracker.example/pixel.png" }], "/watch/", false,
        { title: "Programs", moreLabel: "Browse", presentation, columns: 3 });
      expect(html).not.toContain("tracker.example");
      expect(html).toContain('href="/watch/"');
      expect(html).toContain("Program");
      const trusted = renderHomeProgramRail("featured", [{ ...program, image: "https://image.pbs.org/program.jpg" }], "/watch/", false,
        { title: "Programs", moreLabel: "Browse", presentation, columns: 3 });
      expect(trusted).toContain('src="https://image.pbs.org/program.jpg"');
      expect(trusted).toContain('referrerpolicy="no-referrer"');
    }
  });

  it("escapes source text and attributes and rejects executable URLs", () => {
    const attack = '\"><script>alert(1)</script>';
    const html = renderHomeProgramRail("featured", [{ ...program, title: attack, description: attack, href: "javascript:alert(1)", image: "javascript:alert(2)", index: NaN }], '" onmouseover="alert(3)');
    const news = renderHomeNewsRail([{ title: attack, category: attack, dateLabel: attack, href: "javascript:alert(1)", image: "javascript:alert(2)" }]);
    for (const markup of [html, news]) {
      expect(markup).not.toContain("<script>");
      expect(markup).not.toContain("javascript:");
      expect(markup).toContain("&lt;script&gt;");
      expect(markup).not.toMatch(/\sonmouseover="/);
    }
    expect(html).toContain("background:var(--tile-gradient-0)");
  });
});
