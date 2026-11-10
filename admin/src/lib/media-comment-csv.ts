import type { MediaComment, MediaCommentTime } from "./media-feedback";
import { commentThreads, isResolved } from "./media-comment-threads";
import { frameTimecode } from "./media-comment-time";

function csvCell(value: string | number): string {
  const text = String(value);
  // Quoting preserves delimiters; the apostrophe prevents spreadsheet formula execution.
  const safe = /^[\s\u0000-\u001f\u007f-\u009f]*[=+@-]/u.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

function point(time: MediaCommentTime | undefined, end: boolean): [string, string] {
  if (!time) return ["", ""];
  const frame = end ? time.endFrame : time.startFrame;
  const ms = end ? time.endMs : time.startMs;
  if (frame !== null && time.rateNum !== null && time.rateDen !== null) {
    const rate = { num: time.rateNum, den: time.rateDen };
    return [frameTimecode(frame, rate), String(Number((frame * rate.den / rate.num).toFixed(6)))];
  }
  return ["", ms === null ? "" : String(ms / 1000)];
}

/** Complete authorized threads from the export endpoint, including replies. */
export function mediaCommentsCsv(comments: readonly MediaComment[]): string {
  const rows: (string | number)[][] = [[
    "Timecode", "Seconds", "Range end timecode", "Range end seconds", "Author", "Text",
    "Status", "Replies count", "Comment version", "File version", "Drawing", "Comment ID", "Parent ID",
  ]];
  for (const thread of commentThreads(comments)) {
    for (const comment of [thread.comment, ...thread.replies]) {
      const time = thread.comment.time;
      rows.push([
        ...point(time, false), ...point(time, true), comment.authorName, comment.text,
        isResolved(thread.comment) ? "Resolved" : "Open",
        comment === thread.comment ? thread.replies.length : 0,
        comment.version, time ? time.currentVersion ? "Current" : "Earlier" : "",
        "No", comment.id, comment.parentId ?? "",
      ]);
    }
  }
  return "\uFEFF" + rows.map(row => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export function downloadMediaCommentsCsv(comments: readonly MediaComment[], filter: string): void {
  const url = URL.createObjectURL(new Blob([mediaCommentsCsv(comments)], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `boardwalk-comments-${filter}.csv`;
  document.body.appendChild(link);
  try { link.click(); }
  finally {
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
