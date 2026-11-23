import { postFunction } from "./functions";
import type { PublicationRecheckResult } from "./functions";

interface SiteUpdateRecovery {
  queueId: string;
  createdAt: string | null;
  lastPublicCheck?: Pick<PublicationRecheckResult, "outcome" | "message">;
}

export interface PublishActivitySummary {
  activeCount: number;
  recoveryCount: number;
  postProofRecoveryIds?: string[];
  postProofRecoveryTruncated?: boolean;
  contextRecheckIds?: string[];
  contextRetry?: SiteUpdateRecovery | null;
}

export function summarizePublishActivity(
  items: readonly { status?: unknown }[],
): PublishActivitySummary {
  let activeCount = 0;
  let recoveryCount = 0;
  for (const item of items) {
    if (
      item.status === "reserved" ||
      item.status === "pending" ||
      item.status === "publishing"
    ) {
      activeCount += 1;
    }
    if (item.status === "failed" || item.status === "public_unconfirmed") {
      recoveryCount += 1;
    }
  }
  return { activeCount, recoveryCount };
}

export async function loadPublishActivitySummary(
  idToken: string,
  includePostProofRecovery = false,
): Promise<PublishActivitySummary> {
  const body = await postFunction<{
    success: true;
    activeCount: number;
    recoveryCount: number;
    postProofRecoveryIds?: string[];
    postProofRecoveryTruncated?: boolean;
    contextRecheckIds?: string[];
    contextRetry?: SiteUpdateRecovery | null;
  }>("cmsListContent", idToken, { view: "publish_activity", ...(includePostProofRecovery ? { includePostProofRecovery: true } : {}) });
  if (
    body?.success !== true
    || !Number.isSafeInteger(body.activeCount)
    || body.activeCount < 0
    || !Number.isSafeInteger(body.recoveryCount)
    || body.recoveryCount < 0
    || includePostProofRecovery && body.postProofRecoveryIds !== undefined &&
      (!Array.isArray(body.postProofRecoveryIds) || body.postProofRecoveryIds.length > 100 ||
        body.postProofRecoveryIds.some(id => typeof id !== "string" || !/^[A-Za-z0-9]{20}$/.test(id)))
    || includePostProofRecovery && body.contextRecheckIds !== undefined &&
      (!Array.isArray(body.contextRecheckIds) || body.contextRecheckIds.length > 100 ||
        body.contextRecheckIds.some(id => typeof id !== "string" || !/^[A-Za-z0-9]{20}$/.test(id)))
    || includePostProofRecovery && body.contextRetry != null &&
      (!/^[A-Za-z0-9]{20}$/.test(body.contextRetry.queueId) ||
        body.contextRetry.createdAt !== null && (typeof body.contextRetry.createdAt !== "string" || !Number.isFinite(Date.parse(body.contextRetry.createdAt))) ||
        body.contextRetry.lastPublicCheck !== undefined &&
          (!["confirmed_late", "superseded", "failed"].includes(body.contextRetry.lastPublicCheck?.outcome) ||
            typeof body.contextRetry.lastPublicCheck?.message !== "string"))
  ) {
    throw new Error("Publish activity is unavailable.");
  }
  return { activeCount: body.activeCount, recoveryCount: body.recoveryCount,
    ...(includePostProofRecovery ? { postProofRecoveryIds: body.postProofRecoveryIds ?? [],
      postProofRecoveryTruncated: body.postProofRecoveryTruncated === true, contextRetry: body.contextRetry ?? null,
      ...(body.contextRecheckIds ? { contextRecheckIds: body.contextRecheckIds } : {}) } : {}) };
}
