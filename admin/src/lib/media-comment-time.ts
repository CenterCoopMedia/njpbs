import type { SourceFrameRate } from "./video-frame-rate";
import type { MediaCommentTime, MediaCommentTimeInput } from "./media-feedback";

/** A source frame rate as an exact fraction; 29.97 fps is 30000/1001. */
export interface FrameRate {
  num: number;
  den: number;
}

/** A ready web copy: its own measured rate and the original's rate. */
export interface WebCopyFrameRates extends SourceFrameRate {
  frameRateNumerator?: number | null;
  frameRateDenominator?: number | null;
}

/**
 * Frames count only when the web copy's rate equals the original's, as on the server. A
 * variable-rate original can give a web copy with another rate; those comments use milliseconds.
 */
export function commentFrameRate(copy?: WebCopyFrameRates): FrameRate | null {
  const values = [copy?.frameRateNumerator, copy?.frameRateDenominator,
    copy?.sourceFrameRateNumerator, copy?.sourceFrameRateDenominator];
  if (!values.every(value => Number.isSafeInteger(value) && value! > 0)) return null;
  const [num, den, sourceNum, sourceDen] = values as number[];
  return num * sourceDen === den * sourceNum ? { num, den } : null;
}

/**
 * The frame for a presentation time that the player reported for a painted frame. Container
 * time bases can put a frame start a little before its exact value (a 1 ms time base is 2.4% of
 * a frame early at 59.94 fps), so a time up to 10% of a frame early still counts as that frame.
 */
export function frameAtPresentationTime(seconds: number, rate: FrameRate): number {
  return Math.max(0, Math.floor((seconds * rate.num) / rate.den + 0.1));
}

/**
 * The frame that contains a point on the continuous timeline, such as the player's current
 * time after a seek. Only floating-point error is allowed for; a time just before a frame start
 * is still in the frame before.
 */
export function frameAtSeconds(seconds: number, rate: FrameRate): number {
  return Math.max(0, Math.floor((seconds * rate.num) / rate.den + 1e-6));
}

/** Seek to the middle of a frame so rounding in the player cannot land on its neighbor. */
export function seekSecondsForFrame(frame: number, rate: FrameRate): number {
  return ((frame + 0.5) * rate.den) / rate.num;
}

export function frameStartMs(frame: number, rate: FrameRate): number {
  return Math.floor((frame * rate.den * 1000) / rate.num);
}

function isDropFrame(rate: FrameRate): boolean {
  return rate.num * 1001 === rate.den * 30000 || rate.num * 1001 === rate.den * 60000;
}

const two = (value: number) => String(value).padStart(2, "0");

/**
 * SMPTE timecode counted from the first frame of the file. 29.97 and 59.94 fps use drop-frame
 * numbering (";" before the frames); other rates count whole frames at the nominal rate.
 */
export function frameTimecode(frame: number, rate: FrameRate): string {
  const nominal = Math.round(rate.num / rate.den);
  const drop = isDropFrame(rate) ? nominal / 15 : 0;
  let count = frame;
  if (drop) {
    const perTenMinutes = nominal * 600 - drop * 9;
    const perMinute = nominal * 60 - drop;
    const tens = Math.floor(count / perTenMinutes);
    const rest = count % perTenMinutes;
    count += drop * 9 * tens + (rest > drop ? drop * Math.floor((rest - drop) / perMinute) : 0);
  }
  const frames = count % nominal;
  const seconds = Math.floor(count / nominal);
  return `${two(Math.floor(seconds / 3600))}:${two(Math.floor(seconds / 60) % 60)}:${two(seconds % 60)}${drop ? ";" : ":"}${two(frames)}`;
}

/** Minutes and seconds, such as 1:23 or 1:02:03. */
export function clockLabel(ms: number): string {
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  return hours ? `${hours}:${two(minutes)}:${two(total % 60)}` : `${minutes}:${two(total % 60)}`;
}

function rangeEndMs(time: MediaCommentTime): number | null {
  if (time.endFrame !== null && time.rateNum !== null && time.rateDen !== null) {
    return frameStartMs(time.endFrame, { num: time.rateNum, den: time.rateDen });
  }
  return time.endMs;
}

function timePoint(ms: number, frame: number | null, time: MediaCommentTime): string {
  return frame !== null && time.rateNum !== null && time.rateDen !== null
    ? `${clockLabel(ms)} (${frameTimecode(frame, { num: time.rateNum, den: time.rateDen })})`
    : clockLabel(ms);
}

/** Visible label, such as "1:00 (00:01:00;02) to 1:01 (00:01:00;31)". */
export function commentTimeLabel(time: MediaCommentTime): string {
  const start = timePoint(time.startMs, time.startFrame, time);
  const end = rangeEndMs(time);
  return end === null ? start : `${start} to ${timePoint(end, time.endFrame, time)}`;
}

/** Short spoken label, such as "at 1:23, range to 1:30". */
export function commentTimeSpoken(time: MediaCommentTime): string {
  const end = rangeEndMs(time);
  return `at ${clockLabel(time.startMs)}${end === null ? "" : `, range to ${clockLabel(end)}`}`;
}

/** An unsaved comment time: whole frames when the video has a frame rate, else milliseconds. */
export interface CommentTimeDraft {
  start: number;
  end: number | null;
}

export function draftCommentTime(draft: CommentTimeDraft, rate: FrameRate | null): MediaCommentTime {
  return rate
    ? {
        startFrame: draft.start, endFrame: draft.end, rateNum: rate.num, rateDen: rate.den,
        startMs: frameStartMs(draft.start, rate),
        endMs: draft.end === null ? null : frameStartMs(draft.end + 1, rate),
        currentVersion: true,
      }
    : {
        startFrame: null, endFrame: null, rateNum: null, rateDen: null,
        startMs: draft.start, endMs: draft.end, currentVersion: true,
      };
}

/** `fileVersion` names the file the time was picked on, so the server can refuse a replaced file. */
export function draftCommentInput(
  draft: CommentTimeDraft, rate: FrameRate | null, fileVersion: string,
): MediaCommentTimeInput {
  const end = draft.end === null ? {} : rate ? { endFrame: draft.end } : { endMs: draft.end };
  return rate ? { startFrame: draft.start, ...end, fileVersion } : { startMs: draft.start, ...end, fileVersion };
}
