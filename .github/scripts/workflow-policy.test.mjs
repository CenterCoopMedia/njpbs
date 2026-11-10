import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { describe, it } from "node:test";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const readRepo = (relativePath) => readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8");
const workflowPaths = readdirSync(new URL("../workflows/", import.meta.url))
  .filter(name => /\.ya?ml$/.test(name)).map(name => `.github/workflows/${name}`);

describe("workflow policy", () => {
  it("runs every concrete job on GitHub-hosted Ubuntu 24.04", () => {
    assert.ok(workflowPaths.length > 0);
    for (const path of workflowPaths) {
      const source = readRepo(path);
      const runners = [...source.matchAll(/^    runs-on: (.+)$/gm)];
      assert.ok(runners.length > 0, path);
      for (const [, runner] of runners) assert.equal(runner, "ubuntu-24.04", path);
      assert.doesNotMatch(source, /self-hosted|NJPBS_CI_.*ENABLED|SCHEDULE_BAKE_FLEET_MONITOR/, path);
    }
  });

  it("preserves the supported deployment queue setting", () => {
    for (const name of ["cms-dev-publish", "cms-publish", "pages"]) {
      const source = readRepo(`.github/workflows/${name}.yml`);
      assert.match(source, /^  queue: max$/m);
      assert.match(source, /^  cancel-in-progress: false$/m);
    }
  });

  it("keeps validation read-only and without deployment secrets", () => {
    for (const name of ["ci", "admin-ci", "firebase-ci", "pages-fallback-safety", "dev-anonymous-refusal"]) {
      const source = readRepo(`.github/workflows/${name}.yml`);
      assert.match(source, /permissions:\n\s+contents: read/);
      assert.doesNotMatch(source, /\bsecrets\s*[.[]/);
      assert.doesNotMatch(source, /\bsecrets:\s*inherit\b/);
    }
  });

  it("uses supported sandboxed system Chrome for accessibility", () => {
    const site = readRepo(".github/workflows/ci.yml");
    const floor = site.indexOf("- name: Verify hosted Chrome security floor");
    assert.ok(floor > -1);
    assert.match(site, /set -euo pipefail\n\s+chrome_version="\$\(google-chrome --product-version\)"\n\s+dpkg --compare-versions "\$chrome_version" ge 156\.0\.8078\.73/);
    for (const consumer of ["Browser interactions over coming-soon build", "Accessibility scan over full build"]) {
      assert.ok(site.indexOf(`- name: ${consumer}`) > floor, consumer);
    }
    assert.match(site, /python3 -m pip install -r qa\/requirements\.txt/);
    assert.doesNotMatch(site, /python3 -m playwright install|chrome-for-testing-public|PLAYWRIGHT_CHROMIUM_EXECUTABLE/);
    for (const path of ["qa/axe_scan.py", "qa/axe_scan_browser_test.py"]) {
      const launch = readRepo(path).match(/chromium\.launch\(([^)]*)\)/)?.[1];
      assert.ok(launch, path);
      assert.match(launch, /channel="chrome"/, path);
      assert.match(launch, /chromium_sandbox=True/, path);
      assert.doesNotMatch(launch, /executable_path|--no-sandbox|--disable-\S*sandbox/, path);
    }
  });

  it("validates browser dependencies, version and sandbox for every panel consumer", () => {
    const admin = readRepo(".github/workflows/admin-ci.yml");
    assert.match(admin, /node \.github\/scripts\/ensure-panel-browser-deps\.mjs/);
    assert.match(readRepo(".github/workflows/cms-staging-deploy.yml"), /node "\$RUNNER_TEMP\/cms-smoke-gate"\/\.github\/scripts\/ensure-panel-browser-deps\.mjs/);
    assert.match(admin, /Ensure supported sandboxed Chrome for the built boot check/);
    assert.match(readRepo(".github/workflows/firebase-ci.yml"), /node \.github\/scripts\/ensure-panel-browser-deps\.mjs/);
    const helper = readRepo(".github/scripts/ensure-panel-browser-deps.mjs");
    assert.match(helper, /ensureRuntimeDependencies\(chromiumRuntimePackages\)/);
    assert.match(helper, /chromiumSandbox: true/);
    assert.match(helper, /: \{ channel: "chrome" \}/);
    assert.match(helper, /await verifyBrowserSafety\(browser\)/);
    assert.match(readRepo("scripts/cms-debug-browser.mjs"), /const MINIMUM_BROWSER_VERSION = "156\.0\.8078\.73";/);
  });

  it("keeps the approved sandboxed headless browser for visual baselines", () => {
    const visual = readRepo(".github/workflows/admin-ci.yml").split("\n  admin-visual:\n")[1].split("\n  admin-visual-complete:\n")[0];
    assert.match(visual, /npx --yes --package=@playwright\/test@1\.65\.0 playwright install --with-deps chromium/);
    // A cache hit installs only system packages, for the same pinned Playwright release.
    assert.match(visual, /if: runner\.environment == 'github-hosted' && steps\.visual-browser-cache\.outputs\.cache-hit != 'true'\n        run: npx --yes --package=@playwright\/test@1\.65\.0 playwright install --with-deps chromium/);
    assert.match(visual, /if: runner\.environment == 'github-hosted' && steps\.visual-browser-cache\.outputs\.cache-hit == 'true'\n        run: npx --yes --package=@playwright\/test@1\.65\.0 playwright install-deps chromium/);
    assert.match(visual, /PLAYWRIGHT_CHROMIUM_EXECUTABLE=\$HOME\/\.cache\/ms-playwright\/chromium_headless_shell-1254\/chrome-headless-shell-linux64\/chrome-headless-shell/);
    assert.doesNotMatch(visual, /chrome-for-testing-public/);
    assert.match(visual, /executablePath: process\.env\.PLAYWRIGHT_CHROMIUM_EXECUTABLE, headless: true, chromiumSandbox: true/);
    assert.match(visual, /assert\.equal\(realpathSync\(`\$\{processPath\}\/exe`\), realpathSync\(process\.env\.PLAYWRIGHT_CHROMIUM_EXECUTABLE\)\)/);
    assert.match(visual, /assert\.ok\(!commandLine\.includes\('--no-sandbox'\)/);
    const suite = visual.indexOf("- name: Admin visual regression");
    for (const step of ["Select approved visual browser", "Ensure supported sandboxed visual browser", "Verify visual browser sandbox and executable"]) {
      const index = visual.indexOf(`- name: ${step}`);
      assert.ok(index > -1 && index < suite, step);
    }
    assert.match(readRepo("admin/playwright.config.ts"), /chromiumSandbox: true/);
  });

  it("keeps explicit npm caching for the main consumers", () => {
    for (const name of ["ci", "admin-ci", "firebase-ci"]) {
      const setups = readRepo(`.github/workflows/${name}.yml`).split(/\n      - /)
        .filter(step => step.startsWith("uses: actions/setup-node@v7"));
      assert.ok(setups.length > 0);
      for (const step of setups) {
        assert.match(step, /^          cache: npm$/m);
        assert.match(step, /^          package-manager-cache: true$/m);
        assert.match(step, /^          cache-dependency-path:/m);
      }
    }
  });
});

describe("Admin visual shard completeness", () => {
  const workflow = readRepo(".github/workflows/admin-ci.yml");
  const visual = workflow.split("\n  admin-visual:\n")[1].split("\n  admin-visual-complete:\n")[0];
  const complete = workflow.split("\n  admin-visual-complete:\n")[1];
  const command = complete.split("        run: |\n")[1];

  it("runs four independent shards with distinct evidence and unchanged capture settings", () => {
    assert.match(visual, /fail-fast: false\n\s+matrix:\n\s+shard: \[1, 2, 3, 4\]/);
    assert.match(visual, /npm run test:visual -w njpbs-admin -- --fully-parallel --shard=\$\{\{ matrix.shard \}\}\/4/);
    for (const name of ["admin-visual-diffs", "report-progress-evidence"]) {
      assert.match(visual, new RegExp(`name: ${name}-\\$\\{\\{ matrix.shard \\}\\}`));
    }
    for (const shard of [1, 2, 3, 4]) {
      assert.ok(visual.includes(`shard-${shard}: \${{ steps.complete.outputs.shard-${shard} }}`));
      assert.ok(complete.includes(`SHARD_${shard}: \${{ needs.admin-visual.outputs.shard-${shard} }}`));
    }
    assert.match(visual, /id: complete\n\s+run: echo "shard-\$\{\{ matrix.shard \}\}=success" >> "\$GITHUB_OUTPUT"/);
    assert.match(complete, /needs: \[admin-visual\]\n\s+if: \$\{\{ !cancelled\(\) \}\}/);
    const config = readRepo("admin/playwright.config.ts");
    assert.match(config, /workers: 1,/);
    assert.match(config, /retries: 0,/);
  });

  it("accepts only four successful shards, including when the matrix result says success", () => {
    const success = { RESULT: "success", SHARD_1: "success", SHARD_2: "success", SHARD_3: "success", SHARD_4: "success" };
    const run = (env) => spawnSync("bash", ["-e", "-c", command], { env: { ...process.env, ...env } }).status;
    assert.equal(run(success), 0);
    for (const result of ["failure", "skipped", "cancelled", ""]) {
      assert.notEqual(run({ ...success, RESULT: result }), 0);
      for (const shard of [1, 2, 3, 4]) {
        assert.notEqual(run({ ...success, [`SHARD_${shard}`]: result }), 0);
      }
    }
  });
});

it("anonymous refusal monitor imports from exactly its declared checkout", () => {
  const source = readRepo(".github/workflows/dev-anonymous-refusal.yml");
  const monitor = source.split("\n  refusal:\n")[1]?.split(/\n  [\w-]+:\n/)[0];
  assert.ok(monitor, "Missing refusal monitor job");
  const checkout = monitor.split("\n      - ").find(step => step.startsWith("uses: actions/checkout@"));
  assert.ok(checkout, "Missing monitor checkout");
  assert.doesNotMatch(checkout, /^\s+path:/m, "Monitor must check out into the workspace root");
  const sparse = checkout.match(/sparse-checkout: \|\n((?:            .+\n)+)/);
  assert.ok(sparse || !/^\s+sparse-checkout:/m.test(checkout), "Unsupported monitor sparse-checkout format");
  const tracked = spawnSync("git", ["ls-files", "-z"], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)), encoding: "utf8",
  });
  assert.equal(tracked.status, 0, tracked.stderr);
  const paths = sparse ? sparse[1].trim().split(/\s+/) : tracked.stdout.split("\0").filter(Boolean);
  const directory = mkdtempSync(join(tmpdir(), "refusal-checkout-"));
  try {
    for (const path of paths) {
      assert.ok(!path.startsWith("/") && !path.split("/").includes(".."));
      const destination = join(directory, path);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), destination);
    }
    const result = spawnSync(process.execPath, ["--input-type=module", "-e",
      "globalThis.fetch = () => { throw new Error('No network during import'); }; await import('./scripts/check-dev-anonymous-refusal.mjs');"], {
      cwd: directory, encoding: "utf8", timeout: 5_000,
      env: { PATH: process.env.PATH, CMS_DEV_ACCESS_ORIGIN: "https://access.example.org" },
    });
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
