import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import adminPkg from "../helpers/firebase-admin.js";
import triage from "../../functions/bug-report-triage.js";
import contract from "../../functions/lib/bug-report-contract.js";

const admin = adminPkg;
const PROJECT = process.env.GCLOUD_PROJECT || "demo-njpbs";
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
const NOW = "2026-08-28T22:30:00.000Z";
const REQUEST_ID = "22222222-2222-4222-8222-222222222222";
const MUTATION_ID = "33333333-3333-4333-8333-333333333333";
let db;

function report(index, uid = "editor-1", overrides = {}) {
  const id = contract.mintBugReportId(index.toString(16).padStart(32, "0"));
  return {
    ...contract.composeBugReport({
      severity: index === 2 ? "blocker" : "work_impaired",
      area: "content_editing",
      tryingToDo: `Edit report ${index}`,
      happened: "The save stopped.",
      expected: "The save should finish.",
      route: `/content/posts/post-${index}/edit?secret=value`,
      affectedRecord: { kind: "post", id: `post-${index}`, version: index },
      clientContext: {
        browser: "Chrome 140",
        operatingSystem: "Windows 11",
        viewport: { width: 1280, height: 720 },
        online: true,
        timeZone: "America/New_York",
      },
      correlationIds: [],
    }, {
      reportId: id,
      nowIso: new Date(Date.parse(NOW) + index * 1_000).toISOString(),
      reporter: { uid, email: `${uid}@example.org`, role: "editor" },
      buildRevision: "b".repeat(40),
      deploymentEnvironment: "production",
      requestId: REQUEST_ID,
    }),
    ...overrides,
  };
}

function principal(uid = "editor-1", role = "editor") {
  return {
    uid,
    email: `${uid}@example.org`,
    emailVerified: true,
    principal: { id: uid, grants: [{ role }] },
  };
}

function req(body = {}) {
  return {
    method: "POST",
    body,
    headers: { "x-njpbs-request-id": REQUEST_ID },
    ip: "203.0.113.20",
  };
}

function res() {
  const result = { statusCode: null, body: null, headers: {} };
  result.status = (status) => { result.statusCode = status; return result; };
  result.json = (body) => { result.body = body; return result; };
  result.set = (name, value) => { result.headers[name.toLowerCase()] = value; return result; };
  return result;
}

async function seed(...records) {
  const batch = db.batch();
  for (const record of records) batch.set(db.collection("bug_reports").doc(record.id), record);
  await batch.commit();
}

async function rows(collection) {
  return (await db.collection(collection).get()).docs.map((snapshot) => snapshot.data());
}

beforeAll(() => {
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  db = isolatedFirestore("bug-report-triage.test.js");
});

beforeEach(async () => {
  await clearEmulatorFirestore(`http://${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" }, db);
});

afterAll(async () => {
  await Promise.all(admin.apps.map((app) => app.delete()));
});

describe("bug report read projections", () => {
  it("opens only staff-safe progress for other reports after the approved ladder gate", async () => {
    const other = report(3, "other-staff", { tryingToDo: "PRIVATE-CANARY", happened: "PRIVATE-CANARY" });
    await seed(report(1), other);
    const deps = { firestore: db, requirePrincipalFn: async () => principal(), isAdminFn: async () => false };
    const list = triage.createCmsListBugReportsHandler(deps);
    const refused = res();
    await list(req({ view: "all" }), refused);
    expect(refused.statusCode).toBe(403);
    await db.doc("system/staffAccessActivation").set({ schema: 1, state: "active", cleanScan: true });
    const response = res();
    await list(req({ view: "all" }), response);
    expect(response.statusCode).toBe(200);
    expect(response.body.sharedReportsActive).toBe(true);
    expect(response.body.reports.find((row) => row.id === other.id)).toMatchObject({ shared: true, tryingToDo: "Content editing report" });
    expect(JSON.stringify(response.body)).not.toContain("PRIVATE-CANARY");
    expect(response.body).not.toHaveProperty("repository");
    const detail = res();
    await triage.createCmsGetBugReportHandler(deps)(req({ reportId: other.id }), detail);
    expect(detail.body.report.shared).toBe(true);
    expect(detail.body.audit).toEqual([]);
    expect(detail.body.canAdminister).toBe(false);
    for (const field of ["reporter", "environment", "evidence", "route", "links", "actionableResolution", "consoleLogs"]) expect(detail.body.report).not.toHaveProperty(field);
    const evidence = res();
    await triage.createCmsGetBugReportEvidenceHandler(deps)(req({ reportId: other.id }), evidence);
    expect(evidence.statusCode).toBe(404);
  });
  it("refuses raw Firebase authentication before any report read", async () => {
    const handler = triage.createCmsListBugReportsHandler({
      firestore: db,
      requirePrincipalFn: async () => ({
        uid: "raw-user",
        emailVerified: true,
        principal: { id: "raw-user", grants: [] },
      }),
      isAdminFn: async () => false,
      log: { error: vi.fn() },
    });
    const response = res();

    await handler(req({ view: "mine" }), response);

    expect(response.statusCode).toBe(403);
    expect(response.body.error).toMatch(/approved, active/i);
  });

  it("returns only the caller's fixed projection and keeps blocker reports first", async () => {
    await seed(report(1), report(2), report(3, "editor-2"));
    const handler = triage.createCmsListBugReportsHandler({
      firestore: db,
      requirePrincipalFn: async () => principal(),
      isAdminFn: async () => false,
    });
    const response = res();

    await handler(req({ view: "mine", limit: 10 }), response);

    expect(response.statusCode).toBe(200);
    expect(response.body.reports.map((entry) => entry.id)).toEqual([
      report(2).id,
      report(1).id,
    ]);
    expect(response.body.reports[0]).not.toHaveProperty("reporter");
    expect(response.body.reports[0]).not.toHaveProperty("consoleLogs");
    expect(response.body.reports[0]).not.toHaveProperty("environment");
    expect(response.body.reports[0].tryingToDo.length).toBeLessThanOrEqual(160);
    expect(response.body.reports[0]).not.toHaveProperty("ownerUid");
    expect(response.body.reports[0]).not.toHaveProperty("delivery");
  });

  it("returns the newest bounded report window and says when older reports are omitted", async () => {
    await seed(...Array.from({ length: 101 }, (_, index) => report(index + 10)));
    const handler = triage.createCmsListBugReportsHandler({
      firestore: db,
      requirePrincipalFn: async () => principal(),
    });
    const response = res();

    await handler(req({ view: "mine", limit: 100 }), response);

    expect(response.statusCode).toBe(200);
    expect(response.body.truncated).toBe(true);
    expect(response.body.reports).toHaveLength(100);
    expect(response.body.reports[0].id).toBe(report(110).id);
    expect(response.body.reports.at(-1).id).toBe(report(11).id);
    expect(response.body.reports.map((entry) => entry.id)).not.toContain(report(10).id);
  });

  it("does not claim the 100-report cap was reached just because a smaller limit was requested", async () => {
    await seed(report(1), report(2));
    const handler = triage.createCmsListBugReportsHandler({ firestore: db, requirePrincipalFn: async () => principal() });
    const response = res();
    await handler(req({ view: "mine", limit: 1 }), response);
    expect(response.statusCode).toBe(200);
    expect(response.body.reports).toHaveLength(1);
    expect(response.body.truncated).toBe(false);
  });

  it("keeps an older unresolved blocker ahead of newer terminal reports", async () => {
    const blocker = report(1, "editor-1", { severity: "blocker" });
    const resolved = Array.from({ length: 3 }, (_, index) => report(index + 10, "editor-1", {
      status: "resolved",
    }));
    await seed(blocker, ...resolved);
    const handler = triage.createCmsListBugReportsHandler({
      firestore: db,
      requirePrincipalFn: async () => principal(),
    });
    const response = res();

    await handler(req({ view: "mine", limit: 100 }), response);

    expect(response.statusCode).toBe(200);
    expect(response.body.reports[0].id).toBe(blocker.id);
  });

  it("does not list a Firestore administrator queue", async () => {
    const handler = triage.createCmsListBugReportsHandler({
      firestore: db,
      requirePrincipalFn: async () => principal("admin-1", "admin"),
    });
    const response = res();
    await handler(req({ view: "queue" }), response);
    expect(response.statusCode).toBe(400);
    expect(response.body.error).toMatch(/view is invalid/i);
  });

  it("does not disclose another reporter's detail or private evidence", async () => {
    const stored = report(1, "editor-2", {
      evidence: { screenshot: { id: report(1).id, mimeType: "image/webp" } },
    });
    await seed(stored);
    await db.collection("bugReportEvidence").doc(stored.id).set({
      reportId: stored.id,
      mimeType: "image/webp",
      bytes: Buffer.from("private"),
      width: 1,
      height: 1,
    });
    const detail = triage.createCmsGetBugReportHandler({
      firestore: db,
      requirePrincipalFn: async () => principal(),
      isAdminFn: async () => false,
    });
    const evidence = triage.createCmsGetBugReportEvidenceHandler({
      firestore: db,
      requirePrincipalFn: async () => principal(),
      isAdminFn: async () => false,
    });
    const detailResponse = res();
    const evidenceResponse = res();

    await detail(req({ reportId: stored.id }), detailResponse);
    await evidence(req({ reportId: stored.id }), evidenceResponse);

    expect(detailResponse.statusCode).toBe(404);
    expect(evidenceResponse.statusCode).toBe(404);
  });

  it("returns private evidence to its reporter with a no-store receipt", async () => {
    const stored = report(1);
    await seed(stored);
    await db.collection("bugReportEvidence").doc(stored.id).set({
      reportId: stored.id,
      mimeType: "image/webp",
      bytes: Buffer.from("private"),
      width: 10,
      height: 20,
    });
    const handler = triage.createCmsGetBugReportEvidenceHandler({
      firestore: db,
      requirePrincipalFn: async () => principal(),
      isAdminFn: async () => false,
    });
    const response = res();

    await handler(req({ reportId: stored.id }), response);

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(Buffer.from(response.body.base64, "base64").toString()).toBe("private");
  });

  it("returns the newest bounded audit window and says when older entries are omitted", async () => {
    const stored = report(1);
    await seed(stored);
    const batch = db.batch();
    for (let index = 0; index < 101; index += 1) {
      batch.set(db.collection("admin_logs").doc(`log-${index.toString().padStart(3, "0")}`), {
        action: "bug_report.status",
        actorUid: "admin-1",
        actorEmail: "admin-1@example.org",
        at: new Date(Date.parse(NOW) + index * 1_000).toISOString(),
        target: `bug_reports/${stored.id}`,
      });
    }
    await batch.commit();
    const handler = triage.createCmsGetBugReportHandler({
      firestore: db,
      requirePrincipalFn: async () => principal("admin-1", "admin"),
      isAdminFn: async () => true,
    });
    const response = res();

    await handler(req({ reportId: stored.id }), response);

    expect(response.statusCode).toBe(200);
    expect(response.body.auditTruncated).toBe(true);
    expect(response.body.audit).toHaveLength(100);
    expect(response.body.audit[0].id).toBe("log-100");
    expect(response.body.audit.at(-1).id).toBe("log-001");
  });
});

describe("atomic administrator triage", () => {
  beforeEach(async () => {
    await db.collection("users").doc("admin-1").set({ role: "admin", active: true });
  });

  function handler(user = principal("admin-1", "admin")) {
    return triage.createCmsUpdateBugReportHandler({
      firestore: db,
      requirePrincipalFn: async () => user,
      isAdminFn: async (uid) => uid === "admin-1",
      now: () => NOW,
    });
  }

  it("commits acknowledgement, audit, mutation receipt, and delivery work together", async () => {
    const stored = report(1);
    await seed(stored);
    const response = res();
    const body = {
      reportId: stored.id,
      baseVersion: 1,
      mutationId: MUTATION_ID,
      action: "acknowledge",
    };

    await handler()(req(body), response);

    expect(response.statusCode).toBe(200);
    expect(response.body.report).toMatchObject({
      status: "acknowledged",
      acknowledgedBy: "admin-1",
      acknowledgedAt: NOW,
      version: 2,
    });
    expect(await rows("admin_logs")).toEqual([
      expect.objectContaining({ action: "bug_report.acknowledge", target: `bug_reports/${stored.id}` }),
    ]);
    expect(await rows("bugReportMutationReceipts")).toEqual([
      expect.objectContaining({ mutationId: MUTATION_ID, resultVersion: 2 }),
    ]);
    const deliveries = await rows("bugReportDeliveryOutbox");
    expect(deliveries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        channel: "telegram",
        eventType: "report_updated",
        reportVersion: 2,
        state: "pending",
      }),
      expect.objectContaining({
        channel: "email",
        eventType: "report_acknowledged",
        eventStatus: "acknowledged",
        eventResolution: stored.actionableResolution,
        reportVersion: 2,
        state: "pending",
      }),
    ]));
    for (const delivery of deliveries) {
      expect(delivery.nextAttemptAt.toDate().toISOString()).toBe(NOW);
      expect(delivery.createdAt.toDate().toISOString()).toBe(NOW);
      expect(delivery.updatedAt.toDate().toISOString()).toBe(NOW);
    }

    const replay = res();
    await handler()(req(body), replay);
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toMatchObject({ changed: false, replayed: true, report: { version: 2 } });
    expect(await rows("admin_logs")).toHaveLength(1);
    expect(await rows("bugReportDeliveryOutbox")).toHaveLength(2);
  });

  it.each(["resolved", "dismissed"])(
    "snapshots the %s status and resolution for its email",
    async (status) => {
      const stored = report(1, "editor-1", {
        actionableResolution: {
          ...contract.defaultActionableResolution(),
          recommendedResolution: ["Use the reviewed recovery steps."],
        },
      });
      await seed(stored);
      const response = res();

      await handler()(req({
        reportId: stored.id,
        baseVersion: 1,
        mutationId: MUTATION_ID,
        action: "set_status",
        status,
      }), response);

      expect(response.statusCode).toBe(200);
      expect(await rows("bugReportDeliveryOutbox")).toEqual(expect.arrayContaining([
        expect.objectContaining({
          channel: "email",
          eventType: "report_status_changed",
          eventStatus: status,
          eventResolution: stored.actionableResolution,
          reportVersion: 2,
          state: "pending",
        }),
      ]));
    },
  );

  it("queues an explicit file-and-fix handoff without calling GitHub in the request", async () => {
    const stored = report(1);
    await seed(stored);
    const response = res();

    await handler()(req({
      reportId: stored.id,
      baseVersion: 1,
      mutationId: MUTATION_ID,
      action: "create_github_issue_and_fix",
    }), response);

    expect(response.statusCode).toBe(200);
    expect(response.body.report.githubDelivery).toMatchObject({
      state: "pending",
      lastOperation: "create_issue_and_fix",
      fixStatus: "pending",
    });
    expect(await rows("bugReportGithubOutbox")).toEqual([
      expect.objectContaining({
        operation: "create_issue_and_fix",
        state: "pending",
        requestedBy: "admin-1",
      }),
    ]);
  });

  it("refuses a second issue creation while the first handoff is pending", async () => {
    const stored = report(1);
    stored.githubDelivery = {
      ...stored.githubDelivery,
      state: "pending",
      lastOperation: "create_issue",
    };
    await seed(stored);
    const response = res();

    await handler()(req({
      reportId: stored.id,
      baseVersion: 1,
      mutationId: MUTATION_ID,
      action: "create_github_issue_and_fix",
    }), response);

    expect(response.statusCode).toBe(409);
    expect(await rows("bugReportGithubOutbox")).toEqual([]);
  });

  it("keeps a pinned duplicate issue on an explicit GitHub retry", async () => {
    const stored = report(1);
    stored.githubDelivery = {
      ...stored.githubDelivery,
      state: "unknown",
      lastOperation: "create_issue_and_fix",
      lastTargetNumber: 706,
      fixStatus: "failed",
    };
    await seed(stored);
    const response = res();

    await handler()(req({
      reportId: stored.id,
      baseVersion: 1,
      mutationId: MUTATION_ID,
      action: "retry_github",
    }), response);

    expect(response.statusCode).toBe(200);
    expect(await rows("bugReportGithubOutbox")).toEqual([
      expect.objectContaining({
        operation: "create_issue_and_fix",
        targetNumber: 706,
        state: "pending",
      }),
    ]);
  });

  it("refuses a reused mutation ID when the request is different", async () => {
    const stored = report(1);
    await seed(stored);
    await handler()(req({
      reportId: stored.id,
      baseVersion: 1,
      mutationId: MUTATION_ID,
      action: "acknowledge",
    }), res());
    const collision = res();

    await handler()(req({
      reportId: stored.id,
      baseVersion: 1,
      mutationId: MUTATION_ID,
      action: "take_over",
    }), collision);

    expect(collision.statusCode).toBe(409);
    expect(collision.body.error).toMatch(/already in use/i);
    expect(await rows("admin_logs")).toHaveLength(1);
    expect(await rows("bugReportDeliveryOutbox")).toHaveLength(2);
  });

  it("refuses a stale version without writing partial work", async () => {
    const stored = report(1, "editor-1", { version: 4 });
    await seed(stored);
    const response = res();

    await handler()(req({
      reportId: stored.id,
      baseVersion: 3,
      mutationId: MUTATION_ID,
      action: "take_over",
    }), response);

    expect(response.statusCode).toBe(409);
    expect(response.body.currentVersion).toBe(4);
    expect(await rows("admin_logs")).toEqual([]);
    expect(await rows("bugReportMutationReceipts")).toEqual([]);
  });

  it("validates assignment and related reports inside the transaction", async () => {
    const stored = report(1);
    await seed(stored);
    const assignment = res();
    await handler()(req({
      reportId: stored.id,
      baseVersion: 1,
      mutationId: MUTATION_ID,
      action: "assign",
      ownerUid: "missing-user",
    }), assignment);
    expect(assignment.statusCode).toBe(400);

    const related = res();
    await handler()(req({
      reportId: stored.id,
      baseVersion: 1,
      mutationId: "44444444-4444-4444-8444-444444444444",
      action: "set_related_reports",
      relatedReportIds: [contract.mintBugReportId("f".repeat(32))],
    }), related);
    expect(related.statusCode).toBe(400);
    expect((await db.collection("bug_reports").doc(stored.id).get()).data().version).toBe(1);
  });

  it.each([
    ["legacy staff", { active: true, grants: [{ role: "staff" }] }, 400],
    ["legacy Contributor with empty scope", { active: true, grants: [{ role: "contributor", sections: [] }] }, 200],
    ["legacy Editor with malformed scope", { active: true, grants: [{ role: "editor", sections: null }] }, 200],
    ["tier Viewer", { active: true, accessTier: "viewer", role: "super_admin" }, 200],
    ["invalid tier with stale Owner", { active: true, accessTier: "invalid", role: "super_admin" }, 400],
    ["inactive legacy Contributor", { active: false, grants: [{ role: "contributor" }] }, 400],
  ])("preserves report assignment admission for %s", async (_label, profile, status) => {
    await db.doc("system/staffAccessActivation").set({ schema: 1, state: "active", cleanScan: true });
    const stored = report(1);
    await seed(stored);
    await db.collection("users").doc("candidate").set(profile);
    const response = res();
    await handler()(req({
      reportId: stored.id, baseVersion: 1, mutationId: MUTATION_ID,
      action: "assign", ownerUid: "candidate",
    }), response);
    expect(response.statusCode).toBe(status);
    const persisted = (await db.collection("bug_reports").doc(stored.id).get()).data();
    expect(persisted.version).toBe(status === 200 ? 2 : 1);
    expect(persisted.ownerUid).toBe(status === 200 ? "candidate" : null);
    if (status === 400) {
      expect(await rows("admin_logs")).toEqual([]);
      expect(await rows("bugReportMutationReceipts")).toEqual([]);
    }
  });

  it("enforces the status transition contract and stores a bounded resolution", async () => {
    const stored = report(1, "editor-1", { status: "resolved" });
    await seed(stored);
    const invalid = res();
    await handler()(req({
      reportId: stored.id,
      baseVersion: 1,
      mutationId: MUTATION_ID,
      action: "set_status",
      status: "blocked",
    }), invalid);
    expect(invalid.statusCode).toBe(409);

    const update = res();
    const updateBody = {
      reportId: stored.id,
      baseVersion: 1,
      mutationId: "55555555-5555-4555-8555-555555555555",
      action: "update_resolution",
      actionableResolution: {
        immediateSafeAction: "Keep the current editor open.",
        likelyCause: { certainty: "suspected", summary: "The saved version changed." },
        recommendedResolution: ["Reload after copying the draft.", "Apply the change again."],
        verification: "The next save creates version 8.",
        fallback: "Restore version 7.",
        needsAdminInput: "none",
        missingEvidence: [],
      },
    };
    await handler()(req(updateBody), update);
    expect(update.statusCode).toBe(200);
    expect(update.body.report.actionableResolution).toMatchObject({
      likelyCause: { certainty: "suspected" },
      needsAdminInput: "none",
    });
    expect((await rows("admin_logs"))[0].after.actionableResolution).toMatchObject({
      likelyCause: { certainty: "suspected" },
      needsAdminInput: "none",
    });
    expect(await rows("bugReportDeliveryOutbox")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        channel: "email",
        eventType: "report_resolution_updated",
        eventStatus: "resolved",
        eventResolution: update.body.report.actionableResolution,
        reportVersion: 2,
      }),
    ]));

    const replay = res();
    await handler()(req(updateBody), replay);
    expect(replay.body).toMatchObject({ changed: false, replayed: true });
    expect(await rows("bugReportDeliveryOutbox")).toHaveLength(2);
  });

  it("does not queue an email when resolution input normalizes to the stored value", async () => {
    const stored = report(1);
    await seed(stored);
    const normalizedCopy = structuredClone(stored.actionableResolution);
    for (const field of ["immediateSafeAction", "verification", "fallback", "needsAdminInput"]) {
      normalizedCopy[field] = `  ${normalizedCopy[field]}  `;
    }
    normalizedCopy.likelyCause.summary = `  ${normalizedCopy.likelyCause.summary}  `;
    normalizedCopy.recommendedResolution = normalizedCopy.recommendedResolution
      .map((item) => `  ${item}  `);
    normalizedCopy.missingEvidence = normalizedCopy.missingEvidence
      .map((item) => `  ${item}  `);
    const body = {
      reportId: stored.id,
      baseVersion: 1,
      mutationId: MUTATION_ID,
      action: "update_resolution",
      actionableResolution: normalizedCopy,
    };
    const response = res();

    await handler()(req(body), response);

    expect(response.statusCode).toBe(200);
    expect(await rows("bugReportDeliveryOutbox")).toEqual([
      expect.objectContaining({ channel: "telegram", eventType: "report_updated" }),
    ]);

    const replay = res();
    await handler()(req(body), replay);
    expect(replay.body).toMatchObject({ changed: false, replayed: true });
    expect(await rows("bugReportDeliveryOutbox")).toHaveLength(1);
  });

  it.each([
    ["internal-only fields", (resolution) => ({
      ...resolution,
      needsAdminInput: "Collect the request trace.",
      missingEvidence: ["The request trace is not attached."],
    })],
    ["an unknown cause", (resolution) => ({
      ...resolution,
      likelyCause: {
        certainty: "unknown",
        summary: "The save request needs more investigation.",
      },
    })],
  ])("does not queue an email for an edit to %s", async (_label, editResolution) => {
    const stored = report(1);
    await seed(stored);
    const response = res();

    await handler()(req({
      reportId: stored.id,
      baseVersion: 1,
      mutationId: MUTATION_ID,
      action: "update_resolution",
      actionableResolution: editResolution(stored.actionableResolution),
    }), response);

    expect(response.statusCode).toBe(200);
    expect(response.body.report.version).toBe(2);
    expect(await rows("bugReportDeliveryOutbox")).toEqual([
      expect.objectContaining({ channel: "telegram", eventType: "report_updated" }),
    ]);
  });

  it("refuses triage actions from non-administrators", async () => {
    const stored = report(1);
    await seed(stored);
    const response = res();
    await handler(principal())(req({
      reportId: stored.id,
      baseVersion: 1,
      mutationId: MUTATION_ID,
      action: "take_over",
    }), response);
    expect(response.statusCode).toBe(403);
    expect((await db.collection("bug_reports").doc(stored.id).get()).data().ownerUid).toBeNull();
  });

  it("refuses a second acknowledgement without version or delivery churn", async () => {
    const stored = report(1, "editor-1", {
      status: "acknowledged",
      acknowledgedAt: NOW,
      acknowledgedBy: "admin-1",
      ownerUid: "admin-1",
      assignedAt: NOW,
    });
    await seed(stored);
    const response = res();

    await handler()(req({
      reportId: stored.id,
      baseVersion: 1,
      mutationId: MUTATION_ID,
      action: "acknowledge",
    }), response);

    expect(response.statusCode).toBe(409);
    const takeOverResponse = res();
    await handler()(req({
      reportId: stored.id,
      baseVersion: 1,
      mutationId: "44444444-4444-4444-8444-444444444444",
      action: "take_over",
    }), takeOverResponse);
    expect(takeOverResponse.statusCode).toBe(409);

    const statusResponse = res();
    await handler()(req({
      reportId: stored.id,
      baseVersion: 1,
      mutationId: "55555555-5555-4555-8555-555555555555",
      action: "set_status",
      status: "acknowledged",
    }), statusResponse);
    expect(statusResponse.statusCode).toBe(409);

    expect((await db.collection("bug_reports").doc(stored.id).get()).data().version).toBe(1);
    expect(await rows("admin_logs")).toHaveLength(0);
    expect(await rows("bugReportMutationReceipts")).toHaveLength(0);
    expect(await rows("bugReportDeliveryOutbox")).toHaveLength(0);
  });

  it("queues an explicit retry only for a failed notification", async () => {
    const stored = report(1, "editor-1", {
      deliveryStatus: "unknown",
      delivery: {
        telegramChatId: null,
        telegramMessageId: null,
        attemptCount: 1,
        lastAttemptAt: NOW,
        lastError: "ambiguous",
      },
    });
    await seed(stored);
    const response = res();

    await handler()(req({
      reportId: stored.id,
      baseVersion: 1,
      mutationId: MUTATION_ID,
      action: "retry_notification",
    }), response);

    expect(response.statusCode).toBe(200);
    expect(response.body.report).toMatchObject({
      deliveryStatus: "pending",
      delivery: { lastError: null },
      version: 2,
    });
    expect(await rows("admin_logs")).toEqual([
      expect.objectContaining({ action: "bug_report.notification_retry" }),
    ]);
    expect(await rows("bugReportDeliveryOutbox")).toEqual([
      expect.objectContaining({ channel: "telegram", state: "pending" }),
    ]);

    const notFailed = res();
    await handler()(req({
      reportId: stored.id,
      baseVersion: 2,
      mutationId: "77777777-7777-4777-8777-777777777777",
      action: "retry_notification",
    }), notFailed);
    expect(notFailed.statusCode).toBe(409);
  });
});
