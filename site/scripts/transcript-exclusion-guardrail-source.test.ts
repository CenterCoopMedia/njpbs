import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Source-tree guardrail for ADR 0016 / issue #496: transcript bodies must never
// reach the search index.
//
// The exclusion holds today for a structural reason rather than a policy one.
// The catalog models a transcript as a URL reference (TranscriptRef.url), so no
// transcript text exists anywhere in the built output for Pagefind to index. The
// risk is not that someone indexes transcripts on purpose; it is that the model
// grows an inline body field, or a component fetches the .txt and renders it,
// and the exclusion quietly stops being true while nothing looks wrong.
//
// This is the source half of the guard, and it has no #226 dependency: it reads
// hand-written source, so it catches the drift at the point it is introduced.
// The dist half (scripts/pagefind-transcript-dist.test.ts) reads the generated
// index and catches anything that reaches it by a route this scan cannot see.
//
// Same reasoning as scripts/coverage-wiring-guardrail-source.test.ts: invert the
// dependency so the unsafe change cannot land, rather than hoping a later
// reviewer remembers the ADR.

const siteRoot = fileURLToPath(new URL("..", import.meta.url));
const CATALOG = join(siteRoot, "src/lib/media-manager-catalog.ts");

// Field names that would make a transcript carry its own text rather than point
// at it. Deliberately a small, crisp list: a transcript ref holds a url, and
// anything body-shaped alongside it is the drift this guard exists for.
const BODY_FIELD = /^\s*(body|text|content|plain|plainText|transcriptText|lines)\b/im;

// A read, not a mention: the type, a property or bracket access, or a
// destructure, of either the plural `transcripts` or the raw asset's singular
// `transcript`. Prose that says "transcripts" in a comment or a log string must
// not count, or the allowlist pin below would stay green after the real read
// moved away.
const TRANSCRIPT_READ =
  /\bTranscriptRef\b|\.transcripts?\b|\[\s*["'`]transcripts?["'`]\s*\]|\{[^{}]*\btranscripts?\b[^{}]*\}\s*=/;

const readTranscriptRefBody = (source: string): string => {
  const start = source.indexOf("export interface TranscriptRef");
  expect(
    start,
    "TranscriptRef is gone from media-manager-catalog.ts. If it was renamed, " +
      "point this guard at the new name — an exclusion scan that silently " +
      "matches nothing is the failure mode ADR 0016 cannot afford.",
  ).toBeGreaterThan(-1);
  const open = source.indexOf("{", start);
  const close = source.indexOf("}", open);
  return source.slice(open + 1, close);
};

const sourceFiles = (dir: string, acc: string[] = []): string[] => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      sourceFiles(full, acc);
    } else if (/\.(ts|tsx|astro|mjs|js)$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
};

describe("transcript exclusion (ADR 0016)", () => {
  it("keeps TranscriptRef reference-only", () => {
    const fields = readTranscriptRefBody(readFileSync(CATALOG, "utf8"));
    expect(
      BODY_FIELD.test(fields),
      "TranscriptRef gained a body-shaped field. ADR 0016 excludes transcript " +
        "text from the search index at launch, and the exclusion rests on this " +
        "type staying a URL reference. If the decision changed, change the ADR " +
        "first.",
    ).toBe(false);
  });

  it("still declares the url field this guard assumes", () => {
    // The canary. Every assertion above is a negative — it passes by finding
    // nothing. That is only meaningful while the thing being searched still
    // exists in the shape the search expects, so this pins the positive.
    expect(readTranscriptRefBody(readFileSync(CATALOG, "utf8"))).toMatch(/\burl\s*:\s*string/);
  });

  it("lets only the catalog and the coverage report read transcript references", () => {
    // The render check below sees set:html and nothing else. A component that
    // fetched a transcript url and printed it as {text} would be escaped, still
    // visible, still indexed, and invisible to that check (issue #770). So this
    // pins the step before rendering: the code that can see a transcript url at
    // all. Today that is the module that builds the refs and the report that
    // counts them. A new reader is where a fetch would start, so it has to be
    // added here, next to ADR 0016, before it can land.
    const allowed: Record<string, string> = {
      "src/lib/media-manager-catalog.ts": "builds TranscriptRef from the Media Manager asset",
      "src/lib/media-manager-coverage.ts": "counts transcripts for the coverage report, never reads a url",
    };
    const readers = sourceFiles(join(siteRoot, "src"))
      .filter((file) => !file.endsWith(".test.ts"))
      .map((file) => ({ file: relative(siteRoot, file), source: readFileSync(file, "utf8") }))
      .filter(({ source }) => TRANSCRIPT_READ.test(source));
    const readerFiles = readers.map(({ file }) => file);

    const unexpected = readerFiles.filter((file) => !(file in allowed));
    expect(
      unexpected,
      `${unexpected.join(", ")} now reads transcript references. ADR 0016 keeps ` +
        "transcript bodies out of the public site, so a transcript url may be " +
        "linked but never fetched into a page. If this file only links or counts, " +
        "add it to the allowlist in this test with the reason.",
    ).toEqual([]);

    // The allowlist is a negative too, so pin it: an entry that stops matching
    // means the reader moved, and the guard would be checking a file that no
    // longer holds the thing it protects.
    expect([...readerFiles].sort()).toEqual(Object.keys(allowed).sort());

    const fetching = readers.filter(({ source }) => /\bfetch\s*\(/.test(source)).map(({ file }) => file);
    expect(
      fetching,
      `${fetching.join(", ")} reads transcript references and calls fetch. ` +
        "ADR 0016: link a transcript, do not fetch it into the build.",
    ).toEqual([]);
  });

  it("renders no transcript body into markup", () => {
    // Astro's set:html is the one construct that puts an arbitrary string into
    // the page as markup rather than escaped text. Escaped interpolation is
    // covered by the reader allowlist above, not here. Narrow on purpose: a
    // mention of the word transcript in prose, a link to a transcript url, and
    // the catalog model itself are all fine and must not trip this.
    const offenders = sourceFiles(join(siteRoot, "src"))
      .filter((file) => !file.endsWith(".test.ts"))
      .map((file) => ({ file, source: readFileSync(file, "utf8") }))
      .filter(({ source }) => /set:html=\{[^}]*transcript/i.test(source))
      .map(({ file }) => relative(siteRoot, file));

    expect(
      offenders,
      `transcript text is rendered into markup in: ${offenders.join(", ")}. ` +
        "ADR 0016 keeps transcript bodies out of the indexable page.",
    ).toEqual([]);
  });
});
