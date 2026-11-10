import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import target from "../../functions/lib/publication-target.js";
import { verifyDevPreuploadFailure, devSettlementGithub, assertDevPreuploadFailureSource } from "../../scripts/lib/dev-preupload-provenance.mjs";
import { parseDevPreuploadPacket } from "../../scripts/settle-dev-preupload-failure.mjs";
import { recordedDevPreuploadSourceBlob, devPreuploadRetryFixture } from "../helpers/dev-preupload-sources.js";

// Synthetic failed-run envelope with the exact renderer-refusal error format.
const log = Buffer.from("2026-01-01T00:00:00.0000000Z Retained dev renderer source differs\n");
const request = { schemaVersion: 1, target: target.publicationTarget("development"),
  identity: { queueId: "e8a1597005e84ced55ee", buildBatchId: "cms-e8a1597005e84ced55ee",
    commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, generation: 122, inputDigest: "f".repeat(64),
  failure: { runId: "1001", runAttempt: 1, jobId: "2001", completedAt: "2026-01-01T00:00:01Z",
    code: "retained_dev_renderer_source_differs", logDigest: createHash("sha256").update(log).digest("hex") } };
function fixture() {
  const run = { id: 1001, run_attempt: 1, status: "completed", conclusion: "failure", event: "push",
    path: ".github/workflows/cms-dev-publish.yml", head_branch: "main", head_sha: request.identity.commitSha,
    repository: { full_name: "CenterCoopMedia/njpbs" }, head_repository: { full_name: "CenterCoopMedia/njpbs" },
    actor: { login: "fixture-user" }, triggering_actor: { login: "fixture-user" } };
  const job = { id: 2001, run_id: 1001, run_attempt: 1, head_sha: request.identity.commitSha,
    name: "finalize", status: "completed", conclusion: "failure", completed_at: "2026-01-01T00:00:01Z",
    steps: [{ number: 10, name: "Upload only to dev, verify receipts, and settle dev queue", conclusion: "failure" },
      { number: 11, name: "Record failure or preserve uncertain upload", conclusion: "success" }] };
  const state = { run, jobs: { total_count: 1, jobs: [job] }, hold: { value: "false" }, override: null,
    active: { total_count: 0 }, log };
  const github = async path => {
    if (path.endsWith("/logs")) return state.log;
    if (path.includes("/jobs?")) return state.jobs;
    if (path.includes("/runs?status=")) return state.active;
    if (path.startsWith("environments/")) return state.override;
    if (path.startsWith("actions/variables/")) return state.hold;
    return state.run;
  };
  return { state, github, job };
}

it("proves the original failed job against its reviewed publisher/workflow sources and held/drained writers", async () => {
  await expect(verifyDevPreuploadFailure(request, fixture().github, recordedDevPreuploadSourceBlob)).resolves.toBeUndefined();
});
it("admits the second source fixture on attempt 2 only with the complete skipped first attempt", async () => {
  const { request, github } = devPreuploadRetryFixture();
  await expect(verifyDevPreuploadFailure(request, github, recordedDevPreuploadSourceBlob)).resolves.toBeUndefined();
});
it.each(["missing job", "truncated jobs", "unknown job", "duplicate name", "duplicate id", "invalid id", "other run", "other source",
  "other attempt", "running", "successful job", "failed job", "executed step", "missing steps"])("refuses attempt 2 with %s in attempt 1", async mode => {
  const { request, skipped, github } = devPreuploadRetryFixture();
  const job = skipped.jobs[0];
  if (mode === "missing job") { skipped.jobs.pop(); skipped.total_count--; }
  if (mode === "truncated jobs") skipped.total_count++;
  if (mode === "unknown job") job.name = "other";
  if (mode === "duplicate name") job.name = skipped.jobs[1].name;
  if (mode === "duplicate id") job.id = skipped.jobs[1].id;
  if (mode === "invalid id") job.id = null;
  if (mode === "other run") job.run_id++;
  if (mode === "other source") job.head_sha = "c".repeat(40);
  if (mode === "other attempt") job.run_attempt = 2;
  if (mode === "running") job.status = "in_progress";
  if (mode === "successful job") job.conclusion = "success";
  if (mode === "failed job") job.conclusion = "failure";
  if (mode === "executed step") job.steps.push({ number: 1, conclusion: "success" });
  if (mode === "missing steps") delete job.steps;
  await expect(verifyDevPreuploadFailure(request, github, recordedDevPreuploadSourceBlob)).rejects.toThrow();
});
it("refuses if attempt 2 is restarted while reading its failure log", async () => {
  const { request, run, github } = devPreuploadRetryFixture();
  let reads = 0;
  const read = async (path, options) => path === `actions/runs/${run.id}` && ++reads === 2
    ? { ...run, run_attempt: 3 } : github(path, options);
  await expect(verifyDevPreuploadFailure(request, read, recordedDevPreuploadSourceBlob)).rejects.toThrow();
});
it.each([0, 3, "2", null, 1.5])("refuses unsupported attempt %s before provenance reads", async runAttempt => {
  const { request } = devPreuploadRetryFixture(); request.failure.runAttempt = runAttempt;
  const github = vi.fn();
  await expect(verifyDevPreuploadFailure(request, github, recordedDevPreuploadSourceBlob)).rejects.toThrow();
  expect(github).not.toHaveBeenCalled();
});
it.each(["rerun", "running", "success", "other source", "other workflow", "branch", "actor", "triggering actor", "fork",
  "hold", "override", "active run", "job", "other job source", "job rerun", "missing jobs", "wrong failure step", "cleanup failed",
  "log changed", "different error", "run restarted during proof"])("refuses %s provenance", async mode => {
  const { state, github, job } = fixture();
  const input = structuredClone(request);
  if (mode === "rerun") state.run.run_attempt = 2;
  if (mode === "running") state.run.status = "in_progress";
  if (mode === "success") state.run.conclusion = "success";
  if (mode === "other source") state.run.head_sha = "b".repeat(40);
  if (mode === "other workflow") state.run.path = ".github/workflows/cms-publish.yml";
  if (mode === "branch") state.run.head_branch = "feature";
  if (mode === "actor") state.run.actor.login = "other";
  if (mode === "triggering actor") state.run.triggering_actor.login = "other";
  if (mode === "fork") state.run.head_repository.full_name = "other/njpbs-site";
  if (mode === "hold") state.hold.value = "true";
  if (mode === "override") state.override = { value: "true" };
  if (mode === "active run") state.active.total_count = 1;
  if (mode === "job") job.id++;
  if (mode === "other job source") job.head_sha = "b".repeat(40);
  if (mode === "job rerun") job.run_attempt = 2;
  if (mode === "missing jobs") state.jobs.total_count = 2;
  if (mode === "wrong failure step") job.steps[0].number = 12;
  if (mode === "cleanup failed") job.steps[1].conclusion = "failure";
  if (mode === "log changed") state.log = Buffer.from("a different log");
  if (mode === "different error") {
    state.log = Buffer.from("2026-01-01T00:00:00.0000000Z Upload failed\n");
    input.failure.logDigest = createHash("sha256").update(state.log).digest("hex");
  }
  let reads = 0;
  const read = async (path, options) => {
    if (mode === "run restarted during proof" && path === `actions/runs/${request.failure.runId}` && ++reads === 2)
      return { ...state.run, run_attempt: 2 };
    return github(path, options);
  };
  await expect(verifyDevPreuploadFailure(input, read, recordedDevPreuploadSourceBlob)).rejects.toThrow();
});
it("an unknown publisher source needs a new source review", async () => {
  const input = structuredClone(request); input.identity.commitSha = "c".repeat(40);
  await expect(verifyDevPreuploadFailure(input, fixture().github)).rejects.toThrow();
});
it.each(["site/scripts/cms-dev-publication.mjs", ".github/workflows/cms-dev-publish.yml"])("refuses a changed %s source blob", filename => {
  expect(() => assertDevPreuploadFailureSource(request.identity.commitSha, (sha, path) =>
    path === filename ? "b".repeat(40) : recordedDevPreuploadSourceBlob(sha, path))).toThrow();
});

it("keeps the GitHub token on api.github.com and uses the signed log URL without auth", async () => {
  const signed = "https://productionresultssa.blob.core.windows.net/logs/example?sig=synthetic";
  const request = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: signed } }))
    .mockResolvedValueOnce(new Response(log));
  expect(await devSettlementGithub("synthetic-token", request)("actions/jobs/2001/logs", { log: true })).toEqual(log);
  expect(request.mock.calls[0][1].headers.Authorization).toBe("Bearer synthetic-token");
  expect(request.mock.calls[1][1].headers).toBeUndefined();
});
it.each(["https://example.test/log", "http://productionresultssa.blob.core.windows.net/log"])("refuses a log redirect to %s", async location => {
  const request = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location } }));
  await expect(devSettlementGithub("synthetic-token", request)("actions/jobs/2001/logs", { log: true })).rejects.toThrow();
  expect(request).toHaveBeenCalledTimes(1);
});
it("bounds API/log responses", async () => {
  const request = vi.fn().mockResolvedValue(new Response("x".repeat(256 * 1024 + 1)));
  await expect(devSettlementGithub("synthetic-token", request)("actions/runs/1001")).rejects.toThrow();
});

it.each(["production", "wrong account", "missing source", "unknown field"])("refuses %s operator packet before credential use", mode => {
  const packet = { schemaVersion: 1, kind: "dev-preupload-settlement", operatorCommitSha: "c".repeat(40), request: structuredClone(request),
    credentialIdentity: { projectId: "njpbs-site-dev", clientEmail: "dev-seed-writer@njpbs-site-dev.iam.gserviceaccount.com",
      privateKeyId: "b".repeat(40), secretRef: "pass://example/service/credential" } };
  if (mode === "production") packet.request.target = target.publicationTarget("production");
  if (mode === "wrong account") packet.credentialIdentity.clientEmail = "another-writer@njpbs-site-dev.iam.gserviceaccount.com";
  if (mode === "missing source") packet.operatorCommitSha = null;
  if (mode === "unknown field") packet.credential = "synthetic-value";
  expect(() => parseDevPreuploadPacket(packet)).toThrow();
});
