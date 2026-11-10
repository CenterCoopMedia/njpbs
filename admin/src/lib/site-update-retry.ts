import { postFunction } from "./functions";

export interface SiteUpdateRetryResult {
  success: true;
  queueId: string;
  status: "pending";
  message: string;
}

export function retrySiteUpdate(idToken: string, queueId: string) {
  return postFunction<SiteUpdateRetryResult>("cmsPublish", idToken, { aggregateRetryQueueId: queueId, retry: true });
}
