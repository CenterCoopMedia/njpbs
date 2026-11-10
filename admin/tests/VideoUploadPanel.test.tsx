import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError, RequestNotDispatchedError } from "../src/lib/functions";
import { VideoUploadPanel } from "../src/components/VideoUploadPanel";
import { startVideoUpload, transferVideo, cancelVideoUpload } from "../src/lib/source-media-upload";
import { installTestLockManager } from "./helpers/web-locks";
import { finishVideoUpload, resetUploadRouter, routeChosenFiles, uploadRouterSnapshot } from "../src/lib/upload-router";
vi.mock("../src/lib/source-media-upload", () => ({
  UploadFileMismatchError: class extends Error {}, VideoUploadValidationError: class extends Error {},
  startVideoUpload: vi.fn(), transferVideo: vi.fn(), cancelVideoUpload: vi.fn(),
}));
const session = { sessionId: "session", assetId: "asset", partSize: 4, totalParts: 1, expiresAt: "2026-09-15T00:00:00Z", version: 1 };
const props = { sourceId: "video-library", userId: "staff", getIdToken: async () => "token", onUploaded: vi.fn() };
beforeEach(() => {
  resetUploadRouter();
  vi.resetAllMocks(); localStorage.clear();
  installTestLockManager();
  vi.mocked(startVideoUpload).mockImplementation(async (_token, _source, file) => ({ success: true, upload: { ...session, sessionId: file.name } }));
  vi.mocked(transferVideo).mockImplementation(({ signal, onPhase }) => {
    onPhase("uploading");
    return new Promise((_resolve, reject) => { signal.addEventListener("abort", () => reject(new DOMException("Paused", "AbortError"))); });
  });
  vi.mocked(cancelVideoUpload).mockResolvedValue({ success: true, canceled: true });
});
afterEach(cleanup);
describe("video upload panel", () => {
  it("keeps defaults guarded without reporting an active transfer after a batch finishes", async () => {
    const onActiveChange = vi.fn();
    const onDefaultsDirtyChange = vi.fn();
    let finish!: (asset: Awaited<ReturnType<typeof transferVideo>>) => void;
    vi.mocked(transferVideo).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const view = render(<VideoUploadPanel {...props} onActiveChange={onActiveChange} onDefaultsDirtyChange={onDefaultsDirtyChange} />);
    await waitFor(() => expect(screen.getByLabelText("Batch title default")).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Batch title default"), { target: { value: "Assignment" } });
    expect(onActiveChange).toHaveBeenLastCalledWith(false);
    expect(onDefaultsDirtyChange).toHaveBeenLastCalledWith(true);

    act(() => routeChosenFiles([new File(["data"], "news.mp4", { type: "video/mp4" })]));
    fireEvent.click(await screen.findByRole("button", { name: "Start upload news.mp4" }));
    await waitFor(() => expect(transferVideo).toHaveBeenCalledOnce());
    expect(onActiveChange).toHaveBeenLastCalledWith(true);
    await act(async () => finish({
      id: "uploaded", sourceId: props.sourceId, name: "Assignment", description: null,
      originalName: "news.mp4", mimeType: "video/mp4", kind: "video", sizeBytes: 4,
      preview: "browser", license: null, credit: null, tags: [], rightsStatus: "pending",
      version: 1, createdAt: null, updatedAt: null,
    }));

    await waitFor(() => expect(onActiveChange).toHaveBeenLastCalledWith(false));
    expect(screen.getByLabelText("Batch title default")).toHaveValue("Assignment");
    expect(onDefaultsDirtyChange).toHaveBeenLastCalledWith(true);
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    view.unmount();
    expect(onDefaultsDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it("keeps saved batch fields when a different batch default changes after reopening", async () => {
    localStorage.setItem("boardwalk-video-transfers:staff:video-library", JSON.stringify([
      { id: "saved", name: "saved.mp4", size: 4, lastModified: 42, startRequested: false,
        draft: { name: "Saved assignment", description: "Saved description", nameOverridden: false,
          descriptionOverridden: false, metadataUpdateRequested: true, metadataRequestOverridden: false,
          credit: "", license: "", tags: "", rightsStatus: "pending" } },
    ]));
    render(<VideoUploadPanel {...props} />);
    await waitFor(() => expect(screen.getByLabelText("Batch description default")).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Batch description default"), { target: { value: "New description" } });
    const saved = within(screen.getByRole("group", { name: "Details before upload: saved.mp4" }));
    expect(saved.getByLabelText("Title")).toHaveValue("Saved assignment");
    expect(saved.getByLabelText("Description")).toHaveValue("New description");
    expect(saved.getByRole("checkbox", { name: "Request metadata update" })).toBeChecked();
  });

  it("keeps personal video values when batch defaults and metadata requests change", async () => {
    render(<VideoUploadPanel {...props} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Upload media" })).toBeEnabled());
    expect(screen.getByRole("checkbox", { name: "Request metadata update for the batch" })).not.toBeChecked();
    fireEvent.change(screen.getByLabelText("Batch title default"), { target: { value: "Assignment" } });
    fireEvent.change(screen.getByLabelText("Batch description default"), { target: { value: "Coverage" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Request metadata update for the batch" }));
    act(() => routeChosenFiles(["one.mp4", "two.mp4"].map(name => new File(["data"], name, { type: "video/mp4" }))));
    const first = within(await screen.findByRole("group", { name: "Details before upload: one.mp4" }));
    fireEvent.change(first.getByLabelText("Title"), { target: { value: "Person's title" } });
    fireEvent.change(first.getByLabelText("Description"), { target: { value: "Person's description" } });
    fireEvent.click(first.getByRole("checkbox", { name: "Request metadata update" }));
    fireEvent.change(screen.getByLabelText("Batch title default"), { target: { value: "Updated assignment" } });
    fireEvent.change(screen.getByLabelText("Batch description default"), { target: { value: "Updated coverage" } });
    const second = within(screen.getByRole("group", { name: "Details before upload: two.mp4" }));
    fireEvent.change(second.getByLabelText("Title"), { target: { value: "" } });
    fireEvent.change(second.getByLabelText("Description"), { target: { value: "" } });
    expect(second.getByLabelText("Title")).toHaveValue("");
    expect(second.getByLabelText("Title")).toHaveAttribute("placeholder", "Updated assignment");
    expect(second.getByLabelText("Description")).toHaveValue("");
    expect(second.getByLabelText("Description")).toHaveAttribute("placeholder", "Updated coverage");
    fireEvent.click(screen.getByRole("button", { name: "Start all uploads" }));
    await waitFor(() => expect(startVideoUpload).toHaveBeenCalledTimes(2));
    const metadata = vi.mocked(startVideoUpload).mock.calls.map(call => call[3]);
    expect(metadata[0]).toMatchObject({ name: "Person's title", description: "Person's description" });
    expect(metadata[0].metadataUpdateRequested ?? false).toBe(false);
    expect(metadata[1]).toMatchObject({ name: "Updated assignment", description: "Updated coverage", metadataUpdateRequested: true });
  });

  it("ends a routed session when its batch cannot fit beside saved transfers", async () => {
    localStorage.setItem("boardwalk-video-transfers:staff:video-library", JSON.stringify(
      Array.from({ length: 19 }, (_, index) => ({ id: `saved-${index}`, name: `saved-${index}.mp4`, size: 4, lastModified: 42 })),
    ));
    routeChosenFiles(["one.mp4", "two.mp4"].map(name => new File(["data"], name, { type: "video/mp4" })));
    const onAdmissionFailed = vi.fn(finishVideoUpload);

    render(<VideoUploadPanel {...props} onAdmissionFailed={onAdmissionFailed} />);

    await waitFor(() => expect(onAdmissionFailed).toHaveBeenCalledWith("Add up to 1 more files to this transfer list."));
    expect(uploadRouterSnapshot().videoSession).toBe(false);
    expect(screen.queryByText("one.mp4")).not.toBeInTheDocument();
    expect(screen.queryByText("two.mp4")).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("boardwalk-video-transfers:staff:video-library") ?? "[]")).toHaveLength(19);
  });

  it("keeps a paused file when a later panel batch does not fit", async () => {
    localStorage.setItem("boardwalk-video-transfers:staff:video-library", JSON.stringify(
      Array.from({ length: 18 }, (_, index) => ({ id: `saved-${index}`, name: `saved-${index}.mp4`, size: 4, lastModified: 42 })),
    ));
    const onAdmissionFailed = vi.fn();
    const onActiveChange = vi.fn();
    render(<VideoUploadPanel {...props} onActiveChange={onActiveChange} onAdmissionFailed={onAdmissionFailed} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Upload media" })).toBeEnabled());
    act(() => routeChosenFiles([new File(["data"], "routed.mp4", { type: "video/mp4" })]));
    fireEvent.click(await screen.findByRole("button", { name: "Start upload routed.mp4" }));
    fireEvent.click(await screen.findByRole("button", { name: "Pause routed.mp4" }));
    await screen.findByRole("button", { name: "Resume routed.mp4" });
    await waitFor(() => expect(onActiveChange).toHaveBeenLastCalledWith(false));
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(false);

    fireEvent.drop(screen.getByRole("region", { name: "Video transfers" }), {
      dataTransfer: { files: ["one.mp4", "two.mp4"].map(name => new File(["data"], name, { type: "video/mp4" })) },
    });

    expect(screen.getByText("Add up to 1 more files to this transfer list.")).toBeInTheDocument();
    expect(onAdmissionFailed).not.toHaveBeenCalled();
    expect(screen.getByText("routed.mp4")).toBeInTheDocument();
  });

  it("adds a routed video after an unused Resume file picker", async () => {
    localStorage.setItem("boardwalk-video-transfers:staff:video-library", JSON.stringify([
      { id: "old", name: "old.mp4", size: 4, lastModified: 42, session },
    ]));
    render(<VideoUploadPanel {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Resume old.mp4" }));

    act(() => routeChosenFiles([new File(["new"], "new.mp4", { type: "video/mp4", lastModified: 43 })]));
    expect(await screen.findByText("new.mp4")).toBeInTheDocument();
    expect(screen.getByText("old.mp4")).toBeInTheDocument();
    expect(startVideoUpload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Start upload new.mp4" }));
    await waitFor(() => expect(vi.mocked(startVideoUpload).mock.calls[0]?.[2]).toMatchObject({ name: "new.mp4" }));
  });

  it("uses the file picker selection for the transfer being resumed", async () => {
    localStorage.setItem("boardwalk-video-transfers:staff:video-library", JSON.stringify([
      { id: "old", name: "old.mp4", size: 4, lastModified: 42, session },
    ]));
    const view = render(<VideoUploadPanel {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Resume old.mp4" }));
    const fileInput = view.container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).not.toBeNull();
    fireEvent.change(fileInput!, { target: { files: [new File(["data"], "old.mp4", { type: "video/mp4", lastModified: 42 })] } });
    await waitFor(() => expect(transferVideo).toHaveBeenCalledTimes(1));
    expect(startVideoUpload).not.toHaveBeenCalled();
  });

  it("uses the mounted owner's file picker when Resume starts in the projected tray", async () => {
    localStorage.setItem("boardwalk-video-transfers:staff:video-library", JSON.stringify([
      { id: "old", name: "old.mp4", size: 4, lastModified: 42, session },
    ]));
    const trayTarget = document.createElement("div");
    document.body.appendChild(trayTarget);
    const fileChooser = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined);
    render(<VideoUploadPanel {...props} onOpenSheet={() => undefined} trayTarget={trayTarget} />);

    fireEvent.click(await within(trayTarget).findByRole("button", { name: "Resume old.mp4" }));

    expect(fileChooser).toHaveBeenCalledOnce();
    expect(startVideoUpload).not.toHaveBeenCalled();
    fileChooser.mockRestore();
    trayTarget.remove();
  });

  it("accepts dropped files, limits active files and lets a prepared file be canceled independently", async () => {
    render(<VideoUploadPanel {...props} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Upload media" })).toBeEnabled());
    const files = ["one.mp4", "two.mp4", "three.mp4"].map(name => new File(["data"], name, { type: "video/mp4", lastModified: 42 }));
    fireEvent.drop(screen.getByRole("region", { name: "Video transfers" }), { dataTransfer: { files } });
    fireEvent.click(screen.getByRole("button", { name: "Start upload one.mp4" }));
    fireEvent.click(screen.getByRole("button", { name: "Start upload two.mp4" }));
    await waitFor(() => expect(transferVideo).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Cancel three.mp4" }));
    await waitFor(() => expect(screen.queryByText("three.mp4")).not.toBeInTheDocument());
    expect(cancelVideoUpload).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Pause one.mp4" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Pause two.mp4" })).toBeEnabled();
  });
  it("lets staff review video details before the upload starts", async () => {
    render(<VideoUploadPanel {...props} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Upload media" })).toBeEnabled());
    fireEvent.drop(screen.getByRole("region", { name: "Video transfers" }), {
      dataTransfer: {
        files: [new File(["data"], "NELLIE_POU.mp4", { type: "video/mp4", lastModified: 42 })],
      },
    });

    expect(startVideoUpload).not.toHaveBeenCalled();
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), {
      target: { value: "Nellie Pou interview" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Description" }), {
      target: { value: "Field interview from Paterson." },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Rights review" }), {
      target: { value: "complete" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Credit" }), {
      target: { value: "NJ PBS" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "License" }), {
      target: { value: "Station owned" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Tags" }), {
      target: { value: "interview, politics" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start upload NELLIE_POU.mp4" }));

    await waitFor(() => expect(startVideoUpload).toHaveBeenCalledWith(
      expect.any(Function),
      "video-library",
      expect.objectContaining({ name: "NELLIE_POU.mp4" }),
      {
        name: "Nellie Pou interview",
        description: "Field interview from Paterson.",
        rightsStatus: "complete",
        credit: "NJ PBS",
        license: "Station owned",
        tags: ["interview", "politics"],
      },
      expect.objectContaining({ requestId: expect.any(String) }),
    ));
  });
  it.each([
    [Array.from({ length: 31 }, (_, index) => `tag-${index}`).join(", "), "Enter no more than 30 tags."],
    ["x".repeat(81), "Keep each tag at 80 characters or fewer."],
  ])("keeps invalid upload tags in review", async (tags, message) => {
    const onTransferStarted = vi.fn();
    render(<VideoUploadPanel {...props} onTransferStarted={onTransferStarted} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Upload media" })).toBeEnabled());
    fireEvent.drop(screen.getByRole("region", { name: "Video transfers" }), {
      dataTransfer: { files: [new File(["data"], "tagged.mp4", { type: "video/mp4", lastModified: 42 })] },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Tags" }), { target: { value: tags } });

    fireEvent.click(screen.getByRole("button", { name: "Start upload tagged.mp4" }));

    expect(await screen.findByText(message)).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Tags" })).toBeEnabled();
    expect(startVideoUpload).not.toHaveBeenCalled();
    expect(onTransferStarted).not.toHaveBeenCalled();
  });
  it("keeps Review details available when a prepared title is blank", async () => {
    const trayTarget = document.createElement("div");
    document.body.appendChild(trayTarget);
    const onOpenSheet = vi.fn();
    render(<VideoUploadPanel {...props} onOpenSheet={onOpenSheet} trayTarget={trayTarget} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Upload media" })).toBeEnabled());
    fireEvent.drop(screen.getByRole("region", { name: "Video transfers" }), {
      dataTransfer: { files: [new File(["data"], "untitled.mp4", { type: "video/mp4", lastModified: 42 })] },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "" } });

    const review = within(trayTarget).getByRole("button", { name: "Review details for untitled.mp4" });
    expect(review).toBeEnabled();
    expect(within(trayTarget).getByText("Ready to start")).toBeVisible();
    expect(within(trayTarget).getAllByText("1 video ready to start")).toHaveLength(2);
    fireEvent.click(review);
    expect(onOpenSheet).toHaveBeenCalledOnce();
    trayTarget.remove();
  });
  it("keeps prepared metadata separate and starts only the selected file", async () => {
    render(<VideoUploadPanel {...props} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Upload media" })).toBeEnabled());
    const files = ["one.mp4", "two.mp4"].map(name => new File(["data"], name, { type: "video/mp4", lastModified: 42 }));
    fireEvent.drop(screen.getByRole("region", { name: "Video transfers" }), { dataTransfer: { files } });
    fireEvent.change(within(screen.getByRole("group", { name: "Details before upload: one.mp4" }))
      .getByRole("textbox", { name: "Title" }), { target: { value: "First interview" } });
    fireEvent.change(within(screen.getByRole("group", { name: "Details before upload: two.mp4" }))
      .getByRole("textbox", { name: "Title" }), { target: { value: "Second interview" } });

    fireEvent.click(screen.getByRole("button", { name: "Start upload one.mp4" }));

    await waitFor(() => expect(startVideoUpload).toHaveBeenCalledOnce());
    expect(startVideoUpload).toHaveBeenCalledWith(
      expect.any(Function),
      "video-library",
      expect.objectContaining({ name: "one.mp4" }),
      expect.objectContaining({ name: "First interview" }),
      expect.objectContaining({ requestId: expect.any(String) }),
    );
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Second interview");
    expect(screen.getByRole("button", { name: "Start upload two.mp4" })).toBeEnabled();
  });
  it("starts a reviewed batch and advances approved files as slots open", async () => {
    let rejectFirst!: (reason: Error) => void;
    const onTransferStarted = vi.fn();
    vi.mocked(transferVideo).mockImplementation(({ file, signal, onPhase }) => {
      onPhase("uploading");
      if (file.name === "one.mp4") {
        return new Promise((_resolve, reject) => { rejectFirst = reject; });
      }
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Paused", "AbortError")));
      });
    });
    render(<VideoUploadPanel {...props} onTransferStarted={onTransferStarted} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Upload media" })).toBeEnabled());
    const files = ["one.mp4", "two.mp4", "three.mp4"].map(name =>
      new File(["data"], name, { type: "video/mp4", lastModified: 42 }));
    fireEvent.drop(screen.getByRole("region", { name: "Video transfers" }), { dataTransfer: { files } });

    fireEvent.click(screen.getByRole("button", { name: "Start all uploads" }));

    await waitFor(() => expect(transferVideo).toHaveBeenCalledTimes(2));
    expect(onTransferStarted).toHaveBeenCalledOnce();
    expect(vi.mocked(startVideoUpload).mock.calls.map(call => call[2].name)).toEqual(["one.mp4", "two.mp4"]);
    await act(async () => { rejectFirst(new Error("First transfer stopped")); });
    await waitFor(() => expect(transferVideo).toHaveBeenCalledTimes(3));
    expect(onTransferStarted).toHaveBeenCalledOnce();
    expect(vi.mocked(startVideoUpload).mock.calls.map(call => call[2].name)).toEqual(["one.mp4", "two.mp4", "three.mp4"]);
  });
  it("cancels an active file after draining its part requests and leaves its neighbor running", async () => {
    render(<VideoUploadPanel {...props} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Upload media" })).toBeEnabled());
    const files = ["one.mp4", "two.mp4"].map(name => new File(["data"], name, { type: "video/mp4", lastModified: 42 }));
    fireEvent.drop(screen.getByRole("region", { name: "Video transfers" }), { dataTransfer: { files } });
    fireEvent.click(screen.getByRole("button", { name: "Start upload one.mp4" }));
    fireEvent.click(screen.getByRole("button", { name: "Start upload two.mp4" }));
    await waitFor(() => expect(transferVideo).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Cancel one.mp4" }));
    await waitFor(() => expect(cancelVideoUpload).toHaveBeenCalledWith(expect.any(Function), "video-library", expect.objectContaining({ sessionId: "one.mp4" })));
    await waitFor(() => expect(screen.queryByText("one.mp4")).not.toBeInTheDocument());
    expect(vi.mocked(transferVideo).mock.calls[1][0].signal.aborted).toBe(false);
  });
  it("restores only the current user's queued transfers without treating saved rows as local work", async () => {
    localStorage.setItem("boardwalk-video-transfers:staff:video-library", JSON.stringify([{ id: "queued", name: "queued.mp4", size: 4, lastModified: 42 }]));
    localStorage.setItem("boardwalk-video-transfers:other:video-library", JSON.stringify([{ id: "other", name: "private.mp4", size: 4, lastModified: 42 }]));
    const onActiveChange = vi.fn();
    render(<VideoUploadPanel {...props} onActiveChange={onActiveChange} />);
    expect(screen.getByText("queued.mp4")).toBeInTheDocument();
    expect(screen.queryByText("private.mp4")).not.toBeInTheDocument();
    expect(startVideoUpload).not.toHaveBeenCalled();
    await waitFor(() => expect(onActiveChange).toHaveBeenLastCalledWith(false));
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(false);
  });
  it("returns an approved row to review when its in-memory file is gone", async () => {
    localStorage.setItem("boardwalk-video-transfers:staff:video-library", JSON.stringify([{
      id: "approved",
      name: "approved.mp4",
      size: 4,
      lastModified: 42,
      queued: true,
      startRequested: false,
      draft: { name: "Approved interview", rightsStatus: "pending" },
    }]));
    const fileChooser = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined);

    render(<VideoUploadPanel {...props} />);

    expect(await screen.findByRole("textbox", { name: "Title" })).toHaveValue("Approved interview");
    expect(screen.getByRole("textbox", { name: "Title" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Start upload approved.mp4" }));
    expect(fileChooser).toHaveBeenCalledOnce();
    fileChooser.mockRestore();
  });
  it("keeps prepared files available after a failure without retrying the failed file", async () => {
    vi.mocked(startVideoUpload).mockRejectedValueOnce(new Error("Network unavailable"));
    render(<VideoUploadPanel {...props} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Upload media" })).toBeEnabled());
    const files = ["one.mp4", "two.mp4", "three.mp4"].map(name => new File(["data"], name, { type: "video/mp4", lastModified: 42 }));
    fireEvent.drop(screen.getByRole("region", { name: "Video transfers" }), { dataTransfer: { files } });
    fireEvent.click(screen.getByRole("button", { name: "Start upload one.mp4" }));
    await screen.findByText("Network unavailable");
    expect(startVideoUpload).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Start upload two.mp4" }));
    fireEvent.click(screen.getByRole("button", { name: "Start upload three.mp4" }));
    await waitFor(() => expect(startVideoUpload).toHaveBeenCalledTimes(3));
    expect(screen.getByText("Network unavailable")).toBeInTheDocument();
    expect(vi.mocked(startVideoUpload).mock.calls.map(call => call[2].name)).toEqual(["one.mp4", "two.mp4", "three.mp4"]);
  });
  it("removes a first start that the server rejected before creating a session", async () => {
    vi.mocked(startVideoUpload).mockRejectedValueOnce(new HttpError(400, "Unsupported video"));
    render(<VideoUploadPanel {...props} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Upload media" })).toBeEnabled());
    fireEvent.drop(screen.getByRole("region", { name: "Video transfers" }), {
      dataTransfer: { files: [new File(["data"], "bad.mp4", { type: "video/mp4", lastModified: 42 })] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start upload bad.mp4" }));
    await screen.findByText("Unsupported video");
    fireEvent.click(screen.getByRole("button", { name: "Cancel bad.mp4" }));
    await waitFor(() => expect(screen.queryByText("bad.mp4")).not.toBeInTheDocument());
    expect(startVideoUpload).toHaveBeenCalledOnce();
    expect(cancelVideoUpload).not.toHaveBeenCalled();
  });
  it("removes a first start when App Check fails before request dispatch", async () => {
    vi.mocked(startVideoUpload).mockRejectedValueOnce(new RequestNotDispatchedError(
      new Error("Account-request protection is not configured"),
    ));
    render(<VideoUploadPanel {...props} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Upload media" })).toBeEnabled());
    fireEvent.drop(screen.getByRole("region", { name: "Video transfers" }), {
      dataTransfer: { files: [new File(["data"], "blocked.mp4", { type: "video/mp4", lastModified: 42 })] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start upload blocked.mp4" }));
    await screen.findByText("Account-request protection is not configured");
    expect(screen.getByRole("textbox", { name: "Title" })).toBeEnabled();
    expect(JSON.parse(localStorage.getItem("boardwalk-video-transfers:staff:video-library") ?? "[]"))
      .toEqual([expect.objectContaining({ name: "blocked.mp4", startRequested: false })]);
    fireEvent.click(screen.getByRole("button", { name: "Cancel blocked.mp4" }));
    await waitFor(() => expect(screen.queryByText("blocked.mp4")).not.toBeInTheDocument());
    expect(startVideoUpload).toHaveBeenCalledOnce();
    expect(cancelVideoUpload).not.toHaveBeenCalled();
  });
  it("clears a prior start failure when the reviewed row waits for a slot", async () => {
    vi.mocked(startVideoUpload).mockRejectedValueOnce(new RequestNotDispatchedError(
      new Error("Account-request protection is not configured"),
    ));
    render(<VideoUploadPanel {...props} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Upload media" })).toBeEnabled());
    const files = ["failed.mp4", "one.mp4", "two.mp4"].map(name =>
      new File(["data"], name, { type: "video/mp4", lastModified: 42 }));
    fireEvent.drop(screen.getByRole("region", { name: "Video transfers" }), { dataTransfer: { files } });
    fireEvent.click(screen.getByRole("button", { name: "Start upload failed.mp4" }));
    await screen.findByText("Account-request protection is not configured");
    fireEvent.click(screen.getByRole("button", { name: "Start upload one.mp4" }));
    fireEvent.click(screen.getByRole("button", { name: "Start upload two.mp4" }));
    await waitFor(() => expect(transferVideo).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole("button", { name: "Start upload failed.mp4" }));

    expect(await screen.findByText(/Queued to upload/)).toBeVisible();
    expect(screen.queryByText("Account-request protection is not configured")).not.toBeInTheDocument();
    expect(startVideoUpload).toHaveBeenCalledTimes(3);
  });
  it("keeps an uncertain start when a retry fails before request dispatch", async () => {
    vi.mocked(startVideoUpload)
      .mockRejectedValueOnce(new Error("The first start result is unknown"))
      .mockRejectedValueOnce(new RequestNotDispatchedError(
        new Error("App Check retry failed"),
      ));
    render(<VideoUploadPanel {...props} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Upload media" })).toBeEnabled());
    fireEvent.drop(screen.getByRole("region", { name: "Video transfers" }), {
      dataTransfer: { files: [new File(["data"], "uncertain.mp4", { type: "video/mp4", lastModified: 42 })] },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), {
      target: { value: "Uncertain interview" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start upload uncertain.mp4" }));
    await screen.findByText("The first start result is unknown");
    expect(screen.getByRole("textbox", { name: "Title" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Resume uncertain.mp4" }));
    await screen.findByText("App Check retry failed");
    expect(JSON.parse(localStorage.getItem("boardwalk-video-transfers:staff:video-library") ?? "[]"))
      .toEqual([expect.objectContaining({ name: "uncertain.mp4", startRequested: true })]);
    fireEvent.click(screen.getByRole("button", { name: "Cancel uncertain.mp4" }));
    await waitFor(() => expect(screen.queryByText("uncertain.mp4")).not.toBeInTheDocument());
    expect(startVideoUpload).toHaveBeenCalledTimes(3);
    expect(vi.mocked(startVideoUpload).mock.calls.map(call => call[3]))
      .toEqual(Array.from({ length: 3 }, () => ({ name: "Uncertain interview", rightsStatus: "pending" })));
    expect(cancelVideoUpload).toHaveBeenCalledOnce();
  });
  it("can discard an expired transfer without deleting a video", async () => {
    localStorage.setItem("boardwalk-video-transfers:staff:video-library", JSON.stringify([{ id: "expired", name: "expired.mp4", size: 4, lastModified: 42, session }]));
    vi.mocked(cancelVideoUpload).mockRejectedValueOnce(new HttpError(410, "Upload expired"));
    render(<VideoUploadPanel {...props} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel expired.mp4" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Cancel expired.mp4" }));
    await waitFor(() => expect(screen.queryByText("expired.mp4")).not.toBeInTheDocument());
    expect(localStorage.getItem("boardwalk-video-transfers:staff:video-library")).toBe("[]");
  });

  it("removes a confirmed completed upload from the local queue but keeps a completing upload", async () => {
    localStorage.setItem("boardwalk-video-transfers:staff:video-library", JSON.stringify([
      { id: "completed", name: "completed.mp4", size: 4, lastModified: 42, session: { ...session, sessionId: "completed" } },
      { id: "completing", name: "completing.mp4", size: 4, lastModified: 42, session: { ...session, sessionId: "completing" } },
    ]));
    vi.mocked(cancelVideoUpload)
      .mockRejectedValueOnce(new HttpError(409, "Completed uploads cannot be canceled", { code: "upload_completed" }))
      .mockRejectedValueOnce(new HttpError(409, "Upload session is not ready for more parts"));
    render(<VideoUploadPanel {...props} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel completed.mp4" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Cancel completed.mp4" }));
    await waitFor(() => expect(screen.queryByText("completed.mp4")).not.toBeInTheDocument());
    expect(screen.getByText(/already in the video library/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel completing.mp4" }));
    await screen.findByText("Upload session is not ready for more parts");
    expect(screen.getByText("completing.mp4")).toBeInTheDocument();
    expect(startVideoUpload).not.toHaveBeenCalled();
    expect(transferVideo).not.toHaveBeenCalled();
  });

  it("replaces an old completed-upload notice after the next cancellation", async () => {
    localStorage.setItem("boardwalk-video-transfers:staff:video-library", JSON.stringify([
      { id: "first", name: "first.mp4", size: 4, lastModified: 42, session: { ...session, sessionId: "first" } },
      { id: "second", name: "second.mp4", size: 4, lastModified: 42, session: { ...session, sessionId: "second" } },
    ]));
    vi.mocked(cancelVideoUpload)
      .mockRejectedValueOnce(new HttpError(409, "Completed uploads cannot be canceled", { code: "upload_completed" }))
      .mockRejectedValueOnce(new HttpError(409, "Completed uploads cannot be canceled", { code: "upload_completed" }));
    render(<VideoUploadPanel {...props} />);

    fireEvent.click(await screen.findByRole("button", { name: "Cancel first.mp4" }));
    await waitFor(() => expect(screen.queryByText("first.mp4")).not.toBeInTheDocument());
    expect(screen.getByText(/^first\.mp4 is already in the video library/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel second.mp4" }));
    await waitFor(() => expect(screen.queryByText("second.mp4")).not.toBeInTheDocument());
    expect(screen.getByText(/^second\.mp4 is already in the video library/)).toBeInTheDocument();
    expect(screen.queryByText(/first\.mp4.*second\.mp4/)).not.toBeInTheDocument();
  });

  it("recovers an uncertain start from its saved descriptor before canceling", async () => {
    localStorage.setItem("boardwalk-video-transfers:staff:video-library", JSON.stringify([
      { id: "local-row-1", name: "uncertain.mp4", size: 4, lastModified: 42, startRequested: true },
    ]));
    render(<VideoUploadPanel {...props} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel uncertain.mp4" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Cancel uncertain.mp4" }));
    await waitFor(() => expect(cancelVideoUpload).toHaveBeenCalledOnce());
    expect(startVideoUpload).toHaveBeenCalledWith(expect.any(Function), "video-library",
      expect.objectContaining({ name: "uncertain.mp4", size: 4, lastModified: 42 }),
      { name: "uncertain", rightsStatus: "pending" }, { requestId: "local-row-1" });
    expect(screen.queryByText("uncertain.mp4")).not.toBeInTheDocument();
    expect(localStorage.getItem("boardwalk-video-transfers:staff:video-library")).toBe("[]");
  });

  it("releases ownership after canceling a start that was waiting for a response", async () => {
    vi.mocked(startVideoUpload).mockImplementationOnce((_token, _source, _file, _metadata, options) =>
      new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () =>
        reject(new DOMException("Paused", "AbortError")), { once: true })));
    const first = render(<VideoUploadPanel {...props} />);
    await waitFor(() => expect(within(first.container).getByRole("button", { name: "Upload media" })).toBeEnabled());
    fireEvent.drop(within(first.container).getByRole("region", { name: "Video transfers" }), {
      dataTransfer: { files: [new File(["data"], "uncertain.mp4", { type: "video/mp4", lastModified: 42 })] },
    });
    fireEvent.click(within(first.container).getByRole("button", { name: "Start upload uncertain.mp4" }));
    await waitFor(() => expect(startVideoUpload).toHaveBeenCalledOnce());
    fireEvent.click(within(first.container).getByRole("button", { name: "Cancel uncertain.mp4" }));
    await waitFor(() => expect(startVideoUpload).toHaveBeenCalledTimes(2));
    expect(vi.mocked(startVideoUpload).mock.calls[0][4]?.requestId)
      .toBe(vi.mocked(startVideoUpload).mock.calls[1][4]?.requestId);
    await waitFor(() => expect(within(first.container).queryByText("uncertain.mp4")).not.toBeInTheDocument());
    first.unmount();
    const second = render(<VideoUploadPanel {...props} />);
    await waitFor(() => expect(within(second.container).getByRole("button", { name: "Upload media" })).toBeEnabled());
  });

  it("keeps the old tab lock until an aborted start is recovered and canceled", async () => {
    vi.mocked(startVideoUpload).mockImplementationOnce((_token, _source, _file, _metadata, options) =>
      new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () =>
        reject(new DOMException("Paused", "AbortError")), { once: true })));
    let resolveCancel!: (value: Awaited<ReturnType<typeof cancelVideoUpload>>) => void;
    vi.mocked(cancelVideoUpload).mockReturnValue(new Promise(resolve => { resolveCancel = resolve; }));
    const first = render(<VideoUploadPanel {...props} />);
    await waitFor(() => expect(within(first.container).getByRole("button", { name: "Upload media" })).toBeEnabled());
    fireEvent.drop(within(first.container).getByRole("region", { name: "Video transfers" }), {
      dataTransfer: { files: [new File(["data"], "stalled.mp4", { type: "video/mp4", lastModified: 42 })] },
    });
    fireEvent.click(within(first.container).getByRole("button", { name: "Start upload stalled.mp4" }));
    await waitFor(() => expect(startVideoUpload).toHaveBeenCalledOnce());
    fireEvent.click(within(first.container).getByRole("button", { name: "Cancel stalled.mp4" }));
    first.unmount();
    const second = render(<VideoUploadPanel {...props} />);
    await within(second.container).findByText(/Clear queue, Resume, Cancel, and Upload media are disabled here/);
    await waitFor(() => expect(cancelVideoUpload).toHaveBeenCalledOnce());
    expect(within(second.container).getByRole("button", { name: "Upload media" })).toBeDisabled();
    expect(vi.mocked(startVideoUpload).mock.calls[0][4]?.requestId)
      .toBe(vi.mocked(startVideoUpload).mock.calls[1][4]?.requestId);
    resolveCancel({ success: true, canceled: true });
    await waitFor(() => expect(within(second.container).getByRole("button", { name: "Upload media" })).toBeEnabled());
    expect(within(second.container).queryByText("stalled.mp4")).not.toBeInTheDocument();
  });

  it("keeps a failed server cancellation in Clear queue and retries it", async () => {
    localStorage.setItem("boardwalk-video-transfers:staff:video-library", JSON.stringify([
      { id: "first", name: "first.mp4", size: 4, lastModified: 42, session: { ...session, sessionId: "first" } },
      { id: "second", name: "second.mp4", size: 4, lastModified: 42, session: { ...session, sessionId: "second" } },
    ]));
    vi.mocked(cancelVideoUpload).mockRejectedValueOnce(new Error("Network unavailable"));
    render(<VideoUploadPanel {...props} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Clear queue" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Clear queue" }));
    await screen.findByText("Network unavailable");
    expect(screen.getByText("first.mp4")).toBeInTheDocument();
    expect(screen.getByText("second.mp4")).toBeInTheDocument();
    expect(cancelVideoUpload).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.getByRole("button", { name: "Clear queue" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Clear queue" }));
    await waitFor(() => expect(screen.queryByText("second.mp4")).not.toBeInTheDocument());
    expect(cancelVideoUpload).toHaveBeenCalledTimes(3);
    expect(localStorage.getItem("boardwalk-video-transfers:staff:video-library")).toBe("[]");
  });

  it("returns approved rows to review when Clear queue stops on a failed cancellation", async () => {
    vi.mocked(cancelVideoUpload)
      .mockResolvedValueOnce({ success: true, canceled: true })
      .mockRejectedValueOnce(new Error("Network unavailable"));
    render(<VideoUploadPanel {...props} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Upload media" })).toBeEnabled());
    const files = ["one.mp4", "two.mp4", "three.mp4"].map(name =>
      new File(["data"], name, { type: "video/mp4", lastModified: 42 }));
    fireEvent.drop(screen.getByRole("region", { name: "Video transfers" }), { dataTransfer: { files } });
    fireEvent.click(screen.getByRole("button", { name: "Start all uploads" }));
    await waitFor(() => expect(transferVideo).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole("button", { name: "Clear queue" }));

    await screen.findByText("Network unavailable");
    await waitFor(() => expect(screen.getByRole("button", { name: "Clear queue" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "Start upload three.mp4" })).toBeEnabled();
    expect(startVideoUpload).toHaveBeenCalledTimes(2);
  });

  it("waits for a row already being canceled before clearing the rest", async () => {
    localStorage.setItem("boardwalk-video-transfers:staff:video-library", JSON.stringify([
      { id: "first", name: "first.mp4", size: 4, lastModified: 42, session: { ...session, sessionId: "first" } },
      { id: "second", name: "second.mp4", size: 4, lastModified: 42, session: { ...session, sessionId: "second" } },
    ]));
    let resolveFirst!: (value: Awaited<ReturnType<typeof cancelVideoUpload>>) => void;
    vi.mocked(cancelVideoUpload).mockReturnValueOnce(new Promise(resolve => { resolveFirst = resolve; }));
    render(<VideoUploadPanel {...props} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel first.mp4" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Cancel first.mp4" }));
    await waitFor(() => expect(cancelVideoUpload).toHaveBeenCalledOnce());
    expect(screen.getByText(/Canceling upload/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pause first.mp4" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel first.mp4" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Clear queue" }));
    expect(screen.getByRole("button", { name: "Clearing queue…" })).toBeDisabled();
    resolveFirst({ success: true, canceled: true });
    await waitFor(() => expect(screen.queryByText("second.mp4")).not.toBeInTheDocument());
    expect(cancelVideoUpload).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Some transfers could not be canceled. Try Clear queue again.")).not.toBeInTheDocument();
  });

  it("keeps a legacy sessionless row during Clear queue until explicit local removal", async () => {
    localStorage.setItem("boardwalk-video-transfers:staff:video-library", JSON.stringify([
      { id: "legacy", name: "legacy.mp4", size: 4, lastModified: 42 },
    ]));
    render(<VideoUploadPanel {...props} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Clear queue" })).toBeEnabled());
    expect(screen.getByText(/Saved by an older version/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove saved transfer legacy.mp4" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Resume legacy.mp4" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear queue" }));
    await screen.findByText(/Older saved transfers need individual removal/);
    expect(screen.getByText("legacy.mp4")).toBeInTheDocument();
    const remove = screen.getByRole("button", { name: "Remove saved transfer legacy.mp4" });
    remove.focus();
    fireEvent.click(remove);
    await waitFor(() => expect(screen.queryByText("legacy.mp4")).not.toBeInTheDocument());
    expect(screen.getByText(/Server cancellation could not be confirmed/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upload media" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Upload media" })).toHaveFocus();
    expect(startVideoUpload).not.toHaveBeenCalled();
    expect(cancelVideoUpload).not.toHaveBeenCalled();
  });

  it("keeps the legacy removal warning and action name in the projected tray", async () => {
    localStorage.setItem("boardwalk-video-transfers:staff:video-library", JSON.stringify([
      { id: "legacy", name: "legacy.mp4", size: 4, lastModified: 42 },
    ]));
    const trayTarget = document.createElement("div");
    document.body.appendChild(trayTarget);
    const onCanceled = vi.fn();
    render(<VideoUploadPanel {...props} onCanceled={onCanceled} onOpenSheet={() => undefined} trayTarget={trayTarget} />);

    const remove = await within(trayTarget).findByRole("button", { name: "Remove saved transfer legacy.mp4" });
    expect(remove).toHaveTextContent("Remove");
    expect(screen.getByText(/Server cancellation cannot be confirmed/)).toBeInTheDocument();
    fireEvent.click(remove);
    await waitFor(() => expect(within(trayTarget).queryByText("legacy.mp4")).not.toBeInTheDocument());
    expect(startVideoUpload).not.toHaveBeenCalled();
    expect(cancelVideoUpload).not.toHaveBeenCalled();
    expect(onCanceled).toHaveBeenCalledWith(expect.stringContaining("Server cancellation could not be confirmed."));
    trayTarget.remove();
  });

  it("gives one tab control of a stored queue and preserves it during handoff", async () => {
    const first = render(<VideoUploadPanel {...props} />);
    await waitFor(() => expect(within(first.container).getByRole("button", { name: "Upload media" })).toBeEnabled());
    const original = new File(["data"], "original.mp4", { type: "video/mp4", lastModified: 42 });
    fireEvent.drop(within(first.container).getByRole("region", { name: "Video transfers" }), { dataTransfer: { files: [original] } });
    fireEvent.click(within(first.container).getByRole("button", { name: "Start upload original.mp4" }));
    await waitFor(() => expect(transferVideo).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(JSON.parse(localStorage.getItem("boardwalk-video-transfers:staff:video-library") ?? "[]"))
      .toEqual([expect.objectContaining({ name: "original.mp4", session: expect.objectContaining({ sessionId: "original.mp4" }) })]));

    const second = render(<VideoUploadPanel {...props} />);
    expect(await within(second.container).findByText(/Video transfers are open in another Boardwalk tab/)).toBeInTheDocument();
    expect(within(second.container).getByRole("button", { name: "Upload media" })).toBeDisabled();
    fireEvent.drop(within(second.container).getByRole("region", { name: "Video transfers" }), {
      dataTransfer: { files: [new File(["other"], "other.mp4", { type: "video/mp4", lastModified: 43 })] },
    });
    expect(JSON.parse(localStorage.getItem("boardwalk-video-transfers:staff:video-library") ?? "[]"))
      .toEqual([expect.objectContaining({ name: "original.mp4" })]);

    first.unmount();
    await waitFor(() => expect(within(second.container).getByRole("button", { name: "Upload media" })).toBeEnabled());
    expect(within(second.container).getByText("original.mp4")).toBeInTheDocument();
    expect(within(second.container).queryByText("other.mp4")).not.toBeInTheDocument();
  });

  it("keeps ownership until a delayed start and cancellation drain after unmount", async () => {
    let resolveStart!: (value: Awaited<ReturnType<typeof startVideoUpload>>) => void;
    let resolveCancel!: (value: Awaited<ReturnType<typeof cancelVideoUpload>>) => void;
    vi.mocked(startVideoUpload).mockReturnValue(new Promise(resolve => { resolveStart = resolve; }));
    vi.mocked(transferVideo).mockImplementation(({ signal }) => signal.aborted
      ? Promise.reject(new DOMException("Paused", "AbortError"))
      : new Promise((_resolve, reject) => signal.addEventListener(
          "abort",
          () => reject(new DOMException("Paused", "AbortError")),
          { once: true },
        )));
    vi.mocked(cancelVideoUpload).mockReturnValue(new Promise(resolve => { resolveCancel = resolve; }));

    const first = render(<VideoUploadPanel {...props} />);
    await waitFor(() => expect(within(first.container).getByRole("button", { name: "Upload media" })).toBeEnabled());
    const file = new File(["data"], "delayed.mp4", { type: "video/mp4", lastModified: 42 });
    fireEvent.drop(within(first.container).getByRole("region", { name: "Video transfers" }), {
      dataTransfer: { files: [file] },
    });
    fireEvent.click(within(first.container).getByRole("button", { name: "Start upload delayed.mp4" }));
    await waitFor(() => expect(startVideoUpload).toHaveBeenCalledOnce());
    fireEvent.click(within(first.container).getByRole("button", { name: "Cancel delayed.mp4" }));
    first.unmount();

    const second = render(<VideoUploadPanel {...props} />);
    expect(await within(second.container).findByText(
      /Video transfers are open in another Boardwalk tab/,
    )).toBeInTheDocument();
    resolveStart({ success: true, upload: session });
    await waitFor(() => expect(cancelVideoUpload).toHaveBeenCalledOnce());
    expect(within(second.container).getByRole("button", { name: "Upload media" })).toBeDisabled();

    resolveCancel({ success: true, canceled: true });
    await waitFor(() => expect(within(second.container).getByRole("button", { name: "Upload media" })).toBeEnabled());
    expect(within(second.container).queryByText("delayed.mp4")).not.toBeInTheDocument();
    expect(localStorage.getItem("boardwalk-video-transfers:staff:video-library")).toBe("[]");
  });

  it("disables uploads when the browser cannot provide an exclusive lock", () => {
    Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
    render(<VideoUploadPanel {...props} />);
    expect(screen.getByText("Uploads are unavailable in this browser. You can still view and download videos.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upload media" })).toBeDisabled();
  });

  it("reports an unavailable queue owner to a routed caller", () => {
    Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
    const onOwnershipUnavailable = vi.fn();
    render(<VideoUploadPanel {...props} onOwnershipUnavailable={onOwnershipUnavailable} />);
    expect(onOwnershipUnavailable).toHaveBeenCalledOnce();
  });

});
