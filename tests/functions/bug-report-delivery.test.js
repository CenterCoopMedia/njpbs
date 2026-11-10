import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import adminPkg from "../helpers/firebase-admin.js";
import delivery from "../../functions/bug-report-delivery.js";
import contract from "../../functions/lib/bug-report-contract.js";

const admin = adminPkg;
const PROJECT = process.env.GCLOUD_PROJECT || "demo-njpbs";
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
const NOW = new Date("2026-08-28T23:30:00.000Z");
const REPORT_ID = contract.mintBugReportId("a".repeat(32));
const REPORT_EMAIL_BCC = ["fixture-08a6ef6987@example.org"];
const OFFICIAL_EMAIL_LOGO_SHA256 =
  "8437db4b4e6c9a7302aa5e739650f744e2afd50bb978952014f6e3ec356abf03";
let db;

function report(overrides = {}) {
  return {
    ...contract.composeBugReport({
      severity: "blocker",
      area: "content_editing",
      tryingToDo: "Publish the evening story",
      happened: "The save stopped and the editor could not continue.",
      expected: "The save should finish.",
      steps: "Open the story and select Save.",
      workaround: "Keep the current tab open.",
      consoleLogs: [{
        level: "error",
        message: "Save request failed with status 409",
        timestamp: "2026-08-28T23:29:58.000Z",
      }],
      route: "/content/post/story-1?token=secret",
      affectedRecord: { kind: "post", id: "story-1", version: 7 },
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
    deliveryStatus: "pending",
    ...overrides,
  };
}

function response() {
  const result = { statusCode: null, body: null, headers: {} };
  result.status = (value) => { result.statusCode = value; return result; };
  result.send = (value) => { result.body = value; return result; };
  result.set = (name, value) => { result.headers[name.toLowerCase()] = value; return result; };
  return result;
}

async function rows(collection) {
  return (await db.collection(collection).get()).docs.map((snapshot) => snapshot.data());
}

beforeAll(() => {
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  db = isolatedFirestore("bug-report-delivery.test.js");
});

beforeEach(async () => {
  vi.stubEnv("CMS_BUG_REPORT_EMAIL_BCC", JSON.stringify(REPORT_EMAIL_BCC));
  await clearEmulatorFirestore(
    `http://${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: "DELETE" }, db,
  );
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await Promise.all(admin.apps.map((app) => app.delete()));
});

describe("bug report delivery presentation", () => {
  it("uses staged Telegram menus with bounded callback data", () => {
    const record = report({ deliveryStatus: "unknown" });
    const primary = delivery.telegramKeyboard(record, "primary");
    const more = delivery.telegramKeyboard(record, "more");
    const status = delivery.telegramKeyboard(record, "status");
    const dismissedStatus = delivery.telegramKeyboard(
      report({ status: "dismissed" }),
      "status",
    );

    expect(primary.inline_keyboard.flat().map((button) => button.text)).toEqual([
      "File issue",
      "File + fix",
      "Open CMS report",
      "Ignore",
    ]);
    expect(more.inline_keyboard.flat().map((button) => button.text)).toEqual([
      "Change status",
      "Resolve",
      "Dismiss",
      "Back",
    ]);
    expect(status.inline_keyboard.flat().map((button) => button.text)).toEqual([
      "Start work",
      "Back",
    ]);
    expect(dismissedStatus.inline_keyboard.flat().map((button) => button.text)).toEqual([
      "Reopen",
      "Back",
    ]);
    expect(delivery.callbackAdminAction("o")).toEqual({
      action: "set_status",
      status: "open",
    });
    for (const button of [...primary.inline_keyboard.flat(), ...more.inline_keyboard.flat()]) {
      if (button.callback_data) expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64);
    }
  });

  it("renders submitted facts and console evidence without placeholder analysis", () => {
    const record = report();
    const card = delivery.renderTelegramCard(record);
    expect(delivery.externalReport(record)).not.toHaveProperty("category");
    expect(card.indexOf("Blocker CMS report")).toBeLessThan(card.indexOf("Problem"));
    expect(card).toContain("<b>Problem</b> Publish the evening story");
    expect(card).toContain(
      "<b>Impact</b> The save stopped and the editor could not continue.",
    );
    expect(card.indexOf("Problem")).toBeLessThan(card.indexOf("Reporter"));
    expect(card).toContain("Expected");
    expect(card).toContain("Steps");
    expect(card).toContain("Workaround");
    expect(card).toContain("Console");
    expect(card).toContain("Save request failed with status 409");
    expect(card).not.toContain("Immediate safe action");
    expect(card).not.toContain("Recommended resolution");
    expect(card).not.toContain("Admin input");
    expect(card).toContain("/content/post/story-1");
    expect(card).not.toContain("token=secret");
    expect(Buffer.byteLength(card, "utf8")).toBeLessThanOrEqual(4_096);

    const email = delivery.renderBugReportEmail(report(), "report_received");
    expect(email.subject).toContain("Publish the evening story");
    expect(email.text).toContain(`Reference: ${REPORT_ID}`);
    expect(email.text).toContain(`https://admin.njpbs.org/reports/${REPORT_ID}`);
    expect(email.html).toContain("<a href=");
  });

  it.each([
    ["report_received", report({ category: "bug" }), "We received your bug or error report"],
    [
      "report_acknowledged",
      report({ category: "bug", status: "acknowledged" }),
      "We are looking into it",
    ],
    [
      "report_status_changed",
      report({ category: "bug", status: "in_progress" }),
      "Report status updated",
    ],
    [
      "report_status_changed",
      report({ category: "bug", status: "resolved" }),
      "Report resolved",
    ],
    [
      "report_resolution_updated",
      report({ category: "bug", status: "resolved" }),
      "Resolution updated",
    ],
  ])("renders branded HTML for %s", (eventType, record, heading) => {
    const email = delivery.renderBugReportEmail(record, eventType);

    expect(email.html).toMatch(/^<!doctype html>/);
    expect(email.html).toContain('bgcolor="#0b223d"');
    expect(email.html).toContain("border-bottom:4px solid #2638c4");
    expect(email.html).not.toContain("border-top:8px solid #2638c4");
    expect(email.html).toContain('src="cid:njpbs-email-logo"');
    expect(email.html).toContain('width="228"');
    expect(email.html).toContain(">CMS reports</p>");
    expect(email.html).not.toContain("njpbs-horizontal-white-navy.png");
    expect(email.attachments).toEqual([
      expect.objectContaining({
        content_id: "njpbs-email-logo",
        disposition: "inline",
        filename: "njpbs-horizontal-white.png",
        type: "image/png",
      }),
    ]);
    expect(
      createHash("sha256")
        .update(Buffer.from(email.attachments[0].content, "base64"))
        .digest("hex"),
    ).toBe(OFFICIAL_EMAIL_LOGO_SHA256);
    expect(email.html).toContain("max-width:600px");
    expect(email.html).toContain("display:none;max-height:0");
    expect(email.html).toContain(`<h1 style="margin:0 0 18px;color:#090f2f`);
    expect(email.html).toContain(`>${heading}</h1>`);
    expect(email.html).toContain(">Reference</td>");
    expect(email.html).toContain(">Category</td>");
    expect(email.html).toContain(">Follow the report</a>");
    expect(email.html).toContain(
      `href="https://admin.njpbs.org/reports/${REPORT_ID}"`,
    );
    expect(email.html).toContain("background:#090f2f");
    expect(email.html).toContain(">NJ PBS</td>");
  });

  it("escapes dynamic values in branded HTML and keeps the report URL encoded", () => {
    const unsafeId = `${REPORT_ID}\"><script>alert-id</script>`;
    const email = delivery.renderBugReportEmail(report({
      id: unsafeId,
      status: "resolved",
      actionableResolution: {
        ...contract.defaultActionableResolution(),
        recommendedResolution: ["Reload <the editor> & save.\nDo not run <script>code</script>."],
      },
    }), "report_status_changed");

    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&lt;script&gt;alert-id&lt;/script&gt;");
    expect(email.html).toContain(
      "Reload &lt;the editor&gt; &amp; save.<br>Do not run &lt;script&gt;code&lt;/script&gt;.",
    );
    expect(email.html).toContain(
      `href="https://admin.njpbs.org/reports/${encodeURIComponent(unsafeId)}"`,
    );
  });

  it.each([
    ["bug", "Bug or error", "bug or error report"],
    ["suggestion", "Suggestion", "suggestion"],
    ["question", "Question", "question"],
  ])("delivers the %s category without a duplicate description", (category, label, name) => {
    const description = "The Save button stopped responding.";
    const record = report({ category, tryingToDo: "", happened: description });
    const external = delivery.externalReport(record);
    const card = delivery.renderTelegramCard(record);
    const email = delivery.renderBugReportEmail(record, "report_received");

    expect(external.category).toBe(category);
    expect(card).toContain(`<b>${label} CMS report · Open</b>`);
    expect(card).toContain("<b>Severity</b> Blocker");
    expect(card).toContain(`<b>Description</b> ${description}`);
    expect(card.split(description)).toHaveLength(2);
    expect(card).not.toContain("<b>Problem</b>");
    expect(card).not.toContain("<b>Impact</b>");
    expect(email.subject).toBe(`We received your ${name}: ${description}`);
    expect(email.text).toContain(`We received your ${name} in Boardwalk.`);
    expect(email.text).toContain(`Category: ${label}`);
  });

  it.each([
    ["resolved", "resolved"],
    ["dismissed", "closed"],
  ])("renders the %s final status with the saved resolution", (status, statusName) => {
    const email = delivery.renderBugReportEmail(report({
      category: "suggestion",
      status,
      actionableResolution: {
        immediateSafeAction: "Keep a copy of the draft & retry after review.",
        likelyCause: {
          certainty: "confirmed",
          summary: "The saved version was older than <version 8>.",
        },
        recommendedResolution: ["Reload <the editor>.", "Apply the saved copy."],
        verification: "Version 9 saves & publishes.",
        fallback: "Restore version 8.",
      },
    }), "report_status_changed");

    expect(email.subject).toContain(`Your suggestion is now ${statusName}: Publish the evening story`);
    expect(email.text).toContain(`is now ${statusName}.`);
    expect(email.text).toContain("\nResolution:\n");
    expect(email.html).toContain(">Resolution</h2>");
    expect(email.text).toContain("Recommended resolution:\n1. Reload <the editor>.");
    expect(email.text).toContain("Verification: Version 9 saves & publishes.");
    expect(email.text).toContain("Immediate action: Keep a copy of the draft & retry after review.");
    expect(email.text).toContain("Fallback: Restore version 8.");
    expect(email.text).toContain("Cause (confirmed): The saved version was older than <version 8>.");
    expect(email.html).toContain("Reload &lt;the editor&gt;.");
    expect(email.html).toContain("saves &amp; publishes");
    expect(email.html).not.toContain("<version 8>");
  });

  it("omits default and incomplete resolution fields", () => {
    const defaultEmail = delivery.renderBugReportEmail(
      report({ category: "bug", status: "resolved" }),
      "report_status_changed",
    );
    const incompleteEmail = delivery.renderBugReportEmail(report({
      category: "bug",
      actionableResolution: { likelyCause: { certainty: "suspected" } },
    }), "report_resolution_updated");

    for (const value of Object.values(contract.defaultActionableResolution())) {
      if (typeof value === "string") expect(defaultEmail.text).not.toContain(value);
    }
    expect(defaultEmail.text).not.toContain("Recommended resolution:");
    expect(defaultEmail.text).not.toContain("Verification:");
    expect(defaultEmail.text).not.toContain("Immediate action:");
    expect(defaultEmail.text).not.toContain("Fallback:");
    expect(defaultEmail.text).not.toContain("Cause (");
    expect(defaultEmail.subject).toContain("Your bug or error report is now resolved");
    expect(defaultEmail.text).toContain("Check the report for details.");
    expect(defaultEmail.text).not.toContain("Read the resolution below");
    expect(incompleteEmail.text).not.toContain("undefined");
  });

  describe.each([
    "report_received",
    "report_acknowledged",
    "report_status_changed",
    "report_resolution_updated",
  ])("plain-language %s email", (eventType) => {
    it("includes the submitter's words and chosen details with safe HTML", () => {
      const email = delivery.renderBugReportEmail(report({
        category: "suggestion",
        tryingToDo: '  Find <video> & "audio"\nfor today  ',
        happened: "  Show the uploader's name.\nDo not run <script>alert(1)</script>.  ",
        links: { githubIssueNumbers: [987654] },
      }), eventType);

      expect(email.subject).toContain('Find <video> & "audio" for today');
      expect(email.subject).not.toContain(REPORT_ID);
      expect(email.subject).not.toMatch(/[\r\n]/);
      expect(email.text).toContain('What you were trying to do: Find <video> & "audio"\nfor today');
      expect(email.text).toContain("What you wrote: Show the uploader's name.\nDo not run <script>alert(1)</script>.");
      expect(email.html).toContain("Find &lt;video&gt; &amp; &quot;audio&quot;<br>for today");
      expect(email.html).toContain("Show the uploader&#039;s name.<br>Do not run &lt;script&gt;alert(1)&lt;/script&gt;.");
      expect(email.html).not.toContain("<script>");
      expect(email.text).toContain("Area: Content editing");
      expect(email.text).toContain("Severity: Blocker");
      const visibleHtml = email.html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
      for (const value of ["Content editing", "Blocker", "What happens next", REPORT_ID]) {
        expect(visibleHtml).toContain(value);
      }
      for (const output of [email.subject, email.text, email.html]) {
        expect(output).not.toContain("Save request failed with status 409");
        expect(output).not.toContain("b".repeat(40));
        expect(output).not.toContain("987654");
        expect(output).not.toContain("editor@example.org");
      }
    });

    it("bounds both excerpts and keeps the subject short", () => {
      const email = delivery.renderBugReportEmail(report({
        tryingToDo: `  ${"a".repeat(220)} omitted goal  `,
        happened: `  ${"h".repeat(300)} omitted description  `,
      }), eventType);

      expect(email.subject.split(": ").at(-1)).toBe(`${"a".repeat(79)}…`);
      for (const output of [email.text, email.html]) {
        expect(output).toContain(`${"a".repeat(159)}…`);
        expect(output).toContain(`${"h".repeat(239)}…`);
        expect(output).not.toContain("a".repeat(160));
        expect(output).not.toContain("h".repeat(240));
        expect(output).not.toContain("omitted goal");
        expect(output).not.toContain("omitted description");
      }
    });

    it("keeps Unicode characters intact at each excerpt boundary", () => {
      for (const [field, limit] of [["tryingToDo", 80], ["tryingToDo", 160], ["happened", 240]]) {
        const email = delivery.renderBugReportEmail(report({
          tryingToDo: "",
          happened: "",
          [field]: `${"a".repeat(limit - 2)}\u{1F600} after the limit`,
        }), eventType);
        const boundedOutput = limit === 80 ? email.subject : email.text;
        expect(boundedOutput).toContain(`${"a".repeat(limit - 2)}…`);
        for (const output of [email.subject, email.text, email.html]) {
          expect(output.isWellFormed()).toBe(true);
        }
      }
    });

    it("uses the description when the goal is blank and handles missing optional fields", () => {
      const email = delivery.renderBugReportEmail({
        id: REPORT_ID,
        status: "open",
        tryingToDo: " \n ",
        happened: "  Let us find videos by uploader.  ",
      }, eventType);
      const emptyEmail = delivery.renderBugReportEmail({ id: REPORT_ID, status: "open" }, eventType);

      expect(email.subject).toContain("Let us find videos by uploader.");
      expect(email.text).toContain("What you wrote: Let us find videos by uploader.");
      expect(email.html).toContain("Let us find videos by uploader.");
      expect(email.text).not.toContain("What you were trying to do:");
      expect(email.text).not.toContain("Category:");
      expect(email.text).not.toContain("Area:");
      expect(email.text).not.toContain("Severity:");
      expect(email.html).not.toContain(">Area</td>");
      expect(email.html).not.toContain(">Severity</td>");
      expect(emptyEmail.subject).toContain("Your Boardwalk report");
      for (const output of [email.text, email.html, emptyEmail.text, emptyEmail.html]) {
        expect(output).not.toContain("undefined");
        expect(output).not.toContain("null");
        expect(output).toContain(REPORT_ID);
      }
    });

    it("keeps native descriptions, generated diagnostics, and derived fields out", () => {
      for (const happened of ["My private native description.", "Premiere media.import failed (http; status 500). "]) {
        const email = delivery.renderBugReportEmail(report({
          tryingToDo: "Native goal text.",
          happened,
          environment: { native: { source: "premiere", mode: "manual" } },
        }), eventType);
        expect(email.subject).toContain("Premiere panel report");
        for (const output of [email.subject, email.text, email.html]) {
          expect(output).not.toContain(happened.trim());
          expect(output).not.toContain("Native goal text.");
          expect(output).not.toContain("media.import");
          expect(output).not.toContain("status 500");
        }
        expect(email.text).toContain("from the Premiere panel");
        expect(email.html).toContain("from the Premiere panel");
        expect(email.text).not.toContain("What you wrote:");
        expect(email.text).not.toContain("Area:");
        expect(email.text).not.toContain("Severity:");
        expect(email.html).not.toContain(">Area</td>");
        expect(email.html).not.toContain(">Severity</td>");
      }
    });
  });

  it.each([
    ["open", "waiting for review", "Follow the report for updates"],
    ["acknowledged", "A person is looking into it", "Follow the report for updates"],
    ["in_progress", "Work on your report has started", "Follow the report for updates"],
    ["blocked", "Work is paused", "Check the report for details"],
    ["resolved", "Read the resolution below", "If the problem continues, send a new report"],
    ["dismissed", "closed without further work", "send a new report if you have new details"],
  ])("explains %s and the next step in both formats", (status, meaning, nextStep) => {
    for (const eventType of ["report_status_changed", "report_resolution_updated"]) {
      const email = delivery.renderBugReportEmail(report({
        status,
        actionableResolution: { recommendedResolution: ["Reload the editor."] },
      }), eventType);
      for (const output of [email.text, email.html]) {
        expect(output).toContain(meaning);
        expect(output).toContain(nextStep);
      }
    }
  });

  it("shows a completed investigation-only autofix outcome", () => {
    const record = report();
    record.githubDelivery = {
      ...record.githubDelivery,
      fixStatus: "investigation_only",
    };

    expect(delivery.renderTelegramCard(record)).toContain(
      "Autofix: investigation only",
    );
  });

  it("keeps the autofix outcome before bounded engineering links", () => {
    const record = report();
    record.githubDelivery = {
      ...record.githubDelivery,
      fixStatus: "investigation_only",
    };
    record.links.githubIssues = Array.from({ length: 10 }, (_, index) => ({
      number: index + 1,
      state: "open-with-a-long-status-label",
    }));
    record.links.pullRequests = Array.from({ length: 10 }, (_, index) => ({
      number: index + 1,
      state: "open",
      reviewState: "review-pending-with-long-details",
      checksState: "checks-pending-with-long-details",
      deploymentState: "deployment-pending-with-long-details",
    }));

    const card = delivery.renderTelegramCard(record);
    const engineeringState = card.match(/<b>Engineering state<\/b> ([^\n]+)/)?.[1];

    expect(engineeringState).toMatch(/^Autofix: investigation only/);
    expect(engineeringState.length).toBeLessThanOrEqual(500);
  });

  it("keeps an escaped worst-case incident card within Telegram's text limit", () => {
    const card = delivery.renderTelegramCard(report({
      tryingToDo: "&".repeat(1_000),
      happened: "<".repeat(1_000),
      expected: "漢".repeat(1_000),
      steps: "🙂".repeat(1_000),
      workaround: "'".repeat(1_000),
      route: { path: `/${">".repeat(1_000)}` },
      reporter: { uid: "🙂".repeat(200), role: "editor" },
      ownerUid: "漢".repeat(200),
      environment: {
        buildRevision: "b".repeat(40),
        browser: "🙂".repeat(200),
        operatingSystem: "漢".repeat(200),
        viewport: { width: 10_000, height: 10_000 },
      },
      consoleLogs: Array.from({ length: 20 }, () => ({
        level: "error",
        message: "🙂&".repeat(500),
        timestamp: NOW.toISOString(),
      })),
      links: {
        relatedReportIds: Array.from({ length: 10 }, (_, index) => `br_${String(index).repeat(32)}`),
        githubIssueNumbers: Array.from({ length: 10 }, (_, index) => index + 1),
        pullRequestNumbers: Array.from({ length: 10 }, (_, index) => index + 1),
        githubIssues: Array.from({ length: 10 }, (_, index) => ({ number: index + 1, state: "open" })),
        pullRequests: Array.from({ length: 10 }, (_, index) => ({
          number: index + 1,
          state: "open",
          reviewState: "pending",
          checksState: "pending",
          deploymentState: "pending",
        })),
      },
    }));

    expect(Buffer.byteLength(card, "utf8")).toBeLessThanOrEqual(4_096);
    expect(card).toContain("<b>Workaround</b>");
    expect(card).toContain("<b>Console</b>");
    expect(card).toContain("<b>Engineering state</b>");
  });
});

describe("durable delivery", () => {
  it("starts new delivery work from a Firestore event and sweeps every ten minutes", () => {
    expect(delivery.onBugReportDeliveryCreated.__endpoint.eventTrigger.eventFilterPathPatterns.document)
      .toBe("bugReportDeliveryOutbox/{jobId}");
    expect(delivery.onBugReportDeliveryCreated.__endpoint.timeoutSeconds).toBe(300);
    expect(delivery.onBugReportDelivery.__endpoint.timeoutSeconds).toBe(300);
    expect(delivery.onBugReportDelivery.__endpoint.scheduleTrigger.schedule)
      .toBe("every 10 minutes");
  });

  it("serializes two delivery passes for separate rows on one report", async () => {
    const stored = report();
    await db.collection("bug_reports").doc(stored.id).set(stored);
    for (const [id, version] of [["first", 1], ["second", 2]]) {
      await db.collection("bugReportDeliveryOutbox").doc(id).set({
        reportId: stored.id,
        eventType: version === 1 ? "report_created" : "report_updated",
        reportVersion: version,
        channel: "telegram",
        state: "pending",
        attemptCount: 0,
        nextAttemptAt: new Date(NOW.getTime() + version),
        leaseUntil: null,
        createdAt: NOW,
        updatedAt: NOW,
      });
    }
    const telegramClient = {
      sendMessage: vi.fn(async () => ({ chat: { id: "-1001" }, message_id: 42 })),
      editMessage: vi.fn(async () => null),
    };
    const deps = {
      firestore: db,
      now: () => new Date(NOW.getTime() + 3),
      telegramClient,
      chatId: "-1001",
      adminOrigin: "https://admin.njpbs.org",
    };

    await Promise.all([
      delivery.withDeliveryLease(db, () => delivery.processPendingDeliveries(deps), deps.now),
      delivery.withDeliveryLease(db, () => delivery.processPendingDeliveries(deps), deps.now),
    ]);

    expect(telegramClient.sendMessage).toHaveBeenCalledTimes(1);
    expect(telegramClient.editMessage).toHaveBeenCalledTimes(1);
    expect((await db.collection("bugReportDeliveryOutbox").get()).docs
      .map((document) => document.data().state)).toEqual(["delivered", "delivered"]);
  });

  it("runs another pass when a new event arrives during delivery", async () => {
    let releaseFirst;
    let enterFirst;
    const firstEntered = new Promise((resolve) => { enterFirst = resolve; });
    const firstHeld = new Promise((resolve) => { releaseFirst = resolve; });
    const work = vi.fn(async () => {
      if (work.mock.calls.length === 1) {
        enterFirst();
        await firstHeld;
      }
    });
    const first = delivery.withDeliveryLease(db, work, () => new Date(NOW));
    await firstEntered;
    await expect(delivery.withDeliveryLease(db, work, () => new Date(NOW)))
      .resolves.toBe(false);
    releaseFirst();
    await expect(first).resolves.toBe(true);
    expect(work).toHaveBeenCalledTimes(2);
  });

  it("keeps draining while a pass reports a full batch", async () => {
    const work = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    await expect(delivery.withDeliveryLease(db, work, () => new Date(NOW))).resolves.toBe(true);
    expect(work).toHaveBeenCalledTimes(3);
    expect((await db.collection("system").doc("bugReportDeliveryRun").get()).data())
      .toMatchObject({ owner: null, wakeRequested: false });
  });

  it("drains more than 50 due rows and rows created during the first pass", async () => {
    const reportIds = Array.from({ length: 80 }, (_, index) =>
      contract.mintBugReportId((index + 1).toString(16).padStart(32, "0")));
    async function createRows(ids) {
      const batch = db.batch();
      for (const id of ids) {
        batch.set(db.collection("bug_reports").doc(id), report({ id }));
        batch.set(db.collection("bugReportDeliveryOutbox").doc(id), {
          reportId: id,
          eventType: "report_created",
          reportVersion: 1,
          channel: "telegram",
          state: "pending",
          attemptCount: 0,
          nextAttemptAt: NOW,
          leaseUntil: null,
          createdAt: NOW,
          updatedAt: NOW,
        });
      }
      await batch.commit();
    }
    await createRows(reportIds.slice(0, 60));

    let enterFirst;
    let releaseFirst;
    const firstEntered = new Promise((resolve) => { enterFirst = resolve; });
    const firstHeld = new Promise((resolve) => { releaseFirst = resolve; });
    const telegramClient = {
      sendMessage: vi.fn(async () => {
        if (telegramClient.sendMessage.mock.calls.length === 1) {
          enterFirst();
          await firstHeld;
        }
        return { chat: { id: "-1001" }, message_id: 42 };
      }),
      editMessage: vi.fn(async () => null),
    };
    const deps = {
      firestore: db,
      now: () => new Date(NOW),
      telegramClient,
      chatId: "-1001",
      adminOrigin: "https://admin.njpbs.org",
    };
    const batchSizes = [];
    const work = vi.fn(async () => {
      const before = telegramClient.sendMessage.mock.calls.length;
      const full = await delivery.runDeliveryWork(deps);
      batchSizes.push(telegramClient.sendMessage.mock.calls.length - before);
      return full;
    });
    const leaseRef = db.collection("system").doc("bugReportDeliveryRun");
    const holder = delivery.withDeliveryLease(db, work, deps.now);
    let completed;
    try {
      await firstEntered;
      const heldLease = (await leaseRef.get()).data();
      await createRows(reportIds.slice(60));
      await expect(delivery.withDeliveryLease(db, work, deps.now)).resolves.toBe(false);
      expect(work).toHaveBeenCalledTimes(1);
      expect((await leaseRef.get()).data()).toEqual({ ...heldLease, wakeRequested: true });
    } finally {
      releaseFirst();
      completed = await holder;
    }

    expect(completed).toBe(true);
    expect(batchSizes).toEqual([25, 25, 25, 5]);
    expect(telegramClient.sendMessage).toHaveBeenCalledTimes(reportIds.length);
    expect(telegramClient.editMessage).not.toHaveBeenCalled();
    for (const id of reportIds) {
      expect(telegramClient.sendMessage.mock.calls.filter(([, text]) =>
        text.includes(`<code>${id}</code>`))).toHaveLength(1);
    }
    const deliveredRows = await rows("bugReportDeliveryOutbox");
    expect(deliveredRows).toHaveLength(reportIds.length);
    for (const row of deliveredRows) {
      expect(row).toMatchObject({
        state: "delivered", attemptCount: 1, nextAttemptAt: null, leaseUntil: null,
      });
    }
    expect((await leaseRef.get()).data())
      .toEqual({ owner: null, leaseUntil: null, wakeRequested: false });
  }, 30_000);

  it("sends one Telegram card and edits that card for later events", async () => {
    const stored = report();
    await db.collection("bug_reports").doc(stored.id).set(stored);
    await db.collection("bugReportDeliveryOutbox").doc("initial").set({
      reportId: stored.id,
      eventType: "report_created",
      reportVersion: 1,
      channel: "telegram",
      state: "pending",
      attemptCount: 0,
      nextAttemptAt: NOW,
      leaseUntil: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const telegramClient = {
      sendMessage: vi.fn(async () => ({ chat: { id: "-1001" }, message_id: 42 })),
      editMessage: vi.fn(async () => null),
    };

    const deliveryDeps = {
      firestore: db,
      now: () => new Date(NOW),
      telegramClient,
      chatId: "-1001",
      adminOrigin: "https://admin.njpbs.org",
    };
    const initialResults = await Promise.all([
      delivery.deliverOutboxRow("initial", deliveryDeps),
      delivery.deliverOutboxRow("initial", deliveryDeps),
    ]);
    expect(initialResults.map((result) => result.state).sort())
      .toEqual(["delivered", "skipped"]);
    expect(telegramClient.sendMessage).toHaveBeenCalledTimes(1);

    const first = (await db.collection("bug_reports").doc(stored.id).get()).data();
    expect(first).toMatchObject({
      deliveryStatus: "delivered",
      delivery: { telegramChatId: "-1001", telegramMessageId: "42" },
    });
    expect((await db.collection("bugReportDeliveryOutbox").doc("initial").get()).data().state)
      .toBe("delivered");

    await db.collection("bug_reports").doc(stored.id).update({
      deliveryStatus: "unknown",
    });
    await db.collection("bugReportDeliveryOutbox").doc("update").set({
      reportId: stored.id,
      eventType: "report_updated",
      reportVersion: 2,
      channel: "telegram",
      state: "pending",
      attemptCount: 0,
      nextAttemptAt: NOW,
      leaseUntil: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await delivery.deliverOutboxRow("update", {
      firestore: db,
      now: () => new Date(NOW),
      telegramClient,
      chatId: "-1001",
      adminOrigin: "https://admin.njpbs.org",
    });

    expect(telegramClient.sendMessage).toHaveBeenCalledTimes(1);
    expect(telegramClient.editMessage).toHaveBeenCalledWith(
      "-1001",
      42,
      expect.stringContaining(REPORT_ID),
      expect.objectContaining({ inline_keyboard: expect.any(Array) }),
    );
    const updateKeyboard = telegramClient.editMessage.mock.calls[0][3];
    expect(updateKeyboard.inline_keyboard.flat().map((button) => button.text))
      .not.toContain("Retry notification");
  });

  it("does not automatically retry an ambiguous initial send", async () => {
    const stored = report();
    await db.collection("bug_reports").doc(stored.id).set(stored);
    await db.collection("bugReportDeliveryOutbox").doc("ambiguous").set({
      reportId: stored.id,
      eventType: "report_created",
      reportVersion: 1,
      channel: "telegram",
      state: "pending",
      attemptCount: 0,
      nextAttemptAt: NOW,
      leaseUntil: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const telegramClient = {
      sendMessage: vi.fn(async () => {
        throw new delivery.DeliveryError("unknown", { kind: "ambiguous" });
      }),
    };

    await expect(delivery.deliverOutboxRow("ambiguous", {
      firestore: db,
      now: () => new Date(NOW),
      telegramClient,
      chatId: "-1001",
    })).resolves.toEqual({ state: "unknown" });
    expect((await db.collection("bugReportDeliveryOutbox").doc("ambiguous").get()).data())
      .toMatchObject({ state: "unknown", nextAttemptAt: null });
    expect((await db.collection("bug_reports").doc(stored.id).get()).data().deliveryStatus)
      .toBe("unknown");
  });

  it("blocks later Telegram updates until an ambiguous send is retried explicitly", async () => {
    const stored = report({ deliveryStatus: "unknown" });
    await db.collection("bug_reports").doc(stored.id).set(stored);
    await db.collection("bugReportDeliveryOutbox").doc("later-update").set({
      reportId: stored.id,
      eventType: "report_updated",
      reportVersion: 2,
      channel: "telegram",
      state: "pending",
      attemptCount: 0,
      nextAttemptAt: NOW,
      leaseUntil: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const telegramClient = { sendMessage: vi.fn() };

    await expect(delivery.deliverOutboxRow("later-update", {
      firestore: db,
      now: () => new Date(NOW),
      telegramClient,
      chatId: "-1001",
    })).resolves.toEqual({ state: "skipped" });

    expect(telegramClient.sendMessage).not.toHaveBeenCalled();
    expect((await db.collection("bugReportDeliveryOutbox").doc("later-update").get()).data())
      .toMatchObject({ state: "blocked_unknown", nextAttemptAt: null });
    expect((await db.collection("bug_reports").doc(stored.id).get()).data().deliveryStatus)
      .toBe("unknown");
  });

  it.each([["configured", REPORT_EMAIL_BCC], ["empty", []], ["unset", undefined]])("accepts a queued reporter confirmation with %s BCC", async (_label, bcc) => {
    vi.stubEnv("CMS_BUG_REPORT_EMAIL_BCC", bcc === undefined ? undefined : JSON.stringify(bcc));
    const stored = report();
    await db.collection("bug_reports").doc(stored.id).set(stored);
    await db.collection("bugReportDeliveryOutbox").doc("email").set({
      reportId: stored.id,
      eventType: "report_received",
      reportVersion: 1,
      channel: "email",
      state: "pending",
      attemptCount: 0,
      nextAttemptAt: NOW,
      leaseUntil: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const sendEmail = vi.fn(async () => ({ queued: true }));

    await expect(delivery.deliverOutboxRow("email", {
      firestore: db,
      now: () => new Date(NOW),
      sendEmail,
      adminOrigin: "https://admin.njpbs.org",
    })).resolves.toEqual({ state: "delivered" });
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: "editor@example.org",
      bcc: bcc ?? [],
      subject: "We received your problem report: Publish the evening story",
      text: expect.stringContaining("We received your problem report in Boardwalk."),
      html: expect.stringContaining('<img src="cid:njpbs-email-logo"'),
      attachments: [expect.objectContaining({
        content_id: "njpbs-email-logo",
        disposition: "inline",
      })],
    }));
  });

  it("renders a status email from the status stored with that event", async () => {
    const stored = report({
      status: "dismissed",
      version: 4,
      actionableResolution: {
        ...contract.defaultActionableResolution(),
        recommendedResolution: ["Use the later resolution."],
      },
    });
    const eventResolution = {
      ...contract.defaultActionableResolution(),
      recommendedResolution: ["Use the event resolution."],
    };
    await db.collection("bug_reports").doc(stored.id).set(stored);
    await db.collection("bugReportDeliveryOutbox").doc("status-email").set({
      reportId: stored.id,
      eventType: "report_status_changed",
      eventStatus: "resolved",
      eventResolution,
      reportVersion: 3,
      channel: "email",
      state: "pending",
      attemptCount: 0,
      nextAttemptAt: NOW,
      leaseUntil: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const sendEmail = vi.fn(async () => ({ delivered: true }));

    await expect(delivery.deliverOutboxRow("status-email", {
      firestore: db,
      now: () => new Date(NOW),
      sendEmail,
      adminOrigin: "https://admin.njpbs.org",
    })).resolves.toEqual({ state: "delivered" });

    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      bcc: REPORT_EMAIL_BCC,
      text: expect.stringContaining("is now resolved"),
    }));
    expect(sendEmail.mock.calls[0][0].text).not.toContain("is now closed");
    expect(sendEmail.mock.calls[0][0].text).toContain("Use the event resolution.");
    expect(sendEmail.mock.calls[0][0].text).not.toContain("Use the later resolution.");
    expect(sendEmail.mock.calls[0][0].html).toContain(">Report resolved</h1>");
    expect(sendEmail.mock.calls[0][0].html).toContain("Use the event resolution.");
    expect(sendEmail.mock.calls[0][0].html).not.toContain("Use the later resolution.");
  });

  it("does not add a later resolution to a legacy status event", async () => {
    const stored = report({
      status: "resolved",
      version: 4,
      actionableResolution: {
        ...contract.defaultActionableResolution(),
        recommendedResolution: ["This resolution was saved later."],
      },
    });
    await db.collection("bug_reports").doc(stored.id).set(stored);
    await db.collection("bugReportDeliveryOutbox").doc("legacy-status-email").set({
      reportId: stored.id,
      eventType: "report_status_changed",
      eventStatus: "resolved",
      reportVersion: 3,
      channel: "email",
      state: "pending",
      attemptCount: 0,
      nextAttemptAt: NOW,
      leaseUntil: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const sendEmail = vi.fn(async () => ({ delivered: true }));

    await expect(delivery.deliverOutboxRow("legacy-status-email", {
      firestore: db,
      now: () => new Date(NOW),
      sendEmail,
    })).resolves.toEqual({ state: "delivered" });

    expect(sendEmail.mock.calls[0][0].text).not.toContain("This resolution was saved later.");
  });

  it("does not retry an email when the provider acceptance result is unclear", async () => {
    const stored = report();
    await db.collection("bug_reports").doc(stored.id).set(stored);
    await db.collection("bugReportDeliveryOutbox").doc("unaccepted-email").set({
      reportId: stored.id,
      eventType: "report_received",
      reportVersion: 1,
      channel: "email",
      state: "pending",
      attemptCount: 0,
      nextAttemptAt: NOW,
      leaseUntil: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const sendEmail = vi.fn(async () => ({ delivered: false, queued: false }));

    await expect(delivery.deliverOutboxRow("unaccepted-email", {
      firestore: db,
      now: () => new Date(NOW),
      sendEmail,
    })).resolves.toEqual({ state: "unknown" });
    await expect(delivery.deliverOutboxRow("unaccepted-email", {
      firestore: db,
      now: () => new Date(NOW),
      sendEmail,
    })).resolves.toEqual({ state: "skipped" });

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect((await db.collection("bugReportDeliveryOutbox").doc("unaccepted-email").get()).data())
      .toMatchObject({ state: "unknown", nextAttemptAt: null });
  });

  it("keeps an explicit provider refusal terminal", async () => {
    const stored = report();
    await db.collection("bug_reports").doc(stored.id).set(stored);
    await db.collection("bugReportDeliveryOutbox").doc("refused-email").set({
      reportId: stored.id,
      eventType: "report_received",
      reportVersion: 1,
      channel: "email",
      state: "pending",
      attemptCount: 0,
      nextAttemptAt: NOW,
      leaseUntil: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const refusal = Object.assign(new Error("refused"), {
      name: "EmailDeliveryError",
      kind: "terminal",
      status: 400,
    });

    await expect(delivery.deliverOutboxRow("refused-email", {
      firestore: db,
      now: () => new Date(NOW),
      sendEmail: vi.fn(async () => { throw refusal; }),
    })).resolves.toEqual({ state: "terminal_failed" });

    expect((await db.collection("bugReportDeliveryOutbox").doc("refused-email").get()).data())
      .toMatchObject({ state: "terminal_failed", nextAttemptAt: null, lastError: "terminal (400)" });
  });
});

describe("Telegram callback boundary", () => {
  it("requires the webhook, chat, mapped user, and current CMS admin role", async () => {
    const stored = report();
    await db.collection("bug_reports").doc(stored.id).set(stored);
    await db.collection("users").doc("admin-1").set({
      email: "admin@example.org",
      role: "admin",
      active: true,
    });
    const client = {
      answerCallbackQuery: vi.fn(async () => null),
      editMessage: vi.fn(async () => null),
      editKeyboard: vi.fn(async () => null),
    };
    const handler = await delivery.createTelegramWebhookHandler({
      firestore: db,
      client,
      webhookSecret: "webhook-secret-value",
      chatId: "-1001",
      adminMap: { "100000001": "admin-1" },
      now: () => NOW.toISOString(),
    });
    const req = {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": "webhook-secret-value" },
      body: {
        callback_query: {
          id: "callback-1",
          from: { id: 100000001 },
          message: { message_id: 42, chat: { id: -1001 } },
          data: delivery.callbackData("a", REPORT_ID),
        },
      },
    };
    const firstResponse = response();
    await handler(req, firstResponse);

    expect(firstResponse.statusCode).toBe(200);
    expect((await db.collection("bug_reports").doc(stored.id).get()).data())
      .toMatchObject({ status: "acknowledged", acknowledgedBy: "admin-1", version: 2 });
    expect(await rows("admin_logs")).toHaveLength(1);
    expect(await rows("bugReportMutationReceipts")).toHaveLength(1);
    expect(await rows("bugReportDeliveryOutbox")).toHaveLength(2);

    const replayResponse = response();
    await handler(req, replayResponse);
    expect(replayResponse.statusCode).toBe(200);
    expect(await rows("admin_logs")).toHaveLength(1);
    expect(await rows("bugReportDeliveryOutbox")).toHaveLength(2);
    expect(client.answerCallbackQuery).toHaveBeenLastCalledWith(
      "callback-1",
      "This action was already applied.",
    );

    await db.collection("users").doc("admin-1").update({ active: false });
    const deniedResponse = response();
    await handler({
      ...req,
      body: {
        callback_query: {
          ...req.body.callback_query,
          id: "callback-2",
          data: delivery.callbackData("t", REPORT_ID),
        },
      },
    }, deniedResponse);
    expect((await db.collection("bug_reports").doc(stored.id).get()).data().ownerUid)
      .toBeNull();
  });

  it("reports a saved mutation accurately when the immediate card refresh fails", async () => {
    const stored = report();
    await db.collection("bug_reports").doc(stored.id).set(stored);
    await db.collection("users").doc("admin-1").set({
      email: "admin@example.org",
      role: "admin",
      active: true,
    });
    const client = {
      answerCallbackQuery: vi.fn(async () => null),
      editMessage: vi.fn(async () => {
        throw new delivery.DeliveryError("refresh failed", { kind: "retryable", status: 503 });
      }),
      editKeyboard: vi.fn(async () => null),
    };
    const handler = await delivery.createTelegramWebhookHandler({
      firestore: db,
      client,
      webhookSecret: "webhook-secret-value",
      chatId: "-1001",
      adminMap: { "100000001": "admin-1" },
      now: () => NOW.toISOString(),
    });
    const result = response();

    await handler({
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": "webhook-secret-value" },
      body: {
        callback_query: {
          id: "callback-refresh-failure",
          from: { id: 100000001 },
          message: { message_id: 42, chat: { id: -1001 } },
          data: delivery.callbackData("a", REPORT_ID),
        },
      },
    }, result);

    expect(result.statusCode).toBe(200);
    expect((await db.collection("bug_reports").doc(stored.id).get()).data())
      .toMatchObject({ status: "acknowledged", version: 2 });
    expect(client.answerCallbackQuery).toHaveBeenCalledWith(
      "callback-refresh-failure",
      "Report saved. Open the CMS report for current status.",
    );
  });

  it("rejects a bad webhook secret before answering a callback", async () => {
    const client = { answerCallbackQuery: vi.fn() };
    const handler = await delivery.createTelegramWebhookHandler({
      firestore: db,
      client,
      webhookSecret: "expected-secret",
      chatId: "-1001",
      adminMap: { "100000001": "admin-1" },
    });
    const result = response();
    await handler({
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": "wrong-secret" },
      body: {},
    }, result);
    expect(result.statusCode).toBe(401);
    expect(client.answerCallbackQuery).not.toHaveBeenCalled();
  });
});
