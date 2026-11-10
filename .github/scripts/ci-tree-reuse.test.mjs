import { repositoryFixture } from "../../tests/helpers/repository-identity.mjs";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findReusableRun, fullJobs, reuseFromEnvironment } from "./ci-tree-reuse.mjs";

const repository = "CenterCoopMedia/njpbs";
const head = "a".repeat(40), before = "b".repeat(40), tree = "c".repeat(40);
const merge = "e".repeat(40);
const inputsHash = "f".repeat(64);
const now = Date.parse("2026-10-17T00:00:00Z");
const iso = (offset) => new Date(now + offset).toISOString();
const mainRun = () => ({
  created_at: iso(-10 * 60 * 1000), updated_at: iso(-60 * 1000),
  id: 123, status: "completed", conclusion: "success", event: "push", head_branch: "main",
  path: ".github/workflows/ci.yml", head_sha: head, head_commit: { id: head, tree_id: tree },
  repository: { id: 1442374012, full_name: repository }, head_repository: { id: 1442374012, full_name: repository },
});
const prRun = () => ({ ...mainRun(), event: "pull_request", head_branch: "feature", pull_requests: [],
  referenced_workflows: ["admin", "firebase"].map((name) => ({
    path: `${repository}/.github/workflows/${name}-ci.yml@${merge}`, sha: merge, ref: "refs/pull/42/merge",
  })),
});
const prMetadata = () => ({ base: { ref: "main", repo: { id: 1442374012 } }, head: { sha: head, repo: { id: 1442374012 } } });
const passedJobs = () => fullJobs.map((name) => ({ name, status: "completed", conclusion: "success", runner_group_id: 0, runner_group_name: "GitHub Actions", labels: ["ubuntu-24.04"], steps: name === "ci" ? [{ name: `Full CI inputs ${inputsHash}`, status: "completed", conclusion: "success" }] : [] }));

async function lookup({ runs = [prRun()], jobs = passedJobs(), pr = prMetadata(), commitTree = tree, fail = false, hash = inputsHash } = {}) {
  const calls = [];
  const result = await findReusableRun({ env: repositoryFixture, repository, tree, inputsHash: hash, now,
    request: async (path) => {
      calls.push(path);
      if (fail) throw new Error("API unavailable");
      if (path.includes("/runs?")) return { workflow_runs: runs };
      if (path.includes("/pulls/")) return pr;
      if (path.includes("/git/commits/")) return { sha: path.split("/").at(-1), tree: { sha: commitTree } };
      if (path.includes("/jobs?")) return { total_count: jobs.length, jobs };
      throw new Error(`Unexpected request: ${path}`);
    },
  });
  return { result, calls };
}

describe("full CI tree reuse", () => {
  it("reuses a recent successful full PR run with its tested merge tree", async () => {
    assert.deepEqual((await lookup()).result, { reused: "true", run_id: "123", tree });
  });

  it("accepts standard hosted runner metadata on every source job", async () => {
    // Standard hosted jobs report group 0, GitHub Actions and one Ubuntu label.
    for (const label of ["ubuntu-latest", "ubuntu-24.04", "ubuntu-22.04"]) {
      const jobs = passedJobs().map((job) => ({ ...job, labels: [label] }));
      assert.equal((await lookup({ jobs })).result.reused, "true", label);
    }
  });

  it("rejects self-hosted, unknown or missing runner proof for any source job", async () => {
    for (const name of [...fullJobs, "New gate"]) {
      for (const patch of [
        { runner_group_id: 1442374012, runner_group_name: "Default", labels: ["self-hosted", "linux", "njpbs-ci"] },
        { labels: ["self-hosted", "ubuntu-24.04"] },
        { runner_group_id: 1442374012 }, // A custom group cannot impersonate the hosted group by name.
        { runner_group_id: undefined }, { runner_group_id: null },
        { runner_group_name: undefined }, { runner_group_name: null }, { runner_group_name: "Default" },
        { labels: undefined }, { labels: null }, { labels: [] }, { labels: "ubuntu-24.04" },
        { labels: ["unknown"] }, { labels: ["ubuntu-24.04", "unknown"] },
      ]) {
        const jobs = passedJobs();
        if (name === "New gate") jobs.push({ ...jobs[0], name });
        const source = jobs.map((job) => job.name === name ? { ...job, ...patch } : job);
        assert.equal((await lookup({ jobs: source })).result.reused, "false", `${name}: ${JSON.stringify(patch)}`);
      }
    }
  });

  it("reuses a merged PR with an empty PR list by checking its actual synthetic merge tree", async () => {
    const { result, calls } = await lookup({ runs: [prRun()] });
    assert.equal(result.reused, "true");
    assert.ok(calls.includes(`/repos/${repository}/git/commits/${merge}`));
    assert.ok(calls.includes(`/repos/${repository}/pulls/42`));
    const staleBranch = { ...prRun(), head_commit: { id: head, tree_id: before } };
    assert.equal((await lookup({ runs: [staleBranch] })).result.reused, "true");
    // Same branch tree, but the synthetic merge included different main changes.
    assert.equal((await lookup({ runs: [prRun()], commitTree: before })).result.reused, "false");
    for (const patch of [
      { referenced_workflows: [] },
      { referenced_workflows: [prRun().referenced_workflows[0]] },
      { referenced_workflows: prRun().referenced_workflows.map((w) => ({ ...w, ref: "refs/heads/feature" })) },
    ]) assert.equal((await lookup({ runs: [{ ...prRun(), ...patch }] })).result.reused, "false");
  });

  it("does not use runs from a different workflow, repository, or event", async () => {
    for (const patch of [
      { head_commit: { id: before, tree_id: tree } },
      { path: ".github/workflows/other.yml" },
      { event: "workflow_dispatch" }, { event: "merge_group" }, { event: "push" },
      { repository: { full_name: "attacker/repo" } },
      { head_repository: { full_name: "attacker/repo" } },
      { status: "in_progress" }, { conclusion: "failure" },
    ]) {
      assert.equal((await lookup({ runs: [{ ...prRun(), ...patch }] })).result.reused, "false");
    }
    assert.equal((await lookup({ commitTree: before })).result.reused, "false");
  });

  it("does not reuse a fork PR or a PR against another base", async () => {
    for (const patch of [
      { base: { ref: "develop", repo: { id: 1442374012 } } },
      { head: { sha: head, repo: { id: 2 } } },
      { head: { sha: before, repo: { id: 1442374012 } } },
    ]) {
      assert.equal((await lookup({ runs: [prRun()], pr: { ...prMetadata(), ...patch } })).result.reused, "false");
    }
  });

  it("rejects every missing, skipped, failed, cancelled or pending full-suite job", async () => {
    for (const name of fullJobs) {
      assert.equal((await lookup({ jobs: passedJobs().filter((job) => job.name !== name) })).result.reused, "false", name);
      for (const conclusion of ["skipped", "failure", "cancelled", null]) {
        const jobs = passedJobs().map((job) => job.name === name ? { ...job, conclusion } : job);
        assert.equal((await lookup({ jobs })).result.reused, "false", `${name} ${conclusion}`);
      }
    }
    const jobs = [...passedJobs(), { name: "New gate", status: "completed", conclusion: "failure" }];
    assert.equal((await lookup({ jobs })).result.reused, "false");
  });

  it("paginates jobs so missing later shards cannot be accepted", async () => {
    const calls = [];
    const jobs = passedJobs();
    const result = await findReusableRun({ env: repositoryFixture, repository, tree, inputsHash, now, request: async (path) => {
      calls.push(path);
      if (path.includes("/runs?")) return { workflow_runs: [prRun()] };
      if (path.includes("/git/commits/")) return { sha: merge, tree: { sha: tree } };
      if (path.includes("/pulls/")) return prMetadata();
      return { total_count: jobs.length, jobs: path.endsWith("page=1") ? jobs.slice(0, 7) : jobs.slice(7) };
    } });
    assert.equal(result.reused, "true");
    assert.ok(calls.some((path) => path.endsWith("page=2")));
  });

  it("requires a successful native input-digest marker; older and changed-config runs miss", async () => {
    for (const hash of ["", undefined, "changed", "1".repeat(64)]) {
      const options = hash === undefined ? { hash: null } : { hash };
      assert.equal((await lookup(options)).result.reused, "false");
    }
    for (const steps of [undefined, [], [{ name: `Full CI inputs ${inputsHash}`, status: "completed", conclusion: "skipped" }]]) {
      const jobs = passedJobs().map((job) => job.name === "ci" ? { ...job, steps } : job);
      assert.equal((await lookup({ jobs })).result.reused, "false");
    }
  });

  it("rejects missing, future, stale or inconsistent run timestamps, including refreshed old reruns", async () => {
    for (const field of ["created_at", "updated_at"]) {
      for (const value of [undefined, "invalid", iso(1), iso(-6 * 60 * 60 * 1000 - 1)]) {
        const { result, calls } = await lookup({ runs: [{ ...prRun(), [field]: value }] });
        assert.equal(result.reused, "false", `${field} ${value}`);
        assert.equal(calls.length, 1, "Expired or incomplete runs must not cause further API calls");
      }
    }
    assert.equal((await lookup({ runs: [{ ...prRun(), updated_at: iso(-11 * 60 * 1000) }] })).result.reused, "false");
    assert.equal((await lookup({ runs: [{ ...prRun(), created_at: iso(-6 * 60 * 60 * 1000), updated_at: iso(-6 * 60 * 60 * 1000) }] })).result.reused, "true");
    assert.equal((await lookup({ runs: [mainRun()] })).result.reused, "false", "Main-push results cannot revive old runtime proof");
  });

  it("keeps PR, manual and other-branch runs on normal CI without an API call", async () => {
    for (const env of [
      { GITHUB_EVENT_NAME: "pull_request" }, { GITHUB_EVENT_NAME: "workflow_dispatch" },
      { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/develop" },
    ]) {
      assert.deepEqual(await reuseFromEnvironment(env, () => { throw new Error("Must not call API"); }), { reused: "false" });
    }
  });

  it("falls back to full CI after API errors and malformed responses", async () => {
    const env = { ...repositoryFixture, GITHUB_REPOSITORY: repository, GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main", GITHUB_SHA: "HEAD", CI_INPUTS_HASH: inputsHash };
    for (const fetcher of [
      async () => { throw new Error("Network failure"); },
      async () => ({ ok: false }),
      async () => ({ ok: true, json: async () => ({}) }),
    ]) {
      let calls = 0;
      assert.deepEqual(await reuseFromEnvironment(env, (...args) => { calls++; return fetcher(...args); }), { reused: "false" });
      assert.equal(calls, 1, "Must exercise the request/parse fallback");
    }
  });
});
