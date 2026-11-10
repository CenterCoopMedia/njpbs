import { useEditorWorkspaceView } from "../context/EditorWorkspaceView";
import { EditorActionSlot, useEditorActionsAvailable } from "./EditorActions";
import { altTextReminder, missingAltTextCount } from "../lib/alt-text-reminder";
import { Icon, type IconName } from "./ui/Icon";
import { InfoTooltip } from "./ui/InfoTooltip";
import { Tooltip } from "./ui/Tooltip";
import {
  createContext,
  Fragment,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  LifecycleAction,
  TransitionContentRequest,
  TransitionContentResponse,
  PublicRuntimeReceipt,
  PublishBuildResponse,
} from "../lib/functions";
import {
  didPublicationCommitBeforeError,
  isConflictError,
} from "../lib/functions";
import type { ScheduledPublishFailure } from "../../../packages/content-core/src/content-model";
import { publicationScheduleDeadline } from "../../../packages/content-core/src/publication-schedule";
import { instantToStationLocal } from "../../../packages/content-core/src/station-time";
import { formatPublicationTime, resolvePublicationSchedule } from "../lib/publication-schedule";
import { contentStatusTone, displayContentStatus } from "../lib/content-status";
import {
  AsyncActionButton,
  Button,
  InlineMessage,
  Panel,
  Select,
  StatusBadge,
  Textarea,
  TextInput,
} from "./ui/Primitives";
import { WorkspaceActions, WorkspaceFeedback, WorkspaceSecondaryActions, useWorkspaceFeedbackAvailable, useWorkspaceSecondaryActionsAvailable } from "./WorkspaceActions";
import { useSuccessNotice } from "./ui/SuccessNoticeRegion";
import { PublishedVersionStatus } from "./PublishedVersionStatus";
import { usePublicationMetadata } from "../context/PublicContentStatusContext";
import { useShownAgainCount, useVideoRightsWarnings, type VideoRightsWarning } from "../lib/video-rights";
import type { PublicationVideo } from "../lib/publication-videos";

interface LifecycleActionsPanelProps {
  collection: "cmsPages" | "cmsPosts";
  documentId: string;
  recordTitle?: string;
  unifiedStatus?: boolean;
  status?: string;
  scheduledAt?: string;
  scheduledPublishFailure?: ScheduledPublishFailure;
  baseVersion?: number;
  contentVersion?: number;
  /** Known live snapshot version. Undefined means this surface did not load publication state. */
  liveSourceVersion?: number | null;
  publicUpdatePending?: boolean;
  publicBuildQueueId?: string | null;
  pendingSourceVersion?: number;
  canApprove?: boolean;
  canEdit?: boolean;
  canPublish?: boolean;
  canSchedule?: boolean;
  publicationSupported: boolean;
  cardPublication?: boolean;
  publicationDisabledReason?: string;
  canArchive: boolean;
  canUnpublish: boolean;
  canRestore: boolean;
  disabledReason?: string;
  headless?: boolean;
  onTransition?: (
    request: TransitionContentRequest,
    options?: { retryAcceptedCard: true },
  ) => Promise<TransitionContentResponse>;
  onPublish?: (baseVersion: number, onProgress?: (message: string) => void) => Promise<{
    document: Record<string, unknown>;
    publicReceipt?: PublicRuntimeReceipt | null;
    buildQueued?: boolean;
    transport?: PublishBuildResponse["transport"];
  }>;
  onSchedule?: (baseVersion: number, scheduleAt: string, onProgress?: (message: string) => void) => Promise<{
    document: Record<string, unknown>;
  }>;
  onChanged?: (document: Record<string, unknown>) => void;
  onReload?: () => void;
  onSubmittingChange?: (submitting: boolean) => void;
  /** Visible video assets in the saved version; their current rights show before publish (#2759). */
  videos?: readonly PublicationVideo[];
  workspaceActions?: boolean;
  onReveal?: () => void;
}

const LifecycleFeedbackRevealContext = createContext<(() => void) | undefined>(
  undefined,
);

export function LifecycleFeedbackRevealProvider({
  children,
  onReveal,
}: {
  children: ReactNode;
  onReveal: () => void;
}) {
  return (
    <LifecycleFeedbackRevealContext.Provider value={onReveal}>
      {children}
    </LifecycleFeedbackRevealContext.Provider>
  );
}

interface ActionDefinition {
  action: PanelAction;
  label: string;
  confirmLabel: string;
  description: string;
  successTitle: string;
  errorTitle: string;
  variant: "primary" | "secondary" | "danger";
}

const ACTION_ICONS: Record<PanelAction, IconName> = {
  edit: "pencil", submit: "users", sendBack: "undo", approve: "check",
  unschedule: "calendar", publish: "upload", schedule: "calendar",
  unpublish: "eye-off", archive: "trash", restore: "undo",
};

type PanelAction = Exclude<LifecycleAction, "reopen" | "revise"> | "publish" | "schedule";

function isSecondaryWorkspaceAction(action: PanelAction, canPublish: boolean): boolean {
  return ["unschedule", "unpublish", "archive", "approve", "sendBack"].includes(action) || (action === "submit" && canPublish);
}

const PUBLISHING_HELP = "Save your edits before publishing. Publish uses the saved version. A saved draft is separate from what visitors see; check the public-version status for the result.";

const ACTIONS: Record<PanelAction, ActionDefinition> = {
  edit: {
    action: "edit",
    label: "Edit",
    confirmLabel: "Edit",
    description: "Open this content for editing while its current public version stays live.",
    successTitle: "Editing enabled",
    errorTitle: "Editing was not enabled",
    variant: "primary",
  },
  submit: {
    action: "submit",
    label: "Submit for review",
    confirmLabel: "Confirm submission",
    description:
      "Submitting locks this saved version in the review queue. An editor can approve it or send it back with a note.",
    successTitle: "Content submitted for review",
    errorTitle: "Content was not submitted",
    variant: "primary",
  },
  sendBack: {
    action: "sendBack",
    label: "Send back",
    confirmLabel: "Confirm send back",
    description:
      "Send this version back to draft with a clear review note. The note is stored with the audit evidence.",
    successTitle: "Content sent back to draft",
    errorTitle: "Content was not sent back",
    variant: "secondary",
  },
  approve: {
    action: "approve",
    label: "Approve",
    confirmLabel: "Confirm approval",
    description:
      "Approve this exact saved version for publishing or scheduling. Approval does not publish it. It stays read-only until an editor reopens it.",
    successTitle: "Content approved",
    errorTitle: "Content was not approved",
    variant: "primary",
  },
  unschedule: {
    action: "unschedule",
    label: "Cancel scheduled publication",
    confirmLabel: "Confirm cancellation",
    description:
      "Cancel the scheduled publication and return this saved version to draft for editing or rescheduling.",
    successTitle: "Scheduled publication cancelled",
    errorTitle: "Scheduled publication was not cancelled",
    variant: "secondary",
  },
  publish: {
    action: "publish",
    label: "Publish",
    confirmLabel: "Confirm publication",
    description:
      "Publish this exact saved version. The CMS confirms the public result or queues the required site build.",
    successTitle: "Publication started",
    errorTitle: "Publication did not start",
    variant: "primary",
  },
  schedule: {
    action: "schedule",
    label: "Schedule publish",
    confirmLabel: "Confirm schedule",
    description:
      "Schedule this saved version in New York time, up to one calendar month ahead. It stays read-only until publication or cancellation.",
    successTitle: "Publication scheduled",
    errorTitle: "Publication was not scheduled",
    variant: "secondary",
  },
  unpublish: {
    action: "unpublish",
    label: "Unpublish",
    confirmLabel: "Confirm unpublish",
    description:
      "Request removal of the CMS version from the public site. The working copy and last public snapshot stay saved. Any scheduled publication is cancelled. A built-in page returns to its site content.",
    successTitle: "Removal requested",
    errorTitle: "Content was not unpublished",
    variant: "danger",
  },
  archive: {
    action: "archive",
    label: "Delete",
    confirmLabel: "Move to recycle bin",
    description:
      "This moves the content out of active editorial work and into Recycle bin. Its working copy, published snapshot, revision history, and audit evidence remain intact.",
    successTitle: "Content deleted",
    errorTitle: "Content was not moved to Recycle bin",
    variant: "danger",
  },
  restore: {
    action: "restore",
    label: "Restore to draft",
    confirmLabel: "Confirm restore",
    description:
      "Restoring returns this deleted content to draft. It does not publish the content or replace its last published snapshot.",
    successTitle: "Content restored to draft",
    errorTitle: "Content was not restored",
    variant: "primary",
  },
};

function availableActions(
  status: string | undefined,
  canSchedule: boolean,
  publicationSupported: boolean,
): PanelAction[] {
  const publish: PanelAction[] = publicationSupported ? ["publish"] : [];
  const schedule: PanelAction[] = canSchedule && publicationSupported ? ["schedule"] : [];
  switch (status) {
    case "draft": return [...publish, ...schedule, "submit", "archive"];
    case "in_review": return ["approve", "sendBack", "edit", ...publish, ...schedule, "archive"];
    case "approved": return ["edit", ...publish, ...schedule, "archive"];
    case "scheduled": return ["edit", "unschedule", "archive"];
    case "published": return ["unpublish", "archive"];
    case "archived": return ["restore"];
    default: return [];
  }
}


const NO_VIDEOS: readonly PublicationVideo[] = [];

/** The library name; for a missing or unread video, the block title, then the asset ID. */
function videoRightsLabel(warning: VideoRightsWarning, videos: readonly PublicationVideo[]): string {
  return warning.name || videos.find(video => video.assetId === warning.assetId)?.title || warning.assetId;
}
export function LifecycleActionsPanel({
  collection,
  documentId,
  recordTitle,
  unifiedStatus = true,
  status,
  scheduledAt,
  scheduledPublishFailure,
  baseVersion,
  contentVersion = baseVersion,
  liveSourceVersion,
  publicUpdatePending,
  publicBuildQueueId,
  pendingSourceVersion,
  canApprove = false,
  canEdit = false,
  canPublish = false,
  canSchedule = true,
  publicationSupported,
  cardPublication = false,
  publicationDisabledReason,
  canArchive,
  canUnpublish,
  canRestore,
  disabledReason,
  headless = false,
  onTransition,
  onPublish,
  onSchedule,
  onChanged,
  onReload,
  onSubmittingChange,
  videos = NO_VIDEOS,
  workspaceActions = false,
  onReveal,
}: LifecycleActionsPanelProps) {
  const groupedActions = useEditorActionsAvailable();
  const secondaryActionsAvailable = useWorkspaceSecondaryActionsAvailable();
  const secondaryMenu = workspaceActions && !groupedActions && secondaryActionsAvailable;
  const publication = usePublicationMetadata(collection, documentId, baseVersion);
  const cardReceipt = publication?.data?.libraryCardPublication;
  const definitions = cardPublication ? { ...ACTIONS, approve: { ...ACTIONS.approve,
    description: "Approve this saved version and update its public cards. Later draft edits stay private.",
  } } : ACTIONS;
  const workspaceFeedbackAvailable = useWorkspaceFeedbackAvailable();
  const editorView = useEditorWorkspaceView();
  const successNotice = useSuccessNotice();
  const revealHostedFeedback = useContext(LifecycleFeedbackRevealContext);
  const [pending, setPending] = useState<PanelAction | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submittingAction, setSubmittingAction] = useState<PanelAction | null>(null);
  const [progress, setProgress] = useState("");
  const rightsProbe = useRef<HTMLSpanElement>(null);
  const shownAgain = useShownAgainCount(rightsProbe);
  // Only a record that can still be published or scheduled asks staff to check rights.
  const rightsCheck = canPublish &&
    availableActions(status, canSchedule, publicationSupported).some(action => action === "publish" || action === "schedule");
  const videoRights = useVideoRightsWarnings(rightsCheck ? videos.map(video => video.assetId) : [], shownAgain);
  const [reviewNote, setReviewNote] = useState("");
  const [scheduleAt, setScheduleAt] = useState("");
  const [scheduleOccurrence, setScheduleOccurrence] = useState("");
  const [scheduleClock, setScheduleClock] = useState(Date.now);
  const scheduleInputId = useId();
  const publishingHelpId = useId();
  const menuReasonId = useId();
  const scheduleHelpId = useId();
  const scheduleErrorId = useId();
  const scheduleOccurrenceId = useId();
  const schedule = resolvePublicationSchedule(scheduleAt, scheduleOccurrence, scheduleClock);
  // Start at midnight so native min validation permits the second occurrence of
  // a repeated hour, even if its wall-clock minute is earlier than the first.
  const scheduleMin = instantToStationLocal(new Date(scheduleClock).toISOString()).slice(0, 10) + "T00:00";
  // Likewise, an earlier absolute instant in the first occurrence can have a
  // later wall-clock minute than the ceiling in the second occurrence.
  const scheduleMax = instantToStationLocal(new Date(publicationScheduleDeadline(scheduleClock)).toISOString()).slice(0, 10) + "T23:59";
  const confirmationTitleId = useId();
  const confirmationDescriptionId = useId();
  const confirmationRef = useRef<HTMLDivElement>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);
  const actionButtonRefs = useRef(new Map<PanelAction, HTMLButtonElement>());
  const returnFocusAction = useRef<PanelAction | null>(null);
  const [result, setResult] = useState<{
    tone: "success" | "error";
    title: string;
    message: string;
    conflict?: boolean;
    reloadPublishedVersion?: boolean;
  } | null>(null);

  useEffect(() => {
    setPending(null);
    setReviewNote("");
    setScheduleAt("");
    setScheduleOccurrence("");
    setResult(null);
  }, [collection, documentId, status, baseVersion]);

  useEffect(() => {
    if (pending !== "schedule") return;
    setScheduleClock(Date.now());
    const timer = window.setInterval(() => setScheduleClock(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [pending]);

  useEffect(
    () => () => onSubmittingChange?.(false),
    [onSubmittingChange],
  );

  useEffect(() => {
    if (!workspaceActions || (!submittingAction && !result && pending !== "schedule")) return;
    const feedback = feedbackRef.current;
    const header = feedback?.closest(".workspace-shell")?.querySelector(".workspace-header");
    if (!feedback || !header) return;
    // Publish remains available in the sticky toolbar while reading a long
    // article. Reveal its response below that toolbar, not behind it.
    feedback.style.scrollMarginTop = `${header.getBoundingClientRect().height}px`;
    feedback.scrollIntoView({ block: "nearest" });
  }, [pending, result, submittingAction, workspaceActions]);

  useEffect(() => {
    if (pending) {
      confirmationRef.current
        ?.querySelector<HTMLElement>("[data-lifecycle-initial-focus]")
        ?.focus();
      return;
    }
    const action = returnFocusAction.current;
    if (!action) return;
    const actionButton = actionButtonRefs.current.get(action);
    // A phone menu may have closed while the confirmation was open.
    const menuTrigger = actionButton?.closest(".workspace-more-panel[hidden]")
      ?.parentElement?.querySelector<HTMLButtonElement>(".workspace-more-trigger");
    const actionMenu = actionButton?.closest(".post-template-action-menu[hidden]");
    const actionMenuTrigger = actionMenu
      ? document.querySelector<HTMLElement>(`[aria-controls="${actionMenu.id}"]`) : null;
    (actionMenuTrigger ?? menuTrigger ?? actionButton)?.focus();
    returnFocusAction.current = null;
  }, [pending]);

  const actions = availableActions(
    status,
    canSchedule,
    publicationSupported,
  ).filter(permissionFor);
  const hasPublicSnapshot = status === "published" ||
    (publication?.data?.publiclyVisible === true &&
      (publication.data.workingVersion ?? 0) >= (baseVersion ?? 0));
  if (status !== "archived" && canUnpublish && hasPublicSnapshot && !actions.includes("unpublish")) {
    actions.push("unpublish");
  }
  if (actions.length === 0 && !(status === "archived" && publicationSupported)) return null;

  const versionReason = baseVersion === undefined
    ? "Save this content once before changing its lifecycle."
    : undefined;
  const sharedReason = disabledReason ?? versionReason;

  function permissionFor(action: PanelAction): boolean {
    if (action === "edit") return canEdit;
    if (action === "submit") return canEdit;
    if (action === "approve") return canApprove && (!cardPublication || canPublish);
    if (action === "sendBack") return canApprove;
    if (action === "unschedule" || action === "publish" || action === "schedule") {
      return canPublish;
    }
    if (action === "archive") return canArchive;
    return action === "restore" ? canRestore : canUnpublish;
  }

  function permissionReason(action: PanelAction): string | undefined {
    if (permissionFor(action)) return undefined;
    if (action === "edit") return "Your role cannot edit this content.";
    if (action === "submit") return "Your role cannot submit this content.";
    if (action === "approve" && cardPublication && !canPublish) return "Your role cannot publish this card.";
    if (
      action === "sendBack" ||
      action === "approve"
    ) {
      return "Your role cannot review this content.";
    }
    if (action === "unschedule") return "Your role cannot cancel publication.";
    if (action === "publish" || action === "schedule") {
      return "Your role cannot publish content.";
    }
    if (action === "archive") return "Your role cannot move content to Recycle bin.";
    if (action === "restore") return "Your role cannot restore deleted content.";
    return "Your role cannot take published content off the site.";
  }

  function connectionReason(action: PanelAction): string | undefined {
    if ((action === "publish" || action === "schedule") && publicationDisabledReason) return publicationDisabledReason;
    if (action === "publish") {
      return onPublish ? undefined : "Publishing is not connected in this workspace.";
    }
    if (action === "schedule") {
      return onSchedule ? undefined : "Scheduling is not connected in this workspace.";
    }
    return onTransition
      ? undefined
      : "Lifecycle actions are not connected in this workspace.";
  }

  async function submit(action: PanelAction, retryCard = false) {
    if (
      submitting ||
      sharedReason ||
      !permissionFor(action) ||
      connectionReason(action) ||
      baseVersion === undefined
    ) {
      return;
    }
    const definition = definitions[action];
    setSubmitting(true);
    setSubmittingAction(action);
    onSubmittingChange?.(true);
    setResult(null);
    try {
      let document: Record<string, unknown>;
      let successMessage: string;
      let removalDidNotStart = false;
      if (action === "publish") {
        const response = await onPublish!(baseVersion, setProgress);
        document = response.document;
        if (response.publicReceipt?.status === "confirmed") {
          successMessage = response.buildQueued
            ? `The saved version is published. ` +
              `${response.publicReceipt.label} ` +
              `is confirmed on the public site; an existing site build is still queued.`
            : `The saved version is published. ` +
              `${response.publicReceipt.label} ` +
              `is confirmed on the public site; no public build was needed.`;
        } else if (response.publicReceipt?.status === "unconfirmed") {
          successMessage =
            `Publication requested. ` +
            `${response.publicReceipt.label} ` +
            `is not confirmed on the public site yet; check again shortly.`;
        } else if (response.transport === "post-no-build-v1" || response.transport === "page-no-build-v1" || response.transport === "public-context-no-build-v1" || response.transport === "release-pair-publication-v2") {
          successMessage =
            "Publication requested. The public site has not confirmed this version yet; no public build is needed.";
        } else {
          successMessage =
            "Publication requested. The saved version is queued for a public build.";
        }
      } else if (action === "schedule") {
        const selected = resolvePublicationSchedule(scheduleAt, scheduleOccurrence, Date.now());
        if (!selected.instant) {
          setScheduleClock(Date.now());
          throw new Error(selected.error!);
        }
        const response = await onSchedule!(baseVersion, selected.instant, setProgress);
        document = response.document;
        successMessage = `Publication scheduled for ${formatPublicationTime(selected.instant)} (New York). The content appears when the site update finishes.`;
      } else {
        const request: TransitionContentRequest = {
          collection,
          id: documentId,
          action,
          baseVersion: retryCard && cardReceipt ? cardReceipt.sourceVersion - 1 : baseVersion,
          ...(action === "sendBack" ? { comment: reviewNote.trim() } : {}),
        };
        const response = retryCard
          ? await onTransition!(request, { retryAcceptedCard: true })
          : await onTransition!(request);
        document = response.document;
        successMessage = action === "approve" && publicationSupported
          ? "The content is now approved. Approval does not publish it."
          : `The content is now ${displayContentStatus(response.toStatus).toLowerCase()}.`;
        if (response.publication) {
          removalDidNotStart = action === "unpublish" && response.publication.status === "failed";
          successMessage = response.publication.status === "queued"
            ? response.publication.cardPublication
              ? action === "approve" ? "Approval saved. Check the public card status for confirmation."
                : "Removal saved. Check the public card status for confirmation."
              : "Removal saved. The public update is queued; the current public version remains visible until removal is confirmed."
            : "Removal saved, but the public update did not start. Use Retry removal. Your working copy is unchanged.";
          if (response.publication.warnings?.length) {
            successMessage = `${successMessage} ${response.publication.warnings.join(" ")}`;
          }
        }
      }
      if (action === "publish" || action === "schedule") {
        const reminder = altTextReminder(missingAltTextCount(collection, document));
        if (reminder) successMessage = `${successMessage} ${reminder}`;
      }
      setPending(null);
      setReviewNote("");
      setScheduleAt("");
      setScheduleOccurrence("");
      setResult({
        tone: removalDidNotStart ? "error" : "success",
        title: definition.successTitle,
        message: successMessage,
      });
      // The editor reloads the committed snapshot and unmounts this panel. Keep
      // the accepted-request receipt visible while live metadata takes over.
      if (action === "publish" || action === "schedule" || action === "unpublish") {
        successNotice.show(successMessage, removalDidNotStart ? { tone: "error" } : undefined);
      }
      onChanged?.(document);
    } catch (error) {
      const conflict = isConflictError(error);
      const reloadPublishedVersion = didPublicationCommitBeforeError(error);
      successNotice.show(`${definition.errorTitle}. ${error instanceof Error ? error.message : "Try again."}`, {
        tone: "error",
        action: { label: "Review details", onClick: () => {
          if (onReveal) onReveal();
          else revealHostedFeedback?.();
          requestAnimationFrame(() => feedbackRef.current?.scrollIntoView({ block: "center" }));
        } },
      });
      if (workspaceActions && action === "restore") {
        revealHostedFeedback?.();
      }
      if (workspaceActions && action === "edit") {
        if (onReveal) onReveal();
        else revealHostedFeedback?.();
      }
      setResult({
        tone: "error",
        title: definition.errorTitle,
        message:
          error instanceof Error
            ? error.message
            : "The lifecycle request failed. Try again.",
        conflict,
        reloadPublishedVersion,
      });
      // Reloading here unmounts the error before the person can read it.
      // The explicit reload action handles conflicts and committed snapshots.
    } finally {
      setSubmitting(false);
      setSubmittingAction(null);
      setProgress("");
      onSubmittingChange?.(false);
    }
  }

  // The disabled actions and their reasons, one entry per distinct reason, in action order.
  const unavailableActionGroups = actions.reduce<Array<{ reason: string; labels: string[] }>>(
    (groups, action) => {
      const reason = permissionReason(action) ?? connectionReason(action);
      if (!reason) return groups;
      const group = groups.find((candidate) => candidate.reason === reason);
      const label = definitions[action].label;
      if (group) group.labels.push(label);
      else groups.push({ reason, labels: [label] });
      return groups;
    },
    [],
  );

  const actionButtons = actions.map((action) => {
    const definition = definitions[action];
    const menuItem = groupedActions
      ? ["publish", "schedule", "unschedule", "unpublish", "archive"].includes(action) || (action === "submit" && canPublish)
      : secondaryMenu && isSecondaryWorkspaceAction(action, canPublish);
    const variant = menuItem ? definition.variant === "danger" ? "menu-danger" : "menu"
      : workspaceActions && definition.variant === "primary" && action !== "edit" ? "secondary" : definition.variant;
    const unavailableReason =
      sharedReason ?? permissionReason(action) ?? connectionReason(action);
    const disabled = submitting || Boolean(unavailableReason);
    const reasonId = menuItem && unavailableReason ? `${menuReasonId}-${action}` : undefined;
    const withReason = (button: ReactNode) => <Fragment key={action}>
      {button}
      {reasonId ? <span className="ui-menu-item-description ui-menu-unavailable-reason" id={reasonId}>{unavailableReason}</span> : null}
    </Fragment>;
    if (action === "edit" || action === "publish") {
      return withReason(
        <AsyncActionButton
          key={action}
          aria-describedby={reasonId}
          {...(menuItem ? { "aria-disabled": disabled || undefined } : {})}
          icon={menuItem ? ACTION_ICONS[action] : undefined}
          disabled={disabled}
          label={definitions[action].label}
          onClick={() => {
            returnFocusAction.current = null;
            setPending(null);
            setReviewNote("");
            setScheduleAt("");
            setResult(null);
            void submit(action);
          }}
          pending={submitting && submittingAction === action}
          pendingAnnouncement={action === "publish" ? "Publishing." : "Opening editor."}
          pendingLabel={action === "publish" ? "Publishing…" : "Opening…"}
          variant={menuItem ? "menu" : definition.variant}
        />
      );
    }
    return withReason(
      <Button
        key={action}
        aria-describedby={reasonId}
        {...(menuItem ? { "aria-disabled": disabled || undefined } : {})}
        disabled={disabled}
        ref={(element) => {
          if (element) actionButtonRefs.current.set(action, element);
          else actionButtonRefs.current.delete(action);
        }}
        onClick={() => {
          if (!(groupedActions && workspaceFeedbackAvailable) && !(workspaceActions && workspaceFeedbackAvailable && action === "schedule")) {
            onReveal?.();
            if (!onReveal && !(workspaceActions && action === "restore")) {
              revealHostedFeedback?.();
            }
          }
          returnFocusAction.current = null;
          setPending(action);
          setResult(null);
        }}
        variant={variant}
      >
        {menuItem ? <Icon name={ACTION_ICONS[action]} /> : null}
        <span>{definition.label}</span>
      </Button>
    );
  });

  function cancelPending() {
    if (!pending || submitting) return;
    returnFocusAction.current = pending;
    setPending(null);
    setReviewNote("");
    setScheduleAt("");
    setScheduleOccurrence("");
  }

  const confirmation = pending ? (
    <div
      aria-labelledby={confirmationTitleId}
      className={`lifecycle-actions-confirmation${
        workspaceActions && pending === "restore"
          ? " lifecycle-actions-confirmation-workspace"
          : ""
      }`}
      ref={confirmationRef}
      role="group"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !submitting) {
          event.preventDefault();
          cancelPending();
        }
      }}
    >
      <strong
        className="lifecycle-actions-confirmation-title"
        id={confirmationTitleId}
      >
        {definitions[pending].confirmLabel}
      </strong>
      <p id={confirmationDescriptionId}>
        {definitions[pending].description}
      </p>
      {pending === "sendBack" ? (
        <label className="lifecycle-actions-note" htmlFor="lifecycle-review-note">
          <span>Review note</span>
          <Textarea
            data-lifecycle-initial-focus
            disabled={submitting}
            id="lifecycle-review-note"
            maxLength={1_000}
            onChange={(event) => setReviewNote(event.currentTarget.value)}
            required
            rows={4}
            value={reviewNote}
          />
        </label>
      ) : null}
      {pending === "schedule" ? (
        <div className="lifecycle-actions-note">
          <label htmlFor={scheduleInputId}>Publication time (New York)</label>
          <span id={scheduleHelpId}>
            Eastern time (EST/EDT), regardless of your device time zone. Choose a future time through {formatPublicationTime(new Date(publicationScheduleDeadline(scheduleClock)).toISOString())}.
            {" "}Publication is checked every minute; the site update can take longer.
          </span>
          <TextInput
            aria-describedby={`${scheduleHelpId}${scheduleAt && schedule.error ? ` ${scheduleErrorId}` : ""}`}
            aria-invalid={Boolean(scheduleAt && schedule.error)}
            data-lifecycle-initial-focus
            disabled={submitting}
            id={scheduleInputId}
            min={scheduleMin}
            max={scheduleMax}
            step={60}
            onChange={(event) => {
              setScheduleAt(event.currentTarget.value);
              setScheduleOccurrence("");
              setScheduleClock(Date.now());
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.preventDefault();
            }}
            required
            type="datetime-local"
            value={scheduleAt}
          />
          {schedule.options.length > 1 ? (
            <>
              <label htmlFor={scheduleOccurrenceId}>Which occurrence?</label>
              <Select id={scheduleOccurrenceId} disabled={submitting} required
                aria-describedby={scheduleErrorId}
                value={scheduleOccurrence} onChange={event => setScheduleOccurrence(event.currentTarget.value)}>
                <option value="">Choose EDT or EST</option>
                {schedule.options.map(option => <option key={option.instant} value={option.instant}>{option.label}</option>)}
              </Select>
            </>
          ) : null}
          <span id={scheduleErrorId} aria-live="polite">
            {scheduleAt && schedule.error ? schedule.error : schedule.instant
              ? `Selected: ${formatPublicationTime(schedule.instant)} (New York).` : ""}
          </span>
        </div>
      ) : null}
      <div className="lifecycle-actions-confirmation-buttons">
        <AsyncActionButton
          aria-describedby={confirmationDescriptionId}
          data-lifecycle-initial-focus={
            pending === "sendBack" || pending === "schedule" ? undefined : true
          }
          disabled={
            Boolean(sharedReason || connectionReason(pending) || permissionReason(pending)) ||
            (pending === "sendBack" && reviewNote.trim().length === 0) ||
            (pending === "schedule" && !schedule.instant)
          }
          label={definitions[pending].confirmLabel}
          onClick={() => void submit(pending)}
          pending={submitting}
          pendingAnnouncement="Applying lifecycle action."
          pendingLabel={pending === "publish" ? "Publishing…" : "Applying action…"}
          variant={definitions[pending].variant}
        />
        <Button
          disabled={submitting}
          onClick={cancelPending}
          variant="ghost"
        >
          Cancel
        </Button>
      </div>
    </div>
  ) : null;

  const publicationDetails = cardPublication ? <InlineMessage
    tone={cardReceipt?.warning ? "warning" : "info"}
    title={cardReceipt?.status === "success" ? cardReceipt.withdrawal ? "Card removed" : "Card update confirmed"
      : cardReceipt ? "Card update pending" : "Public cards"}>
    {cardReceipt?.warning ?? (cardReceipt?.status === "success" ? "The public card update is confirmed."
      : cardReceipt ? "The saved card update is waiting for public confirmation."
        : "Approve publishes this card. Unpublish or Archive removes it. Draft edits stay private.")}
    {cardReceipt?.warning && permissionFor(cardReceipt.action) ? <Button
      disabled={submitting || Boolean(sharedReason)} onClick={() => { void submit(cardReceipt.action, true); }}>
      Retry card update
    </Button> : null}
  </InlineMessage> : <PublishedVersionStatus compact detailsOnly={unifiedStatus} alertsOnly={Boolean(editorView?.kind)}
    workingStatus={unifiedStatus ? status ?? "draft" : undefined} recordTitle={recordTitle}
    collection={collection} documentId={documentId}
    canRetry={canPublish && publicationSupported} canRetryWithdrawal={canUnpublish || canArchive}
    liveSourceVersion={liveSourceVersion} publicBuildQueueId={publicBuildQueueId}
    publicUpdatePending={publicUpdatePending} pendingSourceVersion={pendingSourceVersion}
    workingVersion={baseVersion} contentVersion={contentVersion} />;

  const publicationProgress = submittingAction === "publish" ? (
    <InlineMessage tone="info" title="Requesting publication">
      {progress || "The saved version is being submitted. This does not confirm it is live yet."}
    </InlineMessage>
  ) : submittingAction === "schedule" && progress ? (
    <InlineMessage tone="info" title="Scheduling publication">{progress}</InlineMessage>
  ) : null;

  const feedback = (
    <div className="lifecycle-feedback" ref={feedbackRef}>
      {(groupedActions && workspaceFeedbackAvailable) || (workspaceActions && pending === "schedule") ? confirmation : null}
      {status === "scheduled" && scheduledAt && formatPublicationTime(scheduledAt) ? (
        <InlineMessage tone="info" title="Publication scheduled">
          <span>{formatPublicationTime(scheduledAt)} (New York). Cancel scheduled publication to change the time. Edit cancels the schedule and returns the content to draft.</span>
        </InlineMessage>
      ) : null}
      {sharedReason ? <p className="lifecycle-actions-disabled">{sharedReason}</p> : null}
      {!sharedReason
        ? unavailableActionGroups.map(({ reason, labels }) => (
            <p className="lifecycle-actions-disabled" key={reason}>
              <span className="lifecycle-actions-disabled-names">{labels.join(", ")}:</span>{" "}{reason}
            </p>
          ))
        : null}
      <span ref={rightsProbe} className="lifecycle-video-rights-probe" aria-hidden="true" />
      {videoRights.length ? (
        <InlineMessage tone="warning" title="Check video rights before you publish">
          <ul className="lifecycle-video-rights">
            {videoRights.map(warning => (
              <li key={warning.assetId}>
                <strong>{videoRightsLabel(warning, videos)}: </strong>{warning.message}
              </li>
            ))}
          </ul>
        </InlineMessage>
      ) : null}
      {unifiedStatus ? (
        <div className="lifecycle-publication-feedback lifecycle-publication-progress" aria-live="polite">
          {publicationProgress}
        </div>
      ) : publicationProgress}
      {result ? (
        <InlineMessage tone={result.tone} title={result.title}>
          <span>{result.message}</span>
          {(result.conflict || result.reloadPublishedVersion) && onReload ? (
            <Button onClick={onReload}>
              {result.reloadPublishedVersion ? "Reload published version" : "Reload content"}
            </Button>
          ) : null}
        </InlineMessage>
      ) : null}
      {unifiedStatus ? (
        <div className="lifecycle-publication-feedback lifecycle-publication-details" aria-live="polite">
          {liveSourceVersion !== undefined ? publicationDetails : null}
        </div>
      ) : liveSourceVersion !== undefined ? (
        <dl className="lifecycle-version-state" aria-label="Publication status" aria-live="polite">
          <div>
            <dt>Working version</dt>
            <dd>{baseVersion ? <><span className="lifecycle-version-label">Version {contentVersion}</span> · </> : "Version not recorded · "}{displayContentStatus(status)}</dd>
          </div>
          <div><dt>Public site</dt><dd>{publicationDetails}</dd></div>
        </dl>
      ) : null}
    </div>
  );

  const groupedActionButtons = groupedActions ? actionButtons.map((button, index) => {
    const action = actions[index];
    const group = action === "archive" || action === "unpublish" ? "destructive"
      : action === "publish" || action === "schedule" || action === "unschedule" || (action === "submit" && canPublish) ? "publishing"
      : "workflow";
    return <EditorActionSlot key={action} group={group}>{button}</EditorActionSlot>;
  }) : null;

  const content = (
    <>
      <div className="lifecycle-actions-heading" aria-live={!unifiedStatus || workspaceActions || groupedActions ? undefined : "polite"}>
        {!headless ? (
          <div>
            <div className="editor-field-label-row">
              <h3 id="lifecycle-actions-heading">Lifecycle</h3>
              <InfoTooltip label="content workflow" content="A draft is work in progress. Review asks another editor to check it. Approval does not publish. Publish sends the saved version through the publishing process; scheduling sets a future publication time." />
            </div>
            <p>
              Save a draft, submit it for review, or publish the saved version.
            </p>
          </div>
        ) : null}
        {unifiedStatus && liveSourceVersion !== undefined ? (
          <PublishedVersionStatus compact statusOnly workingStatus={status ?? "draft"}
            recordTitle={recordTitle}
            collection={collection} documentId={documentId} liveSourceVersion={liveSourceVersion}
            publicBuildQueueId={publicBuildQueueId} publicUpdatePending={publicUpdatePending}
            pendingSourceVersion={pendingSourceVersion} workingVersion={baseVersion}
            contentVersion={contentVersion} />
        ) : (
          <StatusBadge tone={contentStatusTone(status)}>{displayContentStatus(status)}</StatusBadge>
        )}
      </div>

      {liveSourceVersion !== undefined ? (
        <>
          {unifiedStatus ? <dl className="lifecycle-version-state" aria-label="Publication status">
            <div>
              <dt>Working version</dt>
              <dd>{baseVersion ? <span className="lifecycle-version-label">Version {contentVersion}</span> : "Version not recorded"}</dd>
            </div>
          </dl> : null}
          {status === "approved" && publicationSupported ? (
            <InlineMessage tone="info" title="Approval does not publish">
              <span>
                {canPublish ? (
                  <>
                    Select <strong>Publish</strong> to {liveSourceVersion
                      ? "replace the current public snapshot with the approved working revision."
                      : "put the approved working revision on the public site."}
                  </>
                ) : (
                  <>
                    A publisher must select <strong>Publish</strong> to {liveSourceVersion
                      ? "replace the current public snapshot with the approved working revision."
                      : "put the approved working revision on the public site."}
                  </>
                )}
              </span>
            </InlineMessage>
          ) : null}
        </>
      ) : null}

      {(status === "draft" || status === "approved") && scheduledPublishFailure ? (
        <InlineMessage tone="error" title="Scheduled publication failed">
          <span>{scheduledPublishFailure.reason}</span>
        </InlineMessage>
      ) : null}

      {groupedActions ? <>{groupedActionButtons}{!workspaceFeedbackAvailable && pending === "restore" ? <WorkspaceActions>{confirmation}</WorkspaceActions> : null}</> : workspaceActions ? (
        <WorkspaceActions>
          <>
            <div className="lifecycle-actions-buttons lifecycle-actions-buttons-header">
              {actionButtons.filter((_, index) => !secondaryMenu || !isSecondaryWorkspaceAction(actions[index], canPublish))}
              <WorkspaceSecondaryActions>
                {secondaryMenu ? <>
                  {actionButtons.filter((_, index) => isSecondaryWorkspaceAction(actions[index], canPublish))}
                  {actions.some(action => isSecondaryWorkspaceAction(action, canPublish)) ? <div className="ui-menu-separator" role="separator" /> : null}
                  <Tooltip content={PUBLISHING_HELP} openOnClick>
                    <Button variant="menu" data-lifecycle-help aria-describedby={publishingHelpId}><Icon name="info" /><span>Lifecycle help</span></Button>
                  </Tooltip>
                  <span className="sr-only" id={publishingHelpId}>{PUBLISHING_HELP}</span>
                </> : <span className="workspace-publishing-help">
                  <span className="workspace-more-label">Lifecycle</span>
                  <InfoTooltip label="publishing actions" content={PUBLISHING_HELP} />
                </span>}
              </WorkspaceSecondaryActions>
            </div>
            {pending === "restore" ? confirmation : null}
          </>
        </WorkspaceActions>
      ) : (
        <div className="lifecycle-actions-buttons">{actionButtons}</div>
      )}

      {status === "approved" && !publicationSupported && !cardPublication ? (
        <p className="lifecycle-actions-disabled">
          This record remains available under All content. Publishing is unavailable until it has a public route.
        </p>
      ) : null}

      {!(groupedActions && workspaceFeedbackAvailable) && (!workspaceActions || (pending !== "restore" && pending !== "schedule")) ? confirmation : null}

      {workspaceActions ? <WorkspaceFeedback>{feedback}</WorkspaceFeedback> : feedback}
    </>
  );

  if (headless) {
    return (
      <section className="lifecycle-actions" aria-label="Lifecycle actions">
        {content}
      </section>
    );
  }

  return (
    <Panel className="lifecycle-actions" aria-labelledby="lifecycle-actions-heading">
      {content}
    </Panel>
  );
}
