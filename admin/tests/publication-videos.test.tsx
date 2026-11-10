import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LifecycleActionsPanel } from "../src/components/LifecycleActionsPanel";
import { VideoPickerDialog, videoRightsWarning } from "../src/components/VideoBlockEditor";
import { SuccessNoticeProvider } from "../src/components/ui/SuccessNoticeRegion";
import { saveContentWithPublicVideos } from "../src/lib/publication-videos";
import type { SourceMediaAssetSummary } from "../src/lib/source-media";

// Only the network boundary is faked. Each response is keyed by the Function endpoint.
type Reply = { status: number; body: unknown };
function stubEndpoints(replies: Record<string, Reply>) {
  const fetchMock = vi.fn(async (url: string) => {
    const endpoint = String(url).split("/").at(-1)!;
    const reply = replies[endpoint];
    if (!reply) throw new Error(`Unexpected request to ${endpoint}`);
    return {
      ok: reply.status < 400,
      status: reply.status,
      statusText: "",
      headers: { get: () => null },
      json: async () => reply.body,
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
function endpointsCalled(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.map(([url]) => String(url).split("/").at(-1));
}
function bodyOf(fetchMock: ReturnType<typeof vi.fn>, endpoint: string) {
  const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith(`/${endpoint}`))!;
  return JSON.parse((call[1] as RequestInit).body as string);
}

const media = {
  url: "https://media.njpbs.org/cms-media/video/clip-1/" + "a".repeat(64) + ".mp4",
  posterUrl: "https://media.njpbs.org/cms-media/video/clip-1/" + "b".repeat(64) + ".jpg",
  width: 1920, height: 1080, mimeType: "video/mp4",
};
const saved = { status: 200, body: { success: true, collection: "cmsPosts", id: "post-1", created: false,
  mintedIds: {}, document: { id: "post-1", version: 8 } } };
const blocks = [
  { id: "v1", type: "video", order: 0, visible: true, data: { sourceId: "video-library", assetId: "clip-1", title: "Clip" } },
  { id: "v2", type: "video", order: 1, visible: true, data: { sourceId: "video-library", assetId: "clip-1", title: "Again" } },
  { id: "v3", type: "video", order: 2, visible: false, data: { sourceId: "video-library", assetId: "hidden-clip", title: "Hidden" } },
];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("publishing content that holds a video block (#2751)", () => {
  it("copies each visible video once, before the publish save", async () => {
    const fetchMock = stubEndpoints({
      cmsPublishSourceVideo: { status: 200, body: { success: true, media } },
      cmsSaveContent: saved,
    });
    const progress: string[] = [];
    await saveContentWithPublicVideos("id-token", {
      collection: "cmsPosts", id: "post-1", baseVersion: 7, publish: true, document: {},
    }, { blocks, onProgress: message => progress.push(message) });

    expect(endpointsCalled(fetchMock)).toEqual(["cmsPublishSourceVideo", "cmsSaveContent"]);
    expect(bodyOf(fetchMock, "cmsPublishSourceVideo")).toEqual({
      sourceId: "video-library", assetId: "clip-1", collection: "cmsPosts", id: "post-1",
    });
    expect(progress[0]).toBe("Copying video to the public site…");
  });

  it("copies before a schedule save too", async () => {
    const fetchMock = stubEndpoints({
      cmsPublishSourceVideo: { status: 200, body: { success: true, media } },
      cmsSaveContent: saved,
    });
    await saveContentWithPublicVideos("id-token", {
      collection: "cmsPosts", id: "post-1", baseVersion: 7, scheduleAt: "2026-10-08T14:00:00.000Z", document: {},
    }, { blocks });
    expect(endpointsCalled(fetchMock)).toEqual(["cmsPublishSourceVideo", "cmsSaveContent"]);
    expect(bodyOf(fetchMock, "cmsPublishSourceVideo")).toEqual({
      sourceId: "video-library", assetId: "clip-1", collection: "cmsPosts", id: "post-1",
    });
  });

  it("does not copy a video on a draft save, and strips server-owned public data", async () => {
    const fetchMock = stubEndpoints({ cmsSaveContent: saved });
    const draftBlocks = [{ ...blocks[0]!, data: { ...blocks[0]!.data, public: media } }];
    await saveContentWithPublicVideos("id-token", {
      collection: "cmsPosts", id: "post-1", baseVersion: 7, document: { blocks: draftBlocks },
    }, { blocks: draftBlocks });

    expect(endpointsCalled(fetchMock)).toEqual(["cmsSaveContent"]);
    expect(bodyOf(fetchMock, "cmsSaveContent").document.blocks[0].data).toEqual(
      { sourceId: "video-library", assetId: "clip-1", title: "Clip" },
    );
  });

  it("binds a page video to the saved page without adding another request", async () => {
    const fetchMock = stubEndpoints({
      cmsPublishSourceVideo: { status: 200, body: { success: true, media } },
      cmsSaveContent: saved,
    });
    await saveContentWithPublicVideos("id-token", {
      collection: "cmsPages", id: "watch", baseVersion: 7, publish: true, document: {},
    }, { blocks });
    expect(endpointsCalled(fetchMock)).toEqual(["cmsPublishSourceVideo", "cmsSaveContent"]);
    expect(bodyOf(fetchMock, "cmsPublishSourceVideo")).toEqual({
      sourceId: "video-library", assetId: "clip-1", collection: "cmsPages", id: "watch",
    });
  });

  it("refuses a video copy without a saved record and sends no request", async () => {
    const fetchMock = stubEndpoints({
      cmsPublishSourceVideo: { status: 200, body: { success: true, media } },
      cmsSaveContent: saved,
    });
    await expect(saveContentWithPublicVideos("id-token", {
      collection: "cmsPosts", publish: true, document: {},
    }, { blocks })).rejects.toThrow("Save this content before publishing its videos.");
    expect(endpointsCalled(fetchMock)).toEqual([]);
  });

  it("stops before the save when the copy fails and shows why in the publish panel", async () => {
    const fetchMock = stubEndpoints({
      cmsPublishSourceVideo: { status: 409, body: { error: "The viewing copy is not ready." } },
      cmsSaveContent: saved,
    });
    render(<SuccessNoticeProvider routeKey="post-1">
      <LifecycleActionsPanel baseVersion={7} collection="cmsPosts" documentId="post-1" status="approved"
        canPublish canArchive canRestore canUnpublish publicationSupported
        onPublish={(baseVersion, onProgress) => saveContentWithPublicVideos("id-token", {
          collection: "cmsPosts", id: "post-1", baseVersion, publish: true, document: {},
        }, { blocks, onProgress })} />
    </SuccessNoticeProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));

    const message = "The video could not be copied to the public site: The viewing copy is not ready.";
    await waitFor(() => expect(screen.getAllByText(message, { exact: false }).length).toBeGreaterThan(0));
    expect(endpointsCalled(fetchMock)).toEqual(["cmsPublishSourceVideo"]);
  });
});

describe("video rights warnings", () => {
  const asset = (changes: Partial<SourceMediaAssetSummary>): SourceMediaAssetSummary => ({
    id: "clip-1", sourceId: "video-library", name: "Pending clip", description: null, originalName: "clip.mov",
    mimeType: "video/quicktime", kind: "video", sizeBytes: 10, preview: "browser",
    viewingCopy: { state: "ready", durationSeconds: 65 }, license: "Station owned", credit: null, tags: [],
    rightsStatus: "complete", version: 1, createdAt: null, updatedAt: null, ...changes,
  });

  it("warns for pending rights and a missing license, and not otherwise", () => {
    expect(videoRightsWarning(asset({ rightsStatus: "pending" }))).toMatch(/Rights are not confirmed/);
    expect(videoRightsWarning(asset({ license: "" }))).toMatch(/no license recorded/);
    expect(videoRightsWarning(asset({ license: null }))).toMatch(/no license recorded/);
    expect(videoRightsWarning(asset({}))).toBeNull();
  });

  it("still lets staff choose a video whose rights are pending", async () => {
    const pending = asset({ rightsStatus: "pending" });
    const fetchMock = stubEndpoints({
      cmsListSourceMedia: { status: 200, body: { success: true, records: [pending], nextCursor: null, hasMore: false, total: 1 } },
    });
    const onChoose = vi.fn();
    render(<VideoPickerDialog open getIdToken={async () => "id-token"} onClose={() => {}} onChoose={onChoose} />);

    const choice = await screen.findByRole("button", { name: /Pending clip\. Rights are not confirmed/ });
    fireEvent.click(choice);
    expect(onChoose).toHaveBeenCalledWith(pending);
    expect(bodyOf(fetchMock, "cmsListSourceMedia")).toMatchObject({ sourceId: "video-library" });
  });
  it("loads the next page with the cursor, even when the first page has no ready video", async () => {
    const processing = asset({ id: "clip-0", name: "Still processing", viewingCopy: { state: "processing" } });
    const later = asset({ id: "clip-2", name: "Later clip" });
    const pages = [
      { status: 200, body: { success: true, records: [processing], nextCursor: "page-2", hasMore: true, total: 2 } },
      { status: 200, body: { success: true, records: [later], nextCursor: null, hasMore: false, total: 2 } },
    ];
    const fetchMock = vi.fn(async () => {
      const reply = pages.shift()!;
      return { ok: true, status: reply.status, statusText: "", headers: { get: () => null }, json: async () => reply.body } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<VideoPickerDialog open getIdToken={async () => "id-token"} onClose={() => {}} onChoose={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Load more videos" }));
    expect(await screen.findByRole("button", { name: "Later clip" })).toBeTruthy();
    expect(JSON.parse((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body as string))
      .toMatchObject({ sourceId: "video-library", cursor: "page-2" });
    expect(screen.queryByRole("button", { name: "Load more videos" })).toBeNull();
  });

  it("sends a new request when staff retry after a failed list", async () => {
    const replies = [
      { status: 500, body: { error: "Source unavailable" } },
      { status: 200, body: { success: true, records: [asset({ name: "Recovered clip" })], nextCursor: null, hasMore: false, total: 1 } },
    ];
    const fetchMock = vi.fn(async () => {
      const reply = replies.shift()!;
      return { ok: reply.status < 400, status: reply.status, statusText: "", headers: { get: () => null }, json: async () => reply.body } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<VideoPickerDialog open getIdToken={async () => "id-token"} onClose={() => {}} onChoose={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Recovered clip" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("searches without submitting the post form it renders inside", async () => {
    const fetchMock = stubEndpoints({
      cmsListSourceMedia: { status: 200, body: { success: true, records: [asset({})], nextCursor: null, hasMore: false, total: 1 } },
    });
    const onSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    render(<form onSubmit={onSubmit}>
      <VideoPickerDialog open getIdToken={async () => "id-token"} onClose={() => {}} onChoose={() => {}} />
    </form>);
    await screen.findByRole("status");

    fireEvent.change(screen.getByLabelText("Search videos"), { target: { value: "  storm  " } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body as string))
      .toMatchObject({ sourceId: "video-library", q: "storm" });
    fireEvent.keyDown(screen.getByLabelText("Search videos"), { key: "Enter" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("starts again at the first page when staff reopen the picker", async () => {
    const first = asset({ id: "clip-1", name: "First clip" });
    const later = asset({ id: "clip-2", name: "Later clip" });
    const pages = [
      { records: [first], nextCursor: "page-2", hasMore: true },
      { records: [later], nextCursor: null, hasMore: false },
      { records: [first], nextCursor: "page-2", hasMore: true },
    ];
    const fetchMock = vi.fn(async () => {
      const page = pages.shift()!;
      return { ok: true, status: 200, statusText: "", headers: { get: () => null }, json: async () => ({ success: true, total: 2, ...page }) } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const getIdToken = async () => "id-token";
    const view = render(<VideoPickerDialog open getIdToken={getIdToken} onClose={() => {}} onChoose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Load more videos" }));
    await screen.findByRole("button", { name: "Later clip" });

    view.rerender(<VideoPickerDialog open={false} getIdToken={getIdToken} onClose={() => {}} onChoose={() => {}} />);
    view.rerender(<VideoPickerDialog open getIdToken={getIdToken} onClose={() => {}} onChoose={() => {}} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(JSON.parse((fetchMock.mock.calls[2] as unknown as [string, RequestInit])[1].body as string)).not.toHaveProperty("cursor");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Later clip" })).toBeNull());
    expect(screen.getAllByRole("button", { name: "First clip" })).toHaveLength(1);
  });
});
