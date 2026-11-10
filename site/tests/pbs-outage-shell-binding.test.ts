// Binds the survivability model's editorial-shell claim to the live shell (#189).
//
// pbs-outage-survivability.ts proves, over the surface taxonomy, that the three
// PBS-free surfaces -- editorial content, navigation, and the give landing page --
// stay usable in a full PBS outage. That proof lives at the model level: it never
// looks at a real component. The contract doc (pbs-degradation-fallback-contract.md)
// names the remaining step as a "live-render binding": nothing yet asserts the
// actual public sources render those surfaces without reading PBS state.
//
// PublicSiteLayout.astro IS that shell. It frames every public page with the
// primary nav, the <main> content slot, and the footer, and it imports only static
// data. The independently addressable /give/ page lives in launch-fallback.ts.
// Issue #452 deliberately removed the shell link to that page, so the binding
// checks the page's route definition instead of falsely joining two branches of
// donateHref's conditional source. This pins two things:
//   1. the public sources render a concrete landmark for every PBS-free surface, and
//   2. the shell reads no PBS runtime state to do it (no fetch, no import of a
//      PBS-surface runtime, not even the outage model gating a render).
// If a later change wires a PBS fetch or a schedule/availability runtime into the
// shell -- so a PBS outage could blank the nav or footer -- this goes
// red. That turns the model's design guarantee into a source-level runtime one.
//
// This is the source-level half of the binding, in the same idiom as the repo's
// other component tests (read the shipped .astro source, assert against it). A
// full Astro render (Container API) over the shell lands when the PBS surfaces are
// actually wired; see the contract doc's coverage gaps.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { PBS_FREE_SURFACES } from "../src/lib/pbs-outage-survivability";

const shell = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "src",
    "layouts",
    "PublicSiteLayout.astro",
  ),
  "utf8",
);
const fallbackPages = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "packages", "content-core", "src", "launch-fallback.ts"),
  "utf8",
);

type PbsFreeSurface = (typeof PBS_FREE_SURFACES)[number];

// One concrete source and landmark set per PBS-free surface the model names.
// Written out by hand so dropping a landmark in a refactor
// surfaces here as a mismatch, not a self-passing tautology. The Record type is
// keyed by the model's own union, so adding a PBS-free surface fails to compile
// until it gets a landmark here.
const SURFACE_BINDINGS: Record<PbsFreeSurface, { source: string; landmarks: RegExp[] }> = {
  navigation: {
    source: shell,
    landmarks: [/<nav class="primary"/, /id="primary-nav"/, /aria-label="Primary"/],
  },
  // The <main> matcher tolerates additional attributes on the tag: the landmark
  // this binds is "a concrete <main id="main"> content region exists", not the
  // exact attribute list. It gained data-pagefind-body in #226 and would
  // otherwise go red on a change that does not touch survivability at all.
  // The second landmark binds "<main> holds the page's default slot". The shell may
  // place a bare <slot /> or the slot it rendered first (#2762 reads it to detect a player).
  editorialContent: {
    source: shell,
    landmarks: [
      /<main id="main"[^>]*>/,
      /<main id="main"[^>]*>\s*<Fragment set:html=\{deferredPageContent\}\s*\/>/,
      /const pageContent = await Astro\.slots\.render\("default"\);/,
      /const deferredPageContent = isKidsRoute \? pageContent : deferYoutubeEmbeds\(pageContent\);/,
    ],
  },
  giveLandingPage: {
    source: fallbackPages,
    landmarks: [/\bgive:\s*\{/, /slug: "give"/, /title: "Give to NJ PBS"/],
  },
};

// A PBS outage can only reach the shell if the shell READS PBS state to render.
// These markers name the ways it could: a live fetch, or an import of a PBS-backed
// surface's runtime (or the outage model itself) used to gate the frame.
const PBS_RUNTIME_COUPLINGS: RegExp[] = [
  /\bfetch\s*\(/,
  /schedule-availability/,
  /schedule-now-next/,
  /schedule-widget/,
  /player-degradation/,
  /pbs-outage-survivability/,
];

describe("editorial shell binding: the live shell renders the PBS-free surfaces without reading PBS state (#189)", () => {
  it("covers exactly the model's PBS-free surfaces", () => {
    // Ties the landmark set to the model: add a PBS-free surface to the taxonomy
    // and this fails until its public source gets a landmark here.
    expect(Object.keys(SURFACE_BINDINGS).sort()).toEqual([...PBS_FREE_SURFACES].sort());
  });

  it("binds every PBS-free surface to its public source", () => {
    for (const surface of PBS_FREE_SURFACES) {
      const binding = SURFACE_BINDINGS[surface];
      for (const marker of binding.landmarks) {
        expect(binding.source, `${surface}: public landmark ${marker} missing`).toMatch(marker);
      }
    }
  });

  it("reads no PBS runtime state to render any PBS-free surface", () => {
    for (const surface of PBS_FREE_SURFACES) {
      for (const coupling of PBS_RUNTIME_COUPLINGS) {
        expect(
          SURFACE_BINDINGS[surface].source,
          `${surface} couples to PBS runtime via ${coupling}`,
        ).not.toMatch(coupling);
      }
    }
  });

  it("the coupling guard is live -- it flags a shell that did read PBS state", () => {
    // Prove the guard is not vacuously green: a shell that fetched a PBS schedule
    // to decide whether to render the nav must trip at least one marker. Without
    // this, the negative assertion above could pass because the marker list rotted,
    // not because the shell is clean.
    const coupledShell = [
      "---",
      'import { getScheduleAvailability } from "../lib/schedule-availability";',
      'const live = await fetch("https://tvss.pbs.org/api/...");',
      "---",
      '{live.ok && <nav class="primary" id="primary-nav" aria-label="Primary" />}',
    ].join("\n");
    expect(PBS_RUNTIME_COUPLINGS.some((c) => c.test(coupledShell))).toBe(true);
  });
});
