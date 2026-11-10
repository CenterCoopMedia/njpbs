import { describe, expect, it, vi } from "vitest";

import {
  COLLECTION,
  PROJECT_ID,
  SAFE_ARTICLE_STATUSES,
  SYSTEM_ACTOR,
  articleAsPost,
  convertRetiredArticle,
  parseConversionPlan,
  validateMigrationEnvironment,
} from "../../scripts/convert-retired-article-to-post.mjs";

const NOW = "2026-08-24T15:00:00.000Z";
const PLAN = Object.freeze({
  id: "retired-article-1",
  title: "A retired Article",
  version: 4,
  authorName: "NJ PBS staff",
});

function richText(text = "The original Article body.") {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }],
      },
    ],
  };
}

function article(overrides = {}) {
  return {
    id: PLAN.id,
    type: "article",
    title: PLAN.title,
    version: PLAN.version,
    status: "draft",
    slug: "a-retired-article",
    previousSlugs: [],
    locale: "en",
    publishAt: "2026-08-01T12:00:00.000Z",
    createdAt: "2026-08-01T10:00:00.000Z",
    createdBy: "user-1",
    updatedAt: "2026-08-02T10:00:00.000Z",
    updatedBy: "user-1",
    author: "legacy-author-id",
    dek: "A legacy deck.",
    tags: ["news"],
    heroImage: "pbs-media-manager-image",
    body: richText(),
    blocks: [
      {
        id: "existing-divider",
        type: "divider",
        order: 0,
        visible: true,
        data: {},
      },
    ],
    ...overrides,
  };
}

function approvedCredential() {
  return JSON.stringify({
    type: "service_account",
    project_id: PROJECT_ID,
    client_email: "migration@njpbs-site.iam.gserviceaccount.com",
    private_key_id: "approved-key",
    private_key: "-----BEGIN PRIVATE KEY-----\napproved\n-----END PRIVATE KEY-----\n",
  });
}

function fakeFirestore(storedArticle = article()) {
  let generated = 0;
  const transaction = {
    get: vi.fn(async (target) =>
      target.kind === "document" && target.path === `${COLLECTION}/${PLAN.id}`
        ? {
            exists: true,
            data: () => structuredClone(storedArticle),
          }
        : { docs: [] },
    ),
    set: vi.fn(),
    create: vi.fn(),
  };

  function collection(path) {
    const constraints = [];
    return {
      path,
      doc(id) {
        const documentId = id ?? `generated-${++generated}`;
        return {
          kind: "document",
          id: documentId,
          path: `${path}/${documentId}`,
        };
      },
      where(field, operator, value) {
        constraints.push([field, operator, value]);
        return this;
      },
      limit(value) {
        return {
          kind: "query",
          path,
          constraints: [...constraints],
          limit: value,
        };
      },
    };
  }

  return {
    firestore: {
      collection: vi.fn(collection),
      runTransaction: vi.fn(async (callback) => callback(transaction)),
    },
    transaction,
  };
}

describe("Article-to-Post conversion plan", () => {
  it("pins a bounded Firestore id, exact title, version, and optional byline", () => {
    expect(parseConversionPlan(PLAN)).toEqual(PLAN);
    expect(() =>
      parseConversionPlan({ ...PLAN, id: "nested/id" }),
    ).toThrow(/bounded id and title/);
    expect(() =>
      parseConversionPlan({ ...PLAN, version: 0 }),
    ).toThrow(/positive version/);
    expect(() =>
      parseConversionPlan({ ...PLAN, authorName: "" }),
    ).toThrow(/bounded display name/);
  });
});

describe("Article-to-Post document conversion", () => {
  it("converts the body, preserves safe Post fields, and removes opaque Article hero art", () => {
    const post = articleAsPost(article(), PLAN, NOW);

    expect(post).toMatchObject({
      id: PLAN.id,
      type: "post",
      title: PLAN.title,
      status: "draft",
      summary: "A legacy deck.",
      tags: ["news"],
      credits: [{ kind: "custom", name: "NJ PBS staff" }],
      version: PLAN.version + 1,
      updatedAt: NOW,
      updatedBy: SYSTEM_ACTOR,
    });
    expect(post).not.toHaveProperty("body");
    expect(post).not.toHaveProperty("dek");
    expect(post).not.toHaveProperty("author");
    expect(post).not.toHaveProperty("heroImage");
    expect(post).not.toHaveProperty("heroImageAlt");
    expect(post).not.toHaveProperty("heroImageDecorative");
    expect(post.blocks).toEqual([
      {
        id: `article-body-${PLAN.id}`,
        type: "prose",
        order: 0,
        visible: true,
        data: { content: richText() },
      },
      {
        id: "existing-divider",
        type: "divider",
        order: 1,
        visible: true,
        data: {},
      },
    ]);
  });

  it("treats an absent legacy blocks field as an empty array", () => {
    const legacy = article();
    delete legacy.blocks;

    const post = articleAsPost(legacy, PLAN, NOW);

    expect(post.blocks).toHaveLength(1);
    expect(post.blocks[0]).toMatchObject({
      id: `article-body-${PLAN.id}`,
      type: "prose",
      order: 0,
    });
  });

  it("rejects a present non-array blocks field", () => {
    expect(() =>
      articleAsPost(article({ blocks: null }), PLAN, NOW),
    ).toThrow(/must be absent or contain an array/);
  });

  it.each(["scheduled", "in_review", "approved"])(
    "rejects the unsafe %s lifecycle state",
    (status) => {
      expect(() =>
        articleAsPost(article({ status }), PLAN, NOW),
      ).toThrow(/Only draft or archived Articles/);
    },
  );

  it.each(SAFE_ARTICLE_STATUSES)(
    "accepts the explicitly safe %s lifecycle state",
    (status) => {
      expect(
        articleAsPost(article({ status }), PLAN, NOW).status,
      ).toBe(status);
    },
  );

  it("rejects every public or published Article signal", () => {
    expect(() =>
      articleAsPost(
        article({ status: "published" }),
        PLAN,
        NOW,
      ),
    ).toThrow(/public or published/);
    expect(() =>
      articleAsPost(
        article({ publiclyVisible: true }),
        PLAN,
        NOW,
      ),
    ).toThrow(/public or published/);
    expect(() =>
      articleAsPost(
        article({ published: { sourceVersion: 4 } }),
        PLAN,
        NOW,
      ),
    ).toThrow(/public or published/);
  });

  it("enforces the Post section catalog on retained blocks", () => {
    expect(() =>
      articleAsPost(
        article({
          blocks: [
            {
              id: "article-only-headline",
              type: "headline",
              order: 0,
              visible: true,
              data: { text: "Not allowed in a Post" },
            },
          ],
        }),
        PLAN,
        NOW,
      ),
    ).toThrow(/converted Post section is invalid/i);
  });

  it("enforces the complete Post field contract", () => {
    expect(() =>
      articleAsPost(article({ tags: "news" }), PLAN, NOW),
    ).toThrow(/tags must be an array of strings/);
    expect(() =>
      articleAsPost(
        article({ legacyArticleOnlyField: true }),
        PLAN,
        NOW,
      ),
    ).toThrow(/unsupported fields: legacyArticleOnlyField/);
  });

  it("requires an approved display name for a stored legacy byline", () => {
    const planWithoutName = {
      id: PLAN.id,
      title: PLAN.title,
      version: PLAN.version,
    };
    expect(() =>
      articleAsPost(article(), planWithoutName, NOW),
    ).toThrow(/approved plan must provide its display name/);
  });

  it("refuses plan drift before composing a Post", () => {
    expect(() =>
      articleAsPost(
        article({ version: PLAN.version + 1 }),
        PLAN,
        NOW,
      ),
    ).toThrow(/does not match the approved conversion plan/);
  });
});

describe("Article-to-Post production environment", () => {
  it("refuses emulator routing before reading ADC or opening Firestore", () => {
    const readCredentialFile = vi.fn();

    expect(() =>
      validateMigrationEnvironment({
        env: {
          FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
          GOOGLE_APPLICATION_CREDENTIALS: "/approved/adc.json",
        },
        readCredentialFile,
      }),
    ).toThrow(/emulator routing is not allowed/i);
    expect(readCredentialFile).not.toHaveBeenCalled();
  });

  it("accepts only the approved service-account project identity", () => {
    expect(() =>
      validateMigrationEnvironment({
        env: {
          GOOGLE_APPLICATION_CREDENTIALS: "/approved/adc.json",
          GOOGLE_CLOUD_PROJECT: PROJECT_ID,
        },
        readCredentialFile: () => approvedCredential(),
      }),
    ).not.toThrow();

    expect(() =>
      validateMigrationEnvironment({
        env: {
          GOOGLE_APPLICATION_CREDENTIALS: "/approved/adc.json",
        },
        readCredentialFile: () =>
          approvedCredential().replace(
            `"project_id":"${PROJECT_ID}"`,
            '"project_id":"another-project"',
          ),
      }),
    ).toThrow(/approved service account/);
  });
});

describe("Article-to-Post transactional receipts", () => {
  it("atomically writes content, full history, working media usage, and audit evidence", async () => {
    const stored = article();
    const { firestore, transaction } = fakeFirestore(stored);
    const collectWorkingMediaUsageFn = vi.fn(() => ({
      assetIds: ["media-1"],
      occurrenceCount: 1,
    }));
    const mediaRef = {
      kind: "document",
      path: `${COLLECTION}/${PLAN.id}/mediaUsage/working`,
    };
    const mediaDocument = {
      state: "working",
      sourceVersion: PLAN.version + 1,
      assetIds: ["media-1"],
      occurrenceCount: 1,
    };
    const prepareMediaUsageWriteFn = vi.fn(async () => ({
      ref: mediaRef,
      document: mediaDocument,
    }));
    const documentSizeErrorFn = vi.fn(() => null);

    await expect(
      convertRetiredArticle({
        firestore,
        plan: PLAN,
        nowIso: NOW,
        collectWorkingMediaUsageFn,
        prepareMediaUsageWriteFn,
        documentSizeErrorFn,
      }),
    ).resolves.toEqual({
      id: PLAN.id,
      fromVersion: PLAN.version,
      toVersion: PLAN.version + 1,
    });

    expect(collectWorkingMediaUsageFn).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: COLLECTION,
        documentId: PLAN.id,
        document: expect.objectContaining({
          type: "post",
          version: PLAN.version + 1,
        }),
      }),
    );
    expect(prepareMediaUsageWriteFn).toHaveBeenCalledWith(
      expect.objectContaining({
        firestore,
        transaction,
        collection: COLLECTION,
        documentId: PLAN.id,
        state: "working",
        sourceVersion: PLAN.version + 1,
        usage: {
          assetIds: ["media-1"],
          occurrenceCount: 1,
        },
      }),
    );

    const contentWrite = transaction.set.mock.calls.find(
      ([ref]) => ref.path === `${COLLECTION}/${PLAN.id}`,
    );
    expect(contentWrite?.[1]).toMatchObject({
      type: "post",
      version: PLAN.version + 1,
    });
    expect(transaction.set).toHaveBeenCalledWith(
      mediaRef,
      mediaDocument,
    );

    const historyCall = transaction.create.mock.calls.find(
      ([ref]) => ref.path.startsWith("cmsVersionHistory/"),
    );
    expect(historyCall?.[1]).toMatchObject({
      collection: COLLECTION,
      documentId: PLAN.id,
      action: "article-to-post",
      before: stored,
      after: expect.objectContaining({
        type: "post",
        version: PLAN.version + 1,
      }),
      userId: SYSTEM_ACTOR,
      source: "approved_operator_migration",
      at: NOW,
    });

    const auditCall = transaction.create.mock.calls.find(
      ([ref]) => ref.path.startsWith("admin_logs/"),
    );
    expect(auditCall?.[1]).toMatchObject({
      actorUid: SYSTEM_ACTOR,
      action: "content.article_converted_to_post",
      target: `${COLLECTION}/${PLAN.id}`,
      before: {
        type: "article",
        status: "draft",
        version: PLAN.version,
      },
      after: expect.objectContaining({
        type: "post",
        status: "draft",
        version: PLAN.version + 1,
      }),
      source: "approved_operator_migration",
      at: NOW,
    });
  });

  it("stages no writes when a duplicate Post exists", async () => {
    const { firestore, transaction } = fakeFirestore();
    transaction.get.mockImplementation(async (target) =>
      target.kind === "document"
        ? {
            exists: true,
            data: () => article(),
          }
        : { docs: [{ id: "duplicate-post" }] },
    );

    await expect(
      convertRetiredArticle({
        firestore,
        plan: PLAN,
        nowIso: NOW,
        collectWorkingMediaUsageFn: vi.fn(),
        prepareMediaUsageWriteFn: vi.fn(),
      }),
    ).rejects.toThrow(/already exists/);
    expect(transaction.set).not.toHaveBeenCalled();
    expect(transaction.create).not.toHaveBeenCalled();
  });
});
