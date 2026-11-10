import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderLivePlayerFrame } from "../src/lib/live-player-render";

import {
  pbsAppUrl,
  pbsLivestreamEmbedUrl,
  pbsLivestreamWatchUrl,
  pbsVideoUrl,
} from "../src/data/launch-fallback";

// The /live/ page embeds the PBS livestream as a cross-origin iframe
// (player.pbs.org). Same-origin policy hides its load state from this origin, so
// unlike the gc.js schedule widget there is no failure event to detect and reveal
// a fallback for: a down, geo-blocked, or 403'd player just shows PBS's own frame.
// So the graceful-degradation guarantee for this surface (#189: "each surface has
// a defined fallback", "no PBS outage produces a blank or broken page") is a
// PERSISTENT escape hatch rendered next to the frame. This source test pins that
// the affordance exists, points off the failing frame, and is not hidden behind a
// reveal the parent can never trigger. It is the sibling of
// schedule-degradation-wiring.test.ts, which pins the schedule surface the same way.

const readSource = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

describe("livestream player degrades to a persistent escape hatch (issue #189)", () => {
  expect(readSource("../src/components/PublicSubpage.astro")).toContain("renderLivePlayerFrame()");
  const subpage = renderLivePlayerFrame();
  const servicePageStyles = readSource("../src/styles/service-page.css");

  // Isolate the player figure, so every assertion is about the player surface and
  // not some livestream link elsewhere on the page (the /live/ cards also link
  // out). The class="public-page__player" attribute is unique to the figure --
  // the section, frame, header, and fallback classes all carry a suffix.
  const playerFigure = (() => {
    const start = subpage.indexOf('class="public-page__player"');
    const end = subpage.indexOf("</figure>", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return subpage.slice(start, end);
  })();

  it("renders a fallback affordance inside the player figure", () => {
    expect(playerFigure).toMatch(/data-player-fallback/);
  });

  it("points the fallback to live destinations (PBS app + independent livestream), not VOD", () => {
    // The escape hatch must leave the dead iframe AND keep the user on live video.
    // This is a live-player failure, so a link to on-demand VOD (watch.njpbs.org /
    // pbsVideoUrl) would not recover live viewing -- it sends them to a different
    // product. Check the actual fallback links, apart from the iframe's own source.
    const fallback = playerFigure.match(/<p class="public-page__player-fallback"[^>]*>[\s\S]*?<\/p>/)?.[0];
    expect(fallback).toBeDefined();
    expect(fallback).toContain(`href="${pbsAppUrl}"`);
    expect(fallback).toContain(`href="${pbsLivestreamWatchUrl}"`);
    // ...and the affordance must NOT fall back to the VOD portal for a live failure.
    expect(fallback).not.toContain(`href="${pbsVideoUrl}"`);
    // The escape hatch must NOT reuse the iframe's own embed URL: when player.pbs.org
    // is the part that failed (down/403/geo-blocked), re-opening that exact URL in a
    // new tab just repeats the failing request. It must point off to an independent
    // live surface instead (#189, #385 review).
    expect(fallback).not.toContain(new URL(pbsLivestreamEmbedUrl).origin);
    // The constants resolve to live PBS surfaces: the app (plays live TV) and the
    // standalone NJ PBS livestream on watch.njpbs.org -- the same live feed served
    // by a different host and player than the failing embed.
    expect(pbsAppUrl).toMatch(/^https:\/\/www\.pbs\.org\/pbs-app\//);
    expect(pbsLivestreamWatchUrl).toMatch(/^https:\/\/watch\.njpbs\.org\/livestream\//);
    // Independence is the whole point: the escape hatch and the failing embed must
    // live on different hosts, or the recovery is not a recovery.
    const hostOf = (u: string) => new URL(u).host;
    expect(hostOf(pbsLivestreamWatchUrl)).not.toBe(hostOf(pbsLivestreamEmbedUrl));
  });

  it("keeps the affordance visible, not hidden behind a reveal that can never fire", () => {
    // A cross-origin iframe failure cannot be observed from this origin, so a
    // hidden-until-failure toggle (as the schedule widget uses) would never fire
    // for the player. The affordance must ship visible. Two cheap source checks
    // cover the realistic ways it could regress to hidden: a `hidden` attribute on
    // its own tag, and a display/visibility rule in its own style block. (A parent
    // wrapper flipping it hidden would be a visible structural edit caught in
    // review, not something a source test chases.)
    const tag = playerFigure.match(/<p class="public-page__player-fallback"[^>]*>/);
    expect(tag).not.toBeNull();
    expect(tag?.[0]).not.toMatch(/\bhidden\b/);

    const rule = servicePageStyles.match(
      /\.public-page__player-fallback\s*\{[^}]*\}/,
    );
    expect(rule).not.toBeNull();
    expect(rule?.[0]).not.toMatch(/display:\s*none/);
    expect(rule?.[0]).not.toMatch(/visibility:\s*hidden/);
  });
});
