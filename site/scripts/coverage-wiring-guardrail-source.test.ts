import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Source-tree guardrail for issue #386: whatever assembles the baked catalog must
// also report accessibility coverage over it.
//
// #386 could not be closed by wiring, because the only thing that will produce real
// CatalogProgram[] -- the credentialed Media Manager adapter -- is still blocked on
// the build-time key. The library half shipped instead (reportMediaCoverage in
// src/lib/media-manager-coverage.ts), which left the two halves able to drift: the
// adapter can land months from now, in a different session, and simply never call
// it. Then the rebuild bakes public episodes with no captions or transcripts and
// says nothing, which is the exact silent gap #190 asked to close.
//
// So this inverts the dependency. Instead of "wiring waits for the adapter", the
// adapter cannot land without the wiring: any non-test source file that calls
// buildProgram has to reference reportMediaCoverage too.
//
// Today no such file exists and the scan finds nothing, which is the correct
// current state rather than a broken check. The canary test below is what keeps
// that honest -- an empty result only means "no producers yet" for as long as both
// symbols still exist under the names this scan matches on.
//
// Reads hand-written source, not dist: an Astro getStaticPaths that fetches the
// catalog at build time never lands in the built output as recognizable calls.
// Same reasoning as scripts/workflow-secret-guardrail-source.test.ts.

const siteRoot = fileURLToPath(new URL("..", import.meta.url));

// EVERY hand-written source tree under site/ belongs in SCAN_ROOTS, same standing
// rule as scripts/metered-api-guardrail-source.test.ts: a tree missing from this
// list is not scanned and nothing says so. Add a new one here in the same commit
// that creates it. tests/ is the one deliberate omission -- a test that calls
// buildProgram without reporting coverage is doing its job, not baking a catalog.
const SCAN_ROOTS = ["src", "scripts", "worker", "worker-fanout"];
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".astro", ".mjs", ".js"];

const PRODUCER = "buildProgram";
const PRODUCER_MODULE = "media-manager-catalog";
const REPORTER = "reportMediaCoverage";
const REPORTER_MODULE = "media-manager-coverage";

const REMEDIATION =
  `Call ${REPORTER}(programs) on the assembled catalog (import it from ` +
  `src/lib/${REPORTER_MODULE}). It logs the named caption and transcript gaps ` +
  `and applies the configured policy, so a rebuild cannot bake public episodes ` +
  `with missing accessibility files without saying so. See issue #386.`;

// A file that only re-exports types, or the two library modules themselves, is not
// an adapter. Excluding them by path keeps the rule about production wiring.
const EXCLUDED = new Set([
  join("src", "lib", `${PRODUCER_MODULE}.ts`),
  join("src", "lib", `${REPORTER_MODULE}.ts`),
]);

function isSourceFile(name: string): boolean {
  if (name.includes(".test.") || name.includes(".spec.")) return false;
  return SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext));
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      walk(full, out);
    } else if (entry.isFile() && isSourceFile(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

// Read inside the tests, not in the describe body: a throw during vitest collection
// takes the file down before any test registers, so the run reports zero tests
// instead of a failure and the check that would name the problem never speaks.
function scanSources(): { path: string; source: string }[] {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    const dir = join(siteRoot, root);
    if (!existsSync(dir)) {
      throw new Error(
        `${dir} is missing. This guardrail scans that directory for catalog ` +
          `producers, so an absent path means it silently checks nothing.`,
      );
    }
    walk(dir, files);
  }
  return files
    .map((path) => ({ path: relative(siteRoot, path), source: readFileSync(path, "utf8") }))
    .filter(({ path }) => !EXCLUDED.has(path))
    .sort((a, b) => a.path.localeCompare(b.path));
}

// Comments are stripped before anything is matched, so naming a symbol in a note
// above the code someone forgot to write never counts as using it. The `[^:]`
// guard keeps a `//` inside a URL from swallowing the rest of the line.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** True when the file imports `module` in any form: named, namespace, or bare. */
function importsModule(code: string, module: string): boolean {
  return new RegExp(`(?:from|import)\\s*["'][^"']*${module}["']`).test(code);
}

/**
 * Both sides are matched as "imports the module AND names the symbol", rather
 * than by parsing the import clause. A named import is only one of the ways to
 * reach a symbol -- `import * as catalog from "./media-manager-catalog"` then
 * `catalog.buildProgram(...)` assembles a catalog just as well, and a clause
 * parser would wave it through. Anything that reaches the symbol has to import
 * the module it lives in, so keying on the module plus the name catches every
 * import style without pulling in a TypeScript parser.
 */
function producesCatalog(code: string): boolean {
  return importsModule(code, PRODUCER_MODULE) && new RegExp(`\\b${PRODUCER}\\b`).test(code);
}

/**
 * Compliance is an import plus a call, not a mention. A file can import the
 * reporter and never use it and still bake a catalog with no coverage reporting,
 * which is the failure this guardrail exists for.
 */
function callsReporter(code: string): boolean {
  return importsModule(code, REPORTER_MODULE) && new RegExp(`\\b${REPORTER}\\s*\\(`).test(code);
}

describe("catalog coverage wiring guardrail (#386)", () => {
  it("reports coverage wherever the catalog is assembled", () => {
    const findings = scanSources()
      .map(({ path, source }) => ({ path, code: stripComments(source) }))
      .filter(({ code }) => producesCatalog(code) && !callsReporter(code))
      .map(({ path }) => `${path}: uses ${PRODUCER} but never calls ${REPORTER}`);

    expect(
      findings,
      findings.length
        ? `Catalog is assembled without accessibility-coverage reporting:\n  ` +
            `${findings.join("\n  ")}\n\n  ${REMEDIATION}`
        : "",
    ).toEqual([]);
  });

  it("still matches the symbols it keys on, so an empty scan means no producers", () => {
    // Without this, renaming buildProgram or reportMediaCoverage would turn the
    // scan above into a check that matches nothing and passes forever. An empty
    // findings list has to mean "no adapter yet", never "the scan lost its target".
    const catalog = readFileSync(join(siteRoot, "src", "lib", `${PRODUCER_MODULE}.ts`), "utf8");
    const coverage = readFileSync(join(siteRoot, "src", "lib", `${REPORTER_MODULE}.ts`), "utf8");

    expect(
      catalog.includes(`export function ${PRODUCER}(`),
      `${PRODUCER_MODULE}.ts no longer exports ${PRODUCER}. Update PRODUCER here to ` +
        `the new producer name, or this guardrail silently stops finding adapters.`,
    ).toBe(true);
    expect(
      coverage.includes(`export function ${REPORTER}(`),
      `${REPORTER_MODULE}.ts no longer exports ${REPORTER}. Update REPORTER here, or ` +
        `every adapter starts failing this guardrail for the wrong reason.`,
    ).toBe(true);
  });

  it("recognizes the adapter shapes it has to catch, and the ways around them", () => {
    // The scan above passes today because no adapter exists, so nothing in this
    // file would notice if the matchers stopped matching -- the guardrail would
    // go quietly decorative. These fixtures exercise the positive path directly.
    const named =
      `import { ${PRODUCER} } from "./${PRODUCER_MODULE}";\n` +
      `export const bake = (r) => r.map(${PRODUCER});`;
    const namespaced =
      `import * as catalog from "./${PRODUCER_MODULE}";\n` +
      `export const bake = (r) => r.map(catalog.${PRODUCER});`;
    const wired =
      `${named}\nimport { ${REPORTER} } from "./${REPORTER_MODULE}";\n${REPORTER}(programs);`;
    const mentionedInAComment =
      `${named}\n// call ${REPORTER}(programs) here once the policy is agreed`;
    const importedNeverCalled = `${named}\nimport { ${REPORTER} } from "./${REPORTER_MODULE}";`;

    for (const [label, fixture] of [
      ["named import", named],
      ["namespace import", namespaced],
    ] as const) {
      expect(producesCatalog(stripComments(fixture)), `${label} not detected`).toBe(true);
    }

    expect(callsReporter(stripComments(wired))).toBe(true);
    expect(callsReporter(stripComments(mentionedInAComment))).toBe(false);
    expect(callsReporter(stripComments(importedNeverCalled))).toBe(false);
  });

  it("scans the source tree it claims to, not an empty set", () => {
    // The scan passing because it found no files at all would be indistinguishable
    // from a clean tree. src/lib alone holds both catalog modules, so a healthy
    // scan is never small.
    const scanned = scanSources();
    expect(scanned.length).toBeGreaterThan(0);
    expect(scanned.some(({ path }) => path.startsWith(join("src", "lib")))).toBe(true);
  });
});
