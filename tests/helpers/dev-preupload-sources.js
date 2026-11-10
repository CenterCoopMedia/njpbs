import { createHash } from "node:crypto";
import target from "../../functions/lib/publication-target.js";

// Process-boundary fixtures bind synthetic commit identities to known source
// blob IDs. CI need not fetch historical commits.
export function recordedDevPreuploadSourceBlob(commitSha, filename) {
  if (!["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"].includes(commitSha))
    throw new Error("Unknown recorded source");
  const files = {
    "site/scripts/cms-dev-publication.mjs": commitSha === "b".repeat(40)
      ? "848555f2baf30a031ea4130c81fc03e7e92e5f5b" : "63a5e05f4b066d2dce213e25304371e7fa3c1591",
    ".github/workflows/cms-dev-publish.yml": "7ced4c2d20866733f82732cbd648cdfb28c8c325",
  };
  if (!Object.hasOwn(files, filename)) throw new Error("Unknown recorded file");
  return files[filename];
}

// A closed retry fixture supplies workflow metadata and bounded synthetic log bytes.
export function devPreuploadRetryFixture() {
  const sha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const run = { id: 1002, run_attempt: 2, status: "completed", conclusion: "failure", event: "push",
    path: ".github/workflows/cms-dev-publish.yml", head_branch: "main", head_sha: sha,
    repository: { full_name: "CenterCoopMedia/njpbs" }, head_repository: { full_name: "CenterCoopMedia/njpbs" },
    actor: { login: "fixture-user" }, triggering_actor: { login: "fixture-user" } };
  const jobs = { total_count: 1, jobs: [{ id: 2002, run_id: run.id, run_attempt: 2, head_sha: sha,
    name: "finalize", status: "completed", conclusion: "failure", completed_at: "2026-11-01T16:03:58Z",
    steps: [{ number: 10, name: "Upload only to dev, verify receipts, and settle dev queue", conclusion: "failure" },
      { number: 11, name: "Record failure or preserve uncertain upload", conclusion: "success" }] }] };
  const skipped = { total_count: 4, jobs: [
    [2101, "build"], [2102, "finalize"], [2103, "prepare"], [2104, "reconcile"],
  ].map(([id, name]) => ({ id, name, run_id: run.id, run_attempt: 1, head_sha: sha,
    status: "completed", conclusion: "skipped", steps: [] })) };
  const log = Buffer.from("2026-11-01T16:03:54.0000000Z Retained dev renderer source differs\n");
  const request = { schemaVersion: 1, target: target.publicationTarget("development"),
    identity: { queueId: "b770acb82af30c9c6e13", buildBatchId: "cms-b770acb82af30c9c6e13", commitSha: sha },
    generation: 124, inputDigest: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    failure: { runId: String(run.id), runAttempt: 2, jobId: String(jobs.jobs[0].id), completedAt: jobs.jobs[0].completed_at,
      code: "retained_dev_renderer_source_differs", logDigest: createHash("sha256").update(log).digest("hex") } };
  const github = async path => {
    if (path.endsWith("/logs")) return log;
    if (path.endsWith("/attempts/1/jobs?per_page=100")) return skipped;
    if (path.endsWith("/attempts/2/jobs?per_page=100")) return jobs;
    if (path.includes("/runs?status=")) return { total_count: 0 };
    if (path.startsWith("environments/")) return null;
    if (path.startsWith("actions/variables/")) return { value: "false" };
    if (path === `actions/runs/${run.id}`) return run;
    throw new Error("Unexpected provenance boundary");
  };
  return { request, run, jobs, skipped, log, github };
}
