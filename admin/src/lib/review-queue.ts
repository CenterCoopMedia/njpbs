import { isLibraryRecordKind, type LibraryRecordKind } from "./content-vocab";
import { postFunction } from "./functions";

type ReviewQueueItemBase = {
  requestId: string;
  recordId: string;
  title: string;
  state: "in_review";
  sourceVersion: number;
  contentVersion?: number;
  requestedByLabel: string | null;
  requestedAt: string | null;
  assigneeLabel: string | null;
  recovered: boolean;
};

export type ReviewQueueItem =
  | (ReviewQueueItemBase & {
      collection: "cmsPages";
      contentType: "page";
    })
  | (ReviewQueueItemBase & {
      collection: "cmsPosts";
      // Read state, so a request submitted before a kind was retired still parses
      // and stays visible in the queue. ReviewQueueList refuses to link one,
      // because a retired kind has no editor route.
      contentType: LibraryRecordKind;
    });

export interface ReviewQueueResponse {
  success: true;
  requests: ReviewQueueItem[];
}

const REVIEW_REQUEST_ID_PATTERN = /^review_[a-f0-9]{64}$/;

function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function reviewQueueItem(value: unknown): ReviewQueueItem | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const row = value as Record<string, unknown>;
  const collection = row.collection;
  const contentType = row.contentType;
  const requestedByLabel = nullableString(row.requestedByLabel);
  const requestedAt = nullableString(row.requestedAt);
  const assigneeLabel = nullableString(row.assigneeLabel);
  const contentVersion = row.contentVersion ?? row.sourceVersion;
  if (
    (collection !== "cmsPages" && collection !== "cmsPosts") ||
    typeof row.requestId !== "string" ||
    !REVIEW_REQUEST_ID_PATTERN.test(row.requestId) ||
    typeof row.recordId !== "string" ||
    row.recordId.length === 0 ||
    typeof row.title !== "string" ||
    row.state !== "in_review" ||
    !Number.isSafeInteger(row.sourceVersion) ||
    (row.sourceVersion as number) < 1 ||
    !Number.isSafeInteger(contentVersion) ||
    (contentVersion as number) < 1 ||
    requestedByLabel === undefined ||
    requestedAt === undefined ||
    assigneeLabel === undefined ||
    typeof row.recovered !== "boolean" ||
    (requestedAt !== null && Number.isNaN(Date.parse(requestedAt)))
  ) {
    return null;
  }

  const base = {
    requestId: row.requestId,
    recordId: row.recordId,
    title: row.title,
    state: "in_review" as const,
    sourceVersion: row.sourceVersion as number,
    contentVersion: contentVersion as number,
    requestedByLabel,
    requestedAt,
    assigneeLabel,
    recovered: row.recovered,
  };

  if (collection === "cmsPages") {
    return contentType === "page"
      ? { ...base, collection, contentType }
      : null;
  }
  return typeof contentType === "string" && isLibraryRecordKind(contentType)
    ? { ...base, collection, contentType }
    : null;
}

export function parseReviewQueueResponse(value: unknown): ReviewQueueResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("The editorial queue returned an invalid response.");
  }
  const response = value as Record<string, unknown>;
  if (response.success !== true || !Array.isArray(response.requests)) {
    throw new Error("The editorial queue returned an invalid response.");
  }
  const requests = response.requests.map(reviewQueueItem);
  if (requests.some((request) => request === null)) {
    throw new Error("The editorial queue returned an invalid request.");
  }
  return { success: true, requests: requests as ReviewQueueItem[] };
}

export async function cmsListReviewQueue(
  idToken: string,
): Promise<ReviewQueueResponse> {
  return parseReviewQueueResponse(
    await postFunction("cmsListContent", idToken, { view: "review_queue" }),
  );
}

export async function cmsCountReviewQueue(idToken: string): Promise<number> {
  const body = await postFunction<{ success: true; count: number }>(
    "cmsListContent",
    idToken,
    { view: "review_queue", countOnly: true },
  );
  if (body?.success !== true || !Number.isSafeInteger(body.count) || body.count < 0) {
    throw new Error("The editorial queue returned an invalid response.");
  }
  return body.count;
}
