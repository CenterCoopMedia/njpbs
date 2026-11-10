import { describe, expect, it } from "vitest";
import { transcriptCommentGroups } from "../src/lib/transcript-playback";
import type { CommentThread } from "../src/lib/media-comment-threads";
const segments = [10, 30, 50].map((startSeconds, index) => ({ index, startSeconds, endSeconds: startSeconds + 10, speaker: "spk_0", text: "A passage" }));
function thread(id: string, startMs: number, currentVersion = true): CommentThread {
  return { comment: { id, authorUid: "staff", authorName: "Editor", text: id, version: 1, canEdit: false,
    createdAt: "2026-10-26", updatedAt: "2026-10-26", time: { startMs, endMs: null, startFrame: null, endFrame: null, rateNum: null, rateDen: null, currentVersion } }, replies: [] };
}
describe("timed comments between transcript passages", () => {
  it("orders starts, silence gaps, exact boundaries and trailing comments while excluding replaced-file times", () => {
    const groups = transcriptCommentGroups(segments, [thread("trailing", 70000), thread("boundary", 30000), thread("gap", 25000), thread("opening", 0), thread("old", 10000, false)], true);
    expect([...groups].map(([position, threads]) => [position, threads.map(thread => thread.comment.id)])).toEqual([
      [-1, ["opening"]], [0, ["gap"]], [1, ["boundary"]], [2, ["trailing"]],
    ]);
  });
  it("holds later comments until their transcript page loads and handles an empty transcript", () => {
    expect(transcriptCommentGroups(segments.slice(0, 1), [thread("later", 25000)], false).size).toBe(0);
    expect(transcriptCommentGroups([], [thread("later", 25000)], true).size).toBe(0);
  });
});
