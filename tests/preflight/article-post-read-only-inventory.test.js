import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  ARTICLE_FETCH_CAP,
  DUPLICATE_POST_FETCH_CAP,
  INVENTORY_COLLECTION,
  INVENTORY_PROJECT_ID,
  INVENTORY_PROJECTION,
  collectArticlePostInventory,
  runArticlePostInventoryCli,
  validateApprovedAdc,
} from "../../scripts/inventory-article-posts-read-only.mjs";

const SCRIPT_PATH = fileURLToPath(
  new URL(
    "../../scripts/inventory-article-posts-read-only.mjs",
    import.meta.url,
  ),
);
const NOW = "2026-08-19T17:45:00.000Z";
const TARGET_TITLE =
  "Example newsroom welcomes two new team members";

function record(id, data) {
  return { id, data };
}

function projectedData(data, projection) {
  if (projection === null) return { ...data };
  return Object.fromEntries(
    projection
      .filter((field) => Object.prototype.hasOwnProperty.call(data, field))
      .map((field) => [field, data[field]]),
  );
}

function matchingRecords(records, filters) {
  return records.filter(({ data }) =>
    filters.every(
      ({ field, operation, value }) =>
        operation === "==" && data[field] === value,
    ),
  );
}

function fakeFirestore(records, { countOverrides = {} } = {}) {
  const operations = [];

  class AggregateQuery {
    constructor(query) {
      this.query = query;
    }
  }

  class Query {
    constructor({ filters = [], projection = null, limit = null } = {}) {
      this.filters = filters;
      this.projection = projection;
      this.queryLimit = limit;
    }

    where(field, operation, value) {
      return new Query({
        filters: [...this.filters, { field, operation, value }],
        projection: this.projection,
        limit: this.queryLimit,
      });
    }

    select(...fields) {
      return new Query({
        filters: this.filters,
        projection: fields,
        limit: this.queryLimit,
      });
    }

    limit(value) {
      return new Query({
        filters: this.filters,
        projection: this.projection,
        limit: value,
      });
    }

    count() {
      return new AggregateQuery(this);
    }
  }

  const transaction = {
    get: vi.fn(async (query) => {
      if (query instanceof AggregateQuery) {
        const { filters, projection, queryLimit } = query.query;
        operations.push({
          kind: "count",
          filters,
          projection,
          limit: queryLimit,
        });
        const type = filters.find(({ field }) => field === "type")?.value;
        const count = Object.prototype.hasOwnProperty.call(countOverrides, type)
          ? countOverrides[type]
          : matchingRecords(records, filters).length;
        return { data: () => ({ count }) };
      }
      if (!(query instanceof Query)) {
        throw new Error("Unexpected read-only transaction query");
      }
      operations.push({
        kind: "get",
        filters: query.filters,
        projection: query.projection,
        limit: query.queryLimit,
      });
      const matches = matchingRecords(records, query.filters);
      const bounded =
        query.queryLimit === null
          ? matches
          : matches.slice(0, query.queryLimit);
      return {
        docs: bounded.map(({ id, data }) => ({
          id,
          data: () => projectedData(data, query.projection),
        })),
      };
    }),
    create: vi.fn(() => {
      throw new Error("A read-only inventory must not create a document");
    }),
    set: vi.fn(() => {
      throw new Error("A read-only inventory must not set a document");
    }),
    update: vi.fn(() => {
      throw new Error("A read-only inventory must not update a document");
    }),
    delete: vi.fn(() => {
      throw new Error("A read-only inventory must not delete a document");
    }),
  };

  const firestore = {
    collection: vi.fn((name) => {
      if (name !== INVENTORY_COLLECTION)
        throw new Error(`Unexpected collection ${name}`);
      return new Query();
    }),
    runTransaction: vi.fn(async (operation, options) => {
      if (options?.readOnly !== true) {
        throw new Error(
          "The inventory transaction must be explicitly read-only",
        );
      }
      return operation(transaction);
    }),
    batch: vi.fn(() => {
      throw new Error("A read-only inventory must not create a write batch");
    }),
    bulkWriter: vi.fn(() => {
      throw new Error("A read-only inventory must not create a bulk writer");
    }),
  };

  return { firestore, operations, transaction };
}

function validAdcJson(overrides = {}) {
  return JSON.stringify({
    type: "service_account",
    project_id: INVENTORY_PROJECT_ID,
    private_key_id: "fixture-key-id",
    private_key: "fixture-private-key",
    client_email: "fixture@njpbs-site.iam.gserviceaccount.com",
    ...overrides,
  });
}

function captureStream() {
  let output = "";
  return {
    stream: {
      write: (value) => {
        output += String(value);
      },
    },
    read: () => output,
  };
}

describe("read-only Article and Post inventory", () => {
  it("uses exact aggregate counts, a narrow Article projection, and bounded exact-title duplicate checks", async () => {
    const { firestore, operations, transaction } = fakeFirestore([
      record("article-blake", {
        type: "article",
        title: TARGET_TITLE,
        status: "draft",
        version: 3,
        deleted: false,
        body: { secret: "must not enter the inventory" },
      }),
      record("post-same-title", {
        type: "post",
        title: TARGET_TITLE,
        status: "draft",
        version: 1,
        deleted: false,
        blocks: [{ private: "must not enter the inventory" }],
      }),
      record("post-other", {
        type: "post",
        title: "Another post",
        status: "published",
        version: 7,
      }),
      record("event-ignored", {
        type: "event",
        title: "Ignored event",
        status: "draft",
        version: 1,
      }),
    ]);

    await expect(
      collectArticlePostInventory({ firestore, generatedAt: NOW }),
    ).resolves.toEqual({
      schemaVersion: 1,
      readOnly: true,
      projectId: INVENTORY_PROJECT_ID,
      collection: INVENTORY_COLLECTION,
      generatedAt: NOW,
      limits: {
        articles: ARTICLE_FETCH_CAP,
        exactTitlePostDuplicatesPerArticle: DUPLICATE_POST_FETCH_CAP,
      },
      counts: { article: 1, post: 2 },
      articles: [
        {
          id: "article-blake",
          title: TARGET_TITLE,
          status: "draft",
          version: 3,
          deleted: false,
          exactTitlePostDuplicates: [
            {
              id: "post-same-title",
              title: TARGET_TITLE,
              status: "draft",
              version: 1,
              deleted: false,
            },
          ],
        },
      ],
    });

    expect(operations.filter(({ kind }) => kind === "count")).toEqual([
      {
        kind: "count",
        filters: [{ field: "type", operation: "==", value: "article" }],
        projection: null,
        limit: null,
      },
      {
        kind: "count",
        filters: [{ field: "type", operation: "==", value: "post" }],
        projection: null,
        limit: null,
      },
    ]);
    expect(operations.filter(({ kind }) => kind === "get")).toEqual([
      {
        kind: "get",
        filters: [{ field: "type", operation: "==", value: "article" }],
        projection: [...INVENTORY_PROJECTION],
        limit: ARTICLE_FETCH_CAP + 1,
      },
      {
        kind: "get",
        filters: [
          { field: "type", operation: "==", value: "post" },
          { field: "title", operation: "==", value: TARGET_TITLE },
        ],
        projection: [...INVENTORY_PROJECTION],
        limit: DUPLICATE_POST_FETCH_CAP + 1,
      },
    ]);
    expect(firestore.runTransaction).toHaveBeenCalledTimes(1);
    expect(firestore.runTransaction).toHaveBeenCalledWith(
      expect.any(Function),
      { readOnly: true },
    );
    expect(firestore.batch).not.toHaveBeenCalled();
    expect(firestore.bulkWriter).not.toHaveBeenCalled();
    expect(transaction.create).not.toHaveBeenCalled();
    expect(transaction.set).not.toHaveBeenCalled();
    expect(transaction.update).not.toHaveBeenCalled();
    expect(transaction.delete).not.toHaveBeenCalled();
  });

  it("fails before document reads when the exact Article count exceeds its cap", async () => {
    const { firestore, operations } = fakeFirestore([], {
      countOverrides: { article: ARTICLE_FETCH_CAP + 1, post: 0 },
    });

    await expect(
      collectArticlePostInventory({ firestore, generatedAt: NOW }),
    ).rejects.toThrow(/Article count exceeds the read-only inventory cap/);
    expect(operations.filter(({ kind }) => kind === "get")).toHaveLength(0);
  });

  it("fails when a title has more exact Post duplicates than the duplicate cap", async () => {
    const records = [
      record("article-blake", {
        type: "article",
        title: TARGET_TITLE,
        status: "draft",
        version: 3,
      }),
      ...Array.from({ length: DUPLICATE_POST_FETCH_CAP + 1 }, (_, index) =>
        record(`post-${index}`, {
          type: "post",
          title: TARGET_TITLE,
          status: "draft",
          version: index + 1,
        }),
      ),
    ];
    const { firestore } = fakeFirestore(records);

    await expect(
      collectArticlePostInventory({ firestore, generatedAt: NOW }),
    ).rejects.toThrow(/exact-title Post duplicate count exceeds/);
  });

  it("fails closed when aggregate and projected Article results disagree", async () => {
    const { firestore } = fakeFirestore(
      [
        record("article-one", {
          type: "article",
          title: "One Article",
          status: "draft",
          version: 1,
        }),
      ],
      { countOverrides: { article: 2, post: 0 } },
    );

    await expect(
      collectArticlePostInventory({ firestore, generatedAt: NOW }),
    ).rejects.toThrow(/Article count and projection disagree/);
  });

  it.each([
    ["blank title", { title: "", status: "draft", version: 1 }],
    [
      "oversized title",
      { title: "x".repeat(501), status: "draft", version: 1 },
    ],
    ["blank status", { title: "Title", status: "", version: 1 }],
    ["invalid version", { title: "Title", status: "draft", version: 0 }],
    [
      "invalid deleted flag",
      { title: "Title", status: "draft", version: 1, deleted: "no" },
    ],
  ])(
    "fails closed for a projected Article with a %s",
    async (_label, values) => {
      const { firestore } = fakeFirestore([
        record("article-bad", { type: "article", ...values }),
      ]);

      await expect(
        collectArticlePostInventory({ firestore, generatedAt: NOW }),
      ).rejects.toThrow(/invalid bounded inventory fields/);
    },
  );

  it("requires a production service-account ADC without exposing its content", () => {
    const secret = "credential-private-material";
    expect(() =>
      validateApprovedAdc({
        env: {},
        readCredentialFile: vi.fn(),
      }),
    ).toThrow(/GOOGLE_APPLICATION_CREDENTIALS is required/);

    let error;
    try {
      validateApprovedAdc({
        env: { GOOGLE_APPLICATION_CREDENTIALS: "/approved/adc.json" },
        readCredentialFile: () =>
          validAdcJson({
            project_id: "demo-njpbs",
            private_key: secret,
          }),
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/required production project/);
    expect(error.message).not.toContain("demo-njpbs");
    expect(error.message).not.toContain(secret);

    expect(() =>
      validateApprovedAdc({
        env: { GOOGLE_APPLICATION_CREDENTIALS: "/approved/adc.json" },
        readCredentialFile: () => validAdcJson(),
      }),
    ).not.toThrow();

    expect(() =>
      validateApprovedAdc({
        env: {
          GOOGLE_APPLICATION_CREDENTIALS: "/approved/adc.json",
          GOOGLE_CLOUD_PROJECT: "demo-njpbs",
        },
        readCredentialFile: () => validAdcJson(),
      }),
    ).toThrow(/configured project.*required production project/);

    expect(() =>
      validateApprovedAdc({
        env: {
          GOOGLE_APPLICATION_CREDENTIALS: "/approved/adc.json",
          FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
        },
        readCredentialFile: () => validAdcJson(),
      }),
    ).toThrow(/Firestore emulator routing is not allowed/);
  });

  it("prints one bounded JSON inventory and closes its read client", async () => {
    const { firestore } = fakeFirestore([
      record("article-blake", {
        type: "article",
        title: TARGET_TITLE,
        status: "draft",
        version: 3,
      }),
    ]);
    const close = vi.fn().mockResolvedValue(undefined);
    const stdout = captureStream();
    const stderr = captureStream();

    const exitCode = await runArticlePostInventoryCli({
      argv: [],
      env: { GOOGLE_APPLICATION_CREDENTIALS: "/approved/adc.json" },
      readCredentialFile: () => validAdcJson(),
      openFirestore: vi.fn().mockResolvedValue({ firestore, close }),
      stdout: stdout.stream,
      stderr: stderr.stream,
      generatedAt: NOW,
    });

    expect(exitCode).toBe(0);
    expect(stderr.read()).toBe("");
    expect(stdout.read().trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(stdout.read())).toMatchObject({
      readOnly: true,
      projectId: INVENTORY_PROJECT_ID,
      collection: INVENTORY_COLLECTION,
      generatedAt: NOW,
      counts: { article: 1, post: 0 },
      articles: [{ id: "article-blake", exactTitlePostDuplicates: [] }],
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("redacts unexpected credential and runtime errors from CLI JSON", async () => {
    const secret = "-----BEGIN PRIVATE KEY-----do-not-print";
    const stdout = captureStream();
    const stderr = captureStream();

    const exitCode = await runArticlePostInventoryCli({
      argv: [],
      env: { GOOGLE_APPLICATION_CREDENTIALS: "/approved/adc.json" },
      readCredentialFile: () => validAdcJson({ private_key: secret }),
      openFirestore: async () => {
        throw new Error(secret);
      },
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(exitCode).toBe(1);
    expect(stdout.read()).toBe("");
    expect(stderr.read().trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(stderr.read())).toEqual({
      success: false,
      readOnly: true,
      error: "The read-only Article and Post inventory failed.",
    });
    expect(stderr.read()).not.toContain(secret);
    expect(stderr.read()).not.toContain("/approved/adc.json");
  });

  it("prints bounded JSON help without opening ADC or Firestore", async () => {
    const stdout = captureStream();
    const openFirestore = vi.fn();
    const readCredentialFile = vi.fn();

    const exitCode = await runArticlePostInventoryCli({
      argv: ["--help"],
      env: {},
      readCredentialFile,
      openFirestore,
      stdout: stdout.stream,
      stderr: captureStream().stream,
    });

    expect(exitCode).toBe(0);
    expect(stdout.read().trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(stdout.read())).toMatchObject({
      name: "Read-only Article and Post inventory",
      readOnly: true,
      usage: "npm run --silent cms:inventory:article-posts:read-only",
      projectId: INVENTORY_PROJECT_ID,
      collection: INVENTORY_COLLECTION,
    });
    expect(readCredentialFile).not.toHaveBeenCalled();
    expect(openFirestore).not.toHaveBeenCalled();
  });

  it("rejects unknown arguments before ADC or Firestore access", async () => {
    const stdout = captureStream();
    const stderr = captureStream();
    const readCredentialFile = vi.fn();
    const openFirestore = vi.fn();

    const exitCode = await runArticlePostInventoryCli({
      argv: ["--project", "demo-njpbs"],
      env: {},
      readCredentialFile,
      openFirestore,
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(exitCode).toBe(1);
    expect(stdout.read()).toBe("");
    expect(JSON.parse(stderr.read())).toMatchObject({
      success: false,
      readOnly: true,
      error: expect.stringMatching(/project and collection are fixed/),
    });
    expect(readCredentialFile).not.toHaveBeenCalled();
    expect(openFirestore).not.toHaveBeenCalled();
  });

  it("contains no Firestore mutation calls and requires an explicit read-only transaction", () => {
    const source = readFileSync(SCRIPT_PATH, "utf8");
    expect(source).not.toMatch(
      /\.(?:add|create|set|update|delete|recursiveDelete|batch|bulkWriter)\s*\(/,
    );
    expect(source).not.toMatch(/\b(?:FieldValue|WriteBatch|Transaction)\b/);
    expect(source.match(/\.runTransaction\s*\(/g)).toHaveLength(1);
    expect(source).toMatch(/\.runTransaction\([\s\S]*\{ readOnly: true \}\)/);
  });





});
