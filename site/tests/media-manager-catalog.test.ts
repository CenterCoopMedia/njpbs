import { describe, it, expect } from "vitest";
import {
  buildProgram,
  episodePlayback,
  extractPartnerPlayerSrc,
  isPubliclyAvailable,
  selectPublicFullLengthAsset,
  type AssetAttributes,
  type MediaManagerRecord,
  type RawShow,
} from "../src/lib/media-manager-catalog";

// Synthetic fixtures. These model the verified Media Manager JSON:API shape
// (data[].attributes, Show -> Season -> Episode -> Asset) documented in
// docs/research/pbs-integrations-technical.md; they are NOT captured from the
// live API, since the build-time key does not exist yet. They exercise the
// transform's contract, not real catalog data.

function asset(
  id: string,
  attributes: AssetAttributes,
): MediaManagerRecord<AssetAttributes> {
  return { id, type: "asset", attributes };
}

const PUBLIC_FULL_LENGTH = asset("a1", {
  object_type: "full_length",
  availabilities: { public: { start: null, end: null } },
  player_code:
    '<iframe src="https://player.pbs.org/partnerplayer/ix6DN99Ppzn3ntnxghoZbw==/?start=0&end=0"></iframe>',
  captions: [{ url: "https://captions.example/a1-en.vtt", language: "en" }],
  transcripts: [{ url: "https://transcripts.example/a1.txt" }],
});

const MEMBER_ONLY_FULL_LENGTH = asset("a2", {
  object_type: "full_length",
  availabilities: { all_members: { start: null, end: null } },
  player_code:
    '<iframe src="https://player.pbs.org/partnerplayer/MEMBERONLYTOKEN==/?start=0&end=0"></iframe>',
});

const PUBLIC_CLIP = asset("a3", {
  object_type: "clip",
  availabilities: { public: { start: null, end: null } },
});

const showFixture: RawShow = {
  show: {
    id: "show-1",
    type: "show",
    attributes: {
      title: "River stories",
      slug: "river-stories",
      description_short: "Short docs about New Jersey waterways.",
      genre: { title: "Documentary", slug: "documentary" },
    },
  },
  seasons: [
    {
      season: { id: "s1", type: "season", attributes: { ordinal: 1 } },
      episodes: [
        {
          episode: {
            id: "e1",
            type: "episode",
            attributes: {
              title: "The Passaic",
              slug: "the-passaic",
              description_short: "Tracing the Passaic river.",
              premiered_on: "2026-01-14",
              ordinal: 1,
            },
          },
          assets: [PUBLIC_FULL_LENGTH],
        },
        {
          // Member-only episode: its only full-length asset is gated, so the
          // static build must not bake a player or claim captions for it.
          episode: {
            id: "e2",
            type: "episode",
            attributes: { title: "The Raritan", slug: "the-raritan", ordinal: 2 },
          },
          assets: [MEMBER_ONLY_FULL_LENGTH],
        },
      ],
    },
    {
      season: { id: "s2", type: "season", attributes: { ordinal: 2 } },
      episodes: [
        {
          // Episode without a slug cannot be routed and is dropped.
          episode: { id: "e3", type: "episode", attributes: { title: "No slug" } },
          assets: [PUBLIC_FULL_LENGTH],
        },
      ],
    },
  ],
};

describe("extractPartnerPlayerSrc", () => {
  it("pulls the full player src, preserving the flags PBS set", () => {
    expect(
      extractPartnerPlayerSrc(
        '<iframe src="https://player.pbs.org/partnerplayer/ABC==/?start=0&end=0&topbar=false&endscreen=false"></iframe>',
      ),
    ).toBe("https://player.pbs.org/partnerplayer/ABC==/?start=0&end=0&topbar=false&endscreen=false");
  });

  it("returns null when there is no player src", () => {
    expect(extractPartnerPlayerSrc("<p>no player</p>")).toBeNull();
    expect(extractPartnerPlayerSrc(null)).toBeNull();
  });
});

describe("public availability gating", () => {
  it("treats an asset with a public window as public", () => {
    expect(isPubliclyAvailable(PUBLIC_FULL_LENGTH)).toBe(true);
  });

  it("treats a member-only asset as not public", () => {
    expect(isPubliclyAvailable(MEMBER_ONLY_FULL_LENGTH)).toBe(false);
  });

  it("treats an explicitly null public window as not public", () => {
    expect(
      isPubliclyAvailable(asset("a0", { availabilities: { public: null } })),
    ).toBe(false);
  });

  it("selects the public full-length asset and skips clips and member-only assets", () => {
    expect(selectPublicFullLengthAsset([PUBLIC_CLIP, PUBLIC_FULL_LENGTH])?.id).toBe("a1");
    expect(selectPublicFullLengthAsset([MEMBER_ONLY_FULL_LENGTH])).toBeNull();
    expect(selectPublicFullLengthAsset([PUBLIC_CLIP])).toBeNull();
  });
});

describe("episodePlayback", () => {
  it("verifies caption presence from the actual files rather than assuming it", () => {
    const playback = episodePlayback(PUBLIC_FULL_LENGTH);
    expect(playback.hasCaptions).toBe(true);
    expect(playback.captions).toEqual([
      { url: "https://captions.example/a1-en.vtt", language: "en" },
    ]);
    expect(playback.transcripts).toEqual([{ url: "https://transcripts.example/a1.txt" }]);
  });

  it("bakes the exact player src PBS returned, preserving its flags", () => {
    const configured = asset("a5", {
      object_type: "full_length",
      availabilities: { public: { start: null, end: null } },
      player_code:
        '<iframe src="https://player.pbs.org/partnerplayer/ABC==/?start=0&end=0&topbar=false&autoplay=false&muted=false&endscreen=false"></iframe>',
    });
    expect(episodePlayback(configured).partnerPlayerSrc).toBe(
      "https://player.pbs.org/partnerplayer/ABC==/?start=0&end=0&topbar=false&autoplay=false&muted=false&endscreen=false",
    );
  });

  it("does not fabricate a language for an unlabeled caption track", () => {
    const unlabeled = asset("a6", {
      object_type: "full_length",
      availabilities: { public: { start: null, end: null } },
      captions: [{ url: "https://captions.example/a6.vtt" }],
    });
    expect(episodePlayback(unlabeled).captions).toEqual([
      { url: "https://captions.example/a6.vtt", language: null },
    ]);
  });

  it("reports no captions and no player when there is no public asset", () => {
    const playback = episodePlayback(null);
    expect(playback).toEqual({
      partnerPlayerSrc: null,
      hasCaptions: false,
      captions: [],
      transcripts: [],
    });
  });
});

describe("caption and transcript schema tolerance", () => {
  // The documented Media Manager asset shape is not fully pinned down (the
  // closed-captioning API page is a stub, and the repo research notes disagree on
  // captions vs captions_language and transcript vs transcripts), so the
  // transform reads every documented field and tolerates object-or-array without
  // throwing.
  it("prefers captions_language, which carries the real language codes", () => {
    const asset6 = asset("a7", {
      object_type: "full_length",
      availabilities: { public: { start: null, end: null } },
      captions_language: [
        { url: "https://captions.example/es.vtt", language: "es", primary: true },
        { url: "https://captions.example/en.vtt", language: "en" },
      ],
      captions: [{ url: "https://captions.example/ignored.vtt", language: "en" }],
    });
    expect(episodePlayback(asset6).captions).toEqual([
      { url: "https://captions.example/es.vtt", language: "es" },
      { url: "https://captions.example/en.vtt", language: "en" },
    ]);
  });

  it("accepts a singular transcript as well as a transcripts array", () => {
    const singular = asset("a8", {
      object_type: "full_length",
      availabilities: { public: { start: null, end: null } },
      transcript: { url: "https://transcripts.example/single.txt" },
    });
    expect(episodePlayback(singular).transcripts).toEqual([
      { url: "https://transcripts.example/single.txt" },
    ]);
  });

  it("tolerates a single caption object instead of an array without throwing", () => {
    const objectShaped = asset("a9", {
      object_type: "full_length",
      availabilities: { public: { start: null, end: null } },
      captions: { url: "https://captions.example/one.vtt", language: "en" },
      transcript: "https://transcripts.example/bare.txt",
    });
    const playback = episodePlayback(objectShaped);
    expect(playback.captions).toEqual([
      { url: "https://captions.example/one.vtt", language: "en" },
    ]);
    expect(playback.transcripts).toEqual([{ url: "https://transcripts.example/bare.txt" }]);
  });
});

describe("buildProgram", () => {
  const program = buildProgram(showFixture);

  it("carries the show metadata the static page renders", () => {
    expect(program.slug).toBe("river-stories");
    expect(program.title).toBe("River stories");
    expect(program.genre).toBe("Documentary");
  });

  it("keeps only routable episodes and stamps each with its season number", () => {
    // e3 (no slug) is dropped; e1 and e2 survive.
    expect(program.episodes.map((episode) => episode.id)).toEqual(["e1", "e2"]);
    expect(program.episodes[0]).toMatchObject({
      slug: "the-passaic",
      seasonNumber: 1,
      episodeNumber: 1,
      premieredOn: "2026-01-14",
    });
  });

  it("bakes a public player but leaves member-only episodes without one", () => {
    const [passaic, raritan] = program.episodes;
    expect(passaic.playback.partnerPlayerSrc).not.toBeNull();
    expect(passaic.playback.hasCaptions).toBe(true);
    // e2's only full-length asset is member-gated: no player, no caption claim.
    expect(raritan.playback.partnerPlayerSrc).toBeNull();
    expect(raritan.playback.hasCaptions).toBe(false);
  });

  it("keeps the numbering when Media Manager sends ordinals as numeric strings", () => {
    const stringOrdinals = buildProgram({
      show: { id: "show-2", type: "show", attributes: { title: "Strings", slug: "strings" } },
      seasons: [
        {
          season: { id: "s1", type: "season", attributes: { ordinal: "3" } },
          episodes: [
            {
              episode: {
                id: "e1",
                type: "episode",
                attributes: { title: "Ep", slug: "ep", ordinal: "7" },
              },
              assets: [],
            },
          ],
        },
      ],
    });
    expect(stringOrdinals.episodes[0]).toMatchObject({ seasonNumber: 3, episodeNumber: 7 });
  });
});

describe("buildProgram with specials", () => {
  // A special holds its own assets and has no season, so it bakes as a
  // seasonless episode. Several WNJT shows have specials and no seasons.
  const specialsOnly: RawShow = {
    show: { id: "show-3", type: "show", attributes: { title: "One-on-One", slug: "one-on-one" } },
    seasons: [],
    specials: [
      {
        special: {
          id: "sp1",
          type: "special",
          attributes: {
            title: "A conversation on transit",
            slug: "a-conversation-on-transit",
            description_short: "A one-on-one interview.",
            premiered_on: "2026-03-02",
          },
        },
        assets: [PUBLIC_CLIP, PUBLIC_FULL_LENGTH],
      },
      {
        special: {
          id: "sp2",
          type: "special",
          attributes: { title: "Members first", slug: "members-first" },
        },
        assets: [MEMBER_ONLY_FULL_LENGTH],
      },
      {
        // A special without a slug cannot be routed and is dropped.
        special: { id: "sp3", type: "special", attributes: { title: "No slug" } },
        assets: [PUBLIC_FULL_LENGTH],
      },
    ],
  };

  it("builds a specials-only show into a routable catalog", () => {
    const program = buildProgram(specialsOnly);
    expect(program.episodes.map((episode) => episode.id)).toEqual(["sp1", "sp2"]);
    expect(program.episodes[0]).toMatchObject({
      slug: "a-conversation-on-transit",
      title: "A conversation on transit",
      description: "A one-on-one interview.",
      seasonNumber: null,
      episodeNumber: null,
      premieredOn: "2026-03-02",
    });
  });

  it("bakes a special's public full-length player and gates a member-only one", () => {
    const [publicSpecial, memberSpecial] = buildProgram(specialsOnly).episodes;
    expect(publicSpecial.playback.partnerPlayerSrc).toBe(
      "https://player.pbs.org/partnerplayer/ix6DN99Ppzn3ntnxghoZbw==/?start=0&end=0",
    );
    expect(publicSpecial.playback.hasCaptions).toBe(true);
    expect(memberSpecial.playback).toEqual({
      partnerPlayerSrc: null,
      hasCaptions: false,
      captions: [],
      transcripts: [],
    });
  });

  it("lists season episodes first, then specials", () => {
    const mixed = buildProgram({ ...showFixture, specials: specialsOnly.specials });
    expect(mixed.episodes.map((episode) => [episode.id, episode.seasonNumber])).toEqual([
      ["e1", 1],
      ["e2", 1],
      ["sp1", null],
      ["sp2", null],
    ]);
  });
});
