import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HttpError,
  cmsDeleteMedia,
  cmsListMedia,
  cmsUploadMedia,
  type MediaAssetSummary,
} from "../src/lib/functions";
import { listMediaSources } from "../src/lib/source-media";
import { setMediaFavorite } from "../src/lib/media-favorites";
import { withMediaTabCounts } from "../src/lib/media-tab-counts";
import {
  beginMediaTabCountsRequest,
  clearMediaSessionCache,
  finishMediaTabCountsRequest,
  mediaTabCounts,
} from "../src/lib/media-session-cache";

function okResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as unknown as Response;
}

const asset = {
  id: "asset-one",
  etag: '"media.YXNzZXQtb25l.2"',
} as MediaAssetSummary;

function sentBody(fetchMock: ReturnType<typeof vi.fn>, call = 0) {
  return JSON.parse((fetchMock.mock.calls[call]![1] as RequestInit).body as string);
}

beforeEach(() => {
  clearMediaSessionCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("tab count flags on existing list calls", () => {
  it("normalizes the station label at the response boundary for all consumers", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse({ success: true,
      sources: [{ id: "video-library", label: "Shared video library", description: "Old copy", canUpload: true },
        { id: "archive", label: "Archive", description: "Archive copy" }], counts: { voiceovers: 196 } })));
    const response = await listMediaSources("local-fixture", { counts: true });
    expect(response.sources).toEqual([
      { id: "video-library", label: "Videos", description: "Browse station videos for production, preview, and download.", canUpload: true },
      { id: "archive", label: "Archive", description: "Archive copy" },
    ]);
    expect(response.counts).toEqual({ voiceovers: 196 });
  });
  it("adds counts: true to the Images list body only when asked", async () => {
    const fetchMock = vi.fn(async () => okResponse({ success: true }));
    vi.stubGlobal("fetch", fetchMock);
    await cmsListMedia("id-token", { page: 2 });
    await cmsListMedia("id-token", { page: 1 }, undefined, { counts: true });
    expect(sentBody(fetchMock, 0)).toEqual({ page: 2, paging: "cursor" });
    expect(sentBody(fetchMock, 1)).toEqual({ page: 1, paging: "cursor", counts: true });
  });

  it("sends {} to the video sources call unless counts are asked for", async () => {
    const fetchMock = vi.fn(async () => okResponse({ success: true, sources: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await listMediaSources("id-token");
    await listMediaSources("id-token", { counts: true });
    expect(sentBody(fetchMock, 0)).toEqual({});
    expect(sentBody(fetchMock, 1)).toEqual({ counts: true });
  });
});

describe("withMediaTabCounts", () => {
  it("asks once, strips counts from the list result and stores them", async () => {
    const send = vi.fn(async (withCounts: boolean) => ({
      records: [],
      ...(withCounts ? { counts: { favorites: 2, sources: { "video-library": 5 } } } : {}),
    }));
    await expect(withMediaTabCounts(send)).resolves.toEqual({ records: [] });
    await expect(withMediaTabCounts(send)).resolves.toEqual({ records: [] });
    expect(send.mock.calls).toEqual([[true], [false]]);
    expect(mediaTabCounts()).toEqual({ favorites: 2, sources: { "video-library": 5 } });
  });

  it("retries once without the flag when an older Functions version rejects it", async () => {
    const send = vi.fn(async (withCounts: boolean): Promise<{ records: string[]; counts?: unknown }> => {
      if (withCounts) throw new HttpError(400, "Unknown media list field counts");
      return { records: ["ok"] };
    });
    await expect(withMediaTabCounts(send)).resolves.toEqual({ records: ["ok"] });
    expect(send.mock.calls).toEqual([[true], [false]]);
    // It stops asking this session, so the older server never sees the flag again.
    await withMediaTabCounts(send);
    expect(send.mock.calls.at(-1)).toEqual([false]);
    expect(mediaTabCounts()).toEqual({});
  });

  it("does not retry an ordinary validation error", async () => {
    const send = vi.fn(async () => { throw new HttpError(400, "page must be a positive safe integer"); });
    await expect(withMediaTabCounts(send)).rejects.toThrow("page must be");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("asks again after a failed load and clears every count after a denial", async () => {
    const seeded = beginMediaTabCountsRequest();
    finishMediaTabCountsRequest(seeded!, { favorites: 3 });
    const fetchMock = vi.fn(async () => okResponse({ success: true, asset }));
    vi.stubGlobal("fetch", fetchMock);
    await cmsUploadMedia("id-token", new File(["x"], "x.png", { type: "image/png" }), { category: "news" });

    const failing = vi.fn(async () => { throw new Error("offline"); });
    await expect(withMediaTabCounts(failing)).rejects.toThrow("offline");
    expect(failing).toHaveBeenCalledWith(true);
    expect(mediaTabCounts()).toEqual({ favorites: 3 });

    const denied = vi.fn(async () => { throw new HttpError(403, "Access changed"); });
    await expect(withMediaTabCounts(denied)).rejects.toThrow("Access changed");
    expect(denied).toHaveBeenCalledWith(true);
    expect(mediaTabCounts()).toEqual({});
  });
});

describe("writes that change counts", () => {
  it("asks for fresh counts on the next list load after an upload or delete", async () => {
    const seeded = beginMediaTabCountsRequest();
    finishMediaTabCountsRequest(seeded!, { favorites: 1 });
    expect(beginMediaTabCountsRequest()).toBeNull();

    vi.stubGlobal("fetch", vi.fn(async () => okResponse({ success: true, asset })));
    await cmsUploadMedia("id-token", new File(["x"], "x.png", { type: "image/png" }), { category: "news" });
    const afterUpload = beginMediaTabCountsRequest();
    expect(afterUpload).not.toBeNull();
    finishMediaTabCountsRequest(afterUpload!, { favorites: 1 });

    vi.stubGlobal("fetch", vi.fn(async () => okResponse({ success: true, deleted: true })));
    await cmsDeleteMedia("id-token", asset);
    expect(beginMediaTabCountsRequest()).not.toBeNull();
  });

  it("moves the favorites count by one for a toggle that changed something", async () => {
    const seeded = beginMediaTabCountsRequest();
    finishMediaTabCountsRequest(seeded!, { favorites: 4 });
    const ref = { backend: "r2" as const, id: "asset-one" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okResponse({ success: true, ref, favorite: true, changed: true }))
      .mockResolvedValueOnce(okResponse({ success: true, ref, favorite: true, changed: false }))
      .mockResolvedValueOnce(okResponse({ success: true, ref, favorite: false, changed: true }))
      .mockResolvedValueOnce(okResponse({ success: true, ref, favorite: false, changed: true }));
    vi.stubGlobal("fetch", fetchMock);

    await setMediaFavorite("id-token", ref, true);
    expect(mediaTabCounts().favorites).toBe(5);
    await setMediaFavorite("id-token", ref, true);
    expect(mediaTabCounts().favorites).toBe(5);
    await setMediaFavorite("id-token", ref, false);
    await setMediaFavorite("id-token", ref, false);
    expect(mediaTabCounts().favorites).toBe(3);
    // The toggle response itself carries no count.
    expect(sentBody(fetchMock, 0)).toEqual({ ref, favorite: true });
  });
});
