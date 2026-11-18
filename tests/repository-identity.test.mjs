import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { repositoryIdentity, repositoryMatches, workflowMatches } from "../scripts/lib/repository-identity.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const configured = { CANONICAL_GITHUB_REPOSITORY: "example-org/example-repo", CANONICAL_GITHUB_REPOSITORY_ID: "123456" };

test("identity requires independent name and ID configuration and refuses mismatches", () => {
  for (const env of [{}, { ...configured, CANONICAL_GITHUB_REPOSITORY: "" },
    { ...configured, CANONICAL_GITHUB_REPOSITORY_ID: "" },
    { ...configured, CANONICAL_GITHUB_REPOSITORY_ID: "0" },
    { ...configured, CANONICAL_GITHUB_REPOSITORY: "REPLACE_ME/site" }]) {
    assert.throws(() => repositoryIdentity(env));
    assert.equal(repositoryMatches(configured.CANONICAL_GITHUB_REPOSITORY, env), false);
    assert.equal(workflowMatches("undefined/.github/workflows/ci.yml@refs/heads/main", "ci.yml", env), false);
  }
  assert.equal(repositoryMatches("other/site", configured, "123456"), false);
  assert.equal(repositoryMatches(configured.CANONICAL_GITHUB_REPOSITORY, configured, "42"), false);
  assert.equal(repositoryMatches(configured.CANONICAL_GITHUB_REPOSITORY, configured, "123456"), true);
  assert.equal(workflowMatches("example-org/example-repo/.github/workflows/ci.yml@refs/heads/main", "ci.yml", configured), true);
});

test("canonical URL authorization refuses absent configuration and foreign hosts or repositories", () => {
  for (const [env, url, allowed] of [
    [{}, "https://github.com/example-org/example-repo.git", false],
    [{ ...configured, CANONICAL_GITHUB_REPOSITORY_ID: "" }, "https://github.com/example-org/example-repo.git", false],
    [configured, "https://github.com/other/site.git", false],
    [configured, "https://evil.example/@github.com/example-org/example-repo.git", false],
    [configured, "git@github.com:Example-Org/Example-Repo.git", true],
  ]) {
    const result = spawnSync("bash", ["-c", 'source scripts/lib/canonical-repo.sh; canonical_repo_matches_configured_url "$1"', "_", url],
      { cwd: root, env: { PATH: process.env.PATH, ...env }, encoding: "utf8" });
    assert.equal(result.status, allowed ? 0 : 1, result.stderr);
  }
});

test("CI proof and reuse refuse empty or wrong configured identity before API access", async () => {
  const { requireReleaseCi } = await import("../.github/scripts/require-main-ci.mjs");
  const { findReusableRun } = await import("../.github/scripts/ci-tree-reuse.mjs");
  for (const env of [{}, { ...configured, CANONICAL_GITHUB_REPOSITORY: "" },
    { ...configured, CANONICAL_GITHUB_REPOSITORY: "other/site" }]) {
    const request = () => { throw new Error("API must not be reached"); };
    await assert.rejects(requireReleaseCi({ repository: "example-org/example-repo", sha: "a".repeat(40), env, request }), /identity refused/);
    assert.deepEqual(await findReusableRun({ repository: "example-org/example-repo", env, request }), { reused: "false" });
  }
});
