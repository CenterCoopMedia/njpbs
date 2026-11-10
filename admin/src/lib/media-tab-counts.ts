import { HttpError } from "./functions";
import {
  beginMediaTabCountsRequest,
  clearMediaTabCounts,
  failMediaTabCountsRequest,
  finishMediaTabCountsRequest,
} from "./media-session-cache";

// An older Functions version rejects the flag as an unknown field or a non-empty body.
const FLAG_REJECTED = /\bcounts\b|empty object/i;

/**
 * Runs a list call the page already makes, adding `counts: true` only when this page session
 * has no counts yet or a write made them stale. The counts go to the session cache and never
 * into the returned list, so list caches and their keys stay as they were.
 */
export async function withMediaTabCounts<T extends { counts?: unknown }>(
  send: (withCounts: boolean) => Promise<T>,
): Promise<WithoutCounts<T>> {
  const request = beginMediaTabCountsRequest();
  if (!request) {
    try {
      return withoutCounts(await send(false));
    } catch (error) {
      clearAfterDenial(error);
      throw error;
    }
  }
  let response: T;
  try {
    response = await send(true);
  } catch (error) {
    if (error instanceof HttpError && error.status === 400 && FLAG_REJECTED.test(error.message)) {
      try {
        const plain = await send(false);
        finishMediaTabCountsRequest(request, undefined);
        return withoutCounts(plain);
      } catch (retryError) {
        failMediaTabCountsRequest(request);
        throw retryError;
      }
    }
    failMediaTabCountsRequest(request);
    clearAfterDenial(error);
    throw error;
  }
  finishMediaTabCountsRequest(request, response.counts);
  return withoutCounts(response);
}

// A denied list means the account's access changed: forget every count, not just this tab's.
function clearAfterDenial(error: unknown) {
  if (error instanceof HttpError && (error.status === 401 || error.status === 403)) clearMediaTabCounts();
}

type WithoutCounts<T> = T extends unknown ? Omit<T, "counts"> : never;

function withoutCounts<T extends { counts?: unknown }>(response: T): WithoutCounts<T> {
  const { counts: _counts, ...rest } = response;
  return rest as WithoutCounts<T>;
}
