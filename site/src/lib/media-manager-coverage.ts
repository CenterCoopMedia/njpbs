/**
 * Summarize verified caption and transcript references for playable public assets.
 * Both file types are counted independently; a missing file produces a named
 * coverage gap. The result is a report rather than a hard build gate, allowing
 * callers to surface incomplete accessibility coverage without dropping the
 * remainder of a catalog. This module performs no I/O or clock reads.
 */

import type { CatalogProgram } from "./media-manager-catalog";

/** A public, playable episode missing a verified accessibility file (caption or transcript). */
export interface MissingAssetEpisode {
  programSlug: string;
  programTitle: string;
  episodeId: string;
  episodeSlug: string;
  episodeTitle: string;
}

export interface MediaCoverageReport {
  /**
   * Public episodes: those with a bakeable Partner Player src, i.e. something
   * actually plays publicly. An episode with no public player is not counted --
   * it is not a coverage gap, because there is no public playback to caption or
   * transcribe.
   */
  publicEpisodes: number;
  /** Of the public episodes, how many carry at least one verified caption file. */
  captioned: number;
  /**
   * The public episodes with no verified caption file, named so a rebuild log or
   * a person can find and fix them. Empty when caption coverage is complete.
   */
  uncaptioned: MissingAssetEpisode[];
  /**
   * captioned / publicEpisodes, in [0, 1]. Defined as 1 when there are no public
   * episodes: a catalog with nothing public to caption has no coverage gap, and
   * this keeps the ratio a real number instead of 0/0.
   */
  captionCoverageRatio: number;
  /** Of the public episodes, how many carry at least one verified transcript file. */
  transcribed: number;
  /**
   * The public episodes with no verified transcript file, named the same way.
   * Empty when transcript coverage is complete.
   */
  untranscribed: MissingAssetEpisode[];
  /** transcribed / publicEpisodes, in [0, 1]; 1 when there are no public episodes. */
  transcriptCoverageRatio: number;
}

/**
 * Summarize caption and transcript coverage across a baked catalog. Only public,
 * playable episodes count (partnerPlayerSrc present); hasCaptions and the
 * transcripts list are the transform's verified signals, so this never assumes an
 * asset exists.
 */
export function summarizeMediaCoverage(
  programs: CatalogProgram[],
): MediaCoverageReport {
  let publicEpisodes = 0;
  let captioned = 0;
  let transcribed = 0;
  const uncaptioned: MissingAssetEpisode[] = [];
  const untranscribed: MissingAssetEpisode[] = [];

  for (const program of programs) {
    for (const episode of program.episodes) {
      // Not public/playable: nothing to caption or transcribe, so not a gap.
      if (episode.playback.partnerPlayerSrc === null) continue;
      publicEpisodes += 1;
      const ref: MissingAssetEpisode = {
        programSlug: program.slug,
        programTitle: program.title,
        episodeId: episode.id,
        episodeSlug: episode.slug,
        episodeTitle: episode.title,
      };
      if (episode.playback.hasCaptions) captioned += 1;
      else uncaptioned.push(ref);
      if (episode.playback.transcripts.length > 0) transcribed += 1;
      else untranscribed.push(ref);
    }
  }

  return {
    publicEpisodes,
    captioned,
    uncaptioned,
    captionCoverageRatio: publicEpisodes === 0 ? 1 : captioned / publicEpisodes,
    transcribed,
    untranscribed,
    transcriptCoverageRatio: publicEpisodes === 0 ? 1 : transcribed / publicEpisodes,
  };
}

/** One asset's gap, as an actionable rebuild-log line. */
function coverageLine(
  singular: string,
  plural: string,
  covered: number,
  total: number,
  ratio: number,
  missing: MissingAssetEpisode[],
  maxNamed: number,
): string {
  const pct = Math.round(ratio * 100);
  const shown = missing.slice(0, Math.max(0, maxNamed));
  const named = shown.map((e) => `${e.programSlug}/${e.episodeSlug}`).join(", ");
  const more = missing.length - shown.length;
  const tail = more > 0 ? `, and ${more} more` : "";
  return (
    `${singular} coverage ${covered}/${total} public episodes (${pct}%). ` +
    `Missing ${plural} on public VOD: ${named}${tail}. ` +
    `Add ${plural} in Media Manager, or confirm these assets should not be public.`
  );
}

/**
 * A human-readable warning for the rebuild log, or null when every public episode
 * has both a caption and a transcript. It emits one line per asset with a gap
 * (captions, transcripts, or both), naming the missing episodes (capped so the
 * log stays readable) and saying what to do, so the log is actionable rather than
 * a bare count.
 */
export function formatMediaCoverageWarning(
  report: MediaCoverageReport,
  maxNamed = 10,
): string | null {
  const lines: string[] = [];
  if (report.uncaptioned.length > 0) {
    lines.push(
      coverageLine("Caption", "captions", report.captioned, report.publicEpisodes,
        report.captionCoverageRatio, report.uncaptioned, maxNamed),
    );
  }
  if (report.untranscribed.length > 0) {
    lines.push(
      coverageLine("Transcript", "transcripts", report.transcribed, report.publicEpisodes,
        report.transcriptCoverageRatio, report.untranscribed, maxNamed),
    );
  }
  return lines.length > 0 ? lines.join(" ") : null;
}

/**
 * What a rebuild does when public episodes are missing accessibility files.
 *
 * The default is "warn": name the gaps and keep going. A real catalog
 * legitimately carries some uncaptioned public assets, and a hard failure would
 * block shipping every other program over a handful of them, so refusing to
 * build is worse than shipping with a named, visible gap.
 *
 * "fail" exists for the case where a floor has been agreed and regression below
 * it should stop the rebuild rather than scroll past in a log. It is opt-in
 * precisely because it can block a release.
 *
 * Fail mode takes a floor for both assets, and both are required rather than
 * optional. This module reports captions and transcripts symmetrically on
 * purpose; a gate that only checked captions would let a rebuild with 100%
 * captions and no transcripts pass, which is the same silent gap the report
 * exists to prevent. A caller that only has a caption policy today writes
 * minTranscriptCoverage: 0 and says so, instead of omitting it and getting a
 * half-enforced gate by accident.
 */
export type CoveragePolicy =
  | { mode: "warn" }
  | {
      mode: "fail";
      minCaptionCoverage: number;
      minTranscriptCoverage: number;
    };

export interface ReportMediaCoverageOptions {
  /** Defaults to warn-and-name. */
  policy?: CoveragePolicy;
  /** Where the warning goes. Defaults to console.warn; injectable for tests. */
  log?: (message: string) => void;
  /** How many missing episodes to name per asset type before truncating. */
  maxNamed?: number;
}

/**
 * The single call the credentialed catalog adapter makes once it has baked the
 * catalog: summarize coverage, put any gap in the rebuild log named by program
 * and episode, and apply the configured policy. Returns the report so a caller
 * can assert on it or publish it somewhere else.
 *
 * Silent when coverage is complete, so a clean rebuild log stays clean.
 */
export function reportMediaCoverage(
  programs: CatalogProgram[],
  options: ReportMediaCoverageOptions = {},
): MediaCoverageReport {
  const { policy = { mode: "warn" }, log = console.warn, maxNamed } = options;

  if (policy.mode === "fail") {
    // Validate before doing the work: a NaN or out-of-range floor would make
    // every comparison below silently false and quietly disable the gate the
    // caller opted into.
    for (const [name, floor] of [
      ["minCaptionCoverage", policy.minCaptionCoverage],
      ["minTranscriptCoverage", policy.minTranscriptCoverage],
    ] as const) {
      if (!Number.isFinite(floor) || floor < 0 || floor > 1) {
        throw new RangeError(`${name} must be a number in [0, 1], got ${floor}`);
      }
    }
  }

  const report = summarizeMediaCoverage(programs);
  const warning = formatMediaCoverageWarning(report, maxNamed);
  if (warning !== null) {
    log(warning);
  }

  if (policy.mode === "fail") {
    // Both shortfalls in one throw. Reporting only the first would make a
    // catalog short on captions and transcripts take two rebuilds to discover.
    const shortfalls = [
      shortfall("Caption", "captioned", report.captioned, report.publicEpisodes,
        report.captionCoverageRatio, policy.minCaptionCoverage),
      shortfall("Transcript", "transcribed", report.transcribed, report.publicEpisodes,
        report.transcriptCoverageRatio, policy.minTranscriptCoverage),
    ].filter((line): line is string => line !== null);

    if (shortfalls.length > 0) {
      throw new Error(shortfalls.join(" "));
    }
  }

  return report;
}

/**
 * One asset's floor breach, or null when it clears the floor. Parameter order
 * matches coverageLine above -- both take (covered, total, ratio) in that order,
 * so the two sibling helpers cannot be transposed by eye.
 */
function shortfall(
  singular: string,
  pastTense: string,
  covered: number,
  total: number,
  ratio: number,
  floor: number,
): string | null {
  if (ratio >= floor) return null;
  return (
    `${singular} coverage ${Math.round(ratio * 100)}% is below the ` +
    `required ${Math.round(floor * 100)}% ` +
    `(${covered}/${total} public episodes ${pastTense}).`
  );
}
