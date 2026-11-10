import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  markdownlintConfigOffenders,
  manifestOffenders,
  meteredOffenders,
  REPO_SCAN_ROOTS,
  SCANNED_MARKDOWNLINT_CONFIGS,
  SCANNED_MANIFESTS,
  scanFilesUnder,
  scanMarkdownlintConfigFiles,
  scanPackageManifestFiles,
  scanRepositorySourceFiles,
  scanSiteRootFiles,
  SITE_SCAN_ROOTS,
} from "../../.github/scripts/metered-api-scan.mjs";

// Source-tree guardrail for the no-metered-API rule (issue #245). The walk,
// root lists, and dependency-free executable live in the trusted bootstrap
// outside the graph it scans. CI calls that bootstrap before lifecycle scripts
// run; this spec keeps the same checks inside `npm run guardrails` as defense in
// depth and pins each coverage claim.
//
// Scope is repository-wide first-party source, all package manifests whose
// lifecycle commands can execute during installation/rebuild, and every
// directory-level Markdown lint config that the lint runner can discover.
// The older named-root assertions remain below as explicit coverage pins for
// the currently executable application trees.
// site/tests is included so a unit test can not import a provider SDK or hit a
// metered host and still pass (the guardrail's own unit spec is exempted by
// isMeteredApiScanTarget). The build fails if any scanned file references a
// pay-per-token LLM host or imports a provider SDK.

const siteRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = join(siteRoot, "..");

// The walk throws on a missing root, inside the tests rather than the describe
// body: a throw while vitest is collecting takes the whole file down before a
// single test registers, so the run would report no tests rather than a
// failure, and the check that would name the bad root never gets to speak.
function scan(root: string): string[] {
  return scanFilesUnder(siteRoot, "site/", "SITE_SCAN_ROOTS", root);
}

function scanRepo(root: string): string[] {
  return scanFilesUnder(repoRoot, "", "REPO_SCAN_ROOTS", root);
}

describe("source obeys the no-metered-API guardrail (#245)", () => {
  // #3362: This whole-repository semantic check took 12.223s with measured I/O waits.
  // Its budget allows filesystem work; it is not a performance assertion.
  it("scans first-party source across the entire repository", () => {
    const files = scanRepositorySourceFiles(repoRoot);
    expect(files).toContain("site/tests-e2e/cms-loader.e2e.test.ts");
    expect(files).toContain("archive/theme-chooser/src/lib/chooser-kits.ts");
    expect(files).toContain(".github/scripts/metered-api-scan.d.mts");
    expect(files).not.toContain(".github/scripts/metered-api-scan.mjs");
    expect(meteredOffenders(repoRoot, files)).toEqual([]);
  }, 30_000);

  // Per root, not in total. A root that is renamed or emptied contributes no
  // files, and a total-count assertion still passes on the strength of the other
  // roots, so the guardrail would cover less than it claims and say nothing.
  it.each(SITE_SCAN_ROOTS)("scans site/%s", (root) => {
    expect(scan(root).length).toBeGreaterThan(0);
  });

  it("scans the site root's top-level config files", () => {
    // astro.config.mjs runs during the build; the guardrail must cover it, not just
    // the files under the root subtrees.
    expect(scanSiteRootFiles(siteRoot)).toContain("astro.config.mjs");
  });

  it.each(SITE_SCAN_ROOTS)(
    "has no metered LLM API host or SDK import in site/%s",
    (root) => {
      // Equality against [] surfaces the offending file + matched text on failure.
      expect(meteredOffenders(siteRoot, scan(root))).toEqual([]);
    },
  );

  it("has no metered LLM API host or SDK import in the site root's config files", () => {
    expect(meteredOffenders(siteRoot, scanSiteRootFiles(siteRoot))).toEqual([]);
  });

  it.each(REPO_SCAN_ROOTS)("scans %s", (root) => {
    expect(scanRepo(root).length).toBeGreaterThan(0);
  });

  it.each(REPO_SCAN_ROOTS)(
    "has no metered LLM API host or SDK import in %s",
    (root) => {
      expect(meteredOffenders(repoRoot, scanRepo(root))).toEqual([]);
    },
  );

  it("scans every root, site, and workspace manifest's decoded scripts", () => {
    expect(SCANNED_MANIFESTS).toEqual([
      "package.json",
      "admin/package.json",
      "cms-api/package.json",
      "crawl-worker/package.json",
      "functions/package.json",
      "site/package.json",
    ]);
    expect(manifestOffenders(repoRoot, [...SCANNED_MANIFESTS])).toEqual([]);
    expect(manifestOffenders(repoRoot, scanPackageManifestFiles(repoRoot))).toEqual([]);
    // The fixture compilers create Vite module metadata after a clean checkout.
    // Keep scanning it and require its exact non-executable shape.
    const generatedManifests = [
      "site/.public-page-fixture-cache/vite-sync/deps/package.json",
      "site/.public-page-static-fixtures/record-cache/vite-sync/deps/package.json",
      "site/.public-post-fixture-cache/vite-sync/deps/package.json",
    ].filter((file) => existsSync(join(repoRoot, file)));
    for (const file of generatedManifests) {
      expect(JSON.parse(readFileSync(join(repoRoot, file), "utf8"))).toEqual({ type: "module" });
    }
    expect(scanPackageManifestFiles(repoRoot)).toEqual([
      "admin/package.json",
      "agents/vmix/package.json",
      "cms-api/package.json",
      "crawl-worker/package.json",
      "functions/package.json",
      "infrastructure/boardwalk-s3/claim-probe/package.json",
      "package.json",
      "premiere-boardwalk-panel/package.json",
      "preview-renderer/package.json",
      "publisher/package.json",
      "site/package.json",
      "tests/public-post-runtime/package.json",
      ...generatedManifests,
    ].sort());
  });

  it("scans every supported Markdown lint config tree-wide and forbids custom rules", () => {
    expect(SCANNED_MARKDOWNLINT_CONFIGS).toEqual([
      ".markdownlint-cli2.jsonc",
      ".markdownlint-cli2.yaml",
      ".markdownlint-cli2.cjs",
      ".markdownlint-cli2.mjs",
      ".markdownlint.jsonc",
      ".markdownlint.json",
      ".markdownlint.yaml",
      ".markdownlint.yml",
      ".markdownlint.cjs",
      ".markdownlint.mjs",
    ]);
    expect(scanMarkdownlintConfigFiles(repoRoot)).toContain(
      ".markdownlint-cli2.yaml",
    );
    expect(
      markdownlintConfigOffenders(
        repoRoot,
        scanMarkdownlintConfigFiles(repoRoot),
      ),
    ).toEqual([]);
  });
});
