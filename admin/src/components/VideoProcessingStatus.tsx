import { Fragment, useEffect, useState } from "react";
import { StatusBadge } from "./ui/Primitives";
import type { VideoProcessingStatus as ProcessingDetails } from "../lib/video-production";
import { transcriptionChargeLabel } from "../lib/video-production";
import "./VideoProcessingStatus.css";

const stages = {
  queued: { label: "Queued", detail: "The request is saved and waiting to start." },
  preparing: { label: "Preparing", detail: "The service is preparing the input." },
  processing: { label: "Processing", detail: "The service is processing the request." },
  finalizing: { label: "Finalizing", detail: "The service is checking and saving the result." },
  ready: { label: "Ready", detail: "The saved result is available." },
  failed: { label: "Failed", detail: "Processing stopped. A new run does not start automatically." },
  needs_attention: { label: "Needs attention", detail: "The outcome needs an administrator's check. No new run starts automatically." },
  expired: { label: "Expired", detail: "This export is no longer available. Select the range and export it again." },
};

const statusHelp: Record<string, string> = {
  byok_admission_invalid: "The request stopped before provider submission because access, source, key or quota checks failed. No transcription request was sent to ElevenLabs.",
  byok_preparation_failed: "The input or key could not be prepared after repeated attempts. No transcription request was sent to ElevenLabs.",
  elevenlabs_request_rejected: "ElevenLabs rejected this request. Check the provider account for any charge before submitting another request.",
  elevenlabs_submission_uncertain: "ElevenLabs may have accepted and charged for this request. An administrator must check the saved result and provider account. The request will not be submitted again automatically.",
  byok_spool_missing: "The saved transcript result is missing. An administrator must check the original request and provider account before trying again. The request will not be submitted again automatically.",
  byok_spool_invalid: "The saved transcript result could not be verified. An administrator must check the original request and provider account before trying again. The request will not be submitted again automatically.",
  local_audio_preparation_failed: "The service could not prepare this video’s audio after three tries. Ask a CMS administrator to check the video.",
  paid_budget_unavailable: "Paid transcription is waiting for the paid allowance or another paid request to finish. Daily limits reset at midnight UTC.",
  billing_unavailable: "Processing cannot start while billing is unavailable. Ask a CMS administrator to check billing.",
  transcription_failed: "The transcription service could not complete this request. Ask a CMS administrator to check the reference below.",
  original_archived: "The original is archived. Select Restore original in the video details, wait for it to finish, then retry this export. Standard retrieval can take up to 12 hours. If Restore original is not available, ask a person who manages video.",
  original_check_failed: "The original could not be checked. This export will retry. You can cancel it and try again later. Ask a CMS administrator for help if it stays queued.",
  conversion_failed: "The conversion service could not complete this export. Retry only when a retry button is available.",
  editor_video_unsupported: "This source does not meet the selected editor format's video requirements. XDCAM MXF accepts 1080p at 23.976, 25 or 29.97 fps, 1080i at 25 or 29.97 fps, or 720p at 23.976, 25, 29.97, 50 or 59.94 fps. A retry cannot fix an XDCAM input rejection. For an earlier ProRes or Avid failure, the saved error does not identify which check failed. Use Retry export when available. A retry uses the corrected format checks but can still fail for an unsupported video track or duration. Choose another format or download the original.",
  editor_video_track_unsupported: "Editor exports need exactly one video track. Download the original or choose a source with one video track.",
  editor_duration_unsupported: "Editor exports need a known video duration greater than zero and no longer than 24 hours. Download the original or choose a shorter source.",
  prores_video_unsupported: "ProRes MOV needs even width and height values from 32 through 4096 pixels. Supported frame rates are 23.976, 24, 25, 29.97, 30, 50, 59.94 and 60 fps. A retry cannot succeed with these settings. Download the original or an MP4 copy.",
  avid_video_unsupported: "Avid DNxHD needs 1920 x 1080 or 1280 x 720 progressive video at 23.976, 24, 25, 29.97, 30, 50, 59.94 or 60 fps. Interlaced video needs 1920 x 1080 at 25, 29.97 or 30 fps. Choose ProRes for other sizes, or download the original.",
  editor_audio_unsupported: "The audio layout of this source cannot be used for this editor format. Each audio track must have 1 to 8 channels. XDCAM MXF needs 2, 4 or 8 channels in total. ProRes MOV and Avid MXF accept up to 8. A retry cannot succeed. Try another editor format or download the original.",
  export_source_mismatch: "The original video is shorter than the selected range. A retry cannot succeed. Select a range inside the original, or ask a CMS administrator to check the original.",
  source_unavailable: "The source video is no longer available for this request. Reopen the video library to check its current state.",
  processing_timeout: "Processing exceeded its time limit. Ask a CMS administrator to check the existing request before starting another.",
  processing_failed: "The service could not process the request. Ask a CMS administrator to check the reference below.",
  processing_unconfirmed: "The processing result could not be confirmed. Check the saved status or ask a CMS administrator for help.",
  start_not_confirmed: "The provider start could not be confirmed. Check the saved status or ask a CMS administrator for help.",
};

const localStages = {
  downloading: "Downloading the private web copy to Local worker.",
  preparing: "Preparing the audio on Local worker.",
  transcribing: "Whisper is transcribing the audio on Local worker.",
  aligning: "Matching transcript words to recording timestamps.",
  diarizing: "Separating speakers in the recording.",
  finalizing: "Saving and checking the transcript result.",
};
const fallbackReasons = {
  local_worker_unavailable: "Local worker was unavailable.",
  local_processing_failed: "Local worker could not complete processing.",
  local_model_unavailable: "The transcription model on Local worker was unavailable.",
  local_input_failed: "Local worker could not prepare the input.",
};
const providers = { "elevenlabs": "ElevenLabs · Scribe v2", "amazon-transcribe": "Amazon Transcribe", "aws-mediaconvert": "AWS MediaConvert", "local-whisper": "Local worker · Whisper" };

function timestamp(value?: string | number | null) {
  if (value === null || value === undefined) return null;
  const time = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function dateLabel(value?: string | number | null) {
  const time = timestamp(value);
  return time === null ? null : `${new Date(time).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" })} ET`;
}

function elapsedLabel(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  return `${hours > 0 ? `${hours}h ` : ""}${minutes}m ${seconds % 60}s`;
}

export function VideoProcessingStatus({ kind, state, processing, checkedAt, reference }: {
  kind: "Transcript" | "Clip" | "Export";
  state: string;
  processing?: ProcessingDetails;
  checkedAt?: number;
  reference?: string;
}) {
  const fallback = Object.hasOwn(stages, state) ? state as keyof typeof stages : "needs_attention";
  const stage = processing?.stage && Object.hasOwn(stages, processing.stage) ? processing.stage : fallback;
  const active = ["queued", "preparing", "processing", "finalizing"].includes(stage);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  const requestedAt = timestamp(processing?.requestedAt);
  const completedAt = timestamp(processing?.completedAt);
  const elapsedEnd = active ? now : completedAt;
  const elapsed = requestedAt !== null && elapsedEnd !== null ? elapsedLabel(elapsedEnd - requestedAt) : null;
  const percent = processing?.percentComplete;
  const hasPercent = typeof percent === "number" && Number.isFinite(percent) && percent >= 0 && percent <= 100;
  const provider = processing?.provider && Object.hasOwn(providers, processing.provider) ? providers[processing.provider] : null;
  const localStage = processing?.provider === "local-whisper" && active && processing.localStage && Object.hasOwn(localStages, processing.localStage) ? localStages[processing.localStage] : null;
  const fallbackReason = processing?.fallbackReason && Object.hasOwn(fallbackReasons, processing.fallbackReason) ? fallbackReasons[processing.fallbackReason] : null;
  const awsEstimate = processing?.estimatedAwsChargeUsd;
  const hasEstimate = (kind === "Transcript" || kind === "Export") && typeof awsEstimate === "number" && Number.isFinite(awsEstimate) && awsEstimate >= 0;
  const localTranscript = kind === "Transcript" && processing?.provider === "local-whisper";
  const stageDetail = localTranscript && stage === "queued" ? "Queued, waiting for earlier requests" : stages[stage].detail;
  const facts = [
    ["Provider", provider],
    [processing?.requestedByName ? "Requested by" : "Requester account", processing?.requestedByName || processing?.requestedBy],
    ["Requested", dateLabel(processing?.requestedAt)],
    [`Elapsed${active ? " since request" : " total"}`, elapsed],
    ["Last updated", dateLabel(processing?.updatedAt)],
    ["Last checked", dateLabel(checkedAt)],
  ].filter(([, value]) => value);
  const tone = stage === "ready" ? "success" : stage === "failed" ? "failed" : active ? "pending" : "unknown";
  const safeReference = reference && /^[a-zA-Z0-9_-]{1,128}$/.test(reference) ? reference : null;
  const help = processing?.statusCode && Object.hasOwn(statusHelp, processing.statusCode) ? statusHelp[processing.statusCode] : undefined;

  return <section className="video-processing-status" aria-label={`${kind} processing status`}>
    <div role="status" aria-atomic="true">
      <StatusBadge tone={tone}>{stages[stage].label}</StatusBadge>
      <p>{localStage ?? stageDetail}</p>
      {fallbackReason ? <p>{fallbackReason} {processing?.provider === "amazon-transcribe" ? "This request is using the Amazon Transcribe fallback." : "Automatic fallback is not active for this request. Ask a CMS administrator for help."}</p> : null}
      {help ? <p>{help}</p> : null}
    </div>
    {active ? <>
      {hasPercent ? <label className="video-processing-progress">Provider progress: {Math.round(percent)}%<progress max={100} value={percent} aria-label={`${kind} provider progress`} /></label> : <p className="video-processing-note">The provider does not report a percentage or finish time.</p>}
      <p className="video-processing-note">You can close this window and return later.</p>
    </> : null}
    {facts.length > 0 ? <dl className="video-processing-facts">
      {facts.map(([label, value]) => <Fragment key={label}><dt>{label}</dt><dd>{value}</dd></Fragment>)}
      {hasEstimate && !localTranscript ? <><dt>AWS estimate</dt><dd>{transcriptionChargeLabel(awsEstimate)} estimated</dd></> : null}
    </dl> : null}
    {hasEstimate && localTranscript ? <details><summary>Paid backup details</summary>
      <p>Possible AWS charge: {transcriptionChargeLabel(awsEstimate)} if fallback is used. The estimate covers recognition only. Other charges can apply.</p>
    </details> : null}
    {hasEstimate && !localTranscript ? <p className="video-processing-note">{kind === "Export"
      ? "AWS estimate covers this attempt's conversion, 14 days of storage for the export and 28 days for the staged original, including the retained earlier version. It stays after the export expires. Earlier attempts, requests, function execution and credits are excluded."
      : "AWS estimate covers recognition only. Other charges can apply."}</p> : null}
    {stage === "failed" || stage === "needs_attention" || help ? <p className="video-processing-note">{safeReference ? <>Reference for your CMS administrator: <span className="video-processing-reference">{safeReference}</span></> : "Ask a CMS administrator for help."}</p> : null}
  </section>;
}
