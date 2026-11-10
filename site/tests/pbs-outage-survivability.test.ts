// Pins the two claims docs/research/pbs-degradation-fallback-contract.md rests on
// but never tested: surfaces degrade independently, and the PBS-free editorial
// shell survives a total PBS outage (#189). No network, no DOM, no clock.

import { describe, it, expect } from "vitest";

import {
  assessOutage,
  surfaceOutcome,
  PBS_BACKED_SURFACES,
  PBS_FREE_SURFACES,
  SURFACES_WITH_FALLBACK,
  SURFACES_WITH_WIRED_FALLBACK,
  SURFACES_WITH_POLICY_ONLY_FALLBACK,
  type PageOutage,
  type PbsSurface,
} from "../src/lib/pbs-outage-survivability";

const ALL_SURFACES: PbsSurface[] = [...PBS_BACKED_SURFACES, ...PBS_FREE_SURFACES];

/** The surfaces whose outcome differs between two assessments, for independence. */
function surfacesThatDiffer(a: PageOutage, b: PageOutage): PbsSurface[] {
  return ALL_SURFACES.filter((s) => {
    const x = a.surfaces[s];
    const y = b.surfaces[s];
    return x.usable !== y.usable || x.degraded !== y.degraded;
  });
}

describe("PBS outage survivability: the editorial shell outlives any PBS failure (issue #189)", () => {
  it("no outage: every surface is live and usable, nothing degraded", () => {
    const page = assessOutage(new Set());
    for (const s of ALL_SURFACES) {
      expect(page.surfaces[s]).toEqual({ usable: true, degraded: false });
    }
    expect(page.editorialShellUsable).toBe(true);
    expect(page.noSurfaceBroken).toBe(true);
    // Nothing is failing, so no surface is leaning on a fallback of either kind.
    expect(page.surfacesAwaitingWiring).toEqual([]);
  });

  it("full lapse at handoff: the editorial shell survives, and the model names the surfaces that do not", () => {
    // The contract's worst case (failure mode "full lapse at handoff"): every PBS
    // surface falls away together. #189's acceptance criterion 1 is that the site
    // still serves editorial content, navigation, and the donate path -- the
    // editorial shell -- which must hold even though not every PBS surface has a
    // built fallback yet.
    const page = assessOutage(new Set(PBS_BACKED_SURFACES));

    // The shell survives: editorial content, navigation, and the give landing page
    // are PBS-free, so a full outage cannot touch them.
    expect(page.editorialShellUsable).toBe(true);
    for (const s of PBS_FREE_SURFACES) {
      expect(page.surfaces[s]).toEqual({ usable: true, degraded: false });
    }
    // The surfaces with a built fallback degrade to it -- usable, not broken.
    for (const s of SURFACES_WITH_FALLBACK) {
      expect(page.surfaces[s]).toEqual({ usable: true, degraded: true });
    }
    // Usable is not the same as visible. Two of those fallbacks are policy cores
    // that no component renders yet, and the model says which, so this verdict
    // cannot be read as production coverage it does not have (#432).
    // Written out by hand, not derived: comparing against
    // SURFACES_WITH_POLICY_ONLY_FALLBACK would reduce to POLICY intersect BACKED
    // === POLICY and stay green while production coverage shrank. Unsorted, so it
    // also pins the taxonomy order the field documents.
    expect(page.surfacesAwaitingWiring).toEqual([
      "nowNextStrip",
      "memberGatedPlayback",
    ]);
    // The one PBS-backed surface still without a built fallback is broken -- the
    // contract's one remaining coverage gap: the PBS-hosted donate transaction,
    // which has no CCM-hosted fallback donation path.
    expect(page.noSurfaceBroken).toBe(false);
    const broken = ALL_SURFACES.filter((s) => !page.surfaces[s].usable);
    expect(broken.slice().sort()).toEqual(["donateTransaction"]);
    expect(page.surfaces.donateTransaction).toEqual({ usable: false, degraded: true });
  });

  it("a wired fallback is never reported as awaiting wiring, however it fails", () => {
    // Each wired surface failing on its own: it degrades to a fallback a visitor
    // can see, so nothing is deferred and the list stays empty.
    for (const s of SURFACES_WITH_WIRED_FALLBACK) {
      const page = assessOutage(new Set([s]));
      expect(page.surfaces[s]).toEqual({ usable: true, degraded: true });
      expect(page.surfacesAwaitingWiring).toEqual([]);
    }
    // Each policy surface failing on its own names itself, and only itself. This
    // is the state #432 exists to separate, so pin the pair rather than the field
    // alone: noSurfaceBroken reads all-clear while a visitor still sees a dead
    // surface, and only surfacesAwaitingWiring tells the two apart.
    for (const s of SURFACES_WITH_POLICY_ONLY_FALLBACK) {
      const page = assessOutage(new Set([s]));
      expect(page.noSurfaceBroken).toBe(true);
      expect(page.surfacesAwaitingWiring).toEqual([s]);
    }
  });

  it("fallback coverage is explicit: only donateTransaction lacks a built fallback", () => {
    // The shell's survival does not depend on this, but which PBS surfaces still
    // break in a full outage does. Pin the coverage so shipping a fallback (moving
    // a surface into SURFACES_WITH_FALLBACK) or regressing one is a deliberate test
    // change, not a silent drift. member-gated playback moved into coverage with
    // its degradation policy, leaving the PBS-hosted donate transaction as the one
    // remaining gap the contract names.
    const covered = new Set<PbsSurface>(SURFACES_WITH_FALLBACK);
    const uncovered = PBS_BACKED_SURFACES.filter((s) => !covered.has(s));
    expect(uncovered.slice().sort()).toEqual(["donateTransaction"]);
  });

  it("wired and policy-ready fallbacks partition the coverage list exactly", () => {
    // SURFACES_WITH_FALLBACK is derived from the two, so this cannot drift while
    // they are the only source. It is pinned anyway because the pair is the whole
    // point of #432: a surface counted as covered has to declare which kind of
    // fallback it has, and wiring one up is a deliberate move between the lists
    // rather than an edit nobody reviews.
    // Written out by hand, not derived from each other: a self-comparison would
    // stay green while a surface moved between the lists, which is precisely the
    // change that alters what the model claims a visitor gets.
    expect([...SURFACES_WITH_WIRED_FALLBACK].sort()).toEqual([
      "livestreamPlayer",
      "scheduleGrid",
      "vodLaunchCards",
    ]);
    expect([...SURFACES_WITH_POLICY_ONLY_FALLBACK].sort()).toEqual([
      "memberGatedPlayback",
      "nowNextStrip",
    ]);

    // The union is derived, so it cannot disagree; a surface listed in both would
    // survive that derivation as a duplicate, and this is what catches it.
    const policy = new Set<PbsSurface>(SURFACES_WITH_POLICY_ONLY_FALLBACK);
    expect(SURFACES_WITH_WIRED_FALLBACK.filter((s) => policy.has(s))).toEqual([]);
    // Both kinds are real coverage: every one is PBS-backed and none is the gap.
    for (const s of SURFACES_WITH_FALLBACK) {
      expect(PBS_BACKED_SURFACES).toContain(s);
    }
  });

  it("surfaceOutcome derives usability from fallback coverage, so a fallback-less surface breaks", () => {
    // Prove usable is derived, not hardcoded, by exercising the decision directly
    // -- including the broken case (backed, failing, no fallback) that the current
    // taxonomy never produces, so it cannot be reached through assessOutage alone.
    // A live backed surface is usable regardless of its fallback status.
    expect(surfaceOutcome(true, false, false)).toEqual({ usable: true, degraded: false });
    // Failing with a declared fallback: degraded but usable.
    expect(surfaceOutcome(true, true, true)).toEqual({ usable: true, degraded: true });
    // Failing with no fallback: broken -- the branch the coverage test protects.
    // This assertion fails if the model stops consulting fallback coverage and
    // marks every failed surface usable.
    expect(surfaceOutcome(true, true, false)).toEqual({ usable: false, degraded: true });
    // A PBS-free surface is always usable and never degraded, whatever the flags.
    expect(surfaceOutcome(false, false, false)).toEqual({ usable: true, degraded: false });
    expect(surfaceOutcome(false, true, false)).toEqual({ usable: true, degraded: false });
  });

  it("surfaces degrade independently: flipping any one surface changes only its own outcome", () => {
    // The contract holds "only if every surface above degrades independently".
    // Flip each surface into failure ALONE and assert nothing else moves -- so a
    // coupling between any pair (a shared error boundary that blanks the page, a
    // fallback that reads a sibling's status) fails here instead of shipping.
    // Exhaustive over all eight, not a two-surface sample.
    const base = assessOutage(new Set());
    for (const s of ALL_SURFACES) {
      const diff = surfacesThatDiffer(assessOutage(new Set([s])), base);
      // A PBS-free surface flips nothing (it has no PBS call to fail); a
      // PBS-backed one flips only itself. Never a sibling, either way.
      expect(diff).toEqual((PBS_BACKED_SURFACES as readonly PbsSurface[]).includes(s) ? [s] : []);
    }
  });

  it("the editorial shell is decided without reading any PBS state", () => {
    // The membership-lapse boundary, proven not asserted: instrument the failing
    // set so every membership test is recorded, then confirm assessOutage only
    // ever asks about PBS-backed surfaces -- never editorial content, navigation,
    // or the give landing page. The shell's survival cannot depend on a value it
    // never reads.
    const queried: PbsSurface[] = [];
    const inner = new Set<PbsSurface>(PBS_BACKED_SURFACES);
    const probe = {
      has(v: PbsSurface) {
        queried.push(v);
        return inner.has(v);
      },
    } as unknown as ReadonlySet<PbsSurface>;

    const page = assessOutage(probe);

    // Not one PBS-free surface was consulted on the outage set.
    for (const s of PBS_FREE_SURFACES) {
      expect(queried).not.toContain(s);
    }
    // And the shell's outcome is identical whether nothing or everything is down.
    const down = assessOutage(new Set(PBS_BACKED_SURFACES));
    const up = assessOutage(new Set());
    for (const s of PBS_FREE_SURFACES) {
      expect(page.surfaces[s]).toEqual(up.surfaces[s]);
      expect(down.surfaces[s]).toEqual(up.surfaces[s]);
    }
  });

  it("a bad caller set cannot revoke the shell: a PBS-free surface is never marked degraded", () => {
    // Even if a caller wrongly lists editorial content or the give landing page as
    // failing, the taxonomy wins: those surfaces have no PBS call, so they stay
    // usable and undegraded.
    const page = assessOutage(new Set(ALL_SURFACES));
    for (const s of PBS_FREE_SURFACES) {
      expect(page.surfaces[s]).toEqual({ usable: true, degraded: false });
    }
    expect(page.editorialShellUsable).toBe(true);
  });

  it("the taxonomy partitions every surface exactly once, with no gaps or overlaps", () => {
    // An expected list written out by hand, NOT derived from the module's arrays,
    // so a surface dropped from a classification list shows up as a mismatch here
    // rather than passing a self-comparison.
    const EXPECTED: PbsSurface[] = [
      "livestreamPlayer",
      "scheduleGrid",
      "nowNextStrip",
      "vodLaunchCards",
      "memberGatedPlayback",
      "donateTransaction",
      "editorialContent",
      "navigation",
      "giveLandingPage",
    ];
    expect([...ALL_SURFACES].sort()).toEqual([...EXPECTED].sort());
    // No surface is both PBS-backed and PBS-free.
    const overlap = PBS_BACKED_SURFACES.filter((s) =>
      (PBS_FREE_SURFACES as readonly PbsSurface[]).includes(s),
    );
    expect(overlap).toEqual([]);

    // Compile-time partition guard: `never` means every PbsSurface is classified
    // as backed or free. Add a ninth surface to the union without listing it and
    // this resolves away from `never`, so the assignment stops compiling -- a new
    // surface cannot be silently dropped from an outage assessment.
    type Unclassified = Exclude<
      PbsSurface,
      (typeof PBS_BACKED_SURFACES)[number] | (typeof PBS_FREE_SURFACES)[number]
    >;
    const everySurfaceClassified: [Unclassified] extends [never] ? true : false = true;
    expect(everySurfaceClassified).toBe(true);
  });
});
