import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LifecycleActionsPanel } from "../src/components/LifecycleActionsPanel";
import { VideoBlockEditor } from "../src/components/VideoBlockEditor";
import { SuccessNoticeProvider } from "../src/components/ui/SuccessNoticeRegion";
import type { AdminBlock } from "../src/lib/block-factory";
import type { SourceMediaAssetSummary } from "../src/lib/source-media";
import { ShellProvider, type ShellData } from "../src/routes/ShellContext";
import { clearVideoRightsReads } from "../src/lib/video-rights";

function libraryRecord(id: string, changes: Partial<SourceMediaAssetSummary>) {
  return {
    id, sourceId: "video-library", name: `Clip ${id}`, description: null, originalName: "clip.mov",
    mimeType: "video/quicktime", kind: "video", sizeBytes: 10, preview: "browser",
    viewingCopy: { state: "ready" }, license: "Station owned", credit: null, tags: [],
    rightsStatus: "complete", version: 1, createdAt: null, updatedAt: null, ...changes,
  };
}

// Only the network boundary is faked: each cmsListSourceMedia call answers for the asked asset.
function stubLibrary(assets: Record<string, Partial<SourceMediaAssetSummary> | "missing" | "error">) {
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const { assetId } = JSON.parse(init.body as string) as { assetId?: string };
    if (!assetId) {
      const ids = Object.keys(assets).filter(id => typeof assets[id] === "object");
      const records = ids.map(id => libraryRecord(id, assets[id] as Partial<SourceMediaAssetSummary>));
      return { ok: true, status: 200, statusText: "", headers: { get: () => null },
        json: async () => ({ success: true, records, nextCursor: null, hasMore: false, total: records.length }) } as unknown as Response;
    }
    const entry = assets[assetId];
    if (entry === "error") {
      return { ok: false, status: 500, statusText: "", headers: { get: () => null }, json: async () => ({ error: "Source unavailable" }) } as unknown as Response;
    }
    const records = entry === "missing" ? [] : [libraryRecord(assetId, entry)];
    return { ok: true, status: 200, statusText: "", headers: { get: () => null },
      json: async () => ({ success: true, records, nextCursor: null, hasMore: false, total: records.length }) } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const shell = {
  principal: { id: "publisher", grants: [{ role: "admin" }] },
  user: { uid: "publisher", email: "publisher@example.org", displayName: "Publisher" },
  userDoc: null,
  signOut: () => undefined,
  getIdToken: async () => "id-token",
} as unknown as ShellData;

afterEach(() => { cleanup(); vi.unstubAllGlobals(); clearVideoRightsReads(); });

const videos = (...ids: string[]) => ids.map(assetId => ({ assetId, title: "" }));
const readsOf = (fetchMock: ReturnType<typeof stubLibrary>) => fetchMock.mock.calls
  .map(call => JSON.parse((call as unknown as [string, RequestInit])[1].body as string).assetId as string | undefined)
  .filter(Boolean);

describe("video rights recheck (#2759)", () => {
  it("shows the library's current rights warning when a saved video block opens", async () => {
    const fetchMock = stubLibrary({ "clip-1": { rightsStatus: "pending" } });
    const block = { id: "video-1", type: "video", order: 0, visible: true,
      data: { sourceId: "video-library", assetId: "clip-1", title: "County meeting" } } as unknown as AdminBlock;
    render(<ShellProvider value={shell}><VideoBlockEditor block={block} onChange={() => {}} /></ShellProvider>);

    expect(await screen.findByText(/Rights are not confirmed for this video/)).toBeTruthy();
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string))
      .toMatchObject({ sourceId: "video-library", assetId: "clip-1" });
  });

  it("lists each video that needs a check next to Publish and still lets staff publish", async () => {
    stubLibrary({ "clip-1": { rightsStatus: "pending" }, "clip-2": "missing", "clip-3": "error", "clip-4": {} });
    const onPublish = vi.fn(async () => ({ document: { status: "published" }, buildQueued: true }));
    render(<ShellProvider value={shell}><SuccessNoticeProvider routeKey="post-1">
      <LifecycleActionsPanel baseVersion={7} collection="cmsPosts" documentId="post-1" status="approved"
        canPublish canArchive canRestore canUnpublish publicationSupported
        videos={videos("clip-1", "clip-2", "clip-3", "clip-4")} onPublish={onPublish} />
    </SuccessNoticeProvider></ShellProvider>);

    expect(await screen.findByText("Check video rights before you publish")).toBeTruthy();
    expect(screen.getByText(/Rights are not confirmed for this video/).textContent).toBeTruthy();
    expect(screen.getByText("Clip clip-1:")).toBeTruthy();
    expect(screen.getByText(/no longer in the media library/)).toBeTruthy();
    expect(screen.getByText(/could not be checked/)).toBeTruthy();
    expect(screen.queryByText("Clip clip-4:")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(onPublish).toHaveBeenCalled());
  });

  it("shows no rights notice when every video has confirmed rights and a license", async () => {
    const fetchMock = stubLibrary({ "clip-4": {} });
    render(<ShellProvider value={shell}><SuccessNoticeProvider routeKey="post-1">
      <LifecycleActionsPanel baseVersion={7} collection="cmsPosts" documentId="post-1" status="approved"
        canPublish canArchive canRestore canUnpublish publicationSupported
        videos={videos("clip-4")} onPublish={async () => ({ document: {} })} />
    </SuccessNoticeProvider></ShellProvider>);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Check video rights before you publish")).toBeNull();
  });

  it("stacks one warning per video as a list", async () => {
    stubLibrary({ "clip-1": { rightsStatus: "pending" }, "clip-2": { rightsStatus: "pending" }, "clip-3": { license: "" } });
    render(<ShellProvider value={shell}><SuccessNoticeProvider routeKey="post-1">
      <LifecycleActionsPanel baseVersion={7} collection="cmsPosts" documentId="post-1" status="approved"
        canPublish canArchive canRestore canUnpublish publicationSupported
        videos={videos("clip-1", "clip-2", "clip-3")} onPublish={async () => ({ document: {} })} />
    </SuccessNoticeProvider></ShellProvider>);

    const title = await screen.findByText("Check video rights before you publish");
    const list = title.closest(".inline-message")!.querySelector("ul.lifecycle-video-rights")!;
    expect([...list.querySelectorAll(":scope > li")].map(item => item.textContent))
      .toEqual([1, 2].map(n => `Clip clip-${n}: Rights are not confirmed for this video. Check before you publish.`)
        .concat("Clip clip-3: This video has no license recorded. Check before you publish."));
  });

  it("reads rights again when the window regains focus", async () => {
    const library: Record<string, Partial<SourceMediaAssetSummary>> = { "clip-1": {} };
    const fetchMock = stubLibrary(library);
    render(<ShellProvider value={shell}><SuccessNoticeProvider routeKey="post-1">
      <LifecycleActionsPanel baseVersion={7} collection="cmsPosts" documentId="post-1" status="approved"
        canPublish canArchive canRestore canUnpublish publicationSupported
        videos={videos("clip-1")} onPublish={async () => ({ document: {} })} />
    </SuccessNoticeProvider></ShellProvider>);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Check video rights before you publish")).toBeNull();

    library["clip-1"] = { rightsStatus: "pending" };
    act(() => { window.dispatchEvent(new Event("focus")); });
    expect(await screen.findByText("Check video rights before you publish")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reads rights again when staff pick the same video", async () => {
    const library: Record<string, Partial<SourceMediaAssetSummary>> = { "clip-1": {} };
    const fetchMock = stubLibrary(library);
    const block = { id: "video-1", type: "video", order: 0, visible: true,
      data: { sourceId: "video-library", assetId: "clip-1", title: "County meeting" } } as unknown as AdminBlock;
    render(<ShellProvider value={shell}><VideoBlockEditor block={block} onChange={() => {}} /></ShellProvider>);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/Rights are not confirmed/)).toBeNull();

    library["clip-1"] = { rightsStatus: "pending" };
    fireEvent.click(screen.getByRole("button", { name: "Choose a different video" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Clip clip-1/ }));
    await waitFor(() => expect(screen.getAllByText(/Rights are not confirmed for this video/).length).toBeGreaterThan(0));
    const reads = fetchMock.mock.calls.filter(call => JSON.parse((call as unknown as [string, RequestInit])[1].body as string).assetId);
    expect(reads).toHaveLength(2);
  });

  it.each([
    ["published", { status: "published" }],
    ["scheduled", { status: "scheduled" }],
    ["archived", { status: "archived" }],
    ["a role that cannot publish", { status: "approved", canPublish: false }],
  ])("asks for no rights check on a %s record", async (_label, props) => {
    const fetchMock = stubLibrary({ "clip-1": { rightsStatus: "pending" } });
    render(<ShellProvider value={shell}><SuccessNoticeProvider routeKey="post-1">
      <LifecycleActionsPanel baseVersion={7} collection="cmsPosts" documentId="post-1"
        canPublish canArchive canRestore canUnpublish publicationSupported
        videos={videos("clip-1")} onPublish={async () => ({ document: {} })} {...props} />
    </SuccessNoticeProvider></ShellProvider>);

    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(screen.queryByText("Check video rights before you publish")).toBeNull();
    expect(readsOf(fetchMock)).toEqual([]);
  });

  it("names a missing or unread video by its block title, then by its asset ID", async () => {
    stubLibrary({ "clip-2": "missing", "clip-3": "error" });
    render(<ShellProvider value={shell}><SuccessNoticeProvider routeKey="post-1">
      <LifecycleActionsPanel baseVersion={7} collection="cmsPosts" documentId="post-1" status="approved"
        canPublish canArchive canRestore canUnpublish publicationSupported
        videos={[{ assetId: "clip-2", title: "County meeting" }, { assetId: "clip-3", title: "" }]}
        onPublish={async () => ({ document: {} })} />
    </SuccessNoticeProvider></ShellProvider>);

    const title = await screen.findByText("Check video rights before you publish");
    const items = [...title.closest(".inline-message")!.querySelectorAll("li")].map(item => item.textContent);
    expect(items).toEqual([
      "County meeting: This video is no longer in the media library. Choose another video.",
      "clip-3: The rights for this video could not be checked. Review them before you publish.",
    ]);
  });

  it("reads each video once when its blocks and the publish panel open together", async () => {
    const fetchMock = stubLibrary({ "clip-1": { rightsStatus: "pending" }, "clip-2": {} });
    const block = (id: string, assetId: string) => ({ id, type: "video", order: 0, visible: true,
      data: { sourceId: "video-library", assetId, title: "County meeting" } } as unknown as AdminBlock);
    render(<ShellProvider value={shell}><SuccessNoticeProvider routeKey="post-1">
      <VideoBlockEditor block={block("video-1", "clip-1")} onChange={() => {}} />
      <VideoBlockEditor block={block("video-2", "clip-1")} onChange={() => {}} />
      <VideoBlockEditor block={block("video-3", "clip-2")} onChange={() => {}} />
      <LifecycleActionsPanel baseVersion={7} collection="cmsPosts" documentId="post-1" status="approved"
        canPublish canArchive canRestore canUnpublish publicationSupported
        videos={videos("clip-1", "clip-2")} onPublish={async () => ({ document: {} })} />
    </SuccessNoticeProvider></ShellProvider>);

    expect(await screen.findByText("Check video rights before you publish")).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText(/Rights are not confirmed for this video/)).toHaveLength(3));
    expect(readsOf(fetchMock).sort()).toEqual(["clip-1", "clip-2"]);
  });
});
