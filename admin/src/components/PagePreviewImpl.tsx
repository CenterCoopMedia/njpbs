import { previewPageUrl } from "../lib/preview-url";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  PreviewRequestResponse,
  PreviewStatusResponse,
} from "../lib/functions";
import type { PublicPageId } from "../../../packages/content-core/src/public-pages";
import {
  AsyncActionButton,
  Button,
  InlineMessage,
  StatusBadge,
} from "./ui/Primitives";
import { EditorActionSlot } from "./EditorActions";

const MAX_CONSECUTIVE_POLL_FAILURES = 3;
const DEFAULT_PREVIEW_POLL_DELAYS_MS = [750, 1_500, 3_000, 4_000] as const;

type PreviewState =
  | { kind: "idle" }
  | { kind: "requesting" }
  | {
      kind: "building";
      queueId: string;
      sourceVersion: number;
      status: "pending" | "building";
      pollError?: string;
    }
  | {
      kind: "ready";
      queueId: string;
      sourceVersion: number;
      previewUrl: string;
      expiresAt: string | null;
    }
  | {
      kind: "expired";
      queueId: string;
      sourceVersion: number;
    }
  | { kind: "error"; message: string };

export interface PagePreviewProps {
  pageId: PublicPageId;
  pagePath: string;
  dirty: boolean;
  saving: boolean;
  // The page version currently in the store, not a change counter: retirement compares it with
  // the version the service actually captured, so the answer does not depend on which of the two
  // arrives first (#1042).
  savedVersion?: number;
  requestPreview?: (pageId: PublicPageId) => Promise<PreviewRequestResponse>;
  loadPreviewStatus?: (queueId: string) => Promise<PreviewStatusResponse>;
  // Test and environment override for the follow-up cadence. The first status check is always
  // immediate; when this is absent, polling backs off from 750 ms to a four-second ceiling.
  pollIntervalMs?: number;
  // When the preview is hosted inside a bento card, the card supplies the title and description, so
  // the section renders without its own heading — the status stays as a compact badge above the
  // actions instead of sitting in the (now absent) heading row.
  headless?: boolean;
  workspaceAction?: boolean;
  onReveal?: () => void;
  // A confirmed discard remounts the page editor while it reloads the stored
  // revision. The owner carries this one-shot intent across that remount.
  startOnMount?: boolean;
  onStartOnMountHandled?: () => void;
  // The two ways out of unsaved work, supplied by the editor that owns it (#1042). `saveChanges`
  // is the workspace's one page-save sequence — the same one the Save draft control and the exit
  // guard run (#1032) — so the preview cannot invent a second definition of "this page is saved".
  // It answers whether the save actually landed. `discardChanges` throws the local draft away and
  // re-reads the stored page. Absent both, the panel falls back to stating the requirement.
  saveChanges?: () => Promise<boolean>;
  discardChanges?: () => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "The preview could not be built.";
}

function retryableStatusError(error: unknown): boolean {
  const status =
    typeof error === "object" &&
    error !== null &&
    typeof (error as { status?: unknown }).status === "number"
      ? (error as { status: number }).status
      : null;
  if (status !== null) {
    return status === 408 || status === 429 || status >= 500;
  }
  if (error instanceof TypeError) return true;
  return (
    error instanceof DOMException &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}


function formattedExpiry(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function expiryMillis(value: string | null): number | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function PagePreview({
  pageId,
  pagePath,
  dirty,
  saving,
  savedVersion = 0,
  requestPreview,
  loadPreviewStatus,
  pollIntervalMs,
  headless = false,
  workspaceAction = false,
  onReveal,
  startOnMount = false,
  onStartOnMountHandled,
  saveChanges,
  discardChanges,
}: PagePreviewProps) {
  const [preview, setPreview] = useState<PreviewState>({ kind: "idle" });
  const [copyStatus, setCopyStatus] = useState<
    "idle" | "copying" | "copied" | "failed"
  >("idle");
  // The gate's own state: which decision is on screen, whether its save is running, and what a
  // save that did not land reported. Separate from `preview` because a page can be unsaved while
  // an older artifact is still listed.
  const [gateStep, setGateStep] = useState<"choose" | "confirm-discard">(
    "choose",
  );
  const [gateSaving, setGateSaving] = useState(false);
  const [gateError, setGateError] = useState<string | null>(null);
  const requestGeneration = useRef(0);
  const startOnMountHandled = useRef(false);
  const previewRef = useRef(preview);
  previewRef.current = preview;

  // Moving to another page retires everything: the artifact belongs to the page that was left,
  // and an in-flight request for it can no longer be shown here.
  useEffect(() => {
    requestGeneration.current += 1;
    setPreview({ kind: "idle" });
    setCopyStatus("idle");
    return () => {
      requestGeneration.current += 1;
    };
  }, [pageId]);

  // Retire any artifact the page has moved past, whether it is finished or still being built. An
  // accepted request carries the exact version the service captured, so the comparison is by
  // version rather than by "a save happened": the save-and-preview gate raises the stored version
  // as part of starting its own build, and a rule that retired on any change would cancel exactly
  // the build that save asked for. A later save through Update does move past the captured
  // version, and that build is retired mid-flight rather than being allowed to finish and present
  // a ready link under a page that has since changed (#1042).
  //
  // A request that has not been accepted yet has no captured version to compare and is left
  // alone: the service snapshots the page when it accepts, so it will capture whatever is stored
  // at that moment and report it back.
  useEffect(() => {
    const current = previewRef.current;
    if (current.kind !== "building" && current.kind !== "ready") return;
    if (current.sourceVersion >= savedVersion) return;
    requestGeneration.current += 1;
    setPreview({ kind: "idle" });
    setCopyStatus("idle");
  }, [preview, savedVersion]);

  // The gate is about the work in the editor right now. Once nothing is outstanding, its prompt
  // and its failure both stop describing anything true.
  useEffect(() => {
    if (dirty) return;
    setGateStep("choose");
    setGateError(null);
  }, [dirty]);

  const queueId = preview.kind === "building" ? preview.queueId : null;
  useEffect(() => {
    if (!queueId || !loadPreviewStatus) return;
    const activeQueueId = queueId;
    const statusLoader = loadPreviewStatus;
    let stopped = false;
    let consecutiveFailures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let followUpIndex = 0;
    let lastStatus =
      previewRef.current.kind === "building" &&
      previewRef.current.queueId === activeQueueId
        ? previewRef.current.status
        : null;

    function scheduleNextPoll(resetBackoff = false) {
      if (stopped) return;
      if (resetBackoff) followUpIndex = 0;
      const delay =
        typeof pollIntervalMs === "number"
          ? Math.max(0, pollIntervalMs)
          : DEFAULT_PREVIEW_POLL_DELAYS_MS[
              Math.min(
                followUpIndex,
                DEFAULT_PREVIEW_POLL_DELAYS_MS.length - 1,
              )
            ];
      followUpIndex += 1;
      timer = setTimeout(() => {
        void poll();
      }, delay);
    }

    async function poll() {
      try {
        const status = await statusLoader(activeQueueId);
        if (stopped) return;
        consecutiveFailures = 0;
        if (status.pageId !== pageId) {
          setPreview({
            kind: "error",
            message: "The preview result did not match this page.",
          });
          return;
        }
        if (status.status === "pending" || status.status === "building") {
          const phaseChanged = lastStatus !== null && lastStatus !== status.status;
          lastStatus = status.status;
          setPreview({
            kind: "building",
            queueId: activeQueueId,
            sourceVersion: status.sourceVersion,
            status: status.status,
          });
          scheduleNextPoll(phaseChanged);
          return;
        }
        if (status.status === "ready" && status.previewUrl) {
          try {
            previewPageUrl(status.previewUrl, pagePath, activeQueueId);
          } catch {
            setPreview({
              kind: "error",
              message: "The preview service returned an invalid reviewer URL.",
            });
            return;
          }
          const expiresAt = expiryMillis(status.expiresAt);
          if (expiresAt === null) {
            setPreview({
              kind: "error",
              message: "The preview service returned an invalid expiry time.",
            });
            return;
          }
          if (expiresAt <= Date.now()) {
            setPreview({
              kind: "expired",
              queueId: activeQueueId,
              sourceVersion: status.sourceVersion,
            });
            return;
          }
          setPreview({
            kind: "ready",
            queueId: activeQueueId,
            sourceVersion: status.sourceVersion,
            previewUrl: status.previewUrl,
            expiresAt: status.expiresAt,
          });
          return;
        }
        if (status.status === "expired") {
          setPreview({
            kind: "expired",
            queueId: activeQueueId,
            sourceVersion: status.sourceVersion,
          });
          return;
        }
        setPreview({
          kind: "error",
          message: status.error || "The preview build failed.",
        });
      } catch (error) {
        if (!stopped) {
          if (retryableStatusError(error)) {
            consecutiveFailures += 1;
            if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
              setPreview({ kind: "error", message: errorMessage(error) });
            } else {
              setPreview((current) =>
                current.kind === "building" &&
                current.queueId === activeQueueId
                  ? { ...current, pollError: errorMessage(error) }
                  : current,
              );
              scheduleNextPoll();
            }
          } else {
            setPreview({ kind: "error", message: errorMessage(error) });
          }
        }
      }
    }

    // The request response already supplied the immutable queue id. Waiting before the first
    // status read only adds dead time, so check once now and back off only while it remains active.
    void poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [loadPreviewStatus, pageId, pagePath, pollIntervalMs, queueId]);

  useEffect(() => {
    if (preview.kind !== "ready") return;
    const expiresAt = expiryMillis(preview.expiresAt);
    if (expiresAt === null) return;
    const expire = () => {
      setPreview((current) =>
        current.kind === "ready" &&
        current.queueId === preview.queueId &&
        current.expiresAt === preview.expiresAt
          ? {
              kind: "expired",
              queueId: current.queueId,
              sourceVersion: current.sourceVersion,
            }
          : current,
      );
    };
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      expire();
      return;
    }
    const timer = setTimeout(expire, remaining);
    return () => clearTimeout(timer);
  }, [preview]);

  const previewHref = useMemo(
    () =>
      preview.kind === "ready"
        ? previewPageUrl(preview.previewUrl, pagePath, preview.queueId)
        : null,
    [pagePath, preview],
  );
  const expiry =
    preview.kind === "ready" ? formattedExpiry(preview.expiresAt) : null;
  const disconnected = !requestPreview || !loadPreviewStatus;
  const disabledReason = disconnected
    ? "Preview builds are not configured in this environment."
    : saving
      ? "Wait for the current save to finish."
      : dirty
        ? "Save or discard this page’s changes before building a preview."
        : null;
  const requesting = preview.kind === "requesting";
  const building = preview.kind === "building";
  // Unsaved work is a decision, not a locked button: offer the two ways forward whenever the
  // editor gave this panel a way to take them. Without them the panel keeps stating the
  // requirement, which is all it can honestly do.
  const gateAvailable =
    dirty && !disconnected && Boolean(saveChanges) && Boolean(discardChanges);
  const openTabDescriptionId = `page-preview-open-tab-${pageId}`;

  async function buildPreview() {
    if (disabledReason || requesting || building) return;
    await startPreviewBuild();
  }

  // The request itself, without the "is this page saved" question in front of it. The gate below
  // answers that question by actually saving or discarding, so it calls this directly rather than
  // racing the `dirty` prop it just changed.
  async function startPreviewBuild() {
    if (!requestPreview) return;
    const generation = ++requestGeneration.current;
    setCopyStatus("idle");
    setPreview({ kind: "requesting" });
    try {
      const result = await requestPreview(pageId);
      if (generation !== requestGeneration.current) return;
      setPreview({
        kind: "building",
        queueId: result.queueId,
        sourceVersion: result.sourceVersion,
        status: result.status,
      });
    } catch (error) {
      if (generation !== requestGeneration.current) return;
      setPreview({ kind: "error", message: errorMessage(error) });
    }
  }

  useEffect(() => {
    if (!startOnMount || startOnMountHandled.current || disconnected) return;
    startOnMountHandled.current = true;
    onStartOnMountHandled?.();
    void startPreviewBuild();
  }, [disconnected, onStartOnMountHandled, startOnMount]);

  // Save through the editor's own page-save sequence, then build. A save that did not land never
  // becomes a build: the artifact would then be the older stored revision while the button that
  // produced it said the changes were saved.
  async function saveAndBuild() {
    if (!saveChanges || gateSaving || saving) return;
    setGateError(null);
    setGateSaving(true);
    let landed = false;
    try {
      landed = await saveChanges();
    } catch (error) {
      setGateError(
        `${errorMessage(error)} Your changes were not saved, so no preview was built.`,
      );
      return;
    } finally {
      setGateSaving(false);
    }
    if (!landed) {
      setGateError(
        "Your changes were not saved, so no preview was built. Fix what the page editor reports, then try again.",
      );
      return;
    }
    await startPreviewBuild();
  }

  function discardAndReset() {
    if (!discardChanges || gateSaving || saving) return;
    setGateStep("choose");
    setGateError(null);
    discardChanges();
  }

  async function copyLink() {
    if (!previewHref || copyStatus === "copying") return;
    setCopyStatus("copying");
    try {
      await navigator.clipboard.writeText(previewHref);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  }

  const statusBadge = (
    <StatusBadge
      tone={
        preview.kind === "ready"
          ? "success"
          : building || requesting
            ? "pending"
            : preview.kind === "error"
              ? "failed"
              : "neutral"
      }
    >
      {preview.kind === "ready"
        ? "Ready"
        : building
          ? preview.status === "pending"
            ? "Queued"
            : "Building"
          : requesting
            ? "Requesting"
            : preview.kind === "expired"
              ? "Expired"
              : preview.kind === "error"
                ? "Build failed"
                : "Not built"}
    </StatusBadge>
  );

  const Wrapper = headless ? "div" : "section";
  return (
    <Wrapper
      className={
        headless ? "page-preview-editor--headless" : "page-preview-editor"
      }
      aria-labelledby={headless ? undefined : "page-preview-heading"}
    >
      {workspaceAction ? (
        <EditorActionSlot group="preview">
          <AsyncActionButton
            label="Preview"
            icon="monitor"
            size="standard"
            onClick={() => {
              onReveal?.();
              if (!dirty && !disabledReason) void buildPreview();
            }}
            pending={requesting || building}
            pendingAnnouncement={requesting ? "Requesting preview." : undefined}
            pendingLabel={requesting ? "Requesting preview…" : "Building preview…"}
            reserveLabel="Preview"
            variant="ghost"
          />
        </EditorActionSlot>
      ) : null}
      {headless ? (
        <div className="page-preview-status-row">{statusBadge}</div>
      ) : (
        <div className="page-editor-section-heading">
          <div>
            <h3 id="page-preview-heading">Page preview</h3>
            <p>
              Build the saved draft and open its real public route in a new tab.
            </p>
          </div>
          {statusBadge}
        </div>
      )}

      {gateAvailable ? (
        <div className="page-preview-gate">
          {gateStep === "choose" ? (
            <>
              <p className="page-preview-help">
                A preview always builds this page’s last saved version, so it
                cannot show work that is still only in your browser. Save your
                changes to preview them, or discard them to preview the saved
                version.
              </p>
              <div className="page-preview-gate-actions">
                <AsyncActionButton
                  variant="primary"
                  disabled={saving && !gateSaving}
                  label="Save and preview"
                  onClick={() => void saveAndBuild()}
                  pending={gateSaving}
                  pendingAnnouncement="Saving your changes before building the preview."
                  pendingLabel="Saving changes…"
                  reserveLabel="Save and preview"
                />
                <Button
                  variant="ghost"
                  disabled={gateSaving || saving}
                  onClick={() => setGateStep("confirm-discard")}
                >
                  Discard changes
                </Button>
              </div>
              {saving && !gateSaving ? (
                <p className="page-preview-help" role="status">
                  Wait for the current save to finish.
                </p>
              ) : null}
            </>
          ) : (
            <div className="page-preview-gate-confirm">
              <p className="page-preview-help">
                <strong>Discard your unsaved changes?</strong> This page’s
                unsaved edits are lost, and the preview builds the last saved
                version instead. This cannot be undone.
              </p>
              <div className="page-preview-gate-actions">
                <Button variant="danger" onClick={discardAndReset}>
                  Discard unsaved changes
                </Button>
                <Button variant="ghost" onClick={() => setGateStep("choose")}>
                  Keep editing
                </Button>
              </div>
            </div>
          )}
          {gateError ? (
            <InlineMessage tone="error" title="No preview was built">
              <p>{gateError}</p>
            </InlineMessage>
          ) : null}
        </div>
      ) : (
        <div className="page-preview-actions">
          <div>
            <AsyncActionButton
              variant="secondary"
              disabled={Boolean(disabledReason)}
              label={
                preview.kind === "idle" || requesting || building
                  ? "Build preview"
                  : "Build a new preview"
              }
              onClick={() => void buildPreview()}
              pending={requesting || building}
              pendingAnnouncement={requesting ? "Requesting preview." : undefined}
              pendingLabel={requesting ? "Requesting preview…" : "Building preview…"}
              reserveLabel="Build a new preview"
            />
            {disabledReason ? (
              <p className="page-preview-help">{disabledReason}</p>
            ) : (
              <p className="page-preview-help">
                The preview is private, no-index, and always uses the latest saved
                version—not unsaved work.
              </p>
            )}
            {preview.kind === "building" ? (
              <p className="page-preview-version" role="status">
                Building saved version {preview.sourceVersion}…
              </p>
            ) : null}
          </div>
        </div>
      )}

      {preview.kind === "error" ? (
        <InlineMessage tone="error" title="Preview unavailable">
          <p>{preview.message}</p>
        </InlineMessage>
      ) : null}
      {preview.kind === "building" && preview.pollError ? (
        <InlineMessage tone="info" title="Preview status temporarily unavailable">
          <p>{preview.pollError} Checking again automatically.</p>
        </InlineMessage>
      ) : null}
      {preview.kind === "expired" ? (
        <InlineMessage tone="info" title="This preview is no longer listed">
          <p>
            Build a new preview to review the current saved version of this page.
          </p>
        </InlineMessage>
      ) : null}

      {preview.kind === "ready" && previewHref ? (
        <div className="page-preview-ready">
          <div className="page-preview-toolbar">
            <div className="page-preview-link-actions">
              <a
                aria-describedby={openTabDescriptionId}
                className="button button-primary page-preview-open-tab"
                href={previewHref}
                target="_blank"
                rel="noreferrer"
              >
                Open in new tab
              </a>
              <AsyncActionButton
                label={copyStatus === "copied" ? "Copied" : "Copy link"}
                pending={copyStatus === "copying"}
                pendingAnnouncement="Copying preview link."
                pendingLabel="Copying link…"
                variant="ghost"
                onClick={() => void copyLink()}
              />
            </div>
          </div>
          <p className="page-preview-help" id={openTabDescriptionId}>
            Opens saved version {preview.sourceVersion} of this page in a new
            browser tab. Opening it again adds a separate tab and leaves this
            one where it is.
          </p>
          {copyStatus === "failed" ? (
            <p className="page-preview-copy-error" role="alert">
              The link could not be copied. Open it in a new tab and copy it
              from the address bar.
            </p>
          ) : null}
          {copyStatus === "copied" ? (
            <p className="sr-only" role="status">
              Preview link copied.
            </p>
          ) : null}
          <div className="page-preview-details">
            <span>Saved version {preview.sourceVersion}</span>
            <span>Private reviewer link</span>
            {expiry ? <span>Listed until {expiry}</span> : null}
          </div>
        </div>
      ) : null}
    </Wrapper>
  );
}
