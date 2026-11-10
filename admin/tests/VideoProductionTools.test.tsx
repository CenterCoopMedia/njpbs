import { useRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVideoProductionTools, videoProductionMessage } from "../src/components/VideoProductionTools";
import { postFunction } from "../src/lib/functions";
import { listVideoTranscripts } from "../src/lib/transcription-options";
import type { TranscriptSettings } from "../src/lib/video-production";
import type { SourceMediaAssetSummary } from "../src/lib/source-media";
import { VideoReviewSeek } from "../src/components/media/VideoReviewSeek";
import { Menu } from "../src/components/ui/Menu";

vi.mock("../src/lib/transcription-options", () => ({
  getTranscriptionOptions: vi.fn().mockRejectedValue(new Error("Not enabled in this fixture")),
  listVideoTranscripts: vi.fn().mockResolvedValue({ success: true, transcripts: [], nextCursor: null }),
  requestByokVideoTranscript: vi.fn(),
}));
vi.mock("../src/lib/functions", () => ({ postFunction: vi.fn(), HttpError: class extends Error {} }));
const getIdToken = vi.fn().mockResolvedValue("staff-token");
const asset = { id: "video-1", sourceId: "video-library", name: "Test video", viewingCopy: { state: "ready", durationSeconds: 60, sizeBytes: 1024 } } as SourceMediaAssetSummary;
function Harness({ video = asset, frame = false, workspace = false, seek = false, onBusyChange, onSearchContentChanged, onTranscriptRequested, onTranscriptObserved, onTranscriptReady }: {
  video?: SourceMediaAssetSummary;
  frame?: boolean;
  workspace?: boolean;
  seek?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onSearchContentChanged?: () => void;
  onTranscriptRequested?: (assetId: string, settings: TranscriptSettings, ready: boolean) => void;
  onTranscriptObserved?: (assetId: string, settings: TranscriptSettings) => void;
  onTranscriptReady?: (assetId: string, settings: TranscriptSettings) => void;
}) {
  const player = useRef<HTMLVideoElement>(null);
  const { actions, content, transcriptPane, downloadItems, editorExportsItem, playbackSeconds, seekPlayback, onTimeUpdate } = useVideoProductionTools({ asset: video, getIdToken, player, canRequest: true, disabled: false, headerControls: frame, workspace, onBusyChange, onSearchContentChanged, onTranscriptRequested, onTranscriptObserved, onTranscriptReady });
  return <>{seek ? <><video ref={player} onTimeUpdate={onTimeUpdate} /><VideoReviewSeek currentSeconds={playbackSeconds} durationMs={60000} disabled={false} onSeek={seekPlayback}>{null}</VideoReviewSeek></> : null}{frame ? <Menu label="Download" items={[editorExportsItem, ...downloadItems]} /> : null}{actions}{content}{transcriptPane}</>;
}
async function openTranscript() {
  const disclosure = screen.getByText("Transcript").closest("details")!;
  await act(async () => {
    disclosure.open = true;
    fireEvent(disclosure, new Event("toggle"));
  });
}
async function openClip() {
  const disclosure = screen.getByText("Create a clip").closest("details")!;
  await act(async () => { disclosure.open = true; fireEvent(disclosure, new Event("toggle")); });
}
const response = (state: string) => ({ success: true, cached: true, transcript: { id: "saved-transcript", state, segments: [], nextCursor: null } });

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-15T16:00:00Z")); vi.mocked(postFunction).mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("review seek position", () => {
  it("keeps consecutive requested positions before the media clock reports its seek", () => {
    render(<Harness seek />);
    const slider = screen.getByRole("slider", { name: "Review video position" });
    fireEvent.change(slider, { target: { value: "8.13" } });
    expect(slider).toHaveValue("8.13");
    fireEvent.change(slider, { target: { value: "8.14" } });
    expect(slider).toHaveValue("8.14");
  });
});

describe("shared header downloads", () => {
  it("keeps paid workspace actions paired with the visible transcript settings", async () => {
    vi.mocked(postFunction).mockResolvedValue({ ...response("not_requested"), requestPolicy: { enabled: true, provider: "amazon-transcribe", fallbackEnabled: false } });
    await act(async () => { render(<Harness frame workspace />); });
    const disclosure = screen.getByText("Transcript settings", { selector: "summary" }).closest("details")!;
    expect(disclosure.open).toBe(false);
    expect(screen.queryByRole("button", { name: "Transcribe video" })).not.toBeInTheDocument();
    await act(async () => { disclosure.open = true; fireEvent(disclosure, new Event("toggle")); });
    expect(screen.getByText(/AWS recognition charges apply/)).toBeVisible();
    expect(screen.getByText(/Possible AWS charge for this video/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Transcribe video" })).toBeEnabled();
    await act(async () => { disclosure.open = false; fireEvent(disclosure, new Event("toggle")); });
    expect(screen.queryByRole("button", { name: "Transcribe video" })).not.toBeInTheDocument();
    expect(vi.mocked(postFunction).mock.calls.some(([endpoint]) => endpoint.startsWith("cmsRequest"))).toBe(false);
  });

  it("shows format prerequisites without a paid request, then opens existing transcript settings", async () => {
    vi.mocked(postFunction).mockResolvedValue(response("ready"));
    render(<Harness frame />);
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(postFunction).not.toHaveBeenCalled();
    const plain = screen.getByRole("menuitem", { name: /^Plain text/ });
    expect(plain).toHaveAttribute("aria-disabled", "true");
    expect(plain).toHaveTextContent("Open a saved transcript first.");
    fireEvent.click(plain);
    expect(postFunction).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: "Transcript export settings…" })); });
    expect(screen.getByText("Transcript", { selector: "summary" }).closest("details")).toHaveAttribute("open");
    expect(screen.getByText("Editing software exports", { selector: "summary" }).closest("details")).toHaveAttribute("open");
    expect(screen.getByRole("combobox", { name: "Editing clip or sequence frame rate" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Download text" })).not.toBeInTheDocument();
    expect(vi.mocked(postFunction).mock.calls.some(([endpoint]) => endpoint.startsWith("cmsRequest"))).toBe(false);
  });

  it("keeps the complete saved export payload and reports pending without a repeated download", async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(postFunction).mockImplementation(endpoint => endpoint === "cmsCreateVideoTranscriptRead"
      ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(response("ready")));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const busy = vi.fn();
    render(<Harness frame onBusyChange={busy} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Open transcript" })); });
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: /^Plain text/ })); });
    expect(busy).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    const plain = screen.getByRole("menuitem", { name: /^Plain text/ });
    expect(plain).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(plain);
    const reads = vi.mocked(postFunction).mock.calls.filter(([endpoint]) => endpoint === "cmsCreateVideoTranscriptRead");
    expect(reads).toHaveLength(1);
    expect(reads[0][2]).toEqual({ sourceId: asset.sourceId, assetId: asset.id, transcriptId: "saved-transcript", format: "txt" });
    await act(async () => { finish({ success: true, url: "https://example.test/saved-transcript.txt", expiresAt: "2026-09-15T16:05:00Z" }); });
    expect(click).toHaveBeenCalledOnce();
    expect(busy).toHaveBeenLastCalledWith(false);
    click.mockRestore();
  });

  it("opens broadcast/editor setup without starting an export", () => {
    render(<Harness frame />);
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Broadcast & editing exports…/ }));
    expect(screen.getByText("Broadcast and editing exports", { selector: "summary" }).closest("details")).toHaveAttribute("open");
    expect(vi.mocked(postFunction).mock.calls.some(([endpoint]) => endpoint.startsWith("cmsRequest"))).toBe(false);
  });
});

describe("processing status refresh", () => {
  it("keeps the new file busy when an old transcript page finishes", async () => {
    let oldPage!: (value: unknown) => void, newDownload!: (value: unknown) => void;
    let replaced = false;
    vi.mocked(postFunction).mockImplementation(async (endpoint, _token, body) => {
      if (endpoint === "cmsCreateVideoTranscriptRead") return new Promise(resolve => { newDownload = resolve; });
      if ((body as { cursor?: string }).cursor) return new Promise(resolve => { oldPage = resolve; });
      return { ...response("ready"), transcript: { ...response("ready").transcript, id: replaced ? "new" : "old", nextCursor: replaced ? null : "old-page" } };
    });
    const view = render(<Harness video={{ ...asset, fileVersion: "file-v1" }} />);
    await openTranscript();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Load more transcript" })); });
    replaced = true;
    await act(async () => { view.rerender(<Harness video={{ ...asset, fileVersion: "file-v2" }} />); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Download text" })); });
    await act(async () => { oldPage(response("ready")); });
    expect(screen.getByRole("button", { name: "Download text" })).toBeDisabled();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await act(async () => { newDownload({ success: true, url: "https://example.test/new.txt" }); });
    expect(screen.getByRole("button", { name: "Download text" })).toBeEnabled();
    click.mockRestore();
  });

  it("resets a selected old-file variant before making one new default read", async () => {
    const variant = { id: "old-variant", state: "ready" as const, segments: [], nextCursor: null, languageCode: "en-US" as const, maxSpeakers: 10 };
    vi.mocked(listVideoTranscripts).mockResolvedValue({ success: true, transcripts: [variant], nextCursor: null });
    vi.mocked(postFunction).mockResolvedValue(response("ready"));
    const view = render(<Harness video={{ ...asset, fileVersion: "file-v1" }} />);
    await openTranscript();
    await act(async () => { fireEvent.change(screen.getByLabelText("Saved transcript"), { target: { value: "old-variant" } }); });
    expect(postFunction).toHaveBeenLastCalledWith("cmsGetVideoTranscript", "staff-token", expect.objectContaining({ transcriptId: "old-variant" }), {}, { appCheck: "unless-automation" });
    vi.mocked(postFunction).mockClear();
    await act(async () => { view.rerender(<Harness video={{ ...asset, fileVersion: "file-v2" }} />); });
    const calls = vi.mocked(postFunction).mock.calls.filter(([endpoint]) => endpoint === "cmsGetVideoTranscript");
    expect(calls).toHaveLength(1);
    expect(calls[0][2]).not.toHaveProperty("transcriptId");
    expect(screen.getByLabelText("Saved transcript")).toHaveValue("");
    vi.mocked(listVideoTranscripts).mockResolvedValue({ success: true, transcripts: [], nextCursor: null });
  });

  it.each(["transcript", "clip"])("ignores a delayed %s download after the same ID receives new bytes", async kind => {
    const saved = { id: "c".repeat(64), state: "ready", inMs: 1000, outMs: 2000, durationMs: 1000, expiresAt: "2099-01-01T00:00:00Z" };
    let finish!: (value: unknown) => void;
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    vi.mocked(postFunction).mockImplementation(async (endpoint, _token, body) => {
      if (endpoint === "cmsGetVideoTranscript") return response("ready");
      if (endpoint === "cmsCreateVideoTranscriptRead" || endpoint === "cmsCreateVideoClipRead") return new Promise(resolve => { finish = resolve; });
      return (body as { clipId?: string })?.clipId ? { success: true, clip: saved } : { success: true, clips: [saved] };
    });
    const view = render(<Harness video={{ ...asset, fileVersion: "file-v1" }} />);
    if (kind === "transcript") {
      await openTranscript();
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Download text" })); });
    } else {
      await openClip();
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: /00:00:01.000 to 00:00:02.000/ })); });
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Download clip" })); });
    }
    await act(async () => { view.rerender(<Harness video={{ ...asset, fileVersion: "file-v2" }} />); });
    await act(async () => { finish({ success: true, url: "https://example.test/old.txt", access: { url: "https://example.test/old.mp4" } }); });
    expect(click).not.toHaveBeenCalled();
    click.mockRestore();
  });

  it("refetches a ready transcript when the same video ID receives a new file version", async () => {
    let replacement = false;
    vi.mocked(postFunction).mockImplementation(async endpoint => endpoint === "cmsGetVideoTranscript" ? {
      ...response("ready"), transcript: { ...response("ready").transcript,
        id: replacement ? "new-transcript" : "old-transcript",
        segments: [{ index: 0, speaker: "spk_0", startSeconds: 0, endSeconds: 1, text: replacement ? "Replacement words" : "Original words" }] },
    } : { success: true, clips: [] });
    const view = render(<Harness video={{ ...asset, fileVersion: "file-v1" }} />);
    await openTranscript();
    expect(screen.getByText("Original words")).toBeVisible();
    replacement = true;
    await act(async () => { view.rerender(<Harness video={{ ...asset, fileVersion: "file-v2" }} />); });
    expect(screen.queryByText("Original words")).not.toBeInTheDocument();
    expect(screen.getByText("Replacement words")).toBeVisible();
    expect(vi.mocked(postFunction).mock.calls.filter(([endpoint]) => endpoint === "cmsGetVideoTranscript")).toHaveLength(2);
  });

  it("ignores a late transcript response for the replaced file", async () => {
    let resolveOld!: (value: unknown) => void;
    vi.mocked(postFunction).mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
      .mockResolvedValue({ ...response("ready"), transcript: { ...response("ready").transcript,
        segments: [{ index: 0, speaker: "spk_0", startSeconds: 0, endSeconds: 1, text: "New file transcript" }] } });
    const view = render(<Harness video={{ ...asset, fileVersion: "file-v1" }} />);
    await openTranscript();
    await act(async () => { view.rerender(<Harness video={{ ...asset, fileVersion: "file-v2" }} />); });
    await act(async () => { resolveOld({ ...response("ready"), transcript: { ...response("ready").transcript,
      segments: [{ index: 0, speaker: "spk_0", startSeconds: 0, endSeconds: 1, text: "Stale old transcript" }] } }); });
    expect(screen.getByText("New file transcript")).toBeVisible();
    expect(screen.queryByText("Stale old transcript")).not.toBeInTheDocument();
  });

  it("loads the next page from the transcript on screen when the default moves", async () => {
    const first = { id: "loaded-transcript", state: "ready", editRevision: 0, totalSegments: 2,
      segments: [{ index: 0, speaker: "spk_0", startSeconds: 1, endSeconds: 2, text: "First saved passage" }], nextCursor: "loaded-cursor" };
    vi.mocked(postFunction).mockImplementation(async (endpoint, _token, body) => {
      if (endpoint !== "cmsGetVideoTranscript") return { success: true, clips: [] };
      if (!(body as { cursor?: string }).cursor) return { success: true, cached: true, transcript: first };
      const id = (body as { transcriptId?: string }).transcriptId;
      return { success: true, cached: true, transcript: { ...first, id: id ?? "newer-default",
        segments: [{ index: 1, speaker: "spk_0", startSeconds: 3, endSeconds: 4, text: "Second saved passage" }], nextCursor: null } };
    });
    render(<Harness />);
    await openTranscript();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Load more transcript" })); });
    expect(postFunction).toHaveBeenCalledWith("cmsGetVideoTranscript", "staff-token", {
      sourceId: asset.sourceId, assetId: asset.id, transcriptId: "loaded-transcript", cursor: "loaded-cursor",
    }, {}, { appCheck: "unless-automation" });
    expect(screen.getByText("First saved passage")).toBeVisible();
    expect(screen.getByText("Second saved passage")).toBeVisible();
  });

  it("reports a requested transcript when polling first confirms it is ready", async () => {
    const onTranscriptRequested = vi.fn();
    const onTranscriptReady = vi.fn();
    let requested = false;
    let ready = false;
    vi.mocked(postFunction).mockImplementation(async endpoint => {
      if (endpoint === "cmsRequestVideoTranscript") { requested = true; return response("queued"); }
      return requested ? response(ready ? "ready" : "queued")
        : { ...response("not_requested"), requestPolicy: { enabled: true, provider: "local-whisper", fallbackEnabled: false } };
    });
    render(<Harness onTranscriptRequested={onTranscriptRequested} onTranscriptReady={onTranscriptReady} />);
    await openTranscript();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Transcribe video" })); });
    expect(screen.getByRole("button", { name: "Queued" })).toBeDisabled();
    expect(onTranscriptRequested).toHaveBeenCalledWith(asset.id, { languageCode: "en-US", maxSpeakers: 10 }, false);
    expect(onTranscriptReady).not.toHaveBeenCalled();
    ready = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(onTranscriptReady).toHaveBeenCalledWith(asset.id, { languageCode: "en-US", maxSpeakers: 10 });
  });
  it("reports a transcript started elsewhere when it becomes ready", async () => {
    const onSearchContentChanged = vi.fn();
    const onTranscriptObserved = vi.fn();
    let ready = false;
    vi.mocked(postFunction).mockImplementation(async () => ready
      ? { ...response("ready"), transcript: { ...response("ready").transcript, id: "fallback-child" } }
      : response("queued"));
    render(<Harness onSearchContentChanged={onSearchContentChanged} onTranscriptObserved={onTranscriptObserved} />);
    await openTranscript();
    expect(onSearchContentChanged).not.toHaveBeenCalled();
    expect(onTranscriptObserved).toHaveBeenCalledWith(asset.id, { languageCode: "en-US", maxSpeakers: 10 });
    ready = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(onSearchContentChanged).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(onSearchContentChanged).toHaveBeenCalledOnce();
  });
  it("loads older MP4 clips after an editor-only first history page", async () => {
    const cursor = "b".repeat(64);
    const clip = { id: "older-web", state: "ready", inMs: 1000, outMs: 2000, resolution: "source", quality: "balanced" };
    vi.mocked(postFunction).mockImplementation(async (_endpoint, _token, body) => (body as { clipId?: string }).clipId ? { success: true, clip } : (body as { cursor?: string }).cursor
      ? { success: true, clips: [clip], nextCursor: null }
      : { success: true, clips: [{ ...clip, id: "editor", format: "broadcast_mxf" }], nextCursor: cursor });
    render(<Harness />); await openClip();
    expect(screen.queryByRole("region", { name: "Your recent clip exports" })).not.toBeInTheDocument();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Load older MP4 exports" })));
    expect(screen.getByRole("region", { name: "Your recent clip exports" })).toBeVisible();
    expect(vi.mocked(postFunction).mock.calls.at(-1)?.[2]).toEqual({ sourceId: asset.sourceId, assetId: asset.id, cursor });
    await act(async () => fireEvent.click(screen.getByRole("region", { name: "Your recent clip exports" }).querySelector("button")!));
    expect(screen.getByRole("region", { name: "Your recent clip exports" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Load older MP4 exports" })).not.toBeInTheDocument();
    expect(vi.mocked(postFunction).mock.calls.filter(([, , body]) => !(body as { clipId?: string }).clipId)).toHaveLength(2);
  });
  it("keeps original-based editor exports out of the MP4 clip history", async () => {
    const clip = { id: "editor-clip", format: "broadcast_mxf", scope: "clip", state: "ready", inMs: 1000, outMs: 2000 };
    vi.mocked(postFunction).mockResolvedValue({ success: true, clips: [clip] });
    render(<Harness />);
    await openClip();
    expect(screen.queryByRole("region", { name: "Your recent clip exports" })).not.toBeInTheDocument();
  });
  it("keeps source resolution available when viewing-copy dimensions are unknown", async () => {
    vi.mocked(postFunction).mockResolvedValue({ success: true, clips: [] });
    render(<Harness />);
    await openClip();
    expect(screen.getByRole("combobox", { name: "Clip resolution" })).toHaveValue("source");
    for (const name of ["1080p", "720p", "480p"]) expect(screen.getByRole("option", { name })).toBeDisabled();
    expect(screen.getByRole("option", { name: "Match web copy" })).toBeEnabled();
    expect(screen.getByRole("combobox", { name: "Clip quality" })).toHaveValue("balanced");
  });

  it("retries a selected export's saved range and settings after the draft changes", async () => {
    const clip = { id: "clip-1", state: "failed", inMs: 1000, outMs: 2000, durationMs: 1000, resolution: "720p", quality: "high", canRetry: true, expiresAt: null, sizeBytes: null, errorCode: "conversion_failed" };
    vi.mocked(postFunction).mockImplementation(async (endpoint, _token, body) => {
      if (endpoint === "cmsRequestVideoClip") return { success: true, clip: { ...clip, state: "queued" } };
      return (body as { clipId?: string })?.clipId ? { success: true, clip } : { success: true, clips: [clip] };
    });
    render(<Harness video={{ ...asset, viewingCopy: { ...asset.viewingCopy!, width: 1280, height: 720 } }} />);
    await openClip();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /00:00:01.000 to 00:00:02.000/ })); });
    expect(screen.getByRole("combobox", { name: "Clip resolution" })).toHaveValue("720p");
    expect(screen.getByRole("option", { name: "1080p" })).toBeDisabled();
    fireEvent.change(screen.getByRole("combobox", { name: "Clip resolution" }), { target: { value: "480p" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Clip quality" }), { target: { value: "smaller" } });
    fireEvent.change(screen.getByRole("textbox", { name: "In time" }), { target: { value: "999" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Retry clip" })); });
    const request = vi.mocked(postFunction).mock.calls.find(([endpoint]) => endpoint === "cmsRequestVideoClip");
    expect(request?.[2]).toMatchObject({ inMs: 1000, outMs: 2000, resolution: "720p", quality: "high", retry: true });
  });

  it("keeps an older file's clip downloadable without offering the current transcript", async () => {
    const clip = { id: "c".repeat(64), state: "ready", inMs: 1000, outMs: 2000, durationMs: 1000,
      expiresAt: "2099-01-01T00:00:00Z", matchesCurrentFile: false };
    vi.mocked(postFunction).mockImplementation(async (endpoint, _token, body) => {
      if (endpoint === "cmsGetVideoTranscript") return response("ready");
      return (body as { clipId?: string })?.clipId ? { success: true, clip } : { success: true, clips: [clip] };
    });
    render(<Harness />);
    await openTranscript(); await openClip();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /00:00:01.000 to 00:00:02.000/ })); });
    expect(screen.getByRole("button", { name: "Download clip" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Download clip transcript" })).not.toBeInTheDocument();
    expect(screen.getByText("This clip uses a previous video file. Its transcript is unavailable here.")).toBeVisible();
    expect(vi.mocked(postFunction).mock.calls.some(([endpoint]) => endpoint === "cmsCreateVideoTranscriptRead")).toBe(false);
  });

  it("downloads the selected saved clip transcript after draft bounds change without requesting processing", async () => {
    const clip = { id: "c".repeat(64), state: "ready", inMs: 1000, outMs: 2000, durationMs: 1000, expiresAt: "2099-01-01T00:00:00Z" };
    const createObjectURL = vi.fn().mockReturnValue("blob:clip-transcript");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", class extends URL { static createObjectURL = createObjectURL; static revokeObjectURL = revokeObjectURL; });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    vi.mocked(postFunction).mockImplementation(async (endpoint, _token, body) => {
      if (endpoint === "cmsGetVideoTranscript") return response("ready");
      if (endpoint === "cmsCreateVideoTranscriptRead") return { success: true, clipId: clip.id, inMs: 1000, outMs: 2000, body: "Matching words", contentType: "text/plain", filename: "clip-transcript.txt" };
      return (body as { clipId?: string })?.clipId ? { success: true, clip } : { success: true, clips: [clip] };
    });
    render(<Harness />);
    await openTranscript();
    await openClip();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /00:00:01.000 to 00:00:02.000/ })); });
    fireEvent.change(screen.getByRole("textbox", { name: "In time" }), { target: { value: "5" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Download clip transcript" })); });
    expect(postFunction).toHaveBeenCalledWith("cmsCreateVideoTranscriptRead", "staff-token", expect.objectContaining({ clipId: clip.id, transcriptId: "saved-transcript", format: "txt" }), {}, { appCheck: true });
    expect(vi.mocked(postFunction).mock.calls.some(([endpoint]) => endpoint === "cmsRequestVideoClip" || endpoint === "cmsRequestVideoTranscript")).toBe(false);
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:clip-transcript");
    click.mockRestore();
    vi.unstubAllGlobals();
  });

  it("explains local-first processing and possible AWS cost before a request", async () => {
    vi.mocked(postFunction).mockResolvedValue({ ...response("not_requested"), requestPolicy: { enabled: true, provider: "local-whisper", fallbackEnabled: true } });
    render(<Harness />);
    await openTranscript();
    expect(screen.getByText(/Transcripts are free on our own machine/)).toBeInTheDocument();
    const estimate = screen.getByText(/Possible AWS charge for this video: \$0.006/);
    expect(estimate).not.toBeVisible();
    fireEvent.click(screen.getByText("Paid backup details"));
    expect(estimate).toBeVisible();
    expect(screen.getByRole("button", { name: "Transcribe video" })).toBeEnabled();
    expect(vi.mocked(postFunction).mock.calls.every(([endpoint]) => endpoint === "cmsGetVideoTranscript")).toBe(true);
  });

  it("stops automatic polling when a transcript needs reconciliation and keeps manual checks safe", async () => {
    vi.mocked(postFunction).mockResolvedValueOnce(response("queued")).mockResolvedValue(response("needs_reconciliation"));
    render(<Harness />);
    await openTranscript();
    expect(screen.getByRole("button", { name: "Queued" })).toBeDisabled();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.getByText("Needs attention")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(postFunction).toHaveBeenCalledTimes(2);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Check saved status" })); });
    expect(postFunction).toHaveBeenCalledTimes(3);
    expect(vi.mocked(postFunction).mock.calls.every(([endpoint]) => endpoint === "cmsGetVideoTranscript")).toBe(true);
  });

  it("retains the last confirmed status during a failed refresh without exposing raw errors", async () => {
    let rejectCheck!: (error: Error) => void;
    vi.mocked(postFunction).mockResolvedValueOnce(response("needs_reconciliation")).mockImplementationOnce(() => new Promise((_, reject) => { rejectCheck = reject; }));
    render(<Harness />);
    await openTranscript();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Check saved status" })); });
    expect(screen.getByText("Needs attention")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Checking saved status" })).toBeDisabled();
    await act(async () => { rejectCheck(new Error("Private provider key: test-secret-value")); });
    expect(screen.getByText("Needs attention")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check saved status" })).toBeEnabled();
    expect(screen.getByText(/saved transcript could not be checked/)).toBeInTheDocument();
    expect(screen.queryByText(/test-secret-value/)).not.toBeInTheDocument();
  });
});


describe("controlled request errors", () => {
  it("shows a quota refusal without losing the selected clip range", async () => {
    const message = "Your daily allowance of 30 video exports has been reached. 0 exports remain. Resets at 00:00 UTC on 2026-10-01.";
    vi.mocked(postFunction).mockImplementation(async endpoint => {
      if (endpoint === "cmsRequestVideoClip") throw Object.assign(new Error(message), { status: 429, data: { code: "clip_export_quota" } });
      return { success: true, clips: [] };
    });
    render(<Harness />); await openClip();
    fireEvent.change(screen.getByRole("textbox", { name: "In time" }), { target: { value: "1" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Out time" }), { target: { value: "5" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Export clip" })); });
    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(screen.getByRole("textbox", { name: "In time" })).toHaveValue("1");
    expect(screen.getByRole("textbox", { name: "Out time" })).toHaveValue("5");
    expect(screen.getByRole("button", { name: "Export clip" })).toBeEnabled();
  });
  it.each([
    ["request_transcript", 409, "Prepare the viewing copy before transcribing", "Reopen the video"],
    ["request_transcript", 409, "Paid transcription supports videos of one hour or less. Ask an administrator about local processing for longer videos", "one hour or less"],
    ["request_transcript", 429, "The station has 500 queued or running local transcripts. Wait for a transcript to finish, then try again", "500 local transcripts queued or running"],
    ["request_clip", 409, "Choose a range within a ready web viewing copy", "select the range again"],
    ["request_clip", 429, "Wait for your current clip export to finish", "active clip export"],
    ["request_clip", 429, "Unknown limit detail", "request limit"],
  ] as const)("gives safe %s recovery for %s %s", (operation, status, detail, expected) => {
    expect(videoProductionMessage(Object.assign(new Error(detail), { status }), "fallback", operation)).toContain(expected);
  });
  it("does not expose unknown provider details", () => {
    expect(videoProductionMessage(Object.assign(new Error("private provider key"), { status: 500 }), "Safe fallback", "request_clip")).toBe("Safe fallback");
  });
  it("gives recovery when browser verification stops the request", () => {
    const error = Object.assign(new Error("App Check retry failed"), {
      name: "RequestNotDispatchedError",
    });
    expect(videoProductionMessage(error, "Safe fallback", "request_clip"))
      .toBe("Browser verification failed. Reload Boardwalk, then try again.");
  });
});

it("holds the transcript section and language while a review save is pending", async () => {
  const transcript = { id: "saved-transcript", state: "ready", editRevision: 0, totalSegments: 1, segments: [{ index: 0, speaker: "spk_0", startSeconds: 1, endSeconds: 2, text: "Saved passage" }], nextCursor: null };
  let finish!: (value: unknown) => void;
  vi.mocked(postFunction).mockImplementation(async endpoint => endpoint === "cmsSaveVideoTranscript" ? new Promise(resolve => { finish = resolve; }) : { success: true, cached: true, transcript });
  render(<Harness />);
  await openTranscript();
  fireEvent.click(screen.getByRole("checkbox", { name: "I checked the entire transcript against the audio" }));
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Mark transcript reviewed" })); });
  expect(vi.mocked(postFunction).mock.calls.find(([endpoint]) => endpoint === "cmsSaveVideoTranscript")?.[2]).toEqual({ sourceId: asset.sourceId, assetId: asset.id, transcriptId: transcript.id, revision: 0, reviewed: true });
  expect(screen.getByRole("combobox", { name: "Spoken language" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Download soundbite log" })).toBeDisabled();
  const disclosure = screen.getByText("Transcript", { selector: "summary" }).closest("details")!;
  expect(disclosure).toHaveAttribute("data-viewer-keys", "off");
  await act(async () => { disclosure.open = false; fireEvent(disclosure, new Event("toggle")); });
  expect(disclosure.open).toBe(true);
  await act(async () => { finish({ success: true, cached: true, transcript: { ...transcript, editRevision: 1, reviewedRevision: 1 } }); });
  expect(screen.getByRole("combobox", { name: "Spoken language" })).toBeEnabled();
});

it("explains missing Premiere word alignment without exposing unknown errors", () => {
  const error = Object.assign(new Error("Premiere export requires unchanged word timings for every passage. Use the text or TSV log for corrected transcripts"), { status: 409 });
  expect(videoProductionMessage(error, "Safe fallback", "download_premiere")).toContain("Download text or the soundbite log");
  expect(videoProductionMessage(Object.assign(new Error("private provider detail"), { status: 409 }), "Safe fallback", "download_premiere")).toBe("Safe fallback");
});


it.each([
  [{ enabled: true, provider: "local-whisper", fallbackEnabled: true, paidFallbackProviders: ["elevenlabs", "amazon-transcribe"] }, /ElevenLabs is tried first with the station key/, true, true],
  [{ enabled: true, provider: "local-whisper", fallbackEnabled: false }, /Paid backup is off/, true, false],
  [{ enabled: true, provider: "elevenlabs", fallbackEnabled: true }, /try ElevenLabs with the station key first/, true, true],
  [{ enabled: true, provider: "amazon-transcribe", fallbackEnabled: false }, /Requests use Amazon Transcribe/, true, true],
  [{ enabled: false, provider: "local-whisper", fallbackEnabled: false }, /currently unavailable/, false, false],
  [undefined, /provider could not be verified/, false, false],
  [{ enabled: true, provider: "unknown-provider", fallbackEnabled: true }, /provider could not be verified/, false, false],
] as const)("uses verified request policy %j", async (requestPolicy, copy, enabled, estimate) => {
  vi.mocked(postFunction).mockResolvedValue({ ...response("not_requested"), requestPolicy });
  render(<Harness />); await openTranscript();
  expect(screen.getByText(copy)).toBeInTheDocument();
  const button = screen.getByRole("button", { name: "Transcribe video" });
  if (enabled) expect(button).toBeEnabled(); else expect(button).toBeDisabled();
  expect(Boolean(screen.queryByText(/Possible AWS charge for this video/))).toBe(estimate);
  if (requestPolicy?.provider !== "local-whisper" || !requestPolicy.enabled) expect(screen.queryByText(/Requests go to Local worker/)).not.toBeInTheDocument();
  if (!enabled) {
    await act(async () => { fireEvent.click(button); });
    expect(vi.mocked(postFunction).mock.calls.some(call => call[0] === "cmsRequestVideoTranscript")).toBe(false);
    expect(screen.getByRole("button", { name: "Check availability" })).toBeEnabled();
  }
});

it("gives a recovery action for expired clips and invalid transcript timing", () => {
  const message = (detail: string) => videoProductionMessage(Object.assign(new Error(detail), { status: 409 }), "Safe fallback", "download_clip_transcript");
  expect(message("Choose a ready clip that has not expired")).toContain("export it again");
  expect(message("Transcript has invalid passage timing")).toContain("resync");
  expect(message("Clip exceeds transcript audio duration")).toContain("new clip");
});


it("keeps unrelated draft focus when an export-settings transcript becomes ready in the background", async () => {
  vi.mocked(postFunction).mockResolvedValue(response("queued"));
  render(<><input aria-label="Unrelated draft" /><Harness frame /></>);
  const transcriptDetails = screen.getByText("Transcript", { selector: "summary" }).closest("details")!;
  // jsdom has no native scrolling; this test observes actual DOM focus instead.
  transcriptDetails.scrollIntoView = vi.fn();
  fireEvent.click(screen.getByRole("button", { name: "Download" }));
  await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: "Transcript export settings…" })); });
  await act(async () => { vi.advanceTimersToNextFrame(); });
  const draft = screen.getByRole("textbox", { name: "Unrelated draft" });
  draft.focus();
  expect(draft).toHaveFocus();
  vi.mocked(postFunction).mockResolvedValue(response("ready"));
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(screen.getByText("Editing software exports", { selector: "summary" })).toBeVisible();
  expect(draft).toHaveFocus();
});


it.each(["processing", "failed", "not_prepared"] as const)("does not imply an active transcript check for a %s web copy", async state => {
  await act(async () => { render(<Harness frame workspace video={{ ...asset, viewingCopy: { ...asset.viewingCopy!, state } }} />); });
  expect(screen.getByText(/A ready web copy is required to open a saved transcript/)).toBeVisible();
  expect(screen.queryByText("Checking for a saved transcript.")).not.toBeInTheDocument();
  expect(postFunction).not.toHaveBeenCalled();
});

it("shows a failed saved-transcript read instead of a continuing check in its empty pane", async () => {
  vi.mocked(postFunction).mockRejectedValue(new Error("Unavailable fixture"));
  await act(async () => { render(<Harness frame workspace />); });
  expect(screen.getAllByText(/The saved transcript could not be checked/).length).toBeGreaterThan(0);
  expect(screen.queryByText(/^Checking for a saved transcript/)).not.toBeInTheDocument();
  expect(vi.mocked(postFunction).mock.calls.every(([name]) => name === "cmsGetVideoTranscript")).toBe(true);
});

it("gives a safe recovery when old paid accounting cannot be verified", () => {
  const error = Object.assign(new Error("The paid transcript allowance cannot be verified. Ask an administrator to check paid limits or enable local processing"), { status: 429 });
  expect(videoProductionMessage(error, "Safe fallback", "request_transcript")).toBe("The paid transcript allowance cannot be verified. Ask a CMS administrator to check paid limits or enable local processing.");
});
