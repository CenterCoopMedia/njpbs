import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const readSiteFile = (...segments: string[]) =>
  readFileSync(join(process.cwd(), ...segments), "utf8");

const cinematicHeroSource = readSiteFile(
  "src",
  "components",
  "CinematicHomePage.astro",
);
const homeHeroSource = readSiteFile("src", "components", "HomeHero.astro");
const njHeroSource = readSiteFile("src", "islands", "NJHero.astro");
const carouselSource = readSiteFile(
  "src",
  "components",
  "HeroContentCarousel.astro",
);

describe("disabled hero content carousel contracts", () => {
  it("keeps both legacy 3D paths out of the branded Home hero", () => {
    expect(njHeroSource).not.toContain("HeroContentCarousel");
    expect(njHeroSource).not.toContain("contentCarouselEnabled");
    expect(carouselSource).not.toContain(":global(.hero__grid)");
    expect(cinematicHeroSource).toContain("<HomeHero");
    for (const source of [cinematicHeroSource, homeHeroSource]) {
      expect(source).not.toContain("<NJHero");
      expect(source).not.toContain("HeroContentCarousel");
      expect(source).not.toContain("@babylonjs");
    }
    expect(homeHeroSource).not.toContain('class="branded-signal"');
    expect(homeHeroSource).toContain("data-home-hero-background");
    expect(homeHeroSource).toContain("data-home-hero-slide");
  });
});
