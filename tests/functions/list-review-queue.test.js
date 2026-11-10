import { describe, expect, it, vi } from "vitest";
import listContent from "../../functions/list-content.js";
import reviewQueue from "../../functions/lib/review-queue.js";
import pageContract from "../../functions/lib/public-page-contract.js";
import { reviewQueueFirestore } from "../helpers/review-queue-firestore.mjs";
import { readFileSync } from "node:fs";

const {
  MAX_REVIEW_REQUESTS,
  advanceReviewRequest,
  createReviewRequest,
  presentReviewRequests,
  readInReviewRecords,
  reviewRequestId,
  reviewRequestSummary,
  sortReviewRequests,
  visibleReviewRequests,
} = reviewQueue;
const { createCmsListContentHandler } = listContent;
// Scoped reads reserve one slot per canonical page for stale section values,
// plus the overflow sentinel, without consuming the 500 custom-page slots.
const scopedPageReadLimit = MAX_REVIEW_REQUESTS + Object.keys(pageContract.PAGE_SECTIONS).length + 1;

function responseRecorder() {
  return {
    statusCode: null,
    body: null,
    headersSent: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      this.headersSent = true;
      return this;
    },
  };
}

function record(collection, id, document) {
  return { collection, id, document };
}

const siteWideEditor = {
  uid: "editor-1",
  principal: { id: "editor-1", grants: [{ role: "editor" }] },
};

const scopedEditor = {
  uid: "news-editor",
  principal: {
    id: "news-editor",
    grants: [{ role: "editor", sections: ["news"] }],
  },
};

const contributor = {
  uid: "author-1",
  principal: { id: "author-1", grants: [{ role: "contributor" }] },
};

function reviewRequest(overrides = {}) {
  return {
    method: "POST",
    body: { view: "review_queue" },
    ...overrides,
  };
}

describe("editorial review queue domain", () => {
  it("bounds each authoritative collection read", async () => {
    const queries = [];
    const firestore = {
      collection(collection) {
        const query = {
          where: vi.fn(() => query),
          select: vi.fn(() => query),
          orderBy: vi.fn(() => query),
          limit: vi.fn(() => query),
          get: vi.fn(async () => ({ docs: [] })),
        };
        queries.push({ collection, query });
        return query;
      },
    };

    await readInReviewRecords(firestore, siteWideEditor.principal);

    expect(queries.map(({ collection }) => collection)).toEqual([
      "cmsPages",
      "cmsPosts",
    ]);
    for (const { query } of queries) {
      expect(query.orderBy).toHaveBeenCalledWith("reviewRequest.requestedAt", "desc");
      expect(query.limit).toHaveBeenCalledWith(MAX_REVIEW_REQUESTS + 1);
      expect(query.get).toHaveBeenCalledOnce();
    }
  });

  it("constrains a scoped review read before applying its bound", async () => {
    const queries = [];
    const firestore = {
      collection() {
        const query = {
          where: vi.fn(() => query),
          select: vi.fn(() => query),
          orderBy: vi.fn(() => query),
          limit: vi.fn(() => query),
          get: vi.fn(async () => ({ docs: [] })),
        };
        queries.push(query);
        return query;
      },
    };

    await readInReviewRecords(firestore, scopedEditor.principal);

    for (const query of queries) {
      expect(query.where).toHaveBeenNthCalledWith(1, "status", "==", "in_review");
      expect(query.where).toHaveBeenNthCalledWith(2, "section", "in", ["news"]);
      expect(query.orderBy).toHaveBeenCalledWith("reviewRequest.requestedAt", "desc");
    }
    // Canonical pages can have a stale stored section; custom pages still
    // get the full 500-row allowance after those IDs are authorized separately.
    expect(queries[0].limit).toHaveBeenCalledWith(scopedPageReadLimit);
    expect(queries[1].limit).toHaveBeenCalledWith(MAX_REVIEW_REQUESTS + 1);
  });

  it("does not issue an empty section in-query for a malformed scoped grant", async () => {
    const queries = [];
    const firestore = {
      collection(collection) {
        const query = {
          where: vi.fn(() => query),
          select: vi.fn(() => query),
          orderBy: vi.fn(() => query),
          limit: vi.fn(() => query),
          get: vi.fn(async () => ({ docs: [] })),
        };
        queries.push({ collection, query });
        return query;
      },
    };

    await readInReviewRecords(firestore, {
      id: "empty-desk",
      grants: [{ role: "editor", sections: [""] }],
    });

    expect(queries.map(({ collection }) => collection)).toEqual([
      "cmsPages",
      "cmsPosts",
    ]);
    for (const { query } of queries) {
      expect(query.get).not.toHaveBeenCalled();
      expect(query.where).not.toHaveBeenCalledWith("section", "in", []);
    }
  });

  it.each([
    ["cmsPages", false, 1], ["cmsPages", true, 1],
    ["cmsPosts", false, 1], ["cmsPosts", true, 1],
    ["cmsPages", false, 31], ["cmsPages", true, 31],
    ["cmsPosts", false, 31], ["cmsPosts", true, 31],
  ])("keeps an older authorized %s row behind 501 other-desk requests (countOnly=%s, desks=%s)", async (collection, countOnly, deskCount) => {
    const records = Array.from({ length: 501 }, (_, index) => record(
      collection, `page-${index.toString(16).padStart(32, "0")}`, {
        type: "post", title: "Another desk's request", section: "arts", status: "in_review", version: 1,
        reviewRequest: { requestedAt: "2026-10-06T16:00:00.000Z" },
      },
    ));
    const allowedId = `page-${"f".repeat(32)}`;
    records.push(record(collection, allowedId, {
      type: "post", title: "News request", section: "news", status: "in_review", version: 2,
      reviewRequest: { requestedAt: "2026-10-05T16:00:00.000Z" },
      updatedAt: "2026-10-05T16:00:00.000Z",
    }));
    const firestore = reviewQueueFirestore(records);
    const sections = [...Array.from({ length: deskCount - 1 }, (_, index) => `desk-${index}`), "news"];
    const user = { uid: "news-editor", principal: { id: "news-editor", grants: [{ role: "editor", sections }] } };
    const res = responseRecorder();
    const handler = createCmsListContentHandler({
      firestore, requirePrincipalFn: async () => user,
    });
    await handler(reviewRequest({ body: { view: "review_queue", countOnly } }), res);
    expect(res.statusCode).toBe(200);
    if (countOnly) expect(res.body).toEqual({ success: true, count: 1 });
    else expect(res.body.requests.map((request) => request.recordId)).toEqual([allowedId]);
    expect(firestore.reads.reduce((total, read) => total + read.returned, 0)).toBe(1);
  });

  it.each(["cmsPages", "cmsPosts"])("does not let a malformed grant fill the %s cap ahead of a valid grant", async (collection) => {
    const records = Array.from({ length: 501 }, (_, index) => record(
      collection, `page-${index.toString(16).padStart(32, "0")}`, {
        type: "post", section: "arts", status: "in_review", version: 1,
        reviewRequest: { requestedAt: "2026-10-06T16:00:00.000Z" },
      },
    ));
    const allowedId = `page-${"f".repeat(32)}`;
    records.push(record(collection, allowedId, {
      type: "post", section: "news", status: "in_review", version: 1,
      reviewRequest: { requestedAt: "2026-10-05T16:00:00.000Z" },
    }));
    const principal = {
      id: "news-editor",
      grants: [{ role: "editor", sections: ["news"] }, { role: "editor", sections: ["arts", ""] }],
    };
    const firestore = reviewQueueFirestore(records);
    const visible = visibleReviewRequests(principal, await readInReviewRecords(firestore, principal));
    expect(visible.map((request) => request.recordId)).toEqual([allowedId]);
    expect(firestore.reads.reduce((total, read) => total + read.returned, 0)).toBe(1);
  });

  it("recovers canonical pages by registry section and deduplicates indexed rows", async () => {
    const document = { status: "in_review", version: 2, updatedAt: "2026-10-05T16:00:00.000Z" };
    const firestore = reviewQueueFirestore([
      record("cmsPages", "watch", document),
      record("cmsPages", "live", { ...document, section: "news" }),
      record("cmsPages", "schedule", { ...document, section: "watch", reviewRequest: { requestedAt: document.updatedAt } }),
      record("cmsPages", "about", { ...document, section: "watch", reviewRequest: { requestedAt: document.updatedAt } }),
      record("cmsPages", "kids", { ...document, section: "watch", status: "draft" }),
    ]);
    const principal = { id: "watch-editor", grants: [{ role: "editor", sections: ["watch"] }] };
    const records = await readInReviewRecords(firestore, principal);
    expect(visibleReviewRequests(principal, records).map((request) => request.recordId).sort())
      .toEqual(["live", "schedule", "watch"]);
    expect(records.filter((record) => record.id === "schedule")).toHaveLength(1);
    const exactRead = firestore.reads.find((read) => read.paths);
    expect(exactRead.paths).toEqual(["cmsPages/watch", "cmsPages/live", "cmsPages/schedule", "cmsPages/kids"]);
    expect(exactRead.fields).toContain("reviewRequest");
    expect(exactRead.fields).not.toContain("blocks");
  });

  it("splits more than 30 granted desks without widening either collection", async () => {
    const sections = Array.from({ length: 31 }, (_, index) => `desk-${index}`);
    const firestore = reviewQueueFirestore([
      record("cmsPosts", "last-desk", { type: "post", section: "desk-30", status: "in_review", version: 1,
        reviewRequest: { requestedAt: "2026-10-05T16:00:00.000Z" } }),
    ]);
    const principal = { id: "many-desks", grants: [{ role: "editor", sections }] };
    const records = await readInReviewRecords(firestore, principal);
    expect(visibleReviewRequests(principal, records).map((request) => request.recordId)).toEqual(["last-desk"]);
    expect(firestore.reads).toHaveLength(4);
    for (const read of firestore.reads) {
      expect(read.filters).toContainEqual({ field: "section", operator: "in", value: expect.any(Array) });
      const scope = read.filters.find(({ field }) => field === "section").value;
      expect(scope.length).toBeGreaterThan(0);
      expect(scope.length).toBeLessThanOrEqual(30);
      expect(read.limit).toBe(read.collection === "cmsPages" ? scopedPageReadLimit : MAX_REVIEW_REQUESTS + 1);
      expect(read.fields).not.toContain("blocks");
    }
  });

  it("keeps all 500 custom page slots when another canonical desk has stale sections", async () => {
    const requestedAt = "2026-10-05T16:00:00.000Z";
    const records = Array.from({ length: 500 }, (_, index) => record(
      "cmsPages", `page-${index.toString(16).padStart(32, "0")}`, {
        title: "News request", section: "news", status: "in_review", version: 1,
        reviewRequest: { requestedAt },
      },
    ));
    records.unshift(record("cmsPages", "watch", {
      title: "Watch request", section: "news", status: "in_review", version: 1,
      reviewRequest: { requestedAt: "2026-10-06T16:00:00.000Z" },
    }), record("cmsPages", "live", {
      title: "Live request", section: "news", status: "in_review", version: 1,
      reviewRequest: { requestedAt: "2026-10-06T16:00:00.000Z" },
    }));
    const firestore = reviewQueueFirestore(records);
    const visible = visibleReviewRequests(scopedEditor.principal,
      await readInReviewRecords(firestore, scopedEditor.principal));
    expect(visible).toHaveLength(500);
    expect(visible.every((request) => request.recordId.startsWith("page-"))).toBe(true);
    expect(firestore.reads[0].returned).toBe(502);
    expect(firestore.reads[0].limit).toBe(scopedPageReadLimit);
  });

  it("ships the scoped page review query index", () => {
    const { indexes } = JSON.parse(readFileSync(new URL("../../firestore.indexes.json", import.meta.url), "utf8"));
    expect(indexes).toContainEqual({
      collectionGroup: "cmsPages", queryScope: "COLLECTION",
      fields: [
        { fieldPath: "status", order: "ASCENDING" },
        { fieldPath: "section", order: "ASCENDING" },
        { fieldPath: "reviewRequest.requestedAt", order: "DESCENDING" },
      ],
    });
  });

  it("uses one stable request identity for one content record", () => {
    const first = reviewRequestId("cmsPosts", "record-1");
    expect(first).toBe(reviewRequestId("cmsPosts", "record-1"));
    expect(first).not.toBe(reviewRequestId("cmsPages", "record-1"));
    expect(first).toMatch(/^review_[a-f0-9]{64}$/);
  });

  it("creates the exact immutable submit envelope and advances only its version pointer", () => {
    const submitted = createReviewRequest({
      collection: "cmsPosts",
      id: "record-1",
      sourceVersion: 7,
      requestedBy: "author-1",
      requestedAt: "2026-08-20T16:00:00.000Z",
    });
    expect(submitted).toEqual({
      requestId: reviewRequestId("cmsPosts", "record-1"),
      collection: "cmsPosts",
      recordId: "record-1",
      state: "in_review",
      sourceVersion: 7,
      requestedBy: "author-1",
      requestedAt: "2026-08-20T16:00:00.000Z",
    });

    expect(
      advanceReviewRequest(submitted, {
        collection: "cmsPosts",
        id: "record-1",
        sourceVersion: 8,
      }),
    ).toEqual({
      ...submitted,
      sourceVersion: 8,
    });
  });

  it("keeps submit attribution when an in-review record is later edited or reassigned", () => {
    const summary = reviewRequestSummary("cmsPosts", "record-1", {
      type: "article",
      title: "Transit funding vote",
      status: "in_review",
      version: 8,
      createdBy: "author-1",
      updatedBy: "admin-1",
      updatedAt: "2026-08-20T18:00:00.000Z",
      assignee: "editor-2",
      section: "news",
      reviewRequest: createReviewRequest({
        collection: "cmsPosts",
        id: "record-1",
        sourceVersion: 8,
        requestedBy: "author-1",
        requestedAt: "2026-08-20T16:00:00.000Z",
      }),
    });

    expect(summary).toMatchObject({
      requestId: reviewRequestId("cmsPosts", "record-1"),
      recordId: "record-1",
      state: "in_review",
      sourceVersion: 8,
      requestedByUid: "author-1",
      requestedAt: "2026-08-20T16:00:00.000Z",
      assigneeUid: "editor-2",
      recovered: false,
    });
  });

  it("recovers an older in-review record without a second queue collection", () => {
    const summary = reviewRequestSummary("cmsPages", "watch", {
      title: "Watch",
      status: "in_review",
      version: 3,
      updatedBy: "editor-2",
      updatedAt: "2026-08-20T14:00:00.000Z",
    });

    expect(summary).toMatchObject({
      requestId: reviewRequestId("cmsPages", "watch"),
      recordId: "watch",
      sourceVersion: 3,
      state: "in_review",
      requestedByUid: "editor-2",
      requestedAt: "2026-08-20T14:00:00.000Z",
      recovered: true,
    });
  });

  it("refuses draft, deleted, malformed, and unknown review targets", () => {
    expect(
      reviewRequestSummary("cmsPosts", "record-1", {
        type: "article",
        status: "draft",
        version: 7,
      }),
    ).toBeNull();
    expect(
      reviewRequestSummary("cmsPosts", "record-1", {
        type: "article",
        status: "in_review",
        version: 7,
        deleted: true,
      }),
    ).toBeNull();
    expect(
      reviewRequestSummary("cmsPosts", "record-1", {
        type: "article",
        status: "in_review",
        version: 0,
      }),
    ).toBeNull();
    expect(
      reviewRequestSummary("cmsPosts", "record-1", {
        type: "unknown",
        status: "in_review",
        version: 1,
      }),
    ).toBeNull();
  });

  it("uses the shared section resolver so scoped review rows remain openable", () => {
    const requests = visibleReviewRequests(scopedEditor.principal, [
      record("cmsPosts", "news-1", {
        type: "article",
        title: "News request",
        status: "in_review",
        version: 2,
        section: "news",
      }),
      record("cmsPosts", "arts-1", {
        type: "article",
        title: "Arts request",
        status: "in_review",
        version: 4,
        section: "arts",
      }),
      record("cmsPosts", "legacy-1", {
        type: "article",
        title: "Unsectioned request",
        status: "in_review",
        version: 5,
      }),
    ]);

    expect(requests.map((request) => request.recordId)).toEqual(["news-1"]);

    const watchReviewer = {
      id: "watch-editor",
      grants: [{ role: "editor", sections: ["watch"] }],
    };
    expect(
      visibleReviewRequests(watchReviewer, [
        record("cmsPages", "watch", {
          title: "Watch",
          status: "in_review",
          version: 2,
        }),
      ]).map((request) => request.recordId),
    ).toEqual(["watch"]);
  });

  it("returns staff-facing labels without account ids", () => {
    const requests = [
      {
        requestId: "review_a",
        collection: "cmsPosts",
        recordId: "record-1",
        contentType: "article",
        title: "Request",
        state: "in_review",
        sourceVersion: 4,
        requestedByUid: "author-1",
        requestedAt: "2026-08-20T16:00:00.000Z",
        assigneeUid: "editor-2",
        recovered: false,
        resource: { section: "news" },
      },
    ];
    const [presented] = presentReviewRequests(requests, {
      viewerUid: "editor-2",
      directory: new Map([
        ["author-1", { active: true, displayName: "Avery Author" }],
        ["editor-2", { active: true, displayName: "Ed Editor" }],
      ]),
    });

    expect(presented).toMatchObject({
      requestedByLabel: "Avery Author",
      assigneeLabel: "You",
    });
    expect(presented).not.toHaveProperty("requestedByUid");
    expect(presented).not.toHaveProperty("assigneeUid");
    expect(presented).not.toHaveProperty("resource");
  });

  it("sorts newest submissions first without changing request identity", () => {
    const requests = sortReviewRequests([
      { requestId: "review_b", requestedAt: "2026-08-20T12:00:00.000Z" },
      { requestId: "review_a", requestedAt: "2026-08-20T13:00:00.000Z" },
      { requestId: "review_c", requestedAt: null },
    ]);
    expect(requests.map((request) => request.requestId)).toEqual([
      "review_a",
      "review_b",
      "review_c",
    ]);
  });
});

describe("cmsListContent editorial queue view", () => {
  it("returns the current review state and privacy-preserving labels to an editor", async () => {
    const res = responseRecorder();
    const readStaffDirectoryFn = vi.fn(async () =>
      new Map([
        ["author-1", { active: true, displayName: "Avery Author" }],
        ["editor-2", { active: true, displayName: "Ed Editor" }],
      ]),
    );
    const handler = createCmsListContentHandler({
      firestore: {},
      requirePrincipalFn: async () => siteWideEditor,
      readReviewRecordsFn: async () => [
        record("cmsPosts", "record-1", {
          type: "article",
          title: "Current request",
          status: "in_review",
          version: 8,
          assignee: "editor-2",
          reviewRequest: createReviewRequest({
            collection: "cmsPosts",
            id: "record-1",
            sourceVersion: 8,
            requestedBy: "author-1",
            requestedAt: "2026-08-20T16:00:00.000Z",
          }),
        }),
      ],
      readStaffDirectoryFn,
      log: { error() {}, warn() {} },
    });

    await handler(reviewRequest(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      requests: [
        {
          requestId: reviewRequestId("cmsPosts", "record-1"),
          collection: "cmsPosts",
          recordId: "record-1",
          contentType: "article",
          title: "Current request",
          state: "in_review",
          sourceVersion: 8,
          contentVersion: 8,
          requestedAt: "2026-08-20T16:00:00.000Z",
          recovered: false,
          requestedByLabel: "Avery Author",
          assigneeLabel: "Ed Editor",
        },
      ],
    });
    expect(readStaffDirectoryFn).toHaveBeenCalledWith({}, [
      "author-1",
      "editor-2",
    ]);
  });

  it("refuses a contributor before any review data is read", async () => {
    const readReviewRecordsFn = vi.fn();
    const res = responseRecorder();
    const handler = createCmsListContentHandler({
      firestore: {},
      requirePrincipalFn: async () => contributor,
      readReviewRecordsFn,
      log: { error() {}, warn() {} },
    });

    await handler(reviewRequest(), res);

    expect(res.statusCode).toBe(403);
    expect(readReviewRecordsFn).not.toHaveBeenCalled();
  });

  it("returns a processable bounded set when the authorized queue exceeds its cap", async () => {
    const res = responseRecorder();
    const records = Array.from(
      { length: MAX_REVIEW_REQUESTS + 1 },
      (_, index) =>
        record("cmsPosts", `record-${index}`, {
          type: "article",
          title: `Request ${index}`,
          status: "in_review",
          version: 1,
        }),
    );
    const handler = createCmsListContentHandler({
      firestore: {},
      requirePrincipalFn: async () => siteWideEditor,
      readReviewRecordsFn: async () => records,
      readStaffDirectoryFn: async () => new Map(),
      log: { error() {}, warn() {} },
    });

    await handler(reviewRequest(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.requests).toHaveLength(MAX_REVIEW_REQUESTS);
  });

  it("caps a countOnly review-queue read that exceeds the response cap", async () => {
    const res = responseRecorder();
    const records = Array.from(
      { length: MAX_REVIEW_REQUESTS + 1 },
      (_, index) =>
        record("cmsPosts", `record-${index}`, {
          type: "article",
          title: `Request ${index}`,
          status: "in_review",
          version: 1,
        }),
    );
    const handler = createCmsListContentHandler({
      firestore: {},
      requirePrincipalFn: async () => siteWideEditor,
      readReviewRecordsFn: async () => records,
      readStaffDirectoryFn: async () => new Map(),
      log: { error() {}, warn() {} },
    });

    await handler(reviewRequest({ body: { view: "review_queue", countOnly: true } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, count: MAX_REVIEW_REQUESTS });
  });

  it("refuses an unsupported view without reading either content projection", async () => {
    const readRecordsFn = vi.fn();
    const readReviewRecordsFn = vi.fn();
    const res = responseRecorder();
    const handler = createCmsListContentHandler({
      requirePrincipalFn: async () => siteWideEditor,
      readRecordsFn,
      readReviewRecordsFn,
    });

    await handler(reviewRequest({ body: { view: "unknown" } }), res);
    expect(res.statusCode).toBe(400);
    expect(readRecordsFn).not.toHaveBeenCalled();
    expect(readReviewRecordsFn).not.toHaveBeenCalled();
  });

  it("returns a review-queue count without staff labels or request rows", async () => {
    const readStaffDirectoryFn = vi.fn();
    const res = responseRecorder();
    const handler = createCmsListContentHandler({
      firestore: {},
      requirePrincipalFn: async () => siteWideEditor,
      readReviewRecordsFn: async () => [
        record("cmsPosts", "news-1", {
          type: "article",
          title: "News request",
          status: "in_review",
          version: 4,
          section: "news",
        }),
        record("cmsPosts", "arts-1", {
          type: "article",
          title: "Arts request",
          status: "in_review",
          version: 2,
          section: "arts",
        }),
      ],
      readStaffDirectoryFn,
    });
    await handler(reviewRequest({ body: { view: "review_queue", countOnly: true } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, count: 2 });
    expect(readStaffDirectoryFn).not.toHaveBeenCalled();
  });

  it("counts publish-activity statuses from one status snapshot", async () => {
    const statuses = [
      "reserved",
      "pending",
      "pending",
      "publishing",
      "failed",
      "failed",
      "failed",
      "public_unconfirmed",
    ];
    const firestore = {
      collection(name) {
        expect(name).toBe("cmsPublishQueue");
        return {
          select(field) {
            expect(field).toBe("status");
            return {
              get: async () => ({
                docs: statuses.map((status) => ({ data: () => ({ status }) })),
              }),
            };
          },
        };
      },
    };
    const res = responseRecorder();
    const handler = createCmsListContentHandler({
      firestore,
      requirePrincipalFn: async () => ({
        uid: "admin-1",
        principal: { id: "admin-1", grants: [{ role: "admin" }] },
      }),
    });
    await handler({ method: "POST", body: { view: "publish_activity" } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, activeCount: 4, recoveryCount: 4 });
  });
});
