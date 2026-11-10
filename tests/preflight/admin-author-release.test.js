import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../../scripts/deploy-admin.sh", import.meta.url), "utf8");
const selection = source.match(/^author_profile_release_selection\(\) \{[\s\S]*?^\}/m)?.[0];
const config = source.match(/^admin_config_state\(\) \{[\s\S]*?^\}/m)?.[0];
const buildGate = source.match(/^gate_build_config\(\) \{[\s\S]*?^\}/m)?.[0];
const preCredentials = source.slice(source.indexOf('if [[ "${ADMIN_DEPLOY_CHECK:-}" == "1" ]]; then'), source.indexOf("# --- credentials"));
const build = source.slice(source.indexOf('echo "building admin/dist ..."'), source.indexOf('\nif [[ ! -f admin/dist/index.html ]]'));

function runFixture(value, { ambient = "true", repo = "CenterCoopMedia/njpbs", fail = false, environment, organization, check = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "admin-author-release-"));
  try {
    mkdirSync(join(directory, "admin/public"), { recursive: true });
    mkdirSync(join(directory, "scripts/lib"), { recursive: true });
    mkdirSync(join(directory, "bin"));
    for (const path of ["admin/public/_headers", "admin/index.html", "scripts/lib/admin-public-shell.mjs"]) {
      copyFileSync(new URL(`../../${path}`, import.meta.url), join(directory, path));
    }
    writeFileSync(join(directory, "admin/.env.production"), [
      "VITE_FIREBASE_API_KEY=synthetic-api-key", "VITE_FIREBASE_APP_ID=synthetic-app",
      "VITE_FIREBASE_AUTH_DOMAIN=njpbs-site.firebaseapp.com", "VITE_FIREBASE_PROJECT_ID=njpbs-site",
      "VITE_FIREBASE_APPCHECK_SITE_KEY=synthetic-site-key", "VITE_FUNCTIONS_BASE_URL=https://api.example.org",
      "VITE_AUTHOR_PAGES_LIVE=true",
    ].join("\n"));
    writeFileSync(join(directory, "bin/npm"), '#!/bin/sh\nprintf "%s|%s|%s" "$VITE_AUTHOR_PAGES_LIVE" "${GH_TOKEN+present}" "${GITHUB_TOKEN+present}"\n');
    chmodSync(join(directory, "bin/npm"), 0o700);
    return spawnSync("bash", ["--noprofile", "--norc", "-s"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${directory}/bin:${process.env.PATH}`, FIXTURE_DIR: directory,
        FIXTURE_VALUE: value === undefined ? "" : JSON.stringify(value), FIXTURE_REPO: repo, FIXTURE_FAIL: String(fail),
        FIXTURE_ENVIRONMENT: environment === undefined ? "" : JSON.stringify(environment),
        FIXTURE_ORGANIZATION: organization === undefined ? "" : JSON.stringify(organization),
        ADMIN_DEPLOY_CHECK: check ? "1" : "",
        VITE_AUTHOR_PAGES_LIVE: ambient, GH_TOKEN: "synthetic", GITHUB_TOKEN: "synthetic" },
      input: `set -euo pipefail
repo_root="$FIXTURE_DIR"
CANONICAL_REPO=CenterCoopMedia/njpbs
FIREBASE_PROJECT=njpbs-site
die() { printf '%s\\n' "$1" >&2; exit 1; }
gh() {
  if [[ "$1" == api && "$2" == repos/CenterCoopMedia/njpbs ]]; then printf '%s' "$FIXTURE_REPO";
  elif [[ "$1" == api && "$2" == --paginate && "$3" == repos/CenterCoopMedia/njpbs/environments/production/variables?per_page=100 ]]; then
    printf '%s' "$FIXTURE_ENVIRONMENT"
  elif [[ "$1" == api && "$2" == --paginate && "$3" == repos/CenterCoopMedia/njpbs/actions/organization-variables?per_page=100 ]]; then
    printf '%s' "$FIXTURE_ORGANIZATION"
  elif [[ "$1" == api && "$2" == --paginate && "$3" == repos/CenterCoopMedia/njpbs/actions/variables?per_page=100 ]]; then
    [[ "$FIXTURE_FAIL" != true ]] || return 1
    printf '%s' "$FIXTURE_VALUE"
  else return 1; fi
  printf '%s' selected > "$FIXTURE_DIR/selection-checked"
}
${selection}
${config}
${buildGate}
gate_reviewed_code() { :; }
gate_staff_admission_backend() { :; }
prepare_admin_status_manifest() { printf '%s' synthetic-manifest; }
pass() {
  [[ -f "$FIXTURE_DIR/selection-checked" ]] || die "credential accessed before release selection"
  printf '%s\\n' credential-sentinel
}
${preCredentials}
pass show synthetic
${build}
`,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("standalone Admin authoritative author release", () => {
  it.each([[undefined, "false"], ["", "false"], ["false", "false"], ["true", "true"], ["TRUE", "false"], [" true ", "false"], ["true\n", "false"], ["true\r\n", "false"]])(
    "builds repository selection %s as %s despite stale shell/local Vite inputs", (value, expected) => {
      const result = runFixture(value, { ambient: expected === "true" ? "false" : "true" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("credential-sentinel");
      expect(result.stdout).toContain(`${expected}||`);
      if (value === undefined || value === "true") {
        const checked = runFixture(value, { check: true, ambient: expected === "true" ? "false" : "true" });
        expect(checked.status, checked.stderr).toBe(0);
        expect(checked.stdout).toContain("gate 2, real build config: pass");
        expect(checked.stdout).not.toContain("credential-sentinel");
        expect(checked.stdout).not.toContain("building admin/dist");
      }
    });
  it("refuses unreadable variables before building instead of assuming absent/off", () => {
    const result = runFixture("true", { fail: true });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("could not read the author publication switch");
    expect(result.stdout).not.toContain("building admin/dist");
  });
  it("refuses a different repository identity before building", () => {
    const result = runFixture("true", { repo: "other/repository" });
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("building admin/dist");
  });
  it.each([
    ["true", "false", "false", "false"],
    ["false", "true", "false", "true"],
    ["true", "", "true", "false"],
    [undefined, undefined, "true", "true"],
    ["false", undefined, "true", "false"],
    ["true", "true\n", "true", "false"],
  ])("matches production scope precedence (%s, %s, %s)", (repository, environment, organization, expected) => {
    const result = runFixture(repository, { environment, organization });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`${expected}||`);
  });

});
