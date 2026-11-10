"use strict";

const { CLIP_JOBS, sameClipSource, problem } = require("./video-clip-contract");
const { parseSourceMediaAsset } = require("./source-media-contract");
const { objectKeyWithinSource } = require("./media-sources");
const { alignedWords } = require("./video-transcript-nle");
const { transcriptExports, transcriptLog, transcriptSrt } = require("./video-transcript-contract");

async function readTranscriptClip(firestore, source, request, now = Date.now()) {
  const [assetSnapshot, clipSnapshot] = await Promise.all([
    firestore.collection("mediaSourceAssets").doc(request.assetId).get(),
    firestore.collection(CLIP_JOBS).doc(request.clipId).get(),
  ]);
  const asset = assetSnapshot.exists ? parseSourceMediaAsset(assetSnapshot.id, assetSnapshot.data()) : null;
  const clip = clipSnapshot.data();
  if (!asset || asset.sourceId !== source.id || !objectKeyWithinSource(source, asset.objectKey) ||
      !clip || !sameClipSource(asset, clip)) throw problem(404, "Clip is no longer available");
  if (clip.phase !== "ready" || !Number.isFinite(Date.parse(clip.expiresAt)) || Date.parse(clip.expiresAt) <= now) {
    throw problem(409, "Choose a ready clip that has not expired");
  }
  return { asset, clip };
}

function clipStartSeconds(clip) {
  if (clip.inMs === 0) return 0;
  const recordedStart = clip.output?.sourceStartSeconds;
  const sourceFrame = clip.output?.sourceFrameDurationSeconds;
  if (Number.isFinite(recordedStart) && Number.isFinite(sourceFrame) && sourceFrame > 0 && sourceFrame <= 1 &&
      recordedStart >= 0 && recordedStart <= clip.inMs / 1000 && clip.inMs / 1000 - recordedStart < sourceFrame + 1e-7) return recordedStart;
  const frame = clip.output?.frameDurationSeconds;
  if (!Number.isFinite(frame) || frame < 1 / 60 || frame > 1) {
    throw problem(409, "Re-export this clip to record its frame timing before downloading its transcript");
  }
  // Existing MP4 exports retain the input frame rate and round the start outward.
  return Math.floor(clip.inMs / 1000 / frame + 1e-7) * frame;
}

function clipTranscriptSegments(segments, clip) {
  const start = clip.inMs / 1000;
  const end = clip.outMs / 1000;
  if (!Number.isSafeInteger(clip.inMs) || !Number.isSafeInteger(clip.outMs) || start < 0 || end <= start) {
    throw problem(409, "Clip timing is invalid");
  }
  const origin = clipStartSeconds(clip);
  const shifted = [];
  for (const segment of segments) {
    if (!Number.isFinite(segment.startSeconds) || !Number.isFinite(segment.endSeconds) ||
        segment.startSeconds < 0 || segment.endSeconds < segment.startSeconds) {
      throw problem(409, "Transcript has invalid passage timing");
    }
    // Provider output can contain zero-duration words; they carry no caption interval.
    if (segment.endSeconds === segment.startSeconds || segment.endSeconds <= start || segment.startSeconds >= end) continue;
    if (typeof segment.text !== "string") throw problem(409, "Transcript has invalid passage timing");
    let selected = segment;
    if (segment.startSeconds < start || segment.endSeconds > end) {
      if (!alignedWords(segment)) {
        throw problem(409, "Align the edited transcript or move the clip boundary to a passage boundary before exporting its transcript");
      }
      const words = segment.words.filter(word => word.endSeconds > start && word.startSeconds < end);
      if (!words.length) continue;
      selected = { ...segment, words, text: words.map(word => word.text.trim()).join(" "),
        startSeconds: words[0].startSeconds, endSeconds: words.at(-1).endSeconds };
    }
    shifted.push({ ...selected,
      startSeconds: Math.max(start, selected.startSeconds) - origin,
      endSeconds: Math.min(end, selected.endSeconds) - origin,
      ...(selected.words ? { words: selected.words.map((word) => ({ ...word,
        startSeconds: Math.max(start, word.startSeconds) - origin,
        endSeconds: Math.min(end, word.endSeconds) - origin,
      })) } : {}),
    });
  }
  return shifted;
}

function clipTranscriptExport(segments, job, clip, asset, format) {
  if (!["txt", "vtt", "srt", "tsv"].includes(format)) throw problem(400, "Clip transcript format is invalid");
  if (!Number.isFinite(job.durationSeconds) || job.durationSeconds <= 0 || clip.outMs > Math.ceil(job.durationSeconds * 1000)) throw problem(409, "Clip exceeds transcript audio duration");
  const selected = clipTranscriptSegments(segments, clip);
  const body = format === "tsv"
    ? transcriptLog(selected, job, { title: asset.name || asset.originalName || asset.objectKey.split("/").at(-1), assetId: asset.id, sourceVersion: asset.objectVersionId, timingBasis: "clip-elapsed" })
    : format === "srt" ? transcriptSrt(selected) : transcriptExports(selected, job.speakerNames)[format];
  if (Buffer.byteLength(body, "utf8") > 1024 * 1024) throw problem(413, "Clip transcript is too large to download");
  return { filename: `clip-${clip.id}.${format}`, contentType: format === "vtt" ? "text/vtt; charset=utf-8" : format === "srt" ? "application/x-subrip; charset=utf-8"
    : format === "tsv" ? "text/tab-separated-values; charset=utf-8" : "text/plain; charset=utf-8",
  body, clipId: clip.id, inMs: clip.inMs, outMs: clip.outMs, transcriptId: job.id,
  revision: job.editRevision ?? 0, timingBasis: "clip-elapsed" };
}

module.exports = { readTranscriptClip, clipTranscriptSegments, clipTranscriptExport };
