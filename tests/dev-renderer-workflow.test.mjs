import { repositoryFixture } from "./helpers/repository-identity.mjs";
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { execFileSync } from "node:child_process";
const { parse } = createRequire(import.meta.url)("yaml");
const workflow = parse(readFileSync(new URL("../.github/workflows/cms-dev-deploy.yml", import.meta.url), "utf8"));
const defaults = { release_preview_renderer: false, renderer_only: false, renderer_source_sha: "", preserve_preview_pause: false,
  restore_preview_bootstrap: false, install_reader_bridge: false };
const github = { repository: repositoryFixture.CANONICAL_GITHUB_REPOSITORY, repository_id: repositoryFixture.CANONICAL_GITHUB_REPOSITORY_ID, ref: "refs/heads/main", actor: "fixture-user", triggering_actor: "fixture-user",
  workflow_ref: "CenterCoopMedia/njpbs/.github/workflows/cms-dev-deploy.yml@refs/heads/main" };
function selected(job, inputs, result, actor = github, configuration = repositoryFixture) {
  const expression = workflow.jobs[job].if.replaceAll("needs.preview-renderer.", "needs['preview-renderer'].");
  return Boolean(runInNewContext(expression, { inputs: { ...defaults, ...inputs }, github: actor, vars: { ...configuration, CMS_DEPLOY_OWNER: "fixture-user" },
    format: (template, ...values) => template.replace(/\{(\d+)\}/g, (_, index) => values[Number(index)]),
    needs: { "preview-renderer": { result } }, always: () => true, cancelled: () => false }));
}

it.each([false, true])("skips all CMS/API/Admin jobs for renderer-only requests (pause=%s)", preserve => {
  const inputs = { release_preview_renderer: true, renderer_only: true, renderer_source_sha: "a".repeat(40), preserve_preview_pause: preserve };
  expect(selected("preview-renderer", inputs, "success")).toBe(true);
  expect(selected("deploy", inputs, "success")).toBe(false);
});
it("keeps restoration isolated and retains the ordinary skipped-renderer deployment", () => {
  const restore = { release_preview_renderer: true, renderer_only: true, renderer_source_sha: "a".repeat(40),
    preserve_preview_pause: true, restore_preview_bootstrap: true };
  expect(selected("preview-renderer", restore, "success")).toBe(true);
  expect(selected("deploy", restore, "success")).toBe(false);
  expect(selected("preview-renderer", {}, "skipped")).toBe(false);
  expect(selected("deploy", {}, "skipped")).toBe(true);
  expect(selected("deploy", { release_preview_renderer: true }, "success")).toBe(true);
});
it.each([{ renderer_only: true }, { renderer_source_sha: "invalid" }, { renderer_source_sha: "0" }, { renderer_source_sha: "false" },
  { preserve_preview_pause: true }, { restore_preview_bootstrap: true }])
  ("routes malformed new input %j to credential-free validation rather than silently skipping it", inputs => {
    expect(selected("preview-renderer", inputs, "failure")).toBe(true);
    expect(selected("deploy", inputs, "failure")).toBe(false);
  });
it.each([{ repository_id: "1" }, { actor: "untrusted" }, { triggering_actor: "untrusted" }, { ref: "refs/heads/feature" },
  { workflow_ref: "example-owner/untrusted/.github/workflows/cms-dev-deploy.yml@refs/heads/main" }])
  ("keeps real hosted main actor guards for %j", changed => {
    const actor = { ...github, ...changed };
    expect(selected("preview-renderer", { release_preview_renderer: true }, "success", actor)).toBe(false);
    expect(selected("deploy", {}, "skipped", actor)).toBe(false);
  });
it("keeps the real shell release script valid, including its receipt-source heredoc", () => {
  const release = workflow.jobs["preview-renderer"].steps.find(step => step.id === "ready");
  expect(() => execFileSync("bash", ["-n"], { input: release.run, stdio: ["pipe", "pipe", "pipe"] })).not.toThrow();
});
it("scans first-party source before executing provenance code or opening release credentials", () => {
  const action = parse(readFileSync(new URL("../.github/actions/dev-deploy-source-gates/action.yml", import.meta.url), "utf8"));
  const steps = workflow.jobs["preview-renderer"].steps.flatMap(step => step.uses === "./.dev-deploy-gate/.github/actions/dev-deploy-source-gates" ? action.runs.steps : [step]);
  const scan = steps.findIndex(step => step.run?.startsWith("node .dev-deploy-gate/.github/scripts/metered-api-scan.mjs --target-root"));
  const provenance = steps.findIndex(step => step.run === "node .github/scripts/check-dev-renderer-release-source.mjs");
  expect(scan).toBeGreaterThanOrEqual(0);
  expect(provenance).toBeGreaterThan(scan);
  expect(steps.findIndex(step => step.id === "ready")).toBeGreaterThan(provenance);
});

it.each([
  { ...repositoryFixture, CANONICAL_GITHUB_REPOSITORY: "" },
  { ...repositoryFixture, CANONICAL_GITHUB_REPOSITORY_ID: "" },
  { ...repositoryFixture, CANONICAL_GITHUB_REPOSITORY: "other/repository" },
  { ...repositoryFixture, CANONICAL_GITHUB_REPOSITORY_ID: "1" },
])("refuses empty or wrong configured repository admission %j", configuration => {
  expect(selected("preview-renderer", { release_preview_renderer: true }, "success", github, configuration)).toBe(false);
  expect(selected("deploy", {}, "skipped", github, configuration)).toBe(false);
});
