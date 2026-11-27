import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router";
import type { LibrarySelection } from "../lib/content-library";
import { DEFAULT_CONTENT_QUERY, type ContentQuery } from "../lib/content-query";
import type { ContentRecordSummary } from "../lib/content-records";
import { listOriginState } from "../lib/editor-back";
import type { BulkArchiveOutcome } from "../lib/functions";
import { contentLibraryPath, editRecordPath } from "../lib/routes";
import { AsyncActionButton, Button, InlineMessage, Panel } from "./ui/Primitives";

// The person's own post drafts, oldest edit first, so drafts left behind surface on Home
// instead of waiting in Posts. "Own" is the library's "Mine": the person who last edited it.
const myDraftsQuery: ContentQuery = {
  ...DEFAULT_CONTENT_QUERY,
  types: ["post"],
  statuses: ["draft"],
  ownerMode: "me",
  sortField: "updatedAt",
  sortDirection: "asc",
  sortExplicit: true,
};
export const MY_DRAFTS_QUERY: Readonly<ContentQuery> = Object.freeze(myDraftsQuery);

const SHOWN_DRAFTS = 5;
const STALE_DRAFT_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

type DraftsState =
  | { status: "loading" }
  | { status: "ready"; selection: LibrarySelection }
  | { status: "error"; message: string };

function draftAgeDays(updatedAt: string | undefined, nowMs: number): number | null {
  const editedMs = updatedAt ? Date.parse(updatedAt) : Number.NaN;
  return Number.isFinite(editedMs) ? Math.max(0, Math.floor((nowMs - editedMs) / DAY_MS)) : null;
}

function editedLabel(days: number | null): string {
  if (days === null) return "Edit time unavailable";
  if (days === 0) return "Edited today";
  if (days === 1) return "Edited yesterday";
  return `Edited ${days} days ago`;
}

// Home archives only drafts that never had a public copy. Archiving a draft whose earlier
// version is live also withdraws it from the site, which Posts explains before it happens.
function neverPublished(draft: ContentRecordSummary): boolean {
  return !draft.publishedSourceVersion && !draft.liveSourceVersion && draft.publicUpdatePending !== true;
}

function archiveFailure(outcome: BulkArchiveOutcome | undefined): string | null {
  switch (outcome?.status) {
    case "archived":
    case "already_archived":
      return outcome.publication?.status === "failed"
        ? "The draft was archived, but its public copy was not withdrawn. Open Posts to retry the withdrawal."
        : null;
    case "conflict":
      return "This draft changed since Home loaded. Open it to see the latest version.";
    case "missing":
      return "This draft is no longer available.";
    default:
      return outcome?.message ?? "The draft could not be archived.";
  }
}

interface HomeDraftsProps {
  loadDrafts: () => Promise<LibrarySelection>;
  /** Present only for people who may archive posts. */
  archiveDraft?: (draft: ContentRecordSummary & { version: number }) => Promise<BulkArchiveOutcome | undefined>;
  /** Runs after an archive so the rest of Home shows current counts. */
  onArchived?: () => void;
  now?: () => number;
}

export function HomeDrafts({ loadDrafts, archiveDraft, onArchived, now = Date.now }: HomeDraftsProps) {
  const origin = listOriginState(useLocation());
  const [state, setState] = useState<DraftsState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [archiving, setArchiving] = useState<string | null>(null);
  const [archiveError, setArchiveError] = useState<{ title: string; message: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    loadDrafts()
      .then((selection) => {
        if (!cancelled) setState({ status: "ready", selection });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            status: "error",
            message: error instanceof Error ? error.message : "Your drafts could not be loaded.",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [attempt, loadDrafts]);

  async function archive(draft: ContentRecordSummary & { version: number }) {
    if (!archiveDraft) return;
    setArchiving(draft.id);
    setArchiveError(null);
    let outcome: BulkArchiveOutcome | undefined;
    try {
      outcome = await archiveDraft(draft);
    } catch {
      // The archive may have committed before the response was lost, so read the
      // current state again instead of asserting that nothing changed.
      setArchiveError({
        title: draft.title,
        message: "Boardwalk could not confirm the archive. The list was reloaded; check whether the draft is still here.",
      });
      setAttempt((value) => value + 1);
      onArchived?.();
      setArchiving(null);
      return;
    }
    const failure = archiveFailure(outcome);
    if (failure) setArchiveError({ title: draft.title, message: failure });
    if (outcome?.status === "archived" || outcome?.status === "already_archived") {
      setAttempt((value) => value + 1);
      onArchived?.();
    }
    setArchiving(null);
  }

  const nowMs = now();
  const selection = state.status === "ready" ? state.selection : null;
  const drafts = selection?.records.slice(0, SHOWN_DRAFTS) ?? [];
  const allDraftsPath = contentLibraryPath(MY_DRAFTS_QUERY);

  return (
    <Panel className="home-drafts-panel" tone="soft" aria-label="My drafts">
      <div className="home-drafts-heading">
        <div>
          <h3>My drafts</h3>
          <p>Posts you last edited, oldest first</p>
        </div>
        {selection && selection.total > 0 ? (
          <Link to={allDraftsPath}>{`View all ${selection.total}`}</Link>
        ) : null}
      </div>
      {state.status === "loading" ? <p className="home-drafts-note">Loading your drafts…</p> : null}
      {state.status === "error" ? (
        <InlineMessage tone="error" title="Your drafts could not be loaded">
          <span>{state.message}</span>
          <Button onClick={() => setAttempt((value) => value + 1)}>Try loading drafts again</Button>
        </InlineMessage>
      ) : null}
      {archiveError ? (
        <InlineMessage tone="error" title={`Archiving "${archiveError.title}" needs attention`}>
          {archiveError.message}
        </InlineMessage>
      ) : null}
      {selection && drafts.length === 0 ? (
        <p className="home-drafts-note">You have no open post drafts.</p>
      ) : null}
      {drafts.length > 0 ? (
        <ul className="home-drafts-list">
          {drafts.map((draft) => {
            const days = draftAgeDays(draft.updatedAt, nowMs);
            const version = draft.version;
            const canArchive = archiveDraft !== undefined && days !== null && days >= STALE_DRAFT_DAYS && neverPublished(draft) &&
              typeof version === "number" && Number.isSafeInteger(version) && version > 0;
            return (
              <li key={draft.id}>
                <div className="home-drafts-main">
                  <Link state={origin} to={editRecordPath("post", draft.id)}>
                    {draft.title || "Untitled post"}
                  </Link>
                  <span>{editedLabel(days)}</span>
                </div>
                {canArchive ? (
                  <AsyncActionButton
                    aria-label={`Archive ${draft.title || "untitled post"}`}
                    disabled={archiving !== null && archiving !== draft.id}
                    label="Archive"
                    onClick={() => void archive({ ...draft, version })}
                    pending={archiving === draft.id}
                    pendingLabel="Archiving"
                    size="compact"
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </Panel>
  );
}
