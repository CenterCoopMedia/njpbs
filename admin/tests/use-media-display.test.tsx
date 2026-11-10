import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MEDIA_DISPLAY,
  DEFAULT_VIDEO_MEDIA_DISPLAY,
  MEDIA_DISPLAY_STORAGE_KEY,
  VIDEO_MEDIA_DISPLAY_STORAGE_KEY,
} from "../src/lib/media-display";
import { useMediaDisplay } from "../src/lib/use-media-display";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("useMediaDisplay", () => {
  it("reads once on mount, writes on change, never touches the URL, and tolerates unknown stored keys", () => {
    localStorage.setItem(MEDIA_DISPLAY_STORAGE_KEY, JSON.stringify({ thumbnail: "l", layout: "list", future: 3 }));
    const read = vi.spyOn(Storage.prototype, "getItem");
    const push = vi.spyOn(window.history, "pushState");
    const replace = vi.spyOn(window.history, "replaceState");
    const href = window.location.href;

    const { rerender, result } = renderHook(() => useMediaDisplay("images"));
    // Phase 3 reads layout; "future" stays an unknown key.
    expect(result.current.display).toEqual({ ...DEFAULT_MEDIA_DISPLAY, thumbnail: "l", layout: "list" });
    rerender();
    rerender();
    expect(read).toHaveBeenCalledTimes(1);

    act(() => result.current.setDisplay({ ...result.current.display, density: "compact" }));
    expect(result.current.display.density).toBe("compact");
    expect(JSON.parse(localStorage.getItem(MEDIA_DISPLAY_STORAGE_KEY) ?? "{}")).toMatchObject({ thumbnail: "l", density: "compact" });

    act(() => result.current.resetDisplay());
    expect(result.current.display).toEqual(DEFAULT_MEDIA_DISPLAY);
    expect(localStorage.getItem(MEDIA_DISPLAY_STORAGE_KEY)).toBeNull();

    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(window.location.href).toBe(href);
  });

  it("reads and writes video preferences under the video surface key", () => {
    localStorage.setItem(MEDIA_DISPLAY_STORAGE_KEY, JSON.stringify({ ...DEFAULT_MEDIA_DISPLAY, layout: "list" }));
    localStorage.setItem(VIDEO_MEDIA_DISPLAY_STORAGE_KEY, JSON.stringify({
      ...DEFAULT_VIDEO_MEDIA_DISPLAY,
      layout: "list",
      pageSize: 48,
    }));

    const { result } = renderHook(() => useMediaDisplay("video"));
    expect(result.current.display).toEqual({ ...DEFAULT_VIDEO_MEDIA_DISPLAY, layout: "list" });

    act(() => result.current.setDisplay({ ...result.current.display, pageSize: 96 }));
    expect(JSON.parse(localStorage.getItem(VIDEO_MEDIA_DISPLAY_STORAGE_KEY) ?? "{}")).not.toHaveProperty("pageSize");
    expect(JSON.parse(localStorage.getItem(MEDIA_DISPLAY_STORAGE_KEY) ?? "{}").layout).toBe("list");

    act(() => result.current.resetDisplay());
    expect(result.current.display).toEqual(DEFAULT_VIDEO_MEDIA_DISPLAY);
    expect(localStorage.getItem(VIDEO_MEDIA_DISPLAY_STORAGE_KEY)).toBeNull();
  });
});
