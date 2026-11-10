import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MEDIA_DISPLAY } from "../src/lib/media-display";
import type { SavedMediaView } from "../src/lib/saved-media-views";
import {
  useSavedMediaViews,
  type SavedMediaViewsConfiguration,
} from "../src/lib/use-saved-media-views";

const store = vi.hoisted(() => ({
  load: vi.fn(),
  mutate: vi.fn(),
}));

vi.mock("../src/lib/saved-media-view-store", () => ({
  loadMediaLibraryViews: store.load,
  mutateMediaLibraryViews: store.mutate,
}));

beforeEach(() => vi.clearAllMocks());

function configuration(
  userId: string,
  overrides: Partial<SavedMediaViewsConfiguration> = {},
): SavedMediaViewsConfiguration {
  return {
    userId,
    surface: "images",
    query: "selected=asset-one&page=4&category=news",
    display: DEFAULT_MEDIA_DISPLAY,
    onApply: vi.fn(),
    onMissing: vi.fn(),
    onResetFilters: vi.fn(),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("useSavedMediaViews", () => {
  it("loads lazily once and reuses the account cache across route mounts", async () => {
    const view: SavedMediaView = { id: "news", name: "News", surface: "images", query: "category=news" };
    store.load.mockResolvedValueOnce([view]);
    const first = renderHook(() => useSavedMediaViews(configuration("lazy-account")));
    expect(store.load).not.toHaveBeenCalled();

    await act(() => Promise.all([first.result.current.load(), first.result.current.load()]));
    expect(store.load).toHaveBeenCalledTimes(1);
    expect(first.result.current.views).toEqual([view]);
    first.unmount();

    const second = renderHook(() => useSavedMediaViews(configuration("lazy-account")));
    expect(second.result.current.status).toBe("ready");
    await act(() => second.result.current.load());
    expect(store.load).toHaveBeenCalledTimes(1);
  });

  it("clears the cache for a new account and ignores the old account's late load", async () => {
    const oldLoad = deferred<SavedMediaView[]>();
    const nextLoad = deferred<SavedMediaView[]>();
    store.load.mockImplementation((userId: string) => userId === "old-account" ? oldLoad.promise : nextLoad.promise);
    const hook = renderHook(
      ({ userId }) => useSavedMediaViews(configuration(userId)),
      { initialProps: { userId: "old-account" } },
    );

    let oldPromise!: Promise<void>;
    act(() => { oldPromise = hook.result.current.load(); });
    hook.rerender({ userId: "next-account" });
    let nextPromise!: Promise<void>;
    act(() => { nextPromise = hook.result.current.load(); });
    nextLoad.resolve([{ id: "next", name: "Next", surface: "images", query: "" }]);
    await act(() => nextPromise);
    oldLoad.resolve([{ id: "old", name: "Old", surface: "images", query: "" }]);
    await act(() => oldPromise);

    expect(store.load).toHaveBeenCalledTimes(2);
    expect(hook.result.current.views.map((view) => view.id)).toEqual(["next"]);
  });

  it("reports a missing selected view and saves a validated canonical view", async () => {
    store.load.mockResolvedValueOnce([]);
    store.mutate.mockImplementation(async (_userId, mutation) =>
      mutation.type === "add" ? [mutation.view] : []);
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("11111111-1111-4111-8111-111111111111");
    const config = configuration("mutation-account", { currentViewId: "gone" });
    const hook = renderHook(() => useSavedMediaViews(config));
    await act(() => hook.result.current.load());
    await waitFor(() => expect(config.onMissing).toHaveBeenCalledOnce());

    await act(async () => {
      expect(await hook.result.current.save("  News review  ", true)).toBe(true);
    });
    expect(store.mutate).toHaveBeenCalledWith("mutation-account", {
      type: "add",
      view: expect.objectContaining({
        id: "11111111111141118111111111111111",
        name: "News review",
        surface: "images",
        query: "category=news",
        display: DEFAULT_MEDIA_DISPLAY,
      }),
    });
    expect(hook.result.current.views[0]?.name).toBe("News review");
  });
});
