import type { CommentThread } from "./media-comment-threads";
import type { TranscriptSegment } from "./video-production";

/** Comments belong after the passage that starts before them, including silence gaps. */
export function transcriptCommentGroups(segments: readonly TranscriptSegment[], threads: readonly CommentThread[], complete: boolean) {
  const groups = new Map<number, CommentThread[]>();
  const timed = threads.filter(thread => thread.comment.time?.currentVersion)
    .sort((a, b) => a.comment.time!.startMs - b.comment.time!.startMs || a.comment.createdAt.localeCompare(b.comment.createdAt));
  let position = 0;
  for (const thread of timed) {
    const seconds = thread.comment.time!.startMs / 1000;
    while (position + 1 < segments.length && segments[position + 1].startSeconds <= seconds) position++;
    if (!segments.length || (!complete && seconds > segments.at(-1)!.endSeconds)) continue;
    const key = seconds < segments[0].startSeconds ? -1 : position;
    const group = groups.get(key) ?? [];
    group.push(thread);
    groups.set(key, group);
  }
  return groups;
}
