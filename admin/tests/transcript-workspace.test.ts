import { describe, expect, it } from "vitest";
import { matchingPassages, passageAtPosition, passageId, passageTimestamp, parseTranscriptPosition, selectedPassageRange, speakerLabel, togglePassageSelection, TRANSCRIPT_PAGE_SIZE } from "../src/lib/transcript-workspace";
import { mediaTranscriptFixture, mediaTranscriptSegments } from "../src/dev/fixtures/media-transcript";
import type { TranscriptSegment } from "../src/lib/video-production";

const segments: TranscriptSegment[] = [
  { index: 10, speaker: "spk_0", text: "Local reporting", startSeconds: 0, endSeconds: 2 },
  { index: 20, speaker: "spk_1", text: "Community voices", startSeconds: 10, endSeconds: 12 },
  { index: 30, speaker: "unknown", text: "Local partnerships", startSeconds: 20, endSeconds: 25 },
];

describe("transcript workspace navigation", () => {
  it("bounds each rendered page independently of server pagination", () => {
    expect(TRANSCRIPT_PAGE_SIZE).toBe(50);
    expect(passageId(segments[0], 0)).toBe(10);
    expect(passageId({ ...segments[0], index: undefined }, 4)).toBe(4);
  });
  it("searches wording, names and affiliations literally without changing source indices", () => {
    const names = { spk_0: "Alex" };
    const roles = { spk_0: "Reporter" };
    expect(matchingPassages(segments, " LOCAL ", "", names, roles).map(entry => entry.id)).toEqual([10, 30]);
    expect(matchingPassages(segments, "alex", "", names, roles).map(entry => entry.position)).toEqual([0]);
    expect(matchingPassages(segments, "reporter", "spk_0", names, roles)).toHaveLength(1);
    expect(matchingPassages(segments, "local", "spk_1", names, roles)).toHaveLength(0);
    expect(matchingPassages(segments, "[.*", "", names, roles)).toHaveLength(0);
  });
  it("does not merge or name distinct unknown voices", () => {
    expect(speakerLabel("spk_0")).toBe("Speaker 1");
    expect(speakerLabel("unknown")).toBe("Unknown speaker");
    expect(matchingPassages(segments, "Someone", "", { unknown: "Someone" }, {})).toHaveLength(0);
  });
  it("parses elapsed seconds and long-recording timestamps", () => {
    for (const [text, expected] of [["65.125", 65.125], [" 1:05 ", 65], ["65:30", 3930], ["1:05:30", 3930], ["00:00:01.001", 1.001], ["0", 0]] as const) {
      expect(parseTranscriptPosition(text)).toBe(expected);
    }
  });
  it("formats compact elapsed stamps without changing exact source times", () => {
    expect(passageTimestamp(8.12)).toBe("00:08");
    expect(passageTimestamp(8.3)).toBe("00:08");
    expect(passageTimestamp(3930.125)).toBe("1:05:30");
    const fixture = mediaTranscriptFixture();
    expect(fixture.nextCursor).toBe("synthetic-server-cursor-page-3");
    expect(fixture.segments).toHaveLength(115);
    expect(fixture.transcript.totalSegments).toBe(180);
    expect(mediaTranscriptSegments[179].endSeconds).toBe(5400);
    expect(selectedPassageRange(fixture.segments!, new Set([1]))).toBeNull();
    expect(selectedPassageRange(fixture.segments!, new Set([1, 2]))).toEqual({ speaker: "unknown", text: "", startSeconds: 8.12, endSeconds: 11.94 });
  });
  it("rejects ambiguous, negative, nonfinite and unsafe timestamps", () => {
    for (const value of ["", " ", "-1", "1e3", "Infinity", "NaN", "1:60", "1:60:00", "1:2", "00:00:00.0001", "9999999999999999999999"]) {
      expect(parseTranscriptPosition(value)).toBeNull();
    }
  });
  it("finds containing passages or the next passage in a pause, without inventing unloaded content", () => {
    expect(passageAtPosition(segments, 1)).toBe(0);
    expect(passageAtPosition(segments, 4)).toBe(1);
    expect(passageAtPosition(segments, 20)).toBe(2);
    expect(passageAtPosition(segments, 26)).toBe(-1);
    expect(passageAtPosition([], 0)).toBe(-1);
    expect(passageAtPosition(segments, NaN)).toBe(-1);
  });
});

describe("continuous passage selection", () => {
  it("extends and removes selections in filtered order without mutating existing selection", () => {
    const selected = new Set([10, 99]);
    expect([...togglePassageSelection(selected, 30, true, [10, 20, 30], 10, true)]).toEqual([10, 99, 20, 30]);
    expect([...selected]).toEqual([10, 99]);
    expect([...togglePassageSelection(new Set([10, 20, 30]), 10, false, [10, 20, 30], 30, true)]).toEqual([]);
    expect([...togglePassageSelection(selected, 30, true, [20, 30], 10, true)]).toEqual([10, 99, 30]);
  });
  it("uses chronological bounds rather than click order and explicitly retains gaps", () => {
    expect(selectedPassageRange(segments, new Set([30, 10]))).toEqual({ speaker: "unknown", text: "", startSeconds: 0, endSeconds: 25 });
    expect(selectedPassageRange(segments, new Set([20]))?.startSeconds).toBe(10);
    expect(selectedPassageRange(segments, new Set([999]))).toBeNull();
  });
  it("uses the existing millisecond precision and inclusive 0.25-second / 30-minute duration limits", () => {
    const span = (startSeconds: number, endSeconds: number) => selectedPassageRange([{ ...segments[0], startSeconds, endSeconds }], new Set([10]));
    expect(span(0, 0.25)?.endSeconds).toBe(0.25);
    expect(span(0, 0.249)).toBeNull();
    expect(span(0, 1800)?.endSeconds).toBe(1800);
    expect(span(0, 1800.001)).toBeNull();
    expect(span(1.0004, 2.0004)).toEqual({ speaker: "unknown", text: "", startSeconds: 1, endSeconds: 2 });
  });
  it("rejects invalid timing rather than handing an unsafe range to the exporter", () => {
    for (const [startSeconds, endSeconds] of [[NaN, 2], [0, Infinity], [-1, 1], [2, 1], [1, 1], [1e15, 1e15 + 1]]) {
      expect(selectedPassageRange([{ ...segments[0], startSeconds, endSeconds }], new Set([10]))).toBeNull();
    }
  });
});
