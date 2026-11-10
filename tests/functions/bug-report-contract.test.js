import { describe, expect, it } from "vitest";
import bugReportContract from "../../functions/lib/bug-report-contract.js";

const {
  BUG_REPORT_AREAS,
  BUG_REPORT_COLLECTIONS,
  BUG_REPORT_DELIVERY_STATUSES,
  BUG_REPORT_DEPLOYMENT_ENVIRONMENTS,
  BUG_REPORT_RECORD_KINDS,
  BUG_REPORT_ROLES,
  BUG_REPORT_SEVERITIES,
  BUG_REPORT_STATUSES,
  BugReportContractError,
  CAUSE_CERTAINTIES,
  canTransitionBugReportStatus,
  composeBugReport,
  defaultActionableResolution,
  isBugReportId,
  mintBugReportId,
  normalizeActionableResolution,
  normalizeAdminRoute,
  redactReportText,
  reportForAdmin,
  reportForReporter,
} = bugReportContract;

const NOW = "2026-08-28T20:30:00.000Z";
const REPORT_ID = `br_${"a".repeat(32)}`;
const BUILD_REVISION = "b".repeat(40);

function submission(overrides = {}) {
  return {
    severity: "work_impaired",
    area: "content_editing",
    tryingToDo: "Update the homepage lead story.",
    happened: "The save stopped and showed a conflict.",
    expected: "The new lead story should have saved as a draft.",
    steps: "Open Home.\nChange the lead story.\nSelect Save.",
    workaround: "Kept the editor open and did not reload.",
    consoleLogs: [
      {
        level: "error",
        message: "Save failed for producer@example.org token=secret-value",
        timestamp: "2026-08-28T20:29:55.000Z",
      },
    ],
    route: "/content/page/home?panel=lead#editor",
    affectedRecord: {
      kind: "page",
      id: "home",
      lifecycle: "draft",
      version: 7,
    },
    clientContext: {
      browser: "Chrome 140",
      operatingSystem: "Windows 11",
      viewport: { width: 1440, height: 900 },
      online: true,
      timeZone: "America/New_York",
    },
    correlationIds: ["11111111-1111-4111-8111-111111111111"],
    ...overrides,
  };
}

function trustedContext(overrides = {}) {
  return {
    reportId: REPORT_ID,
    nowIso: NOW,
    reporter: {
      uid: "editor-1",
      email: "editor@example.org",
      role: "editor",
    },
    buildRevision: BUILD_REVISION,
    deploymentEnvironment: "production",
    requestId: "22222222-2222-4222-8222-222222222222",
    ...overrides,
  };
}

describe("bug report vocabulary", () => {
  it("keeps the collection and closed status vocabularies stable", () => {
    expect(BUG_REPORT_COLLECTIONS).toEqual({
      reports: "bug_reports",
      evidence: "bugReportEvidence",
      deliveryOutbox: "bugReportDeliveryOutbox",
      githubOutbox: "bugReportGithubOutbox",
      githubLocks: "bugReportGithubLocks",
      autofixOutbox: "bugReportAutofixOutbox",
      followupOutbox: "bugReportFollowupOutbox",
      mutationReceipts: "bugReportMutationReceipts",
      githubWebhookReceipts: "bugReportGithubWebhookReceipts",
      rateLimits: "bugReportRateLimits",
    });
    expect(BUG_REPORT_SEVERITIES).toEqual([
      "blocker",
      "work_impaired",
      "minor",
    ]);
    expect(BUG_REPORT_AREAS).toEqual([
      "sign_in_access",
      "content_editing",
      "save_revision",
      "review_publish",
      "media",
      "navigation_ui",
      "other",
    ]);
    expect(BUG_REPORT_STATUSES).toEqual([
      "open",
      "acknowledged",
      "in_progress",
      "blocked",
      "resolved",
      "dismissed",
    ]);
    expect(BUG_REPORT_DELIVERY_STATUSES).toEqual([
      "not_queued",
      "pending",
      "sending",
      "delivered",
      "retryable_failed",
      "unknown",
      "terminal_failed",
    ]);
    expect(BUG_REPORT_RECORD_KINDS).toEqual([
      "page",
      "post",
      "settings",
      "media",
      "staff_account",
      "author_profile",
      "publish_request",
    ]);
    expect(BUG_REPORT_ROLES).toEqual([
      "staff",
      "contributor",
      "editor",
      "admin",
      "super_admin",
    ]);
    expect(BUG_REPORT_DEPLOYMENT_ENVIRONMENTS).toEqual([
      "production",
      "development",
      "preview",
      "emulator",
      "local",
    ]);
    expect(CAUSE_CERTAINTIES).toEqual([
      "confirmed",
      "suspected",
      "unknown",
    ]);
  });

  it("mints a stable bounded report id from supplied entropy", () => {
    expect(mintBugReportId("A".repeat(40))).toBe(REPORT_ID);
    expect(isBugReportId(REPORT_ID)).toBe(true);
    expect(isBugReportId(`br_${"g".repeat(32)}`)).toBe(false);
    expect(() => mintBugReportId("short")).toThrow(/entropy/i);
  });
});

describe("bug report redaction and route context", () => {
  it("redacts credentials, cookies, JWTs, and email addresses before storage", () => {
    const text = redactReportText(
      "Email producer@example.org\nAuthorization: Bearer abc.def.ghi\n" +
        "cookie=session=secret-value\napi_key=sk-live-value\n" +
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature",
      { label: "What happened", maxBytes: 2_000, required: true },
    );

    expect(text).toContain("[redacted email]");
    expect(text).toContain("Authorization: [redacted]");
    expect(text).toContain("cookie=[redacted]");
    expect(text).toContain("api_key=[redacted]");
    expect(text).toContain("[redacted token]");
    expect(text).not.toContain("producer@example.org");
    expect(text).not.toContain("secret-value");
    expect(text).not.toContain("sk-live-value");
  });

  it("redacts the full credential for every Authorization scheme", () => {
    const text = redactReportText(
      "Authorization: Basic dXNlcjpwYXNz\nAuthorization=Digest secret=value",
      { label: "What happened", maxBytes: 2_000, required: true },
    );

    expect(text).toBe(
      "Authorization: [redacted]\nAuthorization: [redacted]",
    );
    expect(text).not.toContain("dXNlcjpwYXNz");
    expect(text).not.toContain("secret=value");
  });

  it("redacts the complete value of every labeled secret", () => {
    const text = redactReportText(
      "password: correct horse battery staple\ntoken=abc, def ghi",
      { label: "What happened", maxBytes: 2_000, required: true },
    );

    expect(text).toBe("password=[redacted]\ntoken=[redacted]");
    expect(text).not.toContain("horse battery staple");
    expect(text).not.toContain("def ghi");
  });

  it("redacts OAuth-style secret labels inside URLs and messages", () => {
    const text = redactReportText(
      "GET /callback?access_token=oauth-private&state=kept\n" +
        "refresh_token: refresh-private\nx_api_key=api-private\n" +
        "Bearer bearer-private\nghp_abcdefghijklmnopqrstuvwxyz123456",
      { label: "What happened", maxBytes: 2_000, required: true },
    );

    expect(text).toBe(
      "GET /callback?access_token=[redacted]&state=kept\n" +
        "refresh_token=[redacted]\nx_api_key=[redacted]\n" +
        "Bearer [redacted]\n[redacted token]",
    );
    expect(text).not.toContain("oauth-private");
    expect(text).not.toContain("refresh-private");
    expect(text).not.toContain("api-private");
    expect(text).not.toContain("bearer-private");
    expect(text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456");
  });

  it("removes query and fragment data from the canonical Admin route", () => {
    expect(
      normalizeAdminRoute(
        "/content/page/home?token=secret#lead",
        "production",
      ),
    ).toEqual({
      path: "/content/page/home",
      url: "https://admin.njpbs.org/content/page/home",
    });
    expect(normalizeAdminRoute("/content/page/home", "preview")).toEqual({
      path: "/content/page/home",
      url: null,
    });
    expect(() =>
      normalizeAdminRoute("https://evil.example/report", "production"),
    ).toThrow(/Admin route/i);
    expect(() =>
      normalizeAdminRoute("//evil.example/report", "production"),
    ).toThrow(/Admin route/i);
  });
});

describe("bug report record composition", () => {
  it("builds one canonical open report from reporter and server facts", () => {
    const record = composeBugReport(submission(), trustedContext());

    expect(record).toMatchObject({
      apiVersion: 1,
      id: REPORT_ID,
      severity: "work_impaired",
      area: "content_editing",
      reporter: {
        uid: "editor-1",
        email: "editor@example.org",
        role: "editor",
      },
      route: {
        path: "/content/page/home",
        url: "https://admin.njpbs.org/content/page/home",
      },
      affectedRecord: {
        kind: "page",
        id: "home",
        lifecycle: "draft",
        version: 7,
      },
      evidence: { screenshot: null },
      consoleLogs: [{
        level: "error",
        message: "Save failed for [redacted email] token=[redacted]",
        timestamp: "2026-08-28T20:29:55.000Z",
      }],
      environment: {
        buildRevision: BUILD_REVISION,
        deploymentEnvironment: "production",
        browser: "Chrome 140",
        operatingSystem: "Windows 11",
        viewport: { width: 1440, height: 900 },
        online: true,
        timeZone: "America/New_York",
      },
      correlationIds: [
        "22222222-2222-4222-8222-222222222222",
        "11111111-1111-4111-8111-111111111111",
      ],
      status: "open",
      ownerUid: null,
      deliveryStatus: "not_queued",
      delivery: {
        telegramChatId: null,
        telegramMessageId: null,
        attemptCount: 0,
        lastAttemptAt: null,
        lastError: null,
      },
      links: {
        relatedReportIds: [],
        githubIssueNumbers: [],
        pullRequestNumbers: [],
        workflowRunUrls: [],
        deploymentRunUrls: [],
      },
      version: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(record.actionableResolution).toEqual(defaultActionableResolution());
    expect(record).not.toHaveProperty("screenshot");
  });

  it("rejects unbounded or malformed console evidence", () => {
    expect(() => composeBugReport(submission({
      consoleLogs: Array.from({ length: 101 }, () => ({
        level: "log",
        message: "entry",
        timestamp: NOW,
      })),
    }), trustedContext())).toThrow(/console/i);
    expect(() => composeBugReport(submission({
      consoleLogs: [{ level: "trace", message: "entry", timestamp: NOW }],
    }), trustedContext())).toThrow(/console/i);
  });

  it("drops empty console calls and bounds multibyte messages without blocking intake", () => {
    const record = composeBugReport(submission({
      consoleLogs: [
        { level: "log", message: "   ", timestamp: NOW },
        { level: "error", message: "漢".repeat(500), timestamp: NOW },
      ],
    }), trustedContext());

    expect(record.consoleLogs).toHaveLength(1);
    expect(Buffer.byteLength(record.consoleLogs[0].message, "utf8")).toBeLessThanOrEqual(1_000);
    expect(record.consoleLogs[0].message.endsWith("…")).toBe(true);
  });

  it("rejects unknown fields and invalid closed values", () => {
    expect(() =>
      composeBugReport(
        submission({ authenticationToken: "secret" }),
        trustedContext(),
      ),
    ).toThrow(/unknown field authenticationToken/i);
    expect(() =>
      composeBugReport(submission({ severity: "urgent" }), trustedContext()),
    ).toThrow(/severity/i);
    expect(() =>
      composeBugReport(
        submission({ area: "database" }),
        trustedContext(),
      ),
    ).toThrow(/area/i);
  });

  it("requires bounded trusted identity, build, time, and request context", () => {
    for (const context of [
      trustedContext({ reporter: { uid: "", email: "x", role: "editor" } }),
      trustedContext({ buildRevision: "main" }),
      trustedContext({ nowIso: "yesterday" }),
      trustedContext({ requestId: "not-a-uuid" }),
    ]) {
      expect(() => composeBugReport(submission(), context)).toThrow(
        BugReportContractError,
      );
    }
  });

  it("omits affected-record context when the route has no record", () => {
    const input = submission({ affectedRecord: null });
    expect(composeBugReport(input, trustedContext()).affectedRecord).toBeNull();
  });

  it("does not create a production link for a nonproduction report", () => {
    const record = composeBugReport(
      submission(),
      trustedContext({ deploymentEnvironment: "preview" }),
    );

    expect(record.route).toEqual({
      path: "/content/page/home",
      url: null,
    });
  });
});

describe("actionable resolution and lifecycle", () => {
  it("normalizes a concrete resolution and redacts its text", () => {
    expect(
      normalizeActionableResolution({
        immediateSafeAction: "Keep the draft open.",
        likelyCause: {
          certainty: "suspected",
          summary: "A stale revision from producer@example.org.",
        },
        recommendedResolution: [
          "Open the current revision in a second tab.",
          "Compare the version before saving.",
        ],
        verification: "A save creates version 8 without a conflict.",
        fallback: "Keep version 7 and copy the draft text to an approved note.",
        needsAdminInput: "none",
        missingEvidence: [],
      }),
    ).toEqual({
      immediateSafeAction: "Keep the draft open.",
      likelyCause: {
        certainty: "suspected",
        summary: "A stale revision from [redacted email].",
      },
      recommendedResolution: [
        "Open the current revision in a second tab.",
        "Compare the version before saving.",
      ],
      verification: "A save creates version 8 without a conflict.",
      fallback: "Keep version 7 and copy the draft text to an approved note.",
      needsAdminInput: "none",
      missingEvidence: [],
    });
  });

  it("requires an exact next step and missing evidence for an unknown cause", () => {
    expect(() =>
      normalizeActionableResolution({
        immediateSafeAction: "Keep the draft open.",
        likelyCause: { certainty: "unknown", summary: "The cause is unknown." },
        recommendedResolution: ["Review it."],
        verification: "Unknown.",
        fallback: "Keep the draft.",
        needsAdminInput: "none",
        missingEvidence: [],
      }),
    ).toThrow(/missing evidence/i);
  });

  it("allows only the reviewed state transitions and idempotent repeats", () => {
    expect(canTransitionBugReportStatus("open", "acknowledged")).toBe(true);
    expect(canTransitionBugReportStatus("open", "in_progress")).toBe(true);
    expect(canTransitionBugReportStatus("blocked", "in_progress")).toBe(true);
    expect(canTransitionBugReportStatus("resolved", "in_progress")).toBe(true);
    expect(canTransitionBugReportStatus("open", "open")).toBe(true);
    expect(canTransitionBugReportStatus("resolved", "acknowledged")).toBe(false);
    expect(canTransitionBugReportStatus("dismissed", "resolved")).toBe(false);
    expect(canTransitionBugReportStatus("unknown", "open")).toBe(false);
  });
});

describe("reporter and administrator projections", () => {
  it("keeps delivery identifiers and internal triage out of the reporter view", () => {
    const stored = {
      ...composeBugReport(submission(), trustedContext()),
      ownerUid: "admin-1",
      deliveryStatus: "delivered",
      delivery: {
        telegramChatId: "123456",
        telegramMessageId: "789",
        attemptCount: 1,
        lastAttemptAt: NOW,
        lastError: null,
      },
      internalDecision: "Link to a private security issue.",
      nudgeHistory: [{ id: "PRIVATE-NUDGE-ID", requestedAt: NOW, deliveredAt: NOW, delivery: "delivered", decision: "ignored", decidedAt: NOW, decidedBy: "PRIVATE-ADMIN-UID" }],
    };
    const reporter = reportForReporter(stored, "editor-1");

    expect(Object.keys(reporter)).toEqual([
      "category",
      "apiVersion",
      "id",
      "severity",
      "area",
      "tryingToDo",
      "happened",
      "expected",
      "steps",
      "workaround",
      "consoleLogs",
      "route",
      "affectedRecord",
      "evidence",
      "environment",
      "correlationIds",
      "status",
      "actionableResolution",
      "acknowledgedAt",
      "assignedAt",
      "resolvedAt",
      "dismissedAt",
      "version",
      "createdAt",
      "updatedAt",
      "reporter",
      "progress",
      "nudge",
    ]);
    expect(Object.keys(reporter.nudge).sort()).toEqual(["eligible", "eligibleAt", "history", "historyTruncated", "progressAt", "requestedAt", "version"]);
    expect(Object.keys(reporter.nudge.history[0]).sort()).toEqual(["decidedAt", "decision", "deliveredAt", "delivery", "requestedAt"]);
    expect(JSON.stringify(reporter.nudge)).not.toContain("PRIVATE-");
    expect(reporter).not.toHaveProperty("delivery");
    expect(reporter).not.toHaveProperty("deliveryStatus");
    expect(reporter).not.toHaveProperty("links");
    expect(reporter).not.toHaveProperty("ownerUid");
    expect(reporter).not.toHaveProperty("acknowledgedBy");
    expect(reporter).not.toHaveProperty("resolvedBy");
    expect(reporter).not.toHaveProperty("dismissedBy");
    expect(reporter).not.toHaveProperty("internalDecision");
    expect(reporter.reporter).toEqual({ uid: "editor-1", role: "editor" });
    expect(() => reportForReporter(stored, "other-user")).toThrow(/not available/i);
  });

  it("returns a defensive copy of the complete sanitized admin record", () => {
    const stored = {
      ...composeBugReport(submission(), trustedContext()),
      providerResponse: { accessToken: "must-not-leave-the-server" },
    };
    const admin = reportForAdmin(stored);
    expect(Object.keys(admin)).toEqual([
      "category",
      "apiVersion",
      "id",
      "severity",
      "area",
      "tryingToDo",
      "happened",
      "expected",
      "steps",
      "workaround",
      "consoleLogs",
      "route",
      "affectedRecord",
      "reporter",
      "evidence",
      "environment",
      "correlationIds",
      "status",
      "ownerUid",
      "deliveryStatus",
      "delivery",
      "githubDelivery",
      "links",
      "actionableResolution",
      "acknowledgedAt",
      "acknowledgedBy",
      "assignedAt",
      "resolvedAt",
      "resolvedBy",
      "dismissedAt",
      "dismissedBy",
      "version",
      "createdAt",
      "updatedAt",
      "progress",
    ]);
    expect(admin).not.toHaveProperty("providerResponse");
    admin.links.relatedReportIds.push(`br_${"c".repeat(32)}`);
    expect(stored.links.relatedReportIds).toEqual([]);
  });
});


describe("staff report details", () => {
  const diagnostics = {
    userAgent: "Chrome test", language: "en-US",
    screen: { width: 1920, height: 1080, colorDepth: 24, pixelRatio: 2 },
    sessionAgeMs: 25_000, visibilityState: "visible", reducedMotion: false,
    hardwareConcurrency: 8, deviceMemoryGB: 8,
    navigation: { type: "navigate", ttfbMs: 100, domContentLoadedMs: 300, loadMs: 500 },
    memory: { usedJSHeapSize: 1_000, totalJSHeapSize: 2_000, jsHeapSizeLimit: 8_000 },
    recentRequests: [{ path: "/api/cmsSaveContent?token=private#part", status: 409, durationMs: 100, initiatorType: "fetch" }],
  };
  it("accepts a public-style description without requiring extra staff fields", () => {
    const report = composeBugReport(submission({ category: "suggestion", tryingToDo: "", expected: "" }), trustedContext());
    expect(report.category).toBe("suggestion");
    expect(report.tryingToDo).toBe("");
    const longReport = composeBugReport(submission({ category: "bug", tryingToDo: "", expected: "", happened: "Detailed description ".repeat(80) }), trustedContext());
    expect(longReport.tryingToDo).toBe("");
    expect(longReport.happened.length).toBeGreaterThan(1_000);
    expect(report.expected).toBe("");
    expect(reportForReporter(report, "editor-1").category).toBe("suggestion");
    expect(() => composeBugReport(submission({ category: "unknown" }), trustedContext())).toThrow(/category/i);
  });
  it("keeps bounded diagnostics and 100 redacted debug messages in the private report", () => {
    const report = composeBugReport(submission({
      clientContext: { ...submission().clientContext, diagnostics },
      consoleLogs: Array.from({ length: 100 }, () => ({ level: "debug", message: "token=private", timestamp: NOW })),
    }), trustedContext());
    expect(report.consoleLogs).toHaveLength(100);
    expect(report.consoleLogs[0].message).not.toContain("private");
    expect(report.environment.diagnostics).toEqual({ ...diagnostics,
      recentRequests: [{ ...diagnostics.recentRequests[0], path: "/api/cmsSaveContent" }],
    });
    expect(reportForReporter(report, "editor-1").environment.diagnostics).toEqual(report.environment.diagnostics);
    expect(() => reportForReporter(report, "another-staffer")).toThrow(/available/i);
  });
  it("keeps network failures and rejects invalid HTTP status values", () => {
    const input = submission({ clientContext: { ...submission().clientContext, diagnostics: { ...diagnostics, recentRequests: [{ ...diagnostics.recentRequests[0], status: 0 }] } } });
    expect(composeBugReport(input, trustedContext()).environment.diagnostics.recentRequests[0].status).toBe(0);
    input.clientContext.diagnostics.recentRequests[0].status = 99;
    expect(() => composeBugReport(input, trustedContext())).toThrow(/status/i);
  });
  it("refuses arbitrary diagnostic fields, invalid numbers, and unbounded request lists", () => {
    for (const invalid of [
      { ...diagnostics, cookies: "private" },
      { ...diagnostics, sessionAgeMs: Infinity },
      { ...diagnostics, memory: { ...diagnostics.memory, extra: "private" } },
      { ...diagnostics, recentRequests: Array(21).fill(diagnostics.recentRequests[0]) },
      { ...diagnostics, recentRequests: [{ ...diagnostics.recentRequests[0], headers: {} }] },
    ]) {
      expect(() => composeBugReport(submission({
        clientContext: { ...submission().clientContext, diagnostics: invalid },
      }), trustedContext())).toThrow(BugReportContractError);
    }
  });
});
