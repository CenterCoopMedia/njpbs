import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import { BlockPreview } from "../src/components/BlockPreview";
import { RecordForm } from "../src/components/RecordForm";
import { PostTemplatesPage, type PostTemplatesApi } from "../src/routes/PostTemplatesRoute";
import { EditorWorkspaceViewProvider } from "../src/context/EditorWorkspaceView";
import { VideoBlockEditor } from "../src/components/VideoBlockEditor";
import { useVideoRightsWarnings, clearVideoRightsReads } from "../src/lib/video-rights";
import type { SourceMediaAssetSummary } from "../src/lib/source-media";
import type { AdminBlock } from "../src/lib/block-factory";
import { ShellProvider, type ShellData } from "../src/routes/ShellContext";

vi.mock("../src/lib/firebase", async importOriginal => ({ ...await importOriginal<typeof import("../src/lib/firebase")>(),
  getRequiredAppCheckToken: async () => null,
}));
const shell = { principal: { id: "editor", grants: [{ role: "admin" }] }, user: { uid: "editor", email: null }, userDoc: null,
  signOut() {}, getIdToken: async () => "local-test-only" } as ShellData;
const video = (id = "clip-a", changes: Partial<SourceMediaAssetSummary> = {}): SourceMediaAssetSummary => ({
  id, sourceId: "video-library", name: `Video ${id}`, originalName: "video.mp4", description: null,
  mimeType: "video/mp4", kind: "video", sizeBytes: 100, preview: "browser", credit: "NJ PBS", license: null,
  rightsStatus: "pending", tags: [], version: 4, createdAt: null, updatedAt: null, ...changes,
});
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
function server() {
  const state = { assets: { "clip-a": video(), "clip-b": video("clip-b") } as Record<string, SourceMediaAssetSummary>,
    canEdit: true, permissionError: false, readError: false, writeStatus: 200, gate: null as Promise<void> | null,
    readGate: null as { id: string; result: Promise<Response> } | null,
    receipt: null as SourceMediaAssetSummary | null,
    writes: [] as Array<{ sourceId: string; assetId: string; expectedVersion: number; changes: Record<string, unknown> }> };
  const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const name = String(url).split("/").at(-1);
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (name === "cmsListMediaSources") return state.permissionError ? response({ error: "Access unavailable" }, 503)
      : response({ success: true, sources: [{ id: "video-library", label: "Videos", mediaKind: "video", canBrowse: true,
        canEditMetadata: state.canEdit, canUpload: false, canRequestProduction: false }] });
    if (name === "cmsListSourceMedia") {
      const gate = state.readGate;
      if (gate && gate.id === body.assetId) return gate.result;
      return state.readError ? response({ error: "Read unavailable" }, 503)
        : response({ success: true, records: state.assets[body.assetId] ? [state.assets[body.assetId]] : [], hasMore: false, nextCursor: null });
    }
    if (name === "cmsUpdateSourceMediaMetadata") {
      state.writes.push(body);
      if (state.gate) await state.gate;
      if (state.writeStatus !== 200) return response({ error: "Save unavailable", current: state.assets[body.assetId] }, state.writeStatus);
      const current = state.assets[body.assetId];
      const asset = { ...current, ...body.changes, version: current.version + 1 };
      state.assets[asset.id] = asset;
      return response({ success: true, asset: state.receipt ?? asset });
    }
    throw new Error(`Unexpected endpoint ${name}`);
  });
  vi.stubGlobal("fetch", fetch);
  return state;
}
function Advisory({ id }: { id: string }) {
  return <output aria-label="Other mounted rights check">{useVideoRightsWarnings([id]).length ? "Needs review" : "Recorded"}</output>;
}
function Harness({ id = "clip-a", postSave = vi.fn(), dirty = vi.fn(), inspect }: {
  id?: string; postSave?: () => void; dirty?: (dirty: boolean) => void; inspect?: () => void;
}) {
  const block: AdminBlock = { id: "video-block", type: "video", order: 0, visible: true,
    data: { sourceId: "video-library", assetId: id, title: "A boardwalk story" } };
  return <ShellProvider value={shell}><form onSubmit={event => { event.preventDefault(); postSave(); }}>
    <input aria-label="Unsaved headline" defaultValue="My draft headline" />
    <section className="block-card" tabIndex={-1}><BlockPreview block={block} editorFrame="post" onInspect={inspect} onMediaPickerDirtyChange={dirty} /></section>
    <Advisory id={id} />
  </form></ShellProvider>;
}
async function open() {
  fireEvent.click(await screen.findByRole("button", { name: "Review" }));
  const dialog = await screen.findByRole("dialog", { name: "Video rights" });
  await within(dialog).findByText("Video clip-a");
  return within(dialog);
}
function fill(dialog: ReturnType<typeof within>) {
  fireEvent.change(dialog.getByRole("combobox", { name: "Rights review" }), { target: { value: "complete" } });
  fireEvent.change(dialog.getByRole("textbox", { name: "License" }), { target: { value: "Station owned" } });
}
afterEach(() => { cleanup(); clearVideoRightsReads(); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("in-editor video rights (#3674)", () => {
  it("keeps missing-video Review on the existing Details replacement path", async () => {
    const api = server(); delete api.assets["clip-a"];
    const inspect = vi.fn(); const postSave = vi.fn(); render(<Harness inspect={inspect} postSave={postSave} />);
    await screen.findByText("This video is no longer in the media library. Choose another video.");
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(inspect).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog", { name: "Video rights" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Unsaved headline" })).toHaveValue("My draft headline");
    expect(api.writes).toHaveLength(0); expect(postSave).not.toHaveBeenCalled();
  });
  it("skips unchanged rights submissions before and after a save", async () => {
    const api = server(); render(<Harness />); const dialog = await open();
    const save = dialog.getByRole("button", { name: "Save rights" }); const form = save.closest("form")!;
    expect(save).toBeDisabled(); fireEvent.submit(form);
    expect(api.writes).toHaveLength(0);
    fill(dialog); expect(save).toBeEnabled(); fireEvent.click(save);
    await dialog.findByText("Video rights saved.");
    expect(save).toBeDisabled(); fireEvent.submit(form);
    expect(api.writes).toHaveLength(1);
  });
  it("saves only library rights, refreshes mounted checks and keeps the Post draft and form separate", async () => {
    const api = server(); const postSave = vi.fn(); const dirty = vi.fn();
    const view = render(<Harness postSave={postSave} dirty={dirty} />);
    const dialog = await open();
    fill(dialog);
    fireEvent.change(dialog.getByRole("textbox", { name: "Credit" }), { target: { value: "NJ PBS News" } });
    expect(dirty).toHaveBeenLastCalledWith(true);
    fireEvent.submit(dialog.getByRole("button", { name: "Save rights" }).closest("form")!);
    await dialog.findByText("Video rights saved.");
    expect(api.writes).toEqual([{ sourceId: "video-library", assetId: "clip-a", expectedVersion: 4,
      changes: { rightsStatus: "complete", credit: "NJ PBS News", license: "Station owned" } }]);
    await waitFor(() => expect(screen.getByLabelText("Other mounted rights check")).toHaveTextContent("Recorded"));
    expect(screen.queryByRole("button", { name: "Review" })).toBeNull();
    expect(postSave).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Unsaved headline" })).toHaveValue("My draft headline");
    fireEvent.click(dialog.getByRole("button", { name: "Close video rights" }));
    expect(view.container.querySelector(".block-card")).toHaveFocus();
    expect(dirty).toHaveBeenLastCalledWith(false);
  });
  it.each([false, true])("keeps rights read-only with a clear note when edit access is unavailable (read failure=%s)", async permissionError => {
    const api = server(); api.canEdit = false; api.permissionError = permissionError;
    render(<Harness />); const dialog = await open();
    expect(dialog.getByText(/permission to edit media/)).toBeVisible();
    expect(dialog.getByText("NJ PBS")).toBeVisible();
    expect(dialog.queryByRole("textbox")).toBeNull();
    expect(dialog.queryByRole("button", { name: "Save rights" })).toBeNull();
    expect(dialog.getByRole("button", { name: "Close" })).toBeVisible();
    expect(api.writes).toHaveLength(0);
    if (permissionError) {
      api.permissionError = false; api.canEdit = true;
      fireEvent.click(dialog.getByRole("button", { name: "Retry rights check" }));
      await dialog.findByRole("textbox", { name: "License" });
    } else {
      fireEvent.click(dialog.getByRole("button", { name: "Close" }));
      expect(screen.queryByRole("dialog", { name: "Video rights" })).toBeNull();
    }
  });
  it("retains edits and warnings after a failed save and supports retry", async () => {
    const api = server(); api.writeStatus = 503;
    render(<Harness />); const dialog = await open(); fill(dialog);
    fireEvent.click(dialog.getByRole("button", { name: "Save rights" }));
    await dialog.findByRole("alert");
    expect(dialog.getByRole("textbox", { name: "License" })).toHaveValue("Station owned");
    expect(screen.getByLabelText("Other mounted rights check")).toHaveTextContent("Needs review");
    api.writeStatus = 200;
    fireEvent.click(dialog.getByRole("button", { name: "Save rights" }));
    await dialog.findByText("Video rights saved.");
  });
  it.each(["unavailable", "missing"])("recovers from a %s asset read without a blank metadata write", async failure => {
    const api = server(); api.readError = failure === "unavailable";
    if (failure === "missing") delete api.assets["clip-a"];
    render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Video rights" }));
    await dialog.findByRole("alert");
    expect(dialog.queryByRole("textbox")).toBeNull();
    expect(dialog.queryByRole("button", { name: "Save rights" })).toBeNull();
    api.readError = false; api.assets["clip-a"] = video();
    fireEvent.click(dialog.getByRole("button", { name: "Retry rights check" }));
    await dialog.findByRole("textbox", { name: "License" });
    expect(api.writes).toHaveLength(0);
  });
  it("requires an explicit reload after a version conflict and then saves the current version", async () => {
    const api = server(); api.writeStatus = 409;
    render(<Harness />); const dialog = await open(); fill(dialog);
    api.assets["clip-a"] = video("clip-a", { version: 5, credit: "Another editor" });
    fireEvent.click(dialog.getByRole("button", { name: "Save rights" }));
    await dialog.findByText(/Your edits are still here/);
    expect(dialog.getByRole("textbox", { name: "License" })).toHaveValue("Station owned");
    expect(dialog.getByRole("button", { name: "Save rights" })).toBeDisabled();
    fireEvent.click(dialog.getByRole("button", { name: "Reload current rights" }));
    await waitFor(() => expect(dialog.getByRole("textbox", { name: "Credit" })).toHaveValue("Another editor"));
    api.writeStatus = 200; fill(dialog);
    fireEvent.click(dialog.getByRole("button", { name: "Save rights" }));
    await dialog.findByText("Video rights saved.");
    expect(api.writes.at(-1)).toMatchObject({ expectedVersion: 5, changes: { credit: "Another editor" } });
  });
  it("holds concurrent submits and close while a save is in flight", async () => {
    const api = server(); let release!: () => void; api.gate = new Promise(resolve => { release = resolve; });
    render(<Harness />); const dialog = await open(); fill(dialog);
    const form = dialog.getByRole("button", { name: "Save rights" }).closest("form")!;
    fireEvent.submit(form); fireEvent.submit(form);
    await waitFor(() => expect(api.writes).toHaveLength(1));
    expect(dialog.getByRole("button", { name: "Close video rights" })).toBeDisabled();
    fireEvent(screen.getByRole("dialog", { name: "Video rights" }), new Event("cancel", { bubbles: false, cancelable: true }));
    expect(screen.getByRole("dialog", { name: "Video rights" })).toBeVisible();
    release(); await dialog.findByText("Video rights saved.");
    expect(api.writes).toHaveLength(1);
  });
  it("ignores a prior asset's late load when the selected video changes", async () => {
    const api = server(); const view = render(<Harness />);
    const review = await screen.findByRole("button", { name: "Review" });
    let release!: (value: Response) => void;
    api.readGate = { id: "clip-a", result: new Promise(resolve => { release = resolve; }) };
    fireEvent.click(review);
    await screen.findByText("Loading video rights…");
    view.rerender(<Harness id="clip-b" />);
    const dialog = within(await screen.findByRole("dialog", { name: "Video rights" }));
    await dialog.findByText("Video clip-b");
    release(response({ success: true, records: [video("clip-a", { credit: "Late old asset" })] }));
    await waitFor(() => expect(dialog.queryByText("Video clip-a")).toBeNull());
    expect(dialog.getByRole("textbox", { name: "Credit" })).toHaveValue("NJ PBS");
    fill(dialog); fireEvent.click(dialog.getByRole("button", { name: "Save rights" }));
    await dialog.findByText("Video rights saved.");
    expect(api.writes).toHaveLength(1);
    expect(api.writes[0]).toMatchObject({ assetId: "clip-b", expectedVersion: 4 });
  });
  it("does not apply an old asset's in-flight save to a newly selected video", async () => {
    const api = server(); let release!: () => void; api.gate = new Promise(resolve => { release = resolve; });
    const view = render(<Harness />); const first = await open(); fill(first);
    fireEvent.click(first.getByRole("button", { name: "Save rights" }));
    await waitFor(() => expect(api.writes).toHaveLength(1));
    view.rerender(<Harness id="clip-b" />);
    const current = within(await screen.findByRole("dialog", { name: "Video rights" }));
    await current.findByText("Video clip-b");
    release();
    await waitFor(() => expect(api.assets["clip-a"].version).toBe(5));
    expect(current.queryByText("Video rights saved.")).toBeNull();
    expect(current.getByRole("combobox", { name: "Rights review" })).toHaveValue("pending");
    expect(screen.getByLabelText("Other mounted rights check")).toHaveTextContent("Needs review");
  });
  it("does not clear warnings from a mismatched save receipt", async () => {
    const api = server(); api.receipt = video("clip-b", { version: 5, rightsStatus: "complete", license: "Station owned" });
    render(<Harness />); const dialog = await open(); fill(dialog);
    fireEvent.click(dialog.getByRole("button", { name: "Save rights" }));
    await dialog.findByText(/could not be confirmed/);
    expect(dialog.getByRole("button", { name: "Reload current rights" })).toBeVisible();
    expect(dialog.getByRole("button", { name: "Save rights" })).toBeDisabled();
    expect(screen.getByLabelText("Other mounted rights check")).toHaveTextContent("Needs review");
    expect(dialog.getByRole("textbox", { name: "License" })).toHaveValue("Station owned");
  });
  it("asks before discarding rights edits and reloads saved values on reopen", async () => {
    const api = server(); render(<Harness />); const dialog = await open(); fill(dialog);
    fireEvent.click(dialog.getByRole("button", { name: "Close video rights" }));
    expect(dialog.getByText("Discard rights changes?")).toBeVisible();
    fireEvent.click(dialog.getByRole("button", { name: "Keep editing rights" }));
    expect(dialog.getByRole("textbox", { name: "License" })).toHaveValue("Station owned");
    fireEvent.click(dialog.getByRole("button", { name: "Close video rights" }));
    fireEvent.click(dialog.getByRole("button", { name: "Discard rights changes" }));
    const reopened = await open();
    expect(reopened.getByRole("textbox", { name: "License" })).toHaveValue("");
    expect(api.writes).toHaveLength(0);
  });
  it("offers the same rights review from video details without changing the block", async () => {
    server(); const change = vi.fn();
    render(<ShellProvider value={shell}><VideoBlockEditor block={{ id: "video", type: "video", order: 0, visible: true,
      data: { sourceId: "video-library", assetId: "clip-a", title: "Story" } }} onChange={change} readOnly /></ShellProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Review rights" }));
    expect(await screen.findByRole("dialog", { name: "Video rights" })).toBeVisible();
    expect(await screen.findByRole("textbox", { name: "License" })).toBeEnabled();
    expect(change).not.toHaveBeenCalled();
  });
  it.each([false, true])("keeps clean rights inspectable in video Details without changing content (readOnly=%s)", async readOnly => {
    const api = server(); api.assets["clip-a"] = video("clip-a", { rightsStatus: "complete", license: "Station owned" });
    const change = vi.fn();
    render(<ShellProvider value={shell}><VideoBlockEditor block={{ id: "video", type: "video", order: 0, visible: true,
      data: { sourceId: "video-library", assetId: "clip-a", title: "Story" } }} onChange={change} readOnly={readOnly} /></ShellProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Review rights" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Video rights" }));
    expect(await dialog.findByRole("textbox", { name: "License" })).toHaveValue("Station owned");
    expect(dialog.getByRole("button", { name: "Save rights" })).toBeDisabled();
    expect(change).not.toHaveBeenCalled(); expect(api.writes).toHaveLength(0);
  });
  it("offers replacement without a rights dead end for missing video Details", async () => {
    const api = server(); delete api.assets["clip-a"];
    render(<ShellProvider value={shell}><VideoBlockEditor block={{ id: "video", type: "video", order: 0, visible: true,
      data: { sourceId: "video-library", assetId: "clip-a", title: "Story" } }} onChange={vi.fn()} /></ShellProvider>);
    await screen.findByText("This video is no longer in the media library. Choose another video.");
    expect(screen.queryByRole("button", { name: "Review rights" })).toBeNull();
    expect(screen.getByRole("button", { name: "Choose a different video" })).toBeEnabled();
  });
  it.each([false, true])("registers and clears locked Post lead rights edits with its media exit guard (workspace=%s)", async workspace => {
    const api = server(); const dirty = vi.fn(); const save = vi.fn();
    const form = <RecordForm kind="post" readOnly canSave={false} initialIsClean onSave={save}
      onMediaPickerDirtyChange={dirty} initial={{ title: "Locked Post", tags: [], blocks: [],
        leadMedia: { kind: "library-video", data: { sourceId: "video-library", assetId: "clip-a", title: "Story" } } }} />;
    render(<ShellProvider value={shell}>{workspace ? <EditorWorkspaceViewProvider kind="post">{form}</EditorWorkspaceViewProvider> : form}</ShellProvider>);
    if (workspace) fireEvent.click(screen.getByLabelText("View lead media"));
    fireEvent.click(await screen.findByRole("button", { name: "Review rights" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Video rights" }));
    await dialog.findByRole("textbox", { name: "License" });
    fill(dialog);
    expect(dirty).toHaveBeenLastCalledWith(true);
    fireEvent.click(dialog.getByRole("button", { name: "Close video rights" }));
    fireEvent.click(dialog.getByRole("button", { name: "Discard rights changes" }));
    expect(dirty).toHaveBeenLastCalledWith(false);
    expect(api.writes).toHaveLength(0);
    expect(save).not.toHaveBeenCalled();
  });
  it("blocks navigation for locked template lead rights edits and clears its guard after rights save", async () => {
    const media = server();
    const api: PostTemplatesApi = {
      get: vi.fn(async () => ({ success: true as const, mediaWarning: null,
        template: { id: "template-one", name: "Locked template", description: "", version: 1, mode: "content" as const,
          retired: false, sourceId: "source-post", sourceVersion: 1, section: "watch", counts: {}, canManage: false },
        document: { type: "post", status: "draft", title: "", tags: [], categories: [], blocks: [],
          leadMedia: { kind: "library-video", data: { sourceId: "video-library", assetId: "clip-a", title: "Story" } } } })),
      list: vi.fn(async () => ({ success: true as const, templates: [] })),
      change: vi.fn<PostTemplatesApi["change"]>(), create: vi.fn<PostTemplatesApi["create"]>(),
    };
    const router = createMemoryRouter([
      { path: "/post-templates/:templateId", element: <PostTemplatesPage api={api} /> },
      { path: "/post-templates", element: <h1>Template list</h1> },
    ], { initialEntries: ["/post-templates/template-one"] });
    render(<ShellProvider value={shell}><RouterProvider router={router} /></ShellProvider>);
    await screen.findByRole("textbox", { name: "Template name" });
    fireEvent.click(screen.getByText("Lead media and background", { selector: "summary" }));
    fireEvent.click(await screen.findByRole("button", { name: "Review rights" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Video rights" }));
    await dialog.findByRole("textbox", { name: "License" });
    fill(dialog);
    void router.navigate("/post-templates");
    const guard = within(await screen.findByRole("dialog", { name: "Leave with unsaved changes?" }));
    expect(router.state.location.pathname).toBe("/post-templates/template-one");
    fireEvent.click(guard.getByRole("button", { name: "Keep editing" }));
    expect(dialog.getByRole("textbox", { name: "License" })).toHaveValue("Station owned");
    fireEvent.click(dialog.getByRole("button", { name: "Save rights" }));
    await dialog.findByText("Video rights saved.");
    fireEvent.click(dialog.getByRole("button", { name: "Close video rights" }));
    fireEvent.click(screen.getByRole("link", { name: "Back to post templates" }));
    await screen.findByRole("heading", { name: "Template list" });
    expect(media.writes).toHaveLength(1);
    expect(api.change).not.toHaveBeenCalled();
    expect(api.create).not.toHaveBeenCalled();
  });
});
