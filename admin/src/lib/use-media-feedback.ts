import { useEffect, useRef, useState } from "react";
import {
  exportMediaComments,
  getMediaReview,
  listMediaComments,
  listMentionStaff,
  mutateMediaComment,
  saveMediaReview,
  type MediaComment,
  type MediaCommentPerson,
  type MediaCommentTimeInput,
  type MediaReview,
} from "./media-feedback";
import type { CommentFilter } from "./media-comment-threads";
import { HttpError } from "./functions";
import type { MediaAssetRef } from "./media-identity";
import { downloadMediaCommentsCsv } from "./media-comment-csv";
import { COMMENT_FILTERS } from "./media-comment-threads";

const EMPTY_REVIEW: MediaReview = {
  moreLikeThis: false,
  notes: "",
  version: 0,
  updatedAt: null,
};

type ReviewState = {
  key: string;
  saved: MediaReview;
  draft: MediaReview;
  loading: boolean;
  ready: boolean;
  saving: boolean;
  error: string;
  conflict: boolean;
  savedNotice: boolean;
};

export type CommentAction = "create" | "edit" | "delete" | "resolve" | "reopen";

type StaffState = { list: MediaCommentPerson[] | null; loading: boolean; error: string };

type CommentsState = {
  key: string;
  comments: MediaComment[];
  nextCursor: string | null;
  loading: boolean;
  ready: boolean;
  /** The file the server computed these comment times against. */
  loadedVersion: string | null;
  loadingMore: boolean;
  loadError: string;
  moreError: string;
  mutation: { action: CommentAction; commentId?: string; parentId?: string } | null;
  mutationError: {
    action: CommentAction;
    /** The thread a failed reply belongs to. */
    parentId?: string;
    commentId?: string;
    message: string;
    conflict: boolean;
  } | null;
};

function refKey(ref: MediaAssetRef): string {
  return JSON.stringify(ref.backend === "r2"
    ? [ref.backend, ref.id]
    : [ref.backend, ref.sourceId, ref.id]);
}

function reviewChanged(saved: MediaReview, draft: MediaReview): boolean {
  return saved.moreLikeThis !== draft.moreLikeThis || saved.notes !== draft.notes;
}

function requestId(): string {
  return globalThis.crypto.randomUUID().replaceAll("-", "");
}

function mergeComments(...pages: MediaComment[][]): MediaComment[] {
  const byId = new Map(pages.flat().map(comment => [comment.id, comment]));
  return [...byId.values()].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function useMediaFeedback(
  ref: MediaAssetRef,
  getIdToken?: () => Promise<string>,
  /** The open file. The server computes each comment's place for one file, so a new file reloads them. */
  fileVersion?: string | null,
) {
  const key = refKey(ref);
  const currentKey = useRef(key);
  currentKey.current = key;
  const commentVersion = fileVersion ?? "";
  const commentLoadCount = useRef(0);
  const enabled = Boolean(getIdToken);
  const [reviewAttempt, setReviewAttempt] = useState(0);
  const [commentsAttempt, setCommentsAttempt] = useState(0);
  const [review, setReview] = useState<ReviewState>({
    key,
    saved: EMPTY_REVIEW,
    draft: EMPTY_REVIEW,
    loading: enabled,
    ready: false,
    saving: false,
    error: "",
    conflict: false,
    savedNotice: false,
  });
  const [comments, setComments] = useState<CommentsState>({
    key,
    comments: [],
    nextCursor: null,
    loading: enabled,
    ready: false,
    loadedVersion: null,
    loadingMore: false,
    loadError: "",
    moreError: "",
    mutation: null,
    mutationError: null,
  });
  const createOperation = useRef<{ key: string; text: string; time: string; thread: string; requestId: string }>();
  // A retried resolve or reopen of the same version reuses its request id, so the server replays it.
  const stateOperation = useRef<{ key: string; action: CommentAction; commentId: string; baseVersion: number; requestId: string }>();
  // Resolved threads stay hidden until a reader picks another filter.
  const [commentFilter, setCommentFilter] = useState<CommentFilter>("open");
  const [staff, setStaff] = useState<StaffState>({ list: null, loading: false, error: "" });
  const [commentExport, setCommentExport] = useState({ key, pending: false, error: "", notice: "" });
  const exportRequest = useRef<AbortController>();
  useEffect(() => {
    setCommentExport({ key, pending: false, error: "", notice: "" });
    return () => exportRequest.current?.abort();
  }, [key, enabled]);

  useEffect(() => {
    if (!enabled || !getIdToken) {
      setReview(previous => ({ ...previous, key, loading: false, ready: false }));
      return;
    }
    const controller = new AbortController();
    setReview(previous => previous.key === key
      ? { ...previous, loading: true, error: "", conflict: false, savedNotice: false }
      : { key, saved: EMPTY_REVIEW, draft: EMPTY_REVIEW, loading: true, ready: false,
          saving: false, error: "", conflict: false, savedNotice: false });
    void (async () => {
      try {
        const result = await getMediaReview(await getIdToken(), ref, controller.signal);
        if (controller.signal.aborted || currentKey.current !== key) return;
        const saved = result.review ?? EMPTY_REVIEW;
        setReview(previous => {
          const preserveDraft = previous.key === key && previous.ready && reviewChanged(previous.saved, previous.draft);
          return { key, saved, draft: preserveDraft ? previous.draft : saved, loading: false, ready: true,
            saving: false, error: "", conflict: false, savedNotice: false };
        });
      } catch (error) {
        if (!controller.signal.aborted && currentKey.current === key) {
          setReview(previous => ({ ...previous, key, loading: false,
            error: message(error, "Your review could not be loaded.") }));
        }
      }
    })();
    return () => controller.abort();
  }, [enabled, getIdToken, key, reviewAttempt]);

  useEffect(() => {
    if (!enabled || !getIdToken) {
      setComments(previous => ({ ...previous, key, loading: false, ready: false }));
      return;
    }
    commentLoadCount.current += 1;
    const controller = new AbortController();
    // A new file or an overlap replaces a list that can hold comments past the pages loaded so far.
    const replacesAll = comments.key === key && comments.ready && comments.loadedVersion !== commentVersion;
    const loadedTarget = replacesAll ? Infinity : comments.key === key ? Math.max(comments.comments.length, 30) : 30;
    setComments(previous => previous.key === key
      ? { ...previous, loading: true, loadError: "", moreError: "", mutationError: null }
      : { key, comments: [], nextCursor: null, loading: true, ready: false, loadedVersion: null,
          loadingMore: false, loadError: "", moreError: "", mutation: null, mutationError: null });
    void (async () => {
      try {
        const token = await getIdToken();
        const loaded: MediaComment[] = [];
        let cursor: string | undefined;
        let nextCursor: string | null = null;
        do {
          const result = await listMediaComments(token, { ref, ...(cursor ? { cursor } : {}), limit: 30 }, controller.signal);
          loaded.push(...result.comments);
          nextCursor = result.nextCursor;
          cursor = result.nextCursor ?? undefined;
        } while (!controller.signal.aborted && cursor && loaded.length < loadedTarget);
        if (controller.signal.aborted || currentKey.current !== key) return;
        setComments(previous => ({ ...previous, key, comments: loaded, loadedVersion: commentVersion,
          nextCursor, loading: false, ready: true, loadError: "", moreError: "" }));
      } catch (error) {
        if (!controller.signal.aborted && currentKey.current === key) {
          setComments(previous => ({ ...previous, key, loading: false,
            loadError: message(error, "Staff comments could not be loaded.") }));
        }
      }
    })();
    return () => controller.abort();
  }, [commentsAttempt, commentVersion, enabled, getIdToken, key]);

  const visibleReview = review.key === key ? review : {
    ...review,
    key,
    saved: EMPTY_REVIEW,
    draft: EMPTY_REVIEW,
    loading: enabled,
    ready: false,
  };
  const visibleComments = comments.key === key ? comments : {
    ...comments,
    key,
    comments: [],
    nextCursor: null,
    loading: enabled,
    ready: false,
  };
  const commentTimesCurrent = visibleComments.ready && visibleComments.loadedVersion === commentVersion;
  const reviewDirty = enabled && visibleReview.ready && reviewChanged(visibleReview.saved, visibleReview.draft);

  async function saveReview(): Promise<boolean> {
    if (!enabled || !getIdToken || !reviewDirty || visibleReview.saving) return !reviewDirty;
    const draft = visibleReview.draft;
    const baseVersion = visibleReview.saved.version;
    setReview(previous => previous.key === key ? {
      ...previous,
      saving: true,
      error: "",
      conflict: false,
      savedNotice: false,
    } : previous);
    try {
      const result = await saveMediaReview(await getIdToken(), {
        ref,
        baseVersion,
        moreLikeThis: draft.moreLikeThis,
        notes: draft.notes,
      });
      if (currentKey.current !== key) return false;
      setReview(previous => previous.key === key ? {
        ...previous,
        saved: result.review,
        draft: result.review,
        saving: false,
        error: "",
        conflict: false,
        savedNotice: true,
      } : previous);
      return true;
    } catch (error) {
      if (currentKey.current === key) {
        setReview(previous => previous.key === key ? {
          ...previous,
          saving: false,
          error: message(error, "Your review could not be saved."),
          conflict: error instanceof HttpError && error.status === 409,
        } : previous);
      }
      return false;
    }
  }

  /**
   * A list load replaces the whole list, and a load can start on another file. So a change or page
   * that overlapped a load is either dropped by it or holds another file's times. The returned
   * check runs after that response is applied, and loads the list again.
   */
  function watchCommentLoads() {
    const running = visibleComments.loading;
    const startCount = commentLoadCount.current;
    return () => {
      if (!running && commentLoadCount.current === startCount) return;
      setComments(previous => previous.key === key ? { ...previous, loadedVersion: null } : previous);
      setCommentsAttempt(value => value + 1);
    };
  }

  async function loadMoreComments() {
    if (!enabled || !getIdToken || !visibleComments.ready || visibleComments.loadingMore || !visibleComments.nextCursor) return;
    const cursor = visibleComments.nextCursor;
    const reloadIfOverlapped = watchCommentLoads();
    setComments(previous => previous.key === key ? { ...previous, loadingMore: true, moreError: "" } : previous);
    try {
      const result = await listMediaComments(await getIdToken(), { ref, cursor, limit: 30 });
      if (currentKey.current !== key) return;
      setComments(previous => previous.key === key ? {
        ...previous,
        comments: mergeComments(previous.comments, result.comments),
        nextCursor: result.nextCursor,
        loadingMore: false,
        moreError: "",
      } : previous);
      reloadIfOverlapped();
    } catch (error) {
      if (currentKey.current === key) {
        setComments(previous => previous.key === key ? {
          ...previous,
          loadingMore: false,
          moreError: message(error, "More comments could not be loaded."),
        } : previous);
      }
    }
  }

  async function loadStaff() {
    if (!enabled || !getIdToken || staff.loading || staff.list) return;
    setStaff({ list: null, loading: true, error: "" });
    try {
      const result = await listMentionStaff(await getIdToken(), ref);
      setStaff({ list: result.staff, loading: false, error: "" });
    } catch (error) {
      setStaff({ list: null, loading: false, error: message(error, "The staff list could not be loaded.") });
    }
  }

  async function exportComments() {
    if (!enabled || !getIdToken || exportRequest.current && !exportRequest.current.signal.aborted) return;
    const controller = new AbortController();
    exportRequest.current = controller;
    setCommentExport({ key, pending: true, error: "", notice: "" });
    try {
      const exported = await exportMediaComments(await getIdToken(), ref, commentFilter, controller.signal);
      if (controller.signal.aborted || currentKey.current !== key) return;
      downloadMediaCommentsCsv(exported, commentFilter);
      const label = COMMENT_FILTERS.find(option => option.value === commentFilter)!.label;
      setCommentExport({ key, pending: false, error: "",
        notice: `Downloaded ${exported.length} comment${exported.length === 1 ? "" : "s"} (${label}).` });
    } catch (error) {
      if (!controller.signal.aborted && currentKey.current === key) {
        setCommentExport({ key, pending: false, notice: "", error: message(error, "Comments could not be exported. Try again.") });
      }
    } finally {
      controller.abort();
    }
  }

  /** Resolves to the new comment ID for a create, true for other changes, or false on failure. */
  async function runCommentMutation(
    action: CommentAction,
    options: { commentId?: string; text?: string; time?: MediaCommentTimeInput; parentId?: string; mentions?: string[] },
  ): Promise<string | boolean> {
    if (!enabled || !getIdToken || visibleComments.mutation) return false;
    const comment = options.commentId
      ? visibleComments.comments.find(candidate => candidate.id === options.commentId)
      : undefined;
    if (action !== "create" && !comment) return false;
    const text = options.text?.trim();
    if ((action === "create" || action === "edit") && !text) return false;
    // A retry reuses the request id only for the same text at the same time in the same thread.
    const time = JSON.stringify(options.time ?? null);
    const thread = JSON.stringify([options.parentId ?? null, options.mentions ?? []]);
    const create = action === "create"
      ? createOperation.current?.key === key && createOperation.current.text === text &&
        createOperation.current.time === time && createOperation.current.thread === thread
        ? createOperation.current
        : { key, text: text!, time, thread, requestId: requestId() }
      : undefined;
    if (create) createOperation.current = create;
    const stateChange = action === "resolve" || action === "reopen"
      ? stateOperation.current?.key === key && stateOperation.current.action === action &&
        stateOperation.current.commentId === comment!.id && stateOperation.current.baseVersion === comment!.version
        ? stateOperation.current
        : { key, action, commentId: comment!.id, baseVersion: comment!.version, requestId: requestId() }
      : undefined;
    if (stateChange) stateOperation.current = stateChange;
    const reloadIfOverlapped = watchCommentLoads();
    setComments(previous => previous.key === key ? {
      ...previous,
      mutation: { action, ...(comment ? { commentId: comment.id } : {}),
        ...(options.parentId ? { parentId: options.parentId } : {}) },
      mutationError: null,
    } : previous);
    try {
      const token = await getIdToken();
      const mentions = options.mentions?.length ? { mentions: options.mentions } : {};
      const input = action === "create"
        ? { ref, action, requestId: create!.requestId, text: text!,
            ...(options.time ? { time: options.time } : {}),
            ...(options.parentId ? { parentId: options.parentId } : {}), ...mentions } as const
        : action === "edit"
          ? { ref, action, requestId: requestId(), commentId: comment!.id,
              baseVersion: comment!.version, text: text!,
              ...(options.mentions ? { mentions: options.mentions } : {}) } as const
          : { ref, action, requestId: stateChange?.requestId ?? requestId(), commentId: comment!.id,
              baseVersion: comment!.version } as const;
      const result = await mutateMediaComment(token, input);
      if (currentKey.current !== key) return false;
      if (action === "create" && !result.comment) {
        createOperation.current = undefined;
        throw new Error("This comment was added earlier and later removed. Your draft is still here. Try again to add it as a new comment.");
      }
      if (action !== "create" && action !== "delete" && !result.comment) {
        throw new Error(action === "edit"
          ? "The comment response was incomplete."
          : "This comment is no longer available. Reload the comments.");
      }
      setComments(previous => {
        if (previous.key !== key) return previous;
        const next = action === "create"
          ? mergeComments(previous.comments, [result.comment!])
          : action === "delete"
            ? previous.comments.filter(item => item.id !== comment!.id)
            : previous.comments.map(item => item.id === result.comment!.id ? result.comment! : item);
        return { ...previous, comments: next, mutation: null, mutationError: null };
      });
      reloadIfOverlapped();
      if (action === "create") createOperation.current = undefined;
      if (stateChange) stateOperation.current = undefined;
      return action === "create" ? result.comment!.id : true;
    } catch (error) {
      if (currentKey.current === key) {
        setComments(previous => previous.key === key ? {
          ...previous,
          mutation: null,
          mutationError: {
            action,
            ...(comment ? { commentId: comment.id } : {}),
            ...(options.parentId ? { parentId: options.parentId } : {}),
            message: message(error, action === "delete"
              ? "The comment could not be deleted."
              : action === "resolve" || action === "reopen"
                ? "The thread could not be changed."
                : "The comment could not be saved."),
            conflict: error instanceof HttpError && error.status === 409,
          },
        } : previous);
      }
      return false;
    }
  }

  return {
    enabled,
    review: visibleReview,
    comments: visibleComments,
    /** False until the loaded comment times belong to the open file. */
    commentTimesCurrent,
    reviewDirty,
    pending: visibleReview.saving || Boolean(visibleComments.mutation),
    updateReview: (draft: Partial<Pick<MediaReview, "moreLikeThis" | "notes">>) => {
      setReview(previous => previous.key === key ? {
        ...previous,
        draft: { ...previous.draft, ...draft },
        error: "",
        conflict: false,
        savedNotice: false,
      } : previous);
    },
    resetReview: () => setReview(previous => previous.key === key ? {
      ...previous,
      draft: previous.saved,
      error: "",
      conflict: false,
      savedNotice: false,
    } : previous),
    reloadReview: () => setReviewAttempt(value => value + 1),
    saveReview,
    reloadComments: () => setCommentsAttempt(value => value + 1),
    loadMoreComments,
    exportComments,
    commentExport: commentExport.key === key ? commentExport : { key, pending: false, error: "", notice: "" },
    createComment: (text: string, time?: MediaCommentTimeInput, mentions?: string[]) =>
      runCommentMutation("create", { text, time, mentions }),
    replyToComment: (parentId: string, text: string, mentions?: string[]) =>
      runCommentMutation("create", { text, parentId, mentions }),
    editComment: (commentId: string, text: string, mentions?: string[]) =>
      runCommentMutation("edit", { commentId, text, mentions }),
    deleteComment: (commentId: string) => runCommentMutation("delete", { commentId }),
    resolveComment: (commentId: string) => runCommentMutation("resolve", { commentId }),
    reopenComment: (commentId: string) => runCommentMutation("reopen", { commentId }),
    commentFilter,
    setCommentFilter,
    staff,
    loadStaff,
    clearCommentError: () => setComments(previous => previous.key === key
      ? { ...previous, mutationError: null }
      : previous),
    resetCreateOperation: () => { createOperation.current = undefined; },
  };
}

export type MediaFeedback = ReturnType<typeof useMediaFeedback>;
