import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { createHmac } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import adminPkg from "../helpers/firebase-admin.js";
import github from "../../functions/bug-report-github.js";
import contract from "../../functions/lib/bug-report-contract.js";
import nudges from "../../functions/lib/bug-report-nudge.js";

const admin = adminPkg;
const PROJECT = process.env.GCLOUD_PROJECT || "demo-njpbs";
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
const NOW = new Date("2026-08-29T00:00:00.000Z");
const REPORT_ID = contract.mintBugReportId("d".repeat(32));
let db;

function report(overrides = {}) {
  return {
    ...contract.composeBugReport({
      severity: "blocker",
      area: "content_editing",
      tryingToDo: "Save the homepage @all #urgent",
      happened: "The save stopped. [Open this](https://example.test).",
      expected: "The draft should save.",
      steps: "Open Home.\nSelect Save.",
      workaround: "Keep the editor open.",
      consoleLogs: [{
        level: "error",
        message: "Save request failed with status 409",
        timestamp: "2026-08-28T23:59:58.000Z",
      }],
      route: "/content/pages/home/edit?token=secret",
      affectedRecord: { kind: "page", id: "home", version: 7 },
      clientContext: {
        browser: "Chrome 140",
        operatingSystem: "Windows 11",
        viewport: { width: 1280, height: 720 },
        online: true,
        timeZone: "America/New_York",
      },
      correlationIds: [],
    }, {
      reportId: REPORT_ID,
      nowIso: NOW.toISOString(),
      reporter: { uid: "editor-1", email: "editor@example.org", role: "editor" },
      buildRevision: "b".repeat(40),
      deploymentEnvironment: "production",
      requestId: "22222222-2222-4222-8222-222222222222",
    }),
    ...overrides,
  };
}

async function seedJob(operation = "create_issue", overrides = {}) {
  const stored = report({
    githubDelivery: {
      ...contract.initialGithubDelivery(),
      state: "pending",
      lastOperation: operation,
    },
  });
  await db.collection("bug_reports").doc(stored.id).set(stored);
  await db.collection("bugReportGithubOutbox").doc("job-1").set({
    reportId: stored.id,
    operation,
    targetNumber: null,
    requestedBy: "admin-1",
    state: "pending",
    attemptCount: 0,
    nextAttemptAt: NOW,
    leaseUntil: null,
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
  return stored;
}

beforeAll(() => {
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  db = isolatedFirestore("bug-report-github.test.js");
});

beforeEach(async () => {
  await clearEmulatorFirestore(`http://${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" }, db);
});

afterEach(() => { vi.unstubAllEnvs(); });

afterAll(async () => {
  await Promise.all(admin.apps.map((app) => app.delete()));
});

describe("GitHub handoff presentation", () => {
  it("uses the observed problem in the issue title", () => {
    expect(github.renderGithubIssue(report()).title)
      .toContain("The save stopped");
  });

  it("renders a stable issue template and neutralizes report Markdown and mentions", () => {
    const issue = github.renderGithubIssue(report());

    expect(issue.title).toContain(REPORT_ID);
    expect(issue.title).not.toContain("@all");
    expect(issue.body).toContain(github.githubIssueMarker(REPORT_ID));
    expect(issue.body).toContain("## Impact");
    expect(issue.body).toContain("## Workaround tried");
    expect(issue.body).not.toContain("## Proposed resolution");
    expect(issue.body).not.toContain("## Verification");
    expect(issue.body).not.toContain("No approved resolution yet");
    expect(issue.body).toContain("&#91;Open this&#93;");
    expect(issue.body).not.toContain("@all");
    expect(issue.body).not.toContain("token=secret");
    expect(issue.body).not.toContain("editor@example.org");
  });

  it("summarizes review, check, and deployment state conservatively", () => {
    expect(github.reviewState([
      { user: { login: "a" }, state: "APPROVED" },
      { user: { login: "b" }, state: "CHANGES_REQUESTED" },
    ])).toBe("changes_requested");
    expect(github.combinedChecksState({ check_runs: [
      { status: "completed", conclusion: "success" },
      { status: "in_progress", conclusion: null },
    ] }, { state: "success", statuses: [{}] })).toBe("pending");
    expect(github.combinedChecksState({ check_runs: [
      { status: "completed", conclusion: "startup_failure" },
    ] }, { state: "success", statuses: [{}] })).toBe("failure");
    expect(github.deploymentState([{ state: "success" }, { state: "failure" }]))
      .toBe("failure");
  });

  it("keeps a missing linked record from stopping the rest of a sync", async () => {
    const stored = report();
    stored.links.githubIssueNumbers = [1400, 1401];
    stored.links.githubIssues = [{
      number: 1400,
      url: "https://github.com/example-owner/private-reports/issues/1400",
      title: "Removed issue",
      state: "open",
      updatedAt: NOW.toISOString(),
    }];
    stored.links.pullRequestNumbers = [1345];
    const missing = new github.GithubHandoffError("missing", { status: 404 });
    const client = {
      repository: "example-owner/private-reports",
      listIssueTimeline: vi.fn(async () => []),
      getIssue: vi.fn(async (number) => {
        if (number === 1400) throw missing;
        return {
          number,
          html_url: `https://github.com/example-owner/private-reports/issues/${number}`,
          title: "Available issue",
          state: "open",
          updated_at: NOW.toISOString(),
        };
      }),
      getPullRequest: vi.fn(async () => { throw missing; }),
    };

    const result = await github.executeGithubOperation({
      operation: "sync",
      record: stored,
    }, client);

    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ number: 1400, state: "closed", title: "Removed issue" }),
      expect.objectContaining({ number: 1401, state: "open" }),
    ]));
    expect(result.pullRequests).toEqual([
      expect.objectContaining({ number: 1345, state: "closed" }),
    ]);
  });

  it("stops after an uncertain issue-create response", async () => {
    for (const [configured, expected] of [
      [" example-owner/private-reports \n", "example-owner/private-reports"],
    ]) {
      vi.stubEnv("CMS_BUG_REPORT_GITHUB_REPOSITORY", configured);
      const fetchFn = vi.fn(async () => ({ ok: false, status: 503,
        json: vi.fn(async () => ({ message: "unavailable" })) }));
      const client = github.createGithubClient({ token: "test-token-value", fetchFn });
      await expect(client.createIssue({ title: "Test", body: "Test" }))
        .rejects.toMatchObject({ kind: "ambiguous", status: 503 });
      expect(fetchFn.mock.calls[0][0]).toBe(`https://api.github.com/repos/${expected}/issues`);
    }
  });

  it("retries a GitHub 403 response when rate-limit headers identify it", async () => {
    const client = github.createGithubClient({
      token: "test-token-value",
      repository: "example-owner/private-reports",
      fetchFn: vi.fn(async () => ({
        ok: false,
        status: 403,
        headers: new Headers({ "x-ratelimit-remaining": "0" }),
        json: vi.fn(async () => ({ message: "rate limit exceeded" })),
      })),
    });

    await expect(client.getIssue(1400))
      .rejects.toMatchObject({ kind: "retryable", status: 403 });
  });

  it("retries a GitHub secondary-rate-limit 403 response", async () => {
    const client = github.createGithubClient({
      token: "test-token-value",
      repository: "example-owner/private-reports",
      fetchFn: vi.fn(async () => ({
        ok: false,
        status: 403,
        headers: new Headers({
          "retry-after": "60",
          "x-ratelimit-remaining": "42",
        }),
        json: vi.fn(async () => ({ message: "secondary rate limit" })),
      })),
    });

    await expect(client.getIssue(1400))
      .rejects.toMatchObject({ kind: "retryable", status: 403 });
  });

  it("keeps a GitHub permission 403 response terminal", async () => {
    const client = github.createGithubClient({
      token: "test-token-value",
      repository: "example-owner/private-reports",
      fetchFn: vi.fn(async () => ({
        ok: false,
        status: 403,
        headers: new Headers({ "x-ratelimit-remaining": "42" }),
        json: vi.fn(async () => ({ message: "forbidden" })),
      })),
    });

    await expect(client.getIssue(1400))
      .rejects.toMatchObject({ kind: "terminal", status: 403 });
  });

  it("rejects a new attachment before GitHub when the link list is full", async () => {
    const stored = report();
    stored.links.githubIssueNumbers = Array.from({ length: 10 }, (_, index) => 1400 + index);
    const client = { listIssueTimeline: vi.fn(async () => []),
      getIssue: vi.fn() };

    await expect(github.executeGithubOperation({
      operation: "attach_issue",
      targetNumber: 1500,
      record: stored,
    }, client)).rejects.toMatchObject({ kind: "terminal" });
    expect(client.getIssue).not.toHaveBeenCalled();
  });

  it("enforces pull-request capacity but allows refreshing an existing link", async () => {
    const stored = report();
    stored.links.pullRequestNumbers = Array.from({ length: 10 }, (_, index) => 2000 + index);
    const client = {
      repository: "example-owner/private-reports",
      getPullRequest: vi.fn(async (number) => ({
        number,
        html_url: `https://github.com/example-owner/private-reports/pull/${number}`,
        title: "Existing fix",
        state: "open",
        draft: false,
        merged: false,
        head: { sha: "c".repeat(40) },
        updated_at: NOW.toISOString(),
      })),
      listReviews: vi.fn(async () => []),
      listChecks: vi.fn(async () => ({ check_runs: [] })),
      getCommitStatus: vi.fn(async () => ({ state: "pending", statuses: [] })),
      listDeployments: vi.fn(async () => []),
    };

    await expect(github.executeGithubOperation({
      operation: "attach_pull_request",
      targetNumber: 2100,
      record: stored,
    }, client)).rejects.toMatchObject({ kind: "terminal" });
    expect(client.getPullRequest).not.toHaveBeenCalled();

    await expect(github.executeGithubOperation({
      operation: "attach_pull_request",
      targetNumber: 2000,
      record: stored,
    }, client)).resolves.toMatchObject({
      pullRequests: [expect.objectContaining({ number: 2000 })],
    });
    expect(client.getPullRequest).toHaveBeenCalledOnce();
  });

  it("selects one high-confidence open duplicate and refuses an ambiguous pair", () => {
    const stored = report({
      tryingToDo: "Use the NJ Spotlight News carousel on the homepage.",
      happened: "The right chevron looks vertically off-center in its circular button.",
      expected: "The chevron should be centered in the button.",
      steps: "Open the homepage and view the right carousel control.",
    });
    const matching = {
      number: 706,
      title: "[bug] Chevron off center for NJSN carousel",
      body: "",
      state: "open",
    };
    const unrelated = {
      number: 800,
      title: "Fix the membership form confirmation",
      body: "",
      state: "open",
    };

    expect(github.selectReusableIssue(stored, [unrelated, matching]))
      .toBe(matching);
    expect(github.selectReusableIssue(stored, [
      matching,
      { ...matching, number: 707 },
    ])).toBeNull();
  });

  it("requires four matching title terms before it reuses one issue", () => {
    const stored = report({
      tryingToDo: "Edit the homepage carousel.",
      happened: "The editor carousel control is misplaced.",
      expected: "The homepage carousel control should stay aligned.",
    });

    expect(github.selectReusableIssue(stored, [{
      number: 900,
      title: "Homepage carousel editor alignment",
      body: "The homepage carousel editor control is misplaced.",
      state: "open",
    }])).toBeNull();
  });

  it("verifies GitHub webhook signatures against the raw request bytes", () => {
    const body = Buffer.from('{"repository":{"full_name":"example-owner/private-reports"}}');
    const signature = `sha256=${createHmac("sha256", "test-secret").update(body).digest("hex")}`;

    expect(github.verifyGithubWebhookSignature("test-secret", body, signature)).toBe(true);
    expect(github.verifyGithubWebhookSignature("wrong-secret", body, signature)).toBe(false);
  });

  it("routes pull request comments to the linked pull request", () => {
    expect(github.webhookTargetNumbers("issue_comment", {
      issue: { number: 1500, pull_request: { url: "https://api.github.test/pulls/1500" } },
    })).toEqual({ issueNumbers: [], pullRequestNumbers: [1500] });
  });

  it("waits for completed check events before it queues a full sync", () => {
    expect(github.webhookTargetNumbers("check_suite", {
      action: "in_progress",
      check_suite: { pull_requests: [{ number: 1500 }] },
    })).toEqual({ issueNumbers: [], pullRequestNumbers: [] });
    expect(github.webhookTargetNumbers("check_suite", {
      action: "completed",
      check_suite: { pull_requests: [{ number: 1500 }] },
    })).toEqual({ issueNumbers: [], pullRequestNumbers: [1500] });
  });

  it("uses event triggers for new work and an hourly recovery schedule", () => {
    expect(github.onBugReportGithubOutboxCreated.__endpoint.eventTrigger).toBeTruthy();
    expect(github.onBugReportGithubSync.__endpoint.scheduleTrigger.schedule)
      .toBe("every 60 minutes");
  });
});

describe("durable GitHub handoff", () => {
  it.each(["terminal", "ambiguous", "retryable"])("uses a %s fix-handoff failure's real phase change for nudge timing", async (kind) => {
    const stored = await seedJob("create_issue_and_fix");
    const reportRef = db.collection("bug_reports").doc(stored.id);
    await reportRef.update({ "githubDelivery.fixStatus": "pending", progressChangedAt: NOW.toISOString() });
    const row = await github.claimGithubOutboxRow(db, "job-1", NOW);
    const settledAt = new Date(NOW.getTime() + 4 * 24 * 60 * 60 * 1_000);
    const error = new github.GithubHandoffError("synthetic failure", { kind });
    await github.settleGithubFailure(row, error, { firestore: db, now: () => settledAt });
    const next = (await reportRef.get()).data();
    expect(next.progressChangedAt).toBe(kind === "retryable" ? NOW.toISOString() : settledAt.toISOString());
    expect(nudges.nudgeForReporter(next, settledAt).eligible).toBe(kind === "retryable");
    // Replayed settlements must not create another transition or reset the clock.
    await github.settleGithubFailure(row, error, { firestore: db, now: () => new Date(settledAt.getTime() + 1_000) });
    expect((await reportRef.get()).data()).toEqual(next);
  });

  it("serializes issue creation for each report", async () => {
    const stored = await seedJob("create_issue");
    await db.collection("bugReportGithubOutbox").doc("job-2").set({
      reportId: stored.id,
      operation: "create_issue_and_fix",
      targetNumber: null,
      requestedBy: "admin-2",
      state: "pending",
      attemptCount: 0,
      nextAttemptAt: NOW,
      leaseUntil: null,
      lastError: null,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const first = await github.claimGithubOutboxRow(db, "job-1", new Date(NOW));
    await expect(github.claimGithubOutboxRow(db, "job-2", new Date(NOW)))
      .resolves.toBeNull();
    expect((await db.collection("bugReportGithubLocks").doc(stored.id).get()).data())
      .toMatchObject({ jobId: "job-1" });

    await github.settleGithubFailure(
      first,
      new github.GithubHandoffError("stopped", { kind: "terminal" }),
      { firestore: db, now: () => new Date(NOW) },
    );
    await expect(github.claimGithubOutboxRow(db, "job-2", new Date(NOW)))
      .resolves.toMatchObject({ id: "job-2" });
  });

  it("adds the report to an existing issue before starting autofix", async () => {
    const stored = await seedJob("create_issue_and_fix");
    const duplicate = {
      number: 706,
      html_url: "https://github.com/example-owner/private-reports/issues/706",
      title: "Save stopped for homepage draft",
      body: "The homepage draft cannot save after editing.",
      state: "open",
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    };
    const client = {
      listIssues: vi.fn(async () => []),
      listOpenIssues: vi.fn(async () => [duplicate]),
      listIssueComments: vi.fn(async () => []),
      createIssueComment: vi.fn(async () => ({ id: 1 })),
      listIssueTimeline: vi.fn(async () => []),
      getIssue: vi.fn(async () => duplicate),
      createIssue: vi.fn(),
    };

    await expect(github.processGithubOutboxRow("job-1", {
      firestore: db,
      now: () => new Date(NOW),
      client,
    })).resolves.toEqual({ state: "delivered" });

    expect(client.createIssue).not.toHaveBeenCalled();
    expect(client.createIssueComment).toHaveBeenCalledWith(
      706,
      expect.stringContaining(github.githubIssueMarker(stored.id)),
    );
    expect((await db.collection("bug_reports").doc(stored.id).get()).data().links)
      .toMatchObject({ githubIssueNumbers: [706] });
    expect((await db.collection("bugReportAutofixOutbox").doc(stored.id).get()).data())
      .toMatchObject({ issueNumber: 706, issueSelection: "reused", state: "pending" });
    expect((await db.collection("bugReportGithubOutbox").doc("job-1").get()).data())
      .toMatchObject({ targetNumber: 706, state: "delivered" });
  });

  it("pins a reused issue before an uncertain comment write", async () => {
    const stored = await seedJob("create_issue_and_fix");
    const duplicate = {
      number: 706,
      html_url: "https://github.com/example-owner/private-reports/issues/706",
      title: "Save stopped for homepage draft",
      body: "The homepage draft cannot save after editing.",
      state: "open",
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    };
    const client = {
      listIssues: vi.fn(async () => []),
      listOpenIssues: vi.fn(async () => [duplicate]),
      listIssueComments: vi.fn(async () => []),
      createIssueComment: vi.fn(async () => {
        throw new github.GithubHandoffError("unknown", { kind: "ambiguous" });
      }),
      createIssue: vi.fn(),
    };

    await expect(github.processGithubOutboxRow("job-1", {
      firestore: db,
      now: () => new Date(NOW),
      client,
    })).resolves.toEqual({ state: "unknown" });

    expect((await db.collection("bugReportGithubOutbox").doc("job-1").get()).data())
      .toMatchObject({ targetNumber: 706, state: "unknown" });
    expect((await db.collection("bug_reports").doc(stored.id).get()).data().links)
      .toMatchObject({ githubIssueNumbers: [] });
    expect((await db.collection("bug_reports").doc(stored.id).get()).data().githubDelivery)
      .toMatchObject({ state: "unknown", lastTargetNumber: 706 });
  });

  it("retries a pinned reused issue without selecting a different candidate", async () => {
    const stored = await seedJob("create_issue_and_fix", { targetNumber: 706 });
    const duplicate = {
      number: 706,
      html_url: "https://github.com/example-owner/private-reports/issues/706",
      title: "Save stopped for homepage draft",
      body: "The homepage draft cannot save after editing.",
      state: "open",
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    };
    const client = {
      listIssues: vi.fn(async () => []),
      listOpenIssues: vi.fn(),
      listIssueTimeline: vi.fn(async () => []),
      getIssue: vi.fn(async () => duplicate),
      listIssueComments: vi.fn(async () => [{
        body: github.githubIssueMarker(stored.id),
      }]),
      createIssueComment: vi.fn(),
      createIssue: vi.fn(),
    };

    await expect(github.processGithubOutboxRow("job-1", {
      firestore: db,
      now: () => new Date(NOW),
      client,
    })).resolves.toEqual({ state: "delivered" });

    expect(client.listOpenIssues).not.toHaveBeenCalled();
    expect(client.createIssueComment).not.toHaveBeenCalled();
    expect((await db.collection("bugReportAutofixOutbox").doc(stored.id).get()).data())
      .toMatchObject({ issueNumber: 706, issueSelection: "reused" });
  });

  it("queues one idempotent sync job for a signed GitHub event", async () => {
    const stored = report();
    stored.links.githubIssueNumbers = [706];
    await db.collection("bug_reports").doc(stored.id).set(stored);
    const input = {
      firestore: db,
      repository: "example-owner/private-reports",
      eventName: "issues",
      deliveryId: "11111111-2222-4333-8444-555555555555",
      payload: {
        repository: { full_name: "example-owner/private-reports" },
        issue: { number: 706 },
      },
      now: () => new Date(NOW),
    };

    await expect(github.queueGithubWebhookSync(input))
      .resolves.toEqual({ state: "queued", count: 1 });
    await expect(github.queueGithubWebhookSync(input))
      .resolves.toEqual({ state: "replayed", count: 0 });
    expect((await db.collection("bugReportGithubOutbox").get()).size).toBe(1);
    expect((await db.collection("bugReportGithubWebhookReceipts").get()).size).toBe(1);
  });

  it("does not create a receipt for an event with no linked report", async () => {
    const input = {
      firestore: db,
      repository: "example-owner/private-reports",
      eventName: "issues",
      deliveryId: "11111111-2222-4333-8444-555555555556",
      payload: {
        repository: { full_name: "example-owner/private-reports" },
        issue: { number: 9999 },
      },
      now: () => new Date(NOW),
    };

    await expect(github.queueGithubWebhookSync(input))
      .resolves.toEqual({ state: "ignored", count: 0 });
    expect((await db.collection("bugReportGithubWebhookReceipts").get()).empty).toBe(true);
    expect((await db.collection("bugReportGithubOutbox").get()).empty).toBe(true);
  });

  it("reconciles before creation, links the issue, audits, and queues one card update", async () => {
    const stored = await seedJob("create_issue_and_fix");
    const client = {
      listIssues: vi.fn(async () => []),
      listOpenIssues: vi.fn(async () => []),
      createIssue: vi.fn(async () => ({
        number: 1400,
        html_url: "https://github.com/example-owner/private-reports/issues/1400",
        title: "CMS report",
        state: "open",
        created_at: NOW.toISOString(),
        updated_at: NOW.toISOString(),
      })),
    };

    await expect(github.processGithubOutboxRow("job-1", {
      firestore: db,
      now: () => new Date(NOW),
      client,
    })).resolves.toEqual({ state: "delivered" });

    expect(client.listIssues).toHaveBeenCalledWith(stored.createdAt, 1);
    expect(client.createIssue).toHaveBeenCalledTimes(1);
    const updated = (await db.collection("bug_reports").doc(stored.id).get()).data();
    expect(updated).toMatchObject({
      version: 2,
      githubDelivery: { state: "synced", lastOperation: "create_issue_and_fix" },
      links: { githubIssueNumbers: [1400] },
    });
    expect((await db.collection("bugReportAutofixOutbox").doc(stored.id).get()).data())
      .toMatchObject({ state: "pending", issueNumber: 1400 });
    expect((await db.collection("bugReportDeliveryOutbox").get()).size).toBe(1);
    expect((await db.collection("admin_logs").get()).size).toBe(1);
  });

  it("preserves an existing autofix job when a handoff retry settles", async () => {
    const stored = await seedJob("create_issue_and_fix");
    await db.collection("bugReportAutofixOutbox").doc(stored.id).set({
      reportId: stored.id,
      issueNumber: 1400,
      issueUrl: "https://github.com/example-owner/private-reports/issues/1400",
      state: "completed",
      attemptCount: 1,
      pullRequestUrl: "https://github.com/example-owner/private-reports/pull/1500",
      updatedAt: NOW,
    });
    const client = {
      getAuthenticatedUser: vi.fn(async () => ({ id: 424242, login: "fixture-user" })),
      listIssues: vi.fn(async () => [{
        number: 1400,
        html_url: "https://github.com/example-owner/private-reports/issues/1400",
        title: "CMS report",
        body: github.githubIssueMarker(stored.id),
        user: { id: 424242, login: "fixture-user" },
        state: "open",
        created_at: NOW.toISOString(),
        updated_at: NOW.toISOString(),
      }]),
      createIssue: vi.fn(),
    };

    await expect(github.processGithubOutboxRow("job-1", {
      firestore: db,
      now: () => new Date(NOW),
      client,
    })).resolves.toEqual({ state: "delivered" });

    expect(client.createIssue).not.toHaveBeenCalled();
    expect((await db.collection("bugReportAutofixOutbox").doc(stored.id).get()).data())
      .toMatchObject({ state: "completed", attemptCount: 1, pullRequestUrl: expect.stringContaining("/1500") });
  });

  it("keeps unexpected sync settlement failures retryable", async () => {
    const stored = await seedJob("sync");
    const realRunTransaction = db.runTransaction.bind(db);
    let calls = 0;
    const firestore = Object.create(db);
    firestore.runTransaction = async (handler) => {
      calls += 1;
      if (calls === 2) throw new Error("temporary settlement failure");
      return realRunTransaction(handler);
    };
    firestore.collection = db.collection.bind(db);
    const client = { repository: "example-owner/private-reports" };

    await expect(github.processGithubOutboxRow("job-1", {
      firestore,
      now: () => new Date(NOW),
      client,
    })).resolves.toEqual({ state: "pending" });

    expect((await db.collection("bugReportGithubOutbox").doc("job-1").get()).data())
      .toMatchObject({ state: "pending", attemptCount: 1 });
    expect((await db.collection("bug_reports").doc(stored.id).get()).data().githubDelivery)
      .toMatchObject({ state: "retryable_failed", lastOperation: "sync" });
  });

  it("does not retry an ambiguous issue creation without an explicit admin action", async () => {
    const stored = await seedJob();
    const client = {
      listIssues: vi.fn(async () => []),
      listOpenIssues: vi.fn(async () => []),
      createIssue: vi.fn(async () => {
        throw new github.GithubHandoffError("unknown", { kind: "ambiguous" });
      }),
    };

    await expect(github.processGithubOutboxRow("job-1", {
      firestore: db,
      now: () => new Date(NOW),
      client,
    })).resolves.toEqual({ state: "unknown" });

    expect((await db.collection("bugReportGithubOutbox").doc("job-1").get()).data())
      .toMatchObject({ state: "unknown", nextAttemptAt: null });
    expect((await db.collection("bug_reports").doc(stored.id).get()).data().githubDelivery)
      .toMatchObject({ state: "unknown", lastOperation: "create_issue" });
    expect((await db.collection("bug_reports").doc(stored.id).get()).data().version)
      .toBe(2);
    expect((await db.collection("bugReportDeliveryOutbox").get()).size).toBe(1);
  });

  it("verifies a manual pull request and records review, checks, and deployment links", async () => {
    const stored = await seedJob("attach_pull_request", { targetNumber: 1345 });
    const client = {
      repository: "example-owner/private-reports",
      getPullRequest: vi.fn(async () => ({
        number: 1345,
        html_url: "https://github.com/example-owner/private-reports/pull/1345",
        title: "Fix save",
        state: "open",
        draft: true,
        merged: false,
        head: { sha: "c".repeat(40) },
        created_at: NOW.toISOString(),
        updated_at: NOW.toISOString(),
      })),
      listReviews: vi.fn(async () => [{ user: { login: "reviewer" }, state: "APPROVED" }]),
      listChecks: vi.fn(async () => ({ check_runs: [
        { status: "completed", conclusion: "success", details_url: "https://github.com/example-owner/private-reports/actions/runs/1" },
        { status: "completed", conclusion: "success", details_url: "https://github.com/example-owner/private-reports-lookalike/actions/runs/2" },
      ] })),
      getCommitStatus: vi.fn(async () => ({ state: "success", statuses: [] })),
      listDeployments: vi.fn(async () => [{ id: 4 }]),
      listDeploymentStatuses: vi.fn(async () => [{ state: "success", log_url: "https://github.com/example-owner/private-reports/deployments/4" }]),
    };

    await github.processGithubOutboxRow("job-1", { firestore: db, now: () => new Date(NOW), client });

    const updated = (await db.collection("bug_reports").doc(stored.id).get()).data();
    expect(updated.links.pullRequests[0]).toMatchObject({
      number: 1345,
      draft: true,
      reviewState: "approved",
      checksState: "success",
      deploymentState: "success",
    });
    expect(updated.links.workflowRunUrls).toEqual(["https://github.com/example-owner/private-reports/actions/runs/1"]);
  });

  it("reschedules the same recurring sync job without reusing card update IDs", async () => {
    const stored = report();
    stored.links.githubIssueNumbers = [1400];
    await db.collection("bug_reports").doc(stored.id).set(stored);
    const syncId = `${stored.id}--sync`;
    await db.collection("bugReportGithubOutbox").doc(syncId).set({
      reportId: stored.id,
      operation: "sync",
      targetNumber: null,
      requestedBy: "system:bug-report-github",
      state: "pending",
      attemptCount: 0,
      nextAttemptAt: NOW,
      leaseUntil: null,
      lastError: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const client = {
      repository: "example-owner/private-reports",
      listIssueTimeline: vi.fn(async () => []),
      getIssue: vi.fn(async () => ({
        number: 1400,
        html_url: "https://github.com/example-owner/private-reports/issues/1400",
        title: "CMS report",
        state: "open",
        updated_at: NOW.toISOString(),
      })),
    };

    await expect(github.processGithubOutboxRow(syncId, {
      firestore: db,
      now: () => new Date(NOW),
      client,
    })).resolves.toEqual({ state: "delivered" });
    const nextRun = new Date(NOW.getTime() + 24 * 60 * 60 * 1_000);
    await expect(github.processGithubOutboxRow(syncId, {
      firestore: db,
      now: () => nextRun,
      client,
    })).resolves.toEqual({ state: "delivered" });

    expect(client.getIssue).toHaveBeenCalledTimes(2);
    expect((await db.collection("bugReportGithubOutbox").doc(syncId).get()).data())
      .toMatchObject({ state: "pending", attemptCount: 0 });
    expect((await db.collection("bugReportDeliveryOutbox").get()).size).toBe(2);
    expect((await db.collection("admin_logs").get()).size).toBe(2);
    expect((await db.collection("bug_reports").doc(stored.id).get()).data().version).toBe(3);
  });
});

describe("report progress reconciliation", () => {
  it("retains a PR attached by File + fix while a sync is in flight", async () => {
    const stored = await seedJob("sync");
    const ref = db.collection("bug_reports").doc(stored.id);
    await ref.update({ "links.githubIssueNumbers": [1400] });
    const client = { listIssueTimeline: vi.fn(async () => []),
      getIssue: vi.fn(async () => {
      await ref.update({ "links.pullRequestNumbers": [2845], "githubDelivery.fixStatus": "draft_pr_open", version: 2 });
      return { number: 1400, html_url: "https://github.com/example-owner/private-reports/issues/1400", title: "CMS report", state: "open", updated_at: NOW.toISOString() };
    }) };
    await github.processGithubOutboxRow("job-1", { firestore: db, now: () => NOW, client });
    const updated = (await ref.get()).data();
    expect(updated.links.pullRequestNumbers).toEqual([2845]);
    // File + fix opened a draft; preserve the link without claiming review readiness.
    expect(contract.reportForReporter(updated, "editor-1").progress.phase).toBe("in_progress");
  });
  it("does not replace newer closed evidence with a delayed open read", async () => {
    const stored = await seedJob("sync");
    const ref = db.collection("bug_reports").doc(stored.id);
    await ref.update({ "links.githubIssueNumbers": [1400], "links.githubIssues": [{ number: 1400, state: "closed", updatedAt: NOW.toISOString() }] });
    const client = { listIssueTimeline: vi.fn(async () => []),
      getIssue: vi.fn(async () => ({ number: 1400, html_url: "https://github.com/example-owner/private-reports/issues/1400", state: "open", updated_at: "2026-08-28T23:00:00.000Z" })) };
    await github.processGithubOutboxRow("job-1", { firestore: db, now: () => NOW, client });
    expect((await ref.get()).data().links.githubIssues[0].state).toBe("closed");
  });
  it("records observed reopen progress without rewriting the administrator resolution", async () => {
    const stored = await seedJob("sync");
    const ref = db.collection("bug_reports").doc(stored.id);
    await ref.update({ status: "resolved", resolvedAt: "2026-08-28T23:30:00.000Z", "links.githubIssueNumbers": [1400],
      "links.githubIssues": [{ number: 1400, state: "closed", updatedAt: "2026-08-28T23:00:00.000Z" }] });
    const client = { listIssueTimeline: vi.fn(async () => []),
      getIssue: vi.fn(async () => ({ number: 1400, html_url: "https://github.com/example-owner/private-reports/issues/1400", state: "open", updated_at: NOW.toISOString() })) };
    await github.processGithubOutboxRow("job-1", { firestore: db, now: () => NOW, client });
    const updated = (await ref.get()).data();
    expect(updated.status).toBe("resolved");
    expect(contract.reportForReporter(updated, "editor-1").progress.phase).toBe("reopened");
  });
  it("queues one update for each report sharing an issue and deduplicates the delivery", async () => {
    const first = report();
    const second = report({ id: `br_${"e".repeat(32)}` });
    for (const value of [first, second]) {
      value.links.githubIssueNumbers = [1400];
      await db.collection("bug_reports").doc(value.id).set(value);
    }
    const input = { firestore: db, repository: "example-owner/private-reports", eventName: "issues", deliveryId: "shared-issue-reopened",
      payload: { repository: { full_name: "example-owner/private-reports" }, issue: { number: 1400 }, action: "reopened" }, now: () => NOW };
    expect(await github.queueGithubWebhookSync(input)).toEqual({ state: "queued", count: 2 });
    expect(await github.queueGithubWebhookSync(input)).toEqual({ state: "replayed", count: 0 });
    expect((await db.collection("bugReportGithubOutbox").get()).size).toBe(2);
  });
});

it("uses a signed reopen hint when the intermediate closed state was missed", async () => {
  const stored = report({ status: "resolved", resolvedAt: "2026-08-28T23:30:00.000Z" });
  stored.links.githubIssueNumbers = [1400];
  stored.links.githubIssues = [{ number: 1400, state: "open", updatedAt: "2026-08-28T23:00:00.000Z" }];
  const ref = db.collection("bug_reports").doc(stored.id);
  await ref.set(stored);
  await github.queueGithubWebhookSync({ firestore: db, repository: "example-owner/private-reports", eventName: "issues",
    deliveryId: "missed-close-reopen", now: () => NOW,
    payload: { repository: { full_name: "example-owner/private-reports" }, action: "reopened", issue: { number: 1400, updated_at: NOW.toISOString() } } });
  const client = { listIssueTimeline: vi.fn(async () => []),
      getIssue: vi.fn(async () => ({ number: 1400, html_url: "https://github.com/example-owner/private-reports/issues/1400", state: "open", updated_at: NOW.toISOString() })) };
  await github.processGithubOutboxRow(`${stored.id}--webhook--missed-close-reopen`, { firestore: db, now: () => NOW, client });
  const updated = (await ref.get()).data();
  expect(updated.status).toBe("resolved");
  expect(contract.reportForReporter(updated, "editor-1").progress.phase).toBe("reopened");
});

it("does not reopen a report from an old webhook when the authoritative issue is closed", async () => {
  const stored = report({ status: "resolved", resolvedAt: "2026-08-28T23:30:00.000Z" });
  stored.links.githubIssueNumbers = [1400];
  const ref = db.collection("bug_reports").doc(stored.id);
  await ref.set(stored);
  await github.queueGithubWebhookSync({ firestore: db, repository: "example-owner/private-reports", eventName: "issues",
    deliveryId: "old-reopen", now: () => NOW,
    payload: { repository: { full_name: "example-owner/private-reports" }, action: "reopened", issue: { number: 1400, updated_at: NOW.toISOString() } } });
  const client = { listIssueTimeline: vi.fn(async () => []),
      getIssue: vi.fn(async () => ({ number: 1400, html_url: "https://github.com/example-owner/private-reports/issues/1400", state: "closed", updated_at: NOW.toISOString() })) };
  await github.processGithubOutboxRow(`${stored.id}--webhook--old-reopen`, { firestore: db, now: () => NOW, client });
  expect(contract.reportForReporter((await ref.get()).data(), "editor-1").progress.phase).toBe("resolved");
});
