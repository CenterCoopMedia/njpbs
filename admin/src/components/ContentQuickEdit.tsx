import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ExitSaveOutcome } from "../lib/exit-save";
import {
  can,
  canEditContent,
  type Principal,
  type Resource,
} from "../../../packages/content-core/src/rbac";
import type { PublicPageId } from "../../../packages/content-core/src/public-pages";
import { pageCompositionSeed } from "../../../packages/content-core/src/page-composition-seeds";
import type { LifecycleAction } from "../lib/functions";
import type { ActiveRecordKind } from "../lib/content-vocab";
import {
  pageLifecycleResource,
  pageSaveDecision,
  recordLifecycleResource,
  recordSaveDecision,
} from "../lib/editor-save-decisions";
import { contentStatusTone, displayContentStatus } from "../lib/content-status";
import {
  useContentQuickActions,
  useRegisterContentQuickEditGuard,
  type ContentQuickActionsApi,
} from "../context/ContentQuickActionsContext";
import {
  AsyncActionButton,
  Button,
  InlineMessage,
  StatusBadge,
  Textarea,
  TextInput,
} from "./ui/Primitives";
import { LoadingIndicator } from "./ui/LoadingIndicator";

export type ContentQuickEditTarget =
  | { kind: "page"; pageId: PublicPageId }
  | { kind: ActiveRecordKind; recordId: string };

interface ContentQuickEditProps {
  restoreOnly?: boolean;
  label: string;
  target: ContentQuickEditTarget;
  persistentEditorDirty?: boolean;
  onDocumentChange?: (document: Record<string, unknown>) => void;
}

type QuickValues = {
  title: string;
  description: string;
  summary: string;
};

type LoadState =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "error"; message: string }
  | { status: "ready"; document: Record<string, unknown> };

interface QuickLifecycleAction {
  action: LifecycleAction;
  label: string;
  confirmation: string;
  success: string;
  danger?: boolean;
  commentRequired?: boolean;
}

const LIFECYCLE_ACTIONS: Record<string, readonly QuickLifecycleAction[]> = {
  draft: [
    {
      action: "submit",
      label: "Submit for review",
      confirmation:
        "Submit this exact saved version to the editorial queue. Quick-edit changes must be saved first.",
      success: "Submitted for review.",
    },
  ],
  in_review: [
    {
      action: "approve",
      label: "Approve",
      confirmation:
        "Approve this exact reviewed version. It remains read-only until it is reopened or published.",
      success: "Approved.",
    },
    {
      action: "sendBack",
      label: "Send back to draft",
      confirmation:
        "Return this version to draft with a review note explaining what needs to change.",
      success: "Returned to draft.",
      commentRequired: true,
    },
  ],
  approved: [
    {
      action: "reopen",
      label: "Reopen for edits",
      confirmation:
        "Return this approved version to draft. It must pass review again before publication.",
      success: "Reopened as a draft.",
    },
  ],
  scheduled: [
    {
      action: "unschedule",
      label: "Cancel scheduled publication",
      confirmation:
        "Cancel the scheduled publication and return this saved version to draft for editing or rescheduling.",
      success: "Scheduled publication cancelled.",
    },
  ],
  published: [
    {
      action: "unpublish",
      label: "Unpublish",
      confirmation:
        "Remove this content from the next public build while retaining its working copy and revision history.",
      success: "Unpublished and returned to draft.",
      danger: true,
    },
    {
      action: "archive",
      label: "Move to recycle bin",
      confirmation:
        "Move this content to Recycle bin. Its working copy, publication snapshot, revision history, and audit evidence remain recoverable.",
      success: "Content deleted.",
      danger: true,
    },
  ],
  archived: [
    {
      action: "restore",
      label: "Restore to draft",
      confirmation:
        "Restore this deleted content as a draft. This does not publish it.",
      success: "Restored to draft.",
    },
  ],
};

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readVersion(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1
    ? value
    : undefined;
}

function valuesFromDocument(
  target: ContentQuickEditTarget,
  document: Record<string, unknown>,
  fallbackTitle: string,
): QuickValues {
  if (target.kind === "page") {
    const defaults = pageCompositionSeed(target.pageId)?.metadata ?? {};
    const metadata = { ...defaults, ...document };
    return {
      title: readString(metadata.title) || fallbackTitle,
      description: readString(metadata.description),
      summary: "",
    };
  }
  return {
    title: readString(document.title) || fallbackTitle,
    description: "",
    summary: readString(document.summary),
  };
}

function targetKey(target: ContentQuickEditTarget): string {
  return target.kind === "page"
    ? `page:${target.pageId}`
    : `${target.kind}:${target.recordId}`;
}

function resourceFor(
  target: ContentQuickEditTarget,
  document: Record<string, unknown>,
): Resource {
  if (target.kind === "page") {
    return pageLifecycleResource(target.pageId, {
      expectedAbsent: false,
      pageStatus: document.status,
      createdBy: document.createdBy,
      editingSection: document.section,
    });
  }
  return recordLifecycleResource(document);
}

function permitted(
  action: LifecycleAction,
  principal: Principal,
  resource: Resource,
): boolean {
  if (action === "submit") return canEditContent(principal, resource);
  if (
    action === "approve" ||
    action === "sendBack" ||
    action === "reopen"
  ) {
    return can(principal, "content.edit.any", resource);
  }
  if (action === "unschedule") {
    return can(principal, "content.publish", resource);
  }
  if (action === "unpublish") {
    return can(principal, "content.unpublish", resource);
  }
  if (action === "archive" || action === "restore") {
    return can(principal, "content.delete", resource);
  }
  return false;
}

async function loadDocument(
  api: ContentQuickActionsApi,
  target: ContentQuickEditTarget,
): Promise<Record<string, unknown> | null> {
  return target.kind === "page"
    ? api.loadPage(target.pageId)
    : api.loadRecord(target.kind, target.recordId);
}

export function ContentQuickEdit({
  restoreOnly: requestedRestoreOnly = false,
  label,
  target,
  persistentEditorDirty = false,
  onDocumentChange,
}: ContentQuickEditProps) {
  const restoreOnly =
    requestedRestoreOnly || (target.kind !== "page" && target.kind !== "post");
  const api = useContentQuickActions();
  const headingId = useId();
  const confirmationId = useId();
  // A row owns one immutable page or record id. Keep the registry/list title only as
  // the initial fallback; a successful quick edit adopts the server-returned title
  // without causing the component to reload itself from a parent row update.
  const fallbackLabel = useRef(label);
  const [reload, setReload] = useState(0);
  const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });
  const [values, setValues] = useState<QuickValues>({
    title: label,
    description: "",
    summary: "",
  });
  const [saving, setSaving] = useState(false);
  const [changingStatus, setChangingStatus] = useState(false);
  const [pendingAction, setPendingAction] =
    useState<QuickLifecycleAction | null>(null);
  const [reviewNote, setReviewNote] = useState("");
  const [message, setMessage] = useState<{
    tone: "success" | "error" | "info";
    title: string;
    copy: string;
    conflict?: boolean;
  } | null>(null);
  const key = targetKey(target);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    setLoadState({ status: "loading" });
    setMessage(null);
    setPendingAction(null);
    setReviewNote("");
    void loadDocument(api, target)
      .then((document) => {
        if (cancelled) return;
        if (!document) {
          setLoadState({ status: "missing" });
          return;
        }
        setValues(valuesFromDocument(target, document, fallbackLabel.current));
        setLoadState({ status: "ready", document });
        if (restoreOnly && document.status === "archived" &&
          permitted("restore", api.principal, resourceFor(target, document))) {
          setPendingAction(LIFECYCLE_ACTIONS.archived[0]);
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadState({
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : "Quick edit could not load this content.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [api, key, reload, restoreOnly]);

  const document = loadState.status === "ready" ? loadState.document : null;
  const baseline = useMemo(
    () =>
      document
        ? valuesFromDocument(target, document, fallbackLabel.current)
        : null,
    [document, key],
  );
  const dirty = baseline
    ? target.kind === "page"
      ? values.title !== baseline.title || values.description !== baseline.description
      : values.title !== baseline.title || values.summary !== baseline.summary
    : false;
  const version = document ? readVersion(document.version) : undefined;
  const status = document ? readString(document.status) : "";
  const resource = document ? resourceFor(target, document) : {};
  const lifecycleActions = Object.prototype.hasOwnProperty.call(
    LIFECYCLE_ACTIONS,
    status,
  )
    ? LIFECYCLE_ACTIONS[status]
    : [];
  const actions = document && api
    ? lifecycleActions.filter((candidate) =>
        permitted(candidate.action, api.principal, resource),
      )
    : [];
  const saveDecision = useMemo(() => {
    if (!api || !document) return null;
    return target.kind === "page"
      ? pageSaveDecision(api.principal, target.pageId, {
          expectedAbsent: false,
          pageStatus: document.status,
          createdBy: document.createdBy,
          editingSection: document.section,
        })
      : recordSaveDecision(api.principal, document);
  }, [api, document, key]);
  const metadataAllowed = !restoreOnly && saveDecision?.allowed === true;
  const busy = saving || changingStatus;
  const metadataDisabled = busy || !metadataAllowed || version === undefined;
  const lifecycleDisabled =
    busy || dirty || persistentEditorDirty || version === undefined;

  function adoptDocument(next: Record<string, unknown>) {
    setValues(valuesFromDocument(target, next, fallbackLabel.current));
    setLoadState({ status: "ready", document: next });
    onDocumentChange?.(next);
  }

  async function saveMetadata(): Promise<ExitSaveOutcome> {
    if (!dirty) return { status: "saved" };
    if (!api || !document || busy || version === undefined) {
      return { status: "failed" };
    }
    if (!metadataAllowed) {
      setMessage({
        tone: "error",
        title: "Quick edits were not saved",
        copy:
          saveDecision && !saveDecision.allowed
            ? saveDecision.reason
            : "This content cannot be edited in its current state.",
      });
      return { status: "failed" };
    }
    if (values.title.trim() === "") {
      setMessage({
        tone: "error",
        title: "Quick edits were not saved",
        copy: "Title is required.",
      });
      return { status: "failed" };
    }

    setSaving(true);
    setMessage(null);
    try {
      const next =
        target.kind === "page"
          ? await api.savePageMetadata(
              target.pageId,
              {
                title: values.title.trim(),
                description: values.description,
              },
              version,
            )
          : await api.saveRecordMetadata(
              target.kind,
              target.recordId,
              {
                title: values.title.trim(),
                summary: values.summary,
              },
              version,
            );
      adoptDocument(next);
      setMessage({
        tone: "success",
        title: "Quick edits saved",
        copy: "The saved version was updated without opening the full editor.",
      });
      return { status: "saved" };
    } catch (error) {
      const conflict =
        typeof error === "object" &&
        error !== null &&
        (error as { status?: unknown }).status === 409;
      setMessage({
        tone: "error",
        title: "Quick edits were not saved",
        copy:
          error instanceof Error
            ? error.message
            : "The save failed. Reload quick edit and try again.",
        conflict,
      });
      return { status: "failed" };
    } finally {
      setSaving(false);
    }
  }

  async function confirmStatusChange(
    action: QuickLifecycleAction | null = pendingAction,
  ) {
    if (
      !api ||
      !document ||
      !action ||
      busy ||
      dirty ||
      persistentEditorDirty ||
      version === undefined
    ) {
      return;
    }
    const note = reviewNote.trim();
    if (action.commentRequired && note === "") {
      setMessage({
        tone: "error",
        title: "Status was not changed",
        copy: "Add a review note before sending this content back to draft.",
      });
      return;
    }

    setChangingStatus(true);
    setMessage(null);
    try {
      const next = await api.transition({
        collection: target.kind === "page" ? "cmsPages" : "cmsPosts",
        id: target.kind === "page" ? target.pageId : target.recordId,
        action: action.action,
        baseVersion: version,
        ...(action.commentRequired ? { comment: note } : {}),
      });
      const success = action.success;
      adoptDocument(next);
      setPendingAction(null);
      setReviewNote("");
      setMessage({
        tone: "success",
        title: "Status updated",
        copy: success,
      });
    } catch (error) {
      const conflict =
        typeof error === "object" &&
        error !== null &&
        (error as { status?: unknown }).status === 409;
      setMessage({
        tone: "error",
        title: "Status was not changed",
        copy:
          error instanceof Error
            ? error.message
            : "The lifecycle request failed. Reload quick edit and try again.",
        conflict,
      });
    } finally {
      setChangingStatus(false);
    }
  }

  useRegisterContentQuickEditGuard({
    label,
    dirty,
    saving: busy,
    save: saveMetadata,
  });

  if (!api) return null;

  if (loadState.status === "loading") {
    return (
      <div className="content-quick-edit-loading">
        <LoadingIndicator
          label="Loading quick edit"
          stages={[
            "Fetching the saved metadata for this item",
            "Checking its current status and version",
          ]}
        />
      </div>
    );
  }

  if (loadState.status === "missing") {
    return (
      <InlineMessage tone="info" title="No saved draft yet">
        Use the full editor to create this page or record before using quick edit.
      </InlineMessage>
    );
  }

  if (loadState.status === "error") {
    return (
      <InlineMessage tone="error" title="Quick edit could not be loaded">
        <span>{loadState.message}</span>
        <Button disabled={busy} onClick={() => setReload((value) => value + 1)}>
          Try again
        </Button>
      </InlineMessage>
    );
  }

  return (
    <section
      className="content-quick-edit"
      aria-busy={busy || undefined}
      aria-labelledby={headingId}
    >
      <div className="content-quick-edit-heading">
        <div>
          <h3 id={headingId}>{restoreOnly ? "Restore deleted content" : "Quick edit"}</h3>
          <p>{restoreOnly ? "Restore this item to the main list as a draft. This does not publish it." : "Change common metadata and use valid workflow transitions in place."}</p>
        </div>
        <StatusBadge tone={contentStatusTone(status)}>
          {displayContentStatus(status)}
        </StatusBadge>
      </div>

      {!restoreOnly && !metadataAllowed && saveDecision && !saveDecision.allowed ? (
        <InlineMessage tone="info" title="Quick-edit fields are read-only">
          {saveDecision.reason}
        </InlineMessage>
      ) : null}

      {!restoreOnly ? <form
        className="content-quick-edit-form"
        onSubmit={(event) => {
          event.preventDefault();
          void saveMetadata();
        }}
      >
        {target.kind === "page" && target.pageId === "data-hub" ? (
          <p className="content-quick-edit-note content-quick-edit-wide-field">
            These fields set browser and link metadata. Use the Page editor's Page introduction section for the visible heading and opening text.
          </p>
        ) : null}
        <label>
          <span>Title</span>
          <TextInput
            disabled={metadataDisabled}
            value={values.title}
            onChange={(event) => {
              setValues((current) => ({ ...current, title: event.target.value }));
              setMessage(null);
            }}
          />
        </label>
        {target.kind === "page" ? (
          <label className="content-quick-edit-wide-field">
            <span>Description</span>
            <Textarea
              disabled={metadataDisabled}
              rows={3}
              value={values.description}
              onChange={(event) => {
                setValues((current) => ({
                  ...current,
                  description: event.target.value,
                }));
                setMessage(null);
              }}
            />
          </label>
        ) : (
          <label className="content-quick-edit-wide-field">
            <span>Summary</span>
            <Textarea
              disabled={metadataDisabled}
              rows={3}
              value={values.summary}
              onChange={(event) => {
                setValues((current) => ({ ...current, summary: event.target.value }));
                setMessage(null);
              }}
            />
          </label>
        )}
        <div className="content-quick-edit-save content-quick-edit-wide-field">
          <AsyncActionButton
            variant="primary"
            disabled={!dirty || busy || !metadataAllowed || version === undefined}
            label="Save quick edits"
            pending={saving}
            pendingAnnouncement="Saving quick edits."
            pendingLabel="Saving…"
            onClick={() => void saveMetadata()}
          />
          {dirty ? (
            <Button
              disabled={busy}
              onClick={() => {
                if (baseline) setValues(baseline);
                setMessage(null);
              }}
            >
              Discard field changes
            </Button>
          ) : null}
          {version === undefined ? (
            <span className="content-quick-edit-note">
              Open the full editor before changing a legacy record with no saved version.
            </span>
          ) : null}
        </div>
      </form> : null}

      <div className="content-quick-edit-workflow">
        {!restoreOnly ? <div>
          <h4>Lifecycle</h4>
          <p>
            Quick edit never bypasses review, publication, archive, or permission rules.
          </p>
        </div> : null}
        {persistentEditorDirty ? (
          <p className="content-quick-edit-note">
            Save or discard the full editor draft before changing status here.
          </p>
        ) : dirty ? (
          // The status buttons go quiet the moment a field here changes. Without this line
          // the cause is invisible even though the Save button that clears it is one row up.
          <p className="content-quick-edit-note">
            Save or discard your quick edits before changing status.
          </p>
        ) : null}
        {restoreOnly && version === undefined ? <p className="content-quick-edit-note">
          Open the full editor before restoring an item with no saved version.
        </p> : null}
        {restoreOnly && pendingAction ? null : actions.length > 0 ? (
          <div className="content-quick-edit-action-list">
            {actions.filter((candidate) => !restoreOnly || candidate.action === "restore").map((candidate) =>
              (
                <Button
                  key={candidate.action}
                  disabled={lifecycleDisabled}
                  variant={candidate.danger ? "danger" : "secondary"}
                  onClick={() => {
                    setPendingAction(candidate);
                    setReviewNote("");
                    setMessage(null);
                  }}
                >
                  {candidate.label}
                </Button>
              ),
            )}
          </div>
        ) : (
          <p className="content-quick-edit-note">
            No quick status action is available for this saved state and your access.
          </p>
        )}
      </div>

      {pendingAction ? (
        <div
          className="content-quick-edit-confirmation"
          role="group"
          aria-labelledby={confirmationId}
        >
          <strong id={confirmationId}>{pendingAction.label}?</strong>
          <p>{pendingAction.confirmation}</p>
          {pendingAction.commentRequired ? (
            <label>
              <span>Review note</span>
              <Textarea
                disabled={busy}
                rows={3}
                value={reviewNote}
                onChange={(event) => setReviewNote(event.target.value)}
              />
            </label>
          ) : null}
          <div className="button-row">
            <AsyncActionButton
              variant={pendingAction.danger ? "danger" : "primary"}
              disabled={lifecycleDisabled}
              label={`Confirm ${pendingAction.label.toLowerCase()}`}
              pending={changingStatus}
              pendingAnnouncement={`Changing status: ${pendingAction.label}.`}
              pendingLabel="Changing…"
              onClick={() => void confirmStatusChange()}
            />
            <Button
              disabled={busy}
              onClick={() => {
                setPendingAction(null);
                setReviewNote("");
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {message ? (
        <InlineMessage tone={message.tone} title={message.title}>
          <span>{message.copy}</span>
          {message.conflict ? (
            <Button
              disabled={busy}
              onClick={() => setReload((value) => value + 1)}
            >
              Reload quick edit
            </Button>
          ) : null}
        </InlineMessage>
      ) : null}
    </section>
  );
}
