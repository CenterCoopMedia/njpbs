import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import adminPkg from "../helpers/firebase-admin.js";
import sharp from "sharp";
import bugReport from "../../functions/bug-report.js";
import contract from "../../functions/lib/bug-report-contract.js";

const admin = adminPkg;
const PROJECT = process.env.GCLOUD_PROJECT || "demo-njpbs";
const FIRESTORE_HOST =
  process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
const BUILD_REVISION = "b".repeat(40);
const REQUEST_ID = "22222222-2222-4222-8222-222222222222";
const CLIENT_REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-08-28T20:30:00.000Z");
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X2lWAAAAAElFTkSuQmCC",
  "base64",
);

const {
  BugReportRateLimitError,
  cmsSubmitBugReport,
  createCmsSubmitBugReportHandler,
  deterministicReportId,
  normalizeScreenshot,
  parseMultipartReport,
  parseReportFields,
  persistBugReport,
  reporterRole,
} = bugReport;
const { composeBugReport } = contract;

let db;

function submission(overrides = {}) {
  return {
    severity: "work_impaired",
    area: "content_editing",
    tryingToDo: "Update the homepage lead story.",
    happened: "The save stopped and showed a conflict.",
    expected: "The new lead story should have saved as a draft.",
    steps: "Open Home.\nChange the lead story.\nSelect Save.",
    workaround: "Kept the editor open and did not reload.",
    route: "/content/page/home?private=value#editor",
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
    correlationIds: [],
    ...overrides,
  };
}

function record(clientRequestId = CLIENT_REQUEST_ID) {
  return composeBugReport(submission(), {
    reportId: deterministicReportId("editor-1", clientRequestId),
    nowIso: NOW.toISOString(),
    reporter: {
      uid: "editor-1",
      email: "editor@example.org",
      role: "editor",
    },
    buildRevision: BUILD_REVISION,
    deploymentEnvironment: "production",
    requestId: REQUEST_ID,
  });
}

function makeRes() {
  const response = { statusCode: null, body: null, headers: {} };
  response.set = (name, value) => {
    response.headers[name.toLocaleLowerCase("en-US")] = value;
    return response;
  };
  response.status = (statusCode) => {
    response.statusCode = statusCode;
    return response;
  };
  response.json = (body) => {
    response.body = body;
    return response;
  };
  return response;
}

function handlerRequest() {
  return {
    method: "POST",
    rawBody: Buffer.from("--boundary--"),
    headers: {
      "content-type": "multipart/form-data; boundary=boundary",
      "x-njpbs-request-id": REQUEST_ID,
      "x-forwarded-for": "203.0.113.10",
    },
  };
}

async function collectionRows(name) {
  return (await db.collection(name).get()).docs.map((entry) => entry.data());
}

beforeAll(() => {
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  db = isolatedFirestore("bug-report.test.js");
});

beforeEach(async () => {
  await clearEmulatorFirestore(
    `http://${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: "DELETE" }, db,
  );
});

afterAll(async () => {
  await Promise.all(admin.apps.map((app) => app.delete()));
});

describe("bug report request boundary", () => {
  it("isolates screenshot processing within bounded function resources", () => {
    expect(cmsSubmitBugReport.__endpoint).toMatchObject({
      availableMemoryMb: 1_024,
      concurrency: 1,
      maxInstances: 5,
    });
  });

  it("parses the closed multipart shape with an optional screenshot", async () => {
    const form = new FormData();
    form.set("report", JSON.stringify(submission()));
    form.set("clientRequestId", CLIENT_REQUEST_ID);
    form.set("website", "");
    form.set("screenshot", new Blob([PNG], { type: "image/png" }), "screen.png");
    const request = new Request("https://example.invalid", {
      method: "POST",
      body: form,
    });
    const req = {
      rawBody: Buffer.from(await request.arrayBuffer()),
      headers: Object.fromEntries(request.headers),
    };

    const parsed = await parseMultipartReport(req);

    expect(JSON.parse(parsed.fields.report)).toMatchObject({ area: "content_editing" });
    expect(parsed.fields.clientRequestId).toBe(CLIENT_REQUEST_ID);
    expect(parsed.screenshot).toMatchObject({ mimeType: "image/png" });
    expect(parsed.screenshot.buffer).toEqual(PNG);
  });

  it("normalizes decoded still images to bounded metadata-free WebP", async () => {
    const validPng = await sharp({
      create: {
        width: 2,
        height: 3,
        channels: 3,
        background: { r: 20, g: 40, b: 80 },
      },
    }).png().toBuffer();
    const normalized = await normalizeScreenshot({
      mimeType: "image/png",
      buffer: validPng,
    });

    expect(normalized).toMatchObject({
      mimeType: "image/webp",
      width: 2,
      height: 3,
      sizeBytes: normalized.buffer.length,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    await expect(
      normalizeScreenshot({
        mimeType: "image/png",
        buffer: Buffer.from("not an image"),
      }),
    ).rejects.toMatchObject({ status: 415 });
    await expect(
      normalizeScreenshot({
        mimeType: "image/jpeg",
        buffer: validPng,
      }),
    ).rejects.toMatchObject({ status: 415 });
  });

  it("accepts a high-resolution phone JPEG within the file-size limit", async () => {
    const phoneJpeg = await sharp({
      create: {
        width: 4_284,
        height: 5_712,
        channels: 3,
        background: { r: 20, g: 40, b: 80 },
      },
    }).jpeg().toBuffer();
    expect(phoneJpeg.length).toBeLessThan(5 * 1024 * 1024);

    const normalized = await normalizeScreenshot({
      mimeType: "image/jpeg",
      buffer: phoneJpeg,
    });
    expect(normalized).toMatchObject({ mimeType: "image/webp", width: 1_200, height: 1_600 });
  }, 20_000);

  it("reports when a screenshot exceeds the bounded pixel limit", async () => {
    const oversizedJpeg = await sharp({
      create: {
        width: 8_000,
        height: 6_400,
        channels: 3,
        background: { r: 20, g: 40, b: 80 },
      },
    }).jpeg().toBuffer();
    expect(oversizedJpeg.length).toBeLessThan(5 * 1024 * 1024);

    await expect(normalizeScreenshot({ mimeType: "image/jpeg", buffer: oversizedJpeg }))
      .rejects.toMatchObject({ status: 413, message: expect.stringMatching(/too many pixels/i) });
  }, 20_000);

  it("rejects an image that remains too large after safe normalization", async () => {
    const width = 1_600;
    const height = 1_600;
    const pixels = Buffer.alloc(width * height * 3);
    let state = 0x457;
    for (let index = 0; index < pixels.length; index += 1) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      pixels[index] = state >>> 24;
    }
    const noisyJpeg = await sharp(pixels, {
      raw: { width, height, channels: 3 },
    }).jpeg({ quality: 90 }).toBuffer();
    expect(noisyJpeg.length).toBeLessThan(5 * 1024 * 1024);

    await expect(
      normalizeScreenshot({
        mimeType: "image/jpeg",
        buffer: noisyJpeg,
      }),
    ).rejects.toMatchObject({
      status: 413,
      message: expect.stringMatching(/normalized screenshot is too large/i),
    });
  }, 20_000);

  it("derives the highest approved staff role and rejects raw auth", () => {
    expect(
      reporterRole({ grants: [{ role: "contributor" }, { role: "editor" }] }),
    ).toBe("editor");
    expect(() => reporterRole({ grants: [] })).toThrow(/approved, active/i);
  });

  it("rejects the honeypot without naming the anti-abuse field", () => {
    expect(() =>
      parseReportFields({
        report: JSON.stringify(submission()),
        clientRequestId: CLIENT_REQUEST_ID,
        website: "https://spam.example",
      }),
    ).toThrow("The report could not be submitted");
  });

  it("refuses a Firebase user who has no active CMS grant before parsing", async () => {
    const handler = createCmsSubmitBugReportHandler({
      firestore: db,
      requirePrincipalFn: async () => ({
        uid: "raw-user",
        email: "raw@example.org",
        emailVerified: true,
        principal: { id: "raw-user", grants: [] },
      }),
    });
    const res = makeRes();

    await handler(handlerRequest(), res);

    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/approved, active/i);
    expect(await collectionRows("bug_reports")).toEqual([]);
  });
});

describe("atomic bug report persistence", () => {
  it("commits report, private evidence, audit, rate, and delivery work together", async () => {
    const validPng = await sharp({
      create: {
        width: 2,
        height: 3,
        channels: 3,
        background: { r: 20, g: 40, b: 80 },
      },
    }).png().toBuffer();
    const screenshot = await normalizeScreenshot({
      mimeType: "image/png",
      buffer: validPng,
    });

    const result = await persistBugReport({
      firestore: db,
      record: record(),
      screenshot,
      now: NOW,
      source: { ip: "203.0.113.10", requestId: REQUEST_ID },
    });

    expect(result.created).toBe(true);
    expect(result.record).toMatchObject({
      deliveryStatus: "pending",
      evidence: {
        screenshot: {
          id: result.record.id,
          mimeType: "image/webp",
          sha256: screenshot.sha256,
          expiresAt: "2026-11-26T20:30:00.000Z",
        },
      },
    });
    expect(result.record.evidence.screenshot).not.toHaveProperty("url");

    const evidence = (await collectionRows("bugReportEvidence"))[0];
    expect(evidence).toMatchObject({
      reportId: result.record.id,
      reporterUid: "editor-1",
      mimeType: "image/webp",
      sha256: screenshot.sha256,
    });
    expect(evidence.bytes).toEqual(screenshot.buffer);
    expect(evidence.expireAt.toDate().toISOString()).toBe(
      "2026-11-26T20:30:00.000Z",
    );
    expect(await collectionRows("bugReportDeliveryOutbox")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        reportId: result.record.id,
        channel: "telegram",
        state: "pending",
        attemptCount: 0,
      }),
      expect.objectContaining({
        reportId: result.record.id,
        channel: "email",
        eventType: "report_received",
        state: "pending",
      }),
    ]));
    expect(await collectionRows("admin_logs")).toEqual([
      expect.objectContaining({
        actorUid: "editor-1",
        action: "bug_report.create",
        target: `bug_reports/${result.record.id}`,
      }),
    ]);
    expect(await collectionRows("bugReportRateLimits")).toEqual([
      expect.objectContaining({ count: 1 }),
    ]);
  });

  it("returns the first receipt for an exact client-request retry without new work", async () => {
    const first = await persistBugReport({
      firestore: db,
      record: record(),
      screenshot: null,
      now: NOW,
      source: { ip: null, requestId: REQUEST_ID },
    });
    const retry = await persistBugReport({
      firestore: db,
      record: record(),
      screenshot: null,
      now: new Date(NOW.getTime() + 1_000),
      source: { ip: null, requestId: REQUEST_ID },
    });

    expect(first.created).toBe(true);
    expect(retry).toMatchObject({ created: false, record: { id: first.record.id } });
    expect(await collectionRows("bug_reports")).toHaveLength(1);
    expect(await collectionRows("bugReportDeliveryOutbox")).toHaveLength(2);
    expect(await collectionRows("admin_logs")).toHaveLength(1);
    expect((await collectionRows("bugReportRateLimits"))[0].count).toBe(1);
  });

  it("limits one reporter to five new reports per 15-minute window", async () => {
    for (let index = 0; index < 5; index += 1) {
      const suffix = String(index + 1).padStart(12, "0");
      await persistBugReport({
        firestore: db,
        record: record(`11111111-1111-4111-8111-${suffix}`),
        screenshot: null,
        now: new Date(NOW.getTime() + index),
        source: { ip: null, requestId: REQUEST_ID },
      });
    }

    await expect(
      persistBugReport({
        firestore: db,
        record: record("11111111-1111-4111-8111-000000000006"),
        screenshot: null,
        now: new Date(NOW.getTime() + 5_000),
        source: { ip: null, requestId: REQUEST_ID },
      }),
    ).rejects.toBeInstanceOf(BugReportRateLimitError);
    expect(await collectionRows("bug_reports")).toHaveLength(5);
    expect(await collectionRows("admin_logs")).toHaveLength(5);
  });

  it("returns a fixed reporter receipt from the HTTP handler", async () => {
    const handler = createCmsSubmitBugReportHandler({
      firestore: db,
      requirePrincipalFn: async () => ({
        uid: "editor-1",
        email: "editor@example.org",
        emailVerified: true,
        principal: { id: "editor-1", grants: [{ role: "editor" }] },
      }),
      parseMultipartFn: async () => ({
        fields: {
          report: JSON.stringify(
            submission({ happened: "Authorization: Bearer private-value" }),
          ),
          clientRequestId: CLIENT_REQUEST_ID,
          website: "",
        },
        screenshot: null,
      }),
      normalizeScreenshotFn: async () => null,
      now: () => NOW,
      buildRevision: () => BUILD_REVISION,
      deploymentEnvironment: () => "production",
    });
    const res = makeRes();

    await handler(handlerRequest(), res);

    expect(res.statusCode).toBe(201);
    expect(res.headers["cache-control"]).toContain("no-store");
    expect(res.body).toMatchObject({
      success: true,
      idempotent: false,
      report: {
        id: deterministicReportId("editor-1", CLIENT_REQUEST_ID),
        reporter: { uid: "editor-1", role: "editor" },
        evidence: { screenshot: null },
      },
    });
    expect(res.body.report).not.toHaveProperty("deliveryStatus");
    expect(res.body.report).not.toHaveProperty("links");
    expect(res.body.report.happened).toBe("Authorization: [redacted]");
  });

  it("records the live Admin revision from the production status manifest", async () => {
    const handler = createCmsSubmitBugReportHandler({
      firestore: db,
      requirePrincipalFn: async () => ({
        uid: "editor-1",
        email: "editor@example.org",
        emailVerified: true,
        principal: { id: "editor-1", grants: [{ role: "editor" }] },
      }),
      parseMultipartFn: async () => ({
        fields: {
          report: JSON.stringify(submission()),
          clientRequestId: CLIENT_REQUEST_ID,
          website: "",
        },
        screenshot: null,
      }),
      normalizeScreenshotFn: async () => null,
      now: () => NOW,
      fetchFn: async () => {
        const bytes = Buffer.from(JSON.stringify({
          schemaVersion: 2,
          status: "current",
          environment: "Production",
          build: { revision: BUILD_REVISION, builtAt: NOW.toISOString() },
        }));
        let sent = false;
        return {
          ok: true,
          headers: { get: () => null },
          body: {
            getReader: () => ({
              read: async () => {
                if (sent) return { done: true, value: undefined };
                sent = true;
                return { done: false, value: bytes };
              },
            }),
          },
        };
      },
      deploymentEnvironment: () => "production",
    });
    const res = makeRes();

    await handler(handlerRequest(), res);

    expect(res.statusCode).toBe(201);
    const stored = (await db.collection("bug_reports").doc(res.body.report.id).get()).data();
    expect(stored.environment.buildRevision).toBe(BUILD_REVISION);
  });

  it.each(["emulator", "development"])("uses the configured Admin revision in %s", async environment => {
    const previousRevision = process.env.CMS_ADMIN_BUILD_REVISION;
    process.env.CMS_ADMIN_BUILD_REVISION = BUILD_REVISION;
    const fetchFn = async () => { throw new Error("production Admin status should not be fetched"); };
    const handler = createCmsSubmitBugReportHandler({
      firestore: db,
      requirePrincipalFn: async () => ({
        uid: "editor-1",
        email: "editor@example.org",
        emailVerified: true,
        principal: { id: "editor-1", grants: [{ role: "editor" }] },
      }),
      parseMultipartFn: async () => ({
        fields: {
          report: JSON.stringify(submission()),
          clientRequestId: CLIENT_REQUEST_ID,
          website: "",
        },
        screenshot: null,
      }),
      normalizeScreenshotFn: async () => null,
      now: () => NOW,
      fetchFn,
      deploymentEnvironment: () => environment,
    });
    const res = makeRes();

    try {
      await handler(handlerRequest(), res);
      expect(res.statusCode).toBe(201);
      const stored = (await db.collection("bug_reports").doc(res.body.report.id).get()).data();
      expect(stored.environment.buildRevision).toBe(BUILD_REVISION);
      expect(stored.environment.deploymentEnvironment).toBe(environment);
      expect(stored.route.url).toBeNull();
    } finally {
      if (previousRevision === undefined) delete process.env.CMS_ADMIN_BUILD_REVISION;
      else process.env.CMS_ADMIN_BUILD_REVISION = previousRevision;
    }
  });

  it("returns an existing report without rereading Admin status", async () => {
    const stored = record();
    await persistBugReport({
      firestore: db,
      record: stored,
      screenshot: null,
      now: NOW,
      source: { ip: null, requestId: REQUEST_ID },
    });
    const handler = createCmsSubmitBugReportHandler({
      firestore: db,
      requirePrincipalFn: async () => ({
        uid: "editor-1",
        email: "editor@example.org",
        emailVerified: true,
        principal: { id: "editor-1", grants: [{ role: "editor" }] },
      }),
      parseMultipartFn: async () => ({
        fields: {
          report: JSON.stringify(submission()),
          clientRequestId: CLIENT_REQUEST_ID,
          website: "",
        },
        screenshot: null,
      }),
      normalizeScreenshotFn: async () => {
        throw new Error("retry must not rebuild evidence");
      },
      now: () => NOW,
      fetchFn: async () => { throw new Error("retry must not fetch Admin status"); },
      deploymentEnvironment: () => "production",
    });
    const res = makeRes();

    await handler(handlerRequest(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.idempotent).toBe(true);
    expect(res.body.report.id).toBe(stored.id);
  });

  it("refuses intake when the Admin revision cannot be read", async () => {
    const handler = createCmsSubmitBugReportHandler({
      firestore: db,
      requirePrincipalFn: async () => ({
        uid: "editor-1",
        email: "editor@example.org",
        emailVerified: true,
        principal: { id: "editor-1", grants: [{ role: "editor" }] },
      }),
      parseMultipartFn: async () => ({
        fields: {
          report: JSON.stringify(submission()),
          clientRequestId: CLIENT_REQUEST_ID,
          website: "",
        },
        screenshot: null,
      }),
      normalizeScreenshotFn: async () => null,
      now: () => NOW,
      fetchFn: async () => { throw new Error("offline"); },
      deploymentEnvironment: () => "production",
    });
    const res = makeRes();

    await handler(handlerRequest(), res);

    expect(res.statusCode).toBe(503);
    expect(res.body.error).toMatch(/could not be read/i);
    expect(await db.collection("bug_reports").get()).toMatchObject({ size: 0 });
  });
});
