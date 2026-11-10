"use strict";

const { alignedWords } = require("./video-transcript-nle");
const { SourceMediaValidationError } = require("./source-media-contract");

const LINE_LENGTH = 42;
const MAX_DURATION_MS = 7000;
const PAUSE_MS = 1000;
const normalize = (text) => text.trim().replace(/\s+/g, " ");

// Wrap on word boundaries. Keep an unusually long name or URL intact on its own line.
function captionLines(words) {
  const text = words.join(" ");
  if (words.length === 1 || text.length <= LINE_LENGTH) return text;
  let split = -1;
  let bestScore = Infinity;
  for (let index = 1; index < words.length; index++) {
    const first = words.slice(0, index).join(" ");
    const second = words.slice(index).join(" ");
    if (first.length > LINE_LENGTH || second.length > LINE_LENGTH) continue;
    const score = Math.abs(first.length - second.length) - (/[,;:.!?]["')]*$/.test(first) ? 8 : 0);
    if (score < bestScore) { split = index; bestScore = score; }
  }
  return split === -1 ? null : words.slice(0, split).join(" ") + "\n" + words.slice(split).join(" ");
}

// Text edits and older providers may have no matching word alignment. Estimate only
// the caption times within that saved passage; never change its text or stored timing.
function estimatedWords(text, startMs, endMs) {
  const tokens = normalize(text).split(" ");
  const total = tokens.reduce((sum, token) => sum + token.length + 1, 0);
  let used = 0;
  return tokens.map((token) => {
    const start = startMs + Math.round((endMs - startMs) * used / total);
    used += token.length + 1;
    return { text: token, startMs: start, endMs: startMs + Math.round((endMs - startMs) * used / total) };
  });
}

function captionWords(segment, startMs, endMs) {
  if (alignedWords(segment)) {
    const words = segment.words.flatMap((word) => estimatedWords(word.text,
      Math.max(startMs, Math.round(word.startSeconds * 1000)), Math.min(endMs, Math.round(word.endSeconds * 1000))));
    // Identical/rounded word starts cannot support separate non-overlapping cues.
    if (words.every((word, index) => word.endMs > word.startMs && (index === 0 || word.startMs > words[index - 1].startMs))) return words;
  }
  return estimatedWords(segment.text, startMs, endMs);
}

function passageCues(segment) {
  if (typeof segment.text !== "string" || !Number.isFinite(segment.startSeconds) ||
      !Number.isFinite(segment.endSeconds) || segment.startSeconds < 0 || segment.endSeconds < segment.startSeconds) {
    throw new SourceMediaValidationError("Transcript has invalid caption timing", 409);
  }
  if (!normalize(segment.text) || segment.endSeconds === segment.startSeconds) return [];
  let startMs = Math.round(segment.startSeconds * 1000);
  let endMs = Math.round(segment.endSeconds * 1000);
  // Round outward only when a positive passage collapses at caption precision.
  if (endMs === startMs) {
    startMs = Math.floor(segment.startSeconds * 1000);
    endMs = Math.ceil(segment.endSeconds * 1000);
  }
  const words = captionWords(segment, startMs, endMs);
  const cues = [];
  let first = 0;
  while (first < words.length) {
    let last = first;
    let text = words[first].text;
    while (last + 1 < words.length) {
      if (/[.!?]["')]*$/.test(words[last].text) && words[last].endMs - words[first].startMs >= 1000) break;
      const next = words[last + 1];
      if (next.startMs - words[last].endMs >= PAUSE_MS || next.endMs - words[first].startMs > MAX_DURATION_MS) break;
      const wrapped = captionLines(words.slice(first, last + 2).map((word) => word.text));
      if (wrapped === null) break;
      text = wrapped;
      last++;
    }
    const cueEnd = Math.min(endMs, words[last].endMs, words[first].startMs + MAX_DURATION_MS,
      words[last + 1]?.startMs ?? endMs);
    // Tiny provider passages can have more cues than milliseconds. Share the
    // collapsed interval rather than lose words or prevent saving the transcript.
    const cueStart = Math.min(words[first].startMs, endMs - 1);
    cues.push({ speaker: segment.speaker, startSeconds: cueStart / 1000,
      endSeconds: Math.max(cueStart + 1, cueEnd) / 1000, text });
    first = last + 1;
  }
  return cues;
}

function captionCues(segments) {
  // Overlapping speaker passages must still serialize in chronological order.
  return segments.flatMap(passageCues).sort((first, second) => first.startSeconds - second.startSeconds);
}

module.exports = { captionCues };
