import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  assetToGateInput,
  evaluateMediaManagerGate,
  GATE_REASON,
  HLS_PROFILE_LADDER,
  type AssetVideoRendition,
  type MediaManagerGateAsset,
  type MediaManagerGateViewer,
  type ViewerTier,
} from "../src/lib/media-manager-gating";
import type { Entitlement } from "../src/lib/mvault-entitlement";

// These prove the credential-free Media Manager decision core (#449): given an
// already-fetched asset and a resolved viewer, decide render / deny / unavailable
// with a distinct machine reason, select the HLS rendition in PBS's documented
// streaming order (never a source mp4), and honor inclusive New Jersey
// calendar-day window bounds that match mvault-entitlement.ts so the two never
// disagree by a day. Pure: no clock, network, or DOM.

// 2026-07-09 14:00 ET (18:00Z): comfortably inside the 07-09 New Jersey day.
const NOW = new Date("2026-07-09T18:00:00Z");

const ENTITLED: Entitlement = { entitled: true, state: "active" };
const NOT_ENTITLED: Entitlement = { entitled: false, state: "expired" };

// A record the union forbids at compile time but a buggy MVault mapper could emit
// at runtime: the boolean and the state disagree. Built through `unknown` so the
// gate's runtime fail-closed check is exercised, not the type checker.
const inconsistent = (entitled: boolean, state: string): Entitlement =>
  ({ entitled, state }) as unknown as Entitlement;

// URS-protected HLS is the only thing that may play: PBS's player guidance
// requires the urs.pbs.org urls because they carry the rights, geo, and
// sponsorship enforcement a raw CDN manifest or source mp4 skips.
const HLS_1080: AssetVideoRendition = {
  profile: "hls-16x9-1080p",
  url: "https://urs.pbs.org/redirect/asset-1080/?format=m3u8",
};
const HLS_720: AssetVideoRendition = {
  profile: "hls-16x9-720p",
  url: "https://urs.pbs.org/redirect/asset-720/?format=m3u8",
};
const SOURCE_MP4: AssetVideoRendition = {
  profile: "mp4-16x9-source",
  url: "https://videos.example/asset-source.mp4",
};

const asset = (over: Partial<MediaManagerGateAsset> = {}): MediaManagerGateAsset => ({
  availabilities: { public: { start: null, end: null } },
  renditions: {
    public: [HLS_1080, HLS_720, SOURCE_MP4],
    all_members: [HLS_1080, HLS_720, SOURCE_MP4],
    station_members: [HLS_1080, HLS_720, SOURCE_MP4],
  },
  availabilityWindow: "public",
  playableWindow: "public",
  ...over,
});

const flatRenditionsMustNotCompile: MediaManagerGateAsset = {
  // @ts-expect-error Renditions must stay keyed to their availability window.
  renditions: [HLS_1080],
};
void flatRenditionsMustNotCompile;

const viewer = (
  tier: ViewerTier,
  entitlement: Entitlement = ENTITLED,
): MediaManagerGateViewer => ({ tier, entitlement });

// A tier the union forbids at compile time but the #209 adapter could produce at
// runtime from PIDS/Media Manager audience data. Built through `unknown` for the
// same reason as `inconsistent` above.
const unknownTierViewer = (tier: string): MediaManagerGateViewer =>
  ({ tier, entitlement: ENTITLED }) as unknown as MediaManagerGateViewer;

// The vendored PBS sample at
// The public API sample uses this resource id
// and these exact availability instants. That page's "Videos" section documents
// the audience-keyed `videos` shape; the URLs below are deterministic URS fixture
// paths so this test never performs network I/O.
const VENDORED_SAMPLE_RESOURCE = {
  type: "asset",
  id: "c27f7ba6-5e84-4940-ae92-635f83e36a55",
  attributes: {
    slug: "10-modern-marvels-that-changed-america-8veorc",
    availabilities: {
      public: {
        start: "2018-07-25T04:00:00Z",
        end: "2028-07-24T03:59:59Z",
        updated_at: "2020-03-27T08:24:53.675103Z",
      },
      all_members: {
        start: "2018-07-25T04:00:00Z",
        end: "2028-07-24T03:59:59Z",
      },
      station_members: {
        start: "2018-07-25T04:00:00Z",
        end: "2028-07-24T03:59:59Z",
      },
    },
    videos: {
      public: [
        {
          profile: "hls-16x9-720p",
          url: "https://urs.pbs.org/redirect/sample-public/?format=m3u8",
        },
      ],
      all_members: [
        {
          profile: "hls-16x9-1080p",
          url: "https://urs.pbs.org/redirect/sample-members/?format=m3u8",
        },
      ],
      station_members: [
        {
          profile: "hls-16x9-1080p",
          url: "https://urs.pbs.org/redirect/sample-station/?format=m3u8",
        },
      ],
    },
    availability_window: "public",
    playable_window: "public",
  },
};

describe("evaluateMediaManagerGate — acceptance criteria", () => {
  it("reports an upcoming window unavailable with a distinct reason", () => {
    const a = asset({ availabilities: { public: { start: "2026-08-01", end: null } } });
    expect(evaluateMediaManagerGate(a, viewer("public"), NOW)).toEqual({
      verdict: "unavailable",
      reason: GATE_REASON.beforeWindow,
      hls: null,
    });
  });

  it("reports an expired window unavailable with a distinct reason", () => {
    const a = asset({ availabilities: { public: { start: null, end: "2026-07-08" } } });
    expect(evaluateMediaManagerGate(a, viewer("public"), NOW)).toEqual({
      verdict: "unavailable",
      reason: GATE_REASON.afterWindow,
      hls: null,
    });
  });

  it("reports a missing resolved window as unavailable with its own reason", () => {
    // Media Manager resolved public, but the response does not carry that window.
    const a = asset({ availabilities: { station_members: { start: null, end: null } } });
    expect(evaluateMediaManagerGate(a, viewer("public"), NOW)).toEqual({
      verdict: "unavailable",
      reason: GATE_REASON.noWindow,
      hls: null,
    });
  });

  it("renders the 1080p URS HLS url when entitled and in window", () => {
    expect(evaluateMediaManagerGate(asset(), viewer("public"), NOW)).toEqual({
      verdict: "render",
      reason: GATE_REASON.playable,
      hls: HLS_1080.url,
    });
  });

  it("selects renditions only from the same availability window", () => {
    const publicHls: AssetVideoRendition = {
      profile: "hls-16x9-720p",
      url: "https://urs.pbs.org/redirect/public-window/?format=m3u8",
    };
    const stationHls: AssetVideoRendition = {
      profile: "hls-16x9-1080p",
      url: "https://urs.pbs.org/redirect/station-window/?format=m3u8",
    };
    const windowed = asset({
      availabilities: {
        public: { start: null, end: null },
        station_members: { start: null, end: null },
      },
      renditions: {
        public: [publicHls],
        station_members: [stationHls],
      },
    });

    expect(
      evaluateMediaManagerGate(windowed, viewer("public"), NOW).hls,
    ).toBe(publicHls.url);
    const stationWindowed = {
      ...windowed,
      availabilityWindow: "station_members" as const,
      playableWindow: "station_members" as const,
    };
    expect(
      evaluateMediaManagerGate(
        stationWindowed,
        viewer("station_members", ENTITLED),
        NOW,
      ).hls,
    ).toBe(stationHls.url);

    const publicRenditionMissing = asset({
      renditions: { station_members: [stationHls] },
    });
    expect(
      evaluateMediaManagerGate(
        publicRenditionMissing,
        viewer("public"),
        NOW,
      ),
    ).toEqual({
      verdict: "unavailable",
      reason: GATE_REASON.noHls,
      hls: null,
    });
  });

  it("falls back to the 720p url when only that HLS rendition is present", () => {
    const a = asset({ renditions: { public: [HLS_720, SOURCE_MP4] } });
    expect(evaluateMediaManagerGate(a, viewer("public"), NOW)).toMatchObject({
      verdict: "render",
      hls: HLS_720.url,
    });
  });

  it("reports unavailable when no URS HLS rendition exists, never a silent mp4", () => {
    const a = asset({ renditions: { public: [SOURCE_MP4] } });
    expect(evaluateMediaManagerGate(a, viewer("public"), NOW)).toEqual({
      verdict: "unavailable",
      reason: GATE_REASON.noHls,
      hls: null,
    });
  });

  it("never returns a source mp4 as hls, even under an hls profile", () => {
    // A 1080p entry whose url is actually an mp4 is rejected; the real 720p wins.
    const mislabeled: AssetVideoRendition = {
      profile: "hls-16x9-1080p",
      url: "https://urs.pbs.org/redirect/asset-source.mp4",
    };
    const a = asset({ renditions: { public: [mislabeled, HLS_720] } });
    const result = evaluateMediaManagerGate(a, viewer("public"), NOW);
    expect(result.hls).toBe(HLS_720.url);
    expect(result.hls?.endsWith(".mp4")).toBe(false);
  });

  it("plays a 4:3-only asset and a legacy-only asset (#714)", () => {
    // Before #714 both fell through to no-hls-rendition although PBS streams them.
    for (const profile of ["hls-4x3-720p", "hls-1200k-16x9", "ipad-4x3"]) {
      const only: AssetVideoRendition = {
        profile,
        url: `https://urs.pbs.org/redirect/${profile}/?format=m3u8`,
      };
      expect(
        evaluateMediaManagerGate(
          asset({ renditions: { public: [only, SOURCE_MP4] } }),
          viewer("public"),
          NOW,
        ),
      ).toEqual({ verdict: "render", reason: GATE_REASON.playable, hls: only.url });
    }
  });

  it("follows PBS's order across aspect ratios, not input order", () => {
    // PBS ranks every 16:9 profile, legacy ones included, above any 4:3 one.
    const current4x3: AssetVideoRendition = {
      profile: "hls-4x3-1080p",
      url: "https://urs.pbs.org/redirect/4x3-1080/?format=m3u8",
    };
    const legacy16x9: AssetVideoRendition = {
      profile: "hls-800k-16x9",
      url: "https://urs.pbs.org/redirect/16x9-800k/?format=m3u8",
    };
    const a = asset({ renditions: { public: [current4x3, legacy16x9] } });
    expect(evaluateMediaManagerGate(a, viewer("public"), NOW).hls).toBe(
      legacy16x9.url,
    );
  });

  it("does not select a DRM-only rendition", () => {
    const drm: AssetVideoRendition = {
      profile: "hls-16x9-1080p-drm",
      url: "https://urs.pbs.org/redirect/drm-1080/?format=m3u8",
    };
    expect(
      evaluateMediaManagerGate(
        asset({ renditions: { public: [drm] } }),
        viewer("public"),
        NOW,
      ),
    ).toEqual({ verdict: "unavailable", reason: GATE_REASON.noHls, hls: null });
  });

  it("keeps the ladder identical to PBS's documented streaming order", () => {
    // The ladder claims to be PBS's list verbatim. If PBS changes profiles and the
    // vendored doc is refreshed, this fails until the ladder follows it.
    const documented = JSON.parse(readFileSync(
      join(process.cwd(), "tests/fixtures/public-contracts/streaming-profiles.json"), "utf8",
    ));
    expect([...HLS_PROFILE_LADDER]).toEqual(documented);
  });

  it("rejects a non-URS HLS url, which would bypass rights and geo enforcement", () => {
    // A plausible CDN manifest: right profile, right extension, wrong host. URS is
    // where PBS enforces availability rights, geo restriction, and sponsorship, so
    // serving around it is the same leak the mp4 rejection exists to prevent.
    const cdn: AssetVideoRendition = {
      profile: "hls-16x9-1080p",
      url: "https://cdn.example/hls/asset-1080.m3u8",
    };
    const a = asset({ renditions: { public: [cdn, HLS_720] } });
    expect(evaluateMediaManagerGate(a, viewer("public"), NOW).hls).toBe(HLS_720.url);
  });

  it("rejects the three urls a substring host check would let through", () => {
    // Each defeats a different naive check: a suffix match on the lookalike
    // subdomain, an `includes` on the userinfo trick, and a host-only check that
    // forgets the scheme. Parsing rejects all three.
    const lookalike: AssetVideoRendition = {
      profile: "hls-16x9-1080p",
      url: "https://urs.pbs.org.evil.test/redirect/asset-1080/?format=m3u8",
    };
    const userinfo: AssetVideoRendition = {
      profile: "hls-16x9-1080p",
      url: "https://urs.pbs.org@evil.test/redirect/asset-1080/?format=m3u8",
    };
    const plaintext: AssetVideoRendition = {
      profile: "hls-16x9-720p",
      url: "http://urs.pbs.org/redirect/asset-720/?format=m3u8",
    };
    for (const bad of [lookalike, userinfo, plaintext]) {
      expect(
        evaluateMediaManagerGate(
          asset({ renditions: { public: [bad] } }),
          viewer("public"),
          NOW,
        ),
      ).toEqual({
        verdict: "unavailable",
        reason: GATE_REASON.nonUrsHls,
        hls: null,
      });
    }
  });

  it("rejects a source mp4 whose extension is hidden behind a query string", () => {
    // The shape the suffix check missed: right host, right profile, and the
    // `.mp4` is no longer the end of the string.
    for (const url of [
      "https://urs.pbs.org/redirect/asset-source.mp4?token=abc123",
      "https://urs.pbs.org/redirect/asset-source.mp4?format=m3u8",
    ]) {
      const signed: AssetVideoRendition = {
        profile: "hls-16x9-1080p",
        url,
      };
      expect(
        evaluateMediaManagerGate(
          asset({ renditions: { public: [signed] } }),
          viewer("public"),
          NOW,
        ),
      ).toEqual({
        verdict: "unavailable",
        reason: GATE_REASON.nonUrsHls,
        hls: null,
      });
    }
  });

  it("rejects a URS url that is not an HLS manifest", () => {
    // A trusted host and HLS profile are not enough: returning a DASH manifest
    // or opaque redirect as `hls` would hand the player an unusable stream.
    for (const url of [
      "https://urs.pbs.org/redirect/asset.mpd",
      "https://urs.pbs.org/redirect/asset",
    ]) {
      const mislabeled: AssetVideoRendition = {
        profile: "hls-16x9-1080p",
        url,
      };
      expect(
        evaluateMediaManagerGate(
          asset({ renditions: { public: [mislabeled] } }),
          viewer("public"),
          NOW,
        ),
      ).toEqual({
        verdict: "unavailable",
        reason: GATE_REASON.nonUrsHls,
        hls: null,
      });
    }
  });

  it("separates a refused rendition from no rendition at all", () => {
    // Same verdict, different tag: one says the host was rejected, the other says
    // the asset carries no HLS. A debugger chasing these looks in opposite places.
    const refused = asset({
      renditions: {
        public: [
          {
            profile: "hls-16x9-1080p",
            url: "https://cdn.example/hls/a.m3u8",
          },
        ],
      },
    });
    const absent = asset({ renditions: { public: [] } });
    expect(evaluateMediaManagerGate(refused, viewer("public"), NOW).reason).toBe(
      GATE_REASON.nonUrsHls,
    );
    expect(evaluateMediaManagerGate(absent, viewer("public"), NOW).reason).toBe(
      GATE_REASON.noHls,
    );
  });

  it("denies, never renders, a viewer in a member window who is not entitled", () => {
    const a = asset({
      availabilities: { all_members: { start: null, end: null } },
      availabilityWindow: "all_members",
      playableWindow: "all_members",
    });
    expect(
      evaluateMediaManagerGate(a, viewer("all_members", NOT_ENTITLED), NOW),
    ).toEqual({ verdict: "deny", reason: GATE_REASON.notEntitled, hls: null });
  });

  it("is pure: identical inputs yield identical output and are not mutated", () => {
    // Frozen so the purity claim is enforced, not just asserted: an accidental
    // write to the asset or viewer throws here instead of passing silently.
    const a = Object.freeze(asset());
    const v = Object.freeze(viewer("public"));
    const first = evaluateMediaManagerGate(a, v, NOW);
    const second = evaluateMediaManagerGate(a, v, new Date(NOW.getTime()));
    expect(second).toEqual(first);
  });
});

describe("evaluateMediaManagerGate — resolved window and entitlement", () => {
  it("renders a public window without consulting entitlement", () => {
    const a = asset({ availabilities: { public: { start: null, end: null } } });
    expect(
      evaluateMediaManagerGate(a, viewer("public", NOT_ENTITLED), NOW).verdict,
    ).toBe("render");
  });

  it("renders a station window for an entitled station member", () => {
    const a = asset({
      availabilities: { station_members: { start: null, end: null } },
      availabilityWindow: "station_members",
      playableWindow: "station_members",
    });
    expect(
      evaluateMediaManagerGate(a, viewer("station_members", ENTITLED), NOW).verdict,
    ).toBe("render");
  });

  it("uses availability_window for policy and playable_window for renditions", () => {
    // PBS documents valid responses where a member availability policy resolves
    // to the public videos bucket. The member window governs access, but the
    // public rendition is the only URL this response may return.
    const a = asset({
      availabilities: {
        public: { start: null, end: null },
        all_members: { start: null, end: null },
      },
      availabilityWindow: "all_members",
      playableWindow: "public",
      renditions: {
        public: [HLS_720],
        all_members: [HLS_1080],
      },
    });
    expect(
      evaluateMediaManagerGate(a, viewer("all_members", ENTITLED), NOW),
    ).toMatchObject({
      verdict: "render",
      reason: GATE_REASON.playable,
      hls: HLS_720.url,
    });
    expect(
      evaluateMediaManagerGate(
        a,
        viewer("all_members", NOT_ENTITLED),
        NOW,
      ),
    ).toMatchObject({
      verdict: "deny",
      reason: GATE_REASON.notEntitled,
    });
  });

  it("fails closed on an unknown tier instead of handing back the station window", () => {
    // A typoed or unmapped tier makes the tier-level lookup undefined, and every
    // ">" against undefined is false — so an unguarded walk would return the
    // most privileged window and, with an active entitlement, render it.
    const a = asset({
      availabilities: {
        public: { start: null, end: null },
        station_members: { start: null, end: null },
      },
    });
    expect(evaluateMediaManagerGate(a, unknownTierViewer("station-members"), NOW)).toEqual({
      verdict: "unavailable",
      reason: GATE_REASON.unreadableTier,
      hls: null,
    });
  });

  it("fails closed on a prototype-inherited key masquerading as a tier", () => {
    const a = asset({ availabilities: { public: { start: null, end: null } } });
    expect(
      evaluateMediaManagerGate(a, unknownTierViewer("toString"), NOW).reason,
    ).toBe(GATE_REASON.unreadableTier);
  });

  it("honors Media Manager's unavailable decision without local fallback", () => {
    const a = asset({
      availabilities: {
        public: { start: null, end: null },
        station_members: { start: null, end: null },
      },
      availabilityWindow: "unavailable",
      playableWindow: "unavailable",
    });
    expect(
      evaluateMediaManagerGate(a, viewer("all_members", ENTITLED), NOW).reason,
    ).toBe(GATE_REASON.noWindow);
  });

  it("fails closed when the resolved window exceeds the viewer tier", () => {
    const mismatched = asset({
      availabilities: {
        station_members: { start: null, end: null },
      },
      playableWindow: "station_members",
      renditions: { station_members: [HLS_1080] },
    });

    expect(
      evaluateMediaManagerGate(
        mismatched,
        viewer("all_members", ENTITLED),
        NOW,
      ),
    ).toEqual({
      verdict: "unavailable",
      reason: GATE_REASON.unreadablePlayableWindow,
      hls: null,
    });
  });

  it("prompts a lapsed station member in a member window rather than downgrading them", () => {
    const a = asset({
      availabilities: {
        public: { start: null, end: null },
        station_members: { start: null, end: null },
      },
      availabilityWindow: "station_members",
      playableWindow: "station_members",
    });
    expect(
      evaluateMediaManagerGate(a, viewer("station_members", NOT_ENTITLED), NOW),
    ).toMatchObject({ verdict: "deny", reason: GATE_REASON.notEntitled });
  });

  it("fails closed on an entitled:true record whose state does not stream, never leaking a gated stream", () => {
    // The exact MVault-mapper defect (#431): the boolean says entitled but the
    // state is a lapsed one. Deciding on the boolean alone would render a gated
    // stream to a lapsed member; the gate must fail closed instead.
    const a = asset({
      availabilities: { all_members: { start: null, end: null } },
      availabilityWindow: "all_members",
      playableWindow: "all_members",
    });
    expect(
      evaluateMediaManagerGate(a, viewer("all_members", inconsistent(true, "expired")), NOW),
    ).toEqual({ verdict: "unavailable", reason: GATE_REASON.unreadableEntitlement, hls: null });
  });

  it("fails closed on an entitled:false record whose state claims streaming", () => {
    // The other direction of the same defect: still a data problem on our side,
    // so unavailable rather than a spurious render or a renew prompt.
    const a = asset({
      availabilities: { all_members: { start: null, end: null } },
      availabilityWindow: "all_members",
      playableWindow: "all_members",
    });
    expect(
      evaluateMediaManagerGate(a, viewer("all_members", inconsistent(false, "active")), NOW),
    ).toMatchObject({ verdict: "unavailable", reason: GATE_REASON.unreadableEntitlement });
  });

  it("reports a malformed member entitlement unavailable, not a renew prompt", () => {
    // A malformed record is an unreadable data defect, not a lapsed membership, so
    // it must not tell a possibly-active member to renew over a backend or clock
    // problem. This is the same call member-gated-playback.ts makes for this state.
    const malformed: Entitlement = { entitled: false, state: "malformed" };
    const a = asset({
      availabilities: { all_members: { start: null, end: null } },
      availabilityWindow: "all_members",
      playableWindow: "all_members",
    });
    expect(
      evaluateMediaManagerGate(a, viewer("all_members", malformed), NOW),
    ).toEqual({ verdict: "unavailable", reason: GATE_REASON.unreadableEntitlement, hls: null });
  });
});

describe("evaluateMediaManagerGate — New Jersey calendar-day boundaries", () => {
  it("includes the start day itself", () => {
    const a = asset({ availabilities: { public: { start: "2026-07-09", end: null } } });
    expect(evaluateMediaManagerGate(a, viewer("public"), NOW).verdict).toBe("render");
  });

  it("includes the end day itself", () => {
    const a = asset({ availabilities: { public: { start: null, end: "2026-07-09" } } });
    expect(evaluateMediaManagerGate(a, viewer("public"), NOW).verdict).toBe("render");
  });

  it("holds the end day open through the whole New Jersey day, not UTC midnight", () => {
    // 2026-07-10T01:00Z is 2026-07-09 21:00 ET: still inside a window ending 07-09.
    const lateEt = new Date("2026-07-10T01:00:00Z");
    const a = asset({ availabilities: { public: { start: null, end: "2026-07-09" } } });
    expect(evaluateMediaManagerGate(a, viewer("public"), lateEt).verdict).toBe("render");
  });

  it("treats null bounds as open on either side", () => {
    const a = asset({ availabilities: { public: { start: null, end: null } } });
    expect(evaluateMediaManagerGate(a, viewer("public"), NOW).verdict).toBe("render");
  });

  it("holds a time-bearing start closed until the instant itself, not since midnight", () => {
    // 20:00Z is two hours after NOW on the same New Jersey day. Reducing this bound
    // to its ET day would open the premiere from midnight ET; it must not.
    const a = asset({
      availabilities: { public: { start: "2026-07-09T20:00:00Z", end: null } },
    });
    expect(evaluateMediaManagerGate(a, viewer("public"), NOW)).toMatchObject({
      verdict: "unavailable",
      reason: GATE_REASON.beforeWindow,
    });
  });

  it("closes a time-bearing end at the instant itself, not at the day rollover", () => {
    // 17:00Z is an hour before NOW on the same ET day: expired, not still playable.
    const a = asset({
      availabilities: { public: { start: null, end: "2026-07-09T17:00:00Z" } },
    });
    expect(evaluateMediaManagerGate(a, viewer("public"), NOW)).toMatchObject({
      verdict: "unavailable",
      reason: GATE_REASON.afterWindow,
    });
  });

  it("treats time-bearing bounds as inclusive of their own instant", () => {
    const a = asset({
      availabilities: {
        public: { start: "2026-07-09T18:00:00Z", end: "2026-07-09T18:00:00Z" },
      },
    });
    expect(evaluateMediaManagerGate(a, viewer("public"), NOW).verdict).toBe("render");
  });

  it("renders inside a time-bearing window, the form the Media Manager docs show", () => {
    const a = asset({
      availabilities: {
        public: { start: "2018-07-25T04:00:00Z", end: "2028-07-24T03:59:59Z" },
      },
    });
    expect(evaluateMediaManagerGate(a, viewer("public"), NOW).verdict).toBe("render");
  });

  it("fails closed on an availability entry that is not a window object", () => {
    // A string or array where {start, end} belongs reads both bounds as
    // undefined, which would otherwise be an open window and a playable stream.
    for (const broken of ["2026-07-09", [], 42]) {
      const a = asset({
        availabilities: { public: broken } as never,
      });
      expect(evaluateMediaManagerGate(a, viewer("public"), NOW).reason).toBe(
        GATE_REASON.noWindow,
      );
    }
  });

  it("fails closed on an unparseable window bound", () => {
    for (const start of ["not-a-date", "", "   "]) {
      const a = asset({
        availabilities: { public: { start, end: null } },
      });
      expect(evaluateMediaManagerGate(a, viewer("public"), NOW)).toMatchObject({
        verdict: "unavailable",
        reason: GATE_REASON.unreadableWindow,
      });
    }
  });

  it("fails closed on an unreadable clock", () => {
    expect(
      evaluateMediaManagerGate(asset(), viewer("public"), new Date("nonsense")),
    ).toMatchObject({ verdict: "unavailable", reason: GATE_REASON.unreadableClock });
  });
});

describe("assetToGateInput", () => {
  it("maps the vendored PBS asset shape without flattening windowed videos", () => {
    const before = JSON.stringify(VENDORED_SAMPLE_RESOURCE);
    const mapped = assetToGateInput(VENDORED_SAMPLE_RESOURCE);

    expect(mapped).toEqual({
      availabilities: {
        public: {
          start: "2018-07-25T04:00:00Z",
          end: "2028-07-24T03:59:59Z",
        },
        all_members: {
          start: "2018-07-25T04:00:00Z",
          end: "2028-07-24T03:59:59Z",
        },
        station_members: {
          start: "2018-07-25T04:00:00Z",
          end: "2028-07-24T03:59:59Z",
        },
      },
      renditions: VENDORED_SAMPLE_RESOURCE.attributes.videos,
      availabilityWindow: "public",
      playableWindow: "public",
    });
    expect(JSON.stringify(VENDORED_SAMPLE_RESOURCE)).toBe(before);

    expect(
      evaluateMediaManagerGate(mapped, viewer("public"), NOW),
    ).toMatchObject({
      verdict: "render",
      hls: "https://urs.pbs.org/redirect/sample-public/?format=m3u8",
    });
    expect(
      evaluateMediaManagerGate(
        mapped,
        viewer("station_members", ENTITLED),
        NOW,
      ),
    ).toMatchObject({
      verdict: "render",
      hls: "https://urs.pbs.org/redirect/sample-public/?format=m3u8",
    });
  });

  it("drops malformed JSON fields so the gate fails closed", () => {
    const mapped = assetToGateInput({
      attributes: {
        availability_window: "public",
        playable_window: "public",
        availabilities: { public: "not-a-window" },
        videos: {
          public: "not-a-list",
          station_members: [
            {
              profile: "hls-16x9-1080p",
              url: "https://urs.pbs.org/redirect/station/?format=m3u8",
            },
          ],
        },
      },
    });

    expect(
      evaluateMediaManagerGate(mapped, viewer("public"), NOW),
    ).toEqual({
      verdict: "unavailable",
      reason: GATE_REASON.noWindow,
      hls: null,
    });
  });

  it("does not turn an availability object without bounds into an open window", () => {
    for (const malformedWindow of [
      { updated_at: "2026-07-09T18:00:00Z" },
      { start: undefined },
    ]) {
      const mapped = assetToGateInput({
        attributes: {
          availability_window: "public",
          playable_window: "public",
          availabilities: { public: malformedWindow },
          videos: { public: [HLS_1080] },
        },
      });

      expect(
        evaluateMediaManagerGate(mapped, viewer("public"), NOW),
      ).toEqual({
        verdict: "unavailable",
        reason: GATE_REASON.noWindow,
        hls: null,
      });
    }
  });

  it("maps only documented resolved-window values and fails closed otherwise", () => {
    const station = assetToGateInput({
      attributes: {
        availability_window: "station_members",
        playable_window: "station_members",
        availabilities: {
          station_members: { start: null, end: null },
        },
        videos: {
          station_members: [
            {
              profile: "hls-16x9-1080p",
              url: "https://urs.pbs.org/station.m3u8",
            },
          ],
        },
      },
    });
    expect(
      evaluateMediaManagerGate(
        station,
        viewer("station_members", ENTITLED),
        NOW,
      ),
    ).toMatchObject({
      verdict: "render",
      hls: "https://urs.pbs.org/station.m3u8",
    });

    for (const playableWindow of [undefined, "members", null]) {
      const malformed = assetToGateInput({
        attributes: {
          availability_window: "public",
          playable_window: playableWindow,
          availabilities: { public: { start: null, end: null } },
          videos: { public: [HLS_1080] },
        },
      });
      expect(
        evaluateMediaManagerGate(malformed, viewer("public"), NOW),
      ).toEqual({
        verdict: "unavailable",
        reason: GATE_REASON.unreadablePlayableWindow,
        hls: null,
      });
    }

    for (const availabilityWindow of [undefined, "members", null]) {
      const malformed = assetToGateInput({
        attributes: {
          availability_window: availabilityWindow,
          playable_window: "public",
          availabilities: { public: { start: null, end: null } },
          videos: { public: [HLS_1080] },
        },
      });
      expect(
        evaluateMediaManagerGate(malformed, viewer("public"), NOW),
      ).toEqual({
        verdict: "unavailable",
        reason: GATE_REASON.unreadableAvailabilityWindow,
        hls: null,
      });
    }
  });
});
