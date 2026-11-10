import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { useLayoutEffect, type PropsWithChildren } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlockPreview } from "../src/components/BlockPreview";
import { useResolvedMediaAsset, useResolvedMediaAssets } from "../src/components/useResolvedMediaAsset";
import type { MediaPickerLoader } from "../src/components/MediaPickerDialog";
import type { MediaAssetSummary, ListMediaResponse } from "../src/lib/functions";
import type { AdminBlock } from "../src/lib/block-factory";
import { invalidateMediaLists, publishFavoritesChange, setMediaCachePrincipal, setMediaCacheUser } from "../src/lib/media-session-cache";

afterEach(() => vi.restoreAllMocks());

const shelfImage: MediaAssetSummary = {
  id: "asset-alpha",
  name: "Alpha image",
  originalName: "alpha.png",
  category: "news",
  categories: ["news"],
  tags: [],
  description: null,
  altText: "Alpha image",
  license: "NJ PBS owned",
  credit: null,
  mimeType: "image/png",
  kind: "image",
  sizeBytes: 128,
  width: 800,
  height: 450,
  url: "https://media.njpbs.org/alpha.png",
  lifecycle: "active",
  version: 1,
  etag: '"media.YXNzZXQtYWxwaGE.1"',
  createdAt: "2026-08-13T12:00:00.000Z",
  createdBy: "editor-1",
  updatedAt: "2026-08-13T12:00:00.000Z",
  updatedBy: "editor-1",
};

function result(records: MediaAssetSummary[]): ListMediaResponse {
  return { success: true, records, total: records.length, allCount: records.length, page: 1, pageCount: 1, categoryCounts: {}, kindCounts: { image: records.length, document: 0 } };
}
function deferred() {
  let resolve!: (value: ListMediaResponse) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<ListMediaResponse>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("block preview", () => {
  it("renders formatted draft text through the safe renderer with no navigation or second editor", () => {
    const block: AdminBlock = { id: "text", type: "prose", order: 0, visible: true, data: { content: { type: "doc", content: [
      { type: "paragraph", content: [{ type: "text", text: "<img src=x onerror=alert(1)>", marks: [{ type: "bold" }, { type: "link", attrs: { href: "javascript:alert(1)" } }] }] },
      { type: "paragraph", content: [{ type: "text", text: "Second paragraph" }] },
    ] } } };
    const view = render(<BlockPreview block={block} />);
    expect(view.container.querySelector("strong")).toHaveTextContent("<img src=x onerror=alert(1)>");
    expect(view.container.querySelectorAll(".block-preview-rich p")).toHaveLength(2);
    expect(view.container.querySelector("a, img, iframe, [contenteditable]")).toBeNull();
    expect(view.container.querySelector(".block-preview-content")).toHaveAttribute("inert");
  });

  it("uses the authoritative asset URL and clears it when loader authority changes", async () => {
    const request = deferred();
    const loader = vi.fn<MediaPickerLoader>(() => request.promise);
    const block: AdminBlock = { id: "image", type: "image", order: 0, visible: true, data: { assetId: shelfImage.id, alt: "Alpha", caption: "Studio" } };
    const view = render(<BlockPreview block={block} loadMedia={loader} />);
    expect(view.container.querySelector("img")).toBeNull();
    await act(async () => request.resolve(result([shelfImage])));
    expect(view.container.querySelector("img")).toHaveAttribute("src", shelfImage.url);
    view.rerender(<BlockPreview block={block} />);
    expect(view.container.querySelector("img")).toBeNull();
    expect(screen.getByText("Image preview unavailable")).toBeTruthy();
  });
});

describe("media preview request ownership", () => {
  it("keeps mounted images during writes and refreshes the next acquisition", async () => {
    const request = deferred();
    const loader = vi.fn<MediaPickerLoader>(() => request.promise);
    const first = renderHook(() => useResolvedMediaAsset(shelfImage.id, loader));
    const second = renderHook(() => useResolvedMediaAsset(shelfImage.id, loader));
    await act(async () => {});
    expect(loader).toHaveBeenCalledTimes(1);
    expect(loader).toHaveBeenCalledWith(expect.objectContaining({
      q: "",
      assetIds: [shelfImage.id],
    }), { signal: expect.any(AbortSignal) });
    first.unmount();
    await act(async () => request.resolve(result([shelfImage])));
    expect(second.result.current).toBe(shelfImage);
    renderHook(() => useResolvedMediaAsset(shelfImage.id, loader));
    await act(async () => {});
    expect(loader).toHaveBeenCalledTimes(1);
    await act(async () => invalidateMediaLists());
    await act(async () => publishFavoritesChange());
    expect(second.result.current).toBe(shelfImage);
    expect(loader).toHaveBeenCalledTimes(1);
    renderHook(() => useResolvedMediaAsset(shelfImage.id, loader));
    await act(async () => {});
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("delivers a pre-write response only to its mounted consumers", async () => {
    const oldRequest = deferred();
    const freshRequest = deferred();
    const loader = vi.fn<MediaPickerLoader>().mockReturnValueOnce(oldRequest.promise).mockReturnValue(freshRequest.promise);
    const mounted = renderHook(() => useResolvedMediaAsset(shelfImage.id, loader));
    await act(async () => {});
    await act(async () => invalidateMediaLists());
    await act(async () => oldRequest.resolve(result([shelfImage])));
    expect(mounted.result.current).toBe(shelfImage);
    const fresh = renderHook(() => useResolvedMediaAsset(shelfImage.id, loader));
    await act(async () => {});
    expect(loader).toHaveBeenCalledTimes(2);
    expect(fresh.result.current).toBeNull();
    const updated = { ...shelfImage, url: "https://media.njpbs.org/updated.png" };
    await act(async () => freshRequest.resolve(result([updated])));
    expect(fresh.result.current).toBe(updated);
    expect(mounted.result.current).toBe(shelfImage);
  });

  it.each(["account", "role"])("clears mounted images on a %s change and rejects old authority", async change => {
    setMediaCachePrincipal("original-account", "editor");
    const oldRequest = deferred();
    const newRequest = deferred();
    const loader = vi.fn<MediaPickerLoader>().mockResolvedValueOnce(result([shelfImage]))
      .mockReturnValueOnce(oldRequest.promise).mockReturnValue(newRequest.promise);
    const mounted = renderHook(() => useResolvedMediaAsset(shelfImage.id, loader));
    await waitFor(() => expect(mounted.result.current).toBe(shelfImage));
    const pending = renderHook(() => useResolvedMediaAsset("pending", loader));
    await act(async () => {});
    const oldSignal = loader.mock.calls[1]![1]!.signal!;
    await act(async () => change === "account"
      ? setMediaCacheUser("different-account") : setMediaCachePrincipal("original-account", "viewer"));
    expect(mounted.result.current).toBeNull();
    expect(oldSignal.aborted).toBe(true);
    await act(async () => oldRequest.resolve(result([{ ...shelfImage, id: "pending" }])));
    expect(pending.result.current).toBeNull();
    expect(mounted.result.current).toBeNull();
    await act(async () => newRequest.resolve(result([])));
  });

  it("isolates loader authority and ignores a stale response after an asset change", async () => {
    const oldRequest = deferred();
    const newRequest = deferred();
    const oldLoader = vi.fn<MediaPickerLoader>(() => oldRequest.promise);
    const newLoader = vi.fn<MediaPickerLoader>(() => newRequest.promise);
    const hook = renderHook(({ id, loader }) => useResolvedMediaAsset(id, loader), { initialProps: { id: shelfImage.id, loader: oldLoader } });
    const separate = renderHook(() => useResolvedMediaAsset(shelfImage.id, newLoader));
    await act(async () => {});
    expect(newLoader).toHaveBeenCalledTimes(1);
    hook.rerender({ id: "different", loader: newLoader });
    await act(async () => oldRequest.resolve(result([shelfImage])));
    expect(hook.result.current).toBeNull();
    await act(async () => newRequest.resolve(result([shelfImage])));
    expect(hook.result.current).toBeNull();
    expect(separate.result.current).toBe(shelfImage);
  });

  it("recovers when identity changes between rendering and acquiring the image", async () => {
    setMediaCachePrincipal("layout-account", "editor");
    const loader = vi.fn<MediaPickerLoader>(async () => result([shelfImage]));
    function IdentityChange({ children }: PropsWithChildren) {
      useLayoutEffect(() => setMediaCachePrincipal("layout-account", "viewer"), []);
      return children;
    }
    const mounted = renderHook(() => useResolvedMediaAsset(shelfImage.id, loader), { wrapper: IdentityChange });
    await waitFor(() => expect(mounted.result.current).toBe(shelfImage));
  });

  it("handles a loader that throws before returning its promise", async () => {
    const loader = vi.fn<MediaPickerLoader>(() => { throw new Error("No media authority"); });
    const hook = renderHook(() => useResolvedMediaAsset(shelfImage.id, loader));
    await act(async () => {});
    expect(hook.result.current).toBeNull();
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it.each(["rejected", "malformed"])("releases %s requests so another mount can retry", async failure => {
    const request = deferred();
    const loader = vi.fn<MediaPickerLoader>(() => request.promise);
    const first = renderHook(() => useResolvedMediaAsset(shelfImage.id, loader));
    await act(async () => failure === "rejected"
      ? request.reject(new Error("Permission changed"))
      : request.resolve(undefined as unknown as ListMediaResponse));
    expect(first.result.current).toBeNull();
    renderHook(() => useResolvedMediaAsset(shelfImage.id, loader));
    await act(async () => {});
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("batches a mounted gallery within server and concurrency limits and advances its queue", async () => {
    const requests = Array.from({ length: 5 }, () => deferred());
    let next = 0;
    const loader = vi.fn<MediaPickerLoader>(() => requests[next++]!.promise);
    const hooks = Array.from({ length: 60 }, (_, index) =>
      renderHook(() => useResolvedMediaAsset(`image-${index}`, loader)));
    await act(async () => {});
    expect(loader).toHaveBeenCalledTimes(4);
    expect(loader.mock.calls.map(([query]) => query.assetIds?.length)).toEqual([12, 12, 12, 12]);
    await act(async () => requests[0]!.resolve(result([])));
    expect(loader).toHaveBeenCalledTimes(5);
    for (const hook of hooks) hook.unmount();
    for (const [, options] of loader.mock.calls.slice(1)) expect(options?.signal?.aborted).toBe(true);
    await act(async () => { for (const request of requests.slice(1)) request.resolve(result([])); });
  });

  it("drops undispatched work when its consumers leave", async () => {
    const request = deferred();
    const loader = vi.fn<MediaPickerLoader>(() => request.promise);
    const hooks = Array.from({ length: 60 }, (_, index) =>
      renderHook(() => useResolvedMediaAsset(`image-${index}`, loader)));
    await act(async () => {});
    expect(loader).toHaveBeenCalledTimes(4);
    for (const hook of hooks) hook.unmount();
    await act(async () => request.resolve(result([])));
    expect(loader).toHaveBeenCalledTimes(4);
    expect(loader.mock.calls.every(([, options]) => options?.signal?.aborted)).toBe(true);
  });

  it("evicts old results from a large document while keeping recent previews reusable", async () => {
    const ids = Array.from({ length: 140 }, (_, index) => `image-${index}`);
    const loader = vi.fn<MediaPickerLoader>(async query => result(
      (query.assetIds ?? []).map(id => ({ ...shelfImage, id })),
    ));
    const all = renderHook(() => useResolvedMediaAssets(ids, loader));
    await waitFor(() => expect(all.result.current.size).toBe(140));
    all.unmount();
    const calls = loader.mock.calls.length;
    const recent = renderHook(() => useResolvedMediaAsset("image-139", loader));
    await waitFor(() => expect(recent.result.current?.id).toBe("image-139"));
    expect(loader).toHaveBeenCalledTimes(calls);
    const old = renderHook(() => useResolvedMediaAsset("image-0", loader));
    await waitFor(() => expect(old.result.current?.id).toBe("image-0"));
    expect(loader).toHaveBeenCalledTimes(calls + 1);
  });

  it("aborts only after the last shared consumer leaves and ignores an uncancellable late result", async () => {
    const request = deferred();
    const loader = vi.fn<MediaPickerLoader>(() => request.promise);
    const first = renderHook(() => useResolvedMediaAsset(shelfImage.id, loader));
    const second = renderHook(() => useResolvedMediaAsset(shelfImage.id, loader));
    await act(async () => {});
    const signal = loader.mock.calls[0]![1]!.signal!;
    first.unmount();
    expect(signal.aborted).toBe(false);
    second.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => request.resolve(result([shelfImage])));
    renderHook(() => useResolvedMediaAsset(shelfImage.id, loader));
    await act(async () => {});
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("expires results and forgets them when the same account's authority changes", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const loader = vi.fn<MediaPickerLoader>(async () => result([shelfImage]));
    setMediaCachePrincipal("preview-account", "editor");
    const first = renderHook(() => useResolvedMediaAsset(shelfImage.id, loader));
    await waitFor(() => expect(first.result.current).toBe(shelfImage));
    first.unmount();
    now += 60_001;
    const second = renderHook(() => useResolvedMediaAsset(shelfImage.id, loader));
    await waitFor(() => expect(second.result.current).toBe(shelfImage));
    expect(loader).toHaveBeenCalledTimes(2);
    await act(async () => setMediaCachePrincipal("preview-account", "viewer"));
    expect(loader).toHaveBeenCalledTimes(3);
  });
});
