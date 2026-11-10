import { describe, expect, it } from "vitest";
import { mediaCommentsCsv } from "../src/lib/media-comment-csv";
import { commentTimeLabel } from "../src/lib/media-comment-time";
import type { MediaComment } from "../src/lib/media-feedback";

const first: MediaComment = {
  id: "a".repeat(64), authorUid: "staff", authorName: "José, 李", text: 'Check "intro"\r\nThen audio.',
  version: 3, createdAt: "2026-10-01T12:00:00Z", updatedAt: "2026-10-01T12:00:00Z", canEdit: true,
  resolvedAt: "2026-10-02T12:00:00Z",
  time: { startFrame: 1800, endFrame: 1830, rateNum: 30000, rateDen: 1001,
    startMs: 60060, endMs: 61094, currentVersion: false },
};

describe("comment CSV format", () => {
  it("quotes Unicode, commas, quotes and multiline text, with BOM and complete thread rows", () => {
    const reply = { ...first, id: "b".repeat(64), parentId: first.id, authorName: "Taylor",
      text: "Confirmed", version: 1, time: undefined, resolvedAt: null };
    const csv = mediaCommentsCsv([first, reply]);
    expect(csv.startsWith('\uFEFF"Timecode","Seconds",')).toBe(true);
    // Frame 1800 is 60.06 seconds and frame 1830 is 61.061 seconds at 30000/1001.
    // Range end identifies the last frame's start, matching Boardwalk's visible timecode.
    expect(commentTimeLabel(first.time!)).toBe("1:00 (00:01:00;02) to 1:01 (00:01:01;02)");
    expect(csv).toContain('"00:01:00;02","60.06","00:01:01;02","61.061","José, 李","Check ""intro""\r\nThen audio.","Resolved","1","3","Earlier","No"');
    expect(csv).toContain(`"00:01:00;02","60.06","00:01:01;02","61.061","Taylor","Confirmed","Resolved","0","1","Earlier","No","${reply.id}","${first.id}"\r\n`);
    expect(csv).not.toContain("staff");
  });

  it.each(["=1+1", "+SUM(A1)", "-1+2", "@SUM(A1)", " \t=1+1", "\r\n@SUM(A1)"])(
    "neutralizes spreadsheet formulas in author and text cells: %j", value => {
      const csv = mediaCommentsCsv([{ ...first, authorName: value, text: value }]);
      expect(csv).toContain(`"'${value}","'${value}"`);
    },
  );

  it("preserves millisecond and untimed notes without inventing frame precision", () => {
    const milliseconds = { ...first, resolvedAt: null, time: {
      startFrame: null, endFrame: null, rateNum: null, rateDen: null,
      startMs: 1234, endMs: 2345, currentVersion: true,
    } };
    expect(mediaCommentsCsv([milliseconds])).toContain('"","1.234","","2.345"');
    expect(mediaCommentsCsv([{ ...first, time: undefined }])).toContain('"","","","","José, 李"');
    expect(mediaCommentsCsv([{ ...first, time: { ...first.time!, endFrame: null, endMs: null } }]))
      .toContain('"00:01:00;02","60.06","",""');
  });
});
