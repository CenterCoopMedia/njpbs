import { File as NodeFile } from "node:buffer";
import { webcrypto } from "node:crypto";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VideoReplaceButton } from "../src/components/media/VideoReplaceButton";
import type { SourceMediaAssetSummary } from "../src/lib/source-media";

// Firebase identity/App Check is an external boundary. Exercise the real HTTP,
// upload and replacement helpers, without mocking component internals.
vi.mock("../src/lib/firebase", () => ({ auth: { currentUser: null }, firebaseConfig: { projectId: "demo-njpbs" }, getRequiredAppCheckToken: async () => null }));
const asset: SourceMediaAssetSummary = { id: "video-fixture", sourceId: "video-library", kind: "video", name: "County meeting",
  originalName: "meeting.mp4", description: "Meeting", mimeType: "video/mp4", sizeBytes: 1024, preview: "browser",
  credit: "NJ PBS", license: "Station owned", tags: ["county"], rightsStatus: "complete", version: 2,
  fileVersion: "old-file-version", createdAt: null, updatedAt: null, uploadedBy: null,
  viewingCopy: { state: "ready", durationSeconds: 2 } };
const requests: { endpoint: string; body: Record<string, unknown> }[] = [];
let answer: (endpoint: string, body: Record<string, unknown>) => Response | Promise<Response>;
const onUpdated = vi.fn(), onBusyChange = vi.fn();
function show(overrides: Partial<Parameters<typeof VideoReplaceButton>[0]> = {}) {
  return render(<VideoReplaceButton asset={asset} userId="editor" canReplace getIdToken={async () => "fixture-token"}
    onUpdated={onUpdated} onBusyChange={onBusyChange} {...overrides} />);
}
function choose(name = "corrected.mp4") {
  fireEvent.change(screen.getByLabelText("Choose a replacement video for County meeting"), {
    target: { files: [new File([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])], name, { type: "video/mp4", lastModified: 1234 })] },
  });
}
function status(overrides = {}) {
  return { asset, state: "complete", migrationPending: false, transcriptPending: false, previous: null, previousDeleted: false,
    history: [{ action: "replace", at: "2026-11-03T14:20:00Z", by: "Editor", originalName: "corrected.mp4" }], ...overrides };
}
beforeEach(() => {
  requests.length = 0; localStorage.clear(); vi.clearAllMocks();
  answer = endpoint => endpoint === "cmsGetSourceVideoReplacement" ? Response.json(status()) : Response.json({ error: "The current file stays live" }, { status: 409 });
  vi.stubGlobal("fetch", vi.fn(async (input, init) => {
    const endpoint = String(input).split("/").at(-1)!;
    const body = JSON.parse(String(init?.body ?? "{}")); requests.push({ endpoint, body }); return answer(endpoint, body);
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("video Replace file", () => {
  it.each(["upload_completed", "session_changed"])("clears only a known completed upload when cancellation returns %s", async code => {
    const key = `boardwalk-video-replacement:editor:${asset.id}`;
    const saved = { requestId: "previous-request", expectedVersion: 2, session: { sessionId: "saved-session", assetId: asset.id,
      partSize: 16 * 1024 * 1024, totalParts: 1, expiresAt: "2099-01-01T00:00:00Z", version: 1 } };
    localStorage.setItem(key, JSON.stringify(saved));
    answer = endpoint => endpoint === "cmsGetSourceVideoReplacement"
      ? Response.json(status({ state: "none", history: [] }))
      : Response.json({ error: "Upload session changed", code }, { status: 409 });
    show(); fireEvent.click(screen.getByRole("button", { name: "Cancel saved replacement" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(code === "upload_completed" ? "already finished and cannot be canceled" : "Upload session changed");
    expect(requests.filter(row => row.endpoint === "cmsCancelSourceMediaUpload")).toHaveLength(1);
    expect(localStorage.getItem(key)).toBe(code === "upload_completed" ? null : JSON.stringify(saved));
    if (code === "upload_completed") {
      expect(screen.getByRole("button", { name: "Replace file" })).toBeEnabled();
      expect(screen.queryByRole("button", { name: "Cancel saved replacement" })).toBeNull();
    } else expect(screen.getByRole("button", { name: "Resume replacement" })).toBeEnabled();
    expect(onUpdated).not.toHaveBeenCalled();
  });

  it.each(["unsupported extension", "oversized file"])("keeps no saved replacement after an %s refusal", async reason => {
    const view = show();
    const file = new File([new Uint8Array([0])], reason === "unsupported extension" ? "replacement.txt" : "replacement.mp4");
    if (reason === "oversized file") Object.defineProperty(file, "size", { value: 250 * 1024 ** 3 + 1 });
    fireEvent.change(screen.getByLabelText("Choose a replacement video for County meeting"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm replacement" }));
    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(false));
    expect(requests.some(row => row.endpoint === "cmsStartSourceMediaUpload")).toBe(false);
    expect(localStorage.getItem("boardwalk-video-replacement:editor:video-fixture")).toBeNull();
    expect(screen.queryByRole("button", { name: "Resume replacement" })).not.toBeInTheDocument();
    view.unmount();
    show();
    expect(screen.getByRole("button", { name: "Replace file" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Cancel saved replacement" })).not.toBeInTheDocument();
  });

  it("recovers the processing state when the same file's completion response was lost", async () => {
    const key = `boardwalk-video-replacement:editor:${asset.id}`;
    localStorage.setItem(key, JSON.stringify({ requestId: "lost-completion", expectedVersion: 2,
      session: { sessionId: "completed-session", assetId: asset.id, partSize: 16 * 1024 * 1024,
        totalParts: 1, expiresAt: "2099-01-01T00:00:00Z", version: 1 } }));
    const processingAsset = { ...asset, version: 3, replacement: { state: "processing" as const, requestedAt: null, requestedBy: "Editor" } };
    let resumed = false;
    answer = endpoint => {
      if (endpoint === "cmsResumeSourceMediaUpload") { resumed = true; return Response.json({ asset: processingAsset }); }
      if (endpoint === "cmsGetSourceVideoReplacement") return Response.json(status({
        state: resumed ? "processing" : "none", asset: resumed ? processingAsset : asset }));
      throw new Error(`Unexpected endpoint: ${endpoint}`);
    };
    show(); await act(async () => {});
    choose(); fireEvent.click(screen.getByRole("button", { name: "Confirm replacement" }));
    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(processingAsset));
    expect(localStorage.getItem(key)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Replace file" })).toBeDisabled();
    expect(screen.getByText(/^Preparing replacement/)).toBeVisible();
    await waitFor(() => expect(requests.filter(row => row.endpoint === "cmsGetSourceVideoReplacement")).toHaveLength(2));
    expect(requests.some(row => row.endpoint === "cmsStartSourceMediaUpload")).toBe(false);
  });

  it("uploads the next chosen file after clearing a completed transfer whose completion response was lost", async () => {
    // The server completed the previous upload, but the browser retained its
    // session because it never received the completion response.
    const key = `boardwalk-video-replacement:editor:${asset.id}`;
    const saved = { requestId: "lost-completion-request", expectedVersion: 2,
      session: { sessionId: "completed-session", assetId: asset.id, partSize: 16 * 1024 * 1024,
        totalParts: 1, expiresAt: "2099-01-01T00:00:00Z", version: 1 } };
    localStorage.setItem(key, JSON.stringify(saved));
    const bytes = [0, 0, 0, 24, 102, 116, 121, 112, 7];
    const nextFile = new NodeFile([new Uint8Array(bytes)], "next-cut.mp4", { type: "video/mp4", lastModified: 5678 });
    const freshSession = { ...saved.session, sessionId: "next-session" };
    const sent: number[][] = [];
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("XMLHttpRequest", class {
      upload = { onprogress: null };
      status = 200;
      onload: (() => void) | null = null;
      open() {}
      setRequestHeader() {}
      async send(body: Blob) { sent.push(Array.from(new Uint8Array(await body.arrayBuffer()))); this.onload?.(); }
    });
    answer = (endpoint, body) => {
      if (endpoint === "cmsGetSourceVideoReplacement") return Response.json(status({ state: "complete", history: [] }));
      if (endpoint === "cmsStartSourceMediaUpload") return Response.json({ upload: freshSession });
      if (endpoint === "cmsResumeSourceMediaUpload") return body.sessionId === saved.session.sessionId
        ? Response.json({ asset })
        : Response.json({ upload: { ...freshSession, originalName: nextFile.name, sizeBytes: nextFile.size,
          lastModified: nextFile.lastModified, completedParts: [] } });
      if (endpoint === "cmsSignSourceMediaUploadParts") return Response.json({ version: 2,
        parts: [{ partNumber: 1, url: "https://uploads.example.test/next-part", requiredHeaders: {} }] });
      if (endpoint === "cmsCompleteSourceMediaUpload") return Response.json({ asset });
      throw new Error(`Unexpected endpoint: ${endpoint}`);
    };
    const selectNext = () => fireEvent.change(screen.getByLabelText("Choose a replacement video for County meeting"), {
      target: { files: [nextFile] },
    });
    show(); await act(async () => {});
    selectNext(); fireEvent.click(screen.getByRole("button", { name: "Confirm replacement" }));
    const notice = await screen.findByText(/To replace it with another file, choose that file again/);
    await waitFor(() => expect(requests.filter(row => row.endpoint === "cmsGetSourceVideoReplacement")).toHaveLength(2));
    expect(notice).toBeVisible();
    expect(localStorage.getItem(key)).toBeNull();
    expect(sent).toEqual([]);
    expect(requests.filter(row => row.endpoint === "cmsStartSourceMediaUpload")).toEqual([]);
    expect(screen.getByRole("button", { name: "Replace file" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Cancel saved replacement" })).toBeNull();
    selectNext(); fireEvent.click(screen.getByRole("button", { name: "Confirm replacement" }));
    await waitFor(() => expect(requests.some(row => row.endpoint === "cmsCompleteSourceMediaUpload")).toBe(true));
    await waitFor(() => expect(localStorage.getItem(key)).toBeNull());
    expect(sent).toEqual([bytes]);
    const started = requests.find(row => row.endpoint === "cmsStartSourceMediaUpload")!;
    expect(started.body).toMatchObject({ originalName: "next-cut.mp4", sizeBytes: bytes.length, lastModified: 5678 });
    expect(started.body.requestId).not.toBe(saved.requestId);
    expect(requests.find(row => row.endpoint === "cmsCompleteSourceMediaUpload")?.body.sessionId).toBe("next-session");
  });

  it("rediscovers an uploaded replacement when a viewer reopens with its cached idle descriptor", async () => {
    const processingAsset = { ...asset, replacement: { state: "processing" as const, requestedAt: null, requestedBy: "Editor" } };
    let uploaded = false, promoted = false;
    answer = endpoint => {
      if (endpoint === "cmsStartSourceMediaUpload") return Response.json({ upload: { sessionId: "completed-upload", assetId: asset.id,
        partSize: 16 * 1024 * 1024, totalParts: 1, expiresAt: "2026-11-17T14:20:00Z", version: 1 } });
      if (endpoint === "cmsResumeSourceMediaUpload") { uploaded = true; return Response.json({ asset: processingAsset }); }
      return Response.json(status({ state: promoted ? "complete" : uploaded ? "processing" : "none",
        asset: promoted ? { ...asset, fileVersion: "promoted-file", version: 3 } : processingAsset }));
    };
    const first = show(); choose(); fireEvent.click(screen.getByRole("button", { name: "Confirm replacement" }));
    await waitFor(() => expect(uploaded).toBe(true));
    await waitFor(() => expect(screen.getByRole("button", { name: "Replace file" })).toBeDisabled());
    first.unmount(); requests.length = 0;
    vi.useFakeTimers();
    const reopened = show();
    try {
      await act(async () => {});
      expect(requests.some(row => row.endpoint === "cmsGetSourceVideoReplacement")).toBe(true);
      expect(screen.getByRole("button", { name: "Replace file" })).toBeDisabled();
      promoted = true;
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ fileVersion: "promoted-file", version: 3 }));
    } finally { reopened.unmount(); vi.useRealTimers(); }
  });

  it.each(["idle", "failure"])("ignores a late mount-time %s response after a newer upload", async response => {
    let releaseInitial: (value: Response) => void;
    const initial = new Promise<Response>(resolve => { releaseInitial = resolve; });
    const processingAsset = { ...asset, replacement: { state: "processing" as const, requestedAt: null, requestedBy: "Editor" } };
    let reads = 0, uploaded = false;
    answer = endpoint => {
      if (endpoint === "cmsStartSourceMediaUpload") return Response.json({ upload: { sessionId: "completed-upload", assetId: asset.id,
        partSize: 16 * 1024 * 1024, totalParts: 1, expiresAt: "2026-11-17T14:20:00Z", version: 1 } });
      if (endpoint === "cmsResumeSourceMediaUpload") { uploaded = true; return Response.json({ asset: processingAsset }); }
      return ++reads === 1 ? initial : Response.json(status({ asset: { ...asset, fileVersion: "latest-file", version: 3 } }));
    };
    vi.useFakeTimers();
    const view = show();
    try {
      await act(async () => {});
      expect(reads).toBe(1);
      await act(async () => { choose(); fireEvent.click(screen.getByRole("button", { name: "Confirm replacement" })); });
      expect(uploaded).toBe(true);
      await act(async () => { releaseInitial(response === "idle" ? Response.json(status({ state: "none" }))
        : Response.json({ error: "Old status check failed" }, { status: 503 })); });
      expect(screen.getByRole("button", { name: "Replace file" })).toBeDisabled();
      expect(screen.queryByRole("alert")).toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ fileVersion: "latest-file" }));
    } finally { view.unmount(); vi.useRealTimers(); }
  });
  it.each([404, 410].flatMap(code => ["resume", "cancel"].map(action => [code, action] as const)))(
    "releases a saved upload after HTTP %s on %s so staff can start again", async (code, action) => {
      const key = `boardwalk-video-replacement:editor:${asset.id}`;
      const session = { sessionId: "expired-session", assetId: asset.id, partSize: 16 * 1024 * 1024,
        totalParts: 1, expiresAt: "2026-11-02T14:20:00Z", version: 1 };
      localStorage.setItem(key, JSON.stringify({ requestId: "old-request", expectedVersion: 2, session }));
      answer = endpoint => endpoint === "cmsStartSourceMediaUpload"
        ? Response.json({ error: "New reservation reached" }, { status: 409 })
        : Response.json({ error: "Upload session expired" }, { status: code });
      show();
      if (action === "resume") { choose(); fireEvent.click(screen.getByRole("button", { name: "Confirm replacement" })); }
      else fireEvent.click(screen.getByRole("button", { name: "Cancel saved replacement" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Replace file" })).toBeEnabled());
      expect(localStorage.getItem(key)).toBeNull();
      expect(screen.queryByRole("button", { name: "Cancel saved replacement" })).toBeNull();
      choose(); fireEvent.click(screen.getByRole("button", { name: "Confirm replacement" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("New reservation reached");
      const fresh = requests.find(row => row.endpoint === "cmsStartSourceMediaUpload");
      expect(fresh?.body.requestId).not.toBe("old-request");
      expect(onUpdated).not.toHaveBeenCalled();
    });
  it("shows the button only for permitted shared-library videos and respects dirty/busy guards", () => {
    const view = show({ canReplace: false }); expect(screen.queryByRole("button", { name: "Replace file" })).toBeNull();
    view.rerender(<VideoReplaceButton asset={asset} userId="editor" canReplace disabled getIdToken={async () => "fixture-token"} onUpdated={onUpdated} onBusyChange={onBusyChange} />);
    expect(screen.getByRole("button", { name: "Replace file" })).toBeDisabled(); expect(requests).toEqual([]);
  });
  it("requires confirmation and sends only stable identity/version to the real upload HTTP contract", async () => {
    show(); choose();
    expect(screen.getByRole("dialog")).toHaveTextContent("One previous file is available for rollback for 14 days");
    expect(requests).toEqual([]);
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Confirm replacement" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The current file stays live");
    expect(screen.queryByText("Starting replacement upload…")).toBeNull();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ endpoint: "cmsStartSourceMediaUpload", body: {
      sourceId: asset.sourceId, originalName: "corrected.mp4", replacement: { assetId: asset.id, expectedVersion: 2, confirmed: true },
    } });
    expect(requests[0].body).not.toHaveProperty("metadata");
    expect(onUpdated).not.toHaveBeenCalled(); expect(onBusyChange).toHaveBeenCalledWith(false);
  });
  it("canceling confirmation does not start an upload", () => {
    show(); choose(); fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull(); expect(requests).toEqual([]);
  });
  it.each(["replacement", "rollback"])("requires a fresh %s confirmation after a background version change", async action => {
    answer = endpoint => endpoint === "cmsGetSourceVideoReplacement" ? Response.json(status({ previous: {
      id: "prior", originalName: "original.mp4", expiresAt: "2026-11-17T14:20:00Z" }, state: "none" }))
      : Response.json({ error: "Fresh confirmation reached" }, { status: 409 });
    const view = show();
    await act(async () => {});
    if (action === "replacement") choose();
    else {
      fireEvent.click(screen.getByRole("button", { name: "View file history" }));
      fireEvent.click(await screen.findByRole("button", { name: "Restore previous file" }));
    }
    view.rerender(<VideoReplaceButton asset={{ ...asset, version: 3 }} userId="editor" canReplace
      getIdToken={async () => "fixture-token"} onUpdated={onUpdated} onBusyChange={onBusyChange} />);
    fireEvent.click(screen.getByRole("button", { name: `Confirm ${action}` }));
    expect(screen.getByRole("alert")).toHaveTextContent("The video changed");
    expect(screen.queryByRole("dialog")).toBeNull();
    const endpoint = action === "replacement" ? "cmsStartSourceMediaUpload" : "cmsRollbackSourceVideoReplacement";
    expect(requests.filter(row => row.endpoint === endpoint)).toEqual([]);
    if (action === "replacement") choose();
    else fireEvent.click(screen.getByRole("button", { name: "Restore previous file" }));
    fireEvent.click(screen.getByRole("button", { name: `Confirm ${action}` }));
    await waitFor(() => expect(requests.find(row => row.endpoint === endpoint)?.body).toMatchObject(
      action === "replacement" ? { replacement: { expectedVersion: 3 } } : { expectedVersion: 3 }));
  });
  it("renders file history and hides expired rollback with the 14-day deletion label", async () => {
    answer = () => Response.json(status({ previousDeleted: true }));
    show(); fireEvent.click(screen.getByRole("button", { name: "View file history" }));
    expect(await screen.findByText("Previous version deleted after 14 days")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Restore previous file" })).toBeNull();
    expect(screen.getByRole("list")).toHaveTextContent("Replaced corrected.mp4 — Editor");
  });
  it("reports expired cleanup as pending until deletion is confirmed", async () => {
    answer = () => Response.json(status({ previousCleanupPending: true }));
    show(); fireEvent.click(screen.getByRole("button", { name: "View file history" }));
    expect(await screen.findByText(/Previous file’s restore window has ended/)).toBeVisible();
    expect(screen.queryByText("Previous version deleted after 14 days")).toBeNull();
    expect(screen.queryByRole("button", { name: "Restore previous file" })).toBeNull();
  });
  it("requires confirmation before rollback and keeps the same video identity", async () => {
    answer = endpoint => Response.json(endpoint === "cmsGetSourceVideoReplacement" ? status({ previous: {
      id: "prior", originalName: "original.mp4", expiresAt: "2026-11-17T14:20:00Z" }, state: "none" }) : { asset });
    show(); fireEvent.click(screen.getByRole("button", { name: "View file history" }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore previous file" }));
    expect(requests.filter(row => row.endpoint === "cmsRollbackSourceVideoReplacement")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Confirm rollback" }));
    await waitFor(() => expect(requests.some(row => row.endpoint === "cmsRollbackSourceVideoReplacement")).toBe(true));
    expect(requests.find(row => row.endpoint === "cmsRollbackSourceVideoReplacement")?.body).toEqual({ sourceId: asset.sourceId, assetId: asset.id, expectedVersion: 2, confirmed: true });
  });
  it.each(["replacement_permission_changed", "replacement_video_changed"])("unlocks a permanently stopped %s attempt with a clear recovery message", code => {
    show({ asset: { ...asset, replacement: { state: "failed", requestedAt: null, requestedBy: "Editor", errorCode: code } } });
    expect(screen.getByRole("alert")).toHaveTextContent("The replacement stopped because");
    expect(screen.getByRole("alert")).toHaveTextContent("current file is unchanged");
    expect(screen.getByRole("alert")).toHaveTextContent("authorized staff member");
    expect(screen.getByRole("button", { name: "Replace file" })).toBeEnabled();
    expect(screen.queryByText(/Processing will retry automatically/)).not.toBeInTheDocument();
  });
  it("shows processing failure while the prior video remains available", async () => {
    show({ asset: { ...asset, replacement: { state: "failed", requestedAt: null, requestedBy: "Editor", errorCode: "processing_failed" } } });
    expect(screen.getByRole("alert")).toHaveTextContent("previous file is still live");
    expect(screen.getByRole("button", { name: "Replace file" })).toBeEnabled();
  });
});

it("defers a completed-file refresh while details are dirty, then applies it once", async () => {
  answer = () => Response.json(status({ asset: { ...asset, fileVersion: "new-file-version", version: 3 } }));
  const view = show({ disabled: true });
  fireEvent.click(screen.getByRole("button", { name: "View file history" }));
  await screen.findByRole("list"); expect(onUpdated).not.toHaveBeenCalled();
  view.rerender(<VideoReplaceButton asset={asset} userId="editor" canReplace getIdToken={async () => "fixture-token"} onUpdated={onUpdated} onBusyChange={onBusyChange} />);
  fireEvent.click(screen.getByRole("button", { name: "View file history" }));
  await waitFor(() => expect(onUpdated).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "View file history" }));
  await waitFor(() => expect(requests.length).toBeGreaterThanOrEqual(3));
  expect(onUpdated).toHaveBeenCalledTimes(1);
});

it("keeps replacement and rollback available while transcription is waiting", async () => {
  answer = () => Response.json(status({ transcriptPending: true, errorCode: "transcription_waiting",
    previous: { id: "prior", originalName: "original.mp4", expiresAt: "2026-11-17T14:20:00Z" } }));
  show(); fireEvent.click(screen.getByRole("button", { name: "View file history" }));
  expect(await screen.findByRole("button", { name: "Restore previous file" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Replace file" })).toBeEnabled();
  expect(screen.getByText("The video is ready. Its transcript is waiting to be processed.")).toBeVisible();
});

it("retains a deferred cleanup session so staff can cancel without recovering the file first", async () => {
  const upload = { sessionId: "cleanup-session", assetId: asset.id, partSize: 16 * 1024 * 1024, totalParts: 1, expiresAt: "2026-11-04T14:20:00Z", version: 1 };
  answer = endpoint => endpoint === "cmsStartSourceMediaUpload" ? Response.json({ error: "Previous file cleanup is still pending", upload }, { status: 503 }) : Response.json({ canceled: true });
  show(); choose(); fireEvent.click(screen.getByRole("button", { name: "Confirm replacement" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("cleanup is still pending");
  fireEvent.click(screen.getByRole("button", { name: "Cancel saved replacement" }));
  await waitFor(() => expect(requests.some(row => row.endpoint === "cmsCancelSourceMediaUpload")).toBe(true));
  expect(requests.find(row => row.endpoint === "cmsCancelSourceMediaUpload")?.body).toEqual({ sourceId: asset.sourceId, sessionId: upload.sessionId, version: 1 });
  await waitFor(() => expect(screen.queryByRole("button", { name: "Cancel saved replacement" })).toBeNull());
});

it("hides rollback automatically when its 14-day retention expires in an open viewer", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-17T14:19:59Z"));
  try {
    answer = () => Response.json(status({ previous: { id: "prior", originalName: "original.mp4", expiresAt: "2026-11-17T14:20:00Z" } }));
    show(); await act(async () => { fireEvent.click(screen.getByRole("button", { name: "View file history" })); });
    expect(screen.getByRole("button", { name: "Restore previous file" })).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(1001); });
    expect(screen.queryByRole("button", { name: "Restore previous file" })).toBeNull();
    expect(screen.getByText(/Previous file’s restore window has ended/)).toBeVisible();
    expect(screen.queryByText("Previous version deleted after 14 days")).toBeNull();
  } finally { vi.useRealTimers(); }
});

it("announces history loading, ignores duplicate opens and recovers its error with an empty state", async () => {
  let release: (response: Response) => void = () => {};
  answer = () => new Promise<Response>(resolve => { release = resolve; });
  show(); fireEvent.click(screen.getByRole("button", { name: "View file history" }));
  expect(screen.getByText("Loading file history…")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "View file history" }));
  await waitFor(() => expect(requests).toHaveLength(1));
  await act(async () => { release(Response.json({ error: "unavailable" }, { status: 503 })); });
  expect(screen.getByRole("alert")).toHaveTextContent("File history could not be loaded");
  answer = () => Response.json(status({ history: [] }));
  fireEvent.click(screen.getByRole("button", { name: "View file history" }));
  expect(await screen.findByText("No previous replacements.")).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
});


it("suppresses a prior completion message after the next replacement is rejected", async () => {
  show(); fireEvent.click(screen.getByRole("button", { name: "View file history" }));
  await screen.findByRole("list");
  expect(screen.getByText("Video file replaced.")).toBeVisible();
  choose(); fireEvent.click(screen.getByRole("button", { name: "Confirm replacement" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("The current file stays live");
  expect(screen.queryByText("Video file replaced.")).toBeNull();
  expect(screen.queryByText("Starting replacement upload…")).toBeNull();
});


it("offers rollback with an actionable error when a published owner cannot refresh", async () => {
  answer = endpoint => Response.json(endpoint === "cmsGetSourceVideoReplacement" ? status({ migrationPending: true, errorCode: "publication_refresh_failed",
    previous: { id: "prior", originalName: "original.mp4", expiresAt: "2026-11-17T14:20:00Z" } }) : { asset });
  show(); fireEvent.click(screen.getByRole("button", { name: "View file history" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Some published players could not be updated");
  expect(screen.getByRole("button", { name: "Replace file" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Restore previous file" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm rollback" }));
  await waitFor(() => expect(requests.some(row => row.endpoint === "cmsRollbackSourceVideoReplacement")).toBe(true));
});

it("refreshes a saved publication error automatically and clears it when the owner recovers", async () => {
  answer = () => Response.json(status({ errorCode: null, migrationPending: false }));
  show({ asset: { ...asset, replacement: { state: "complete", requestedAt: null, requestedBy: "Editor", errorCode: "publication_refresh_failed" } } });
  await waitFor(() => expect(requests.some(row => row.endpoint === "cmsGetSourceVideoReplacement")).toBe(true));
  await waitFor(() => expect(screen.getByRole("button", { name: "Replace file" })).toBeEnabled());
  expect(screen.queryByRole("alert")).toBeNull();
});

it.each(["complete", "error"])("ignores an older %s poll after a newer history read and keeps polling", async outcome => {
  vi.useFakeTimers();
  try {
    let finishOld!: (response: Response) => void;
    let reads = 0;
    const updated = { ...asset, fileVersion: "new-file-version", version: 3 };
    answer = () => ++reads === 1 ? new Promise(resolve => { finishOld = resolve; })
      : Response.json(status({ asset: updated, transcriptPending: reads < 3,
        history: [{ action: "replace", at: "2026-11-03T14:21:00Z", by: "Editor", originalName: "newest.mp4" }] }));
    await act(async () => { show({ asset: { ...asset, replacement: { state: "processing", requestedAt: null, requestedBy: "Editor" } } }); });
    expect(reads).toBe(1);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "View file history" })); });
    expect(onUpdated).toHaveBeenCalledExactlyOnceWith(updated);
    await act(async () => { finishOld(outcome === "complete" ? Response.json(status()) : Response.json({ error: "Old status failed" }, { status: 503 })); });
    expect(onUpdated).toHaveBeenCalledExactlyOnceWith(updated);
    expect(screen.getByRole("list")).toHaveTextContent("newest.mp4");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "View file history" })).toBeEnabled();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(reads).toBe(3);
  } finally { vi.useRealTimers(); }
});

it.each(["replacement", "rollback"])("discards status reads that span a %s and preserves its newer completion", async action => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-03T14:22:00Z"));
  try {
    let finishOldPoll!: (response: Response) => void;
    let finishOldHistory!: (response: Response) => void;
    let finishMutation!: (response: Response) => void;
    let reads = 0;
    const previous = { id: "prior", originalName: "original.mp4", expiresAt: "2026-11-17T14:20:00Z" };
    const pending = { ...asset, version: 3, replacement: { state: "processing" as const, requestedAt: null, requestedBy: "Editor" } };
    const updated = { ...asset, fileVersion: "new-file-version", version: 4 };
    const upload = { sessionId: "finished-session", assetId: asset.id, partSize: 16 * 1024 * 1024, totalParts: 1, expiresAt: "2099-01-01T00:00:00Z", version: 1 };
    answer = endpoint => {
      if (endpoint === "cmsGetSourceVideoReplacement") {
        reads += 1;
        if (reads === 1) return Response.json(status({ previous, transcriptPending: true }));
        if (reads === 2) return new Promise(resolve => { finishOldPoll = resolve; });
        if (reads === 3) return new Promise(resolve => { finishOldHistory = resolve; });
        return Response.json(status({ asset: updated, transcriptPending: reads < 5,
          lastAction: action === "rollback" ? "rollback" : "replace",
          history: [{ action: action === "rollback" ? "rollback" : "replace", at: "2026-11-03T14:21:00Z", by: "Editor", originalName: "newest.mp4" }] }));
      }
      if (endpoint === "cmsStartSourceMediaUpload") return Response.json({ success: true, upload });
      // A resumed upload can already be complete on the server while its response is pending.
      if (endpoint === "cmsResumeSourceMediaUpload" || endpoint === "cmsRollbackSourceVideoReplacement") {
        return new Promise(resolve => { finishMutation = resolve; });
      }
      return Response.json({ error: "Unexpected request" }, { status: 500 });
    };
    show();
    await act(async () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(reads).toBe(2);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "View file history" })); });
    expect(reads).toBe(3);
    await act(async () => {
      if (action === "rollback") fireEvent.click(screen.getByRole("button", { name: "Restore previous file" }));
      else choose();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: action === "rollback" ? "Confirm rollback" : "Confirm replacement" }));
    });
    expect(finishMutation).toBeDefined();
    await act(async () => { finishOldHistory(Response.json({ error: "Obsolete status failed" }, { status: 503 })); });
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => { finishMutation(Response.json({ success: true, asset: pending })); });
    if (action === "rollback") expect(onUpdated).toHaveBeenLastCalledWith(pending);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "View file history" })); });
    expect(reads).toBe(4);
    expect(onUpdated).toHaveBeenLastCalledWith(updated);
    const acceptedUpdates = onUpdated.mock.calls.length;
    await act(async () => { finishOldPoll(Response.json(status({ previous }))); });
    expect(onUpdated).toHaveBeenCalledTimes(acceptedUpdates);
    expect(screen.getByRole("list")).toHaveTextContent("newest.mp4");
    expect(screen.queryByText("Loading file history…")).toBeNull();
    expect(screen.getByRole("button", { name: "View file history" })).toBeEnabled();
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(reads).toBe(5);
    expect(onUpdated).toHaveBeenCalledTimes(acceptedUpdates);
  } finally { vi.useRealTimers(); }
});

it("drops an old history read when another consumer refreshes the binary descriptor", async () => {
  let finishOld!: (value: Response) => void, reads = 0;
  const old = new Promise<Response>(resolve => { finishOld = resolve; });
  const fresh = { ...asset, fileVersion: "external-file", version: 3 };
  answer = () => ++reads === 1 ? old : Response.json(status({ asset: fresh,
    history: [{ action: "replace", at: "2026-11-04T12:00:00Z", by: "Editor", originalName: "new-prior.mp4" }] }));
  const view = show();
  await waitFor(() => expect(reads).toBe(1));
  view.rerender(<VideoReplaceButton asset={fresh} userId="editor" canReplace getIdToken={async () => "fixture-token"}
    onUpdated={onUpdated} onBusyChange={onBusyChange} />);
  await waitFor(() => expect(reads).toBe(2));
  fireEvent.click(screen.getByRole("button", { name: "View file history" }));
  await waitFor(() => expect(reads).toBe(3));
  await act(async () => { finishOld(Response.json(status({ history: [
    { action: "replace", at: "2026-11-03T12:00:00Z", by: "Editor", originalName: "old-prior.mp4" }] }))); });
  expect(await screen.findByRole("list")).toHaveTextContent("new-prior.mp4");
  expect(screen.getByRole("list")).not.toHaveTextContent("old-prior.mp4");
  expect(onUpdated).not.toHaveBeenCalled();
});
