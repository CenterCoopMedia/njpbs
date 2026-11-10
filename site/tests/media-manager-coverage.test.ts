import { describe, it, expect } from "vitest";

import {
  summarizeMediaCoverage,
  formatMediaCoverageWarning,
  reportMediaCoverage,
} from "../src/lib/media-manager-coverage";
import type {
  CatalogEpisode,
  CatalogProgram,
} from "../src/lib/media-manager-catalog";

// Fixtures are CatalogProgram view models (the transform's output), built
// directly so these tests exercise the coverage layer in isolation from the
// raw-record transform, which media-manager-catalog.test.ts already covers. The
// signals that matter here are partnerPlayerSrc (is it publicly playable),
// hasCaptions (is a verified caption file present), and the transcripts list.

function episode(
  id: string,
  opts: { public: boolean; captioned: boolean; transcribed: boolean },
): CatalogEpisode {
  return {
    id,
    slug: `ep-${id}`,
    title: `Episode ${id}`,
    description: "",
    seasonNumber: 1,
    episodeNumber: 1,
    premieredOn: null,
    playback: {
      partnerPlayerSrc: opts.public
        ? `https://player.pbs.org/partnerplayer/${id}/`
        : null,
      hasCaptions: opts.captioned,
      captions: opts.captioned
        ? [{ url: `https://captions.example/${id}.vtt`, language: "en" }]
        : [],
      transcripts: opts.transcribed
        ? [{ url: `https://transcripts.example/${id}.txt` }]
        : [],
    },
  };
}

function program(slug: string, episodes: CatalogEpisode[]): CatalogProgram {
  return {
    id: `show-${slug}`,
    slug,
    title: slug,
    description: "",
    genre: null,
    episodes,
  };
}

describe("summarizeMediaCoverage (issue #190)", () => {
  it("counts only public, playable episodes and reports the captioned/transcribed shares", () => {
    const programs = [
      program("river", [
        episode("1", { public: true, captioned: true, transcribed: true }),
        episode("2", { public: true, captioned: false, transcribed: true }),
        episode("3", { public: false, captioned: false, transcribed: false }),
      ]),
    ];
    const report = summarizeMediaCoverage(programs);
    expect(report.publicEpisodes).toBe(2);
    expect(report.captioned).toBe(1);
    expect(report.captionCoverageRatio).toBe(0.5);
    expect(report.uncaptioned.map((e) => e.episodeId)).toEqual(["2"]);
    expect(report.transcribed).toBe(2);
    expect(report.transcriptCoverageRatio).toBe(1);
    expect(report.untranscribed).toEqual([]);
  });

  it("flags a caption-covered episode that is still missing a transcript", () => {
    const report = summarizeMediaCoverage([
      program("river", [
        episode("1", { public: true, captioned: true, transcribed: false }),
      ]),
    ]);
    expect(report.captioned).toBe(1);
    expect(report.uncaptioned).toEqual([]);
    expect(report.transcribed).toBe(0);
    expect(report.untranscribed.map((e) => e.episodeId)).toEqual(["1"]);
    expect(report.transcriptCoverageRatio).toBe(0);
  });

  it("treats a catalog with no public playback as fully covered, not 0/0", () => {
    const report = summarizeMediaCoverage([
      program("river", [
        episode("1", { public: false, captioned: false, transcribed: false }),
      ]),
    ]);
    expect(report.publicEpisodes).toBe(0);
    expect(report.uncaptioned).toEqual([]);
    expect(report.untranscribed).toEqual([]);
    expect(report.captionCoverageRatio).toBe(1);
    expect(report.transcriptCoverageRatio).toBe(1);
    expect(Number.isNaN(report.captionCoverageRatio)).toBe(false);
  });

  it("names the program and episode for each missing-asset public episode", () => {
    const [gap] = summarizeMediaCoverage([
      program("river", [
        episode("2", { public: true, captioned: false, transcribed: false }),
      ]),
    ]).uncaptioned;
    expect(gap).toMatchObject({
      programSlug: "river",
      episodeId: "2",
      episodeSlug: "ep-2",
      episodeTitle: "Episode 2",
    });
  });
});

describe("formatMediaCoverageWarning (issue #190)", () => {
  it("returns null when every public episode has captions and a transcript", () => {
    const report = summarizeMediaCoverage([
      program("river", [
        episode("1", { public: true, captioned: true, transcribed: true }),
      ]),
    ]);
    expect(formatMediaCoverageWarning(report)).toBeNull();
  });

  it("names the missing captions and says what to do", () => {
    const report = summarizeMediaCoverage([
      program("river", [
        episode("1", { public: true, captioned: true, transcribed: true }),
        episode("2", { public: true, captioned: false, transcribed: true }),
      ]),
    ]);
    const warning = formatMediaCoverageWarning(report);
    expect(warning).toContain("Caption coverage 1/2");
    expect(warning).toContain("50%");
    expect(warning).toContain("river/ep-2");
    expect(warning).toMatch(/Add captions/);
    // transcripts are complete here, so no transcript line
    expect(warning).not.toContain("Transcript coverage");
  });

  it("emits both a caption and a transcript line when both have gaps", () => {
    const report = summarizeMediaCoverage([
      program("river", [
        episode("1", { public: true, captioned: false, transcribed: true }),
        episode("2", { public: true, captioned: true, transcribed: false }),
      ]),
    ]);
    const warning = formatMediaCoverageWarning(report) ?? "";
    expect(warning).toContain("Caption coverage 1/2");
    expect(warning).toContain("Missing captions on public VOD: river/ep-1");
    expect(warning).toContain("Transcript coverage 1/2");
    expect(warning).toContain("Missing transcripts on public VOD: river/ep-2");
  });

  it("caps the named list and summarizes the remainder", () => {
    const episodes = Array.from({ length: 12 }, (_, i) =>
      episode(String(i), { public: true, captioned: false, transcribed: true }),
    );
    const report = summarizeMediaCoverage([program("river", episodes)]);
    expect(formatMediaCoverageWarning(report, 10)).toContain("and 2 more");
  });
});

describe("reportMediaCoverage (issue #386)", () => {
  const gappy = [
    program("river", [
      episode("1", { public: true, captioned: true, transcribed: true }),
      episode("2", { public: true, captioned: false, transcribed: false }),
    ]),
  ];

  it("logs the named gap and returns the report", () => {
    const logged: string[] = [];
    const report = reportMediaCoverage(gappy, { log: (m) => logged.push(m) });

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("river/ep-2");
    expect(report.publicEpisodes).toBe(2);
    expect(report.captioned).toBe(1);
  });

  it("stays silent when coverage is complete, so a clean rebuild log stays clean", () => {
    const logged: string[] = [];
    const complete = [
      program("river", [
        episode("1", { public: true, captioned: true, transcribed: true }),
      ]),
    ];
    reportMediaCoverage(complete, { log: (m) => logged.push(m) });
    expect(logged).toEqual([]);
  });

  it("warns without throwing by default, so one gap cannot block the whole rebuild", () => {
    expect(() => reportMediaCoverage(gappy, { log: () => {} })).not.toThrow();
  });

  it("throws below the floor when a caller opts into failing", () => {
    expect(() =>
      reportMediaCoverage(gappy, {
        log: () => {},
        policy: { mode: "fail", minCaptionCoverage: 0.9, minTranscriptCoverage: 0 },
      }),
    ).toThrow(/Caption coverage 50% is below the required 90%/);
  });

  it("does not throw when coverage meets the floor", () => {
    expect(() =>
      reportMediaCoverage(gappy, {
        log: () => {},
        policy: { mode: "fail", minCaptionCoverage: 0.5, minTranscriptCoverage: 0.5 },
      }),
    ).not.toThrow();
  });

  it("fails on a transcript gap even when every public episode is captioned", () => {
    const captionedButUntranscribed = [
      program("river", [
        episode("1", { public: true, captioned: true, transcribed: true }),
        episode("2", { public: true, captioned: true, transcribed: false }),
      ]),
    ];
    expect(() =>
      reportMediaCoverage(captionedButUntranscribed, {
        log: () => {},
        policy: { mode: "fail", minCaptionCoverage: 1, minTranscriptCoverage: 1 },
      }),
    ).toThrow(/Transcript coverage 50% is below the required 100%/);
  });

  it("names both shortfalls in one throw, so one rebuild surfaces both", () => {
    let message = "";
    try {
      reportMediaCoverage(gappy, {
        log: () => {},
        policy: { mode: "fail", minCaptionCoverage: 1, minTranscriptCoverage: 1 },
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("Caption coverage 50%");
    expect(message).toContain("Transcript coverage 50%");
  });

  it("rejects an out-of-range floor rather than silently disabling the gate", () => {
    for (const bad of [1.5, -0.1, Number.NaN]) {
      expect(() =>
        reportMediaCoverage(gappy, {
          log: () => {},
          policy: { mode: "fail", minCaptionCoverage: bad, minTranscriptCoverage: 0 },
        }),
      ).toThrow(/minCaptionCoverage must be a number in \[0, 1\]/);
      expect(() =>
        reportMediaCoverage(gappy, {
          log: () => {},
          policy: { mode: "fail", minCaptionCoverage: 0, minTranscriptCoverage: bad },
        }),
      ).toThrow(/minTranscriptCoverage must be a number in \[0, 1\]/);
    }
  });

  it("still logs the gap before throwing, so the failure names what is missing", () => {
    const logged: string[] = [];
    expect(() =>
      reportMediaCoverage(gappy, {
        log: (m) => logged.push(m),
        policy: { mode: "fail", minCaptionCoverage: 1, minTranscriptCoverage: 1 },
      }),
    ).toThrow();
    expect(logged[0]).toContain("river/ep-2");
  });
});
