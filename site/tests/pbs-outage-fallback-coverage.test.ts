// Binds the survivability model's fallback claim to each surface's real fallback (#189).
//
// pbs-outage-survivability.ts derives the whole page's outage verdict from one
// hand-maintained list, SURFACES_WITH_FALLBACK, and pbs-outage-survivability.test.ts
// proves the derivation is correct *given* that list. Each surface's own test proves
// that surface's fallback in isolation. Nothing binds the two: the model would
// happily report a surface usable in an outage because it is on the list, even if
// that surface had no working fallback -- the contract doc's "usability is derived
// from built fallback coverage" (pbs-degradation-fallback-contract.md) is, until
// here, a prose claim rather than an executable one.
//
// This test closes that seam. For every surface the model lists as covered, it
// exercises that surface's REAL fallback under a simulated PBS outage and asserts it
// degrades honestly -- an unavailable/cached island with a real next step, never a
// blank, broken, or access-granting state. Then it checks the two directions the
// list can drift: a surface added to SURFACES_WITH_FALLBACK without a working
// fallback has no prover here (so this test fails), and the one PBS-backed surface
// with no built fallback (the PBS-hosted donate transaction) stays out of coverage
// and is reported broken in a full lapse.
//
// Scope: it exercises each surface's policy, data, or wired escape hatch at the unit
// level, the same posture the rest of #189 uses. It is not a live Astro render over
// the assembled page; that binding is the deferred gap the contract doc still names.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { renderLivePlayerFrame } from "../src/lib/live-player-render";

import {
  PBS_BACKED_SURFACES,
  SURFACES_WITH_FALLBACK,
  assessOutage,
  type PbsSurface,
} from "../src/lib/pbs-outage-survivability";
import { resolveScheduleWidgetStatus } from "../src/lib/schedule-widget-health";
import {
  resolveScheduleAvailability,
  type ScheduleFetchStatus,
} from "../src/lib/schedule-availability";
import {
  resolveGatedPlayback,
  type GatedFetchFailure,
  type GatedOutageLayer,
} from "../src/lib/member-gated-playback";
import {
  manualLaunchCards,
  pbsLivestreamWatchUrl,
  pbsLivestreamEmbedUrl,
  selectLaunchCards,
  type LaunchCard,
} from "../src/data/launch-fallback";

// Every non-ok transport failure the proxy collapses PBS into, shared across the
// surfaces that take a ScheduleFetchStatus / GatedFetchFailure. The list is bound to
// both status unions, not free-standing: `satisfies` proves no *extra* case (every
// entry is a real non-ok status on both surfaces), and the AssertCovers aliases below
// prove no *missing* case (every non-ok ScheduleFetchStatus and every GatedFetchFailure
// appears here). So a surface that grows a new outage status fails to compile until it
// is listed and exercised, instead of silently skipping coverage.
const FETCH_FAILURES = [
  "timeout",
  "forbidden",
  "rateLimited",
  "error",
] as const satisfies readonly (Exclude<ScheduleFetchStatus, "ok"> & GatedFetchFailure)[];

type FetchFailure = (typeof FETCH_FAILURES)[number];
// Fails to compile if Union has a member missing from FETCH_FAILURES.
type AssertCovers<Union extends FetchFailure> = Union;
type _CoversSchedule = AssertCovers<Exclude<ScheduleFetchStatus, "ok">>;
type _CoversGated = AssertCovers<GatedFetchFailure>;
const NOW = new Date("2026-07-09T12:00:00-04:00");

// One prover per surface the model claims has a fallback. Each drives that surface's
// real fallback under a simulated outage and asserts an honest, usable degradation.
// The map's keys are checked against SURFACES_WITH_FALLBACK below, so a surface added
// to the model's list without a prover here fails the coverage test.
const PROVERS: Record<(typeof SURFACES_WITH_FALLBACK)[number], () => void> = {
  // The player embed is cross-origin, so its failure is unobservable from this
  // origin; its fallback is a persistent escape hatch wired into the page, proven at
  // the source level (the same way player-degradation.test.ts pins it). Exercising
  // it means confirming the affordance ships pointing off to an independent live
  // host, not back at the failing embed.
  livestreamPlayer: () => {
    // happy-dom hands modules a non-file: import.meta.url, so resolve via
    // fileURLToPath rather than `new URL(rel, import.meta.url)`, which readFileSync
    // rejects for its scheme (schedule-degradation-wiring.test.ts documents the trap).
    const subpage = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "src", "components", "PublicSubpage.astro"),
      "utf8",
    );
    // Locate the player figure before slicing, so a missing marker fails as
    // "player marker not found" rather than a confusing downstream regex mismatch.
    expect(subpage).toContain("renderLivePlayerFrame()");
    const player = renderLivePlayerFrame();
    const start = player.indexOf('class="public-page__player"');
    expect(start, "player figure marker not found in shared renderer").toBeGreaterThan(-1);
    const end = player.indexOf("</figure>", start);
    expect(end, "player figure has no closing </figure>").toBeGreaterThan(start);
    const figure = player.slice(start, end);
    expect(figure).toMatch(/data-player-fallback/);
    // The escape hatch leaves the dead frame for an independent live host, and does
    // not re-open the exact embed URL that just failed.
    const fallback = figure.match(/<p class="public-page__player-fallback"[^>]*>[\s\S]*?<\/p>/)?.[0];
    expect(fallback).toBeDefined();
    expect(fallback).toContain(`href="${pbsLivestreamWatchUrl}"`);
    expect(fallback).not.toContain(new URL(pbsLivestreamEmbedUrl).origin);
    expect(new URL(pbsLivestreamWatchUrl).host).not.toBe(
      new URL(pbsLivestreamEmbedUrl).host,
    );
  },

  // gc.js is a third-party script we read through the DOM. A loader error or a
  // missed render deadline must resolve to the honest "unavailable" fallback, never
  // silently stay "loading" or read as "ready" when nothing rendered.
  scheduleGrid: () => {
    const base = { widgetRendered: false, loaderErrored: false, deadlineReached: false };
    expect(resolveScheduleWidgetStatus({ ...base, loaderErrored: true })).toBe("unavailable");
    expect(resolveScheduleWidgetStatus({ ...base, deadlineReached: true })).toBe("unavailable");
    // A genuinely rendered widget is still "ready" -- the fallback does not fire when
    // the grid is up, so this is degradation, not a blanket takeover.
    expect(resolveScheduleWidgetStatus({ ...base, widgetRendered: true })).toBe("ready");
  },

  // The now/next strip is our own TVSS proxy fetch. Every failure must degrade to
  // last-known-good cached listings, or to an honest empty state with a real next
  // step when nothing is cached -- and never to a bare "live" strip.
  nowNextStrip: () => {
    for (const status of FETCH_FAILURES) {
      const cold = resolveScheduleAvailability<string>({
        status,
        fresh: null,
        cache: null,
        now: NOW,
      });
      expect(cold.render.mode).toBe("unavailable");
      expect(cold.render.mode === "unavailable" && cold.render.notice.length).toBeGreaterThan(0);

      const warm = resolveScheduleAvailability<string>({
        status,
        fresh: null,
        cache: { data: "last-known-good", fetchedAt: "2026-07-09T06:00:00-04:00" },
        now: NOW,
      });
      expect(warm.render.mode).toBe("cached");
      // A 403 lapse is never retried; the transient failures are.
      expect(warm.retryable).toBe(status !== "forbidden");
    }
  },

  // Media Manager cards are optional: the homepage selects them when the feed has any,
  // and falls back to the in-repo manual cards when it is empty (an outage or a dropped
  // feed). The homepage runs that choice through selectLaunchCards, so this exercises
  // the exact same pure function under an empty feed rather than matching the selection
  // expression in component source (which a refactor could leave behind as dead code).
  vodLaunchCards: () => {
    // An empty feed resolves to the real manual cards, by reference.
    expect(selectLaunchCards([], manualLaunchCards)).toBe(manualLaunchCards);
    expect(manualLaunchCards.length).toBeGreaterThan(0);
    for (const card of manualLaunchCards) {
      expect(card.source).toBe("manual");
      expect(card.href.length).toBeGreaterThan(0);
    }
    // A non-empty feed passes through unchanged; the fallback fires only on an empty feed.
    const liveFeed: LaunchCard[] = [
      { title: "Live", description: "from a synced feed", href: "/live-vod/", source: "media-manager" },
    ];
    expect(selectLaunchCards(liveFeed, manualLaunchCards)).toBe(liveFeed);

    // Wiring: the homepage's rendered launch-card rail is assigned from selectLaunchCards,
    // so the direct assertions above are the production selection, not a parallel copy.
    // This fails if the homepage stops routing launchCards through the helper (a full
    // Astro render over the rail is the deferred Container-API gap the contract doc names).
    const homepage = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "src", "components", "CinematicHomePage.astro"),
      "utf8",
    );
    const sources = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "src", "lib", "home-sources.ts"),
      "utf8",
    );
    expect(sources).toMatch(/pool\s*=\s*selectLaunchCards\(/);
    expect(homepage).toContain('getEntry("publicHomeSources", "home")');
    expect(homepage).toContain("homeSources.pbs.featured.map(");
    expect(homepage).toContain("homeSources.pbs.more.map(");
  },

  // Fail-closed: an entitlement or sign-in outage denies access and shows an honest
  // unavailable island (never a broken/blank state, never access from stale data).
  memberGatedPlayback: () => {
    const layers: GatedOutageLayer[] = ["auth", "entitlement"];
    for (const layer of layers) {
      for (const status of FETCH_FAILURES as readonly GatedFetchFailure[]) {
        const r = resolveGatedPlayback({ kind: "outage", layer, status });
        expect(r.render.mode).toBe("unavailable");
        expect(r.render.mode === "unavailable" && r.render.notice.length).toBeGreaterThan(0);
        expect(r.grantAccess).toBe(false);
      }
    }
  },
};

describe("SURFACES_WITH_FALLBACK is backed by each surface's real fallback (issue #189)", () => {
  it("every surface the model lists as covered has a prover that exercises its real fallback", () => {
    // The binding both ways: no listed surface may lack a prover (an unproven claim
    // of coverage), and no prover may name a surface the model does not list.
    expect(Object.keys(PROVERS).sort()).toEqual([...SURFACES_WITH_FALLBACK].sort());
  });

  for (const surface of SURFACES_WITH_FALLBACK) {
    it(`${surface} degrades honestly under a simulated PBS outage`, () => {
      PROVERS[surface]();
    });
  }

  it("the PBS-hosted donate transaction stays out of coverage and reads as broken in a full lapse", () => {
    // The one PBS-backed surface with no CCM-hosted fallback. It must be backed but
    // absent from coverage, so the model does not overstate the site's survivability.
    expect(PBS_BACKED_SURFACES).toContain<PbsSurface>("donateTransaction");
    expect(SURFACES_WITH_FALLBACK).not.toContain("donateTransaction");
    expect(Object.keys(PROVERS)).not.toContain("donateTransaction");
  });

  it("the model's full-lapse verdict agrees with the coverage list the provers are pinned to", () => {
    // A consistency cross-check across the triangle, not a re-run of the provers: the
    // per-surface tests above prove each fallback, the first test pins the prover set
    // to SURFACES_WITH_FALLBACK, and this pins that same list to the model's verdict.
    // With every PBS surface failing at once, each listed surface reads usable and
    // degraded and the one with no fallback (donate) reads broken. If the provers and
    // the list drift, the first test fails; if the list and the model drift, this does.
    const outage = assessOutage(new Set(PBS_BACKED_SURFACES));
    for (const surface of SURFACES_WITH_FALLBACK) {
      expect(outage.surfaces[surface]).toEqual({ usable: true, degraded: true });
    }
    expect(outage.surfaces.donateTransaction).toEqual({ usable: false, degraded: true });
    expect(outage.noSurfaceBroken).toBe(false);
    expect(outage.editorialShellUsable).toBe(true);
  });
});
