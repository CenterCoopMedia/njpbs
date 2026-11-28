import { describe, expect, it } from "vitest";
import { jobId, outboxJob, planLinks, SYSTEM_ACTOR } from "../../scripts/link-public-fix-pull-requests.mjs";

const FIX = "example-owner/public-code";
const report = (id, overrides = {}) => ({ id, status: "acknowledged",
  links: { githubIssueNumbers: [41], pullRequestNumbers: [], pullRequests: [] }, ...overrides });

describe("public fix backfill plan", () => {
  it("plans one attach job per mapped pull request and skips links already in the fix namespace", () => {
    const linked = report("br_b", { fixPullRequestRepository: FIX, fixPullRequestRepositoryId: 1000002,
      links: { githubIssueNumbers: [41], pullRequestNumbers: [7] } });
    const privateNamespace = report("br_c", { links: { githubIssueNumbers: [42], pullRequestNumbers: [7] } });
    const plan = planLinks(new Map([[41, [report("br_a"), linked]], [42, [privateNamespace]]]), FIX,
      { 41: [7, 8], 42: [7], 43: [9] });
    expect(plan.filter((row) => row.jobId).map((row) => row.jobId))
      .toEqual([jobId("br_a", 7), jobId("br_a", 8), jobId("br_b", 8), jobId("br_c", 7)]);
    expect(plan).toContainEqual(expect.objectContaining({ reportId: "br_b", pullNumber: 7, skip: "already linked" }));
    expect(plan).toContainEqual({ issueNumber: 43, reportId: null, skip: "no report links this issue" });
  });

  it("queues only the administrator attach operation, without status or email fields", () => {
    const now = new Date("2026-11-28T12:00:00.000Z");
    const job = outboxJob({ reportId: "br_a", pullNumber: 7 }, now);
    expect(job).toEqual({ reportId: "br_a", operation: "attach_pull_request", targetNumber: 7, requestedBy: SYSTEM_ACTOR,
      state: "pending", attemptCount: 0, nextAttemptAt: now, leaseUntil: null, lastError: null, createdAt: now, updatedAt: now });
  });
});
