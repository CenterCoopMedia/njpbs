import type { MediaComment, MediaCommentPerson } from "./media-feedback";

/**
 * Filters apply to whole threads. Open and Resolved follow the first comment's state. Mine and
 * Mentions me include resolved threads. Filters work on the comments loaded so far.
 */
export type CommentFilter = "open" | "resolved" | "mine" | "mentions" | "all";

export const COMMENT_FILTERS: readonly { value: CommentFilter; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "resolved", label: "Resolved" },
  { value: "mine", label: "Mine" },
  { value: "mentions", label: "Mentions me" },
  { value: "all", label: "All" },
];

export interface CommentThread {
  comment: MediaComment;
  replies: MediaComment[];
}

export function isResolved(comment: MediaComment): boolean {
  return Boolean(comment.resolvedAt);
}

/**
 * First comments in the given order, each with its replies in the order added. A reply whose
 * first comment is not loaded shows as its own thread so it is never hidden.
 */
export function commentThreads(comments: readonly MediaComment[]): CommentThread[] {
  const tops = new Map<string, CommentThread>();
  for (const comment of comments) {
    if (!comment.parentId) tops.set(comment.id, { comment, replies: [] });
  }
  const threads: CommentThread[] = [];
  for (const comment of comments) {
    const parent = comment.parentId ? tops.get(comment.parentId) : undefined;
    if (parent) parent.replies.push(comment);
    else threads.push(tops.get(comment.id) ?? { comment, replies: [] });
  }
  for (const thread of tops.values()) {
    thread.replies.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }
  return threads;
}

export function threadMatches(thread: CommentThread, filter: CommentFilter): boolean {
  const all = [thread.comment, ...thread.replies];
  switch (filter) {
    case "open": return !isResolved(thread.comment);
    case "resolved": return isResolved(thread.comment);
    case "mine": return all.some(comment => comment.canEdit);
    case "mentions": return all.some(comment => comment.mentionsYou === true);
    default: return true;
  }
}

export function filterCounts(threads: readonly CommentThread[]): Record<CommentFilter, number> {
  const counts = { open: 0, resolved: 0, mine: 0, mentions: 0, all: 0 };
  for (const thread of threads) {
    for (const { value } of COMMENT_FILTERS) if (threadMatches(thread, value)) counts[value] += 1;
  }
  return counts;
}

/** First comments of the threads the filter shows. Replies have no time, so they get no marker. */
export function filteredTimelineComments(comments: readonly MediaComment[], filter: CommentFilter): MediaComment[] {
  return commentThreads(comments).filter(thread => threadMatches(thread, filter)).map(thread => thread.comment);
}

/** The text of an @ query that ends at the caret, or null when the caret is not in one. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at < 0 || (at > 0 && !/\s/.test(before[at - 1]))) return null;
  const query = before.slice(at + 1);
  // One space lets a reader type a first and last name.
  if (query.length > 40 || /\n/.test(query) || !/^[^\s@]*( [^\s@]*)?$/.test(query)) return null;
  return { start: at, query };
}

export function mentionMatches(staff: readonly MediaCommentPerson[], query: string, limit = 8): MediaCommentPerson[] {
  const wanted = query.trim().toLocaleLowerCase();
  const starts = (person: MediaCommentPerson) =>
    person.name.toLocaleLowerCase().split(/\s+/).some(word => word.startsWith(wanted)) ||
    person.name.toLocaleLowerCase().startsWith(wanted);
  return staff.filter(person => !wanted || starts(person)).slice(0, limit);
}

/**
 * True when the text holds @name as a whole name: the next character after the name is not a
 * letter, digit, or name joiner. So "@Anna" does not count as a mention of "Ann".
 */
export function namesMention(text: string, name: string): boolean {
  const wanted = `@${name}`;
  for (let at = text.indexOf(wanted); at >= 0; at = text.indexOf(wanted, at + 1)) {
    const next = text[at + wanted.length];
    if (next === undefined || !/[\p{L}\p{N}_'’-]/u.test(next)) return true;
  }
  return false;
}

/** Mentions the text still names. A pick whose @name was removed from the text is not sent. */
export function mentionsInText(text: string, picked: readonly MediaCommentPerson[]): MediaCommentPerson[] {
  return picked.filter(person => namesMention(text, person.name));
}
