import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { parseKilledRefreshPacket, verifyKilledDevRefresh } from "../../scripts/settle-dev-killed-refresh.mjs";

const UPLOAD = "Upload only to dev, verify receipts, and settle dev queue";
beforeEach(() => {
  vi.stubEnv("CANONICAL_GITHUB_REPOSITORY", "CenterCoopMedia/njpbs");
  vi.stubEnv("CANONICAL_GITHUB_REPOSITORY_ID", "1");
});
afterEach(() => vi.unstubAllEnvs());

function fixture(upload = "skipped") {
  const repo = { full_name: "CenterCoopMedia/njpbs" };
  const state = { run: { id: 1001, run_attempt: 1, status: "completed", path: ".github/workflows/cms-dev-publish.yml",
    repository: repo, head_repository: repo }, latest: null,
  jobs: { total_count: 2, jobs: [
    { run_id: 1001, name: "build", status: "completed", steps: [{ name: "Build", conclusion: "cancelled" }] },
    { run_id: 1001, name: "finalize", status: "completed", steps: [{ name: UPLOAD, conclusion: upload }] }] } };
  let runReads = 0;
  const github = async path => path.includes("/jobs?") ? state.jobs : (runReads++ && state.latest) || state.run;
  return { state, github };
}

const packet = () => ({ schemaVersion: 1, kind: "dev-killed-refresh-settlement", operatorCommitSha: "c".repeat(40),
  credentialIdentity: { projectId: "njpbs-site-dev", clientEmail: "cms-sdk@njpbs-site-dev.iam.gserviceaccount.com",
    privateKeyId: "f".repeat(40), secretRef: "pass://example/service/credential" },
  request: { runId: "1001", commitSha: "a".repeat(40) } });

it("derives the queue and batch from the run id", () => {
  vi.stubEnv("CMS_DEV_SDK_CLIENT_EMAIL", "cms-sdk@njpbs-site-dev.iam.gserviceaccount.com");
  const queueId = createHash("sha256").update("dev-code-refresh:1001").digest("hex").slice(0, 20);
  expect(parseKilledRefreshPacket(packet()).identity).toEqual({ queueId, buildBatchId: `cms-${queueId}`, commitSha: "a".repeat(40) });
});

it.each(["kind", "run id", "commit", "extra field"])("refuses a packet with a wrong %s", mode => {
  vi.stubEnv("CMS_DEV_SDK_CLIENT_EMAIL", "cms-sdk@njpbs-site-dev.iam.gserviceaccount.com");
  const value = packet();
  if (mode === "kind") value.kind = "dev-preupload-settlement";
  if (mode === "run id") value.request.runId = "0";
  if (mode === "commit") value.request.commitSha = "A".repeat(40);
  if (mode === "extra field") value.request.queueId = "x";
  expect(() => parseKilledRefreshPacket(value)).toThrow();
});

it("accepts a completed run whose upload step was skipped or never listed", async () => {
  await expect(verifyKilledDevRefresh("1001", fixture("skipped").github)).resolves.toBeUndefined();
  const { state, github } = fixture();
  state.jobs.jobs[1].steps = [];
  await expect(verifyKilledDevRefresh("1001", github)).resolves.toBeUndefined();
});

// A failed or cancelled upload may have reached the provider; it keeps retained reconciliation.
it.each(["failure", "cancelled", "success", null])("refuses an upload step that concluded %s", async upload => {
  await expect(verifyKilledDevRefresh("1001", fixture(upload).github)).rejects.toThrow("refused");
});

it.each(["upload succeeded", "running", "other workflow", "other repo", "truncated jobs", "job running", "rerun started",
  "other run"])("refuses %s", async mode => {
  const { state, github } = fixture(mode === "upload succeeded" ? "success" : "skipped");
  if (mode === "running") state.run.status = "in_progress";
  if (mode === "other workflow") state.run.path = ".github/workflows/cms-staging-deploy.yml";
  if (mode === "other repo") state.run.head_repository = { full_name: "fork/njpbs" };
  if (mode === "truncated jobs") state.jobs.total_count++;
  if (mode === "job running") state.jobs.jobs[0].status = "in_progress";
  if (mode === "rerun started") state.latest = { ...state.run, run_attempt: 2, status: "queued" };
  if (mode === "other run") state.run.id = 1002;
  await expect(verifyKilledDevRefresh("1001", github)).rejects.toThrow("refused");
});

it("reads every attempt and refuses an upload that succeeded in an earlier one", async () => {
  const { state, github } = fixture();
  state.run.run_attempt = 2;
  const reads = [];
  const first = { total_count: 1, jobs: [{ run_id: 1001, status: "completed", steps: [{ name: UPLOAD, conclusion: "success" }] }] };
  await expect(verifyKilledDevRefresh("1001", async path => {
    reads.push(path);
    return path.includes("/attempts/1/") ? first : github(path);
  })).rejects.toThrow("refused");
  expect(reads).toContain("actions/runs/1001/attempts/1/jobs?per_page=100");
});
