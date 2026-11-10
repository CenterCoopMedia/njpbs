// Post-build transcript-exclusion lock over the Pagefind index (issue #496).
//
// ADR 0016 launches search over editorial pages and baked video metadata only,
// with no Media Manager transcript bodies. The source half of this guard
// (scripts/transcript-exclusion-guardrail-source.test.ts) keeps the catalog's
// transcript surface a URL reference so no transcript text exists to index.
// This half asks the built artifact directly, which catches anything that
// reaches the index by a route the source scan cannot see — a vendored file, a
// future adapter, a caption sidecar rendered into the page.
//
// The markers below find a transcript by its shape, so a plain-prose transcript
// with no speaker tags or cue timings passes this half. That bound is inherent
// to a marker scan (issue #770). The source half's reader allowlist is what
// stops a transcript body from being fetched into the build at all.
//
// It reads fragments through src/lib/pagefind-index.ts rather than scanning the
// directory as text. Pagefind stores fragments gzipped, so `grep -r` over
// dist/pagefind/ returns zero hits regardless of what the index contains:
// measured on a real leaking build of this site, a search for `/wiki/` found
// nothing while the index held 17 wiki pages with their full body text. Written
// the obvious way, this guard would pass green on precisely the build it exists
// to fail.
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodePagefindFragment,
  findBannedContent,
  type PagefindFragment,
} from "../src/lib/pagefind-index";

// Phrases that only appear in a verbatim transcript body, not in a synopsis or a
// link label. Kept narrow so an episode description that mentions the word
// "transcript", or a page linking to one, never trips the guard — the thing
// being excluded is the transcript text itself.
const TRANSCRIPT_BODY_MARKERS: readonly RegExp[] = [
  // Speaker-turn markers: the shape of a transcript, not of editorial copy.
  /\[\s*(?:speaker|narrator|announcer)\s*\d*\s*\]/i,
  />>\s*[A-Z][a-z]+:/,
  // WebVTT / SRT cue timing leaking through a converted transcript.
  /\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->/,
  /^WEBVTT\b/im,
];

const distDir = fileURLToPath(new URL("../dist/", import.meta.url));
const fragmentDir = join(distDir, "pagefind", "fragment");

const readFragments = (): PagefindFragment[] =>
  readdirSync(fragmentDir)
    .filter((name) => name.endsWith(".pf_fragment"))
    .map((name) => decodePagefindFragment(readFileSync(join(fragmentDir, name))));

describe("Pagefind index carries no transcript bodies (ADR 0016)", () => {
  it("indexes no transcript body text", () => {
    // No index means Pagefind did not run for this build mode. Whether that is
    // correct is pagefind-scope-dist.test.ts's assertion, not this one, so this
    // guard does not duplicate it and does not fail the build a second time for
    // the same reason.
    if (!existsSync(fragmentDir)) return;

    const hits = findBannedContent(readFragments(), TRANSCRIPT_BODY_MARKERS);
    expect(
      hits,
      `transcript body text entered the search index: ${hits
        .map((hit) => `${hit.url} (${hit.match})`)
        .join(", ")}. ADR 0016 excludes transcripts from the launch corpus.`,
    ).toEqual([]);
  });

  it("would recognise a transcript body if one were indexed", () => {
    // The canary. The assertion above passes by finding nothing, which stays
    // meaningful only while the markers still match a real transcript. This
    // pins that against a synthetic fragment rather than trusting the patterns.
    const sample: PagefindFragment = {
      url: "/watch/example/episode-1/",
      content: "00:00:04.120 --> 00:00:07.480 >> Briana: Welcome back to the program.",
    };
    expect(findBannedContent([sample], TRANSCRIPT_BODY_MARKERS)).not.toEqual([]);
  });

  it("does not flag editorial copy that merely mentions transcripts", () => {
    const sample: PagefindFragment = {
      url: "/accessibility/",
      content: "Transcripts are available for every episode. Request a transcript by email.",
    };
    expect(findBannedContent([sample], TRANSCRIPT_BODY_MARKERS)).toEqual([]);
  });
});
