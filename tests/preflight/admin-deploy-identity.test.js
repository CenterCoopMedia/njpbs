import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { decideRelease } from "../../scripts/lib/cms-release-plan.mjs";
import { releasePlanOutputLines } from "../../scripts/cms-release-plan.mjs";

const workflow = parse(readFileSync(new URL("../../.github/workflows/cms-staging-deploy.yml", import.meta.url), "utf8"));
const admin = workflow.jobs["admin-deploy"];
const deploySha = "a".repeat(40);
const liveFunctionsSha = "b".repeat(40);
const liveRendererSha = "c".repeat(40);

function expectedSha(step, variable, mutated, liveSha, rendererTargetSha = liveSha) {
  const outputs = {
    functions_mutated: String(mutated),
    live_functions_sha: liveSha,
    renderer_target_sha: rendererTargetSha,
  };
  const available = {
    "admin-build": { outputs: { deploy_sha: deploySha } },
    "firebase-preflight": { outputs },
  };
  const needs = Object.fromEntries(admin.needs.map(job => [job, available[job] ?? {}]));
  const expression = step.env[variable].slice(3, -2).replace(/needs\.([\w-]+)/g, 'needs["$1"]');
  return runInNewContext(expression, { needs });
}

function recheck(step, variable, sha) {
  // Replace the external receipt CLI with an argument recorder. An empty SHA
  // must fail before that process can omit its optional SHA comparison.
  const directory = mkdtempSync(join(tmpdir(), "admin-identity-"));
  try {
    return spawnSync("bash", ["--noprofile", "--norc", "-c", `
      node() { printf '%s\\n' "$@"; }
      ${step.run}
    `], { env: { PATH: process.env.PATH, [variable]: sha, SA: "fixture-account",
      GOOGLE_APPLICATION_CREDENTIALS: join(directory, "firebase-service-account.json") }, encoding: "utf8" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("Admin upload component identity boundary", () => {
  it("checks the legacy preview protocol before preflight and Firebase provider mutations", () => {
    const preflight = workflow.jobs["firebase-preflight"];
    const before = (job, first, next) => {
      const at = job.steps.findIndex(step => step.name === first);
      expect(at).toBeGreaterThan(-1);
      expect(job.steps.findIndex(step => step.name === next)).toBeGreaterThan(at);
    };
    before(preflight, "Require the legacy preview protocol before provider mutations", "Set up Google Cloud CLI");
    before(workflow.jobs.firebase, "Require the legacy preview protocol before Firebase mutation", "Pause cloud preview admission before changing Functions");
    expect(workflow.jobs.firebase.steps.find(step => step.name === "Pause cloud preview admission before changing Functions").if).toContain("preview_protocol == 'schema-one'");
    expect(preflight.outputs.preview_protocol).toContain("release_plan.outputs.preview_protocol");
  });
  it.each([0, 7])("removes the step-local ADC file after receipt CLI exit %s", exitCode => {
    const step = admin.steps.find(step => step.name === "Recheck live Functions identity before Admin upload");
    const directory = mkdtempSync(join(tmpdir(), "admin-adc-"));
    const credentials = join(directory, "firebase-service-account.json");
    const githubEnv = join(directory, "github-env");
    try {
      const result = spawnSync("bash", ["--noprofile", "--norc", "-c", `
        node() {
          test -f "$GOOGLE_APPLICATION_CREDENTIALS" || return 91
          test "$(cat "$GOOGLE_APPLICATION_CREDENTIALS")" = "$SA" || return 92
          test "$(stat -c '%a' "$GOOGLE_APPLICATION_CREDENTIALS")" = 600 || return 93
          return ${exitCode}
        }
        ${step.run}
      `], { env: { PATH: process.env.PATH, LIVE_FUNCTIONS_SHA: liveFunctionsSha,
        SA: "fixture-account", GOOGLE_APPLICATION_CREDENTIALS: credentials, GITHUB_ENV: githubEnv }, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(exitCode);
      expect(existsSync(credentials)).toBe(false);
      expect(existsSync(githubEnv) ? readFileSync(githubEnv, "utf8") : "").toBe("");
      expect(result.stdout).toBe("");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  for (const [component, name, variable, liveSha] of [
    ["functions", "Recheck live Functions identity before Admin upload", "LIVE_FUNCTIONS_SHA", liveFunctionsSha],
    ["renderer", "Recheck live renderer identity before Admin upload", "RENDERER_TARGET_SHA", liveRendererSha],
  ]) {
    const step = admin.steps.find(step => step.name === name);

    it(`${component}: confirms the selected live SHA for an Admin-only release`, () => {
      const sha = expectedSha(step, variable, false, liveSha);
      expect(sha).toBe(liveSha);
      const result = recheck(step, variable, sha);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim().split("\n")).toEqual([
        "scripts/component-runner.mjs", component, "confirm", "--source-sha", liveSha,
      ]);
    });

    it(`${component}: confirms the newly deployed SHA for force_firebase, including a first release`, () => {
      const emitted = Object.fromEntries(releasePlanOutputLines(decideRelease({ forceFirebase: true }), {
        deploySha, edgeFingerprint: "d".repeat(64), configurationFingerprint: "e".repeat(64), variablesFingerprint: "f".repeat(64),
      }).map(line => { const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)]; }));
      for (const previousSha of [liveSha, ""]) {
        // Exercise the real planner output before the workflow expression.
        const sha = expectedSha(step, variable, true, previousSha, emitted.renderer_target_sha);
        expect(sha).toBe(deploySha);
        const result = recheck(step, variable, sha);
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout.trim().split("\n").at(-1)).toBe(deploySha);
      }
    });

    it(`${component}: honors the renderer plan separately from a Functions mutation`, () => {
      const sha = expectedSha(step, variable, true, liveSha, liveRendererSha);
      const expected = component === "functions" ? deploySha : liveRendererSha;
      expect(sha).toBe(expected);
      const result = recheck(step, variable, sha);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim().split("\n").at(-1)).toBe(expected);
    });

    it(`${component}: rejects a missing preflight SHA before invoking the receipt CLI`, () => {
      const sha = expectedSha(step, variable, false, "");
      expect(sha).toBe("");
      const result = recheck(step, variable, sha);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("source SHA is required before Admin upload");
    });
  }
});
