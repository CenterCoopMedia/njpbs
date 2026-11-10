import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

const ADMIN_SRC = fileURLToPath(new URL("../../admin/src/", import.meta.url));
const ADMIN_DEPLOY = fileURLToPath(
  new URL("../../scripts/deploy-admin.sh", import.meta.url),
);

function sourceFilesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFilesUnder(path);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

describe("admin public environment boundary", () => {
  it("connects the reviewed author-release switch to the Admin build, defaulting off", () => {
    const workflow = parse(readFileSync(new URL("../../.github/workflows/cms-staging-deploy.yml", import.meta.url), "utf8"));
    const build = workflow.jobs["admin-build"].steps.find((step) => step.name === "Build admin app");
    expect(build.env.VITE_AUTHOR_PAGES_LIVE).toBe("${{ vars.AUTHOR_PAGES_LIVE || 'false' }}");
  });

  it("never expands the whole Vite environment object into the client bundle", () => {
    const offenders = sourceFilesUnder(ADMIN_SRC)
      .filter((path) =>
        readFileSync(path, "utf8")
          .split("\n")
          .filter((line) => {
            const trimmed = line.trimStart();
            return !trimmed.startsWith("//") && !trimmed.startsWith("*");
          })
          .some((line) => /import\.meta\.env(?!\s*\.)/.test(line)),
      )
      .map((path) => path.slice(ADMIN_SRC.length));

    expect(
      offenders,
      "Whole-object import.meta.env reads serialize every VITE_* value, including " +
        "retired exact-email settings left in a shell or gitignored env file.",
    ).toEqual([]);
  });

  it.each([
    ["401", "403", 0, "both navigation boundaries are ready"],
    ["404", "403", 1, "the edge route is absent"],
    ["401", "404", 1, "the Function is absent"],
    ["401", "500", 1, "the Function fails at startup"],
    ["401", "000", 1, "the Function cannot be reached"],
  ])("checks navigation edge %s and origin %s before upload (%s: %s)", (edgeStatus, originStatus, expected, _reason) => {
    const source = readFileSync(ADMIN_DEPLOY, "utf8");
    const gate = source.match(/^gate_staff_admission_backend\(\) \{[\s\S]*?^\}/m)?.[0];
    expect(gate).toBeTruthy();
    const directory = mkdtempSync(join(tmpdir(), "admin-backend-gate-"));
    const receipts = join(directory, "requests");
    try {
      // Fake only the curl/network boundary. Execute the deployment's real gate
      // in an isolated shell; no credentials, build, or deployment can run here.
      const result = spawnSync("bash", ["-s", "--", edgeStatus, originStatus, receipts], {
        encoding: "utf8",
        input: `set -euo pipefail
FIREBASE_PROJECT=njpbs-site
edge_status="$1"
origin_status="$2"
receipts="$3"
admin_functions_url() { printf '%s' 'https://cms-api.example.test'; }
die() { printf '%s\\n' "$1" >&2; exit 1; }
curl() {
  local url="\${!#}"
  printf '%s\\n' "$url" >> "$receipts"
  printf '%s\\n' "$@" >> "$receipts.args"
  case "$url" in
    https://cms-api.example.test/cmsSetNavigationPreferences) printf '%s' "$edge_status" ;;
    https://us-central1-njpbs-site.cloudfunctions.net/cmsSetNavigationPreferences) printf '%s' "$origin_status" ;;
    *) printf '%s' '401' ;;
  esac
}
${gate}
gate_staff_admission_backend
`,
      });
      expect(result.status, result.stderr).toBe(expected);
      const requests = readFileSync(receipts, "utf8").trim().split("\n");
      expect(requests).toEqual([
        ...["registerStaffProfile", "submitStaffAccessRequest", "cmsGetBroadcastSchedule", "cmsSetNavigationPreferences"]
          .map(endpoint => `https://cms-api.example.test/${endpoint}`),
        ...(edgeStatus === "401" ? ["https://us-central1-njpbs-site.cloudfunctions.net/cmsSetNavigationPreferences"] : []),
      ]);
      expect(readFileSync(`${receipts}.args`, "utf8")).not.toMatch(/authorization/i);
      if (expected !== 0) expect(result.stderr).toContain("cmsSetNavigationPreferences is not ready");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses a rollback that predates the public authentication shell", () => {
    const source = readFileSync(ADMIN_DEPLOY, "utf8");
    const gate = source.match(/^gate_build_config\(\) \{[\s\S]*?^\}/m)?.[0];
    expect(gate).toBeTruthy();
    const directory = mkdtempSync(join(tmpdir(), "admin-shell-rollback-"));
    try {
      for (const missing of ["admin/public/_headers", "admin/index.html", "scripts/lib/admin-public-shell.mjs"]) {
        const result = spawnSync("bash", ["--noprofile", "--norc", "-s"], {
          cwd: directory,
          encoding: "utf8",
          input: `set -euo pipefail
repo_root="$PWD"
ADMIN_DEPLOY_ROLLBACK=1
ADMIN_DEPLOY_ALLOW_UNREVIEWED=1
mkdir -p admin/public scripts/lib
printf '%s' synthetic > admin/public/_headers
printf '%s' synthetic > admin/index.html
printf '%s' synthetic > scripts/lib/admin-public-shell.mjs
rm "${missing}"
die() { printf '%s\n' "$*" >&2; exit 1; }
author_profile_release_selection() { printf '%s\n' 'unexpected configuration access' >&2; exit 97; }
admin_config_state() { printf '%s\n' 'unexpected configuration access' >&2; exit 97; }
pass() { printf '%s\n' 'unexpected credential access' >&2; exit 98; }
${gate}
gate_build_config
pass show synthetic
`,
        });
        expect(result.error).toBeUndefined();
        expect(result.status, `${missing}: ${result.stderr}`).toBe(1);
        expect(result.stderr).toContain("predates the public authentication-shell safety boundary");
        expect(result.stderr).not.toContain("unexpected configuration access");
        expect(result.stderr).not.toContain("unexpected credential access");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

const root = resolve(".");
const sha = "a".repeat(40);
const newer = "b".repeat(40);
const directories = [];
afterEach(() => directories.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

function probe({ env = {}, ci = "success" } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "admin-pin-"));
  directories.push(directory);
  const bin = join(directory, "bin"), requests = join(directory, "requests");
  mkdirSync(bin);
  const checkout = join(directory, "source");
  mkdirSync(join(checkout, "admin"), { recursive: true });
  mkdirSync(join(checkout, "scripts"));
  mkdirSync(join(checkout, "config"));
  copyFileSync(join(root, "scripts/render-development-config.mjs"), join(checkout, "scripts/render-development-config.mjs"));
  copyFileSync(join(root, "config/development-inputs.json"), join(checkout, "config/development-inputs.json"));
  symlinkSync(join(root, "scripts/check-admin-release-ci.mjs"), join(checkout, "scripts/check-admin-release-ci.mjs"));
  writeFileSync(join(checkout, "admin/index.html"), "Reviewed Admin fixture\n");
  const git = args => execFileSync("/usr/bin/git", args, { cwd: checkout, stdio: "ignore" });
  git(["init", "-q"]);
  git(["add", "."]);
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "Reviewed Admin fixture"]);
  if (env.FIXTURE_DIRTY) writeFileSync(join(checkout, "admin/index.html"), "Unreviewed Admin edit\n");
  writeFileSync(join(bin, "git"), `#!/bin/bash
case "$*" in
  'status --porcelain') printf '%s' "$FIXTURE_DIRTY" ;;
  'ls-remote --get-url origin') printf '%s\\n' "$FIXTURE_ORIGIN" ;;
  'fetch --quiet origin main') exit "$FIXTURE_FETCH_STATUS" ;;
  'rev-parse --verify --quiet origin/main') ;;
  'merge-base --is-ancestor HEAD origin/main') exit "$FIXTURE_ANCESTOR_STATUS" ;;
  'rev-parse HEAD') printf '%s\\n' "$FIXTURE_HEAD" ;;
  'rev-parse origin/main') printf '%s\\n' "$FIXTURE_MAIN" ;;
  *) exit 89 ;;
esac
`, { mode: 0o755 });
  writeFileSync(join(bin, "gh"), `#!${process.execPath}
const fs = require('node:fs');
const endpoint = process.argv[3];
if (endpoint === 'repos/example-owner/example-repo') { console.log(424242); process.exit(0); }
fs.appendFileSync(process.env.FIXTURE_REQUESTS, endpoint + '\\n');
const mode = process.env.FIXTURE_CI;
if (mode === 'api-error') { console.error('private-provider-error'); process.exit(1); }
const sha = '${sha}';
if (endpoint.includes('/jobs?')) {
  const jobs = mode === 'missing-ci-job' ? [] : [{ name: 'ci', run_id: 123, head_sha: sha,
    status: 'completed', conclusion: mode === 'failed-ci-job' ? 'failure' : 'success' }];
  console.log(JSON.stringify({ jobs, total_count: jobs.length }));
} else {
  console.log(JSON.stringify({ workflow_runs: [{ id: 123, event: mode === 'pr-run' ? 'pull_request' : 'push',
    head_branch: 'main', head_sha: mode === 'newer-sha' ? '${newer}' : sha, status: 'completed',
    conclusion: 'success', path: '.github/workflows/ci.yml', repository: { full_name: 'example-owner/example-repo', id: 424242 },
    head_repository: { full_name: 'example-owner/example-repo', id: 424242 } }] }));
}
`, { mode: 0o755 });
  const gate = readFileSync(join(root, "scripts/deploy-admin.sh"), "utf8")
    .match(/^gate_reviewed_code\(\) \{[\s\S]*?^\}/m)[0];
  const result = spawnSync("bash", ["--noprofile", "--norc", "-c", `set -euo pipefail
source "$1"
repo_root="$2"
CANONICAL_REPO="$CANONICAL_GITHUB_REPOSITORY"
CANONICAL_REPO_ID="$CANONICAL_GITHUB_REPOSITORY_ID"
die() { printf '%s\\n' "$1" >&2; exit 1; }
${gate}
gate_reviewed_code`, "_", join(root, "scripts/lib/canonical-repo.sh"), checkout], {
    cwd: checkout, encoding: "utf8", env: {
      PATH: `${bin}:${process.env.PATH}`, FIXTURE_REQUESTS: requests, FIXTURE_CI: ci,
      FIXTURE_HEAD: sha, FIXTURE_MAIN: newer, FIXTURE_DIRTY: "",
      FIXTURE_ORIGIN: "https://github.com/example-owner/example-repo.git",
      CANONICAL_GITHUB_REPOSITORY: "example-owner/example-repo", CANONICAL_GITHUB_REPOSITORY_ID: "424242",
      FIXTURE_FETCH_STATUS: "0", FIXTURE_ANCESTOR_STATUS: "0", ...env,
    },
  });
  return { ...result, requests: (() => { try { return readFileSync(requests, "utf8"); } catch { return ""; } })() };
}

it("accepts an explicit reviewed ancestor with that pin's successful main CI after main advances", () => {
  const result = probe({ env: { ADMIN_DEPLOY_RELEASE_SHA: sha } });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain(`Admin release ${sha} passed main CI run 123.`);
  expect(result.requests).toContain(`branch=main&event=push&status=success&head_sha=${sha}`);
  expect(result.requests).not.toContain(newer);
});

it.each(["newer-sha", "pr-run", "failed-ci-job", "missing-ci-job", "api-error"])(
  "refuses a pin when exact main CI proof is unavailable: %s", ci => {
    const result = probe({ env: { ADMIN_DEPLOY_RELEASE_SHA: sha }, ci });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("selected Admin release requires its own successful main CI");
    expect(result.stderr).toContain(ci === "api-error" ? "CI lookup failed" : "no matching main CI proof");
    expect(result.stderr).not.toContain("private-provider-error");
  },
);

it.each([
  [{ ADMIN_DEPLOY_RELEASE_SHA: "" }, "full commit SHA"],
  [{ ADMIN_DEPLOY_RELEASE_SHA: "main" }, "full commit SHA"],
  [{ ADMIN_DEPLOY_RELEASE_SHA: newer }, "HEAD must equal"],
  [{ FIXTURE_DIRTY: " M admin/index.html" }, "uncommitted changes"],
  [{ FIXTURE_ORIGIN: "https://github.com/elsewhere/repo.git" }, "approved repository"],
  [{ FIXTURE_FETCH_STATUS: "1" }, "could not reach origin"],
  [{ FIXTURE_ANCESTOR_STATUS: "1" }, "not part of origin/main"],
  [{ ADMIN_DEPLOY_ALLOW_UNREVIEWED: "1" }, "cannot use unreviewed or rollback overrides"],
  [{ ADMIN_DEPLOY_ROLLBACK: "1" }, "cannot use unreviewed or rollback overrides"],
])("keeps source refusals ahead of the pin CI lookup: %j", (env, message) => {
  const result = probe({ env: { ADMIN_DEPLOY_RELEASE_SHA: sha, ...env } });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(message);
  expect(result.requests).toBe("");
});

it("keeps ordinary tip deployment available without an explicit pin or extra CI lookup", () => {
  const result = probe({ env: { FIXTURE_MAIN: sha } });
  expect(result.status, result.stderr).toBe(0);
  expect(result.requests).toBe("");
});

it("still refuses an unselected older checkout", () => {
  const result = probe();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("HEAD is behind origin/main");
  expect(result.requests).toBe("");
});
