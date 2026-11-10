import { postFunction } from "./functions";
import { invalidateVideoSearchCorpus } from "./video-search-session-cache";

export interface VideoIdentity { sourceId: string; assetId: string }
export interface ClipSettings {
  resolution: "source" | "1080p" | "720p" | "480p";
  quality: "smaller" | "balanced" | "high";
}
export function clipResolutionAvailable(resolution: ClipSettings["resolution"], width?: number, height?: number) {
  if (resolution === "source") return true;
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) && Math.min(width!, height!) >= Number.parseInt(resolution, 10);
}
export interface TranscriptSettings { languageCode: "en-US" | "es-US"; maxSpeakers: number; transcriptId?: string }
export interface TranscriptSegment { index?: number; speaker: string; startSeconds: number; endSeconds: number; text: string; words?: { startSeconds: number; endSeconds: number; text: string }[]; speakerUncertain?: boolean; overlappingSpeech?: boolean }
export interface VideoProcessingStatus {
  stage: "queued" | "preparing" | "processing" | "finalizing" | "ready" | "failed" | "needs_attention" | "expired";
  provider: "amazon-transcribe" | "aws-mediaconvert" | "local-whisper" | "elevenlabs";
  requestedBy: string | null;
  requestedByName?: string | null;
  requestedAt: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
  percentComplete: number | null;
  statusCode: string | null;
  localStage?: "downloading" | "preparing" | "transcribing" | "aligning" | "diarizing" | "finalizing" | null;
  fallbackReason?: "local_worker_unavailable" | "local_processing_failed" | "local_model_unavailable" | "local_input_failed" | null;
  estimatedAwsChargeUsd?: number | null;
}

// Standard batch recognition in AWS Ohio, checked September 15, 2026.
// https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/transcribe/current/us-east-2/index.json
export function estimateAwsTranscriptionCharge(durationSeconds: number) {
  return Number.isFinite(durationSeconds) && durationSeconds > 0 ? Math.ceil(durationSeconds) * 0.0001 : null;
}

export function transcriptionChargeLabel(amount: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(amount);
}
export interface VideoTranscript {
  id?: string;
  state: "not_requested" | "queued" | "processing" | "ready" | "failed" | "needs_reconciliation" | "cancelled" | "stale";
  languageCode?: string;
  maxSpeakers?: number;
  durationSeconds?: number;
  totalSegments?: number;
  errorCode?: string;
  editRevision?: number;
  speakerNames?: Record<string, string>;
  speakerIds?: string[];
  speakerRoles?: Record<string, string>;
  reviewedRevision?: number | null;
  reviewedBy?: string | null;
  reviewedByName?: string | null;
  reviewedAt?: string | null;
  alignment?: TranscriptAlignment;
  processing?: VideoProcessingStatus;
}
export interface TranscriptAlignment {
  state: "not_requested" | "queued" | "processing" | "partial" | "review_required" | "ready" | "unavailable" | "needs_reconciliation" | "cancelled" | "stale";
  timingBasis: "viewing-copy-elapsed";
  revision?: number;
  requestId?: string;
  eligiblePassages?: number;
  unavailablePassages?: number;
  updatedAt?: string | null;
}
export interface TranscriptRequestPolicy {
  enabled: boolean;
  localEnabled?: boolean;
  provider: "local-whisper" | "elevenlabs" | "amazon-transcribe";
  fallbackEnabled: boolean;
  paidFallbackProviders?: ("elevenlabs" | "amazon-transcribe")[];
}
export interface TranscriptResponse {
  requestPolicy?: TranscriptRequestPolicy;
  success: true;
  transcript: VideoTranscript;
  cached: boolean;
  segments?: TranscriptSegment[];
  nextCursor?: string | null;
}
export interface VideoClip {
  id: string;
  state: "queued" | "processing" | "ready" | "failed" | "expired" | "needs_reconciliation" | "cancelled" | "stale";
  inMs: number;
  outMs: number;
  durationMs: number;
  expiresAt: string | null;
  errorCode: string | null;
  sizeBytes: number | null;
  canRetry?: boolean;
  matchesCurrentFile?: boolean;
  processing?: VideoProcessingStatus;
  resolution?: ClipSettings["resolution"];
  quality?: ClipSettings["quality"];
  width?: number | null;
  height?: number | null;
}

function transcriptSelection(settings: TranscriptSettings) {
  return settings.transcriptId ? { transcriptId: settings.transcriptId } : { languageCode: settings.languageCode, maxSpeakers: settings.maxSpeakers };
}
export async function getVideoTranscript(token: string, identity: VideoIdentity, settings: TranscriptSettings, cursor?: string) {
  const response = await postFunction<{ success: true; transcript: VideoTranscript & { segments?: TranscriptSegment[]; nextCursor?: string | null }; cached: boolean; requestPolicy?: TranscriptRequestPolicy }>("cmsGetVideoTranscript", token, { ...identity, ...transcriptSelection(settings), cursor }, {}, { appCheck: "unless-automation" });
  return { ...response, segments: response.transcript.segments, nextCursor: response.transcript.nextCursor };
}
export type TranscriptEdits = {
  revision: number;
  segments: { index: number; text?: string; speaker?: string }[];
  speakerNames?: Record<string, string>;
  speakerRoles?: Record<string, string>;
  reviewed?: never;
} | { revision: number; reviewed: true; segments?: never; speakerNames?: never; speakerRoles?: never };
export async function saveVideoTranscript(token: string, identity: VideoIdentity, settings: TranscriptSettings, edits: TranscriptEdits): Promise<TranscriptResponse> {
  const response = await postFunction<{ success: true; transcript: VideoTranscript & { segments?: TranscriptSegment[]; nextCursor?: string | null }; cached: boolean }>("cmsSaveVideoTranscript", token, { ...identity, ...transcriptSelection(settings), ...edits }, {}, { appCheck: true });
  invalidateVideoSearchCorpus(identity.sourceId);
  return { ...response, segments: response.transcript.segments, nextCursor: response.transcript.nextCursor };
}
export function requestVideoTranscript(token: string, identity: VideoIdentity, settings: TranscriptSettings, attempt?: { provider: "local" | "amazon-transcribe"; newAttemptOf: string; attemptKey?: string }) {
  return postFunction<TranscriptResponse>("cmsRequestVideoTranscript", token, { ...identity, languageCode: settings.languageCode, maxSpeakers: settings.maxSpeakers, ...attempt }, {}, { appCheck: true });
}
type TranscriptAlignmentResponse = { success: true; alignment: TranscriptAlignment; cached: boolean };
export function requestVideoTranscriptAlignment(token: string, identity: VideoIdentity, transcriptId: string,
  revision: number, retry = false) {
  return postFunction<TranscriptAlignmentResponse>("cmsRequestVideoTranscriptAlignment", token,
    { ...identity, transcriptId, revision, ...(retry ? { retry: true } : {}) }, {}, { appCheck: true });
}
export function cancelVideoTranscriptAlignment(token: string, identity: VideoIdentity, transcriptId: string,
  revision: number, requestId: string) {
  return postFunction<TranscriptAlignmentResponse>("cmsCancelVideoTranscriptAlignment", token,
    { ...identity, transcriptId, revision, requestId }, {}, { appCheck: true });
}
export type VideoOrientation = "vertical" | "horizontal";
export interface VideoOrientationExport {
  id: string; orientation: VideoOrientation;
  state: "queued" | "processing" | "finishing_upload" | "complete" | "failed" | "stale" | "needs_reconciliation";
  outputAssetId: string | null; errorCode: string | null; requestedAt: string; updatedAt: string;
}
export function requestVideoOrientationExport(token: string, identity: VideoIdentity, orientation: VideoOrientation) {
  return postFunction<{ success: true; export: VideoOrientationExport; cached: boolean }>("cmsRequestVideoOrientationExport", token,
    { ...identity, orientation }, {}, { appCheck: true });
}
export function listVideoOrientationExports(token: string, identity: VideoIdentity) {
  return postFunction<{ success: true; exports: VideoOrientationExport[]; workerReady: boolean }>("cmsListVideoOrientationExports", token,
    identity, {}, { appCheck: true });
}
export type TranscriptDownloadFormat = "txt" | "vtt" | "srt" | "tsv" | "avid" | "premiere";
export const avidFrameRates = ["24000/1001", "24/1", "25/1", "30000/1001", "30/1", "50/1", "60000/1001", "60/1"] as const;
export type AvidFrameRate = typeof avidFrameRates[number];
export interface AvidTranscriptOptions { frameRate: AvidFrameRate; frameOffset: number }
export function readVideoTranscript(token: string, identity: VideoIdentity, settings: TranscriptSettings, format: TranscriptDownloadFormat, avid?: AvidTranscriptOptions) {
  return postFunction<{ success: true; url: string; expiresAt: string }>("cmsCreateVideoTranscriptRead", token, { ...identity, ...transcriptSelection(settings), format, ...(format === "avid" ? avid : {}) }, {}, { appCheck: true });
}
export type ClipTranscriptFormat = "txt" | "vtt" | "srt" | "tsv";
export function readClipTranscript(token: string, identity: VideoIdentity, settings: TranscriptSettings, clipId: string, format: ClipTranscriptFormat) {
  return postFunction<{ success: true; filename: string; contentType: string; body: string; clipId: string; inMs: number; outMs: number; transcriptId: string; revision: number; timingBasis: "clip-elapsed" }>(
    "cmsCreateVideoTranscriptRead", token, { ...identity, ...transcriptSelection(settings), clipId, format }, {}, { appCheck: true });
}
export function requestVideoClip(token: string, identity: VideoIdentity, inMs: number, outMs: number, retry = false, settings: ClipSettings = { resolution: "source", quality: "balanced" }) {
  return postFunction<{ success: true; clip: VideoClip }>("cmsRequestVideoClip", token, { ...identity, inMs, outMs, retry, ...settings }, {}, { appCheck: true });
}
export function getVideoClip(token: string, identity: VideoIdentity, clipId: string) {
  return postFunction<{ success: true; clip: VideoClip }>("cmsGetVideoClip", token, { ...identity, clipId }, {}, { appCheck: true });
}
export function listVideoClips(token: string, identity: VideoIdentity, cursor?: string) {
  return postFunction<{ success: true; clips: VideoClip[]; nextCursor?: string | null }>("cmsGetVideoClip", token, { ...identity, ...(cursor ? { cursor } : {}) }, {}, { appCheck: true });
}
export function readVideoClip(token: string, identity: VideoIdentity, clipId: string) {
  return postFunction<{ success: true; access: { url: string; expiresAt: string } }>("cmsCreateVideoClipRead", token, { ...identity, clipId }, {}, { appCheck: true });
}

export function videoTime(seconds: number) {
  const milliseconds = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor(milliseconds / 60_000) % 60;
  const remainder = ((milliseconds % 60_000) / 1000).toFixed(3).padStart(6, "0");
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${remainder}`;
}

export function parseVideoTime(value: string): number | null {
  // Accept decimal seconds or hours:minutes:seconds, to millisecond precision.
  if (/^\d+(?:\.\d{1,3})?$/.test(value.trim())) {
    const milliseconds = Math.round(Number(value) * 1000);
    return Number.isSafeInteger(milliseconds) ? milliseconds : null;
  }
  const match = /^(\d+):([0-5]\d):([0-5]\d(?:\.\d{1,3})?)$/.exec(value.trim());
  if (!match) return null;
  const milliseconds = Math.round((Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000);
  return Number.isSafeInteger(milliseconds) ? milliseconds : null;
}
