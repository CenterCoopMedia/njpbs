import type { TranscriptSegment } from "./video-production";

export const TRANSCRIPT_PAGE_SIZE = 50;
export const passageId = (segment: TranscriptSegment, position: number) => segment.index ?? position;
export const speakerLabel = (id: string) => id === "unknown" ? "Unknown speaker" : id.replace(/^spk_(\d+)$/, (_, number: string) => `Speaker ${Number(number) + 1}`);

/** Reading timestamp only; exact source milliseconds stay in details and seek handlers. */
export function passageTimestamp(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor(whole / 60) % 60;
  return `${hours ? `${hours}:` : ""}${String(minutes).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
}

export function matchingPassages(segments: TranscriptSegment[], query: string, speaker: string, names: Record<string, string>, roles: Record<string, string>) {
  const needle = query.trim().toLocaleLowerCase();
  return segments.map((segment, position) => ({ segment, position, id: passageId(segment, position) }))
    .filter(({ segment }) => (!speaker || segment.speaker === speaker) && (!needle ||
      [segment.text, speakerLabel(segment.speaker), segment.speaker === "unknown" ? "" : names[segment.speaker], segment.speaker === "unknown" ? "" : roles[segment.speaker]]
        .filter(Boolean).join(" ").toLocaleLowerCase().includes(needle)));
}

/** Shift selection follows the current filtered order, including other result pages. */
export function togglePassageSelection(selected: Set<number>, id: number, checked: boolean, order: number[], anchor: number | null, extend: boolean) {
  const next = new Set(selected);
  const first = anchor === null ? -1 : order.indexOf(anchor);
  const last = order.indexOf(id);
  const ids = extend && first >= 0 && last >= 0 ? order.slice(Math.min(first, last), Math.max(first, last) + 1) : [id];
  for (const entry of ids) { if (checked) next.add(entry); else next.delete(entry); }
  return next;
}

/** The existing export contract is one continuous span, never a concatenated montage. */
export function selectedPassageRange(segments: TranscriptSegment[], selected: Set<number>): TranscriptSegment | null {
  const chosen = segments.filter((segment, position) => selected.has(passageId(segment, position)));
  if (!chosen.length || chosen.some(segment => !Number.isFinite(segment.startSeconds) || !Number.isFinite(segment.endSeconds) ||
      segment.startSeconds < 0 || segment.endSeconds <= segment.startSeconds)) return null;
  let startSeconds = Infinity;
  let endSeconds = -Infinity;
  for (const segment of chosen) {
    startSeconds = Math.min(startSeconds, segment.startSeconds);
    endSeconds = Math.max(endSeconds, segment.endSeconds);
  }
  const start = Math.round(startSeconds * 1000);
  const end = Math.round(endSeconds * 1000);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end - start < 250 || end - start > 1_800_000) return null;
  return { speaker: "unknown", text: "", startSeconds: start / 1000, endSeconds: end / 1000 };
}

/** Accept elapsed seconds, m:ss, or h:mm:ss, without interpreting invalid minutes. */
export function parseTranscriptPosition(value: string): number | null {
  const text = value.trim();
  let seconds: number;
  if (/^\d+(?:\.\d{1,3})?$/.test(text)) seconds = Number(text);
  else {
    const match = /^(?:(\d+):)?(\d+):([0-5]\d(?:\.\d{1,3})?)$/.exec(text);
    if (!match || (match[1] !== undefined && Number(match[2]) > 59)) return null;
    seconds = Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  }
  return Number.isSafeInteger(Math.round(seconds * 1000)) ? seconds : null;
}

/** A timestamp in a pause navigates to the next loaded passage, without seeking media. */
export function passageAtPosition(segments: TranscriptSegment[], seconds: number): number {
  if (!Number.isFinite(seconds) || seconds < 0) return -1;
  const containing = segments.findIndex(segment => segment.startSeconds <= seconds && seconds < segment.endSeconds);
  if (containing >= 0) return containing;
  return segments.findIndex(segment => segment.startSeconds >= seconds);
}
