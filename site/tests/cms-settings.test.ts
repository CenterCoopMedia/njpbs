import { describe, expect, it } from "vitest";
import serverContract from "../../functions/lib/cms-settings-contract.js";
import {
  CMS_SETTINGS_SCHEMAS,
  DEFAULT_NJ_DECIDES_SETTINGS,
  DEFAULT_PUBLIC_HOMEPAGE_BANNER_SETTINGS,
  DEFAULT_NEWSROOM_BANNER_HEADING,
  MAX_CMS_SETTINGS_ASSET_LIST_ITEMS,
  MAX_CMS_SETTINGS_FIELD_NAME_BYTES,
  MAX_CMS_SETTINGS_FIELDS,
  MAX_CMS_SETTINGS_STRING_BYTES,
  MAX_CMS_SETTINGS_VALUES_JSON_BYTES,
  NEWSROOM_HOME_SETTINGS_ID,
  NJ_DECIDES_SETTINGS_ID,
  PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
  cmsSettingsSchemaFor,
  collectCmsSettingsAssetOccurrences,
  createCmsSettingsPublishedSnapshot,
  currentCmsSettingsSchemaFor,
  projectPublishedCmsSettings,
  validateCmsSettingsValues,
  type CmsSettingsSchema,
  type CmsSettingsSchemaCatalog,
} from "../../packages/content-core/src/cms-settings";

const SCHEMA_V1 = {
  schemaVersion: 1,
  fields: {
    enabled: { kind: "boolean", required: true },
    message: { kind: "string", required: true, maxBytes: 120 },
    heroAssetId: { kind: "assetId" },
    galleryAssetIds: { kind: "assetIdList", maxItems: 200 },
  },
} as const satisfies CmsSettingsSchema;

const SCHEMA_V2 = {
  schemaVersion: 2,
  fields: {
    enabled: { kind: "boolean", required: true },
    message: { kind: "string", required: true, maxBytes: 120 },
    audience: { kind: "string", required: true, maxBytes: 40 },
    heroAssetId: { kind: "assetId" },
    galleryAssetIds: { kind: "assetIdList", maxItems: 200 },
  },
} as const satisfies CmsSettingsSchema;

const FIXTURE_CATALOG = {
  "fixture-settings": {
    currentVersion: 2,
    versions: { 1: SCHEMA_V1, 2: SCHEMA_V2 },
  },
} as const satisfies CmsSettingsSchemaCatalog;

const VALUES_V1 = {
  enabled: true,
  message: "The station is live.",
  heroAssetId: "asset-hero",
  galleryAssetIds: ["asset-one", "asset-one", "asset-two"],
};

const VALUES_V2 = { ...VALUES_V1, audience: "all" };

function outcome(run: () => unknown) {
  try {
    return { ok: true, value: run() };
  } catch (error) {
    return {
      ok: false,
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function expectParity(canonical: () => unknown, server: () => unknown) {
  expect(outcome(server)).toEqual(outcome(canonical));
}

describe("CMS settings TypeScript and CommonJS parity", () => {
  it("keeps constants, the closed catalog, and version resolution equal", () => {
    expect(serverContract.CMS_SETTINGS_SCHEMAS).toEqual(CMS_SETTINGS_SCHEMAS);
    expect(serverContract.NEWSROOM_HOME_SETTINGS_ID).toBe(
      NEWSROOM_HOME_SETTINGS_ID,
    );
    expect(serverContract.DEFAULT_NEWSROOM_BANNER_HEADING).toBe(
      DEFAULT_NEWSROOM_BANNER_HEADING,
    );
    expect(serverContract.PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID).toBe(
      PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
    );
    expect(serverContract.DEFAULT_PUBLIC_HOMEPAGE_BANNER_SETTINGS).toEqual(
      DEFAULT_PUBLIC_HOMEPAGE_BANNER_SETTINGS,
    );
    expect(serverContract.NJ_DECIDES_SETTINGS_ID).toBe(NJ_DECIDES_SETTINGS_ID);
    expect(serverContract.DEFAULT_NJ_DECIDES_SETTINGS).toEqual(
      DEFAULT_NJ_DECIDES_SETTINGS,
    );
    expect(currentCmsSettingsSchemaFor("newsroom-home")).toEqual({
      schemaVersion: 1,
      fields: {
        bannerHeading: {
          kind: "string",
          required: true,
          maxBytes: 160,
        },
      },
    });
    expect({
      fields: serverContract.MAX_CMS_SETTINGS_FIELDS,
      fieldNameBytes: serverContract.MAX_CMS_SETTINGS_FIELD_NAME_BYTES,
      stringBytes: serverContract.MAX_CMS_SETTINGS_STRING_BYTES,
      listItems: serverContract.MAX_CMS_SETTINGS_ASSET_LIST_ITEMS,
      valuesBytes: serverContract.MAX_CMS_SETTINGS_VALUES_JSON_BYTES,
    }).toEqual({
      fields: MAX_CMS_SETTINGS_FIELDS,
      fieldNameBytes: MAX_CMS_SETTINGS_FIELD_NAME_BYTES,
      stringBytes: MAX_CMS_SETTINGS_STRING_BYTES,
      listItems: MAX_CMS_SETTINGS_ASSET_LIST_ITEMS,
      valuesBytes: MAX_CMS_SETTINGS_VALUES_JSON_BYTES,
    });
    expectParity(
      () => cmsSettingsSchemaFor("fixture-settings", 1, FIXTURE_CATALOG),
      () => serverContract.cmsSettingsSchemaFor("fixture-settings", 1, FIXTURE_CATALOG),
    );
    expectParity(
      () => currentCmsSettingsSchemaFor("fixture-settings", FIXTURE_CATALOG),
      () => serverContract.currentCmsSettingsSchemaFor("fixture-settings", FIXTURE_CATALOG),
    );
    expectParity(
      () => cmsSettingsSchemaFor("constructor", 1, FIXTURE_CATALOG),
      () => serverContract.cmsSettingsSchemaFor("constructor", 1, FIXTURE_CATALOG),
    );
    const incompleteHistory = {
      "fixture-settings": { currentVersion: 2, versions: { 1: SCHEMA_V1 } },
    } as const;
    expectParity(
      () => currentCmsSettingsSchemaFor("fixture-settings", incompleteHistory),
      () => serverContract.currentCmsSettingsSchemaFor(
        "fixture-settings",
        incompleteHistory,
      ),
    );
  });

  it("keeps validation success and failure tables equal", () => {
    const maximumName = "é".repeat(MAX_CMS_SETTINGS_FIELD_NAME_BYTES / 2);
    const aggregateFieldCount = Math.ceil(
      MAX_CMS_SETTINGS_VALUES_JSON_BYTES / MAX_CMS_SETTINGS_STRING_BYTES,
    ) + 1;
    const aggregateFields = Object.fromEntries(
      Array.from({ length: aggregateFieldCount }, (_, index) => [
        `field${index}`,
        { kind: "string", maxBytes: MAX_CMS_SETTINGS_STRING_BYTES },
      ]),
    );
    const aggregateValues = Object.fromEntries(
      Array.from({ length: aggregateFieldCount }, (_, index) => [
        `field${index}`,
        "x".repeat(MAX_CMS_SETTINGS_STRING_BYTES),
      ]),
    );
    const cases: Array<[unknown, unknown]> = [
      [SCHEMA_V1, VALUES_V1],
      [SCHEMA_V2, VALUES_V2],
      [SCHEMA_V1, { ...VALUES_V1, unknown: true }],
      [SCHEMA_V1, { ...VALUES_V1, enabled: "yes" }],
      [SCHEMA_V1, { ...VALUES_V1, message: "é".repeat(61) }],
      [{ ...SCHEMA_V1, schemaVersion: 0 }, VALUES_V1],
      [{ schemaVersion: 1, fields: { [`${maximumName}é`]: { kind: "boolean" } } }, {}],
      [{
        schemaVersion: 1,
        fields: {
          message: { kind: "string", maxBytes: MAX_CMS_SETTINGS_STRING_BYTES + 1 },
        },
      }, {}],
      [{
        schemaVersion: 1,
        fields: {
          assets: {
            kind: "assetIdList",
            maxItems: MAX_CMS_SETTINGS_ASSET_LIST_ITEMS + 1,
          },
        },
      }, {}],
      [{ schemaVersion: 1, fields: aggregateFields }, aggregateValues],
      [CMS_SETTINGS_SCHEMAS[NJ_DECIDES_SETTINGS_ID].versions[1], DEFAULT_NJ_DECIDES_SETTINGS],
      [CMS_SETTINGS_SCHEMAS[NJ_DECIDES_SETTINGS_ID].versions[1], {
        ...DEFAULT_NJ_DECIDES_SETTINGS,
        textColor: "#777777",
      }],
      [CMS_SETTINGS_SCHEMAS[NJ_DECIDES_SETTINGS_ID].versions[1], {
        ...DEFAULT_NJ_DECIDES_SETTINGS,
        logoAssetId: "custom-logo",
      }],
      [CMS_SETTINGS_SCHEMAS[PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID].versions[1],
        DEFAULT_PUBLIC_HOMEPAGE_BANNER_SETTINGS],
      [CMS_SETTINGS_SCHEMAS[PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID].versions[2], {
        enabled: true,
        message: "Election results and live coverage",
        linkLabel: "Follow live",
        linkHref: "/nj-decides/",
        njDecides: true,
        liveLabel: "Live",
        startsAt: "2026-11-03T23:00:00.000Z",
        endsAt: "2026-11-04T06:00:00.000Z",
      }],
      [CMS_SETTINGS_SCHEMAS[PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID].versions[2], {
        enabled: true,
        message: "",
        njDecides: true,
      }],
      [CMS_SETTINGS_SCHEMAS[PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID].versions[2], {
        enabled: true,
        message: "",
      }],
      [CMS_SETTINGS_SCHEMAS[PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID].versions[2], {
        enabled: false,
        message: "Election results",
        startsAt: "2026-11-04T06:00:00.000Z",
        endsAt: "2026-11-03T23:00:00.000Z",
      }],
      [{
        schemaVersion: 1,
        fields: {
          order: {
            kind: "stringList",
            required: true,
            maxItems: 2,
            allowedValues: ["first", "second"],
            unique: true,
          },
          label: { kind: "string", maxBytes: 20, pairedWith: "url" },
          url: { kind: "safeHref", maxBytes: 200, pairedWith: "label" },
        },
      }, { order: ["second"], label: "Details", url: "https://example.org" }],
      [{
        schemaVersion: 1,
        fields: {
          order: {
            kind: "stringList",
            maxItems: 2,
            allowedValues: ["first", "second"],
            unique: true,
          },
        },
      }, { order: ["first", "first"] }],
    ];
    for (const [schema, values] of cases) {
      expectParity(
        () => validateCmsSettingsValues(schema as CmsSettingsSchema, values),
        () => serverContract.validateCmsSettingsValues(schema, values),
      );
    }
  });

  it("keeps occurrence extraction success and failure equal", () => {
    for (const values of [VALUES_V1, { ...VALUES_V1, heroAssetId: "bad/id" }]) {
      expectParity(
        () => collectCmsSettingsAssetOccurrences(SCHEMA_V1, values),
        () => serverContract.collectCmsSettingsAssetOccurrences(SCHEMA_V1, values),
      );
    }
  });

  it("keeps snapshot success, receipt errors, and canonical time equal", () => {
    for (const input of [
      {
        schema: SCHEMA_V1,
        values: VALUES_V1,
        sourceVersion: 4,
        publishedAt: "2026-08-14T12:30:00.000Z",
      },
      {
        schema: SCHEMA_V1,
        values: VALUES_V1,
        sourceVersion: 0,
        publishedAt: "2026-08-14T12:30:00.000Z",
      },
      {
        schema: SCHEMA_V1,
        values: VALUES_V1,
        sourceVersion: 4,
        publishedAt: "2026-08-14T12:30:00Z",
      },
    ]) {
      expectParity(
        () => createCmsSettingsPublishedSnapshot(input),
        () => serverContract.createCmsSettingsPublishedSnapshot(input),
      );
    }
  });

  it("keeps historical projection, absent snapshots, and receipt failures equal", () => {
    const published = createCmsSettingsPublishedSnapshot({
      schema: SCHEMA_V1,
      values: VALUES_V1,
      sourceVersion: 3,
      publishedAt: "2026-08-14T12:30:00.000Z",
    });
    const documents = [
      {
        version: 4,
        schemaVersion: 2,
        values: VALUES_V2,
        published,
      },
      { version: 4, schemaVersion: 2, values: VALUES_V2 },
      { published },
      { version: 2, published: { ...published, sourceVersion: 3 } },
      { version: 4, published: { ...published, schemaVersion: 99 } },
      { version: 4, published: { ...published, extra: true } },
    ];
    for (const document of documents) {
      expectParity(
        () => projectPublishedCmsSettings({
          documentId: "fixture-settings",
          schemas: FIXTURE_CATALOG,
          document,
        }),
        () => serverContract.projectPublishedCmsSettings({
          documentId: "fixture-settings",
          schemas: FIXTURE_CATALOG,
          document,
        }),
      );
    }
  });
});

// Bounds and URL semantics from the approved #4362 contract.
describe("NJ Decides banner exclusions", () => {
  const schema = currentCmsSettingsSchemaFor(PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID)!;
  const base = { enabled: true, message: "", njDecides: true };
  it.each([undefined, [], ["/", "/election/", "/posts/election-guide/"],
    Array.from({ length: 50 }, (_, i) => `/page-${i}/`), ["/" + "a".repeat(510) + "/"]].map(excludedPaths => ({ excludedPaths })))(

    "admits an absent or bounded canonical selection", ({ excludedPaths }) => {
      const values = { ...base, ...(excludedPaths ? { excludedPaths } : {}) };
      expect(validateCmsSettingsValues(schema, values)).toBeNull();
      expect(serverContract.validateCmsSettingsValues(serverContract.currentCmsSettingsSchemaFor(PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID), values)).toBeNull();
    });
  it.each([["/", "/"], Array.from({ length: 51 }, (_, i) => `/page-${i}/`),
    ["/" + "a".repeat(511) + "/"], ["https://njpbs.org/"], ["//example.org/"],
    ["/page/?q=1"], ["/page/#heading"], ["/posts/*/"], ["/../"], ["/page%2fother/"], ["/Page/"], ["/missing-slash"], [null]].map(paths => ({ paths })))(

    "rejects unsafe, duplicate or excessive selections", ({ paths }) => {
      expect(validateCmsSettingsValues(schema, { ...base, excludedPaths: paths })).toMatch(/excludedPaths/);
      expect(serverContract.validateCmsSettingsValues(serverContract.currentCmsSettingsSchemaFor(PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID), { ...base, excludedPaths: paths })).toMatch(/excludedPaths/);
    });
  it.each([null, "/", 1, {}].map(excludedPaths => ({ excludedPaths })))("rejects a non-list exclusion value", ({ excludedPaths }) => {
    expect(validateCmsSettingsValues(schema, { ...base, excludedPaths })).toMatch(/excludedPaths/);
    expect(serverContract.validateCmsSettingsValues(serverContract.currentCmsSettingsSchemaFor(PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID), { ...base, excludedPaths })).toMatch(/excludedPaths/);
  });
  it("keeps the old published banner readable while a newer draft is saved", () => {
    const values = { enabled: true, message: "Vote", njDecides: true };
    const published = { schemaVersion: 2, values, sourceVersion: 1, publishedAt: "2026-10-29T12:00:00.000Z" };
    const oldCatalog = { [PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID]: { currentVersion: 2,
      versions: { 1: cmsSettingsSchemaFor(PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID, 1)!, 2: cmsSettingsSchemaFor(PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID, 2)! } } };
    const document = { schemaVersion: 3, version: 2, values: { ...values, excludedPaths: ["/"] }, published };
    expect(projectPublishedCmsSettings({ documentId: PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID, schemas: oldCatalog, document })).toEqual(published);
    expect(() => projectPublishedCmsSettings({ documentId: PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID, schemas: oldCatalog,
      document: { ...document, published: { ...published, schemaVersion: 3, sourceVersion: 2, values: document.values } } })).toThrow(/schema is not available/);
  });
});
