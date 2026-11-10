import { describe, expect, it } from "vitest";
import { parseReviewQueueResponse } from "../src/lib/review-queue";

const request = {
  requestId: `review_${"0123456789abcdef".repeat(4)}`,
  collection: "cmsPosts",
  recordId: "record-1",
  contentType: "post",
  title: "Transit funding vote",
  state: "in_review",
  sourceVersion: 7,
  requestedByLabel: "Avery Author",
  requestedAt: "2026-08-20T16:00:00.000Z",
  assigneeLabel: null,
  recovered: false,
};

describe("editorial queue client contract", () => {
  it("accepts the authoritative lifecycle request shape", () => {
    expect(
      parseReviewQueueResponse({ success: true, requests: [request] }),
    ).toEqual({ success: true, requests: [{ ...request, contentVersion: request.sourceVersion }] });
  });

  it("accepts a canonical public-page request and a recovered row", () => {
    expect(
      parseReviewQueueResponse({
        success: true,
        requests: [
          {
            ...request,
            collection: "cmsPages",
            recordId: "watch",
            contentType: "page",
            requestedByLabel: null,
            recovered: true,
          },
        ],
      }).requests[0],
    ).toMatchObject({
      collection: "cmsPages",
      recordId: "watch",
      contentType: "page",
      recovered: true,
    });
  });

  it("rejects a row whose state and version cannot match reviewable content", () => {
    expect(() =>
      parseReviewQueueResponse({
        success: true,
        requests: [{ ...request, state: "draft" }],
      }),
    ).toThrow("invalid request");
    expect(() =>
      parseReviewQueueResponse({
        success: true,
        requests: [{ ...request, sourceVersion: 0 }],
      }),
    ).toThrow("invalid request");
  });

  it("rejects a request id outside the deterministic server identity contract", () => {
    expect(() =>
      parseReviewQueueResponse({
        success: true,
        requests: [{ ...request, requestId: "review_record-1" }],
      }),
    ).toThrow("invalid request");
  });

  it("rejects raw account ids in place of the staff-facing label contract", () => {
    expect(() =>
      parseReviewQueueResponse({
        success: true,
        requests: [
          {
            ...request,
            requestedByLabel: undefined,
            requestedBy: "author-1",
          },
        ],
      }),
    ).toThrow("invalid request");
  });

  it("rejects mismatched collection and content types", () => {
    expect(() =>
      parseReviewQueueResponse({
        success: true,
        requests: [{ ...request, collection: "cmsPages" }],
      }),
    ).toThrow("invalid request");
    expect(() =>
      parseReviewQueueResponse({
        success: true,
        requests: [{ ...request, contentType: "unknown" }],
      }),
    ).toThrow("invalid request");
  });

  it("keeps a request for a retired kind readable in the queue", () => {
    // Article was retired (#1039). A request submitted before that must still parse,
    // or the queue would silently drop work that is genuinely waiting; the list
    // refuses to link it, because no editor route resolves for a retired kind.
    expect(
      parseReviewQueueResponse({
        success: true,
        requests: [{ ...request, contentType: "article" }],
      }).requests[0],
    ).toMatchObject({ contentType: "article" });
  });

  it("rejects a malformed response instead of rendering a partial queue", () => {
    expect(() => parseReviewQueueResponse(null)).toThrow("invalid response");
    expect(() =>
      parseReviewQueueResponse({ success: true, requests: {} }),
    ).toThrow("invalid response");
  });
});
