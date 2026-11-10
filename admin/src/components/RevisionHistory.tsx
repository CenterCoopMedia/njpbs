import { useEditorWorkspaceView } from "../context/EditorWorkspaceView";
import { RetainedEditorHost } from "./RetainedEditorHost";
import { useEffect, useId, useRef, useState } from "react";
import { displayContentStatus, contentStatusTone } from "../lib/content-status";
import { buildRevisionDiff, type RevisionBlockChange } from "../lib/revision-diff";
import type {
  GetRevisionResponse,
  ListRevisionsResponse,
  RestoreRevisionResponse,
  RevisionDetail,
  RevisionSummary,
  SaveCollection,
} from "../lib/functions";
import { Button, EmptyState, InlineMessage, StatusBadge } from "./ui/Primitives";
import { LoadingIndicator } from "./ui/LoadingIndicator";

type TimelineState =
  | { status: "loading" }
  | { status: "ready"; entries: RevisionSummary[]; nextCursor: string | null }
  | { status: "error" };

type DetailState =
  | { status: "idle" }
  | { status: "loading"; id: string }
  | { status: "ready"; revision: RevisionDetail }
  | { status: "error"; id: string };

type RestoreState =
  | { status: "idle" }
  | { status: "confirming"; id: string }
  | { status: "saving"; id: string }
  | { status: "restored"; id: string; label: string }
  | { status: "error"; id: string; message: string };

interface RevisionHistoryProps {
  collection: SaveCollection;
  documentId: string;
  loadRevisions: (
    collection: SaveCollection,
    documentId: string,
    cursor?: string,
  ) => Promise<ListRevisionsResponse>;
  loadRevision: (
    collection: SaveCollection,
    documentId: string,
    revisionId: string,
  ) => Promise<GetRevisionResponse>;
  currentVersion?: number;
  restoreRevision?: (
    collection: SaveCollection,
    documentId: string,
    revisionId: string,
    baseVersion: number,
  ) => Promise<RestoreRevisionResponse>;
  onRestored?: (document: Record<string, unknown>) => void | Promise<void>;
  onRestoringChange?: (restoring: boolean) => void;
  restoreDisabledReason?: string;
  refreshKey?: number;
  headless?: boolean;
}

function revisionVersion(entry: RevisionSummary): string {
  return entry.version === null ? "Unversioned change" : `Version ${entry.contentVersion ?? entry.version}`;
}

function formatInstant(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function words(value: string): string {
  const spaced = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .replaceAll("-", " ");
  return `${spaced.charAt(0).toUpperCase()}${spaced.slice(1)}`;
}

function valueSummary(value: unknown): string {
  if (value === null || value === undefined) return "Not set";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized.length > 120 ? `${normalized.slice(0, 117)}…` : normalized || "Empty";
  }
  if (Array.isArray(value)) return `${value.length} ${value.length === 1 ? "item" : "items"}`;
  return "Structured value changed";
}

function richTextSummary(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const root = value as { type?: unknown };
  if (root.type !== "doc") return null;
  const parts: string[] = [];

  function visit(node: unknown): void {
    if (typeof node !== "object" || node === null || Array.isArray(node)) return;
    const record = node as { type?: unknown; text?: unknown; content?: unknown };
    if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
    if (record.type === "hardBreak") parts.push("\n");
    if (Array.isArray(record.content)) record.content.forEach(visit);
    if (
      record.type === "paragraph" ||
      record.type === "heading" ||
      record.type === "listItem" ||
      record.type === "blockquote"
    ) {
      parts.push("\n");
    }
  }

  visit(value);
  const text = parts.join("").replace(/\n{3,}/g, "\n\n").trim();
  return text || "Empty rich text";
}

function structuredEvidence(value: unknown): string {
  const raw = JSON.stringify(value);
  if (!raw) return "No structured value";
  const limit = 4_000;
  return raw.length > limit ? `${raw.slice(0, limit - 1)}…` : raw;
}

function ValueEvidence({ value }: { value: unknown }) {
  if (typeof value !== "object" || value === null) return <>{valueSummary(value)}</>;
  const readable = richTextSummary(value);
  return (
    <div className="revision-value-evidence">
      {readable ? <p>{readable}</p> : <p>{valueSummary(value)}</p>}
      <details>
        <summary>Show structured evidence</summary>
        <code>{structuredEvidence(value)}</code>
      </details>
    </div>
  );
}

function blockChangeCopy(change: RevisionBlockChange): string {
  if (change.kind === "added") return "Added to the composition.";
  if (change.kind === "removed") return "Removed from the composition.";
  const changes: string[] = [];
  if (change.moved && change.beforeIndex !== null && change.afterIndex !== null) {
    changes.push(`Moved from position ${change.beforeIndex + 1} to ${change.afterIndex + 1}`);
  }
  if (change.visibilityChanged) changes.push("Visibility changed");
  if (change.typeChanged) changes.push("Block type changed");
  if (change.envelopeChanges.length > 0) {
    changes.push(
      `Updated ${change.envelopeChanges.map(({ field }) => words(field).toLowerCase()).join(", ")}`,
    );
  }
  if (change.changedDataFields.length > 0) {
    changes.push(
      `Updated ${change.changedDataFields.map((field) => words(field).toLowerCase()).join(", ")}`,
    );
  }
  return `${changes.join(". ")}.`;
}

function RevisionDetails({ revision }: { revision: RevisionDetail }) {
  const headingId = useId();
  const diff = revision.beforeTruncated ? null : buildRevisionDiff(revision.before, revision.after);
  const version =
    typeof (revision.after as { version?: unknown } | null)?.version === "number"
      ? ((revision.after as { contentVersion?: number }).contentVersion ?? (revision.after as { version: number }).version)
      : null;
  const hasChanges =
    diff !== null && (
      diff.fields.length > 0 ||
      diff.blocks.length > 0 ||
      diff.media.added.length > 0 ||
      diff.media.removed.length > 0
    );

  return (
    <section className="revision-detail" aria-labelledby={headingId}>
      <header className="revision-detail-header">
        <div>
          <h4 id={headingId}>
            {version === null ? "Changes in this revision" : `Changes in version ${version}`}
          </h4>
          <p>
            Saved by {revision.actorEmail ?? "an unknown staff member"} on{" "}
            <time dateTime={revision.at}>{formatInstant(revision.at)}</time>.
          </p>
        </div>
      </header>

      {revision.beforeTruncated ? (
        <InlineMessage tone="warning" title="Exact comparison is unavailable">
          <p>
            This legacy repair retained a bounded receipt instead of the full earlier document,
            so the CMS does not infer changes from missing content. The saved result remains complete.
          </p>
        </InlineMessage>
      ) : null}

      {!revision.beforeTruncated && !hasChanges ? (
        <p className="revision-empty-copy">No content differences were recorded.</p>
      ) : null}

      {diff && diff.fields.length > 0 ? (
        <div className="revision-change-group">
          <h5>Fields</h5>
          <div className="revision-diff-key">
            <span>Field</span><span>Before</span><span>After</span>
          </div>
          <dl className="revision-field-diff">
            {diff.fields.map((change) => (
              <div key={change.field} className="revision-field-change">
                <dt>{words(change.field)}</dt>
                <dd>
                  <span className="revision-value-label sr-only">Before: </span>
                  <ValueEvidence value={change.before} />
                </dd>
                <dd>
                  <span className="revision-value-label sr-only">After: </span>
                  <ValueEvidence value={change.after} />
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}

      {diff && diff.blocks.length > 0 ? (
        <div className="revision-change-group">
          <h5>Blocks</h5>
          <ul className="revision-block-diff">
            {diff.blocks.map((change) => (
              <li key={change.id}>
                <strong>{words(change.type)}</strong>
                <span>{blockChangeCopy(change)}</span>
                {[...change.envelopeChanges, ...change.dataChanges].length > 0 ? (
                  <div className="revision-block-data-diff">
                    <div className="revision-diff-key">
                      <span>Block field</span><span>Before</span><span>After</span>
                    </div>
                    <dl className="revision-field-diff">
                      {[...change.envelopeChanges, ...change.dataChanges].map((dataChange) => (
                        <div key={dataChange.field} className="revision-field-change">
                          <dt>{words(dataChange.field)}</dt>
                          <dd>
                            <span className="revision-value-label sr-only">Before: </span>
                            <ValueEvidence value={dataChange.before} />
                          </dd>
                          <dd>
                            <span className="revision-value-label sr-only">After: </span>
                            <ValueEvidence value={dataChange.after} />
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {diff && (diff.media.added.length > 0 || diff.media.removed.length > 0) ? (
        <div className="revision-change-group">
          <h5>Media references</h5>
          <div className="revision-media-groups">
            {diff.media.added.length > 0 ? (
              <div>
                <strong>Added</strong>
                <ul className="revision-token-list">
                  {diff.media.added.map((id) => <li key={id}><code>{id}</code></li>)}
                </ul>
              </div>
            ) : null}
            {diff.media.removed.length > 0 ? (
              <div>
                <strong>Removed</strong>
                <ul className="revision-token-list">
                  {diff.media.removed.map((id) => <li key={id}><code>{id}</code></li>)}
                </ul>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function RevisionHistory({
  collection,
  documentId,
  loadRevisions,
  loadRevision,
  currentVersion,
  restoreRevision,
  onRestored,
  onRestoringChange,
  restoreDisabledReason,
  refreshKey = 0,
  headless = false,
}: RevisionHistoryProps) {
  const editorView = useEditorWorkspaceView();
  useEffect(() => {
    if (!editorView?.kind) return;
    editorView.setHistoryAvailable(true);
    return () => editorView.setHistoryAvailable(false);
  }, [editorView?.kind, editorView?.setHistoryAvailable]);
  const headingId = useId();
  const [retryKey, setRetryKey] = useState(0);
  const [timeline, setTimeline] = useState<TimelineState>({ status: "loading" });
  const [detail, setDetail] = useState<DetailState>({ status: "idle" });
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState(false);
  const [restore, setRestore] = useState<RestoreState>({ status: "idle" });
  const timelineGenerationRef = useRef(0);
  const detailRequestRef = useRef(0);
  const paginationInFlightRef = useRef(false);
  // The restore receipt takes focus once the reloaded timeline has rendered it.
  const receiptRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (restore.status === "restored") receiptRef.current?.focus();
  }, [restore]);

  useEffect(() => {
    const generation = timelineGenerationRef.current + 1;
    timelineGenerationRef.current = generation;
    detailRequestRef.current += 1;
    paginationInFlightRef.current = false;
    let cancelled = false;
    setTimeline({ status: "loading" });
    setDetail({ status: "idle" });
    // A reload triggered by a restore keeps the restore's receipt; every other reload starts
    // the restore state over.
    setRestore((current) => (current.status === "restored" ? current : { status: "idle" }));
    setLoadingOlder(false);
    setOlderError(false);
    loadRevisions(collection, documentId)
      .then((response) => {
        if (!cancelled) {
          setTimeline({
            status: "ready",
            entries: response.entries,
            nextCursor: response.nextCursor,
          });
        }
      })
      .catch(() => {
        if (!cancelled) setTimeline({ status: "error" });
    });
    return () => {
      cancelled = true;
      if (timelineGenerationRef.current === generation) {
        timelineGenerationRef.current += 1;
      }
      detailRequestRef.current += 1;
      paginationInFlightRef.current = false;
    };
  }, [collection, documentId, loadRevisions, refreshKey, retryKey]);

  async function inspect(entry: RevisionSummary) {
    if (detail.status === "ready" && detail.revision.id === entry.id) {
      detailRequestRef.current += 1;
      setDetail({ status: "idle" });
      setRestore({ status: "idle" });
      return;
    }
    const generation = timelineGenerationRef.current;
    const requestId = detailRequestRef.current + 1;
    detailRequestRef.current = requestId;
    setDetail({ status: "loading", id: entry.id });
    setRestore({ status: "idle" });
    try {
      const response = await loadRevision(collection, documentId, entry.id);
      if (
        timelineGenerationRef.current === generation &&
        detailRequestRef.current === requestId
      ) {
        setDetail({ status: "ready", revision: response.revision });
      }
    } catch {
      if (
        timelineGenerationRef.current === generation &&
        detailRequestRef.current === requestId
      ) {
        setDetail({ status: "error", id: entry.id });
      }
    }
  }

  async function restoreSelected(entry: RevisionSummary) {
    if (
      !restoreRevision ||
      !onRestored ||
      !Number.isSafeInteger(currentVersion) ||
      (currentVersion ?? 0) < 1 ||
      restoreDisabledReason
    ) return;
    setRestore({ status: "saving", id: entry.id });
    onRestoringChange?.(true);
    try {
      const response = await restoreRevision(
        collection,
        documentId,
        entry.id,
        currentVersion as number,
      );
      await onRestored(response.document);
      // The restore is the one destructive action here, so it ends with a receipt: which
      // version came back, said where the confirm button stood, with focus moved onto it.
      // Before this the panel simply emptied and the timeline reloaded, which read as nothing
      // having happened.
      setRestore({ status: "restored", id: entry.id, label: revisionVersion(entry) });
      setDetail({ status: "idle" });
      setRetryKey((value) => value + 1);
    } catch (error) {
      setRestore({
        status: "error",
        id: entry.id,
        message: error instanceof Error ? error.message : "The restore request failed.",
      });
    } finally {
      onRestoringChange?.(false);
    }
  }

  async function loadOlder() {
    if (
      timeline.status !== "ready" ||
      !timeline.nextCursor ||
      loadingOlder ||
      paginationInFlightRef.current
    ) return;
    const generation = timelineGenerationRef.current;
    const cursor = timeline.nextCursor;
    paginationInFlightRef.current = true;
    setLoadingOlder(true);
    setOlderError(false);
    try {
      const response = await loadRevisions(collection, documentId, cursor);
      if (timelineGenerationRef.current === generation) {
        setTimeline((current) => current.status === "ready" ? {
          status: "ready",
          entries: [...current.entries, ...response.entries],
          nextCursor: response.nextCursor,
        } : current);
      }
    } catch {
      if (timelineGenerationRef.current === generation) setOlderError(true);
    } finally {
      if (timelineGenerationRef.current === generation) {
        paginationInFlightRef.current = false;
        setLoadingOlder(false);
      }
    }
  }

  return (
    <RetainedEditorHost target={editorView?.kind ? editorView.historyTarget : null}>
    <section
      className="revision-history"
      aria-label={headless ? "Revision history" : undefined}
      aria-labelledby={headless ? undefined : headingId}
    >
      {headless ? null : (
        <header className="revision-history-header">
          <div>
            <h3 id={headingId}>Revision history</h3>
            <p>Inspect saved versions and the exact change recorded by each save.</p>
          </div>
        </header>
      )}

      {/* The receipt stands above the list rather than in the restored version's row: the
          reload shows only the newest page, and a version reached through Load older is no
          longer in it, so a row-bound receipt would vanish exactly when it was earned. */}
      {restore.status === "restored" ? (
        <div className="revision-restore-receipt" ref={receiptRef} tabIndex={-1}>
          <InlineMessage tone="success" title={`${restore.label} restored.`}>
            <p>
              The working content now matches that version, saved as a new revision. Workflow
              status, schedule, and the published version are unchanged.
            </p>
          </InlineMessage>
        </div>
      ) : null}

      {timeline.status === "loading" ? (
        <div className="revision-loading">
          <LoadingIndicator
            label="Loading revision history"
            stages={[
              "Asking the CMS for the saved revisions",
              "Reading who saved each version and when",
            ]}
          />
        </div>
      ) : timeline.status === "error" ? (
        <InlineMessage tone="error" title="Revision history could not be loaded.">
          <Button onClick={() => setRetryKey((value) => value + 1)}>
            Retry revision history
          </Button>
        </InlineMessage>
      ) : timeline.entries.length === 0 ? (
        <EmptyState
          title="No revisions yet"
          description="The first successful save will create the initial immutable revision."
        />
      ) : (
        <>
          <ol className="revision-list">
            {timeline.entries.map((entry) => {
              const changedFieldCount = entry.changedFieldCount ?? 0;
              const selected =
                (detail.status === "ready" && detail.revision.id === entry.id) ||
                ((detail.status === "loading" || detail.status === "error") && detail.id === entry.id);
              return (
                <li key={entry.id} className="revision-row">
                  <div className="revision-row-main">
                    <div className="revision-row-title">
                      <strong>{revisionVersion(entry)}</strong>
                      <time dateTime={entry.at}>{formatInstant(entry.at)}</time>
                    </div>
                    <p className="revision-actor">
                      {entry.actorEmail ?? "Unknown staff member"} · {words(entry.action)}
                    </p>
                    <div className="revision-status-transition">
                      <StatusBadge tone={contentStatusTone(entry.beforeStatus)}>
                        {displayContentStatus(entry.beforeStatus)}
                      </StatusBadge>
                      <span aria-hidden="true">→</span>
                      <span className="sr-only">to</span>
                      <StatusBadge tone={contentStatusTone(entry.status)}>
                        {displayContentStatus(entry.status)}
                      </StatusBadge>
                    </div>
                    {entry.diffAvailable ? (
                      <>
                        <div className="revision-summary-line">
                          <span>{changedFieldCount} {changedFieldCount === 1 ? "field" : "fields"} changed</span>
                          {entry.blockCount !== null ? <span>{entry.blockCount} {entry.blockCount === 1 ? "block" : "blocks"}</span> : null}
                          <span>{entry.mediaReferenceCount} media {entry.mediaReferenceCount === 1 ? "reference" : "references"}</span>
                        </div>
                        {entry.changedFields.length > 0 ? (
                          <ul className="revision-field-pills" aria-label="Changed fields">
                            {entry.changedFields.slice(0, 6).map((field) => (
                              <li key={field}>{words(field)}</li>
                            ))}
                            {changedFieldCount > 6 ? <li>+{changedFieldCount - 6}</li> : null}
                          </ul>
                        ) : null}
                      </>
                    ) : (
                      <p className="revision-summary-unavailable">
                        <strong>Earlier comparison unavailable</strong>
                        <span>The saved result contains {entry.blockCount ?? 0} {entry.blockCount === 1 ? "block" : "blocks"} and {entry.mediaReferenceCount} media {entry.mediaReferenceCount === 1 ? "reference" : "references"}.</span>
                      </p>
                    )}
                  </div>
                  <Button
                    aria-expanded={selected}
                    className="revision-inspect-button"
                    onClick={() => void inspect(entry)}
                  >
                    {detail.status === "ready" && detail.revision.id === entry.id
                      ? "Close details"
                      : `Inspect ${revisionVersion(entry).toLowerCase()}`}
                  </Button>
                  {detail.status === "loading" && detail.id === entry.id ? (
                    <div className="revision-detail-status">
                      <LoadingIndicator
                        label="Loading revision details"
                        stages={["Fetching this revision", "Comparing it with the current draft"]}
                      />
                    </div>
                  ) : detail.status === "error" && detail.id === entry.id ? (
                    <InlineMessage tone="error" title="Revision details could not be loaded.">
                      <Button onClick={() => void inspect(entry)}>Retry details</Button>
                    </InlineMessage>
                  ) : detail.status === "ready" && detail.revision.id === entry.id ? (
                    <>
                      <RevisionDetails revision={detail.revision} />
                      {restoreRevision && onRestored ? (
                        <div className="revision-restore">
                          {restore.status === "confirming" && restore.id === entry.id ? (
                            <InlineMessage tone="warning" title={`Restore ${revisionVersion(entry).toLowerCase()}?`}>
                              <p>
                                This replaces the current working content with {revisionVersion(entry).toLowerCase()}.
                                It keeps the current workflow status, schedule, approval, routes, assignment,
                                and published version. The CMS saves the result as a new revision.
                              </p>
                              <div className="revision-restore-actions">
                                <Button onClick={() => setRestore({ status: "idle" })}>Cancel</Button>
                                <Button
                                  onClick={() => void restoreSelected(entry)}
                                  variant="danger"
                                >
                                  {`Confirm restore of ${revisionVersion(entry).toLowerCase()}`}
                                </Button>
                              </div>
                            </InlineMessage>
                          ) : (
                            <>
                              <Button
                                disabled={
                                  Boolean(restoreDisabledReason) ||
                                  !Number.isSafeInteger(currentVersion) ||
                                  entry.version === currentVersion ||
                                  (restore.status === "saving" && restore.id === entry.id)
                                }
                                onClick={() => setRestore({ status: "confirming", id: entry.id })}
                              >
                                {entry.version === currentVersion
                                  ? "Current version"
                                  : restore.status === "saving" && restore.id === entry.id
                                    ? `Restoring ${revisionVersion(entry).toLowerCase()}…`
                                    : `Restore ${revisionVersion(entry).toLowerCase()}`}
                              </Button>
                              {restoreDisabledReason ? (
                                <p className="revision-restore-disabled">{restoreDisabledReason}</p>
                              ) : !Number.isSafeInteger(currentVersion) ? (
                                <p className="revision-restore-disabled">
                                  Reload this record before restoring a version.
                                </p>
                              ) : null}
                            </>
                          )}
                          {restore.status === "error" && restore.id === entry.id ? (
                            <InlineMessage
                              tone="error"
                              title={`${revisionVersion(entry)} could not be restored.`}
                            >
                              <p>{restore.message}</p>
                            </InlineMessage>
                          ) : null}
                        </div>
                      ) : null}
                    </>
                  ) : null}
                </li>
              );
            })}
          </ol>
          {olderError ? (
            <InlineMessage tone="error" title="Older revisions could not be loaded.">
              <Button onClick={() => void loadOlder()}>Retry older revisions</Button>
            </InlineMessage>
          ) : null}
          {timeline.nextCursor ? (
            <Button disabled={loadingOlder} onClick={() => void loadOlder()}>
              {loadingOlder ? "Loading older revisions…" : "Load older revisions"}
            </Button>
          ) : null}
        </>
      )}
    </section>
    </RetainedEditorHost>
  );
}
