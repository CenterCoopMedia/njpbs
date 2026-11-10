import { InfoTooltip } from "./ui/InfoTooltip";
import { useEffect, useMemo, useState } from "react";
import { Button, Select } from "./ui/Primitives";
import {
  AUTHOR_HIDDEN_POSTS_MAX,
  isPostReference,
} from "../../../packages/content-core/src/author-profiles";
import type { AuthorPagePostSummary } from "../lib/functions";

export interface AuthorPageControlsValue {
  pinnedPostId: string | null;
  hiddenPostIds: string[];
}

export interface AuthorPageControlsProps {
  value: AuthorPageControlsValue;
  onChange: (value: AuthorPageControlsValue) => void;
  posts: readonly AuthorPagePostSummary[];
  postsState: "loading" | "ready" | "error";
  hasMore?: boolean;
  loadingMore?: boolean;
  moreError?: string | null;
  onLoadMore?: () => void;
  onReload?: () => void;
  disabled?: boolean;
  idPrefix: string;
  subject?: "self" | "other";
  subjectName?: string;
}

/**
 * Pin and hide choices for one author page.
 *
 * Every option comes from the byline-scoped endpoint. The control never uses
 * the editorial content library, and it follows that endpoint one bounded page
 * at a time only when the editor asks for more.
 */
export function AuthorPageControls({
  value,
  onChange,
  posts,
  postsState,
  hasMore = false,
  loadingMore = false,
  moreError = null,
  onLoadMore,
  onReload,
  disabled = false,
  idPrefix,
  subject = "self",
  subjectName,
}: AuthorPageControlsProps) {
  const [pendingHidden, setPendingHidden] = useState("");
  const summaries = useMemo(
    () => new Map(posts.map((post) => [post.id, post])),
    [posts],
  );
  const owner =
    subject === "self"
      ? "your page"
      : `${subjectName ?? "this author"}'s page`;
  const pinFieldId = `${idPrefix}-pinned-post`;
  const hideFieldId = `${idPrefix}-hidden-post`;
  const unavailablePin = value.pinnedPostId ? summaries.get(value.pinnedPostId)?.noindex === true : false;
  const unknownPin = !!value.pinnedPostId && !summaries.has(value.pinnedPostId);

  const label = (id: string): string => {
    const post = summaries.get(id);
    return post ? `${post.headline} — ${post.publishDate}` : id;
  };

  const atLimit = value.hiddenPostIds.length >= AUTHOR_HIDDEN_POSTS_MAX;
  const addable = posts.filter(
    (post) =>
      !post.noindex && !value.hiddenPostIds.includes(post.id) && post.id !== value.pinnedPostId,
  );
  const pendingIsAddable =
    postsState === "ready" &&
    addable.some((post) => post.id === pendingHidden);

  useEffect(() => {
    setPendingHidden("");
  }, [idPrefix]);

  function addHidden(): void {
    if (!pendingIsAddable || !isPostReference(pendingHidden) || atLimit) return;
    onChange({
      pinnedPostId:
        value.pinnedPostId === pendingHidden ? null : value.pinnedPostId,
      hiddenPostIds: [...value.hiddenPostIds, pendingHidden],
    });
    setPendingHidden("");
  }

  return (
    <section
      aria-labelledby={`${idPrefix}-controls-head`}
      className="author-page-controls"
    >
      <div className="editor-field-label-row"><h3 id={`${idPrefix}-controls-head`}>Author page</h3><InfoTooltip label="Author page" content={`These choices change ${owner} on njpbs.org and nothing else. A story left off ${owner} stays published at its own address and still appears on every coauthor’s page.`} /></div>


      {postsState === "loading" ? (
        <p className="field-hint" role="status">
          Loading published posts credited to this author…
        </p>
      ) : null}
      {postsState === "error" ? (
        <div>
          <p className="field-error">
            The list of posts could not be loaded, so these choices cannot be
            changed right now. Everything else on this form still saves.
          </p>
          {onReload ? (
            <Button
              disabled={disabled}
              onClick={onReload}
              type="button"
              variant="secondary"
            >
              Try loading posts again
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="author-profile-field">
        <div className="editor-field-label-row"><label htmlFor={pinFieldId}>Pinned post</label><InfoTooltip label="Pinned post" content="One story to show first, marked as pinned. Leave this on None to list everything newest first." /></div>
        <p className="sr-only" id={`${pinFieldId}-hint`}>
          One story to show first, marked as pinned. Leave this on
          &ldquo;None&rdquo; to list everything newest first.
        </p>
        <p className="field-hint" id={`${pinFieldId}-visibility`}>
          {unavailablePin
            ? "The pinned Post is hidden from search engines and cannot appear on this author page. Choose another Post or None."
            : unknownPin
              ? "The pinned Post is not in the loaded list, so its status is unknown. Load more Posts when available, or choose another Post or None."
              : "Posts hidden from search engines stay off author pages, even when pinned."}
        </p>
        <Select
          aria-describedby={`${pinFieldId}-hint ${pinFieldId}-visibility`}
          disabled={disabled || postsState !== "ready"}
          id={pinFieldId}
          onChange={(event) =>
            onChange({ ...value, pinnedPostId: event.target.value || null })
          }
          value={value.pinnedPostId ?? ""}
        >
          <option value="">None</option>
          {value.pinnedPostId && unknownPin ? (
            <option disabled value={value.pinnedPostId}>{value.pinnedPostId} — status not checked</option>
          ) : null}
          {value.pinnedPostId && unavailablePin ? (
            <option disabled value={value.pinnedPostId}>{label(value.pinnedPostId)} — unavailable on author page</option>
          ) : null}
          {posts
            .filter((post) => !post.noindex && !value.hiddenPostIds.includes(post.id))
            .map((post) => (
              <option key={post.id} value={post.id}>
                {label(post.id)}
              </option>
            ))}
        </Select>
      </div>

      <div className="author-profile-field">
        <div className="editor-field-label-row"><label htmlFor={hideFieldId}>Leave a post off this page</label><InfoTooltip label="Leave a post off this page" content={`Up to ${AUTHOR_HIDDEN_POSTS_MAX} stories. This never unpublishes anything.`} /></div>
        <p className="sr-only" id={`${hideFieldId}-hint`}>
          Up to {AUTHOR_HIDDEN_POSTS_MAX} stories. This never unpublishes
          anything.
        </p>
        <div className="author-page-controls__add">
          <Select
            aria-describedby={`${hideFieldId}-hint`}
            disabled={disabled || postsState !== "ready" || atLimit}
            id={hideFieldId}
            onChange={(event) => setPendingHidden(event.target.value)}
            value={pendingHidden}
          >
            <option value="">Choose a post…</option>
            {addable.map((post) => (
              <option key={post.id} value={post.id}>
                {label(post.id)}
              </option>
            ))}
          </Select>
          <Button
            disabled={disabled || !pendingIsAddable || atLimit}
            onClick={addHidden}
            type="button"
            variant="secondary"
          >
            Leave off
          </Button>
        </div>
        {atLimit ? (
          <p className="field-hint">
            That is the maximum. Put one back on the page to leave another off.
          </p>
        ) : null}

        {value.hiddenPostIds.length > 0 ? (
          <ul className="author-page-controls__list">
            {value.hiddenPostIds.map((id) => (
              <li key={id}>
                <span>{label(id)}</span>
                <Button
                  disabled={disabled}
                  onClick={() =>
                    onChange({
                      ...value,
                      hiddenPostIds: value.hiddenPostIds.filter(
                        (entry) => entry !== id,
                      ),
                    })
                  }
                  type="button"
                  variant="secondary"
                >
                  Put &ldquo;{label(id)}&rdquo; back on the page
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="field-hint">No stories are left off this page right now.</p>
        )}
      </div>

      {postsState === "ready" && hasMore && onLoadMore ? (
        <div>
          <Button
            disabled={disabled || loadingMore}
            onClick={onLoadMore}
            type="button"
            variant="secondary"
          >
            {loadingMore ? "Loading more…" : "Load more posts"}
          </Button>
          {moreError ? <p className="field-error">{moreError}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
