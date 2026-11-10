import { postFunction } from "./functions";
import type { MediaAssetRef } from "./media-identity";
import type { CommentFilter } from "./media-comment-threads";

export const MEDIA_FEEDBACK_SCHEMA_VERSION = 1;

export interface MediaReview {
  moreLikeThis: boolean;
  notes: string;
  version: number;
  updatedAt: string | null;
}

/** Frames are null when the video had no usable frame rate; endMs ends the last frame. */
export interface MediaCommentTime {
  startFrame: number | null;
  endFrame: number | null;
  rateNum: number | null;
  rateDen: number | null;
  startMs: number;
  endMs: number | null;
  /** False when the comment was made on an earlier version of the file. */
  currentVersion: boolean;
}

export type MediaCommentTimeInput = (
  | { startFrame: number; endFrame?: number }
  | { startMs: number; endMs?: number }
) & { fileVersion: string };

/** A staff member named on a comment. The name is read from the staff directory at request time. */
export interface MediaCommentPerson {
  uid: string;
  name: string;
}

export interface MediaComment {
  id: string;
  authorUid: string;
  authorName: string;
  text: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  canEdit: boolean;
  time?: MediaCommentTime;
  /** The first comment of the thread for a reply; null for a first comment. */
  parentId?: string | null;
  mentions?: MediaCommentPerson[];
  mentionsYou?: boolean;
  resolvedAt?: string | null;
  resolvedBy?: MediaCommentPerson | null;
  /** True when the reader may resolve or reopen this thread. Always false for a reply. */
  canResolve?: boolean;
  /** A first comment with at least one reply, including replies on pages not loaded yet. */
  hasReplies?: boolean;
}

export function getMediaReview(
  token: string,
  ref: MediaAssetRef,
  signal?: AbortSignal,
) {
  return postFunction<{ success: true; review: MediaReview | null }>(
    "cmsGetMediaReview",
    token,
    { schemaVersion: MEDIA_FEEDBACK_SCHEMA_VERSION, ref },
    {},
    { signal, operation: "media-read" },
  );
}

export function saveMediaReview(
  token: string,
  input: {
    ref: MediaAssetRef;
    baseVersion: number;
    moreLikeThis: boolean;
    notes: string;
  },
  signal?: AbortSignal,
) {
  return postFunction<{ success: true; review: MediaReview }>(
    "cmsSaveMediaReview",
    token,
    { schemaVersion: MEDIA_FEEDBACK_SCHEMA_VERSION, ...input },
    {},
    { appCheck: true, signal, operation: "media-write" },
  );
}

export function listMediaComments(
  token: string,
  input: { ref: MediaAssetRef; cursor?: string; limit?: number },
  signal?: AbortSignal,
) {
  return postFunction<{
    success: true;
    comments: MediaComment[];
    nextCursor: string | null;
  }>(
    "cmsListMediaComments",
    token,
    { schemaVersion: MEDIA_FEEDBACK_SCHEMA_VERSION, ...input },
    {},
    { signal, operation: "media-read" },
  );
}

/** Complete filtered comments; the server commits the export audit before answering. */
export async function exportMediaComments(token: string, ref: MediaAssetRef, filter: CommentFilter, signal: AbortSignal) {
  const result = await postFunction<{ success: true; exported: true; comments: MediaComment[] }>(
    "cmsListMediaComments", token,
    { schemaVersion: MEDIA_FEEDBACK_SCHEMA_VERSION, ref, export: filter }, {},
    { appCheck: true, signal, operation: "media-write" },
  );
  if (result.exported !== true) throw new Error("Comment export is not available. Reload and try again.");
  return result.comments;
}

/** Active staff that can be mentioned. The server answers only readers of the item. */
export function listMentionStaff(
  token: string,
  ref: MediaAssetRef,
  signal?: AbortSignal,
) {
  return postFunction<{ success: true; staff: MediaCommentPerson[] }>(
    "cmsListMediaComments",
    token,
    { schemaVersion: MEDIA_FEEDBACK_SCHEMA_VERSION, ref, staff: true },
    {},
    { signal, operation: "media-read" },
  );
}

export type MediaCommentMutation =
  | {
      ref: MediaAssetRef;
      action: "create";
      requestId: string;
      text: string;
      time?: MediaCommentTimeInput;
      parentId?: string;
      mentions?: string[];
    }
  | {
      ref: MediaAssetRef;
      action: "edit";
      requestId: string;
      commentId: string;
      baseVersion: number;
      text: string;
      mentions?: string[];
    }
  | {
      ref: MediaAssetRef;
      action: "delete" | "resolve" | "reopen";
      requestId: string;
      commentId: string;
      baseVersion: number;
    };

export function mutateMediaComment(
  token: string,
  input: MediaCommentMutation,
  signal?: AbortSignal,
) {
  return postFunction<{ success: true; comment: MediaComment | null }>(
    "cmsMutateMediaComment",
    token,
    { schemaVersion: MEDIA_FEEDBACK_SCHEMA_VERSION, ...input },
    {},
    { appCheck: true, signal, operation: "media-write" },
  );
}
