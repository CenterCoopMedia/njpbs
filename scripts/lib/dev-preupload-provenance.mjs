import { repositoryIdentity } from "./repository-identity.mjs";
import dispatch from "../../functions/lib/cms-publish-dispatch.js";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import contract from "../../functions/lib/dev-publication-preupload.js";

const root = fileURLToPath(new URL("../../", import.meta.url));

// These reviewed source blobs place the exact seal refusal before every upload.
// An unfamiliar publisher/workflow needs source review, never an absence waiver.
const sources = [{
  "site/scripts/cms-dev-publication.mjs": "f1be6de3daf8a000cb3002c210e07a998765c9c2",
  ".github/workflows/cms-dev-publish.yml": "e5ebbc5204e0874d2841afbf30c74c5f0e55742a",
}, {
  "site/scripts/cms-dev-publication.mjs": "63a5e05f4b066d2dce213e25304371e7fa3c1591",
  ".github/workflows/cms-dev-publish.yml": "7ced4c2d20866733f82732cbd648cdfb28c8c325",
}, {
  // This publisher version changed the seal shape and upload capability;
  // this refusal still precedes context retention, upload, candidate and lease.
  "site/scripts/cms-dev-publication.mjs": "848555f2baf30a031ea4130c81fc03e7e92e5f5b",
  ".github/workflows/cms-dev-publish.yml": "7ced4c2d20866733f82732cbd648cdfb28c8c325",
}];
function readGitSourceBlob(commitSha, filename) {
  return execFileSync("git", ["--no-optional-locks", "rev-parse", `${commitSha}:${filename}`], {
      cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  }).trim();
}
export function assertDevPreuploadFailureSource(commitSha, readSourceBlob = readGitSourceBlob) {
  const actual = Object.fromEntries(Object.keys(sources[0]).map(filename => [filename, readSourceBlob(commitSha, filename)]));
  if (!sources.some(source => Object.entries(source).every(([filename, blob]) => actual[filename] === blob))) contract.refuse();
}

// Only a first execution on attempt 2 is admitted. Even a failed prepare/build
// step in attempt 1 leaves uncertainty; all four original jobs must be skipped.
function assertSkippedFirstAttempt(jobs, { failure, identity }) {
  const names = ["reconcile", "prepare", "build", "finalize"];
  if (jobs?.total_count !== names.length || !Array.isArray(jobs.jobs) || jobs.jobs.length !== names.length ||
      names.some(name => jobs.jobs.filter(job => job.name === name).length !== 1) ||
      new Set(jobs.jobs.map(job => job.id)).size !== names.length ||
      jobs.jobs.some(job => !Number.isSafeInteger(job.id) || job.id < 1 || String(job.run_id) !== failure.runId ||
        job.run_attempt !== 1 || job.head_sha !== identity.commitSha || job.status !== "completed" ||
        job.conclusion !== "skipped" || !Array.isArray(job.steps) || job.steps.length !== 0)) contract.refuse();
}

async function boundedBytes(response) {
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 256 * 1024) contract.refuse();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Fixed GitHub origin, bounded reads and no raw API/log output. */
export function devSettlementGithub(token, request = fetch, env = process.env) {
  const { repository: repo } = repositoryIdentity(env);
  return async (suffix, { log = false, allowMissing = false } = {}) => {
    const response = await request(`https://api.github.com/repos/${repo}/${suffix}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      redirect: "manual", signal: AbortSignal.timeout(30_000),
    });
    if (allowMissing && response.status === 404) return null;
    let content = response;
    if (log) {
      const location = new URL(response.headers.get("location"));
      if (response.status !== 302 || location.protocol !== "https:" || location.username || location.password ||
          !location.hostname.endsWith(".blob.core.windows.net")) contract.refuse();
      content = await request(location, { redirect: "error", signal: AbortSignal.timeout(30_000) });
    }
    if (!content.ok) contract.refuse();
    const bytes = await boundedBytes(content);
    return log ? bytes : JSON.parse(bytes.toString("utf8"));
  };
}

export async function verifyDevPreuploadFailure(request, github, readSourceBlob) {
  const { repository: repo } = repositoryIdentity();
  contract.parseDevPreuploadSettlement(request);
  assertDevPreuploadFailureSource(request.identity.commitSha, readSourceBlob);
  const { failure, identity } = request;
  const trusted = dispatch.trustedPublishActors();
  if (!trusted.length) contract.refuse();
  const [run, jobs, hold, override, ...active] = await Promise.all([
    github(`actions/runs/${failure.runId}`), github(`actions/runs/${failure.runId}/attempts/${failure.runAttempt}/jobs?per_page=100`),
    github("actions/variables/CMS_DEV_PUBLISH_ENABLED"),
    github("environments/development/variables/CMS_DEV_PUBLISH_ENABLED", { allowMissing: true }),
    ...["queued", "in_progress", "waiting", "requested", "pending"].map(status =>
      github(`actions/workflows/cms-dev-publish.yml/runs?status=${status}&per_page=1`)),
  ]);
  if (String(run.id) !== failure.runId || run.run_attempt !== failure.runAttempt || run.status !== "completed" || run.conclusion !== "failure" ||
      run.path !== ".github/workflows/cms-dev-publish.yml" || run.head_branch !== "main" || run.head_sha !== identity.commitSha ||
      run.event !== "push" || !trusted.includes(run.actor?.login) || !trusted.includes(run.triggering_actor?.login) ||
      run.repository?.full_name !== repo || run.head_repository?.full_name !== repo ||
      hold?.value !== "false" || override !== null || active.some(result => result.total_count !== 0) ||
      !Array.isArray(jobs.jobs) || jobs.total_count !== jobs.jobs.length) contract.refuse();
  if (failure.runAttempt === 2) {
    assertSkippedFirstAttempt(await github(`actions/runs/${failure.runId}/attempts/1/jobs?per_page=100`), request);
  }
  const job = jobs.jobs.find(value => String(value.id) === failure.jobId);
  if (!job || String(job.run_id) !== failure.runId || job.run_attempt !== failure.runAttempt || job.head_sha !== identity.commitSha ||
      job.name !== "finalize" || job.status !== "completed" || job.conclusion !== "failure" || job.completed_at !== failure.completedAt ||
      !Array.isArray(job.steps) || job.steps.filter(step => step.conclusion === "failure").length !== 1 ||
      !job.steps.some(step => step.number === 10 && step.name === "Upload only to dev, verify receipts, and settle dev queue" &&
        step.conclusion === "failure") || !job.steps.some(step => step.number === 11 && step.conclusion === "success")) contract.refuse();
  const log = await github(`actions/jobs/${failure.jobId}/logs`, { log: true });
  if (createHash("sha256").update(log).digest("hex") !== failure.logDigest ||
      log.toString("utf8").split(/\r?\n/).filter(line =>
        /^\d{4}-\d\d-\d\dT[0-9:.]+Z Retained dev renderer source differs$/.test(line)).length !== 1) contract.refuse();
  // Recheck the attempt after reading logs: a rerun invalidates this proof.
  const latest = await github(`actions/runs/${failure.runId}`);
  if (latest.run_attempt !== failure.runAttempt || latest.status !== "completed" || latest.conclusion !== "failure") contract.refuse();
}
