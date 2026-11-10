import { describe, expect, it } from "vitest";
import {
  clockLabel,
  commentTimeLabel,
  commentFrameRate,
  commentTimeSpoken,
  frameAtPresentationTime,
  frameAtSeconds,
  frameTimecode,
  seekSecondsForFrame,
} from "../src/lib/media-comment-time";

const NTSC = { num: 30000, den: 1001 };
const FILM = { num: 24000, den: 1001 };
const NTSC_HIGH = { num: 60000, den: 1001 };

describe("comment timecode", () => {
  // Expected values follow SMPTE ST 12-1 drop-frame numbering: frames ;00 and ;01 (;00 to ;03
  // at 59.94) are skipped at the start of each minute except every tenth minute.
  it("uses drop-frame numbering for 29.97 and 59.94 fps", () => {
    expect(frameTimecode(1799, NTSC)).toBe("00:00:59;29");
    expect(frameTimecode(1800, NTSC)).toBe("00:01:00;02");
    expect(frameTimecode(17_982, NTSC)).toBe("00:10:00;00");
    expect(frameTimecode(107_892, NTSC)).toBe("01:00:00;00");
    expect(frameTimecode(3600, NTSC_HIGH)).toBe("00:01:00;04");
    expect(frameTimecode(35_964, NTSC_HIGH)).toBe("00:10:00;00");
  });

  it("counts whole frames at the nominal rate for other rates", () => {
    expect(frameTimecode(24, FILM)).toBe("00:00:01:00");
    expect(frameTimecode(86_400, FILM)).toBe("01:00:00:00");
    expect(frameTimecode(49, { num: 25, den: 1 })).toBe("00:00:01:24");
  });

  it("labels clock time and ranges", () => {
    expect(clockLabel(83_999)).toBe("1:23");
    expect(clockLabel(3_723_000)).toBe("1:02:03");
    const range = {
      startFrame: 1800, endFrame: 1829, rateNum: 30000, rateDen: 1001,
      startMs: 60_060, endMs: 61_061, currentVersion: true,
    };
    expect(commentTimeLabel(range)).toBe("1:00 (00:01:00;02) to 1:01 (00:01:01;01)");
    expect(commentTimeSpoken(range)).toBe("at 1:00, range to 1:01");
    const unmeasured = {
      startFrame: null, endFrame: null, rateNum: null, rateDen: null,
      startMs: 83_500, endMs: null, currentVersion: true,
    };
    expect(commentTimeLabel(unmeasured)).toBe("1:23");
  });
});

describe("frame-accurate seeking", () => {
  const rates = [FILM, NTSC, NTSC_HIGH];
  const frames = [0, 1, 23, 24, 1799, 1800, 17_982, 107_891, 215_784];

  it("seeks to the middle of each frame and reads the same frame back", () => {
    for (const rate of rates) {
      for (const frame of frames) {
        expect(frameAtSeconds(seekSecondsForFrame(frame, rate), rate)).toBe(frame);
      }
    }
  });

  it("reads a frame start in 1 ms and 90 kHz container time bases as that frame", () => {
    for (const rate of rates) {
      for (const frame of frames) {
        const exact = (frame * rate.den) / rate.num;
        expect(frameAtPresentationTime(Math.round(exact * 1000) / 1000, rate)).toBe(frame);
        expect(frameAtPresentationTime(Math.round(exact * 90_000) / 90_000, rate)).toBe(frame);
      }
    }
  });

  it("keeps a player time just before a frame start in the frame before", () => {
    // Frame 1 at 23.976 fps starts at 0.04171 s; 0.038 s is 91% of the way through frame 0.
    expect(frameAtSeconds(0.038, FILM)).toBe(0);
    expect(frameAtSeconds((1 * FILM.den) / FILM.num - 0.001, FILM)).toBe(0);
  });
});

describe("comment frame rate", () => {
  it("uses frames only when the web copy rate equals the original rate", () => {
    const copy = (web: [number, number] | null, source: [number, number]) => ({
      ...(web ? { frameRateNumerator: web[0], frameRateDenominator: web[1] } : {}),
      sourceFrameRateNumerator: source[0], sourceFrameRateDenominator: source[1],
    });
    expect(commentFrameRate(copy([24000, 1001], [24000, 1001]))).toEqual(FILM);
    expect(commentFrameRate(copy([60000, 2002], [30000, 1001]))).toEqual({ num: 60000, den: 2002 });
    // A variable-rate phone file: the original reports 29.97 fps, the web copy came out at 25.
    expect(commentFrameRate(copy([25, 1], [30000, 1001]))).toBeNull();
    // A web copy made before its own rate was recorded.
    expect(commentFrameRate(copy(null, [30000, 1001]))).toBeNull();
    expect(commentFrameRate(undefined)).toBeNull();
  });
});
