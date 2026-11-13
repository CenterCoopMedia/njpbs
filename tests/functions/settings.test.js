import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import adminPkg from "../helpers/firebase-admin.js";
import settingsPkg from "../../functions/settings.js";
import { DEFAULT_SITE_NAVIGATION } from "../../packages/content-core/src/cms-settings";

const admin = adminPkg;
const require = createRequire(import.meta.url);
const PROJECT = "demo-njpbs";
const {
  createCmsGetSettingsHandler,
  createCmsGetNewsroomBannerHandler,
  createCmsGetPublishedSettingsHandler,
  createCmsPublishSettingsHandler,
  createCmsSaveSettingsHandler,
  DEFAULT_NEWSROOM_BANNER_HEADING,
  validateGetPublishedSettingsRequest,
  validateGetSettingsRequest,
  validatePublishSettingsRequest,
  validateSaveSettingsRequest,
} = settingsPkg;

const SETTINGS_SCHEMAS = Object.freeze({
  "site-brand": {
    currentVersion: 2,
    versions: {
      1: {
        schemaVersion: 1,
        fields: {
          headline: { kind: "string", required: true, maxBytes: 120 },
        },
      },
      2: {
        schemaVersion: 2,
        fields: {
          headline: { kind: "string", required: true, maxBytes: 120 },
          hero: { kind: "assetId" },
          gallery: { kind: "assetIdList", maxItems: 4 },
        },
      },
    },
  },
});

let db;

function makeReq({
  method = "POST",
  body = {},
  headers = { "content-type": "application/json" },
} = {}) {
  return {
    method,
    body,
    headers,
    ip: "203.0.113.17",
    rawBody: Buffer.from(JSON.stringify(body)),
  };
}

function makeRes() {
  const res = {
    statusCode: null,
    body: null,
    headersSent: false,
    headers: new Map(),
  };
  res.set = (name, value) => {
    res.headers.set(name.toLocaleLowerCase(), value);
    return res;
  };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    res.headersSent = true;
    return res;
  };
  return res;
}

function actor(grants = [{ role: "admin" }]) {
  return {
    uid: "admin-1",
    email: "admin@example.org",
    principal: { id: "admin-1", grants },
  };
}

function handlerDeps(overrides = {}) {
  return {
    firestore: db,
    requirePrincipalFn: async () => actor(),
    settingsSchemas: SETTINGS_SCHEMAS,
    now: () => "2026-08-14T15:00:00.000Z",
    log: { error: vi.fn(), warn: vi.fn() },
    ...overrides,
  };
}

async function call(handler, body, options = {}) {
  const res = makeRes();
  await handler(makeReq({ body, ...options }), res);
  return res;
}

async function docsIn(collection) {
  const snapshot = await db.collection(collection).get();
  return snapshot.docs.map((document) => ({ id: document.id, ...document.data() }));
}

function activeSeedAsset(overrides = {}) {
  return {
    id: "asset-one",
    lifecycle: "active",
    source: "site_seed",
    mimeType: "image/png",
    url: "https://media.njpbs.org/cms-media/site/asset-one/hash.png",
    altText: "NJ PBS mark",
    width: 800,
    height: 450,
    ...overrides,
  };
}

function mediaProjection(asset) {
  return {
    url: asset.url,
    altText: asset.altText,
    mimeType: asset.mimeType,
    width: asset.width,
    height: asset.height,
  };
}

function noWriteHarness(document) {
  const settingsRef = { path: "cmsSettings/site-brand" };
  const userRef = { path: "users/admin-1" };
  const auditRef = { path: "admin_logs/generated" };
  const historyRef = { path: "cmsVersionHistory/generated" };
  const transaction = {
    get: vi.fn(async (ref) => ({
      exists: ref === userRef || (ref === settingsRef && document !== undefined),
      data: () => ref === userRef ? { role: "admin", active: true } : document,
    })),
    set: vi.fn(),
  };
  const firestore = {
    collection: vi.fn((name) => ({
      doc: vi.fn(() => name === "cmsSettings"
        ? settingsRef
        : name === "users"
          ? userRef
          : name === "cmsVersionHistory"
            ? historyRef
            : auditRef),
    })),
    runTransaction: vi.fn(async (callback) => callback(transaction)),
  };
  return { firestore, transaction };
}

beforeAll(() => {
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  db = admin.firestore();
});

beforeEach(async () => {
  await clearEmulatorFirestore(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: "DELETE" },
  );
  await db.collection("users").doc("admin-1").set({ role: "admin", active: true });
});

afterAll(async () => {
  await Promise.all(admin.apps.map((app) => app.delete()));
});

describe("CMS settings request contracts", () => {
  it("exports the approved settings handlers from the deployment manifest", () => {
    const api = require("../../functions/index.js");
    const runtimeSettings = require("../../functions/settings.js");
    for (const name of ["cmsGetNewsroomBanner", "cmsGetSettings", "cmsSaveSettings", "cmsPublishSettings"]) {
      expect(api[name]).toBeTypeOf("function");
      expect(api[name]).toBe(runtimeSettings[name]);
      expect(api[name].__endpoint.platform).toBe("gcfv2");
    }
    expect(Object.hasOwn(api, "cmsGetPublishedSettings")).toBe(false);
    const source = readFileSync(
      new URL("../../functions/settings.js", import.meta.url),
      "utf8",
    );
    expect(source).toMatch(
      /const cmsPublishSettings = cmsOnRequest\(\s*\{ cors: true \}/,
    );
  });

  it("accepts only the exact read and publish shapes", () => {
    expect(validateGetSettingsRequest({ id: "site-brand" })).toBeNull();
    expect(validateGetSettingsRequest({ id: "site-brand", extra: true }))
      .toMatch(/unknown request field/i);
    expect(validateGetSettingsRequest({ id: "bad/path" })).toMatch(/bounded/i);
    expect(validateGetPublishedSettingsRequest({ id: "site-brand" })).toBeNull();
    expect(validateGetPublishedSettingsRequest({ id: "site-brand", version: 1 }))
      .toMatch(/unknown request field/i);

    expect(validatePublishSettingsRequest({ id: "site-brand", baseVersion: 2 }))
      .toBeNull();
    expect(validatePublishSettingsRequest({ id: "site-brand", baseVersion: 0 }))
      .toMatch(/positive safe integer/i);
    expect(validatePublishSettingsRequest({
      id: "site-brand",
      baseVersion: 2,
      values: {},
    })).toMatch(/unknown request field/i);
  });

  it("requires one exact create or update save precondition", () => {
    expect(validateSaveSettingsRequest({
      id: "site-brand",
      values: { headline: "NJ PBS" },
      createOnly: true,
    })).toBeNull();
    expect(validateSaveSettingsRequest({
      id: "site-brand",
      values: { headline: "NJ PBS" },
      baseVersion: 3,
    })).toBeNull();
    for (const body of [
      { id: "site-brand", values: { headline: "NJ PBS" } },
      {
        id: "site-brand",
        values: { headline: "NJ PBS" },
        createOnly: true,
        baseVersion: 1,
      },
      { id: "site-brand", values: {}, createOnly: false },
      { id: "site-brand", values: {}, baseVersion: "1" },
      { id: "site-brand", values: {}, createOnly: true, version: 1 },
    ]) {
      expect(validateSaveSettingsRequest(body)).not.toBeNull();
    }
  });
});

describe("CMS settings authorization and catalog admission", () => {
  it("rejects an unknown production settings id with zero settings reads", async () => {
    const firestore = {
      collection: vi.fn(),
      runTransaction: vi.fn(),
    };
    const handler = createCmsGetSettingsHandler({
      firestore,
      requirePrincipalFn: vi.fn(async () => actor()),
      log: { error: vi.fn() },
    });

    const res = await call(handler, { id: "any-bounded-id" });

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: "This settings document is not available." });
    expect(firestore.collection).not.toHaveBeenCalled();
    expect(firestore.runTransaction).not.toHaveBeenCalled();
  });

  it("requires global settings.manage before a known settings document read", async () => {
    const firestore = {
      collection: vi.fn(),
      runTransaction: vi.fn(),
    };
    const handler = createCmsGetSettingsHandler({
      firestore,
      requirePrincipalFn: vi.fn(async () => actor([{ role: "editor" }])),
      settingsSchemas: SETTINGS_SCHEMAS,
      log: { error: vi.fn() },
    });

    const res = await call(handler, { id: "site-brand" });

    expect(res.statusCode).toBe(403);
    expect(firestore.collection).not.toHaveBeenCalled();
  });

  it("allows admitted editors to read only a published snapshot and denies identities without a staff grant", async () => {
    const publishedHandler = createCmsGetPublishedSettingsHandler({
      firestore: db,
      requirePrincipalFn: vi.fn(async () => actor([{ role: "editor" }])),
      settingsSchemas: SETTINGS_SCHEMAS,
      log: { error: vi.fn(), warn: vi.fn() },
    });
    await db.collection("cmsSettings").doc("site-brand").set({
      schemaVersion: 2,
      values: { headline: "Private draft", gallery: [] },
      version: 4,
      published: {
        schemaVersion: 2,
        values: { headline: "Published banner", gallery: [] },
        sourceVersion: 2,
        publishedAt: "2026-08-14T15:00:00.000Z",
      },
    });

    const admitted = await call(publishedHandler, { id: "site-brand" });
    expect(admitted.statusCode).toBe(200);
    expect(admitted.body).toEqual({
      success: true,
      found: true,
      id: "site-brand",
      published: {
        schemaVersion: 2,
        values: { headline: "Published banner", gallery: [] },
        sourceVersion: 2,
        publishedAt: "2026-08-14T15:00:00.000Z",
      },
    });
    expect(admitted.body).not.toHaveProperty("settings");
    expect(JSON.stringify(admitted.body)).not.toContain("Private draft");
    expect(admitted.headers.get("cache-control")).toBe("private, no-store");

    for (const grants of [
      [],
      [{ role: "unknown-role" }],
      [{ role: "contributor", sections: [] }],
    ]) {
      const noRecognizedGrant = createCmsGetPublishedSettingsHandler({
        firestore: { collection: vi.fn() },
        requirePrincipalFn: vi.fn(async () => actor(grants)),
        settingsSchemas: SETTINGS_SCHEMAS,
        log: { error: vi.fn(), warn: vi.fn() },
      });
      const denied = await call(noRecognizedGrant, { id: "site-brand" });
      expect(denied.statusCode).toBe(403);
      expect(denied.body.error).toMatch(/CMS access required/i);
    }
  });

  it("requires JSON and a bounded body before any settings read", async () => {
    const firestore = { collection: vi.fn(), runTransaction: vi.fn() };
    const handler = createCmsSaveSettingsHandler({
      firestore,
      requirePrincipalFn: vi.fn(async () => actor()),
      settingsSchemas: SETTINGS_SCHEMAS,
      log: { error: vi.fn() },
    });
    const res = makeRes();

    await handler(makeReq({
      headers: { "content-type": "text/plain" },
      body: { id: "site-brand", values: {}, createOnly: true },
    }), res);

    expect(res.statusCode).toBe(415);
    expect(firestore.collection).not.toHaveBeenCalled();
  });
});

describe("cmsGetNewsroomBanner", () => {
  it("refuses an authenticated account without an admitted CMS role", async () => {
    const firestore = { collection: vi.fn() };
    const handler = createCmsGetNewsroomBannerHandler({
      firestore,
      requirePrincipalFn: vi.fn(async () => actor([])),
      log: { error: vi.fn() },
    });

    const res = await call(handler, {});

    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/CMS access required/i);
    expect(firestore.collection).not.toHaveBeenCalled();
  });

  it("returns the plain-language default to an admitted editor before a setting exists", async () => {
    const document = { exists: false, data: () => undefined };
    const get = vi.fn(async () => document);
    const firestore = {
      collection: vi.fn(() => ({ doc: vi.fn(() => ({ get })) })),
    };
    const handler = createCmsGetNewsroomBannerHandler({
      firestore,
      requirePrincipalFn: vi.fn(async () => actor([{ role: "editor" }])),
      log: { error: vi.fn() },
    });

    const res = await call(handler, {});

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      heading: DEFAULT_NEWSROOM_BANNER_HEADING,
      milestoneNumber: 16,
      source: "default",
      version: null,
    });
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-njpbs-cms-settings-contract"))
      .toBe("newsroom-milestone-v1");
  });

  it("returns only the saved banner heading from the admitted settings document", async () => {
    await db.collection("cmsSettings").doc("newsroom-home").set({
      schemaVersion: 1,
      values: { bannerHeading: "Preparing the newsroom publishing workflow" },
      version: 3,
    });
    const handler = createCmsGetNewsroomBannerHandler({
      firestore: db,
      requirePrincipalFn: vi.fn(async () => actor([{ role: "contributor" }])),
      log: { error: vi.fn() },
    });

    const res = await call(handler, {});

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      heading: "Preparing the newsroom publishing workflow",
      milestoneNumber: 16,
      source: "saved",
      version: 3,
    });
  });

  it("returns the saved current milestone with the banner heading", async () => {
    await db.collection("cmsSettings").doc("newsroom-home").set({
      schemaVersion: 1,
      values: { bannerHeading: "Publishing work" },
      version: 2,
    });
    await db.collection("cmsSettings").doc("newsroom-milestone").set({
      schemaVersion: 1,
      values: { milestoneNumber: 6 },
      version: 1,
    });
    const handler = createCmsGetNewsroomBannerHandler({
      firestore: db,
      requirePrincipalFn: vi.fn(async () => actor([{ role: "editor" }])),
      log: { error: vi.fn() },
    });

    const res = await call(handler, {});

    expect(res.body).toMatchObject({
      heading: "Publishing work",
      milestoneNumber: 6,
    });
  });
});

describe("cmsGetSettings", () => {
  it("inspects an exact historical working document without migrating it", async () => {
    const historical = {
      schemaVersion: 1,
      values: { headline: "Legacy NJ PBS" },
      version: 4,
    };
    await db.collection("cmsSettings").doc("site-brand").set(historical);
    const handler = createCmsGetSettingsHandler(handlerDeps());

    const res = await call(handler, { id: "site-brand" });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      found: true,
      id: "site-brand",
      settings: historical,
    });
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("rejects an inexact stored document", async () => {
    await db.collection("cmsSettings").doc("site-brand").set({
      schemaVersion: 2,
      values: { headline: "NJ PBS" },
      version: 1,
      privateField: "must not escape",
    });
    const handler = createCmsGetSettingsHandler(handlerDeps());

    const res = await call(handler, { id: "site-brand" });

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/invalid/i);
  });
});

describe("cmsGetPublishedSettings", () => {
  it("serves the admitted newsroom banner through draft, publish, and published-only reads", async () => {
    const productionDeps = {
      firestore: db,
      requirePrincipalFn: async () => actor(),
      now: () => "2026-08-14T15:00:00.000Z",
      log: { error: vi.fn(), warn: vi.fn() },
    };
    const values = {
      bannerHeading: "Morning assignment update",
    };

    const saved = await call(
      createCmsSaveSettingsHandler(productionDeps),
      { id: "newsroom-home", values, createOnly: true },
    );
    expect(saved.statusCode).toBe(200);
    expect(saved.body).toMatchObject({
      success: true,
      changed: true,
      id: "newsroom-home",
      settings: { schemaVersion: 1, values, version: 1 },
    });

    const published = await call(
      createCmsPublishSettingsHandler(productionDeps),
      { id: "newsroom-home", baseVersion: 1 },
    );
    expect(published.statusCode).toBe(200);
    expect(published.body.settings.published).toEqual({
      schemaVersion: 1,
      values,
      sourceVersion: 1,
      publishedAt: "2026-08-14T15:00:00.000Z",
    });

    const read = await call(
      createCmsGetPublishedSettingsHandler({
        ...productionDeps,
        requirePrincipalFn: async () => actor([{ role: "contributor" }]),
      }),
      { id: "newsroom-home" },
    );
    expect(read.statusCode).toBe(200);
    expect(read.body).toEqual({
      success: true,
      found: true,
      id: "newsroom-home",
      published: published.body.settings.published,
    });
    expect(read.body).not.toHaveProperty("settings");
  });

  it("returns found false for a missing or unpublished document without exposing working values", async () => {
    const handler = createCmsGetPublishedSettingsHandler(handlerDeps({
      requirePrincipalFn: async () => actor([{ role: "contributor" }]),
    }));

    const missing = await call(handler, { id: "site-brand" });
    expect(missing.statusCode).toBe(200);
    expect(missing.body).toEqual({ success: true, found: false, id: "site-brand" });

    await db.collection("cmsSettings").doc("site-brand").set({
      schemaVersion: 2,
      values: { headline: "Working only", gallery: [] },
      version: 1,
    });
    const unpublished = await call(handler, { id: "site-brand" });
    expect(unpublished.statusCode).toBe(200);
    expect(unpublished.body).toEqual({ success: true, found: false, id: "site-brand" });
    expect(JSON.stringify(unpublished.body)).not.toContain("Working only");
  });

  it("fails safely to found false for an invalid published snapshot", async () => {
    const log = { error: vi.fn(), warn: vi.fn() };
    await db.collection("cmsSettings").doc("site-brand").set({
      schemaVersion: 2,
      values: { headline: "Private draft", gallery: [] },
      version: 2,
      published: {
        schemaVersion: 2,
        values: { headline: "Unsafe snapshot", gallery: [], extra: "private" },
        sourceVersion: 1,
        publishedAt: "2026-08-14T15:00:00.000Z",
      },
    });
    const handler = createCmsGetPublishedSettingsHandler(handlerDeps({
      requirePrincipalFn: async () => actor([{ role: "editor" }]),
      log,
    }));

    const res = await call(handler, { id: "site-brand" });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, found: false, id: "site-brand" });
    expect(log.warn).toHaveBeenCalledWith(
      "cmsGetPublishedSettings ignored an invalid snapshot",
      expect.objectContaining({ id: "site-brand" }),
    );
  });
});

describe.each([
  ["demoted", { role: "staff", active: true }],
  ["inactive", { role: "admin", active: false }],
  ["deleted", null],
])("settings transactions for a %s administrator", (_state, profile) => {
  it.each(["create", "update", "unchanged save", "publish", "unchanged publish"])(
    "refuses %s after admission without changing settings, media usage or audit records",
    async (operation) => {
      const values = { headline: "NJ PBS", gallery: [] };
      const before = operation === "create" ? null : {
        schemaVersion: 2,
        values,
        version: 2,
        ...(operation === "unchanged publish" ? {
          published: {
            schemaVersion: 2,
            values,
            sourceVersion: 1,
            publishedAt: "2026-08-14T15:00:00.000Z",
          },
        } : {}),
      };
      const settingsRef = db.collection("cmsSettings").doc("site-brand");
      if (before) await settingsRef.set(before);
      const firestore = {
        collection: (name) => db.collection(name),
        runTransaction: async (callback) => {
          // Revoke at the database boundary after the request's admission check.
          const userRef = db.collection("users").doc("admin-1");
          if (profile) await userRef.set(profile);
          else await userRef.delete();
          return db.runTransaction(callback);
        },
      };
      const publishing = operation.includes("publish");
      const handler = (publishing
        ? createCmsPublishSettingsHandler
        : createCmsSaveSettingsHandler)(handlerDeps({ firestore }));
      const body = {
        id: "site-brand",
        ...(operation === "create" ? { createOnly: true } : { baseVersion: 2 }),
        ...(!publishing ? {
          values: operation === "unchanged save" ? values : {
            ...values,
            headline: "Changed NJ PBS",
          },
        } : {}),
      };

      const res = await call(handler, body);

      expect(res.statusCode).toBe(403);
      expect(res.body).toEqual({ error: "You do not have permission to manage settings." });
      const after = await settingsRef.get();
      expect(after.exists).toBe(before !== null);
      expect(after.data()).toEqual(before ?? undefined);
      expect((await settingsRef.collection("mediaUsage").get()).empty).toBe(true);
      expect(await docsIn("cmsVersionHistory")).toEqual([]);
      expect(await docsIn("admin_logs")).toEqual([]);
    },
  );
});

describe("cmsSaveSettings", () => {
  it("creates a current settings document, working usage, full revision, and compact audit atomically", async () => {
    const handler = createCmsSaveSettingsHandler(handlerDeps());

    const res = await call(handler, {
      id: "site-brand",
      values: { headline: "NJ PBS", gallery: [] },
      createOnly: true,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      changed: true,
      id: "site-brand",
      settings: {
        schemaVersion: 2,
        values: { headline: "NJ PBS", gallery: [] },
        version: 1,
      },
    });
    expect((await db.collection("cmsSettings").doc("site-brand").get()).data())
      .toEqual(res.body.settings);
    expect((await db.doc("cmsSettings/site-brand/mediaUsage/working").get()).data())
      .toEqual({
        state: "working",
        sourceVersion: 1,
        assetIds: [],
        occurrenceCount: 0,
      });
    const audits = await docsIn("admin_logs");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorUid: "admin-1",
      action: "cms.settings.save",
      target: "cmsSettings/site-brand",
      before: null,
      after: {
        schemaVersion: 2,
        version: 1,
        publishedSourceVersion: null,
      },
    });
    expect(audits[0].after.valuesSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(audits[0].after).not.toHaveProperty("values");
    const revisions = await docsIn("cmsVersionHistory");
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      collection: "cmsSettings",
      documentId: "site-brand",
      action: "create",
      before: null,
      after: res.body.settings,
      userId: "admin-1",
    });
  });

  it("preserves the detached published snapshot and advances only the working version", async () => {
    const published = {
      schemaVersion: 2,
      values: { headline: "Published NJ PBS", gallery: [] },
      sourceVersion: 1,
      publishedAt: "2026-08-14T14:00:00.000Z",
    };
    await db.collection("cmsSettings").doc("site-brand").set({
      schemaVersion: 2,
      values: { headline: "Published NJ PBS", gallery: [] },
      version: 2,
      published,
    });
    const handler = createCmsSaveSettingsHandler(handlerDeps());

    const res = await call(handler, {
      id: "site-brand",
      values: { headline: "Working NJ PBS", gallery: [] },
      baseVersion: 2,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.settings).toEqual({
      schemaVersion: 2,
      values: { headline: "Working NJ PBS", gallery: [] },
      version: 3,
      published,
    });
    const revisions = await docsIn("cmsVersionHistory");
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      collection: "cmsSettings",
      documentId: "site-brand",
      action: "update",
      before: {
        schemaVersion: 2,
        values: { headline: "Published NJ PBS", gallery: [] },
        version: 2,
        published,
      },
      after: res.body.settings,
    });
  });

  it("rejects historical working schema writes and stale versions", async () => {
    await db.collection("cmsSettings").doc("site-brand").set({
      schemaVersion: 1,
      values: { headline: "Legacy NJ PBS" },
      version: 4,
    });
    const handler = createCmsSaveSettingsHandler(handlerDeps());

    const historical = await call(handler, {
      id: "site-brand",
      values: { headline: "Still legacy" },
      baseVersion: 4,
    });
    expect(historical.statusCode).toBe(409);
    expect(historical.body.error).toMatch(/migration/i);

    await db.collection("cmsSettings").doc("site-brand").set({
      schemaVersion: 2,
      values: { headline: "NJ PBS", gallery: [] },
      version: 5,
    });
    const stale = await call(handler, {
      id: "site-brand",
      values: { headline: "Changed", gallery: [] },
      baseVersion: 4,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.body.error).toMatch(/changed since/i);
  });

  it("returns changed false with no usage, settings, or audit write for identical values", async () => {
    const stored = {
      schemaVersion: 2,
      values: { headline: "NJ PBS", gallery: [] },
      version: 7,
    };
    const harness = noWriteHarness(stored);
    const prepareMediaUsageWriteFn = vi.fn();
    const adminLogEntryFn = vi.fn();
    const versionHistoryEntryFn = vi.fn();
    const handler = createCmsSaveSettingsHandler(handlerDeps({
      firestore: harness.firestore,
      prepareMediaUsageWriteFn,
      adminLogEntryFn,
      versionHistoryEntryFn,
    }));

    const res = await call(handler, {
      id: "site-brand",
      values: { headline: "NJ PBS", gallery: [] },
      baseVersion: 7,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ changed: false, settings: stored });
    expect(prepareMediaUsageWriteFn).not.toHaveBeenCalled();
    expect(adminLogEntryFn).not.toHaveBeenCalled();
    expect(versionHistoryEntryFn).not.toHaveBeenCalled();
    expect(harness.transaction.set).not.toHaveBeenCalled();
  });

  it("checks the complete document size before preparing any write", async () => {
    const harness = noWriteHarness(undefined);
    const prepareMediaUsageWriteFn = vi.fn();
    const handler = createCmsSaveSettingsHandler(handlerDeps({
      firestore: harness.firestore,
      prepareMediaUsageWriteFn,
      firestoreDocumentBytesFn: () => 1_000_000,
    }));

    const res = await call(handler, {
      id: "site-brand",
      values: { headline: "NJ PBS", gallery: [] },
      createOnly: true,
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/too large/i);
    expect(prepareMediaUsageWriteFn).not.toHaveBeenCalled();
    expect(harness.transaction.set).not.toHaveBeenCalled();
  });

  it("checks the full version-history row before preparing any write", async () => {
    const harness = noWriteHarness(undefined);
    const prepareMediaUsageWriteFn = vi.fn();
    const handler = createCmsSaveSettingsHandler(handlerDeps({
      firestore: harness.firestore,
      prepareMediaUsageWriteFn,
      firestoreDocumentBytesFn: (_document, path) =>
        path.startsWith("cmsVersionHistory/") ? 1_000_000 : 100,
    }));

    const res = await call(handler, {
      id: "site-brand",
      values: { headline: "NJ PBS", gallery: [] },
      createOnly: true,
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/revision is too large/i);
    expect(prepareMediaUsageWriteFn).not.toHaveBeenCalled();
    expect(harness.transaction.set).not.toHaveBeenCalled();
  });
});

describe("cmsPublishSettings", () => {
  it("limits the deployed publish path to the public homepage banner", async () => {
    const harness = noWriteHarness({
      schemaVersion: 2,
      values: { headline: "NJ PBS", gallery: [] },
      version: 1,
    });
    const handler = createCmsPublishSettingsHandler(handlerDeps({
      firestore: harness.firestore,
      publishableSettingsIds: new Set(["public-homepage-banner"]),
    }));

    const res = await call(handler, { id: "site-brand", baseVersion: 1 });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/cannot be published/i);
    expect(harness.transaction.get).not.toHaveBeenCalled();
    expect(harness.transaction.set).not.toHaveBeenCalled();
  });

  it("preserves working values and atomically creates a detached snapshot, published usage, and audit", async () => {
    const asset = activeSeedAsset();
    await Promise.all([
      db.collection("media_assets").doc("asset-one").set(asset),
      db.collection("media_assets_public").doc("asset-one").set(mediaProjection(asset)),
      db.collection("cmsSettings").doc("site-brand").set({
        schemaVersion: 2,
        values: {
          headline: "NJ PBS",
          hero: "asset-one",
          gallery: ["asset-one"],
        },
        version: 1,
      }),
    ]);
    const handler = createCmsPublishSettingsHandler(handlerDeps());

    const res = await call(handler, { id: "site-brand", baseVersion: 1 });

    expect(res.statusCode).toBe(200);
    expect(res.headers.get("x-njpbs-cms-settings-contract"))
      .toBe("newsroom-milestone-v1");
    expect(res.body.settings).toEqual({
      schemaVersion: 2,
      values: {
        headline: "NJ PBS",
        hero: "asset-one",
        gallery: ["asset-one"],
      },
      version: 2,
      published: {
        schemaVersion: 2,
        values: {
          headline: "NJ PBS",
          hero: "asset-one",
          gallery: ["asset-one"],
        },
        sourceVersion: 1,
        publishedAt: "2026-08-14T15:00:00.000Z",
      },
    });
    expect((await db.doc("cmsSettings/site-brand/mediaUsage/published").get()).data())
      .toEqual({
        state: "published",
        sourceVersion: 1,
        assetIds: ["asset-one"],
        occurrenceCount: 2,
      });
    const audits = await docsIn("admin_logs");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "cms.settings.publish",
      before: {
        schemaVersion: 2,
        version: 1,
        publishedSourceVersion: null,
      },
      after: {
        schemaVersion: 2,
        version: 2,
        publishedSourceVersion: 1,
      },
    });
    const revisions = await docsIn("cmsVersionHistory");
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      collection: "cmsSettings",
      documentId: "site-brand",
      action: "publish",
      before: {
        schemaVersion: 2,
        values: {
          headline: "NJ PBS",
          hero: "asset-one",
          gallery: ["asset-one"],
        },
        version: 1,
      },
      after: res.body.settings,
    });
  });

  it("does not change the detached snapshot while admission is paused", async () => {
    const before = {
      schemaVersion: 2,
      values: { headline: "NJ PBS", gallery: [] },
      version: 1,
    };
    await Promise.all([
      db.collection("cmsSettings").doc("site-brand").set(before),
      db.collection("system").doc("cmsPublicationRuntime").set({
        schemaVersion: 1,
        phase: "paused",
        commitSha: "a".repeat(40),
        serializerId: "cloud-publication-primary",
      }),
    ]);
    const handler = createCmsPublishSettingsHandler(handlerDeps());

    const res = await call(handler, { id: "site-brand", baseVersion: 1 });

    expect(res.statusCode).toBe(503);
    expect(res.body.error).toMatch(/failed to manage CMS settings/i);
    expect((await db.collection("cmsSettings").doc("site-brand").get()).data())
      .toEqual(before);
    expect(await docsIn("cmsVersionHistory")).toHaveLength(0);
    expect(await docsIn("admin_logs")).toHaveLength(0);
  });

  it("returns changed false with zero writes for the current detached snapshot", async () => {
    const stored = {
      schemaVersion: 2,
      values: { headline: "NJ PBS", gallery: [] },
      version: 2,
      published: {
        schemaVersion: 2,
        values: { headline: "NJ PBS", gallery: [] },
        sourceVersion: 1,
        publishedAt: "2026-08-14T15:00:00.000Z",
      },
    };
    const harness = noWriteHarness(stored);
    const prepareMediaUsageWriteFn = vi.fn();
    const adminLogEntryFn = vi.fn();
    const versionHistoryEntryFn = vi.fn();
    const handler = createCmsPublishSettingsHandler(handlerDeps({
      firestore: harness.firestore,
      prepareMediaUsageWriteFn,
      adminLogEntryFn,
      versionHistoryEntryFn,
    }));

    const res = await call(handler, { id: "site-brand", baseVersion: 2 });

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ changed: false, settings: stored });
    expect(prepareMediaUsageWriteFn).not.toHaveBeenCalled();
    expect(adminLogEntryFn).not.toHaveBeenCalled();
    expect(versionHistoryEntryFn).not.toHaveBeenCalled();
    expect(harness.transaction.set).not.toHaveBeenCalled();
  });

  it("rejects an older working schema and a non-seed media reference", async () => {
    const handler = createCmsPublishSettingsHandler(handlerDeps());
    await db.collection("cmsSettings").doc("site-brand").set({
      schemaVersion: 1,
      values: { headline: "Legacy NJ PBS" },
      version: 3,
    });

    const historical = await call(handler, { id: "site-brand", baseVersion: 3 });
    expect(historical.statusCode).toBe(409);
    expect(historical.body.error).toMatch(/migration/i);

    const uploaded = activeSeedAsset({ source: "upload" });
    await Promise.all([
      db.collection("media_assets").doc("asset-one").set(uploaded),
      db.collection("media_assets_public").doc("asset-one").set(mediaProjection(uploaded)),
      db.collection("cmsSettings").doc("site-brand").set({
        schemaVersion: 2,
        values: { headline: "NJ PBS", hero: "asset-one", gallery: [] },
        version: 4,
      }),
    ]);

    const blocked = await call(handler, { id: "site-brand", baseVersion: 4 });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.body.error).toMatch(/public deployment coordination/i);
    expect((await db.collection("cmsSettings").doc("site-brand").get()).data())
      .not.toHaveProperty("published");
  });
});

describe("site navigation settings", () => {
  beforeEach(async () => {
    // Public settings now require the same exact cloud release and initialized
    // context as their atomic publication queue. Draft-only and private schemas
    // still exercise their original authorization and version contracts.
    await db.doc("system/publicDeployment").set({ schemaVersion: 1, state: "idle", mediaLifecycleReady: true,
      activeGeneration: 1, activeDeploymentId: "fixture-deployment", activeCommitSha: "a".repeat(40),
      lastReservedGeneration: 1, newestEligibleGeneration: 1, newestEligibleBuildBatchId: "fixture-build" });
    await db.doc("system/publicDeployment/contexts/public").set({ schemaVersion: 1, revision: 1 });
    await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: "ready",
      commitSha: "a".repeat(40), serializerId: "node-compute",
      cloud: { phase: "ready", commitSha: "a".repeat(40), serializerId: "cloudflare-publisher" } });
  });

  const PRODUCTION_PUBLISHABLE = new Set(["public-homepage-banner", "site-navigation"]);
  const seed = () => JSON.parse(JSON.stringify(DEFAULT_SITE_NAVIGATION));

  it("publishes a stored v1 CTA draft and upgrades it on its next save without changing its public rules", async () => {
    const ref = db.collection("cmsSettings").doc("story-ctas");
    await ref.set({ schemaVersion: 1, values: { rules: [] }, version: 4 });
    const deps = handlerDeps({ settingsSchemas: undefined, publishableSettingsIds: new Set(["story-ctas"]) });
    const published = await call(createCmsPublishSettingsHandler(deps), { id: "story-ctas", baseVersion: 4, publicationTransport: "public-context-no-build-v1" });
    expect(published.statusCode).toBe(200);
    expect(published.body.settings.published).toMatchObject({ schemaVersion: 1, sourceVersion: 4, values: { rules: [] } });
    const saved = await call(createCmsSaveSettingsHandler(deps), { id: "story-ctas", baseVersion: 5, values: { rules: [] } });
    expect(saved.statusCode).toBe(200);
    expect(saved.body.settings).toEqual({ schemaVersion: 2, version: 6, values: { rules: [] }, published: published.body.settings.published });
  });

  it("upgrades a v1 draft without changing its publication and rejects old-client omission of browsing", async () => {
    const values = seed();
    const published = { schemaVersion: 1, values, sourceVersion: 3, publishedAt: "2026-09-25T14:00:00.000Z" };
    const ref = db.collection("cmsSettings").doc("site-navigation");
    await ref.set({ schemaVersion: 1, values, version: 4, published });
    const save = createCmsSaveSettingsHandler(handlerDeps({ settingsSchemas: undefined }));
    const arranged = { ...values, postsBrowse: { groups: [{ id: "schools", label: "Schools", icon: "heart", terms: [{ filter: "category", value: "Education" }] }] } };
    const upgraded = await call(save, { id: "site-navigation", values: arranged, baseVersion: 4 });
    expect(upgraded.statusCode).toBe(200);
    expect(upgraded.body.settings).toEqual({ schemaVersion: 2, values: arranged, version: 5, published });
    const stale = await call(save, { id: "site-navigation", values: arranged, baseVersion: 4 });
    expect(stale.statusCode).toBe(409);
    const omitted = await call(save, { id: "site-navigation", values, baseVersion: 5 });
    expect(omitted.statusCode).toBe(409);
    expect(omitted.body.error).toMatch(/Posts browsing/);
    expect((await ref.get()).data()).toEqual(upgraded.body.settings);
  });

  it("saves a draft, publishes it through the production path, and audits each change", async () => {
    const save = createCmsSaveSettingsHandler(handlerDeps({ settingsSchemas: undefined }));
    const publish = createCmsPublishSettingsHandler(handlerDeps({
      settingsSchemas: undefined,
      publishableSettingsIds: PRODUCTION_PUBLISHABLE,
    }));

    const created = await call(save, { id: "site-navigation", values: seed(), createOnly: true });
    expect(created.statusCode).toBe(200);
    expect(created.body.settings).toMatchObject({ schemaVersion: 2, version: 1 });

    const values = seed();
    const about = values.footer.find(({ id }) => id === "about");
    const contact = about.links.find(({ id }) => id === "contact");
    about.links = about.links.filter(({ id }) => id !== "contact");
    values.footer[0].links.unshift({ ...contact, label: "Contact us" });
    const changed = await call(save, { id: "site-navigation", values, baseVersion: 1 });
    expect(changed.statusCode).toBe(200);
    expect(changed.body).toMatchObject({ changed: true, settings: { version: 2 } });

    const unchanged = await call(save, { id: "site-navigation", values, baseVersion: 2 });
    expect(unchanged.body).toMatchObject({ changed: false });

    const published = await call(publish, { id: "site-navigation", baseVersion: 2, publicationTransport: "public-context-no-build-v1" });
    expect(published.statusCode).toBe(200);
    expect(published.body.settings.published).toEqual({
      schemaVersion: 2,
      values,
      sourceVersion: 2,
      publishedAt: "2026-08-14T15:00:00.000Z",
    });

    const audits = (await docsIn("admin_logs"))
      .map(({ action, target }) => [action, target])
      .sort();
    expect(audits).toEqual([
      ["cms.settings.publish", "cmsSettings/site-navigation"],
      ["cms.settings.save", "cmsSettings/site-navigation"],
      ["cms.settings.save", "cmsSettings/site-navigation"],
    ]);
  });

  it.each([false, true])("lets staff correct duplicate stored headings (published: %s)", async (withPublished) => {
    const values = seed();
    values.footer[1].heading = "  WATCH  ";
    const stored = { schemaVersion: 1, values, version: 4 };
    if (withPublished) {
      stored.published = {
        schemaVersion: 1, values, sourceVersion: 4,
        publishedAt: "2026-09-25T14:00:00.000Z",
      };
    }
    const ref = db.collection("cmsSettings").doc("site-navigation");
    await ref.set(stored);
    const deps = handlerDeps({ settingsSchemas: undefined });
    const read = await call(createCmsGetSettingsHandler(deps), { id: "site-navigation" });
    expect(read.statusCode).toBe(200);
    expect(read.body.settings).toEqual(stored);

    const publish = createCmsPublishSettingsHandler(deps);
    const rejected = await call(publish, { id: "site-navigation", baseVersion: 4, publicationTransport: "public-context-no-build-v1" });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.body.error).toMatch(/heading must be unique/);
    const save = createCmsSaveSettingsHandler(deps);
    expect((await call(save, { id: "site-navigation", values, baseVersion: 4 })).statusCode).toBe(400);
    expect((await ref.get()).data()).toEqual(stored);
    expect(await docsIn("admin_logs")).toEqual([]);

    const corrected = seed();
    const stale = await call(save, { id: "site-navigation", values: corrected, baseVersion: 3 });
    expect(stale.statusCode).toBe(409);
    const saved = await call(save, { id: "site-navigation", values: corrected, baseVersion: 4 });
    expect(saved.statusCode).toBe(200);
    expect(saved.body.settings).toEqual({ ...stored, schemaVersion: 2, version: 5, values: corrected });
    expect((await ref.get()).data()).toEqual(saved.body.settings);

    const published = await call(publish, { id: "site-navigation", baseVersion: 5, publicationTransport: "public-context-no-build-v1" });
    expect(published.statusCode).toBe(200);
    expect(published.body.settings.published).toMatchObject({ sourceVersion: 5, values: corrected });
    const history = await docsIn("cmsVersionHistory");
    expect(history).toHaveLength(2);
    expect((await docsIn("admin_logs")).map(({ action }) => action).sort())
      .toEqual(["cms.settings.publish", "cms.settings.save"]);
  });

  it.each(["values", "published"])("keeps unsafe stored %s blocked even with duplicate headings", async (location) => {
    const values = seed();
    values.footer[1].heading = "watch";
    values.footer[1].links[0].target = { type: "href", href: "javascript:alert(1)" };
    const stored = {
      schemaVersion: 1, version: 4,
      values: location === "values" ? values : seed(),
      ...(location === "published" ? { published: {
        schemaVersion: 1, values, sourceVersion: 3, publishedAt: "2026-09-25T14:00:00.000Z",
      } } : {}),
    };
    const ref = db.collection("cmsSettings").doc("site-navigation");
    await ref.set(stored);
    const deps = handlerDeps({ settingsSchemas: undefined });
    expect((await call(createCmsGetSettingsHandler(deps), { id: "site-navigation" })).statusCode).toBe(409);
    expect((await call(createCmsSaveSettingsHandler(deps), {
      id: "site-navigation", values: seed(), baseVersion: 4,
    })).statusCode).toBe(409);
    expect((await ref.get()).data()).toEqual(stored);
    expect(await docsIn("admin_logs")).toEqual([]);
  });

  it("normalizes stale internal new-tab flags on create and on an otherwise unchanged save", async () => {
    const save = createCmsSaveSettingsHandler(handlerDeps({ settingsSchemas: undefined }));
    const values = seed();
    values.header[0].external = true;
    values.footer[0].links[0].external = true;
    const created = await call(save, { id: "site-navigation", values, createOnly: true });
    expect(created.statusCode).toBe(200);
    const ref = db.collection("cmsSettings").doc("site-navigation");
    const normalized = (await ref.get()).data().values;
    expect(normalized.header[0].external).toBe(false);
    expect(normalized.footer[0].links[0].external).toBe(false);
    expect(normalized.header[1].external).toBe(true);

    await ref.set({ schemaVersion: 1, values, version: 2 });
    const saved = await call(save, { id: "site-navigation", values: normalized, baseVersion: 2 });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).toMatchObject({ changed: true, settings: { version: 3, values: normalized } });
    expect((await ref.get()).data().values).toEqual(normalized);
    const unchanged = await call(save, { id: "site-navigation", values, baseVersion: 3 });
    expect(unchanged.body.changed).toBe(false);
  });

  it("rejects a draft that removes or retargets the contact link with no write", async () => {
    const save = createCmsSaveSettingsHandler(handlerDeps({ settingsSchemas: undefined }));
    const removed = seed();
    const about = removed.footer.find(({ id }) => id === "about");
    about.links = about.links.filter(({ id }) => id !== "contact");
    const retargeted = seed();
    retargeted.footer.find(({ id }) => id === "about").links
      .find(({ id }) => id === "contact").target = { type: "href", href: "https://example.org/" };
    const unsafe = seed();
    unsafe.header[0].target = { type: "href", href: "javascript:alert(1)" };

    for (const [values, message] of [
      [removed, /must keep the contact link/],
      [retargeted, /cannot change its target/],
      [unsafe, /safe link/],
    ]) {
      const res = await call(save, { id: "site-navigation", values, createOnly: true });
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toMatch(message);
    }
    expect(await docsIn("cmsSettings")).toEqual([]);
    expect(await docsIn("admin_logs")).toEqual([]);
  });

  it("refuses navigation saves and publishes without settings.manage", async () => {
    const deps = handlerDeps({
      settingsSchemas: undefined,
      requirePrincipalFn: async () => actor([{ role: "editor" }]),
      publishableSettingsIds: PRODUCTION_PUBLISHABLE,
    });
    const saved = await call(createCmsSaveSettingsHandler(deps), {
      id: "site-navigation",
      values: seed(),
      createOnly: true,
    });
    const published = await call(createCmsPublishSettingsHandler(deps), {
      id: "site-navigation",
      publicationTransport: "public-context-no-build-v1",
      baseVersion: 1,
    });
    expect(saved.statusCode).toBe(403);
    expect(published.statusCode).toBe(403);
    expect(await docsIn("cmsSettings")).toEqual([]);
  });
});

// The exported Functions endpoints must identify the settings contract even when
// real emulator Auth refuses the token, before any stored-setting access.
it("returns the settings receipt on invalid-token HTTP responses from every exported settings endpoint", async () => {
  const host = process.env.FUNCTIONS_EMULATOR_HOST || "127.0.0.1:5001";
  if (!/^127\.0\.0\.1:\d+$/.test(host)) throw new Error("Use the local Functions emulator");
  for (const name of ["cmsGetNewsroomBanner", "cmsGetSettings", "cmsSaveSettings", "cmsPublishSettings"]) {
    const response = await fetch(`http://${host}/${PROJECT}/us-central1/${name}`, {
      method: "POST", headers: { authorization: "Bearer invalid-token", "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status, name).toBe(401);
    expect(response.headers.get("x-njpbs-cms-settings-contract"), name).toBe("newsroom-milestone-v1");
  }
});
