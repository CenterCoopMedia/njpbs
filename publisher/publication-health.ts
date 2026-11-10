import externalRefresh from "../functions/lib/cloud-external-refresh-state.js";
import cloudWork from "../functions/lib/no-build-cloud-work.js";
import ownership from "../functions/lib/publication-runtime-owner.js";
import projection from "../functions/lib/editorial-preview-projection.js";

const FAMILIES = ["listings", "authors", "feed", "contentApi", "sitemap", "search", "home", "programs", "events"];
export const OVERDUE_MS = 5 * 60_000;
type Read = (path: string) => Promise<Record<string, any> | null>;
type Runtime = { owner: "cloudflare"; release: string };

export type PublicationHealth = {
  healthy: boolean;
  reasons: string[];
  oldestDueAt: number | null;
};
export const publicationAttemptsExhausted = (record: Record<string, any> | null, now = Date.now()) => Boolean(record &&
  record.status !== "verified" && Number.isSafeInteger(record.attempts) && record.attempts >= 4 &&
  (record.nextAttemptAt === null || (Number.isFinite(record.nextAttemptAt) && record.nextAttemptAt <= now)));

/** Observe durable progress only. Neither a process HTTP 200 nor readable
 * last-good output proves that the replacement owner is making progress. */
export async function readPublicationHealth({ read, listOwners, runtime, now, clock = Date.now }: {
  read: Read; listOwners?: () => Promise<Record<string, any>[]>; runtime: Runtime; now?: number; clock?: () => number;
}): Promise<PublicationHealth> {
  ownership.publicationRuntime(runtime);
  const reasons = new Set<string>();
  let oldestDueAt: number | null = null;
  // A fresh document may contain writes committed after an earlier read. Use
  // the clock at observation, while fixed clocks keep contract checks repeatable.
  const observedAt = () => now ?? clock();
  const due = (at: unknown, progressAt: number | null = null) => {
    const current = observedAt();
    if (!Number.isFinite(at) || Number(at) < 0 || Number(at) > current) return;
    oldestDueAt = Math.min(oldestDueAt ?? current, Number(at));
    if (current - Math.max(Number(at), progressAt ?? 0) >= OVERDUE_MS) reasons.add("work_overdue");
  };
  const exhausted = (record: Record<string, any> | null) => publicationAttemptsExhausted(record, observedAt());

  const pointer = await read("system/publicDeployment");
  if (!pointer || !["idle", "deploying", "reconciling"].includes(pointer.state)) {
    throw new Error("Invalid publication health coordinator");
  }
  if (pointer.state !== "idle") {
    // An unresolved legacy lease also fences this owner. Keep its recovery with
    // the original runtime; observation must never transfer or clear the lease.
    if (!Number.isFinite(pointer.leaseAcquiredAt) || pointer.leaseAcquiredAt > observedAt()) {
      reasons.add("state_unreadable");
    } else due(pointer.leaseAcquiredAt);
    if (pointer.state === "reconciling") reasons.add("activation_uncertain");
    return { healthy: reasons.size === 0, reasons: [...reasons], oldestDueAt };
  }
  const context = await read("system/publicDeployment/contexts/public");
  if (context?.schemaVersion !== 1 || !Number.isSafeInteger(context.revision) || context.revision < 1) {
    throw new Error("Invalid publication health context");
  }
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`njpbs-public-context-v1:${context.revision}`));
  const digest = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
  const refresh = await read(externalRefresh.EXTERNAL_REFRESH_PATH);
  if (refresh) {
    externalRefresh.externalRefreshDue(refresh, runtime, observedAt());
    if (!externalRefresh.externalRefreshHeld(refresh, observedAt())) {
      due(refresh.status === "verified" ? refresh.nextAttemptAt : refresh.periodStartedAt);
    }
  } else if (pointer.activeCommitSha === runtime.release) {
    if (!Number.isFinite(context.changedAt) || context.changedAt < 0 || context.changedAt > observedAt()) reasons.add("state_unreadable");
    else due(context.changedAt);
  }
  const aggregate = await read("system/publicDeployment/aggregateContexts/current");
  let aggregateProgressAt: number | null = null;
  if (aggregate) {
    if (aggregate.schemaVersion !== 1 || !/^[A-Za-z0-9]{20}$/.test(aggregate.operationId ?? "") ||
        !ownership.samePublicationOwner(aggregate, runtime)) throw new Error("Invalid aggregate health owner");
    const queue = await read(`cmsPublishQueue/${aggregate.operationId}`);
    if (!queue || queue.transport !== "public-context-no-build-v1" || !ownership.samePublicationOwner(queue, runtime)) {
      reasons.add("state_unreadable");
    } else {
      const preparation = await read(`cmsPublishQueue/${aggregate.preparationOperationId ?? aggregate.operationId}/backgroundPreparation/${aggregate.contextDigest}`);
      aggregateProgressAt = cloudWork.publicContextProgressAt({ aggregate, queue, preparation, runtime, now: observedAt() });
      if (queue.status !== "success" || aggregate.contextDigest !== digest || !ownership.ownsPublication(aggregate, runtime)) {
        due(aggregate.pendingSince ?? (aggregate.contextDigest !== digest ? aggregate.followUp?.pendingSince ?? context.changedAt : aggregate.acceptedAt), aggregateProgressAt);
        if (preparation && ownership.samePublicationOwner(preparation, runtime) && preparation.status !== "verified") {
          if (exhausted(preparation)) reasons.add("preparation_exhausted");
          due(preparation.nextAttemptAt, aggregateProgressAt);
        }
      }
      const previewPreparation = ["pending", "failed"].includes(queue.status) &&
        /^[A-Za-z0-9]{20}$/.test(aggregate.preparationOperationId ?? "")
        ? await read(`cmsPublishQueue/${aggregate.preparationOperationId}/backgroundPreparation/${digest}`) : null;
      const previewEligible = aggregate.contextDigest === digest && ownership.ownsPublication(aggregate, runtime) &&
        (queue.status === "success" || projection.verifiedPreviewProjection(previewPreparation, runtime, digest) || previewPreparation?.status === "verified" &&
          ownership.ownsPublication(previewPreparation, runtime) && previewPreparation.contextDigest === digest &&
          /^[a-f0-9]{64}$/.test(previewPreparation.preparedDigest ?? ""));
      if (previewEligible) {
        const preview = queue.previewContext;
        let previewDue = false;
        try { previewDue = cloudWork.previewContextDue(queue, pointer, observedAt(), true, previewPreparation); }
        catch { reasons.add("state_unreadable"); }
        if (previewDue || preview?.status !== "verified") {
          const sameGeneration = preview?.publicationGeneration === pointer.activeGeneration;
          if (preview && !sameGeneration) {
            const updatedAt = pointer.updatedAt?.toMillis?.() ?? pointer.updatedAt;
            const acceptedAt = aggregate.acceptedAt;
            const current = observedAt();
            if (![updatedAt, acceptedAt].every(at => Number.isFinite(at) && at >= 0 && at <= current)) {
              reasons.add("state_unreadable");
            } else due(Math.max(updatedAt, acceptedAt), aggregateProgressAt);
          } else due(preview?.startedAt ?? aggregate.acceptedAt, aggregateProgressAt);
          if (sameGeneration && exhausted(preview)) reasons.add("preview_context_exhausted");
        }
      }
    }
  }
  // Observe durable current ownership even when admission, source, queue or
  // retry gates prevent execution. Historical preparations are never queried.
  const [legacy, owners] = await Promise.all([
    read("system/publicDeployment/noBuildPosts/current"), listOwners ? listOwners() : [],
  ]);
  if (!Array.isArray(owners)) throw new Error("Invalid publication health owners");
  const states = [...owners, ...(legacy ? [legacy] : [])];
  if (!aggregate && pointer.activeCommitSha === runtime.release) {
    if (!Number.isFinite(context.changedAt) || context.changedAt < 0 || context.changedAt > observedAt()) reasons.add("state_unreadable");
    else due(context.changedAt);
  }
  const seen = new Set<string>();
  for (const state of states) {
    if (!state || !/^[A-Za-z0-9_-]{1,128}$/.test(state.postId) || seen.has(state.postId)) {
      throw new Error("Ambiguous publication health ownership");
    }
    seen.add(state.postId);
    if (!state.operationId || state.mode === "static" || !ownership.samePublicationOwner(state, runtime)) continue;
    if (!/^[A-Za-z0-9]{20}$/.test(state.operationId)) throw new Error("Invalid publication health operation");
    const preparation = await read(`cmsPublishQueue/${state.operationId}/backgroundPreparation/${digest}`);
    if (preparation && ownership.samePublicationOwner(preparation, runtime) && preparation.status !== "verified") {
      if (exhausted(preparation)) reasons.add("preparation_exhausted");
      due(preparation.nextAttemptAt);
    }
  }
  for (const family of FAMILIES) {
    const output = await read(`cmsBackgroundOutputs/${family}`);
    if (!output) continue;
    if (family === "home" && output.owner === "page-no-build-v1") {
      const home = await read("system/publicDeployment/noBuildPageOwners/home");
      if (output.schemaVersion !== 1 || output.pageId !== "home" || output.ownerPath !== "system/publicDeployment/noBuildPageOwners/home" ||
          home?.pageId !== "home" || !Array.isArray(home.ownedPaths) || home.ownedPaths.length !== 2 ||
          !home.ownedPaths.includes("/") || !home.ownedPaths.includes("/_home-sources.json")) reasons.add("state_unreadable");
      continue;
    }
    if (!ownership.samePublicationOwner(output, runtime)) continue;
    const current = output.status === "verified" && output.contextDigest === digest &&
      output.receipt?.rendererSha === runtime.release;
    if (current) continue;
    const pendingSince = output.pendingSince ?? context.changedAt;
    if (!Number.isFinite(pendingSince) || pendingSince < 0 || pendingSince > observedAt()) reasons.add("state_unreadable");
    else due(pendingSince, output.contextOnly === true && output.taskPath ===
      `cmsPublishQueue/${aggregate?.namespaceOperationId}/backgroundOutputs/${family}` ? aggregateProgressAt : null);
    const good = output.status === "verified" && output.receipt ? { receipt: output.receipt, after: output.after } : output.lastGood;
    const withdrawalRevision = context.withdrawalRevision ?? 0;
    const withdrawal = good && (withdrawalRevision !== (good.receipt.withdrawalRevision ?? 0) ||
      (!output.contextOnly && output.after?.visible === false && good.after?.visible === true));
    if (withdrawal) {
      // Match the serving owner's repeated-removal rule: only the deadline for
      // this withdrawal revision may replace verification time plus 60 seconds.
      const pilotDeadline = output.withdrawalDeadlineRevision === withdrawalRevision ? output.withdrawalDeadline : null;
      const deadline = pilotDeadline ?? Math.min(good.receipt.verifiedAt, good.receipt.sourceReadAt ?? good.receipt.verifiedAt) + 60_000;
      if (!Number.isFinite(deadline)) reasons.add("state_unreadable");
      else if (observedAt() >= deadline) reasons.add("withdrawal_overdue");
    }
    if (typeof output.taskPath !== "string" ||
        !new RegExp(`^cmsPublishQueue/[A-Za-z0-9_-]{1,200}/backgroundOutputs/${family}(?:-[0-9]+)?$`).test(output.taskPath)) {
      throw new Error("Invalid publication health task");
    }
    const task = await read(output.taskPath);
    if (!task || !ownership.samePublicationOwner(task, runtime)) reasons.add("state_unreadable");
    else if (exhausted(task)) reasons.add("family_exhausted");
  }
  return { healthy: reasons.size === 0, reasons: [...reasons].sort(), oldestDueAt };
}
