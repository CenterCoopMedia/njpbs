import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { releaseStreak } from "./release-streak.mjs";

// GitHub's answers on Nov. 26, 2026, trimmed to the fields the script reads.
const recorded = JSON.parse(readFileSync(new URL("../tests/fixtures/release-streak-2026-11-26.json", import.meta.url), "utf8"));
const since = "2026-11-01T00:00:00.000Z";

function fake(answers) {
  return async (path) => {
    const body = answers[path];
    if (body === undefined) throw new Error(`unrecorded read ${path}`);
    if (body.httpStatus) throw Object.assign(new Error(`HTTP ${body.httpStatus}`), { status: body.httpStatus });
    return structuredClone(body);
  };
}

test("Nov. 26: no release counts; the release without a record is named with its three CMS runs", async () => {
  const result = await releaseStreak(fake(recorded), { need: 4, since, repo: "CenterCoopMedia/njpbs", toolRepo: "jamditis/jawn-ops" });
  assert.equal(result.count, 0);
  assert.equal(result.met, false);
  assert.equal(result.releases.length, 1);
  const [release] = result.releases;
  assert.equal(release.counted, false);
  assert.equal(release.sha, null);
  assert.equal(release.mainAtDispatch, "ec7f48a199b53b42e7aa66d43f83c7fdf7963561");
  assert.deepEqual(release.why, ["no release-production record (3 production CMS runs: 45739394936 failure, 45757428529 failure, 45762652112 success)"]);
});

// A release built to the record contract on top of the recorded data, one
// field per condition, so a case can break one condition.
const SOURCE = "2".repeat(40);
const PREVIOUS = "ec7f48a199b53b42e7aa66d43f83c7fdf7963561"; // njpbs.org/_publication.json on Nov. 26
const TOOL = "1".repeat(40);
const deployments = (env) => `repos/CenterCoopMedia/njpbs/deployments?environment=${env}&per_page=100&page=1`;
const cmsRuns = "repos/CenterCoopMedia/njpbs/actions/workflows/cms-deploy.yml/runs?created=%3E%3D2026-11-01&per_page=100&page=1";
const driftRuns = "repos/CenterCoopMedia/njpbs/actions/workflows/release-drift.yml/runs?created=%3E%3D2026-11-01&per_page=100&page=1";

function counted(change = {}) {
  const a = structuredClone(recorded);
  const record = { id: 9001, sha: SOURCE, environment: "release-production", created_at: "2026-12-01T03:00:00Z", payload: { schema: 1, source: SOURCE, release_id: "r1", tool: TOOL, target: "production", live: change.live ?? PREVIOUS } };
  a[deployments("release-production")] = [record];
  a["repos/CenterCoopMedia/njpbs/deployments/9001/statuses?per_page=100"] = [
    { state: change.end ?? "success", description: `failed=${change.failed ?? 0} seconds=1484 refused=701`, created_at: "2026-12-01T03:30:00Z" },
    { state: "in_progress", description: "", created_at: "2026-12-01T03:00:01Z" },
  ];
  a[deployments(`release-production&sha=${SOURCE}`)] = [record];
  a[deployments(`release-development&sha=${SOURCE}`)] = [{ id: 9000, sha: SOURCE, environment: "release-development", created_at: "2026-11-30T03:00:00Z", payload: { release_id: "d1", tool: TOOL } }];
  a["repos/CenterCoopMedia/njpbs/deployments/9000/statuses?per_page=100"] = [{ state: change.dev ?? "success", description: "failed=0 seconds=1300 refused=0", created_at: change.devEnd ?? "2026-11-30T03:25:00Z" }];
  if (change.earlier) {
    // A failed attempt of the same commit, older than the window.
    a[deployments(`release-production&sha=${SOURCE}`)].push({ ...record, id: 8999, created_at: "2026-09-01T03:00:00Z" });
    a["repos/CenterCoopMedia/njpbs/deployments/8999/statuses?per_page=100"] = [{ state: "failure", description: "failed=1 seconds=9 refused=0", created_at: "2026-09-01T03:10:00Z" }];
  }
  // The production CMS run of the release, linked by its environment deployment.
  a[cmsRuns] = { workflow_runs: [{ id: 50001, display_title: "CMS deploy [c1]", created_at: "2026-12-01T03:05:00Z", updated_at: "2026-12-01T03:15:00Z", conclusion: "success", run_attempt: change.attempt ?? 1 }, ...a[cmsRuns].workflow_runs] };
  a[deployments("production")] = [{ id: 9002, sha: SOURCE, created_at: "2026-12-01T03:05:02Z" }, ...a[deployments("production")]];
  a["repos/CenterCoopMedia/njpbs/deployments/9002/statuses?per_page=100"] = [{ state: "success", created_at: "2026-12-01T03:15:00Z", target_url: "https://github.com/CenterCoopMedia/njpbs/actions/runs/50001/job/1" }];
  a[driftRuns] = { workflow_runs: change.drift ?? [
    { id: 60002, display_title: "Release drift production after [r1] 7f3a", created_at: "2026-12-01T03:20:00Z", updated_at: "2026-12-01T03:22:00Z", conclusion: "success" },
    { id: 60001, display_title: "Release drift production [r1]", created_at: "2026-12-01T03:00:05Z", updated_at: "2026-12-01T03:02:00Z", conclusion: "success" },
  ] };
  a[`repos/jamditis/jawn-ops/compare/master...${TOOL}`] = { status: change.tool ?? "behind" };
  a[`repos/CenterCoopMedia/njpbs/compare/${PREVIOUS}...${SOURCE}`] = change.compare ?? { status: "ahead", ahead_by: 1, behind_by: 0 };
  for (const id of [60001, 60002]) a[`repos/CenterCoopMedia/njpbs/actions/runs/${id}/jobs?per_page=100`] = { jobs: [{ name: "development", conclusion: "success" }, { name: "check", conclusion: change.driftJob ?? "success" }] };
  return a;
}

test("a release that meets every condition counts; the stretch without a record before it ends the streak", async () => {
  const result = await releaseStreak(fake(counted()), { need: 1, since, repo: "CenterCoopMedia/njpbs", toolRepo: "jamditis/jawn-ops" });
  assert.equal(result.met, true);
  assert.deepEqual(result.releases.map((r) => r.counted), [true]);
  const two = await releaseStreak(fake(counted()), { need: 2, since, repo: "CenterCoopMedia/njpbs", toolRepo: "jamditis/jawn-ops" });
  assert.equal(two.count, 1);
  assert.equal(two.met, false);
  assert.match(two.releases[1].why[0], /^no release-production record/);
});

test("each broken condition stops the count and is named", async () => {
  const cases = [
    [{ end: "failure", failed: 2 }, /record ended failure, failed=2/],
    [{ attempt: 2 }, /CMS run 50001 success, attempt 2/],
    [{ drift: [] }, /no green drift check before the CMS run/],
    [{ drift: [{ id: 60001, display_title: "Release drift production [r1]", created_at: "2026-12-01T03:00:05Z", updated_at: "2026-12-01T03:02:00Z", conclusion: "success" }] }, /^no green drift check after the release/],
    [{ tool: "diverged" }, /tool 11111111 is not on jawn-ops master/],
    [{ dev: "failure" }, /first release-development record did not succeed/],
    [{ compare: { status: "identical", ahead_by: 0, behind_by: 0 } }, /the commit is not ahead of the live commit/],
    [{ compare: { status: "diverged", ahead_by: 2, behind_by: 1 } }, /the commit is not ahead of the live commit/],
    [{ driftJob: "skipped" }, /no green drift check before the CMS run/],
    [{ earlier: true }, /2 release-production records for the commit/],
    [{ devEnd: "2026-12-01T03:00:00Z" }, /the development release ended after the production release started/],
  ];
  for (const [change, why] of cases) {
    const result = await releaseStreak(fake(counted(change)), { need: 1, since, repo: "CenterCoopMedia/njpbs", toolRepo: "jamditis/jawn-ops" });
    assert.equal(result.count, 0, JSON.stringify(change));
    assert.match(result.releases[0].why.join("; "), why);
  }
});

test("a record that never ended takes no production CMS run", async () => {
  const a = counted();
  // A stopped command: the record has only its in_progress status.
  a["repos/CenterCoopMedia/njpbs/deployments/9001/statuses?per_page=100"] = [{ state: "in_progress", description: "started", created_at: "2026-12-01T03:00:01Z" }];
  const result = await releaseStreak(fake(a), { need: 1, since, repo: "CenterCoopMedia/njpbs", toolRepo: "jamditis/jawn-ops" });
  assert.equal(result.count, 0);
  assert.deepEqual(result.releases[0].why, ["no release-production record (1 production CMS run: 50001 success)"]);
});

test("a record that does not name the live commit does not count", async () => {
  const result = await releaseStreak(fake(counted({ live: "" })), { need: 1, since, repo: "CenterCoopMedia/njpbs", toolRepo: "jamditis/jawn-ops" });
  assert.equal(result.count, 0);
  assert.deepEqual(result.releases[0].why, ["the record does not name the commit live at its start"]);
});

test("an unfinished CMS run with no production deployment yet keeps the goal unmet", async () => {
  const a = counted();
  a[cmsRuns].workflow_runs.unshift({ id: 50010, display_title: "CMS deploy [q]", created_at: "2026-12-02T03:00:00Z", updated_at: "2026-12-02T03:00:00Z", conclusion: null, run_attempt: 1 });
  const result = await releaseStreak(fake(a), { need: 1, since, repo: "CenterCoopMedia/njpbs", toolRepo: "jamditis/jawn-ops" });
  assert.equal(result.count, 1);
  assert.equal(result.met, false);
  assert.deepEqual(result.pending, [50010]);
});

test("a drift run with the release ID outside the record does not count", async () => {
  // The after check, dispatched again with the same ID after the record ended.
  const late = { id: 60002, display_title: "Release drift production after [r1]", created_at: "2026-12-01T04:00:00Z", updated_at: "2026-12-01T04:02:00Z", conclusion: "success" };
  const before = { id: 60001, display_title: "Release drift production [r1]", created_at: "2026-12-01T03:00:05Z", updated_at: "2026-12-01T03:02:00Z", conclusion: "success" };
  const result = await releaseStreak(fake(counted({ drift: [late, before] })), { need: 1, since, repo: "CenterCoopMedia/njpbs", toolRepo: "jamditis/jawn-ops" });
  assert.deepEqual(result.releases[0].why, ["no green drift check after the release (conditions 4 and 5)"]);
});

test("a hand CMS run inside the record, or a run left by an earlier command, stops the count", async () => {
  // A second production CMS run inside the record window.
  const a = counted();
  a[cmsRuns].workflow_runs.unshift({ id: 50002, display_title: "CMS deploy [hand]", created_at: "2026-12-01T03:16:00Z", updated_at: "2026-12-01T03:18:00Z", conclusion: "success", run_attempt: 1 });
  a[deployments("production")].unshift({ id: 9005, sha: SOURCE, created_at: "2026-12-01T03:16:02Z" });
  a["repos/CenterCoopMedia/njpbs/deployments/9005/statuses?per_page=100"] = [{ state: "success", created_at: "2026-12-01T03:18:00Z", target_url: "https://github.com/CenterCoopMedia/njpbs/actions/runs/50002/job/1" }];
  const hand = await releaseStreak(fake(a), { need: 1, since, repo: "CenterCoopMedia/njpbs", toolRepo: "jamditis/jawn-ops" });
  assert.match(hand.releases[0].why.join("; "), /2 production CMS runs inside the record, not 1/);
  // An earlier command of the same commit made its own record, so the later one is not a first try.
  const resumed = await releaseStreak(fake(counted({ earlier: true })), { need: 1, since, repo: "CenterCoopMedia/njpbs", toolRepo: "jamditis/jawn-ops" });
  assert.match(resumed.releases[0].why.join("; "), /2 release-production records for the commit/);
});
