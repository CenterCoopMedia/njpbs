import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { InspectorSection } from "../ui/Inspector";
import { AsyncActionButton, Button, InlineMessage, Select, Textarea } from "../ui/Primitives";
import type { MediaComment, MediaCommentPerson } from "../../lib/media-feedback";
import {
  commentTimeLabel,
  draftCommentInput,
  draftCommentTime,
  type CommentTimeDraft,
  type FrameRate,
} from "../../lib/media-comment-time";
import {
  COMMENT_FILTERS,
  commentThreads,
  filterCounts,
  isResolved,
  mentionsInText,
  namesMention,
  threadMatches,
  type CommentThread,
} from "../../lib/media-comment-threads";
import type { MediaFeedback } from "../../lib/use-media-feedback";
import { MentionTextarea } from "./MentionTextarea";
import "./MediaFeedbackSections.css";

const COMMENT_TIME = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "America/New_York",
});

function commentTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Time unavailable" : `${COMMENT_TIME.format(date)} ET`;
}

function CommentMeta({ comment }: { comment: MediaComment }) {
  const edited = comment.updatedAt !== comment.createdAt;
  return <p className="media-feedback-comment-meta"><strong>{comment.authorName}</strong>{" · "}
    <time dateTime={comment.updatedAt}>{commentTime(comment.updatedAt)}</time>{edited ? " · Edited" : ""}</p>;
}

/** Resolve state in words, so it does not depend on color. */
function ResolvedState({ comment }: { comment: MediaComment }) {
  if (!isResolved(comment)) return null;
  return <p className="media-feedback-resolved"><strong>Resolved</strong>
    {comment.resolvedBy ? ` by ${comment.resolvedBy.name}` : ""}
    {comment.resolvedAt ? <>{" · "}<time dateTime={comment.resolvedAt}>{commentTime(comment.resolvedAt)}</time></> : null}</p>;
}

function Mentions({ comment }: { comment: MediaComment }) {
  if (!comment.mentions?.length) return null;
  return <p className="media-feedback-comment-meta">Mentioned: {comment.mentions.map(person => person.name).join(", ")}</p>;
}

// Before any query or fragment, punctuation that starts another address ends
// the current one. A query or fragment keeps nested addresses intact.
const COMMENT_URL = /\bhttps?:\/\/(?:(?![.,;!]https?:\/\/)[^\s<>"'?#])+(?:[?#][^\s<>"']*)?/giu;
const TRAILING_URL_PUNCTUATION = new Set([".", ",", "!", "?", ";", ":", "…", "”", "’", "»"]);
const URL_BRACKETS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

function withoutTrailingPunctuation(value: string): string {
  let end = value.length;
  while (end > 0) {
    const last = value[end - 1];
    if (TRAILING_URL_PUNCTUATION.has(last)) {
      end -= 1;
      continue;
    }
    const opening = URL_BRACKETS[last];
    if (!opening) break;
    const candidate = value.slice(0, end);
    const openings = candidate.split(opening).length - 1;
    const closings = candidate.split(last).length - 1;
    if (closings <= openings) break;
    end -= 1;
  }
  return value.slice(0, end);
}

function safeCommentUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function CommentText({ text }: { text: string }) {
  const content: ReactNode[] = [];
  let textStart = 0;
  for (const match of text.matchAll(COMMENT_URL)) {
    if (match.index === undefined) continue;
    const label = withoutTrailingPunctuation(match[0]);
    const href = safeCommentUrl(label);
    if (!href) continue;
    content.push(text.slice(textStart, match.index));
    content.push(<a key={`${match.index}-${label}`} href={href} target="_blank" rel="noopener noreferrer"
      aria-label={`${label} (opens in a new tab)`}>{label}</a>);
    textStart = match.index + label.length;
  }
  content.push(text.slice(textStart));
  return <p className="media-feedback-comment-text">{content}</p>;
}

/** Player-side controls for comments on a frame or a range. Only videos in a player pass this. */
export interface CommentTiming {
  rate: FrameRate | null;
  /** The opened file; a draft time is sent with it. */
  fileVersion: string;
  /** Comment times were loaded for another file, so they cannot seek or claim a version yet. */
  timesPending?: boolean;
  draft: CommentTimeDraft | null;
  /** A short status from the last time control, such as a rejected range end. */
  message: string;
  activeId?: string;
  /** Every explicit marker activation, including a repeat of the active comment. */
  navigationRequest?: number;
  /** A new value opens Staff comments and focuses the new comment field. */
  composerRequest: number;
  onUseCurrent: () => void;
  onSetIn: () => void;
  onSetOut: () => void;
  onClear: () => void;
  onSeek: (comment: MediaComment) => void;
}

function CommentTime({ comment, timing }: { comment: MediaComment; timing?: CommentTiming }) {
  if (!comment.time) return null;
  const label = commentTimeLabel(comment.time);
  if (timing?.timesPending) return <p className="media-feedback-comment-meta">{label}</p>;
  if (!comment.time.currentVersion) {
    return <p className="media-feedback-comment-meta">{label} · Made on an earlier version of this file.</p>;
  }
  return timing
    ? <div><Button variant="ghost" className="media-feedback-time-jump"
      onClick={() => timing.onSeek(comment)}><span className="sr-only">Go to </span>{label}</Button></div>
    : <p className="media-feedback-comment-meta">{label}</p>;
}

/** Comments on the current file version in time order, then the rest in the order added. */
function timeOrdered(comments: readonly MediaComment[]): MediaComment[] {
  const placed = (comment: MediaComment) => Boolean(comment.time?.currentVersion);
  return [...comments].sort((a, b) =>
    Number(placed(b)) - Number(placed(a)) ||
    (placed(a) ? a.time!.startMs - b.time!.startMs : 0) ||
    a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/**
 * Mention IDs to send for an edit, or undefined when the mentions did not change. A stored mention
 * is removed only when its @name was in the saved text and the edit removes it. A person who was
 * renamed or has left keeps their mention, because the saved text does not hold the current name.
 * New picks are added when their @name is still in the text.
 */
function editedMentions(comment: MediaComment, text: string, picked: readonly MediaCommentPerson[]): string[] | undefined {
  const stored = comment.mentions ?? [];
  const removed = (person: MediaCommentPerson) =>
    namesMention(comment.text, person.name) && !namesMention(text, person.name);
  const kept = stored.filter(person => !removed(person)).map(person => person.uid);
  const added = mentionsInText(text, picked).map(person => person.uid).filter(uid => !kept.includes(uid));
  const next = [...kept, ...added];
  const before = stored.map(person => person.uid);
  return next.length === before.length && next.every((uid, index) => uid === before[index]) ? undefined : next;
}

function addPick(list: MediaCommentPerson[], person: MediaCommentPerson): MediaCommentPerson[] {
  return list.some(item => item.uid === person.uid) ? list : [...list, person];
}

type FocusRequest =
  | { kind: "comment"; id: string }
  | { kind: "thread-state"; id: string; index: number }
  | { kind: "created"; id: string; filterLabel: string };

export function MediaFeedbackSections({
  commentsTarget,
  context,
  feedback,
  locked = false,
  onCommentDirtyChange,
  reviewSaveMode,
  timing,
}: {
  /** A mounted desktop side pane that receives the existing comments panel. */
  commentsTarget?: HTMLElement | null;
  context?: { view: "details" | "comments" | "review"; id: string };
  feedback: MediaFeedback;
  locked?: boolean;
  onCommentDirtyChange: (dirty: boolean) => void;
  reviewSaveMode: "combined" | "separate";
  timing?: CommentTiming;
}) {
  const composerId = useId();
  const [localCommentsTarget, setLocalCommentsTarget] = useState<HTMLDivElement | null>(null);
  const [commentsRoot] = useState(() => typeof document === "undefined" ? null : document.createElement("div"));
  const handledComposerRequest = useRef(0);
  const handledNavigationRequest = useRef(0);
  const timeHeadingId = useId();
  const filterId = useId();
  const [newComment, setNewComment] = useState("");
  const [newMentions, setNewMentions] = useState<MediaCommentPerson[]>([]);
  const [editingId, setEditingId] = useState<string>();
  const [editDraft, setEditDraft] = useState("");
  const [editMentions, setEditMentions] = useState<MediaCommentPerson[]>([]);
  const [deletingId, setDeletingId] = useState<string>();
  const [replyingId, setReplyingId] = useState<string>();
  const [replyDraft, setReplyDraft] = useState("");
  const [replyMentions, setReplyMentions] = useState<MediaCommentPerson[]>([]);
  const [threadNotice, setThreadNotice] = useState("");
  const [focusRequest, setFocusRequest] = useState<FocusRequest>();
  const deleteConfirmation = useRef<HTMLDivElement>(null);
  const deleteTriggerRow = useRef<HTMLLIElement | null>(null);
  const editTriggerRow = useRef<HTMLLIElement | null>(null);
  const replyTrigger = useRef<string>();
  const threadList = useRef<HTMLOListElement>(null);
  const loadedComments = feedback.comments.comments;
  const comments = useMemo(
    () => timing ? timeOrdered(loadedComments) : loadedComments,
    [loadedComments, timing],
  );
  const threads = useMemo(() => commentThreads(comments), [comments]);
  const filter = feedback.commentFilter;
  const shownThreads = useMemo(() => threads.filter(thread => threadMatches(thread, filter)), [threads, filter]);
  const counts = useMemo(() => filterCounts(threads), [threads]);
  const editingComment = editingId ? comments.find(comment => comment.id === editingId) : undefined;
  const replyingThread = replyingId ? threads.find(thread => thread.comment.id === replyingId) : undefined;
  const commentDirty = newComment !== "" || replyDraft !== "" ||
    Boolean(editingId && editDraft !== (editingComment?.text ?? ""));
  const pending = feedback.pending;
  const loadStaff = feedback.loadStaff;
  const needStaff = useCallback(() => { void loadStaff(); }, [loadStaff]);

  useLayoutEffect(() => {
    if (!context || !commentsRoot) return;
    const target = commentsTarget ?? localCommentsTarget;
    if (!target || commentsRoot.parentElement === target) return;
    const focused = commentsRoot.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
    const selection = focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement
      ? { start: focused.selectionStart, end: focused.selectionEnd, direction: focused.selectionDirection }
      : null;
    const restoreFocus = () => {
      focused?.focus({ preventScroll: true });
      if (selection && (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) &&
        selection.start !== null && selection.end !== null) {
        focused.setSelectionRange(selection.start, selection.end, selection.direction ?? undefined);
      }
    };
    target.append(commentsRoot);
    restoreFocus();
  }, [commentsRoot, commentsTarget, context, localCommentsTarget]);
  useEffect(() => () => commentsRoot?.remove(), [commentsRoot]);

  useEffect(() => {
    onCommentDirtyChange(commentDirty);
    return () => onCommentDirtyChange(false);
  }, [commentDirty, onCommentDirtyChange]);
  useEffect(() => {
    if (deletingId) deleteConfirmation.current?.focus();
  }, [deletingId]);
  useEffect(() => {
    if (replyingId) document.getElementById(`${composerId}-reply`)?.focus();
  }, [composerId, replyingId]);
  const activeId = timing?.activeId;
  function honorContextRequest() {
    if (context?.view !== "comments") return;
    const composerRequest = timing?.composerRequest ?? 0;
    if (composerRequest && handledComposerRequest.current !== composerRequest) {
      const composer = document.getElementById(composerId);
      if (composer && !composer.closest("[hidden]")) {
        handledComposerRequest.current = composerRequest;
        composer.focus();
      }
      return;
    }
    const navigationRequest = timing?.navigationRequest ?? 0;
    if (!navigationRequest || handledNavigationRequest.current === navigationRequest || !activeId) return;
    const comment = document.getElementById(`media-comment-${activeId}`);
    if (comment && !comment.closest("[hidden]")) {
      handledNavigationRequest.current = navigationRequest;
      comment.scrollIntoView?.({ block: "nearest" });
    }
  }
  useEffect(() => {
    honorContextRequest();
  }, [context?.view, timing?.composerRequest, timing?.navigationRequest, activeId, feedback.comments.ready, composerId]);
  useEffect(() => {
    if (!context && activeId) document.getElementById(`media-comment-${activeId}`)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);
  // Focus moves after a reply to the new reply, and after resolve or reopen to the same thread's
  // button. When the filter hides that thread, focus moves to the thread now in its place.
  useEffect(() => {
    if (!focusRequest) return;
    setFocusRequest(undefined);
    const item = document.getElementById(`media-comment-${focusRequest.id}`);
    if (focusRequest.kind === "created") {
      // A shown comment keeps focus where it is. A comment the filter hides would seem to
      // vanish, so say where it went and move focus to the filter.
      if (!item) {
        setThreadNotice(`Comment added. The ${focusRequest.filterLabel} filter hides it. Choose All in Show to see it.`);
        document.getElementById(filterId)?.focus();
      }
      return;
    }
    if (focusRequest.kind === "comment") {
      item?.focus();
      return;
    }
    const stateButton = item?.querySelector<HTMLButtonElement>(":scope > .media-feedback-actions button[data-thread-state]");
    if (stateButton) {
      stateButton.focus();
      return;
    }
    const rows = threadList.current ? [...threadList.current.children] as HTMLElement[] : [];
    const next = rows[Math.min(focusRequest.index, rows.length - 1)];
    if (next) next.focus();
    else document.getElementById(filterId)?.focus();
  }, [filterId, focusRequest]);

  if (!feedback.enabled) return null;

  async function addComment() {
    const time = timing?.draft ? draftCommentInput(timing.draft, timing.rate, timing.fileVersion) : undefined;
    const mentions = mentionsInText(newComment, newMentions).map(person => person.uid);
    const created = await feedback.createComment(newComment, time, mentions);
    if (typeof created === "string") {
      setThreadNotice("");
      setFocusRequest({ kind: "created", id: created,
        filterLabel: COMMENT_FILTERS.find(option => option.value === filter)?.label ?? filter });
      setNewComment("");
      setNewMentions([]);
      timing?.onClear();
    }
  }

  function closeReply(returnFocus: boolean) {
    const threadId = replyingId;
    setReplyingId(undefined);
    setReplyDraft("");
    setReplyMentions([]);
    feedback.clearCommentError();
    if (returnFocus && threadId) {
      requestAnimationFrame(() => document.getElementById(`media-comment-${threadId}`)
        ?.querySelector<HTMLButtonElement>("button[data-comment-reply]")?.focus());
    }
  }

  async function sendReply(thread: CommentThread) {
    const mentions = mentionsInText(replyDraft, replyMentions).map(person => person.uid);
    const created = await feedback.replyToComment(thread.comment.id, replyDraft, mentions);
    if (typeof created === "string") {
      setReplyingId(undefined);
      setReplyDraft("");
      setReplyMentions([]);
      setThreadNotice(`Reply added to the thread by ${thread.comment.authorName}.`);
      setFocusRequest({ kind: "comment", id: created });
    }
  }

  async function changeThreadState(thread: CommentThread, index: number) {
    const resolving = !isResolved(thread.comment);
    const changed = resolving
      ? await feedback.resolveComment(thread.comment.id)
      : await feedback.reopenComment(thread.comment.id);
    if (!changed) return;
    const hidden = resolving ? filter === "open" : filter === "resolved";
    setThreadNotice(`${resolving ? "Thread marked resolved" : "Thread reopened"}.${hidden
      ? ` The ${resolving ? "Open" : "Resolved"} filter now hides it. Choose All in Show to see it.`
      : ""}`);
    setFocusRequest({ kind: "thread-state", id: thread.comment.id, index });
  }

  const reviewDisabled = locked || feedback.review.loading || !feedback.review.ready || pending;
  const commentsDisabled = locked || feedback.comments.loading || !feedback.comments.ready || pending;
  const reviewError = feedback.review.error ? <InlineMessage tone="error" title="Your review needs attention">
    <span>{feedback.review.error}</span>
    <div className="media-feedback-actions">
      {feedback.review.ready && feedback.reviewDirty
        ? <Button disabled={pending} onClick={() => void feedback.saveReview()}>Try again</Button>
        : null}
      <Button disabled={pending || feedback.review.loading} onClick={feedback.reloadReview}>
        {feedback.review.conflict ? "Reload current review" : "Reload review"}
      </Button>
    </div>
  </InlineMessage> : null;

  function renderComment(comment: MediaComment, thread: CommentThread | null, index: number) {
    const editing = editingId === comment.id;
    const confirmingDelete = deletingId === comment.id;
    const mutationError = feedback.comments.mutationError?.commentId === comment.id
      ? feedback.comments.mutationError
      : null;
    const stateAction = thread && isResolved(comment) ? "reopen" : "resolve";
    // A first comment with replies cannot be deleted; the server refuses it too.
    // The server refuses to delete a first comment with replies. While more pages remain, a
    // reply may sit on one of them, so the server's hasReplies also hides Delete. Once every page
    // is loaded, the loaded replies are complete and stay current after a reply is deleted.
    const canDelete = !thread || (thread.replies.length === 0 &&
      !(feedback.comments.nextCursor && comment.hasReplies));
    const busyElsewhere = Boolean(editingId && editingId !== comment.id);
    return <>
      <CommentMeta comment={comment} />
      {thread ? <CommentTime comment={comment} timing={timing} /> : null}
      {thread ? <ResolvedState comment={comment} /> : null}
      {editing ? <>
        <MentionTextarea label={`Edit comment by ${comment.authorName}`} value={editDraft}
          disabled={commentsDisabled} staff={feedback.staff} onNeedStaff={needStaff}
          onPick={person => setEditMentions(list => addPick(list, person))}
          onChange={value => { setEditDraft(value); feedback.clearCommentError(); }} />
        <div className="media-feedback-actions">
          <Button disabled={pending} onClick={() => { setEditingId(undefined); setEditDraft(""); feedback.clearCommentError();
            requestAnimationFrame(() => editTriggerRow.current?.querySelector<HTMLButtonElement>("button[data-comment-edit]")?.focus()); }}>Cancel edit</Button>
          <AsyncActionButton label="Save comment" pending={feedback.comments.mutation?.action === "edit" && feedback.comments.mutation.commentId === comment.id}
            pendingLabel="Saving comment" pendingAnnouncement="Saving staff comment."
            disabled={locked || pending || !editDraft.trim() || editDraft === comment.text}
            onClick={() => void feedback.editComment(comment.id, editDraft, editedMentions(comment, editDraft, editMentions)).then(saved => {
              if (saved) { setEditingId(undefined); setEditDraft(""); }
            })} />
        </div>
      </> : <CommentText text={comment.text} />}
      {editing ? null : <Mentions comment={comment} />}
      {!editing && !confirmingDelete && (thread || comment.canEdit) ? <div className="media-feedback-actions">
        {thread ? <Button data-comment-reply disabled={pending || locked || commentsDisabled || Boolean(replyingId)}
          onClick={() => { replyTrigger.current = comment.id; setReplyingId(comment.id); setReplyDraft(""); setReplyMentions([]); feedback.clearCommentError(); }}>
          Reply{" "}<span className="sr-only">to {comment.authorName}</span></Button> : null}
        {thread && comment.canResolve ? <AsyncActionButton data-thread-state
          label={stateAction === "resolve" ? "Mark resolved" : "Reopen"}
          pending={feedback.comments.mutation?.action === stateAction && feedback.comments.mutation.commentId === comment.id}
          pendingLabel={stateAction === "resolve" ? "Resolving" : "Reopening"}
          pendingAnnouncement={stateAction === "resolve" ? "Marking the thread resolved." : "Reopening the thread."}
          disabled={locked || pending}
          onClick={() => void changeThreadState(thread, index)} /> : null}
        {comment.canEdit ? <>
          <Button data-comment-edit disabled={pending || locked || busyElsewhere} onClick={event => {
            editTriggerRow.current = event.currentTarget.closest("li");
            setEditingId(comment.id);
            setEditDraft(comment.text);
            setEditMentions([]);
            setDeletingId(undefined);
            feedback.clearCommentError();
          }}>Edit comment</Button>
          {canDelete ? <Button variant="danger-quiet" data-comment-delete disabled={pending || locked || busyElsewhere}
            onClick={event => { deleteTriggerRow.current = event.currentTarget.closest("li"); setDeletingId(comment.id); setEditingId(undefined); feedback.clearCommentError(); }}>Delete comment</Button> : null}
        </> : null}
      </div> : null}
      {confirmingDelete ? <div aria-label={`Confirm deletion of comment by ${comment.authorName}`}
        className="media-feedback-delete" ref={deleteConfirmation} role="group" tabIndex={-1}>
        <p>Delete this comment?</p>
        <div className="media-feedback-actions">
          <AsyncActionButton variant="danger" label="Delete comment"
            pending={feedback.comments.mutation?.action === "delete" && feedback.comments.mutation.commentId === comment.id}
            pendingLabel="Deleting comment" pendingAnnouncement="Deleting staff comment."
            disabled={locked || pending}
            onClick={() => void feedback.deleteComment(comment.id).then(deleted => {
              if (deleted) setDeletingId(undefined);
            })} />
          <Button disabled={pending} onClick={() => {
            setDeletingId(undefined);
            feedback.clearCommentError();
            requestAnimationFrame(() => deleteTriggerRow.current?.querySelector<HTMLButtonElement>("button[data-comment-delete]")?.focus());
          }}>Keep comment</Button>
        </div>
      </div> : null}
      {mutationError ? <InlineMessage tone="error" title={mutationError.action === "delete"
        ? "Comment was not deleted"
        : mutationError.action === "resolve" || mutationError.action === "reopen"
          ? "Thread was not changed"
          : "Comment was not saved"}>
        <span>{mutationError.message}</span>
        <div className="media-feedback-actions">
          {mutationError.conflict ? <Button disabled={pending} onClick={feedback.reloadComments}>Reload comments</Button> : null}
          {mutationError.action === "edit" && editing
            ? <Button disabled={pending || !editDraft.trim()} onClick={() => void feedback.editComment(comment.id, editDraft, editedMentions(comment, editDraft, editMentions))}>Try again</Button>
            : mutationError.action === "delete" && confirmingDelete
              ? <Button disabled={pending} onClick={() => void feedback.deleteComment(comment.id)}>Try again</Button>
              : (mutationError.action === "resolve" || mutationError.action === "reopen") && thread && !mutationError.conflict
                ? <Button disabled={pending} onClick={() => void changeThreadState(thread, index)}>Try again</Button>
                : null}
        </div>
      </InlineMessage> : null}
    </>;
  }

  const filterLabel = COMMENT_FILTERS.find(option => option.value === filter)?.label ?? "All";
  const replyError = feedback.comments.mutationError?.action === "create" && feedback.comments.mutationError.parentId
    ? feedback.comments.mutationError
    : null;

  const reviewPanel = <InspectorSection id="review" title="Your review">
      <p className="media-feedback-help">Only you can see this.</p>
      {feedback.review.loading ? <p className="media-feedback-status" role="status">Loading your review</p> : null}
      {feedback.review.ready ? <>
        <label className="media-feedback-check"><input type="checkbox"
          checked={feedback.review.draft.moreLikeThis} disabled={reviewDisabled}
          onChange={event => feedback.updateReview({ moreLikeThis: event.target.checked })} />
          <span>More like this</span>
        </label>
        <label className="media-feedback-field">Notes
          <Textarea maxLength={2000} rows={4} value={feedback.review.draft.notes} disabled={reviewDisabled}
            onChange={event => feedback.updateReview({ notes: event.target.value })} />
        </label>
        {reviewSaveMode === "separate" ? <div className="media-feedback-actions">
          <Button disabled={!feedback.reviewDirty || reviewDisabled} onClick={feedback.resetReview}>Cancel review changes</Button>
          <AsyncActionButton variant="primary" label="Save review" pending={feedback.review.saving}
            pendingLabel="Saving review" pendingAnnouncement="Saving your private media review."
            disabled={!feedback.reviewDirty || locked || Boolean(feedback.comments.mutation)}
            onClick={() => void feedback.saveReview()} />
        </div> : null}
        {feedback.review.savedNotice ? <InlineMessage tone="success" title="Your review saved">
          Your private review is version {feedback.review.saved.version}.
        </InlineMessage> : null}
      </> : null}
      {reviewError}
    </InspectorSection>;
  const commentsPanel = <InspectorSection id="staff-comments" title="Staff comments" openRequest={(timing?.composerRequest ?? 0) + (timing?.navigationRequest ?? 0)}
      onOpenRequestHandled={context ? honorContextRequest : () => document.getElementById(composerId)?.focus()}>
      <p className="media-feedback-help">Visible to staff with access.</p>
      {feedback.comments.loading ? <p className="media-feedback-status" role="status">Loading staff comments</p> : null}
      {feedback.comments.loadError ? <InlineMessage tone="error" title="Staff comments need attention">
        <span>{feedback.comments.loadError}</span>
        <Button disabled={pending || feedback.comments.loading} onClick={feedback.reloadComments}>Try again</Button>
      </InlineMessage> : null}
      {feedback.comments.ready ? <>
        {threads.length > 0 ? <div className="media-feedback-filter">
          <label htmlFor={filterId}>Show</label>
          <Select id={filterId} value={filter} onChange={event => {
            feedback.setCommentFilter(event.target.value as typeof filter);
            setThreadNotice("");
          }}>
            {COMMENT_FILTERS.map(option => <option key={option.value} value={option.value}>
              {option.label} ({counts[option.value]})</option>)}
          </Select>
          <Button disabled={feedback.commentExport.pending || feedback.comments.loading || pending}
            onClick={() => void feedback.exportComments()}>
            {feedback.commentExport.pending ? "Exporting…" : "Export CSV"}
          </Button>
        </div> : null}
        {threads.length > 0 ? <p className="media-feedback-help">Exports all saved comments matching Show, including replies and comments not yet loaded.</p> : null}
        {feedback.commentExport.error ? <InlineMessage tone="error" title="Comments could not be exported">
          {feedback.commentExport.error}
        </InlineMessage> : null}
        <p className="media-feedback-status" role="status">{feedback.commentExport.notice}</p>
        <p className="media-feedback-status" role="status">{threadNotice}</p>
        {threads.length === 0 ? <p className="media-feedback-empty">No staff comments yet.</p>
          : shownThreads.length === 0 ? <p className="media-feedback-empty">No threads match {filterLabel}.
            {feedback.comments.nextCursor ? " More comments may match after you load them." : ""}</p>
          : <ol className="media-feedback-comments" aria-label="Comment threads" ref={threadList}>
          {shownThreads.map((thread, index) => {
            const comment = thread.comment;
            const replying = replyingId === comment.id;
            return <li className="media-feedback-comment" key={comment.id} id={`media-comment-${comment.id}`} tabIndex={-1}
              data-active={comment.id === activeId || undefined} data-resolved={isResolved(comment) || undefined}>
              {renderComment(comment, comment.parentId ? null : thread, index)}
              {thread.replies.length > 0 ? <ol className="media-feedback-replies" aria-label={`Replies to ${comment.authorName}`}>
                {thread.replies.map(reply => <li className="media-feedback-reply" key={reply.id} id={`media-comment-${reply.id}`} tabIndex={-1}>
                  {renderComment(reply, null, index)}
                </li>)}
              </ol> : null}
              {replying ? <div className="media-feedback-reply-composer">
                <MentionTextarea id={`${composerId}-reply`} label={`Reply to ${comment.authorName}`} value={replyDraft}
                  disabled={commentsDisabled} staff={feedback.staff} onNeedStaff={needStaff}
                  onPick={person => setReplyMentions(list => addPick(list, person))}
                  onChange={value => { setReplyDraft(value); feedback.resetCreateOperation(); feedback.clearCommentError(); }} rows={3} />
                <div className="media-feedback-actions">
                  <AsyncActionButton label="Send reply" pending={feedback.comments.mutation?.action === "create" && feedback.comments.mutation.parentId === comment.id}
                    pendingLabel="Sending reply" pendingAnnouncement="Sending reply."
                    disabled={locked || pending || !replyDraft.trim()}
                    onClick={() => void sendReply(thread)} />
                  <Button disabled={pending} onClick={() => closeReply(true)}>Cancel reply</Button>
                </div>
                {replyError && replyError.parentId === comment.id ? <InlineMessage tone="error" title="Reply was not sent">
                  <span>{replyError.message}</span>
                  {replyError.conflict || replyError.message.includes("Reload")
                    ? <Button disabled={pending} onClick={feedback.reloadComments}>Reload comments</Button> : null}
                </InlineMessage> : null}
              </div> : null}
            </li>;
          })}
        </ol>}
        {replyingId && !replyingThread ? <InlineMessage tone="warning" title="The thread is no longer available">
          <p>Your unsaved reply stays here so you can copy it.</p>
          <label className="media-feedback-field">Unsaved reply
            <Textarea maxLength={2000} rows={3} value={replyDraft} disabled={pending || locked}
              onChange={event => setReplyDraft(event.target.value)} />
          </label>
          <Button disabled={pending} onClick={() => closeReply(false)}>Discard reply</Button>
        </InlineMessage> : null}
        {feedback.comments.nextCursor ? <Button disabled={pending || feedback.comments.loadingMore}
          onClick={() => void feedback.loadMoreComments()}>
          {feedback.comments.loadingMore ? "Loading more comments" : "Load more comments"}
        </Button> : null}
        {feedback.comments.moreError ? <InlineMessage tone="error" title="More comments were not loaded">
          <span>{feedback.comments.moreError}</span>
          <Button disabled={pending || feedback.comments.loadingMore} onClick={() => void feedback.loadMoreComments()}>Try again</Button>
        </InlineMessage> : null}
        {editingId && !editingComment ? <InlineMessage tone="warning" title="The edited comment is no longer available">
          <p>Your unsaved draft stays here so you can copy it or add it as a new comment.</p>
          <label className="media-feedback-field">Unsaved comment draft
            <Textarea maxLength={2000} rows={4} value={editDraft} disabled={pending || locked}
              onChange={event => setEditDraft(event.target.value)} />
          </label>
          <Button disabled={pending} onClick={() => { setEditingId(undefined); setEditDraft(""); }}>Discard draft</Button>
        </InlineMessage> : null}
        {timing ? <div className="media-feedback-time" role="group" aria-labelledby={timeHeadingId}>
          <p id={timeHeadingId}><strong>Time:</strong>{" "}
            {timing.draft ? commentTimeLabel(draftCommentTime(timing.draft, timing.rate)) : "None. The comment applies to the whole video."}</p>
          <div className="media-feedback-actions">
            <Button disabled={commentsDisabled} onClick={timing.onUseCurrent}>
              {timing.rate ? "Use current frame" : "Use current time"}</Button>
            <Button disabled={commentsDisabled} onClick={timing.onSetIn}>Set range start</Button>
            <Button disabled={commentsDisabled} onClick={timing.onSetOut}>Set range end</Button>
            {timing.draft ? <Button disabled={commentsDisabled} onClick={timing.onClear}>Remove time</Button> : null}
          </div>
          <p className="media-feedback-status" role="status">{timing.message}</p>
          <p className="media-feedback-help">Times count from the start of the file. Camera timecode is not kept.
            {timing.rate ? "" : " Frame numbers are not available for this video, so times use milliseconds."}</p>
        </div> : null}
        <MentionTextarea id={composerId} label="New comment" value={newComment} disabled={commentsDisabled}
          staff={feedback.staff} onNeedStaff={needStaff}
          onPick={person => setNewMentions(list => addPick(list, person))}
          onChange={value => { setNewComment(value); feedback.resetCreateOperation(); feedback.clearCommentError(); }} />
        <AsyncActionButton label="Add comment" pending={feedback.comments.mutation?.action === "create" && !feedback.comments.mutation.parentId}
          pendingLabel="Adding comment" pendingAnnouncement="Adding staff comment."
          disabled={locked || pending || !newComment.trim()}
          onClick={() => void addComment()} />
        {feedback.comments.mutationError?.action === "create" && !feedback.comments.mutationError.parentId ? <InlineMessage tone="error" title="Comment was not saved">
          <span>{feedback.comments.mutationError.message}</span>
          <div className="media-feedback-actions">
            {feedback.comments.mutationError.conflict ? <Button disabled={pending} onClick={feedback.reloadComments}>Reload comments</Button> : null}
            <Button disabled={pending || !newComment.trim()} onClick={() => void addComment()}>Try again</Button>
          </div>
        </InlineMessage> : null}
      </> : null}
    </InspectorSection>;
  const commentsPanelNode = context
    ? <div hidden={context.view !== "comments"} id={`${context.id}-comments`} role="tabpanel" aria-label="Comments">{commentsPanel}</div>
    : commentsPanel;
  const placedComments = context && commentsRoot ? createPortal(commentsPanelNode, commentsRoot) : commentsPanelNode;
  return <>
    {context ? <div hidden={context.view !== "review"} id={`${context.id}-review`} role="tabpanel" aria-label="Your review">{reviewPanel}</div> : reviewPanel}
    {context ? <div ref={setLocalCommentsTarget} /> : null}
    {placedComments}
  </>;
}
