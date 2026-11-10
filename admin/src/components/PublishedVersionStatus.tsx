import { Children, useEffect, useId, useState } from "react";
import { contentStatusPresentation, displayContentStatus, displayLiveVersion } from "../lib/content-status";
import type { ContentPublicationMetadata } from "../lib/functions";
import { publicContentKey } from "../lib/public-content-status";
import { usePublicationMetadata, usePublicationRetry, usePublicationRecheck, usePublicContentStatus } from "../context/PublicContentStatusContext";
import { PublicationRecheckAction } from "./PublicationRecheckAction";
import { PUBLIC_PAGES } from "../../../packages/content-core/src/public-pages";
import { Icon } from "./ui/Icon";
import { LoadingIndicator } from "./ui/LoadingIndicator";
import { AsyncActionButton, StatusBadge } from "./ui/Primitives";
import { Tooltip } from "./ui/Tooltip";

// The publish pipeline's in-flight queue states, in order, and what each one is doing
// The indicator shows the real stage, never a cycle.
export const PUBLISH_PROGRESS_STAGES = [
  "Reserved a slot in the publish queue",
  "Waiting for the publish service to pick up the job",
  "Building, uploading and activating the public site",
] as const;

export function publishProgressStage(queueStatus: string | null | undefined): number {
  if (queueStatus === "reserved") return 0;
  if (queueStatus === "pending") return 1;
  return 2;
}

// A build-free Page has no publish service to wait for: its public check starts
// on acceptance, and a failed public read schedules the next check.
export const PAGE_PUBLISH_PROGRESS_STAGES = [
  "Publication accepted",
  "Checking the public page",
  "Waiting to check the public page again",
] as const;

export function pagePublishProgressStage(check: ContentPublicationMetadata["pageConfirmation"] | undefined): number {
  if (check?.checking) return 1;
  if ((check?.attempts ?? 0) > 0) return 2;
  return 0;
}

export function PublishedVersionStatus({
  liveSourceVersion,
  publicUpdatePending = false,
  publicBuildQueueId,
  pendingSourceVersion,
  workingVersion,
  contentVersion,
  publishedSourceVersion,
  publishedContentVersion,
  pageReceipt,
  recordPublication,
  publicationTransport,
  collection,
  documentId,
  canRetry = false,
  canRetryWithdrawal = false,
  compact = false,
  unknownLabel = "Public status unavailable",
  loadPublicationMetadata = true,
  watchPublicReceipts = true,
  workingStatus,
  recordTitle,
  statusOnly = false,
  detailsOnly = false,
  documentBar,
  alertsOnly = false,
  "aria-live": ariaLive,
}: {
  liveSourceVersion?: number | null;
  publicUpdatePending?: boolean;
  publicBuildQueueId?: string | null;
  pendingSourceVersion?: number;
  workingVersion?: number;
  contentVersion?: number;
  publishedSourceVersion?: number;
  publishedContentVersion?: number;
  pageReceipt?: { operationId: string; sourceVersion: number; visible: boolean };
  recordPublication?: ContentPublicationMetadata["recordPublication"];
  publicationTransport?: "page-no-build-v1";
  collection?: "cmsPages" | "cmsPosts";
  documentId?: string;
  canRetry?: boolean;
  canRetryWithdrawal?: boolean;
  compact?: boolean;
  unknownLabel?: string;
  loadPublicationMetadata?: boolean;
  watchPublicReceipts?: boolean;
  workingStatus?: string;
  recordTitle?: string;
  statusOnly?: boolean;
  detailsOnly?: boolean;
  documentBar?: { kind: "page" | "post"; draftState: "saved" | "dirty" | "saving" | "new" };
  alertsOnly?: boolean;
  "aria-live"?: "off" | "polite" | "assertive";
}) {
  const draftDescriptionId = useId();
  const publicStatus = usePublicContentStatus({ watch: watchPublicReceipts });
  const metadata = usePublicationMetadata(
    loadPublicationMetadata ? collection : undefined,
    loadPublicationMetadata ? documentId : undefined,
    workingVersion,
  );
  const saved = metadata?.data && (!workingVersion || (metadata.data.workingVersion ?? 0) >= workingVersion)
    ? metadata.data : null;
  const retry = usePublicationRetry();
  const recheck = usePublicationRecheck();
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const identity = collection && documentId ? `${collection}/${documentId}` : null;
  const [key, setKey] = useState<{ identity: string; value: string } | null>(null);
  useEffect(() => {
    if (!collection || !documentId || !identity) return;
    let stopped = false;
    void publicContentKey(collection, documentId).then((value) => {
      if (!stopped) setKey({ identity, value });
    }).catch(() => { if (!stopped) setKey(null); });
    return () => { stopped = true; };
  }, [collection, documentId, identity]);

  const page = collection === "cmsPages" ? PUBLIC_PAGES.find((entry) => entry.id === documentId) : null;
  const matchingKey = key?.identity === identity ? key?.value : null;
  // Every unowned Page, Contact included, is served from the committed context
  // that the public inventory describes. Owned Pages carry their own receipt.
  const route = publicStatus?.routes.find((entry) => entry.contentKey === matchingKey ||
    (entry.source === "site" && entry.path === page?.path));
  const pendingVersion = saved?.publishedSourceVersion ?? publishedSourceVersion ?? pendingSourceVersion;
  const servedPost = !metadata?.unavailable && collection === "cmsPosts" && saved?.postServingConfirmed === true &&
    saved.publiclyVisible && saved.queueStatus === "success" && !saved.publicUpdatePending &&
    saved.publicSourceVersion === pendingVersion;
  const confirmedPage = saved ? saved.pageReceipt : pageReceipt;
  const pageConfirmed = !metadata?.unavailable && collection === "cmsPages" &&
    (saved ? saved.queueStatus === "success" : !publicUpdatePending) && confirmedPage &&
    confirmedPage.sourceVersion === pendingVersion && (!saved || confirmedPage.visible === saved.publiclyVisible);
  const noBuildPage = (saved?.publicationTransport ?? publicationTransport) === "page-no-build-v1";
  const confirmedRecord = saved ? saved.recordPublication : recordPublication;
  const recordConfirmed = !metadata?.unavailable && confirmedRecord?.status === "success" &&
    (saved ? saved.queueStatus === "success" && !saved.publicUpdatePending && confirmedRecord.withdrawal === !saved.publiclyVisible : !publicUpdatePending) &&
    confirmedRecord.sourceVersion === pendingVersion;
  const canConfirm = Boolean(recordConfirmed || pageConfirmed || !noBuildPage && !confirmedRecord &&
    identity && matchingKey && publicStatus?.state === "current" && (!page || route));
  const actualVersion = recordConfirmed ? (confirmedRecord.withdrawal ? null : confirmedRecord.sourceVersion) : pageConfirmed ? (confirmedPage!.visible ? confirmedPage!.sourceVersion : null) : canConfirm ? route?.sourceVersion : null;
  const pending = saved?.publicUpdatePending ?? publicUpdatePending;
  const queueId = saved ? saved.publicBuildQueueId : publicBuildQueueId;
  const withdrawal = (saved ? saved.publiclyVisible === false : confirmedRecord?.withdrawal === true) && Boolean(pendingVersion);
  const effectConfirmed = servedPost || (canConfirm && (withdrawal ? !actualVersion : actualVersion === pendingVersion));
  const removalBuildPending = withdrawal && (Boolean(saved?.homeWarning) || saved?.withdrawalBuildPending === true) && saved?.queueStatus !== "success";
  const settlementSucceeded = saved?.queueStatus === "success" || Boolean(saved &&
    !saved.queueStatus && !pending && !queueId &&
    (withdrawal ? saved.publicSourceVersion === null : saved.publicSourceVersion === pendingVersion));
  const queueActive = ["reserved", "pending", "publishing"].includes(saved?.queueStatus ?? "");
  const stillPending = (pending || queueActive) && (!effectConfirmed || removalBuildPending);
  const waitingForConfirmation = withdrawal
    ? "Waiting for public removal confirmation" : "Waiting for public confirmation";
  const version = saved?.workingVersion ?? workingVersion;
  const editorialVersion = saved?.contentVersion ?? contentVersion ?? version;
  const publishedVersion = saved?.publishedContentVersion ?? publishedContentVersion;
  let progress = "";
  let progressActive = false;
  if (stillPending) {
    const subject = withdrawal ? "Removal" : "The saved copy";
    if (metadata?.unavailable || saved?.queueStatus === "unavailable") progress = "Publish progress unavailable. Check again shortly.";
    else if (saved?.queueStatus === "failed" && saved.recheckQueueId) progress = withdrawal
      ? "Public removal could not be confirmed. Check again or retry removal."
      : "The public update could not be confirmed. Check again or retry publication.";
    else if (["failed", "cancelled", "superseded"].includes(saved?.queueStatus ?? "")) progress = withdrawal
      ? "Removal did not complete. Retry removal." : `${subject} was not published. Retry publication.`;
    else if (saved?.queueStatus === "public_unconfirmed" || saved?.queueStatus === "success") progress = waitingForConfirmation;
    else if (!queueId) progress = withdrawal
      ? "Removal has not started. Retry removal." : "The public update has not started. Retry publication.";
    else if (saved?.queueStatus === "pending" && noBuildPage) {
      progress = withdrawal ? "Removing from the public site" : `${subject} is publishing`;
      progressActive = true;
    } else if (saved?.queueStatus === "pending" || saved?.queueStatus === "reserved") {
      progress = `${subject} is queued`;
      progressActive = true;
    } else if (saved?.queueStatus === "publishing") {
      progress = withdrawal ? "Removing from the public site" : `${subject} is publishing`;
      progressActive = true;
    } else {
      progress = "Checking publication status.";
    }
  } else if (!servedPost && saved?.postProofStatus !== "failed" && canConfirm && saved?.publiclyVisible && pendingVersion && actualVersion !== pendingVersion) {
    progress = waitingForConfirmation;
  } else if (canConfirm && saved && !saved.publiclyVisible && actualVersion) {
    progress = waitingForConfirmation;
  }
  const retryAvailable = Boolean(retry && collection && documentId && saved?.workingVersion && pendingVersion &&
    (withdrawal ? canRetryWithdrawal : canRetry) && (!effectConfirmed || removalBuildPending) && !settlementSucceeded && !metadata?.unavailable &&
    (pending || canConfirm || ["failed", "cancelled", "superseded", "public_unconfirmed"].includes(saved?.queueStatus ?? "")) &&
    (saved?.queueStatus === "reserved" ? saved.canResumeReservation === true
      : !["pending", "publishing", "success", "unavailable"].includes(saved?.queueStatus ?? "")));
  let liveLabel = typeof liveSourceVersion === "number" ? "Published copy live" : displayLiveVersion(liveSourceVersion, publicUpdatePending);
  if (saved?.postProofStatus === "failed") {
    liveLabel = "Public check failed";
  } else if (servedPost) {
    liveLabel = publishedVersion ? `Version ${publishedVersion} live` : "Published copy live";
  } else if (recordConfirmed) {
    liveLabel = !confirmedRecord.withdrawal ? (publishedVersion ? `Version ${publishedVersion} live` : "Published copy live") : "Not live";
  } else if (pageConfirmed) {
    liveLabel = confirmedPage.visible ? (publishedVersion ? `Version ${publishedVersion} live` : "Published copy live") : "Not live";
  } else if (identity && watchPublicReceipts) {
    if (canConfirm) {
      liveLabel = !pageConfirmed && route?.source === "site" ? "Site content live" : actualVersion ? (actualVersion === pendingVersion && publishedVersion ? `Version ${publishedVersion} live` : "Published copy live") : "Not live";
    } else if (publicStatus?.state === "checking") {
      liveLabel = "Checking public site…";
    } else {
      liveLabel = unknownLabel;
    }
  }
  const confirmedVersion = servedPost ? saved.publicSourceVersion
    : recordConfirmed || pageConfirmed ? actualVersion : identity && watchPublicReceipts ? actualVersion : liveSourceVersion;
  // The public receipt identifies a transaction, not an editorial revision.
  // Compare editorial numbers only for the snapshot confirmed by that receipt.
  // Legacy records still use their transaction number as the display baseline.
  const confirmedContentVersion = confirmedVersion === pendingVersion && publishedVersion
    ? publishedVersion
    : editorialVersion === version ? confirmedVersion : undefined;
  const workingIsNewer = !stillPending && typeof editorialVersion === "number" &&
    typeof confirmedContentVersion === "number" && editorialVersion > confirmedContentVersion;

  const publicState = saved?.postProofStatus === "failed" ? "unknown"
    : identity && watchPublicReceipts && !canConfirm && !servedPost ? "unknown"
    : ((!pageConfirmed && !recordConfirmed && identity && route?.source === "site") || (Number.isSafeInteger(confirmedVersion) && Number(confirmedVersion) > 0))
      ? "live" : "not-live";

  const unified = workingStatus !== undefined;
  const presentation = contentStatusPresentation({
    status: saved?.workingStatus ?? workingStatus,
    publicState,
    liveLabel,
    contentVersion: saved?.contentVersion ?? contentVersion,
    // Only the confirmed snapshot's editorial counter can prove a newer draft.
    // Missing counters during a Functions/Admin deploy never fall back to transactions.
    liveContentVersion: confirmedVersion === pendingVersion ? publishedVersion : undefined,
    savedVersion: version,
    siteContentLive: !pageConfirmed && !recordConfirmed && route?.source === "site",
    withdrawn: withdrawal,
  });
  const statusLabel = unified ? (
    <>
      <StatusBadge tone={presentation.tone}
        className={presentation.newerDraft ? "content-status-with-draft" : undefined}>
        <span className="content-status-text">{presentation.label}</span>
        {presentation.newerDraft ? (
          <Tooltip content="Newer draft available" openOnClick>
            <button type="button" className="content-status-draft"
              aria-label={`Draft status for ${recordTitle || documentId || "this record"}`} aria-describedby={draftDescriptionId}>
              <Icon name="pencil" />
            </button>
          </Tooltip>
        ) : null}
      </StatusBadge>
      {presentation.newerDraft ? <span className="sr-only" id={draftDescriptionId}>Newer draft available</span> : null}
    </>
  ) : (
    <span className="published-version-label">
      <Icon name={publicState === "live" ? "check" : publicState === "unknown" ? "info" : "eye-off"} />
      {liveLabel}
    </span>
  );

  if (documentBar) {
    const draft = workingStatus === "draft" || workingStatus === undefined;
    const label = documentBar.draftState === "new" ? "New draft" : documentBar.draftState === "saving" ? "Saving…" : documentBar.draftState === "dirty" ? "Unsaved changes"
      : draft ? documentBar.kind === "post" ? "Captured draft" : "Draft saved" : displayContentStatus(workingStatus);
    const live = publicState === "live" && typeof confirmedContentVersion === "number" ? `v${confirmedContentVersion} live` : liveLabel;
    const revision = documentBar.kind === "post" && draft && editorialVersion ? `Draft v${editorialVersion}` : workingIsNewer ? "Newer draft" : null;
    return <span className="editor-document-state" data-public-state={publicState} aria-live={ariaLive}>
      <span className="editor-document-save-state"><Icon name={documentBar.draftState === "saved" ? "check" : "pencil"} />{label}</span>
      <span className="editor-document-version-state">{progress || <><span>{live}</span>{revision ? <> · {revision}</> : null}</>}</span>
    </span>;
  }

  if (statusOnly) return <span className="published-version-status" data-public-state={publicState} aria-live={ariaLive}>{statusLabel}</span>;

  const details = Children.toArray([
    !alertsOnly && unified && (publicState === "unknown" || publicState === "live") && presentation.label !== liveLabel ?
      compact && publicState === "unknown" ? (
        <span className="published-version-label"><Icon name="info" />{liveLabel}</span>
      ) : <span className="published-version-note">{liveLabel}</span> : null,
    !alertsOnly && identity && watchPublicReceipts && !canConfirm && !servedPost && typeof liveSourceVersion === "number" ? (
      <span className="published-version-note">A published copy was last recorded</span>
    ) : null,
    !alertsOnly && identity && watchPublicReceipts && !canConfirm && version && !saved ? (
      <span className="published-version-note">Working version {editorialVersion}</span>
    ) : null,
    progress && progressActive ? (
      <LoadingIndicator
        activeStage={noBuildPage ? pagePublishProgressStage(saved?.pageConfirmation) : publishProgressStage(saved?.queueStatus)}
        className="published-version-note published-version-progress"
        label={progress}
        stages={noBuildPage ? PAGE_PUBLISH_PROGRESS_STAGES : PUBLISH_PROGRESS_STAGES}
      />
    ) : progress ? (
      <span className="published-version-note toolbar">{progress}</span>
    ) : null,
    !alertsOnly && workingIsNewer && !unified ? (
      <span className="published-version-note">
        Working version {editorialVersion} is newer
      </span>
    ) : null,
    saved?.homeWarning ? <span role="status" className="published-version-note">{saved.homeWarning}</span> : null,
    saved?.recordPublication?.warning ? <span role="status" className="published-version-note">{saved.recordPublication.warning}</span> : null,
    saved?.postProofWarning ? <span role="status" className="published-version-note">{saved.postProofWarning}</span> : null,
    !alertsOnly && !compact && saved && !workingIsNewer ? (
      <span className="published-version-note">
        {version ? `Saved version ${editorialVersion}` : "No saved version"}{!unified ? ` · ${displayContentStatus(saved.workingStatus)}` : ""}
      </span>
    ) : null,
    retryAvailable || (removalBuildPending && canRetryWithdrawal && retry) ? (
      <AsyncActionButton
        disabled={!retryAvailable}
        label={withdrawal ? "Retry removal" : "Retry publication"}
        pending={retrying}
        pendingLabel="Requesting…"
        pendingAnnouncement="Requesting the public update. Your edits are unchanged."
        onClick={() => {
          setRetrying(true);
          setRetryError(null);
          void retry!({ collection: collection!, id: documentId!,
            sourceVersion: pendingVersion!, baseVersion: saved!.workingVersion!,
            ...(withdrawal ? { operation: "withdraw" as const } : {}),
          }).catch((error: unknown) => setRetryError(error instanceof Error ? error.message : "Publication could not be retried."))
            .finally(() => setRetrying(false));
        }}
      />
    ) : null,
    canRetry && recheck && collection && documentId &&
      (saved?.recheckQueueId || saved?.postProofQueueId || metadata?.lastRecheck) ? (
      <PublicationRecheckAction key={saved?.recheckQueueId ?? saved?.postProofQueueId ?? metadata?.lastRecheck?.queueId}
        available={!metadata?.unavailable && Boolean(saved?.recheckQueueId || saved?.postProofQueueId)}
        recordedResult={metadata?.lastRecheck ? { message: metadata.lastRecheck.message, failed: metadata.lastRecheck.outcome === "failed" } : undefined}
        onCheck={() => recheck(saved!.recheckQueueId ?? saved!.postProofQueueId!, collection, documentId)} />
    ) : null,
    retryError ? <span role="alert" className="published-version-note">{retryError}</span> : null,
  ]);
  if (detailsOnly && details.length === 0) return null;

  return (
    <span className="published-version-status" data-public-state={publicState} aria-live={ariaLive}>
      {detailsOnly ? null : statusLabel}
      {details}
    </span>
  );
}
