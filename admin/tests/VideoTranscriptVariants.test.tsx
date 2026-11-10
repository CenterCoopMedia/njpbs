import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { VideoTranscriptVariants } from "../src/components/VideoTranscriptVariants";
import { getVideoTranscript, saveVideoTranscript, readVideoTranscript, type VideoTranscript } from "../src/lib/video-production";
import { postFunction } from "../src/lib/functions";
vi.mock("../src/lib/functions", () => ({ postFunction: vi.fn() }));
const identity = { sourceId: "video-library", assetId: "video-1" };
const variant: VideoTranscript = { id: "a".repeat(64), state: "ready", languageCode: "es-US", maxSpeakers: 3, processing: { provider: "elevenlabs", stage: "ready", requestedBy: null, requestedAt: null, startedAt: null, updatedAt: null, completedAt: null, percentComplete: null, statusCode: null } };
const allowance = { reservedSubmissions: 0, reservedAudioSeconds: 0, consumedSubmissions: 0, consumedAudioSeconds: 0, remainingSubmissions: 5, remainingAudioSeconds: 3600, outstanding: 0 };
const options = { success: true, enabled: true, credentials: [{ scope: "personal", provider: "elevenlabs", revision: 4, configured: true }, { scope: "organization", provider: "elevenlabs", revision: 8, configured: true }], provider: { id: "elevenlabs", model: "scribe_v2", wordTimings: true, languageCodes: ["en-US", "es-US"], maxSpeakers: { min: 2, max: 10 }, maxInputBytes: 2e9, minDurationSeconds: 0.1, maxDurationSeconds: 7200 }, limits: { requester: { submissions: 5, audioSeconds: 3600, outstanding: 1 }, global: { submissions: 20, audioSeconds: 14400 } }, budget: { day: "2026-09-15", requester: allowance, global: allowance } };
const props = { identity, getIdToken: vi.fn().mockResolvedValue("token"), open: true, disabled: false, canRequest: true, settings: { languageCode: "en-US" as const, maxSpeakers: 10 }, duration: 1800, sizeBytes: 54_000_000, refresh: 0, onSelect: vi.fn(), onRequested: vi.fn(), onBusyChange: vi.fn() };
beforeEach(() => {
  vi.clearAllMocks(); props.getIdToken.mockResolvedValue("token");
  vi.mocked(postFunction).mockImplementation(async endpoint => endpoint === "cmsGetTranscriptionOptions" ? options : endpoint === "cmsListVideoTranscripts" ? { success: true, transcripts: [variant], nextCursor: null } : { success: true, cached: false, transcript: variant });
});
afterEach(cleanup);
async function paid() {
  await waitFor(() => expect(screen.getByRole("button", { name: "Reload transcription options" })).toBeEnabled());
  const details = screen.getByText("New transcript").closest("details")!;
  await act(async () => { details.open = true; fireEvent(details, new Event("toggle")); });
}
function consent(scope = "personal") {
  fireEvent.change(screen.getByLabelText("Account to charge"), { target: { value: scope } }); fireEvent.click(screen.getByRole("checkbox"));
}
it("requires key choice and paid consent, then binds the request to its revision", async () => {
  render(<VideoTranscriptVariants {...props} />); await paid();
  const request = screen.getByRole("button", { name: "Request ElevenLabs transcript" });
  expect(request).toBeDisabled(); expect(screen.getByLabelText("Account to charge")).toHaveValue("");
  fireEvent.change(screen.getByLabelText("Account to charge"), { target: { value: "organization" } }); expect(request).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox")); await act(async () => { fireEvent.click(request); });
  expect(vi.mocked(postFunction).mock.calls.filter(([name]) => name === "cmsRequestByokVideoTranscript")).toEqual([["cmsRequestByokVideoTranscript", "token", { ...identity, provider: "elevenlabs", credentialScope: "organization", credentialRevision: 8, languageCode: "en-US", maxSpeakers: 10 }, {}, { appCheck: true }]]);
  expect(props.onRequested).toHaveBeenCalledWith({ success: true, cached: false, transcript: variant }); expect(props.onBusyChange).toHaveBeenCalledWith(true); expect(props.onBusyChange).toHaveBeenLastCalledWith(false);
});
it.each(["unavailable", "budget", "active", "malformed"])("blocks paid requests for %s options", async reason => {
  const original = vi.mocked(postFunction).getMockImplementation()!;
  vi.mocked(postFunction).mockImplementation(async (...args) => args[0] !== "cmsGetTranscriptionOptions" ? original(...args) : reason === "malformed" ? {} : { ...options, enabled: reason !== "unavailable", budget: { ...options.budget, requester: { ...allowance, remainingAudioSeconds: reason === "budget" ? 1 : 3600, outstanding: reason === "active" ? 1 : 0 } } });
  render(<VideoTranscriptVariants {...props} />); await paid(); consent();
  expect(screen.getByRole("button", { name: "Request ElevenLabs transcript" })).toBeDisabled();
  expect(vi.mocked(postFunction).mock.calls.some(([name]) => name === "cmsRequestByokVideoTranscript")).toBe(false);
});
it("selects a saved result without submitting and respects edit locks", async () => {
  const view = render(<VideoTranscriptVariants {...props} />); await paid();
  fireEvent.change(screen.getByLabelText("Saved transcript"), { target: { value: variant.id } }); expect(props.onSelect).toHaveBeenCalledExactlyOnceWith(variant);
  view.rerender(<VideoTranscriptVariants {...props} disabled />); expect(screen.getByLabelText("Saved transcript")).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Saved transcript"), { target: { value: "" } }); expect(props.onSelect).toHaveBeenCalledTimes(1);
});
it("continues an empty page with a non-null cursor", async () => {
  const original = vi.mocked(postFunction).getMockImplementation()!;
  vi.mocked(postFunction).mockImplementation(async (...args) => args[0] !== "cmsListVideoTranscripts" ? original(...args) : (args[2] as { cursor?: string }).cursor ? { success: true, transcripts: [variant], nextCursor: null } : { success: true, transcripts: [], nextCursor: "page-2" });
  render(<VideoTranscriptVariants {...props} />); await paid();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Load more saved transcripts" })); });
  expect(screen.getByRole("option", { name: /ElevenLabs Scribe v2/ })).toBeInTheDocument();
});
it("does not submit after unmount during token acquisition", async () => {
  const view = render(<VideoTranscriptVariants {...props} />); await paid(); let resolve!: (token: string) => void;
  props.getIdToken.mockImplementationOnce(() => new Promise(done => { resolve = done; })); consent();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Request ElevenLabs transcript" })); });
  view.unmount(); await act(async () => { resolve("late-token"); });
  expect(vi.mocked(postFunction).mock.calls.some(([name]) => name === "cmsRequestByokVideoTranscript")).toBe(false);
});
it("uses only the explicit variant ID for reads, corrections and downloads", async () => {
  const settings = { languageCode: "es-US" as const, maxSpeakers: 3, transcriptId: variant.id };
  await getVideoTranscript("token", identity, settings, "page"); await saveVideoTranscript("token", identity, settings, { revision: 2, reviewed: true }); await readVideoTranscript("token", identity, settings, "avid", { frameRate: "30000/1001", frameOffset: 60 });
  expect(vi.mocked(postFunction).mock.calls.map(call => call[2])).toEqual([{ ...identity, transcriptId: variant.id, cursor: "page" }, { ...identity, transcriptId: variant.id, revision: 2, reviewed: true }, { ...identity, transcriptId: variant.id, format: "avid", frameRate: "30000/1001", frameOffset: 60 }]);
});

it.each([0.05, 0.1])("enforces the advertised duration minimum for %s seconds", async duration => {
  render(<VideoTranscriptVariants {...props} duration={duration} />); await paid(); consent();
  const request = screen.getByRole("button", { name: "Request ElevenLabs transcript" });
  if (duration < 0.1) expect(request).toBeDisabled(); else expect(request).toBeEnabled();
});
it("blocks requests when the provider duration minimum is missing", async () => {
  const original = vi.mocked(postFunction).getMockImplementation()!;
  vi.mocked(postFunction).mockImplementation(async (...args) => args[0] !== "cmsGetTranscriptionOptions" ? original(...args) : { ...options, provider: { ...options.provider, minDurationSeconds: undefined } });
  render(<VideoTranscriptVariants {...props} duration={0.1} />); await paid(); consent();
  expect(screen.getByRole("button", { name: "Request ElevenLabs transcript" })).toBeDisabled();
});

it.each([401, 500])("only permits a new confirmed request after a definite authentication failure (%s)", async status => {
  const original = vi.mocked(postFunction).getMockImplementation()!;
  let submissions = 0;
  vi.mocked(postFunction).mockImplementation(async (...args) => {
    if (args[0] === "cmsRequestByokVideoTranscript" && ++submissions === 1) throw Object.assign(new Error("Request failed"), { status });
    return original(...args);
  });
  render(<VideoTranscriptVariants {...props} />); await paid(); consent();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Request ElevenLabs transcript" })); });
  expect(screen.getByText(status === 401
    ? "Your session could not be verified. Sign in again, then reload transcription options."
    : "The request could not be confirmed. Check the saved transcript list and ask an administrator to check before another paid request.")).toBeInTheDocument();
  expect(screen.getByRole("checkbox")).not.toBeChecked();
  expect(screen.getByRole("button", { name: "Request ElevenLabs transcript" })).toBeDisabled();

  props.getIdToken.mockResolvedValue("renewed-token");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Reload transcription options" })); });
  expect(submissions).toBe(1);
  expect(screen.getByRole("button", { name: "Request ElevenLabs transcript" })).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox"));
  const request = screen.getByRole("button", { name: "Request ElevenLabs transcript" });
  if (status === 401) {
    expect(request).toBeEnabled();
    await act(async () => { fireEvent.click(request); });
    expect(submissions).toBe(2);
    expect(props.onRequested).toHaveBeenCalledExactlyOnceWith({ success: true, cached: false, transcript: variant });
  } else {
    expect(request).toBeDisabled();
    fireEvent.click(request);
    expect(submissions).toBe(1);
    expect(props.onRequested).not.toHaveBeenCalled();
  }
});

it("keeps a relocated paid action bound to consent, account and pending guards", async () => {
  const target = document.createElement("div"); document.body.append(target);
  const view = render(<VideoTranscriptVariants {...props} actionTarget={target} />); await paid();
  expect(target.querySelector("button")).toBeDisabled();
  consent("organization");
  const request = screen.getByRole("button", { name: "Request ElevenLabs transcript (station key)" });
  expect(target).toContainElement(request); expect(request).toBeEnabled();
  let finish!: (value: unknown) => void;
  const original = vi.mocked(postFunction).getMockImplementation()!;
  vi.mocked(postFunction).mockImplementation(async (...args) => args[0] === "cmsRequestByokVideoTranscript" ? new Promise(resolve => { finish = resolve; }) : original(...args));
  await act(async () => { fireEvent.click(request); });
  expect(request).toBeDisabled(); expect(screen.getByLabelText("Account to charge")).toBeDisabled();
  expect(props.onBusyChange).toHaveBeenLastCalledWith(true);
  await act(async () => { finish({ success: true, cached: false, transcript: variant }); });
  expect(target).toBeEmptyDOMElement();
  view.unmount(); target.remove();
});

it("shows a queued local request in the saved list without submitting again", async () => {
  const original = vi.mocked(postFunction).getMockImplementation()!;
  vi.mocked(postFunction).mockImplementation(async (...args) => args[0] === "cmsListVideoTranscripts"
    ? { success: true, transcripts: [{ ...variant, state: "queued", processing: { provider: "local-whisper" } }], nextCursor: null }
    : original(...args));
  render(<VideoTranscriptVariants {...props} />); await paid();
  expect(screen.getByRole("option", { name: /Local worker Whisper.*Queued/ })).toBeInTheDocument();
  expect(vi.mocked(postFunction).mock.calls.some(([name]) => name.startsWith("cmsRequest"))).toBe(false);
});

it.each(["failed", "needs_reconciliation", "ready"] as const)("offers a free provider attempt after %s without paid consent", async state => {
  const currentTranscript = { ...variant, state };
  render(<VideoTranscriptVariants {...props} currentTranscript={currentTranscript} requestPolicy={{ enabled: true, provider: "local-whisper", localEnabled: true, fallbackEnabled: true }} />);
  await paid();
  expect(screen.getByLabelText("Transcript provider")).toHaveValue("local");
  await waitFor(() => expect(screen.getByLabelText("New transcript language")).toHaveValue("es-US"));
  expect(screen.getByLabelText("Maximum speakers")).toHaveValue("3");
  fireEvent.change(screen.getByLabelText("New transcript language"), { target: { value: "en-US" } });
  fireEvent.change(screen.getByLabelText("Maximum speakers"), { target: { value: "4" } });
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  const request = screen.getByRole("button", { name: "Request free transcript" });
  expect(request).toBeEnabled(); expect(request).toHaveClass("button-primary");
  await act(async () => { fireEvent.click(request); });
  expect(vi.mocked(postFunction).mock.calls.filter(([name]) => name === "cmsRequestVideoTranscript")).toEqual([["cmsRequestVideoTranscript", "token", { ...identity, languageCode: "en-US", maxSpeakers: 4, provider: "local", newAttemptOf: variant.id, attemptKey: expect.any(String) }, {}, { appCheck: true }]]);
});
it.each([
  ["A free transcript retry is already active for this earlier request", "A free retry from this earlier transcript is already active. Check saved transcripts."],
  ["You already have an active free transcript retry", "Your active free transcript retry must finish before another one. Check saved transcripts."],
  ["You have reached five free transcript retries today", "You have used five free transcript retries today. This limit resets at midnight UTC."],
])("explains the free retry limit: %s", async (detail, message) => {
  const original = vi.mocked(postFunction).getMockImplementation()!;
  vi.mocked(postFunction).mockImplementation(async (...args) => {
    if (args[0] === "cmsRequestVideoTranscript") throw Object.assign(new Error(detail), { status: 429 });
    return original(...args);
  });
  render(<VideoTranscriptVariants {...props} currentTranscript={{ ...variant, state: "failed" }} requestPolicy={{ enabled: true, provider: "local-whisper", localEnabled: true, fallbackEnabled: true }} />);
  await paid();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Request free transcript" })); });
  expect(screen.getByText(message)).toBeInTheDocument();
});
it("explains a retained earlier Amazon request without choosing an unrelated history row", async () => {
  const detail = "An earlier Amazon request for this video is not confirmed yet. Choose that request in the saved transcript list to try again.";
  const original = vi.mocked(postFunction).getMockImplementation()!;
  vi.mocked(postFunction).mockImplementation(async (...args) => {
    if (args[0] === "cmsRequestVideoTranscript") throw Object.assign(new Error(detail), { status: 429 });
    return original(...args);
  });
  render(<VideoTranscriptVariants {...props} currentTranscript={{ ...variant, state: "ready" }} requestPolicy={{ enabled: true, provider: "local-whisper", localEnabled: true, fallbackEnabled: true }} />);
  await paid();
  fireEvent.change(screen.getByLabelText("Transcript provider"), { target: { value: "amazon-transcribe" } });
  fireEvent.click(screen.getByRole("checkbox"));
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Request Amazon transcript" })); });
  expect(screen.getByText(detail)).toBeInTheDocument();
  expect(props.onSelect).not.toHaveBeenCalled();
});
it("requires fresh paid consent for an explicit Amazon attempt and keeps its predecessor", async () => {
  render(<VideoTranscriptVariants {...props} currentTranscript={{ ...variant, state: "needs_reconciliation" }} requestPolicy={{ enabled: true, provider: "local-whisper", localEnabled: true, fallbackEnabled: true }} />);
  await paid();
  fireEvent.change(screen.getByLabelText("Transcript provider"), { target: { value: "amazon-transcribe" } });
  const request = screen.getByRole("button", { name: "Request Amazon transcript" });
  expect(request).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox"));
  await act(async () => { fireEvent.click(request); });
  expect(vi.mocked(postFunction).mock.calls.find(([name]) => name === "cmsRequestVideoTranscript")?.[2]).toEqual({ ...identity, languageCode: "es-US", maxSpeakers: 3, provider: "amazon-transcribe", newAttemptOf: variant.id, attemptKey: expect.any(String) });
});
it("binds an ElevenLabs retry to terminal history and current key revision", async () => {
  render(<VideoTranscriptVariants {...props} currentTranscript={{ ...variant, state: "failed" }} requestPolicy={{ enabled: true, provider: "local-whisper", localEnabled: true, fallbackEnabled: true }} />);
  await paid();
  fireEvent.change(screen.getByLabelText("Transcript provider"), { target: { value: "elevenlabs" } });
  consent("organization");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Request ElevenLabs transcript" })); });
  expect(vi.mocked(postFunction).mock.calls.find(([name]) => name === "cmsRequestByokVideoTranscript")?.[2]).toMatchObject({ newAttemptOf: variant.id, credentialScope: "organization", credentialRevision: 8 });
});
it.each(["queued", "processing"] as const)("blocks another paid attempt while the current request is %s", async state => {
  render(<VideoTranscriptVariants {...props} currentTranscript={{ ...variant, state }} />);
  await paid(); consent();
  expect(screen.queryByLabelText("Transcript provider")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Request ElevenLabs transcript" })).toBeDisabled();
});
it("blocks an Amazon attempt when the shared paid allowance is known to be used", async () => {
  const original = vi.mocked(postFunction).getMockImplementation()!;
  vi.mocked(postFunction).mockImplementation(async (...args) => args[0] === "cmsGetTranscriptionOptions"
    ? { ...options, budget: { ...options.budget, requester: { ...allowance, remainingSubmissions: 0 } } } : original(...args));
  render(<VideoTranscriptVariants {...props} currentTranscript={{ ...variant, state: "failed" }} requestPolicy={{ enabled: true, provider: "local-whisper", localEnabled: true, fallbackEnabled: true }} />);
  await paid();
  fireEvent.change(screen.getByLabelText("Transcript provider"), { target: { value: "amazon-transcribe" } });
  fireEvent.click(screen.getByRole("checkbox"));
  expect(screen.getByRole("button", { name: "Request Amazon transcript" })).toBeDisabled();
  expect(vi.mocked(postFunction).mock.calls.some(([name]) => name === "cmsRequestVideoTranscript")).toBe(false);
});
it("keeps Amazon unavailable when operators disable that route", async () => {
  render(<VideoTranscriptVariants {...props} currentTranscript={{ ...variant, state: "failed" }} requestPolicy={{ enabled: true, provider: "local-whisper", localEnabled: true, fallbackEnabled: false }} />);
  await paid();
  expect(screen.getByRole("option", { name: "Amazon Transcribe (paid)" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Transcript provider"), { target: { value: "amazon-transcribe" } });
  fireEvent.click(screen.getByRole("checkbox"));
  expect(screen.getByRole("button", { name: "Request Amazon transcript" })).toBeDisabled();
});
