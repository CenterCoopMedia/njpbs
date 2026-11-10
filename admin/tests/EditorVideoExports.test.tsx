import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorVideoExports } from "../src/components/EditorVideoExports";
import { postFunction } from "../src/lib/functions";

vi.mock("../src/lib/functions", () => ({ postFunction: vi.fn() }));
const identity = { sourceId: "video-library", assetId: "video-1" };
const getIdToken = vi.fn().mockResolvedValue("staff-token");
const props = { identity, name: "Interview", getIdToken, canRequest: true, disabled: false,
  inMs: 1000, outMs: 2000, validRange: true, exportEligible: true, transcriptReady: true, transcriptLocked: false, transcriptRevision: 0,
  transcriptSettings: { languageCode: "en-US" as const, maxSpeakers: 2 } };
const clip = { id: "clip-1", attemptId: "attempt-1", format: "broadcast_mxf", scope: "clip",
  state: "queued", inMs: 1000, outMs: 2000, canCancel: true, expiresAt: null };
let enabled = true;
let history: unknown[] = [];

async function open() {
  const details = screen.getByText("Broadcast and editing exports").closest("details")!;
  await act(async () => { details.open = true; fireEvent(details, new Event("toggle")); });
}
async function click(name: string | RegExp) {
  await act(async () => { fireEvent.click(screen.getByRole("button", { name })); });
}

beforeEach(() => {
  vi.useFakeTimers(); enabled = true; history = [];
  getIdToken.mockReset().mockResolvedValue("staff-token");
  vi.mocked(postFunction).mockReset().mockImplementation(async (endpoint, _token, body) => {
    if (endpoint === "cmsGetVideoClip") return (body as { clipId?: string }).clipId
      ? { success: true, editorExportsEnabled: enabled, clip }
      : { success: true, editorExportsEnabled: enabled, clips: history };
    return { success: true, clip };
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("editor video exports", () => {
  it.each([
    [429, { code: "clip_export_quota" }, "This export exceeds the station's remaining daily editor export duration. 3 seconds remain of 345600 seconds. Resets at 00:00 UTC on 2026-10-01."],
    [409, { code: "original_archived" }, "The original is archived. Restore it before exporting."],
    [429, {}, "Wait for the current original-range extraction to finish"],
  ])("preserves actionable export refusal %s %s", async (status, data, message) => {
    const original = vi.mocked(postFunction).getMockImplementation()!;
    vi.mocked(postFunction).mockImplementation((...args) => args[0] === "cmsRequestVideoClip"
      ? Promise.reject(Object.assign(new Error(message), { status, data })) : original(...args));
    render(<EditorVideoExports {...props} />); await open();
    await click("Export video");
    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(screen.getByRole("button", { name: "Export video" })).toBeEnabled();
    expect(screen.getByRole("combobox", { name: "Export range" })).toHaveValue("clip");
  });
  it("keeps saved downloads available when full-video admission is ineligible", async () => {
    history = [{ ...clip, state: "ready" }];
    render(<EditorVideoExports {...props} exportEligible={false} />); await open();
    await act(async () => fireEvent.change(screen.getByRole("combobox", { name: "Export range" }), { target: { value: "source" } }));
    expect(screen.getByRole("button", { name: "Export video" })).toBeDisabled();
    await click(/MXF \/ XDCAM/);
    expect(screen.getByRole("button", { name: "Download video" })).toBeEnabled();
    expect(vi.mocked(postFunction).mock.calls.some(([endpoint]) => endpoint === "cmsRequestVideoClip")).toBe(false);
  });

  it.each([
    ["broadcast_mp4", /MP4 \/ Frame rate copy/],
    ["broadcast_mxf", /MXF \/ XDCAM HD422/],
    ["prores_mov", /MOV \/ ProRes 422 HQ/],
    ["avid_mxf", /MXF \/ DNxHD/],
  ] as const)("keeps old-file %s downloads while explaining its unavailable matching transcript", async (format, label) => {
    history = [{ ...clip, format, state: "ready", canCancel: false, matchesCurrentFile: false }];
    const original = vi.mocked(postFunction).getMockImplementation()!;
    vi.mocked(postFunction).mockImplementation((...args) => args[0] === "cmsCreateVideoClipRead"
      ? Promise.resolve({ success: true, access: { url: "https://media.example.test/saved-editor-export" } }) : original(...args));
    const download = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<EditorVideoExports {...props} />); await open(); await click(label);
    expect(screen.getByRole("button", { name: "Download video" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Download matching transcript" })).not.toBeInTheDocument();
    expect(screen.getByText("This export uses a previous video file. Its transcript is unavailable here.")).toBeInTheDocument();
    await click("Download video");
    expect(download).toHaveBeenCalledTimes(1);
    expect(vi.mocked(postFunction).mock.calls.some(([endpoint]) => endpoint === "cmsCreateVideoTranscriptRead")).toBe(false);
    expect(vi.mocked(postFunction).mock.calls.some(([endpoint]) => endpoint === "cmsRequestVideoClip")).toBe(false);
  });

  it("reloads the history cursor after replacing a failed export", async () => {
    let replaced = false;
    const saved = { ...clip, state: "failed", canRetry: true };
    vi.mocked(postFunction).mockImplementation(async (endpoint, _token, body) => {
      if (endpoint === "cmsRequestVideoClip") { replaced = true; return { success: true, clip }; }
      if ((body as { cursor?: string }).cursor) return { success: true, clips: [], nextCursor: null };
      return { success: true, editorExportsEnabled: true, clips: [saved], nextCursor: replaced ? "fresh-cursor" : "old-cursor" };
    });
    render(<EditorVideoExports {...props} />); await open(); await click(/MXF \/ XDCAM/);
    await click("Retry export"); await click("Load older editor exports");
    expect(vi.mocked(postFunction).mock.calls.at(-1)?.[2]).toEqual({ ...identity, scope: "clip", cursor: "fresh-cursor" });
  });

  it("discards a pre-edit transcript after the same selection is saved at a new revision", async () => {
    history = [{ ...clip, state: "ready" }];
    let finish!: (value: unknown) => void;
    const original = vi.mocked(postFunction).getMockImplementation()!;
    vi.mocked(postFunction).mockImplementation((...args) => args[0] === "cmsCreateVideoTranscriptRead"
      ? new Promise(resolve => { finish = resolve; }) : original(...args));
    const download = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const view = render(<EditorVideoExports {...props} />); await open(); await click(/MXF \/ XDCAM/);
    await click("Download matching transcript");
    view.rerender(<EditorVideoExports {...props} transcriptLocked />);
    view.rerender(<EditorVideoExports {...props} transcriptRevision={1} />);
    await act(async () => finish({ success: true, revision: 0, clipId: clip.id, inMs: 1000, outMs: 2000,
      body: "Old passage", contentType: "text/plain", filename: "clip.txt" }));
    expect(download).not.toHaveBeenCalled();
  });

  it("keeps older editor exports reachable after a page containing only MP4 clips", async () => {
    const cursor = "a".repeat(64);
    vi.mocked(postFunction).mockImplementation(async (_endpoint, _token, body) =>
      (body as { clipId?: string }).clipId ? { success: true, clip: { ...clip, state: "ready" } } : (body as { cursor?: string }).cursor
        ? { success: true, editorExportsEnabled: true, clips: [clip], nextCursor: null }
        : { success: true, editorExportsEnabled: true, clips: Array.from({ length: 10 }, (_, id) => ({ ...clip, id: String(id), format: "web_mp4" })), nextCursor: cursor });
    render(<EditorVideoExports {...props} />); await open();
    expect(screen.queryByRole("button", { name: /MXF \/ XDCAM/ })).not.toBeInTheDocument();
    await click("Load older editor exports");
    expect(screen.getByRole("button", { name: /MXF \/ XDCAM/ })).toBeEnabled();
    expect(vi.mocked(postFunction).mock.calls.at(-1)?.[2]).toEqual({ ...identity, scope: "clip", cursor });
    await click(/MXF \/ XDCAM/);
    await click("Check export status");
    expect(screen.getByRole("button", { name: /MXF \/ XDCAM.*ready/ })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Load older editor exports" })).not.toBeInTheDocument();
    expect(vi.mocked(postFunction).mock.calls.filter(([, , body]) => !(body as { clipId?: string }).clipId)).toHaveLength(2);
  });

  it("retains history and capability while refreshing and does not reload them on each unchanged status poll", async () => {
    history = [clip]; render(<EditorVideoExports {...props} />); await open();
    await click(/MXF \/ XDCAM HD422/);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(vi.mocked(postFunction).mock.calls.filter(([, , body]) => !(body as { clipId?: string }).clipId)).toHaveLength(1);
    let finish!: (value: unknown) => void;
    vi.mocked(postFunction).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await click("Refresh export history");
    expect(screen.getByRole("button", { name: /MXF \/ XDCAM HD422/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Export video" })).toBeDisabled();
    expect(screen.queryByText("Editor exports are not enabled.", { exact: false })).not.toBeInTheDocument();
    await act(async () => finish({ success: true, editorExportsEnabled: true, clips: [clip] }));
  });

  it("waits for the server capability and preserves history while disabled", async () => {
    enabled = false; history = [clip];
    render(<EditorVideoExports {...props} />);
    expect(postFunction).not.toHaveBeenCalled();
    await open();
    expect(screen.getByRole("button", { name: "Export video" })).toBeDisabled();
    await click(/MXF \/ XDCAM HD422/);
    expect(screen.getByRole("button", { name: "Check export status" })).toBeEnabled();
  });

  it("submits full-source conversion without clip or web-quality fields", async () => {
    render(<EditorVideoExports {...props} validRange={false} />); await open();
    await act(async () => fireEvent.change(screen.getByRole("combobox", { name: "Export range" }), { target: { value: "source" } }));
    fireEvent.change(screen.getByRole("combobox", { name: "Video format" }), { target: { value: "prores_mov" } });
    await click("Export video");
    expect(vi.mocked(postFunction).mock.calls.find(([endpoint]) => endpoint === "cmsRequestVideoClip")?.[2])
      .toEqual({ ...identity, scope: "source", format: "prores_mov", frameRateMode: "broadcast" });
  });

  it("sends the selected clip range and prevents a duplicate pending request", async () => {
    let finish!: (value: unknown) => void;
    const original = vi.mocked(postFunction).getMockImplementation()!;
    vi.mocked(postFunction).mockImplementation((...args) => args[0] === "cmsRequestVideoClip"
      ? new Promise(resolve => { finish = resolve; }) : original(...args));
    render(<EditorVideoExports {...props} />); await open();
    await click("Export video");
    expect(screen.getByRole("button", { name: "Sending export request" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Sending export request" }));
    const requests = vi.mocked(postFunction).mock.calls.filter(([endpoint]) => endpoint === "cmsRequestVideoClip");
    expect(requests).toHaveLength(1);
    expect(requests[0][2]).toEqual({ ...identity, scope: "clip", format: "broadcast_mxf", frameRateMode: "broadcast", inMs: 1000, outMs: 2000 });
    await act(async () => finish({ success: true, clip }));
  });

  it("cancels only the selected saved attempt", async () => {
    history = [clip]; render(<EditorVideoExports {...props} />); await open();
    await click(/MXF \/ XDCAM HD422/); await click("Cancel queued export");
    expect(vi.mocked(postFunction).mock.calls.find(([endpoint]) => endpoint === "cmsCancelVideoClip")?.[2])
      .toEqual({ ...identity, clipId: "clip-1", attemptId: "attempt-1" });
  });

  it("does not start a paid request if permission changes while the token is pending", async () => {
    const view = render(<EditorVideoExports {...props} />); await open();
    let token!: (value: string) => void;
    getIdToken.mockImplementationOnce(() => new Promise(resolve => { token = resolve; }));
    await click("Export video");
    view.rerender(<EditorVideoExports {...props} canRequest={false} />);
    await act(async () => token("staff-token"));
    expect(vi.mocked(postFunction).mock.calls.some(([endpoint]) => endpoint === "cmsRequestVideoClip")).toBe(false);
  });

  it("retries the saved format and range instead of changed draft controls", async () => {
    history = [{ ...clip, state: "failed", canCancel: false, canRetry: true }];
    render(<EditorVideoExports {...props} />); await open(); await click(/MXF \/ XDCAM HD422/);
    fireEvent.change(screen.getByRole("combobox", { name: "Video format" }), { target: { value: "avid_mxf" } });
    await click("Retry export");
    expect(vi.mocked(postFunction).mock.calls.find(([endpoint]) => endpoint === "cmsRequestVideoClip")?.[2])
      .toEqual({ ...identity, scope: "clip", format: "broadcast_mxf", inMs: 1000, outMs: 2000, retry: true });
  });

  it("does not offer a partial transcript for a full-source export", async () => {
    history = [{ ...clip, scope: "source", state: "ready", inMs: undefined, outMs: undefined }];
    render(<EditorVideoExports {...props} />); await open(); await click(/MXF \/ XDCAM HD422/);
    expect(screen.getByRole("button", { name: "Download video" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Download matching transcript" })).not.toBeInTheDocument();
  });

  it("discards a transcript download after the selected transcript changes", async () => {
    history = [{ ...clip, state: "ready", canCancel: false }];
    let finish!: (value: unknown) => void;
    const original = vi.mocked(postFunction).getMockImplementation()!;
    vi.mocked(postFunction).mockImplementation((...args) => args[0] === "cmsCreateVideoTranscriptRead"
      ? new Promise(resolve => { finish = resolve; }) : original(...args));
    const clickDownload = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const view = render(<EditorVideoExports {...props} />); await open(); await click(/MXF \/ XDCAM HD422/);
    await click("Download matching transcript");
    view.rerender(<EditorVideoExports {...props} transcriptSettings={{ ...props.transcriptSettings, transcriptId: "other" }} />);
    await act(async () => finish({ success: true, clipId: clip.id, inMs: 1000, outMs: 2000,
      body: "Saved passage", contentType: "text/plain", filename: "clip.txt" }));
    expect(clickDownload).not.toHaveBeenCalled();
  });
});


describe("broadcast frame rate workflow", () => {
  const sourceRate = { sourceFrameRateNumerator: 25, sourceFrameRateDenominator: 1 };
  it("shows a notice without blocking exports and submits an explicit keep-source choice", async () => {
    render(<EditorVideoExports {...props} sourceRate={sourceRate} sourceDurationSeconds={120} />); await open();
    expect(screen.getByRole("button", { name: "Export video" })).toBeEnabled();
    expect(screen.getByRole("combobox", { name: "Export frame rate" })).toHaveValue("broadcast");
    fireEvent.change(screen.getByRole("combobox", { name: "Export frame rate" }), { target: { value: "source" } });
    await click("Export video");
    expect(vi.mocked(postFunction).mock.calls.find(([endpoint]) => endpoint === "cmsRequestVideoClip")?.[2])
      .toMatchObject({ frameRateMode: "source", format: "broadcast_mxf" });
  });
  it("offers every standard choice, marks XDCAM exclusions and shows a saved choice", async () => {
    history = [{ ...clip, frameRateMode: "60000/1001" }];
    render(<EditorVideoExports {...props} sourceRate={sourceRate} />); await open();
    const select = screen.getByRole("combobox", { name: "Export frame rate" }) as HTMLSelectElement;
    expect([...select.options].map(option => option.value)).toEqual(["broadcast", "source", "24000/1001", "24/1", "25/1", "30/1", "50/1", "60000/1001", "60/1"]);
    expect([...select.options].filter(option => option.disabled).map(option => option.value)).toEqual(["24/1", "30/1", "60/1"]);
    await click(/MXF \/ XDCAM HD422/);
    expect(screen.getByRole("region", { name: "Selected editor export" })).toHaveTextContent("Chosen rate: 59.94 fps (60000/1001)");
    expect(screen.getByRole("button", { name: /MXF \/ XDCAM HD422/ })).toHaveTextContent("59.94 fps (60000/1001)");
  });
  it("prepares a full-source copy with a price before any paid request", async () => {
    render(<EditorVideoExports {...props} sourceRate={sourceRate} sourceDurationSeconds={120} validRange={false} />);
    await click("Prepare 29.97 fps copy");
    expect(screen.getByRole("combobox", { name: "Export range" })).toHaveValue("source");
    expect(screen.getByRole("combobox", { name: "Video format" })).toHaveValue("broadcast_mp4");
    expect(screen.getByRole("combobox", { name: "Export frame rate" })).toBeEnabled();
    expect(screen.getByText(/Estimated MediaConvert charge before request/)).toHaveTextContent("$0.048");
    expect(vi.mocked(postFunction).mock.calls.some(([endpoint]) => endpoint === "cmsRequestVideoClip")).toBe(false);
    await click("Export video");
    expect(vi.mocked(postFunction).mock.calls.find(([endpoint]) => endpoint === "cmsRequestVideoClip")?.[2])
      .toEqual({ ...identity, scope: "source", format: "broadcast_mp4", frameRateMode: "broadcast" });
  });
  it("uses original download for a measured 29.97 source without a conversion request", async () => {
    const onDownloadOriginal = vi.fn();
    render(<EditorVideoExports {...props} sourceRate={{ sourceFrameRateNumerator: 30000, sourceFrameRateDenominator: 1001 }} onDownloadOriginal={onDownloadOriginal} />);
    expect(screen.queryByRole("button", { name: "Prepare 29.97 fps copy" })).not.toBeInTheDocument();
    await click("Download 29.97 fps original");
    expect(onDownloadOriginal).toHaveBeenCalledOnce();
    expect(vi.mocked(postFunction).mock.calls.some(([endpoint]) => endpoint === "cmsRequestVideoClip")).toBe(false);
  });
  it("lets staff choose a standard rate and saves that choice", async () => {
    render(<EditorVideoExports {...props} sourceRate={sourceRate} sourceDurationSeconds={120} />); await open();
    fireEvent.change(screen.getByRole("combobox", { name: "Video format" }), { target: { value: "prores_mov" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Export frame rate" }), { target: { value: "60000/1001" } });
    expect(screen.getByText(/Estimated MediaConvert charge before request/)).toHaveTextContent("$0.005 to $0.02");
    await click("Export video");
    expect(vi.mocked(postFunction).mock.calls.find(([endpoint]) => endpoint === "cmsRequestVideoClip")?.[2])
      .toMatchObject({ frameRateMode: "60000/1001", format: "prores_mov" });
  });
  it("avoids a matching-rate MP4 request but allows another target rate", async () => {
    render(<EditorVideoExports {...props} sourceRate={{ sourceFrameRateNumerator: 30000, sourceFrameRateDenominator: 1001 }} sourceDurationSeconds={120} />); await open();
    await act(async () => fireEvent.change(screen.getByRole("combobox", { name: "Export range" }), { target: { value: "source" } }));
    fireEvent.change(screen.getByRole("combobox", { name: "Video format" }), { target: { value: "broadcast_mp4" } });
    expect(screen.getByRole("button", { name: "Export video" })).toBeDisabled();
    fireEvent.change(screen.getByRole("combobox", { name: "Export frame rate" }), { target: { value: "25/1" } });
    await click("Export video");
    expect(vi.mocked(postFunction).mock.calls.find(([endpoint]) => endpoint === "cmsRequestVideoClip")?.[2])
      .toMatchObject({ scope: "source", frameRateMode: "25/1", format: "broadcast_mp4" });
  });
  it("retries the saved source-rate choice after the current control changes", async () => {
    history = [{ ...clip, state: "failed", canRetry: true, frameRateMode: "source" }];
    render(<EditorVideoExports {...props} sourceRate={sourceRate} />); await open(); await click(/MXF \/ XDCAM HD422/);
    expect(screen.getByRole("combobox", { name: "Export frame rate" })).toHaveValue("broadcast");
    await click("Retry export");
    expect(vi.mocked(postFunction).mock.calls.find(([endpoint]) => endpoint === "cmsRequestVideoClip")?.[2])
      .toMatchObject({ frameRateMode: "source", retry: true });
  });
});
