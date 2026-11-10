import { describe, expect, it, vi } from "vitest";
import settingsContract from "../../functions/lib/cms-settings-contract.js";
import settingsHandlers from "../../functions/settings.js";

const {
  CMS_SETTINGS_SCHEMAS,
  DEFAULT_NJ_DECIDES_SETTINGS,
  DEFAULT_PUBLIC_HOMEPAGE_BANNER_SETTINGS,
  MAX_CMS_SETTINGS_ASSET_LIST_ITEMS,
  MAX_CMS_SETTINGS_FIELD_NAME_BYTES,
  MAX_CMS_SETTINGS_FIELDS,
  MAX_CMS_SETTINGS_STRING_BYTES,
  MAX_CMS_SETTINGS_VALUES_JSON_BYTES,
  NJ_DECIDES_SETTINGS_ID,
  PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
  CmsSettingsContractError,
  cmsSettingsSchemaFor,
  collectCmsSettingsAssetOccurrences,
  createCmsSettingsPublishedSnapshot,
  currentCmsSettingsSchemaFor,
  projectPublishedCmsSettings,
  validateCmsSettingsValues,
} = settingsContract;
const {
  createCmsSaveSettingsHandler,
  isPublicHomepageBannerUpgrade,
  settingsSchemaForPublication,
  validateNjDecidesMediaAssets,
} = settingsHandlers;

const SCHEMA_V1 = Object.freeze({
  schemaVersion: 1,
  fields: Object.freeze({
    enabled: Object.freeze({ kind: "boolean", required: true }),
    message: Object.freeze({ kind: "string", required: true, maxBytes: 120 }),
    heroAssetId: Object.freeze({ kind: "assetId" }),
    galleryAssetIds: Object.freeze({ kind: "assetIdList", maxItems: 200 }),
  }),
});

const SCHEMA_V2 = Object.freeze({
  schemaVersion: 2,
  fields: Object.freeze({
    enabled: Object.freeze({ kind: "boolean", required: true }),
    message: Object.freeze({ kind: "string", required: true, maxBytes: 120 }),
    audience: Object.freeze({ kind: "string", required: true, maxBytes: 40 }),
    heroAssetId: Object.freeze({ kind: "assetId" }),
    galleryAssetIds: Object.freeze({ kind: "assetIdList", maxItems: 200 }),
  }),
});

const FIXTURE_CATALOG = Object.freeze({
  "fixture-settings": Object.freeze({
    currentVersion: 2,
    versions: Object.freeze({ 1: SCHEMA_V1, 2: SCHEMA_V2 }),
  }),
});

const valuesV1 = (overrides = {}) => ({
  enabled: true,
  message: "The station is live.",
  heroAssetId: "asset-hero",
  galleryAssetIds: ["asset-one", "asset-one", "asset-two"],
  ...overrides,
});

const valuesV2 = (overrides = {}) => ({
  ...valuesV1(),
  audience: "all",
  ...overrides,
});

describe("CMS settings contract", () => {
  it("admits the newsroom home settings and resolves exact schema versions", () => {
    expect(CMS_SETTINGS_SCHEMAS).toEqual({
      "coverage-labels": { currentVersion: 1, versions: { 1: { schemaVersion: 1, fields: { labels: { kind: "coverageLabels", required: true } } } } },
      "newsroom-home": {
        currentVersion: 1,
        versions: {
          1: {
            schemaVersion: 1,
            fields: {
              bannerHeading: {
                kind: "string",
                required: true,
                maxBytes: 160,
              },
            },
          },
        },
      },
      "newsroom-milestone": {
        currentVersion: 1,
        versions: {
          1: {
            schemaVersion: 1,
            fields: {
              milestoneNumber: {
                kind: "integer",
                required: true,
                minimum: 1,
                maximum: 10_000,
              },
            },
          },
        },
      },
      "nj-decides-brand": {
        currentVersion: 1,
        versions: {
          1: {
            schemaVersion: 1,
            valueContract: "njDecidesBrandV1",
            fields: {
              backgroundColor: {
                kind: "string",
                required: true,
                maxBytes: 7,
                format: "hexColor",
              },
              textColor: {
                kind: "string",
                required: true,
                maxBytes: 7,
                format: "hexColor",
              },
              linkColor: {
                kind: "string",
                required: true,
                maxBytes: 7,
                format: "hexColor",
              },
              ruleColor: {
                kind: "string",
                required: true,
                maxBytes: 7,
                format: "hexColor",
              },
              accentColor: {
                kind: "string",
                required: true,
                maxBytes: 7,
                format: "hexColor",
              },
              flagEnabled: { kind: "boolean", required: true },
              logoAssetId: { kind: "assetId" },
              logoAlt: { kind: "string", maxBytes: 500 },
              backgroundAssetId: { kind: "assetId" },
            },
          },
        },
      },
      "public-homepage-banner": {
        currentVersion: 4,
        versions: {
          1: {
            schemaVersion: 1,
            fields: {
              enabled: { kind: "boolean", required: true },
              message: { kind: "string", required: true, maxBytes: 240 },
              linkLabel: {
                kind: "string",
                maxBytes: 80,
                pairedWith: "linkHref",
              },
              linkHref: {
                kind: "safeHref",
                maxBytes: 2_048,
                pairedWith: "linkLabel",
              },
            },
          },
          2: {
            schemaVersion: 2,
            valueContract: "publicHomepageBannerV2",
            fields: {
              enabled: { kind: "boolean", required: true },
              message: {
                kind: "string",
                required: true,
                allowEmpty: true,
                maxBytes: 240,
              },
              linkLabel: {
                kind: "string",
                maxBytes: 80,
                pairedWith: "linkHref",
              },
              linkHref: {
                kind: "safeHref",
                maxBytes: 2_048,
                pairedWith: "linkLabel",
              },
              njDecides: { kind: "boolean" },
              liveLabel: { kind: "string", maxBytes: 24 },
              startsAt: {
                kind: "string",
                maxBytes: 64,
                format: "canonicalUtcInstant",
              },
              endsAt: {
                kind: "string",
                maxBytes: 64,
                format: "canonicalUtcInstant",
              },
            },
          },
          3: {
            schemaVersion: 3,
            valueContract: "publicHomepageBannerV2",
            fields: {
              enabled: { kind: "boolean", required: true },
              message: {
                kind: "string",
                required: true,
                allowEmpty: true,
                maxBytes: 240,
              },
              linkLabel: {
                kind: "string",
                maxBytes: 80,
                pairedWith: "linkHref",
              },
              linkHref: {
                kind: "safeHref",
                maxBytes: 2_048,
                pairedWith: "linkLabel",
              },
              njDecides: { kind: "boolean" },
              liveLabel: { kind: "string", maxBytes: 24 },
              startsAt: {
                kind: "string",
                maxBytes: 64,
                format: "canonicalUtcInstant",
              },
              endsAt: {
                kind: "string",
                maxBytes: 64,
                format: "canonicalUtcInstant",
              },
              excludedPaths: { kind: "canonicalPathList", maxItems: 50, maxBytes: 512 },
            },
          },
          4: {
            schemaVersion: 4,
            valueContract: "publicHomepageBannerV4",
            fields: {
              enabled: { kind: "boolean", required: true },
              message: {
                kind: "string",
                required: true,
                allowEmpty: true,
                maxBytes: 240,
              },
              linkLabel: {
                kind: "string",
                maxBytes: 80,
                pairedWith: "linkHref",
              },
              linkHref: {
                kind: "safeHref",
                maxBytes: 2_048,
                pairedWith: "linkLabel",
              },
              secondLinkLabel: { kind: "string", maxBytes: 80, pairedWith: "secondLinkHref" },
              secondLinkHref: { kind: "safeHref", maxBytes: 2_048, pairedWith: "secondLinkLabel" },
              njDecides: { kind: "boolean" },
              liveLabel: { kind: "string", maxBytes: 24 },
              startsAt: {
                kind: "string",
                maxBytes: 64,
                format: "canonicalUtcInstant",
              },
              endsAt: {
                kind: "string",
                maxBytes: 64,
                format: "canonicalUtcInstant",
              },
              excludedPaths: { kind: "canonicalPathList", maxItems: 50, maxBytes: 512 },
            },
          },
        },
      },
      "site-navigation": {
        currentVersion: 2,
        versions: {
          1: {
            schemaVersion: 1,
            fields: {
              header: {
                kind: "navigationLinks",
                required: true,
                maxItems: 12,
                labelMaxBytes: 80,
                hrefMaxBytes: 2_048,
              },
              footer: {
                kind: "navigationColumns",
                required: true,
                maxItems: 6,
                headingMaxBytes: 40,
                maxLinks: 10,
                labelMaxBytes: 80,
                hrefMaxBytes: 2_048,
                lockedLinks: [
                  { id: "contact", target: { type: "page", pageId: "contact" } },
                ],
              },
            },
          },
          2: {
            schemaVersion: 2,
            fields: {
              postsBrowse: { kind: "postsBrowse" },
              header: {
                kind: "navigationLinks",
                required: true,
                maxItems: 12,
                labelMaxBytes: 80,
                hrefMaxBytes: 2_048,
              },
              footer: {
                kind: "navigationColumns",
                required: true,
                maxItems: 6,
                headingMaxBytes: 40,
                maxLinks: 10,
                labelMaxBytes: 80,
                hrefMaxBytes: 2_048,
                lockedLinks: [
                  { id: "contact", target: { type: "page", pageId: "contact" } },
                ],
              },
            },
          },
        },
      },
      "public-site-chrome": {
        currentVersion: 1,
        versions: {
          1: {
            schemaVersion: 1,
            fields: {
              newsletterEnabled: { kind: "boolean", required: true },
              newsletterLabel: { kind: "string", required: true, maxBytes: 80 },
              newsletterHref: {
                kind: "safeHref",
                required: true,
                maxBytes: 2_048,
                absoluteOrRootRelative: true,
              },
              newsletterOpensInNewTab: { kind: "boolean", required: true },
            },
          },
        },
      },
    });
    expect(Object.isFrozen(CMS_SETTINGS_SCHEMAS)).toBe(true);
    const chromeSchema = CMS_SETTINGS_SCHEMAS["public-site-chrome"].versions[1];
    const chrome = {
      newsletterEnabled: true,
      newsletterLabel: "Newsletter",
      newsletterHref: "/newsletter/",
      newsletterOpensInNewTab: false,
    };
    expect(validateCmsSettingsValues(chromeSchema, chrome)).toBeNull();
    expect(validateCmsSettingsValues(chromeSchema, {
      ...chrome,
      newsletterHref: "https://example.org/newsletter",
    })).toBeNull();
    for (const newsletterHref of ["newsletter", "#signup", "//example.org/"]) {
      expect(validateCmsSettingsValues(chromeSchema, { ...chrome, newsletterHref }))
        .toMatch(/newsletterHref/);
    }
    expect(currentCmsSettingsSchemaFor("newsroom-home")).toEqual(
      CMS_SETTINGS_SCHEMAS["newsroom-home"].versions[1],
    );
    expect(validateCmsSettingsValues(
      CMS_SETTINGS_SCHEMAS["newsroom-home"].versions[1],
      { bannerHeading: "Admin interface and user experience" },
    )).toBeNull();
    expect(validateCmsSettingsValues(
      CMS_SETTINGS_SCHEMAS["newsroom-milestone"].versions[1],
      { milestoneNumber: 6 },
    )).toBeNull();
    expect(validateCmsSettingsValues(
      CMS_SETTINGS_SCHEMAS["newsroom-milestone"].versions[1],
      { milestoneNumber: 0 },
    )).toMatch(/integer from 1 to 10000/i);
    expect(NJ_DECIDES_SETTINGS_ID).toBe("nj-decides-brand");
    expect(DEFAULT_NJ_DECIDES_SETTINGS).toEqual({
      backgroundColor: "#e9eaee",
      textColor: "#011375",
      linkColor: "#011375",
      ruleColor: "#8B0000",
      accentColor: "#011375",
      flagEnabled: true,
    });
    expect(validateCmsSettingsValues(
      CMS_SETTINGS_SCHEMAS[NJ_DECIDES_SETTINGS_ID].versions[1],
      DEFAULT_NJ_DECIDES_SETTINGS,
    )).toBeNull();
    expect(PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID).toBe(
      "public-homepage-banner",
    );
    expect(DEFAULT_PUBLIC_HOMEPAGE_BANNER_SETTINGS).toEqual({
      enabled: false,
      message: "Montclair State University will acquire NJ Spotlight.",
      linkLabel: "Read the announcement",
      linkHref:
        "https://inside.montclair.edu/news/montclair-state-university-acquire-nj-spotlight-commits-continuing-its-watchdog-journalism-through",
    });
    expect(validateCmsSettingsValues(
      CMS_SETTINGS_SCHEMAS[PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID].versions[1],
      DEFAULT_PUBLIC_HOMEPAGE_BANNER_SETTINGS,
    )).toBeNull();
    expect(cmsSettingsSchemaFor("fixture-settings", 1)).toBeNull();
    expect(currentCmsSettingsSchemaFor("fixture-settings")).toBeNull();
    expect(cmsSettingsSchemaFor("constructor", 1)).toBeNull();
    expect(cmsSettingsSchemaFor("fixture-settings", 1, FIXTURE_CATALOG)).toBe(
      SCHEMA_V1,
    );
    expect(currentCmsSettingsSchemaFor("fixture-settings", FIXTURE_CATALOG)).toBe(
      SCHEMA_V2,
    );
    expect(currentCmsSettingsSchemaFor("fixture-settings", {
      "fixture-settings": { currentVersion: 2, versions: { 1: SCHEMA_V1 } },
    })).toBeNull();
    expect(cmsSettingsSchemaFor("fixture-settings", 1, {
      "fixture-settings": {
        currentVersion: 1,
        versions: { 1: { ...SCHEMA_V1, schemaVersion: 2 } },
      },
    })).toBeNull();
  });

  it.each([
    [{ ...DEFAULT_NJ_DECIDES_SETTINGS, backgroundColor: "#fff" }, /#RRGGBB/i],
    [{ ...DEFAULT_NJ_DECIDES_SETTINGS, textColor: "#777777" }, /text color.*4\.5:1/i],
    [{ ...DEFAULT_NJ_DECIDES_SETTINGS, linkColor: "#777777" }, /link color.*4\.5:1/i],
    [{ ...DEFAULT_NJ_DECIDES_SETTINGS, logoAssetId: "custom-logo" }, /logoAlt is required/i],
    [{ ...DEFAULT_NJ_DECIDES_SETTINGS, surprise: true }, /unknown settings field surprise/i],
  ])("rejects unsafe NJ Decides brand values", (values, expected) => {
    const schema = currentCmsSettingsSchemaFor(NJ_DECIDES_SETTINGS_ID);
    expect(validateCmsSettingsValues(schema, values)).toMatch(expected);
  });

  it("accepts accessible NJ Decides custom asset values and tracks both assets", () => {
    const schema = currentCmsSettingsSchemaFor(NJ_DECIDES_SETTINGS_ID);
    const values = {
      ...DEFAULT_NJ_DECIDES_SETTINGS,
      logoAssetId: "custom-logo",
      logoAlt: "NJ Decides 2026",
      backgroundAssetId: "election-art",
    };
    expect(validateCmsSettingsValues(schema, values)).toBeNull();
    expect(collectCmsSettingsAssetOccurrences(schema, values)).toEqual([
      "custom-logo",
      "election-art",
    ]);
  });

  it("validates selected NJ Decides media at the save boundary", async () => {
    const records = new Map([
      ["custom-logo", {
        lifecycle: "active",
        url: "https://media.njpbs.org/cms-media/custom-logo.png",
        mimeType: "image/png",
        sizeBytes: 2_000_000,
        width: 1920,
        height: 1080,
      }],
      ["election-art", {
        lifecycle: "active",
        url: "https://media.njpbs.org/cms-media/election-art.webp",
        mimeType: "image/webp",
        sizeBytes: 4_000_000,
        width: 2400,
        height: 1350,
      }],
    ]);
    const firestore = {
      collection: () => ({ doc: (id) => ({ id }) }),
    };
    const transaction = {
      get: async ({ id }) => ({
        exists: records.has(id),
        data: () => records.get(id),
      }),
    };
    const input = {
      documentId: NJ_DECIDES_SETTINGS_ID,
      values: { logoAssetId: "custom-logo", backgroundAssetId: "election-art" },
      firestore,
      transaction,
    };

    await expect(validateNjDecidesMediaAssets(input)).resolves.toBeUndefined();
    records.set("custom-logo", { ...records.get("custom-logo"), url: "https://unreviewed.example/image.png" });
    await expect(validateNjDecidesMediaAssets(input)).rejects.toMatchObject({
      status: 400, message: expect.stringMatching(/not ready for public election coverage/i),
    });
    records.set("custom-logo", { ...records.get("custom-logo"), url: "https://media.njpbs.org/cms-media/custom-logo.png" });
    records.set("custom-logo", { ...records.get("custom-logo"), mimeType: "image/gif" });
    await expect(validateNjDecidesMediaAssets(input)).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/PNG, JPEG or WebP/i),
    });
    records.set("custom-logo", {
      ...records.get("custom-logo"),
      mimeType: "image/png",
      width: 20_000,
      height: 20_000,
    });
    await expect(validateNjDecidesMediaAssets(input)).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/dimension limit/i),
    });
  });

  it("enforces the public homepage banner byte and reciprocal-link limits", () => {
    const schema = currentCmsSettingsSchemaFor(
      PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
    );
    expect(validateCmsSettingsValues(schema, {
      enabled: true,
      message: "x".repeat(240),
    })).toBeNull();
    expect(validateCmsSettingsValues(schema, {
      enabled: true,
      message: "é".repeat(121),
    })).toMatch(/message can be at most 240 bytes/i);
    expect(validateCmsSettingsValues(schema, {
      enabled: true,
      message: "Service update",
      linkLabel: "Details",
    })).toMatch(/linkLabel and linkHref must be provided together/i);
    expect(validateCmsSettingsValues(schema, {
      enabled: true,
      message: "Service update",
      linkLabel: "Details",
      linkHref: "//example.com/update",
    })).toMatch(/safe link/i);
  });

  it("keeps banner v1 immutable and accepts the optional v2 election fields", () => {
    const schemaV1 = cmsSettingsSchemaFor(PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID, 1);
    const schemaV2 = currentCmsSettingsSchemaFor(PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID);
    expect(schemaV1).toEqual({
      schemaVersion: 1,
      fields: {
        enabled: { kind: "boolean", required: true },
        message: { kind: "string", required: true, maxBytes: 240 },
        linkLabel: { kind: "string", maxBytes: 80, pairedWith: "linkHref" },
        linkHref: { kind: "safeHref", maxBytes: 2_048, pairedWith: "linkLabel" },
      },
    });
    expect(validateCmsSettingsValues(schemaV1, DEFAULT_PUBLIC_HOMEPAGE_BANNER_SETTINGS))
      .toBeNull();
    expect(validateCmsSettingsValues(schemaV2, {
      enabled: true,
      message: "",
      njDecides: true,
      liveLabel: "Live",
      startsAt: "2026-11-03T23:00:00.000Z",
      endsAt: "2026-11-04T06:00:00.000Z",
    })).toBeNull();
    expect(validateCmsSettingsValues(schemaV2, {
      enabled: true,
      message: "Election results and live coverage",
      linkLabel: "Follow live",
      linkHref: "/nj-decides/",
      njDecides: true,
    })).toBeNull();
  });

  it.each([
    [{
      enabled: true,
      message: "",
    }, /message is required unless NJ Decides mode is enabled/i],
    [{
      enabled: true,
      message: "Election results",
      njDecides: true,
      linkLabel: "Follow live",
      linkHref: "nj-decides",
    }, /absolute address or a path that starts with/i],
    [{
      enabled: false,
      message: "Election results",
      liveLabel: "é".repeat(13),
    }, /liveLabel can be at most 24 bytes/i],
    [{
      enabled: false,
      message: "Election results",
      startsAt: "2026-11-03T23:00:00Z",
    }, /startsAt must be a canonical UTC instant/i],
    [{
      enabled: false,
      message: "Election results",
      startsAt: "2026-11-04T06:00:00.000Z",
      endsAt: "2026-11-03T23:00:00.000Z",
    }, /startsAt must be before endsAt/i],
    [{
      enabled: false,
      message: "Election results",
      njDecides: "yes",
    }, /njDecides must be a boolean/i],
  ])("rejects invalid banner v2 values", (values, expected) => {
    const schema = currentCmsSettingsSchemaFor(PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID);
    expect(validateCmsSettingsValues(schema, values)).toMatch(expected);
  });

  it("preserves a valid detached banner v1 snapshot after v2 becomes current", () => {
    const schemaV1 = cmsSettingsSchemaFor(PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID, 1);
    const published = createCmsSettingsPublishedSnapshot({
      schema: schemaV1,
      values: DEFAULT_PUBLIC_HOMEPAGE_BANNER_SETTINGS,
      sourceVersion: 3,
      publishedAt: "2026-10-26T18:00:00.000Z",
    });
    expect(projectPublishedCmsSettings({
      documentId: PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
      document: { version: 4, published },
    })).toEqual(published);
  });

  it("limits save upgrade and historical publication to banner v1/v2/v3-to-v4", () => {
    const current = currentCmsSettingsSchemaFor(PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID);
    const stored = { schemaVersion: 1, values: DEFAULT_PUBLIC_HOMEPAGE_BANNER_SETTINGS };
    expect(isPublicHomepageBannerUpgrade(
      PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
      stored,
      current,
    )).toBe(true);
    expect(isPublicHomepageBannerUpgrade("other", stored, current)).toBe(false);
    expect(isPublicHomepageBannerUpgrade(
      PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
      { ...stored, schemaVersion: 4 },
      current,
    )).toBe(false);
    expect(settingsSchemaForPublication(
      PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
      stored,
      current,
      CMS_SETTINGS_SCHEMAS,
    )).toBe(cmsSettingsSchemaFor(PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID, 1));
    expect(() => settingsSchemaForPublication(
      "other",
      stored,
      current,
      CMS_SETTINGS_SCHEMAS,
    )).toThrow(/migration/i);
  });

  it.each([1, 2, 3])("upgrades a saved banner v%s draft to v4 and preserves its v1 snapshot", async (schemaVersion) => {
    const published = {
      schemaVersion: 1,
      values: DEFAULT_PUBLIC_HOMEPAGE_BANNER_SETTINGS,
      sourceVersion: 4,
      publishedAt: "2026-10-26T18:00:00.000Z",
    };
    const before = {
      schemaVersion,
      values: DEFAULT_PUBLIC_HOMEPAGE_BANNER_SETTINGS,
      version: 5,
      published,
    };
    const refs = {
      settings: { path: `cmsSettings/${PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID}` },
      user: { path: "users/admin-1" },
      history: { path: "cmsVersionHistory/generated" },
      audit: { path: "admin_logs/generated" },
      usage: { path: `cmsSettings/${PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID}/mediaUsage/working` },
    };
    const transaction = {
      get: vi.fn(async (ref) => ({
        exists: ref === refs.settings || ref === refs.user,
        data: () => ref === refs.user ? { role: "admin", active: true } : before,
      })),
      set: vi.fn(),
      create: vi.fn(),
    };
    const firestore = {
      collection: vi.fn((name) => ({
        doc: vi.fn(() => name === "cmsSettings"
          ? refs.settings
          : name === "users"
            ? refs.user
            : name === "cmsVersionHistory"
              ? refs.history
              : refs.audit),
      })),
      runTransaction: vi.fn(async (callback) => callback(transaction)),
    };
    const handler = createCmsSaveSettingsHandler({
      firestore,
      requirePrincipalFn: async () => ({
        uid: "admin-1",
        email: "admin@example.test",
        principal: { id: "admin-1", grants: [{ role: "admin" }] },
      }),
      prepareMediaUsageWriteFn: async () => ({ ref: refs.usage, document: {} }),
      adminLogEntryFn: () => ({}),
      versionHistoryEntryFn: ({ before: previous, after }) => ({ previous, after }),
      firestoreDocumentBytesFn: () => 100,
      log: { error: vi.fn() },
    });
    const body = {
      id: PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
      baseVersion: 5,
      values: {
        ...DEFAULT_PUBLIC_HOMEPAGE_BANNER_SETTINGS,
        njDecides: true,
        liveLabel: "Live",
      },
    };
    const req = {
      method: "POST",
      body,
      headers: { "content-type": "application/json" },
      rawBody: Buffer.from(JSON.stringify(body)),
      ip: "192.0.2.1",
    };
    const res = {
      headersSent: false,
      set: vi.fn(),
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; this.headersSent = true; return this; },
    };

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.settings).toEqual({
      schemaVersion: 4,
      values: body.values,
      version: 6,
      published,
    });
    expect(transaction.set).toHaveBeenCalledWith(refs.settings, res.body.settings);
  });

  it("accepts complete values for their exact schema version", () => {
    expect(validateCmsSettingsValues(SCHEMA_V1, valuesV1())).toBeNull();
    expect(validateCmsSettingsValues(SCHEMA_V2, valuesV2())).toBeNull();
  });

  it.each([
    [{ ...valuesV1(), surprise: true }, /unknown settings field surprise/i],
    [valuesV1({ enabled: "yes" }), /enabled must be a boolean/i],
    [valuesV1({ message: "x".repeat(121) }), /message can be at most 120 bytes/i],
    [valuesV1({ heroAssetId: "bad/id" }), /valid media asset id/i],
    [valuesV1({ galleryAssetIds: ["bad/id"] }), /valid media asset id/i],
    [valuesV1({ galleryAssetIds: "asset-one" }), /array of media asset ids/i],
    [{ message: "Missing enabled" }, /enabled is required/i],
  ])("refuses invalid complete values", (candidate, expected) => {
    expect(validateCmsSettingsValues(SCHEMA_V1, candidate)).toMatch(expected);
  });

  it("bounds schema fields, UTF-8 field names, and per-field declarations", () => {
    const maximumName = "é".repeat(MAX_CMS_SETTINGS_FIELD_NAME_BYTES / 2);
    expect(validateCmsSettingsValues({
      schemaVersion: 1,
      fields: { [maximumName]: { kind: "boolean" } },
    }, {})).toBeNull();
    expect(validateCmsSettingsValues({
      schemaVersion: 1,
      fields: { [`${maximumName}é`]: { kind: "boolean" } },
    }, {})).toMatch(/schema is invalid/i);

    const tooManyFields = Object.fromEntries(
      Array.from({ length: MAX_CMS_SETTINGS_FIELDS + 1 }, (_, index) => [
        `field${index}`,
        { kind: "boolean" },
      ]),
    );
    expect(validateCmsSettingsValues({
      schemaVersion: 1,
      fields: tooManyFields,
    }, {})).toMatch(/schema is invalid/i);
    expect(validateCmsSettingsValues({
      schemaVersion: 1,
      fields: {
        message: { kind: "string", maxBytes: MAX_CMS_SETTINGS_STRING_BYTES + 1 },
      },
    }, {})).toMatch(/schema is invalid/i);
    expect(validateCmsSettingsValues({
      schemaVersion: 1,
      fields: {
        assets: {
          kind: "assetIdList",
          maxItems: MAX_CMS_SETTINGS_ASSET_LIST_ITEMS + 1,
        },
      },
    }, {})).toMatch(/schema is invalid/i);
  });

  it("counts UTF-8 value bytes and caps the aggregate JSON value object", () => {
    const utf8Schema = {
      schemaVersion: 1,
      fields: { message: { kind: "string", maxBytes: 4 } },
    };
    expect(validateCmsSettingsValues(utf8Schema, { message: "éé" })).toBeNull();
    expect(validateCmsSettingsValues(utf8Schema, { message: "ééx" })).toMatch(
      /at most 4 bytes/i,
    );

    const fieldCount = Math.ceil(
      MAX_CMS_SETTINGS_VALUES_JSON_BYTES / MAX_CMS_SETTINGS_STRING_BYTES,
    ) + 1;
    const fields = Object.fromEntries(
      Array.from({ length: fieldCount }, (_, index) => [
        `field${index}`,
        { kind: "string", maxBytes: MAX_CMS_SETTINGS_STRING_BYTES },
      ]),
    );
    const oversized = Object.fromEntries(
      Array.from({ length: fieldCount }, (_, index) => [
        `field${index}`,
        "x".repeat(MAX_CMS_SETTINGS_STRING_BYTES),
      ]),
    );
    expect(validateCmsSettingsValues({ schemaVersion: 1, fields }, oversized)).toMatch(
      new RegExp(`${MAX_CMS_SETTINGS_VALUES_JSON_BYTES} bytes`, "i"),
    );
  });

  it("extracts declared media fields and keeps duplicate occurrences", () => {
    expect(collectCmsSettingsAssetOccurrences(SCHEMA_V1, valuesV1())).toEqual([
      "asset-hero",
      "asset-one",
      "asset-one",
      "asset-two",
    ]);
    expect(
      collectCmsSettingsAssetOccurrences(SCHEMA_V1, valuesV1({
        heroAssetId: "",
        galleryAssetIds: [],
      })),
    ).toEqual([]);
  });

  it("creates a detached snapshot carrying its exact schema version", () => {
    const working = valuesV1();
    const snapshot = createCmsSettingsPublishedSnapshot({
      schema: SCHEMA_V1,
      values: working,
      sourceVersion: 7,
      publishedAt: "2026-08-14T12:30:00.000Z",
    });

    working.message = "Later draft";
    working.galleryAssetIds.push("later-asset");
    expect(snapshot).toEqual({
      schemaVersion: 1,
      values: valuesV1(),
      sourceVersion: 7,
      publishedAt: "2026-08-14T12:30:00.000Z",
    });
  });

  it("projects an old published schema after a new schema becomes current", () => {
    const published = createCmsSettingsPublishedSnapshot({
      schema: SCHEMA_V1,
      values: valuesV1({ message: "Published under v1" }),
      sourceVersion: 3,
      publishedAt: "2026-08-14T12:30:00.000Z",
    });
    const projected = projectPublishedCmsSettings({
      documentId: "fixture-settings",
      schemas: FIXTURE_CATALOG,
      document: {
        version: 4,
        schemaVersion: 2,
        values: valuesV2({ message: "Unpublished v2 draft" }),
        published,
      },
    });

    expect(projected).toEqual(published);
    expect(projected.values.message).toBe("Published under v1");
  });

  it("returns null without a snapshot and never falls back to working values", () => {
    expect(projectPublishedCmsSettings({
      documentId: "fixture-settings",
      schemas: FIXTURE_CATALOG,
      document: { version: 4, schemaVersion: 2, values: valuesV2() },
    })).toBeNull();
  });

  it("fails closed on invalid document and snapshot receipts", () => {
    const validPublished = createCmsSettingsPublishedSnapshot({
      schema: SCHEMA_V1,
      values: valuesV1(),
      sourceVersion: 3,
      publishedAt: "2026-08-14T12:30:00.000Z",
    });
    for (const document of [
      { published: validPublished },
      { version: 0, published: validPublished },
      { version: 2, published: { ...validPublished, sourceVersion: 3 } },
      { version: 4, published: { ...validPublished, schemaVersion: 99 } },
      { version: 4, published: { ...validPublished, extra: true } },
    ]) {
      expect(() => projectPublishedCmsSettings({
        documentId: "fixture-settings",
        schemas: FIXTURE_CATALOG,
        document,
      })).toThrow(CmsSettingsContractError);
    }
  });

  it("refuses patch values and invalid snapshot receipts", () => {
    for (const input of [
      {
        schema: SCHEMA_V1,
        values: { message: "Patch only" },
        sourceVersion: 7,
        publishedAt: "2026-08-14T12:30:00.000Z",
      },
      {
        schema: SCHEMA_V1,
        values: valuesV1(),
        sourceVersion: 0,
        publishedAt: "2026-08-14T12:30:00.000Z",
      },
      {
        schema: SCHEMA_V1,
        values: valuesV1(),
        sourceVersion: 7,
        publishedAt: "Friday afternoon",
      },
    ]) {
      expect(() => createCmsSettingsPublishedSnapshot(input)).toThrow(
        CmsSettingsContractError,
      );
    }
  });
});
