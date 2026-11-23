import {
  collection,
  documentId,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  where,
  type DocumentData,
} from "firebase/firestore";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { canManageSettings, canPublishContent, canViewPublishActivity } from "../lib/access";
import { retrySiteUpdate } from "../lib/site-update-retry";
import type { SiteUpdateRetryResult } from "../lib/site-update-retry";
import { cmsRecheckPublication } from "../lib/functions";
import { loadPublishActivitySummary } from "../lib/publish-activity";
import { db } from "../lib/firebase";
import {
  cmsListReviewQueue,
  type ReviewQueueItem,
} from "../lib/review-queue";
import { useShell } from "../routes/ShellContext";
import type { QueueItem } from "./QueueList";
import { QueueSurface } from "./QueueSurface";
import { PUBLISH_ATTENTION_LIMIT, PUBLISH_HISTORY_LIMIT, PUBLISH_RECOVERY_LIMIT } from "../lib/listener-limits";

function valueToDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (
    value &&
    typeof value === "object" &&
    "toDate" in value &&
    typeof value.toDate === "function"
  ) {
    return value.toDate();
  }
  if (typeof value === "number" || typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function queueItemFromDoc(id: string, data: DocumentData, settingsAccess: boolean): QueueItem {
  const legacyContext = data.transport === "public-context-no-build-v1";
  const pairedContext = data.transport === "release-pair-publication-v2";
  const automaticContext = (legacyContext &&
    !data.settingsPublication && !data.libraryCardPublication && !data.recordPublication &&
    Array.isArray(data.changes) && data.changes.length === 0) || (pairedContext && !data.familyPublication);
  const requesterId =
    typeof data.triggeredBy === "string" && data.triggeredBy.trim()
      ? data.triggeredBy
      : null;
  const requesterEmail =
    typeof data.triggeredByEmail === "string" && data.triggeredByEmail.trim()
      ? data.triggeredByEmail
      : null;
  const contextRecheck = legacyContext
    ? Boolean(data.recordPublication || data.libraryCardPublication || settingsAccess && (automaticContext || data.settingsPublication))
    : pairedContext && (data.familyPublication?.kind === "record" ||
      settingsAccess && (!data.familyPublication || data.familyPublication.kind === "settings"));
  let status = typeof data.status === "string" ? data.status : "unknown";
  let check = data.lastPublicCheck;
  if (legacyContext || pairedContext) {
    if (check?.queueStatus !== status || check?.alertEpoch !== (data.alertEpoch ?? null)) check = undefined;
    if (check?.outcome === "confirmed_late") status = "success";
    else if (check?.outcome === "superseded") status = "superseded";
    else if (legacyContext && status === "success") {
      const identity = data.recordPublication ?? data.settingsPublication ?? data.libraryCardPublication;
      const consumers = data.recordPublication ? ["pages", "home", "posts", "record"] : ["pages", "home", "posts"];
      const missingProof = identity && consumers.some(name => {
        const proof = data.consumerReceipts?.[name];
        return proof?.rendererSha !== identity.rendererSha || proof?.contextDigest !== identity.contextDigest ||
          proof?.contextRevision !== identity.contextRevision || !(proof?.verifiedAt > 0);
      });
      const startedAt = valueToDate(data.recordRetryAt ?? data.settingsRetryAt ?? data.cardRetryAt ?? data.triggeredAt ?? data.createdAt);
      if (missingProof) status = startedAt && Date.now() - startedAt.getTime() >= 5 * 60_000 ? "public_unconfirmed" : "checking";
      if (status !== "public_unconfirmed") check = undefined;
    }
  }
  return {
    id,
    status,
    contextRecheck,
    automaticSiteUpdate: automaticContext,
    triggeredBy:
      requesterEmail ?? requesterId ?? (automaticContext ? "Automatic site update" : null),
    triggeredById: requesterId,
    changes: automaticContext ? ["Site-wide update"] : legacyContext && data.settingsPublication ? ["Site settings update"] :
      legacyContext && data.recordPublication ? [data.recordPublication.family === "programs" ? "Program update" : "Event update"] :
        legacyContext && data.libraryCardPublication ? ["Library card update"] : data.changes,
    timestamp: valueToDate(data.triggeredAt ?? (data.transport === "public-context-no-build-v1" ? data.createdAt : undefined)),
    completedAt: valueToDate(data.completedAt),
    error: automaticContext && data.status === "failed" ? "The accepted site update did not complete."
      : automaticContext && data.error === "public_context_superseded" ? "A newer site update took its place."
      : typeof data.error === "string" ? data.error : null,
    transport: typeof data.transport === "string" ? data.transport : null,
    proofExhausted: data.transport === "post-no-build-v1" && data.status === "success" &&
      data.postProof?.status === "failed" && data.postProof.nextAttemptAt === null &&
      Number.isSafeInteger(data.postProof.attempts) && data.postProof.attempts >= 4,
    ...(typeof check?.message === "string" ? {
      recheckMessage: check.message,
      recheckOutcome: check.outcome,
    } : {}),
  };
}

export function QueueTab() {
  const { principal } = useShell();
  const { getIdToken } = useAuth();
  const showPublishActivity = canViewPublishActivity(principal);
  const settingsAccess = canManageSettings(principal);

  const [reviewRequests, setReviewRequests] = useState<ReviewQueueItem[]>([]);
  const [reviewLoading, setReviewLoading] = useState(true);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewAttempt, setReviewAttempt] = useState(0);

  const [publishItems, setPublishItems] = useState<QueueItem[]>([]);
  const [publishLoading, setPublishLoading] = useState(showPublishActivity);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [publishRecoveryError, setPublishRecoveryError] = useState<string | null>(null);
  const [publishRecoveryLoading, setPublishRecoveryLoading] = useState(false);
  const [publishAttempt, setPublishAttempt] = useState(0);
  const [publishRecoveryTruncated, setPublishRecoveryTruncated] = useState(false);
  const [siteUpdateResult, setSiteUpdateResult] = useState<SiteUpdateRetryResult & { focusOnAccept: boolean } | null>(null);
  const siteUpdateObservation = useRef<{ queueId: string; changed: boolean } | null>(null);
  const proofRecoveryItems = useRef<QueueItem[]>([]);

  useEffect(() => {
    let current = true;
    setReviewLoading(true);
    setReviewError(null);

    void (async () => {
      try {
        const idToken = await getIdToken();
        const response = await cmsListReviewQueue(idToken);
        if (!current) return;
        setReviewRequests(response.requests);
        setReviewLoading(false);
      } catch (error) {
        if (!current) return;
        setReviewLoading(false);
        setReviewError(
          error instanceof Error
            ? error.message
            : "The editorial queue could not be loaded.",
        );
      }
    })();

    return () => {
      current = false;
    };
  }, [getIdToken, reviewAttempt]);

  useEffect(() => {
    setSiteUpdateResult(null);
    if (!showPublishActivity) {
      setPublishItems([]);
      setPublishLoading(false);
      setPublishError(null);
      setPublishRecoveryError(null);
      setPublishRecoveryLoading(false);
      return;
    }

    setPublishLoading(true);
    setPublishError(null);
    setPublishRecoveryError(null);
    setPublishRecoveryLoading(true);
    const reads = [
      { source: query(collection(db, "cmsPublishQueue"), orderBy("triggeredAt", "desc"),
        limit(PUBLISH_HISTORY_LIMIT)), items: null as QueueItem[] | null, error: null as string | null },
      // Active jobs must survive the recent-history window. Failed history has
      // its own recency bound so old failures cannot fill the active-job limit.
      { source: query(collection(db, "cmsPublishQueue"),
        where("status", "in", ["reserved", "pending", "publishing", "checking"]),
        limit(PUBLISH_ATTENTION_LIMIT + 1)), items: null as QueueItem[] | null, error: null as string | null },
      { source: query(collection(db, "cmsPublishQueue"),
        where("status", "in", ["failed", "public_unconfirmed"]), orderBy("triggeredAt", "desc"),
        limit(PUBLISH_RECOVERY_LIMIT + 1)), items: null as QueueItem[] | null, error: null as string | null },
    ];
    let current = true;
    let recoveryTruncated = false, proofTruncated = false;
    proofRecoveryItems.current = [];
    function updateItems() {
      if (!current) return;
      const error = reads.find(read => read.error)?.error;
      if (error) {
        setPublishLoading(false);
        setPublishError(error);
        return;
      }
      if (reads.some(read => read.items === null)) return;
      const proofItems = new Map(proofRecoveryItems.current.map(item => [item.id, item]));
      const items = new Map([...proofItems, ...reads.flatMap(read => read.items!.map(item => [item.id, item] as const))]);
      setPublishItems([...items.values()].map(item => ({ ...item,
        proofRecovery: proofItems.get(item.id)?.proofRecovery === true && item.proofExhausted === true,
        contextRetry: proofItems.get(item.id)?.contextRetry === true,
      })).sort((a, b) => (b.timestamp?.getTime() ?? 0) - (a.timestamp?.getTime() ?? 0)));
      setPublishRecoveryTruncated(recoveryTruncated || proofTruncated);
      setPublishLoading(false);
      setPublishError(null);
    }
    const stops = reads.map((read, index) => onSnapshot(read.source, snapshot => {
      if (!current) return;
      if (siteUpdateObservation.current && snapshot.docs.some(row => row.id === siteUpdateObservation.current!.queueId)) {
        siteUpdateObservation.current.changed = true;
      }
      read.error = index === 1 && snapshot.docs.length > PUBLISH_ATTENTION_LIMIT
        ? "Too many active publication requests. Contact a Site owner." : null;
      if (index === 2) recoveryTruncated = snapshot.docs.length > PUBLISH_RECOVERY_LIMIT;
      const rows = index === 2 ? snapshot.docs.slice(0, PUBLISH_RECOVERY_LIMIT) : snapshot.docs;
      read.items = rows.map(row => queueItemFromDoc(row.id, row.data(), settingsAccess));
      updateItems();
    }, error => {
      read.error = error.message;
      updateItems();
    }));
    // Recovery membership is a bounded current-only server read on opening or
    // explicit refresh. Live history snapshots never repeat the queue scan.
    void (async () => {
      try {
        const summary = await loadPublishActivitySummary(await getIdToken(), true);
        if (!current) return;
        const postProofIds = new Set(summary.postProofRecoveryIds);
        const ids = [...new Set([...postProofIds, ...(summary.contextRecheckIds ?? [])])];
        const items: QueueItem[] = [];
        for (let offset = 0; offset < ids.length; offset += 30) {
          const rows = await getDocs(query(collection(db, "cmsPublishQueue"),
            where(documentId(), "in", ids.slice(offset, offset + 30))));
          if (!current) return;
          items.push(...rows.docs.map(row => ({ ...queueItemFromDoc(row.id, row.data(), settingsAccess), proofRecovery: postProofIds.has(row.id) })));
        }
        if (summary.contextRetry) {
          const { queueId, createdAt, lastPublicCheck } = summary.contextRetry;
          const status = lastPublicCheck?.outcome === "confirmed_late" ? "success" : lastPublicCheck?.outcome === "superseded" ? "superseded" : "failed";
          items.push({ id: queueId, status, contextRecheck: settingsAccess, transport: "public-context-no-build-v1",
            automaticSiteUpdate: true, contextRetry: status === "failed", timestamp: valueToDate(createdAt),
            triggeredBy: "Automatic site update", changes: ["Site-wide update"], error: "The accepted site update did not complete.",
            ...(lastPublicCheck ? { recheckMessage: lastPublicCheck.message, recheckOutcome: lastPublicCheck.outcome } : {}) });
        }
        proofRecoveryItems.current = items;
        proofTruncated = summary.postProofRecoveryTruncated === true;
        setPublishRecoveryLoading(false);
        updateItems();
      } catch {
        if (!current) return;
        setPublishRecoveryLoading(false);
        setPublishRecoveryError("Recent and failed requests are still shown. Try again to include older public checks and site updates.");
      }
    })();
    return () => { current = false; stops.forEach(stop => stop()); };
  }, [getIdToken, publishAttempt, settingsAccess, showPublishActivity]);

  return <QueueSurface
    reviewRequests={reviewRequests} reviewLoading={reviewLoading} reviewError={reviewError}
    onReviewRefresh={() => setReviewAttempt((value) => value + 1)}
    showPublishActivity={showPublishActivity} publishItems={publishItems}
    publishLoading={publishLoading} publishError={publishError}
    publishRecoveryError={publishRecoveryError} publishRecoveryLoading={publishRecoveryLoading}
    publishRecoveryTruncated={publishRecoveryTruncated}
    onPublishRefresh={() => setPublishAttempt((value) => value + 1)}
    siteUpdateResult={siteUpdateResult}
    onRetrySiteUpdate={canManageSettings(principal) ? async (queueId, control) => {
      const observed = { queueId, changed: false };
      siteUpdateObservation.current = observed;
      try {
        const result = await retrySiteUpdate(await getIdToken(), queueId);
        proofRecoveryItems.current = proofRecoveryItems.current.filter(item => item.id !== queueId);
        setPublishItems(items => items.map(item => item.id === queueId ? {
          ...item, ...(observed.changed ? {} : { status: "pending" }), contextRetry: false,
        } : item));
        setSiteUpdateResult({ ...result, focusOnAccept: document.activeElement === control });
        return result;
      } finally {
        if (siteUpdateObservation.current === observed) siteUpdateObservation.current = null;
      }
    } : undefined}
    onCheckAgain={canPublishContent(principal) ? async queueId => {
      const result = await cmsRecheckPublication(await getIdToken(), queueId);
      if (result.outcome !== "failed") {
        const settled = (item: QueueItem): QueueItem => item.id !== queueId ? item : {
          ...item, proofRecovery: false, proofExhausted: false,
          recheckMessage: result.message, recheckOutcome: result.outcome,
          status: result.outcome === "superseded" && item.status !== "success" ? "superseded" : "success",
        };
        proofRecoveryItems.current = proofRecoveryItems.current.map(settled);
        setPublishItems(items => items.map(settled));
      }
      return result;
    } : undefined}
  />;
}
