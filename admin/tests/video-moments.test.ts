import { afterEach, describe, expect, it, vi } from "vitest";
import { pruneBrowserVideoMoments, readVideoMoments, videoMomentsKey, writeVideoMoments } from "../src/lib/video-moments";

const moments = { bookmarks: [{ id: "opening", name: "Opening remark", seconds: 12 }], resume: 48 };
const key = (user: string, version: string) => videoMomentsKey(user, "video-library", "interview", version);

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("video moments retention", () => {
  it("prunes expired entries and entries for other accounts while keeping current moments", () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now - 30 * 24 * 60 * 60 * 1000);
    writeVideoMoments(key("editor", "old-version"), moments);
    clock.mockReturnValue(now);
    writeVideoMoments(key("editor", "current-version"), moments);
    writeVideoMoments(key("editor:other", "current-version"), moments);
    localStorage.setItem("unrelated-preference", "keep");

    pruneBrowserVideoMoments("editor");

    expect(localStorage.getItem(key("editor", "old-version"))).toBeNull();
    expect(localStorage.getItem(key("editor:other", "current-version"))).toBeNull();
    expect(readVideoMoments(key("editor", "current-version"))).toEqual(moments);
    expect(localStorage.getItem("unrelated-preference")).toBe("keep");
  });

  it("drops a moment that expires while the editor has the viewer open", () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const storageKey = key("editor", "current-version");
    writeVideoMoments(storageKey, moments);

    clock.mockReturnValue(now + 30 * 24 * 60 * 60 * 1000);

    expect(readVideoMoments(storageKey)).toEqual({ bookmarks: [], resume: null });
    expect(localStorage.getItem(storageKey)).toBeNull();
  });
});
