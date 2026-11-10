import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isGuardrailExemptPath } from "../src/lib/guardrails";
import { isPublicOnlyBuild } from "../src/lib/build-target";
import { inlineDisplay } from "./image-layout-guard.mjs";

// Post-build CLS floor (issue #237, ADR 0018). Runs only via npm run guardrails,
// after a build has produced dist/. Every <img> the build emits must declare both
// width and height.
//
// Why this is the check and not a metric: an unsized image is the ordinary way CLS
// regresses on a content-driven site. The browser cannot reserve the box before the
// bytes arrive, so everything below it moves when they do, and the reader loses their
// place or taps the wrong thing.
//
// This covers authored and CMS-rendered images on non-exempt public routes.
// The wiki remains independently governed. A full site must contain images, while
// a coming-soon rollback may contain only text; both must contain public HTML.
// Literal fixtures below keep an image-free rollback from hiding a broken parser.
//
// Deliberately narrow. It checks that a box is declared, not that the box is right,
// and a wrong width/height pair still shifts layout. Catching that needs the real
// image bytes, which this does not read. ADR 0018 records that limit rather than
// leaving a reader to assume the gate proves more than it does.

const distDir = fileURLToPath(new URL("../dist/", import.meta.url));
const normalizeRel = (rel: string): string => rel.replaceAll("\\", "/");

// Quoted attribute values may contain a literal `>` (for example alt="A > B").
// Consume quoted strings whole so the tag does not end before later dimensions.
const IMG_TAG = /<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;

// Attribute names only. Matching /\bwidth\s*=/ against the whole tag would accept
// <img src="/photo.jpg?width=640&height=360">, which declares no dimensions at all
// and is exactly the unsized image this gate exists to catch. So walk the tag's
// attributes instead: the value alternatives consume quoted strings whole, which is
// what keeps a query string or an alt text out of the name position.
const ATTR = /([a-zA-Z_:][-\w:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/g;

function attrs(tag: string): Map<string, string | null> {
  // Drop "<img" so the tag name itself cannot be read as an attribute.
  const body = tag.slice(4, -1);
  const found = new Map<string, string | null>();
  for (const [, name, dq, sq, bare] of body.matchAll(ATTR)) {
    found.set(name.toLowerCase(), dq ?? sq ?? bare ?? null);
  }
  return found;
}

// The attribute has to carry a usable number, not just exist. `<img width height>`
// and `width="" height=""` name both attributes and still give the browser nothing
// to reserve a box with, so a name-only check would pass the very tag it should
// catch. HTML parses these as a non-negative integer in CSS pixels; a bare "300" is
// the conforming shape Astro emits. This deploy contract deliberately rejects units
// and percentages so every image records a positive intrinsic pixel size.
const VALID_DIMENSION = /^[1-9]\d*$/;

function declaresBox(found: Map<string, string | null>): boolean {
  return (["width", "height"] as const).every((name) => {
    const value = found.get(name);
    return typeof value === "string" && VALID_DIMENSION.test(value.trim());
  });
}

// An <img> the browser never lays out cannot shift anything below it, so it is exempt.
// Only two removals are visible in the tag itself: the boolean `hidden` attribute and
// an inline display:none. A stylesheet class or a hidden parent removes the box too,
// and this scan will still flag such an image, which is the safe direction to be wrong
// in. `aria-hidden` is not a removal at all: it hides an element from the accessibility
// tree and leaves it laid out exactly as before, so an unsized decorative image still
// shifts the text under it.
function isLaidOut(found: Map<string, string | null>): boolean {
  const style = found.get("style");
  const display = typeof style === "string" ? inlineDisplay(style) : null;
  // An explicit display can override the hidden attribute's default UA rule.
  return display === null ? !found.has("hidden") : display !== "none";
}

function hasScanCoverage(pageCount: number, imageCount: number, publicOnly: boolean): boolean {
  return pageCount > 0 && (imageCount > 0 || publicOnly);
}

function candidateHtmlFiles(files: string[]): string[] {
  return files.filter((file) => !isGuardrailExemptPath(file));
}

function htmlFiles(): string[] {
  return candidateHtmlFiles(
    (readdirSync(distDir, { recursive: true }) as string[])
      .map(normalizeRel)
      .filter((file) => file.endsWith(".html")),
  );
}

/** Every <img> in one document that lays out but does not reserve its box. */
function unsizedIn(html: string): string[] {
  const offenders: string[] = [];
  for (const match of html.matchAll(IMG_TAG)) {
    const tag = match[0];
    const found = attrs(tag);
    if (!isLaidOut(found)) continue;
    if (declaresBox(found)) continue;
    offenders.push(tag.slice(0, 200));
  }
  return offenders;
}

function unsizedImages(): Array<{ file: string; tag: string }> {
  return htmlFiles().flatMap((file) =>
    unsizedIn(readFileSync(join(distDir, file), "utf8")).map((tag) => ({ file, tag })),
  );
}

describe("every emitted image reserves its own layout box", () => {
  it("dist/ exists, meaning a build ran first", () => {
    expect(existsSync(distDir)).toBe(true);
  });

  it("has no image without width and height", () => {
    expect(
      unsizedImages(),
      "An emitted <img> declares no usable width and height, so the browser cannot " +
        "reserve its box before the bytes arrive and everything below it moves when " +
        "they do. That is a CLS regression against the 0.1-at-P75 target in ADR 0018. " +
        "Give both attributes a plain pixel integer matching the source file's " +
        "intrinsic size.",
    ).toEqual([]);
  });

  it("scans public HTML and requires images outside the coming-soon rollback", () => {
    const files = htmlFiles();
    const total = files.reduce(
      (n, file) => n + [...readFileSync(join(distDir, file), "utf8").matchAll(IMG_TAG)].length,
      0,
    );
    expect(
      hasScanCoverage(files.length, total, isPublicOnlyBuild(process.env)),
      "the scan needs public HTML, and a full build must contain images",
    ).toBe(true);
  });
});

// The scan's own behaviour, on literal tags rather than on dist. Every case here is
// one a name-only or whole-tag regex gets wrong, so these are the assertions that
// keep the check from quietly passing the images it exists to catch.
describe("what the scan counts as sized", () => {
  const flags = (tag: string) => unsizedIn(tag).length === 1;

  it("accepts a plain integer pair, however it is written", () => {
    expect(flags('<img src="/a.png" width="800" height="450">')).toBe(false);
    expect(flags("<img src=/a.png WIDTH=800 Height=450 />")).toBe(false);
    expect(flags('<img src="/a.png" alt="A > B" width="800" height="450">')).toBe(false);
  });

  it("rejects dimensions that only look like attributes", () => {
    // A query string and an alt text both put width= and height= in the tag.
    expect(flags('<img src="/a.png?width=640&height=360">')).toBe(true);
    expect(flags('<img src="/a.png" alt="width=9 height=9">')).toBe(true);
  });

  it("rejects an attribute with nothing usable in it", () => {
    expect(flags("<img src=/a.png width height>")).toBe(true);
    expect(flags('<img src="/a.png" width="" height="">')).toBe(true);
    // CSS-shaped values are outside this attribute contract; use intrinsic pixels.
    expect(flags('<img src="/a.png" width="300px" height="200px">')).toBe(true);
    expect(flags('<img src="/a.png" width="0" height="0">')).toBe(true);
  });

  it("exempts only the images that are actually removed from layout", () => {
    expect(flags('<img src="/a.png" hidden>')).toBe(false);
    expect(flags('<img src="/a.png" style="color:red;display: none">')).toBe(false);
    // A data attribute is inert CSS metadata, not the real inline style attribute.
    expect(flags('<img src="/a.png" data-style="display:none">')).toBe(true);
    // aria-hidden leaves the box in place, so it still has to declare one.
    expect(flags('<img src="/a.png" aria-hidden="true">')).toBe(true);
  });

  it("uses the effective display declaration, including importance and resets", () => {
    expect(flags('<img style="display:none;display:block">')).toBe(true);
    expect(flags('<img style="display:block;display:none">')).toBe(false);
    expect(flags('<img style="display:none!important;display:block">')).toBe(false);
    expect(flags('<img style="display:none!important;display:block!important">')).toBe(true);
    expect(flags('<img style="display:none;all:initial">')).toBe(true);
    expect(flags('<img style="all:none">')).toBe(true);
    expect(flags('<img hidden style="display:block">')).toBe(true);
  });

  it("does not mistake comments, strings, or unresolved values for a display exemption", () => {
    expect(flags('<img style="/* display:none */">')).toBe(true);
    expect(flags(`<img style="content:'display:none';display:block">`)).toBe(true);
    expect(flags('<img style="--display:none">')).toBe(true);
    expect(flags('<img style="display:none;display:var(--layout)">')).toBe(true);
  });
});

describe("which emitted pages the scan owns", () => {
  it("keeps the independently governed wiki out of the public-site gate", () => {
    expect(candidateHtmlFiles(["index.html", "news/index.html", "wiki/guide/index.html"])).toEqual([
      "index.html",
      "news/index.html",
    ]);
  });
});


describe("image scan coverage in full and coming-soon builds", () => {
  it("accepts image-free rollback HTML while keeping the full-build floor", () => {
    expect(hasScanCoverage(1, 0, true)).toBe(true);
    expect(hasScanCoverage(1, 0, false)).toBe(false);
    expect(hasScanCoverage(1, 1, false)).toBe(true);
  });

  it("rejects an empty public page set in either build target", () => {
    expect(hasScanCoverage(0, 0, true)).toBe(false);
    expect(hasScanCoverage(0, 0, false)).toBe(false);
  });
});
