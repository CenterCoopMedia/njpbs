import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VideoProcessingStatus } from "../src/components/VideoProcessingStatus";
import type { VideoProcessingStatus as ProcessingDetails } from "../src/lib/video-production";

const details: ProcessingDetails = {
  stage: "queued", provider: "amazon-transcribe", requestedBy: "staff-123", requestedByName: "Sam Editor",
  requestedAt: "2026-09-15T16:00:00Z", startedAt: null,
  updatedAt: "2026-09-15T16:00:00Z", completedAt: null,
  percentComplete: null, statusCode: null,
};

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("video processing evidence", () => {
  it("keeps queued work queued as elapsed time grows without inventing a percentage", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T16:01:00Z"));
    render(<VideoProcessingStatus kind="Transcript" state="queued" processing={details} checkedAt={Date.now()} />);
    expect(screen.getByText("1m 0s")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText("2m 0s")).toBeInTheDocument();
    expect(within(screen.getByRole("status")).getByText("Queued")).toBeInTheDocument();
    expect(within(screen.getByRole("status")).queryByText("2m 0s")).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.getByText(/does not report a percentage/)).toBeInTheDocument();
    expect(screen.getByText("Sam Editor")).toBeInTheDocument();
  });

  it("uses the recorded completion time for total elapsed time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T17:00:00Z"));
    render(<VideoProcessingStatus kind="Transcript" state="ready" processing={{ ...details, stage: "ready", completedAt: "2026-09-15T16:02:15Z" }} />);
    expect(screen.getByText("2m 15s")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText("2m 15s")).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shows real finalization and measured percentage only when supplied", () => {
    render(<VideoProcessingStatus kind="Clip" state="processing" processing={{ ...details, stage: "finalizing", provider: "aws-mediaconvert", percentComplete: 95 }} />);
    expect(screen.getByText("Finalizing")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("value", "95");
    expect(screen.getByText("AWS MediaConvert")).toBeInTheDocument();
  });

  it("does not expose unrecognized provider errors or unsafe references", () => {
    render(<VideoProcessingStatus kind="Transcript" state="needs_reconciliation" processing={{ ...details, stage: "needs_attention", statusCode: "https://private.example.test/token" }} reference="secret?token=value" />);
    expect(screen.getByText("Needs attention")).toBeInTheDocument();
    expect(screen.queryByText(/private.example|token=value/)).not.toBeInTheDocument();
    expect(screen.getByText(/No new run starts automatically/)).toBeInTheDocument();
  });

  it.each([
    ["byok_spool_missing", /saved transcript result is missing/],
    ["byok_spool_invalid", /saved transcript result could not be verified/],
  ])("explains %s without offering another paid submission", (statusCode, explanation) => {
    render(<VideoProcessingStatus kind="Transcript" state="needs_reconciliation" processing={{ ...details, provider: "elevenlabs", stage: "needs_attention", statusCode: statusCode as string }} />);
    expect(screen.getByText(explanation as RegExp)).toBeVisible();
    expect(screen.getByText(/administrator must check the original request and provider account/)).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows actual local stages and a possible AWS estimate without calling a busy queue unavailable", () => {
    const { rerender } = render(<VideoProcessingStatus kind="Transcript" state="queued" processing={{ ...details, provider: "local-whisper", estimatedAwsChargeUsd: 0.36 }} />);
    expect(screen.getByText("Local worker · Whisper")).toBeInTheDocument();
    expect(screen.getByText(/Possible AWS charge: \$0.36 if fallback is used/)).not.toBeVisible();
    expect(screen.getByText("Paid backup details")).toBeVisible();
    expect(screen.getByText("Queued, waiting for earlier requests")).toBeVisible();
    expect(screen.queryByText(/Local worker was unavailable/)).not.toBeInTheDocument();
    rerender(<VideoProcessingStatus kind="Transcript" state="processing" processing={{ ...details, stage: "processing", provider: "local-whisper", localStage: "diarizing" }} />);
    expect(screen.getByText("Separating speakers in the recording.")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("shows a ready export estimate with its conversion and storage scope", () => {
    render(<VideoProcessingStatus kind="Export" state="ready" processing={{ ...details, stage: "ready", provider: "aws-mediaconvert", estimatedAwsChargeUsd: 0.6693 }} />);
    expect(screen.getByText("$0.6693 estimated")).toBeInTheDocument();
    expect(screen.getByText(/this attempt's conversion, 14 days of storage for the export and 28 days for the staged original/)).toBeInTheDocument();
    expect(screen.queryByText(/covers recognition only/)).not.toBeInTheDocument();
  });
  it("shows a cloud fallback reason and hides the old local stage", () => {
    render(<VideoProcessingStatus kind="Transcript" state="queued" processing={{ ...details, provider: "amazon-transcribe", localStage: "diarizing", fallbackReason: "local_processing_failed", estimatedAwsChargeUsd: 0.36 }} />);
    expect(screen.getByText(/Local worker could not complete processing/)).toBeInTheDocument();
    expect(screen.getByText(/using the Amazon Transcribe fallback/)).toBeInTheDocument();
    expect(screen.queryByText("Separating speakers in the recording.")).not.toBeInTheDocument();
    expect(screen.getByText("$0.36 estimated")).toBeInTheDocument();
  });

  it("explains a recognized processing stop without pretending a legacy timestamp exists", () => {
    render(<VideoProcessingStatus kind="Transcript" state="queued" processing={{ ...details, requestedAt: null, statusCode: "billing_unavailable" }} reference="saved-job" />);
    expect(screen.getByText(/cannot start while billing is unavailable/)).toBeInTheDocument();
    expect(screen.getByText("saved-job")).toBeInTheDocument();
    expect(screen.queryByText("Requested", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText(/Elapsed|Last checked/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Not recorded|Not checked in this window/)).not.toBeInTheDocument();
  });
  it("omits absent status facts", () => {
    const { container } = render(<VideoProcessingStatus kind="Transcript" state="queued" processing={{ ...details, requestedBy: null, requestedByName: undefined, provider: undefined as unknown as ProcessingDetails["provider"], requestedAt: null, updatedAt: null }} />);
    expect(screen.queryByText("staff-123")).not.toBeInTheDocument();
    expect(screen.queryByText(/Requested by|Last updated|Not recorded/)).not.toBeInTheDocument();
    expect(container.querySelector("dl")).toBeNull();
  });
  it("keeps the saved account id when no display name is known", () => {
    render(<VideoProcessingStatus kind="Clip" state="queued" processing={{ ...details, requestedByName: undefined }} />);
    expect(screen.getByText("Requester account")).toBeInTheDocument();
    expect(screen.getByText("staff-123")).toBeInTheDocument();
    expect(screen.queryByText("Requested by")).not.toBeInTheDocument();
  });
  it("shows the plain preparation stop reason after three tries", () => {
    render(<VideoProcessingStatus kind="Transcript" state="failed" processing={{ ...details, stage: "failed", provider: "local-whisper", statusCode: "local_audio_preparation_failed" }} />);
    expect(screen.getByText(/could not prepare this video’s audio after three tries/)).toBeVisible();
  });
  it("explains why a paid transcript waits without calling it failed", () => {
    render(<VideoProcessingStatus kind="Transcript" state="queued" processing={{ ...details, statusCode: "paid_budget_unavailable" }} />);
    expect(screen.getByText(/waiting for the paid allowance or another paid request to finish/)).toBeVisible();
    expect(within(screen.getByRole("status")).getByText("Queued")).toBeVisible();
  });
  it("explains why an original export is queued and how to release it", () => {
    render(<VideoProcessingStatus kind="Export" state="queued" processing={{ ...details, stage: "queued", statusCode: "original_check_failed" }} />);
    expect(screen.getByText(/original could not be checked/)).toBeInTheDocument();
    expect(screen.getByText(/You can cancel it and try again later/)).toBeInTheDocument();
  });
});


describe("BYOK charge status", () => {
  it.each(["byok_admission_invalid", "byok_preparation_failed"])("explains that %s stopped before provider submission", (statusCode) => {
    render(<VideoProcessingStatus kind="Transcript" state="failed" processing={{ ...details, provider: "elevenlabs", stage: "failed", statusCode }} />);
    expect(screen.getByText(/No transcription request was sent to ElevenLabs/)).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });
  it("explains uncertain provider charging and no automatic resubmission", () => {
    render(<VideoProcessingStatus kind="Transcript" state="needs_reconciliation" processing={{ ...details, provider: "elevenlabs", stage: "needs_attention", statusCode: "elevenlabs_submission_uncertain" }} />);
    expect(screen.getByText(/may have accepted and charged/)).toBeInTheDocument();
    expect(screen.getByText(/will not be submitted again automatically/)).toBeInTheDocument();
  });
  it("uses the saved finalizing checkpoint while the job remains running", () => {
    render(<VideoProcessingStatus kind="Transcript" state="processing" processing={{ ...details, provider: "elevenlabs", stage: "finalizing" }} />);
    expect(screen.getByText("Finalizing")).toBeInTheDocument();
    expect(screen.queryByText("Processing", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });
});
