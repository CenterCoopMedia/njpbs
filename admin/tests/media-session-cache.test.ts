import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  adjustMediaFavoritesCount,
  beginMediaTabCountsRequest,
  clearMediaSessionCache,
  clearMediaTabCounts,
  failMediaTabCountsRequest,
  finishMediaTabCountsRequest,
  invalidateMediaLists,
  markMediaTabCountsStale,
  mediaListRevision,
  mediaTabCounts,
  mediaTabCountsRevision,
  setMediaCachePrincipal,
  setMediaCacheUser,
  subscribeMediaCacheIdentity,
  setMediaImagesCount,
  setMediaSourceCount,
  subscribeMediaListRevision,
  subscribeMediaTabCounts,
} from "../src/lib/media-session-cache";
import { cacheVideoSearchCorpus, cachedVideoSearchCorpus, updateCachedVideoSearchAsset, videoSearchCacheRevision } from "../src/lib/video-search-session-cache";
import type { SourceMediaAssetSummary } from "../src/lib/source-media";

const video = (fields: Partial<SourceMediaAssetSummary> = {}): SourceMediaAssetSummary => ({
  id: "video-1", sourceId: "video-library", name: "Meeting", description: "Council",
  originalName: "meeting.mp4", mimeType: "video/mp4", kind: "video", sizeBytes: 1000,
  preview: "browser", license: null, credit: null, tags: ["news"], rightsStatus: "complete",
  version: 1, createdAt: null, updatedAt: null, ...fields,
});

beforeEach(() => {
  clearMediaSessionCache();
});

describe("media session cache", () => {
  it("drops private video text on role or account change and rejects late scan writes", () => {
    const snapshot = { entries: [], coverage: { assetsScanned: 0, assetsIndexed: 0, assetsWithoutTranscript: 0, assetsUnavailable: 0, truncatedAssets: 0 }, status: "Library scan finished.", complete: true };
    setMediaCachePrincipal("editor-1", "editor");
    const firstRevision = videoSearchCacheRevision();
    cacheVideoSearchCorpus("editor-1", "video-library", snapshot, firstRevision);
    expect(cachedVideoSearchCorpus("editor-1", "video-library")).toBe(snapshot);

    setMediaCachePrincipal("editor-1", "administrator");
    expect(cachedVideoSearchCorpus("editor-1", "video-library")).toBeUndefined();
    cacheVideoSearchCorpus("editor-1", "video-library", snapshot, firstRevision);
    expect(cachedVideoSearchCorpus("editor-1", "video-library")).toBeUndefined();

    cacheVideoSearchCorpus("editor-1", "video-library", snapshot, videoSearchCacheRevision());
    setMediaCacheUser("editor-2");
    expect(cachedVideoSearchCorpus("editor-1", "video-library")).toBeUndefined();

    const secondRevision = videoSearchCacheRevision();
    cacheVideoSearchCorpus("editor-2", "video-library", snapshot, secondRevision);
    expect(updateCachedVideoSearchAsset("editor-1", video({ name: "Late old-account save" }), secondRevision)).toBe(false);
    expect(cachedVideoSearchCorpus("editor-2", "video-library")).toBe(snapshot);
  });
  it("patches a partial corpus and rejects a late page from the earlier scan", () => {
    setMediaCachePrincipal("editor-1", "editor");
    const original = video();
    const snapshot = {
      entries: [
        { id: `asset/${original.id}`, text: "Meeting Council news", asset: original },
        { id: `${original.id}/transcript/2/0`, text: "school funding", asset: original,
          chunk: { id: `${original.id}/transcript/2/0`, assetId: original.id, transcriptId: "transcript", editRevision: 2, segmentIndex: 0, startSeconds: 1, endSeconds: 2, text: "school funding" } },
      ],
      coverage: { assetsScanned: 1, assetsIndexed: 1, assetsWithoutTranscript: 0, assetsUnavailable: 0, truncatedAssets: 0 },
      status: "Loading video search.", nextCursor: "next", complete: false,
    };
    const requestRevision = videoSearchCacheRevision();
    cacheVideoSearchCorpus("editor-1", "video-library", snapshot, requestRevision);
    const updated = video({ name: "Updated meeting", description: "New description", tags: ["education"], rightsStatus: "pending", version: 2 });
    expect(updateCachedVideoSearchAsset("editor-1", updated, requestRevision)).toBe(true);

    const patched = cachedVideoSearchCorpus("editor-1", "video-library")!;
    expect(patched).toMatchObject({ nextCursor: "next", complete: false });
    expect(patched.entries[0]).toMatchObject({ text: "Updated meeting New description education", asset: updated });
    expect(patched.entries[1]).toMatchObject({ text: "school funding", asset: updated });
    cacheVideoSearchCorpus("editor-1", "video-library", snapshot, requestRevision);
    expect(cachedVideoSearchCorpus("editor-1", "video-library")).toBe(patched);
  });
  it("drops an incomplete corpus when the changed asset is not in its retained prefix", () => {
    setMediaCachePrincipal("editor-1", "editor");
    const requestRevision = videoSearchCacheRevision();
    const other = video({ id: "other" });
    cacheVideoSearchCorpus("editor-1", "video-library", {
      entries: [{ id: "asset/other", text: other.name, asset: other }],
      coverage: { assetsScanned: 1, assetsIndexed: 0, assetsWithoutTranscript: 1, assetsUnavailable: 0, truncatedAssets: 0 },
      status: "Loading video search.", nextCursor: "next", complete: false,
    }, requestRevision);
    expect(updateCachedVideoSearchAsset("editor-1", video({ version: 2 }), requestRevision)).toBe(false);
    expect(cachedVideoSearchCorpus("editor-1", "video-library")).toBeUndefined();
  });
  it("drops a newer same-account scan when an older metadata request finishes", () => {
    setMediaCachePrincipal("editor-1", "editor");
    const requestRevision = videoSearchCacheRevision();
    setMediaCachePrincipal("editor-1", "administrator");
    const currentRevision = videoSearchCacheRevision();
    const original = video();
    const snapshot = {
      entries: [{ id: `asset/${original.id}`, text: original.name, asset: original }],
      coverage: { assetsScanned: 1, assetsIndexed: 0, assetsWithoutTranscript: 1, assetsUnavailable: 0, truncatedAssets: 0 },
      status: "Library scan finished.", complete: true,
    };
    cacheVideoSearchCorpus("editor-1", "video-library", snapshot, currentRevision);
    expect(updateCachedVideoSearchAsset("editor-1", video({ name: "Saved later", version: 2 }), requestRevision)).toBe(false);
    expect(cachedVideoSearchCorpus("editor-1", "video-library")).toBeUndefined();
  });
  it("notifies revision subscribers when media lists are invalidated", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeMediaListRevision(listener);
    const before = mediaListRevision();

    invalidateMediaLists();
    invalidateMediaLists();
    // The revision moves at once; the notice waits for a microtask and covers both calls.
    expect(mediaListRevision()).toBe(before + 2);
    expect(listener).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);

    // A user change invalidates through the same path, so subscribers hear it too.
    setMediaCacheUser("editor-2");
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    invalidateMediaLists();
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("media cache identity", () => {
  it("notifies on account and role changes, not when the same principal is set again", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeMediaCacheIdentity(listener);

    setMediaCachePrincipal("editor-1", "editor");
    expect(listener).toHaveBeenCalledTimes(1);
    setMediaCachePrincipal("editor-1", "editor");
    expect(listener).toHaveBeenCalledTimes(1);

    setMediaCachePrincipal("editor-1", "administrator");
    expect(listener).toHaveBeenCalledTimes(2);
    setMediaCacheUser(null);
    expect(listener).toHaveBeenCalledTimes(3);
    clearMediaSessionCache();
    expect(listener).toHaveBeenCalledTimes(3);

    unsubscribe();
  });
});

describe("media tab counts", () => {
  it("asks for counts once per page session and again only after an upload or delete", () => {
    const first = beginMediaTabCountsRequest();
    expect(first).not.toBeNull();
    // A second load while the first is in flight does not ask again.
    expect(beginMediaTabCountsRequest()).toBeNull();
    finishMediaTabCountsRequest(first!, { images: 3, favorites: 2, voiceovers: 196, sources: { "video-library": 412 } });
    expect(mediaTabCounts()).toEqual({ images: 3, favorites: 2, voiceovers: 196, sources: { "video-library": 412 } });
    // Paging, filtering, sorting and searching reuse the counts in hand.
    expect(beginMediaTabCountsRequest()).toBeNull();

    markMediaTabCountsStale();
    // The shown counts stay until the reload that follows the write replaces them.
    expect(mediaTabCounts().favorites).toBe(2);
    const afterWrite = beginMediaTabCountsRequest();
    expect(afterWrite).not.toBeNull();
    finishMediaTabCountsRequest(afterWrite!, { images: 4, favorites: 2 });
    expect(mediaTabCounts()).toEqual({ images: 4, favorites: 2 });
    expect(beginMediaTabCountsRequest()).toBeNull();
  });

  it("retries after a failed request and settles when the server sends no counts", () => {
    const failed = beginMediaTabCountsRequest();
    failMediaTabCountsRequest(failed!);
    const retry = beginMediaTabCountsRequest();
    expect(retry).not.toBeNull();
    finishMediaTabCountsRequest(retry!, undefined);
    expect(mediaTabCounts()).toEqual({});
    expect(beginMediaTabCountsRequest()).toBeNull();
  });

  it("keeps only exact counts and never shows a missing count as zero", () => {
    const request = beginMediaTabCountsRequest();
    finishMediaTabCountsRequest(request!, {
      images: -1,
      favorites: 1.5,
      voiceovers: "196",
      sources: { "video-library": 7, broken: Number.NaN },
      extra: 3,
    });
    expect(mediaTabCounts()).toEqual({ sources: { "video-library": 7 } });
  });

  it("drops a response that started before an account change or a write", () => {
    const request = beginMediaTabCountsRequest();
    setMediaCachePrincipal("editor-2", "{}");
    finishMediaTabCountsRequest(request!, { favorites: 5 });
    expect(mediaTabCounts()).toEqual({});

    const beforeWrite = beginMediaTabCountsRequest();
    markMediaTabCountsStale();
    finishMediaTabCountsRequest(beforeWrite!, { favorites: 5 });
    expect(mediaTabCounts()).toEqual({});
    expect(beginMediaTabCountsRequest()).not.toBeNull();
  });

  it("takes the Images count from a current list and hides it after the list changes", () => {
    const revision = mediaListRevision();
    setMediaImagesCount(12, revision);
    expect(mediaTabCounts().images).toBe(12);
    invalidateMediaLists();
    expect(mediaTabCounts()).not.toHaveProperty("images");
    setMediaImagesCount(12, revision);
    expect(mediaTabCounts()).not.toHaveProperty("images");
    setMediaImagesCount(13, mediaListRevision());
    setMediaImagesCount(null, mediaListRevision());
    expect(mediaTabCounts()).not.toHaveProperty("images");
  });

  it("sets and hides one video source count from totals already in hand", () => {
    setMediaSourceCount("video-library", 40);
    setMediaSourceCount("archive-working", 3);
    expect(mediaTabCounts().sources).toEqual({ "video-library": 40, "archive-working": 3 });
    setMediaSourceCount("video-library", null);
    expect(mediaTabCounts().sources).toEqual({ "archive-working": 3 });
  });

  it("moves the favorites count by one for the caller's own toggles only while it is current", () => {
    adjustMediaFavoritesCount(1, mediaTabCountsRevision());
    expect(mediaTabCounts()).not.toHaveProperty("favorites");

    const request = beginMediaTabCountsRequest();
    finishMediaTabCountsRequest(request!, { favorites: 1 });
    const revision = mediaTabCountsRevision();
    adjustMediaFavoritesCount(1, revision);
    expect(mediaTabCounts().favorites).toBe(2);
    adjustMediaFavoritesCount(-1, revision);
    adjustMediaFavoritesCount(-1, revision);
    adjustMediaFavoritesCount(-1, revision);
    expect(mediaTabCounts().favorites).toBe(0);
    adjustMediaFavoritesCount(4, revision);
    expect(mediaTabCounts().favorites).toBe(4);
    adjustMediaFavoritesCount(0, revision);
    adjustMediaFavoritesCount(1.5, revision);
    expect(mediaTabCounts().favorites).toBe(4);
    adjustMediaFavoritesCount(-4, revision);
    expect(mediaTabCounts().favorites).toBe(0);

    clearMediaTabCounts();
    adjustMediaFavoritesCount(1, revision);
    expect(mediaTabCounts()).toEqual({});
  });

  it("clears counts for a new account or sign-out and tells subscribers once per turn", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeMediaTabCounts(listener);
    const request = beginMediaTabCountsRequest();
    finishMediaTabCountsRequest(request!, { favorites: 4 });
    setMediaSourceCount("video-library", 9);
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);

    setMediaCacheUser("editor-9");
    expect(mediaTabCounts()).toEqual({});
    expect(beginMediaTabCountsRequest()).not.toBeNull();
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});
