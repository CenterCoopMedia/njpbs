import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { coverageSites } from "../src/data/transmitter-coverage";

describe("transmitter coverage data", () => {
  it("keeps station, community, facility, and channel rows aligned", () => {
    for (const site of coverageSites) {
      expect(site.communities).toHaveLength(site.callsigns.length);
      expect(site.contourPath).toMatch(/^M.+ Z$/);

      if (site.category === "nj-coming") {
        expect(site.facilityIds).toHaveLength(0);
      } else {
        expect(site.facilityIds).toHaveLength(site.callsigns.length);
      }

      if ("channels" in site) {
        expect(site.channels).toHaveLength(site.callsigns.length);
      }
    }
  });

  it("lists every proposed signal on its own row with no approved FCC facility IDs", () => {
    const proposedSites = coverageSites.filter((site) => site.category === "nj-coming");

    expect(proposedSites).toHaveLength(10);
    expect(proposedSites.flatMap((site) => site.callsigns)).toHaveLength(10);
    expect(proposedSites.every((site) => site.callsigns.length === 1)).toBe(true);
    expect(proposedSites.every((site) => site.facilityIds.length === 0)).toBe(true);
  });

  it("counts nine proposed transmitter sites because Princeton and Yardville are co-located", () => {
    const transmitterSites = new Set(
      coverageSites
        .filter((site) => site.category === "nj-coming")
        .map((site) => `${site.lat},${site.lon}`),
    );

    expect(transmitterSites.size).toBe(9);
  });

  it("gives the co-located Princeton and Yardville signals their own channel and contour", () => {
    const princeton = coverageSites.find((site) => site.id === "coming-princeton");
    const yardville = coverageSites.find((site) => site.id === "coming-yardville");

    expect(princeton?.channel).toBe(22);
    expect(yardville?.channel).toBe(26);
    expect(princeton?.communities).toEqual(["Princeton, N.J."]);
    expect(yardville?.communities).toEqual(["Yardville, N.J."]);
    expect(princeton?.lat).toBe(yardville?.lat);
    expect(princeton?.lon).toBe(yardville?.lon);
    expect(princeton?.contourPath).not.toBe(yardville?.contourPath);
  });

  it("keeps each co-located signal label selectable", () => {
    const coverageMapSource = readFileSync(
      "src/components/TransmitterCoverageMap.astro",
      "utf8",
    );

    expect(coverageMapSource).toMatch(
      /\.coverage-site text \{[\s\S]*?pointer-events:\s*auto;/,
    );
  });

  it("records the FCC-confirmed shared RF channels explicitly", () => {
    const sharedChannels = Object.fromEntries(
      coverageSites
        .filter((site) => "channels" in site)
        .map((site) => [site.id, "channels" in site ? [...site.channels] : []]),
    );

    expect(sharedChannels).toEqual({
      "lehigh-valley": [9, 9],
      "nj-north": [8, 8],
      "nj-south": [23, 23],
    });
  });
});
