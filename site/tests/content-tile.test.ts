// @vitest-environment node
// Reads the component source off disk, so it needs the Node environment (the suite
// default, happy-dom, gives import.meta.url an http: URL that fileURLToPath rejects).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tileBadges, BADGE_COLORS, BADGE_ICONS, TILE_MIN_TARGET_PX, type BadgeTone, type ContentTileData } from "../src/lib/content-tile";
import { contrastRatio, meetsAA } from "../src/lib/contrast";

import { resolveTokenColor } from "./color-token-test-utils";

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const COMPONENT = read("../src/components/ContentTile.astro");

const freeEpisode: ContentTileData = {
  title: "Nature",
  href: "/w/nature",
  access: "free",
  mediaKind: "episode",
};
const passportClipLeaving: ContentTileData = {
  title: "Masterpiece preview",
  href: "/w/masterpiece",
  access: "passport",
  mediaKind: "clip",
  leavingOn: "2026-07-10",
};
const windowedEpisode: ContentTileData = {
  title: "Nature special",
  href: "/w/nature-special",
  access: "free",
  mediaKind: "episode",
  leavingPublicOn: "2026-07-10",
  leavingPassportOn: "2026-08-31",
};

describe("content tile status badges", () => {
  it("pairs every badge's colour with a text label and an icon (1.4.1)", () => {
    for (const tile of [freeEpisode, passportClipLeaving]) {
      const badges = tileBadges(tile);
      expect(badges.length).toBeGreaterThan(0);
      for (const b of badges) {
        // A non-empty label plus an icon means the status still reads with colour
        // removed -- it is never signalled by colour alone.
        expect(b.label.trim().length).toBeGreaterThan(0);
        expect(BADGE_ICONS[b.icon]).toBeTruthy();
        expect(BADGE_ICONS[b.icon].length).toBeGreaterThan(0);
      }
    }
  });

  it("surfaces free vs Passport before the click", () => {
    const free = tileBadges(freeEpisode).find((b) => b.id === "access");
    expect(free).toMatchObject({ tone: "free", label: "Free", icon: "unlock" });

    const passport = tileBadges(passportClipLeaving).find((b) => b.id === "access");
    expect(passport).toMatchObject({ tone: "passport", label: "Passport", icon: "lock" });
  });

  it("distinguishes a full episode from a clip", () => {
    const episode = tileBadges(freeEpisode).find((b) => b.id === "media");
    expect(episode).toMatchObject({ label: "Full episode", icon: "film" });

    const clip = tileBadges(passportClipLeaving).find((b) => b.id === "media");
    expect(clip).toMatchObject({ label: "Clip", icon: "clip" });
  });

  it("shows a leaving badge only when a date is known, with a full date for AT", () => {
    expect(tileBadges(freeEpisode).some((b) => b.id === "leaving")).toBe(false);

    const leaving = tileBadges(passportClipLeaving).find((b) => b.id === "leaving");
    expect(leaving?.label).toBe("Leaving Jul 10");
    expect(leaving?.srText).toBe("Leaving July 10, 2026");
  });

  it("shows each viewer the availability date that affects their access", () => {
    const publicLeaving = tileBadges(windowedEpisode, "free").find(
      (b) => b.id === "leaving",
    );
    expect(publicLeaving?.label).toBe("Free until Jul 10");
    expect(publicLeaving?.srText).toBe("Free until July 10, 2026");
    expect(tileBadges(windowedEpisode).find((b) => b.id === "leaving")).toEqual(
      publicLeaving,
    );

    const passportLeaving = tileBadges(windowedEpisode, "passport").find(
      (b) => b.id === "leaving",
    );
    expect(passportLeaving?.label).toBe("Leaving Aug 31");
    expect(passportLeaving?.srText).toBe("Leaving August 31, 2026");
  });

  it("does not present a public-window end as a member catalogue exit", () => {
    const publicOnlyWindow: ContentTileData = {
      ...windowedEpisode,
      leavingPassportOn: undefined,
    };

    expect(
      tileBadges(publicOnlyWindow, "passport").some((b) => b.id === "leaving"),
    ).toBe(false);
  });

  it("uses a known catalogue exit for both viewers", () => {
    const catalogueExit: ContentTileData = {
      ...windowedEpisode,
      leavingPublicOn: undefined,
    };

    for (const viewerAccess of ["free", "passport"] as const) {
      expect(
        tileBadges(catalogueExit, viewerAccess).find((b) => b.id === "leaving"),
      ).toMatchObject({
        label: "Leaving Aug 31",
        srText: "Leaving August 31, 2026",
      });
    }
  });

  it("keeps the legacy leavingOn contract for both viewers", () => {
    for (const viewerAccess of ["free", "passport"] as const) {
      expect(
        tileBadges(passportClipLeaving, viewerAccess).find((b) => b.id === "leaving"),
      ).toMatchObject({
        label: "Leaving Jul 10",
        srText: "Leaving July 10, 2026",
      });
    }
  });

  it("orders the badges access, leaving, then media", () => {
    expect(tileBadges(passportClipLeaving).map((b) => b.id)).toEqual([
      "access",
      "leaving",
      "media",
    ]);
  });
});

describe("badge contrast", () => {
  it("clears WCAG AA for normal text on every badge tone", () => {
    for (const tone of Object.keys(BADGE_COLORS) as BadgeTone[]) {
      const { fg, bg } = BADGE_COLORS[tone];
      const ratio = contrastRatio(resolveTokenColor(fg), resolveTokenColor(bg));
      expect(meetsAA(ratio), `${tone} badge ratio ${ratio.toFixed(2)}`).toBe(true);
    }
  });
});

describe("ContentTile.astro presentation", () => {
  it("marks each badge icon decorative and exposes the media kind programmatically", () => {
    expect(COMPONENT).toContain('set:html={BADGE_ICONS[b.icon]}');
    expect(COMPONENT).toContain('aria-hidden="true"');
    expect(COMPONENT).toContain("data-media-kind={tile.mediaKind}");
  });

  it("applies the minimum target size and hides the AT-only date text", () => {
    expect(TILE_MIN_TARGET_PX).toBeGreaterThanOrEqual(24); // 2.5.8 AA floor
    expect(COMPONENT).toContain("minTarget: `${TILE_MIN_TARGET_PX}px`");
    expect(COMPONENT).toContain("min-height: var(--minTarget)");
    expect(COMPONENT).toContain('class="sr-only"');
  });
});
