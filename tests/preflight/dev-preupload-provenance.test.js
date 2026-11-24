import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import target from "../../functions/lib/publication-target.js";
import { verifyDevPreuploadFailure, devSettlementGithub, assertDevPreuploadFailureSource } from "../../scripts/lib/dev-preupload-provenance.mjs";
import { parseDevPreuploadPacket } from "../../scripts/settle-dev-preupload-failure.mjs";
import contract from "../../functions/lib/dev-publication-preupload.js";
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
  if (mode === "other workflow") state.run.path = ".github/workflows/cms-staging-deploy.yml";
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

// A refresh dispatch that failed in the build job: no artifact retained and every finalize upload skipped.
const buildLog = Buffer.from("2026-11-23T19:11:48.4327692Z ##[error]Process completed with exit code 1.\n");
const buildSha = "dddddddddddddddddddddddddddddddddddddddd";
const buildBlob = (sha, filename) => {
  if (sha !== buildSha) throw new Error("Unknown recorded source");
  return { "site/scripts/cms-dev-publication.mjs": "d85f46bd056d054d2128f55b5fa6d34b3074fcf0",
    ".github/workflows/cms-dev-publish.yml": "3d1a870c7c135bd4189bfcff9fa2ac871a3c9825" }[filename];
};
function buildFixture(code) {
  const failed = code === "dev_refresh_frozen_build_failed" ? 20 : 21;
  const input = structuredClone(request);
  input.identity.commitSha = buildSha;
  input.failure = { ...input.failure, code, jobId: "3001", completedAt: "2026-11-23T19:11:51Z",
    logDigest: createHash("sha256").update(buildLog).digest("hex") };
  const run = { id: 1001, run_attempt: 1, status: "completed", conclusion: "failure", event: "workflow_dispatch",
    path: ".github/workflows/cms-dev-publish.yml", head_branch: "main", head_sha: buildSha,
    repository: { full_name: "CenterCoopMedia/njpbs" }, head_repository: { full_name: "CenterCoopMedia/njpbs" },
    actor: { login: "fixture-user" }, triggering_actor: { login: "fixture-user" } };
  const base = { run_id: 1001, run_attempt: 1, head_sha: buildSha, status: "completed" };
  const build = { ...base, id: 3001, name: "build", conclusion: "failure", completed_at: input.failure.completedAt, steps: [
    { number: 20, name: "Build from frozen input without network or credentials", conclusion: failed === 20 ? "failure" : "success" },
    { number: 21, name: "Check built content", conclusion: failed === 21 ? "failure" : "skipped" },
    { number: 23, name: "Retain artifact and private receipts", conclusion: "skipped" }] };
  const finalize = { ...base, id: 3002, name: "finalize", conclusion: "success", completed_at: "2026-11-23T19:12:52Z", steps: [
    { number: 11, name: "Verify retained Post renderer files", conclusion: "skipped" },
    { number: 12, name: "Upload only to dev, verify receipts, and settle dev queue", conclusion: "skipped" },
    { number: 13, name: "Record failure or preserve uncertain upload", conclusion: "success" }] };
  const state = { run, jobs: { total_count: 2, jobs: [build, finalize] }, log: buildLog };
  const github = async path => {
    if (path.endsWith("/logs")) return state.log;
    if (path.includes("/jobs?")) return state.jobs;
    if (path.includes("/runs?status=")) return { total_count: 0 };
    if (path.startsWith("environments/")) return null;
    if (path.startsWith("actions/variables/")) return { value: "false" };
    return state.run;
  };
  return { input, state, build, finalize, github };
}
const BUILD_CODES = ["dev_refresh_frozen_build_failed", "dev_refresh_content_check_failed"];
it.each(BUILD_CODES)("proves a refresh build failure at %s with no retained artifact and no upload", async code => {
  const { input, github } = buildFixture(code);
  await expect(verifyDevPreuploadFailure(input, github, buildBlob)).resolves.toBeUndefined();
});
it.each(["push event", "renderer sources", "other failed step", "two failed steps", "artifact retained", "verify ran",
  "upload ran", "upload step missing", "no finalize", "two finalize jobs", "finalize other attempt", "finalize job id",
  "no exit line", "two exit lines", "log changed", "run restarted"])("refuses a build failure with %s", async mode => {
  const code = "dev_refresh_content_check_failed";
  const { input, state, build, finalize, github } = buildFixture(code);
  let blobs = buildBlob;
  if (mode === "push event") state.run.event = "push";
  if (mode === "renderer sources") blobs = (sha, filename) => recordedDevPreuploadSourceBlob("a".repeat(40), filename);
  if (mode === "other failed step") { build.steps[0].conclusion = "failure"; build.steps[1].conclusion = "skipped"; }
  if (mode === "two failed steps") build.steps[0].conclusion = "failure";
  if (mode === "artifact retained") build.steps[2].conclusion = "success";
  if (mode === "verify ran") finalize.steps[0].conclusion = "success";
  if (mode === "upload ran") finalize.steps[1].conclusion = "failure";
  if (mode === "upload step missing") finalize.steps.splice(1, 1);
  if (mode === "no finalize") { state.jobs.jobs.pop(); state.jobs.total_count--; }
  if (mode === "two finalize jobs") { state.jobs.jobs.push({ ...finalize, id: 3003 }); state.jobs.total_count++; }
  if (mode === "finalize other attempt") finalize.run_attempt = 2;
  if (mode === "finalize job id") input.failure.jobId = "3002";
  const relog = text => { state.log = Buffer.from(text); input.failure.logDigest = createHash("sha256").update(state.log).digest("hex"); };
  if (mode === "no exit line") relog("2026-11-23T19:11:48.4327692Z Build failed\n");
  if (mode === "two exit lines") relog(buildLog.toString() + buildLog.toString());
  if (mode === "log changed") state.log = Buffer.from("a different log");
  let reads = 0;
  const read = async (path, options) => mode === "run restarted" && path === `actions/runs/${input.failure.runId}` && ++reads === 2
    ? { ...state.run, run_attempt: 2 } : github(path, options);
  await expect(verifyDevPreuploadFailure(input, read, blobs)).rejects.toThrow();
});
it("refuses a renderer-refusal code against a failed build job, and a build code against a renderer refusal", async () => {
  const { input, github } = buildFixture("dev_refresh_frozen_build_failed");
  input.failure.code = "retained_dev_renderer_source_differs";
  await expect(verifyDevPreuploadFailure(input, github, buildBlob)).rejects.toThrow();
  const renderer = structuredClone(request); renderer.failure.code = "dev_refresh_frozen_build_failed";
  await expect(verifyDevPreuploadFailure(renderer, fixture().github, recordedDevPreuploadSourceBlob)).rejects.toThrow();
});
it("accepts only the listed failure codes and maps each to its queue error", () => {
  for (const code of [...BUILD_CODES, "retained_dev_renderer_source_differs"]) {
    const value = structuredClone(request); value.failure.code = code;
    expect(contract.parseDevPreuploadSettlement(value)).toBe(value);
    expect(contract.failureMessage(code)).toBe(contract.FAILURES[code]);
  }
  for (const code of ["unknown", "toString", "__proto__", null]) {
    const value = structuredClone(request); value.failure.code = code;
    expect(() => contract.parseDevPreuploadSettlement(value)).toThrow();
    expect(() => contract.failureMessage(code)).toThrow();
  }
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
