import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VideoOrientationExport, useVideoExportCompletion } from "../src/components/media/VideoOrientationExport";
import type { SourceMediaAssetSummary } from "../src/lib/source-media";

// Firebase identity and the network are the boundaries; the real HTTP helpers run.
vi.mock("../src/lib/firebase", () => ({ auth: { currentUser: null }, firebaseConfig: { projectId: "demo-njpbs" }, getRequiredAppCheckToken: async () => null }));
const asset: SourceMediaAssetSummary = { id: "video-fixture", sourceId: "video-library", kind: "video", name: "County meeting",
  originalName: "meeting.mp4", description: "Meeting", mimeType: "video/mp4", sizeBytes: 1024, preview: "browser",
  credit: "NJ PBS", license: "Station owned", tags: [], rightsStatus: "complete", version: 2,
  fileVersion: "v1", createdAt: null, updatedAt: null, uploadedBy: null,
  viewingCopy: { state: "ready", durationSeconds: 2 } };
const job = (overrides = {}) => ({ id: "e".repeat(64), orientation: "vertical", state: "queued", outputAssetId: null,
  errorCode: null, requestedAt: "2026-11-09T12:00:00Z", updatedAt: "2026-11-09T12:00:00Z", ...overrides });
const requests: { endpoint: string; body: Record<string, unknown> }[] = [];
let exports: ReturnType<typeof job>[] = [];
let workerReady = true;

beforeEach(() => {
  requests.length = 0; exports = []; workerReady = true;
  vi.stubGlobal("fetch", vi.fn(async (input, init) => {
    const endpoint = String(input).split("/").at(-1)!;
    const body = JSON.parse(String(init?.body ?? "{}"));
    requests.push({ endpoint, body });
    return endpoint === "cmsRequestVideoOrientationExport"
      ? Response.json({ success: true, export: job({ orientation: body.orientation }), cached: false })
      : Response.json({ success: true, exports, workerReady });
  }));
});
afterEach(() => vi.unstubAllGlobals());

function show(overrides: Partial<SourceMediaAssetSummary> = {}) {
  return render(<MemoryRouter><VideoOrientationExport asset={{ ...asset, ...overrides }} getIdToken={async () => "token"} /></MemoryRouter>);
}

const token = async () => "token";
function Library({ open = true, onCreated }: { open?: boolean; onCreated: () => void }) {
  const onStatus = useVideoExportCompletion(onCreated);
  return <MemoryRouter>{open ? <VideoOrientationExport asset={asset} getIdToken={token} onStatus={onStatus} /> : null}</MemoryRouter>;
}

describe("social format export", () => {
  it("queues a vertical export and keeps that format busy until it finishes", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Export vertical (9:16, 1080 × 1920)" }));
    expect(await screen.findByText("Vertical export is waiting for the media worker.")).toBeTruthy();
    expect(requests.at(-1)).toEqual({ endpoint: "cmsRequestVideoOrientationExport",
      body: { sourceId: "video-library", assetId: "video-fixture", orientation: "vertical" } });
    expect(screen.getByRole("button", { name: /Export vertical/ }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: /Export horizontal/ }).hasAttribute("disabled")).toBe(false);
  });

  it("keeps a new export when an older status read finishes later", async () => {
    let finishRead!: () => void;
    const fetchMock = vi.mocked(fetch);
    const answer = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementationOnce(async (input, init) => {
      await new Promise<void>(resolve => { finishRead = resolve; });
      return answer(input, init);
    });
    show();
    fireEvent.click(await screen.findByRole("button", { name: /Export vertical/ }));
    expect(await screen.findByText("Vertical export is waiting for the media worker.")).toBeTruthy();
    finishRead();
    await vi.waitFor(() => expect(requests.filter(({ endpoint }) => endpoint === "cmsListVideoOrientationExports")).toHaveLength(1));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(screen.getByText("Vertical export is waiting for the media worker.")).toBeTruthy();
  });

  it("says when the media worker is away and still accepts exports", async () => {
    workerReady = false;
    show();
    expect(await screen.findByText(/The media worker is not running exports right now/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Export vertical/ }).hasAttribute("disabled")).toBe(false);
  });

  it("tells the library once when a watched export saves its video", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const onCreated = vi.fn();
      render(<Library onCreated={onCreated} />);
      fireEvent.click(await screen.findByRole("button", { name: /Export vertical/ }));
      await screen.findByText("Vertical export is waiting for the media worker.");
      exports = [job({ state: "complete", outputAssetId: "new-video" })];
      await act(() => vi.advanceTimersByTimeAsync(15_000));
      await screen.findByRole("link", { name: "Open vertical video" });
      await act(() => vi.advanceTimersByTimeAsync(15_000));
      expect(onCreated).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it("links a finished export to its new video", async () => {
    exports = [job({ orientation: "horizontal", state: "complete", outputAssetId: "new-video" })];
    show();
    const link = await screen.findByRole("link", { name: "Open horizontal video" });
    expect(link.getAttribute("href")).toContain("asset=new-video");
  });

  it("refreshes the library for an export that finishes while the viewer is closed", async () => {
    const onCreated = vi.fn();
    exports = [job()];
    const library = render(<Library onCreated={onCreated} />);
    await screen.findByText("Vertical export is waiting for the media worker.");
    library.rerender(<Library open={false} onCreated={onCreated} />);
    exports = [job({ state: "complete", outputAssetId: "new-video" })];
    library.rerender(<Library onCreated={onCreated} />);
    await screen.findByRole("link", { name: "Open vertical video" });
    expect(onCreated).toHaveBeenCalledTimes(1);
    library.rerender(<Library open={false} onCreated={onCreated} />);
    library.rerender(<Library onCreated={onCreated} />);
    await screen.findByRole("link", { name: "Open vertical video" });
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it("keeps the library's page when opening an already completed export", async () => {
    const onCreated = vi.fn();
    exports = [job({ state: "complete", outputAssetId: "old-video" })];
    const library = render(<Library onCreated={onCreated} />);
    await screen.findByRole("link", { name: "Open vertical video" });
    library.rerender(<Library open={false} onCreated={onCreated} />);
    library.rerender(<Library onCreated={onCreated} />);
    await screen.findByRole("link", { name: "Open vertical video" });
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("tracks an export whose request response arrives after the viewer closes", async () => {
    let finishRequest!: () => void;
    let requested = false;
    const pending = new Promise<void>(resolve => { finishRequest = resolve; });
    const fetchMock = vi.mocked(fetch);
    const answer = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("cmsRequestVideoOrientationExport")) { requested = true; await pending; }
      return answer(input, init);
    });
    const onCreated = vi.fn();
    const library = render(<Library onCreated={onCreated} />);
    fireEvent.click(await screen.findByRole("button", { name: /Export vertical/ }));
    await vi.waitFor(() => expect(requested).toBe(true));
    library.rerender(<Library open={false} onCreated={onCreated} />);
    await act(async () => { finishRequest(); });
    exports = [job({ state: "complete", outputAssetId: "new-video" })];
    library.rerender(<Library onCreated={onCreated} />);
    await screen.findByRole("link", { name: "Open vertical video" });
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it("stays hidden until the viewing copy is ready", async () => {
    show({ viewingCopy: { state: "processing" } as SourceMediaAssetSummary["viewingCopy"] });
    expect(screen.queryByRole("button", { name: /Export/ })).toBeNull();
    expect(requests).toEqual([]);
  });
});
