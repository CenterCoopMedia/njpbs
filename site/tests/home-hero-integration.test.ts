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
describe("Home hero integration", () => {
  it("uses HomeHero with its background and slides", () => {
    expect(cinematicHeroSource).toContain("<HomeHero");
    for (const source of [cinematicHeroSource, homeHeroSource]) {
      expect(source).not.toContain("<NJHero");
      expect(source).not.toContain("@babylonjs");
    }
    expect(homeHeroSource).not.toContain('class="branded-signal"');
    expect(homeHeroSource).toContain("data-home-hero-background");
    expect(homeHeroSource).toContain("data-home-hero-slide");
  });
});
