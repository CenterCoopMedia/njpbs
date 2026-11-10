import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_RECENT_MEDIA_TAGS, clearRecentTags, readRecentTags, recentTagsKey, recordRecentTags } from "../src/lib/recent-media-tags";
import { clearMediaSessionCache, setMediaCacheUser } from "../src/lib/media-session-cache";

beforeEach(() => setMediaCacheUser("staff-a"));

afterEach(() => {
  clearMediaSessionCache();
  localStorage.clear();
});

function memoryStore(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, String(value)); },
  };
}

function throwingStore(): Storage {
  const fail = () => { throw new Error("blocked"); };
  return { length: 0, clear: fail, getItem: fail, key: fail, removeItem: fail, setItem: fail };
}

describe("recent media tags", () => {
  it("does not show one staff account's saved tags to the next account", () => {
    setMediaCacheUser("staff-a");
    recordRecentTags("images", ["Private image tag"], "staff-a");
    recordRecentTags("video", ["Private video tag"], "staff-a");
    expect(readRecentTags("images", "staff-a")).toEqual(["Private image tag"]);
    expect(readRecentTags("video", "staff-a")).toEqual(["Private video tag"]);

    setMediaCacheUser("staff-b");
    expect(readRecentTags("images", "staff-b")).toEqual([]);
    expect(readRecentTags("video", "staff-b")).toEqual([]);
    recordRecentTags("images", ["Second account tag"], "staff-b");
    // An old account's pending save must not change the new account's suggestions.
    recordRecentTags("images", ["Late first account tag"], "staff-a");
    expect(readRecentTags("images", "staff-b")).toEqual(["Second account tag"]);
    expect(readRecentTags("images", "staff-a")).toEqual(["Private image tag"]);
  });

  it("ignores legacy tags that have no account owner", () => {
    localStorage.setItem("njpbs-admin:media-recent-tags:images", JSON.stringify(["Previous staff tag"]));
    localStorage.setItem("njpbs-admin:media-recent-tags:video", JSON.stringify(["Previous video tag"]));
    expect(readRecentTags("images", "staff-a")).toEqual([]);
    expect(readRecentTags("video", "staff-a")).toEqual([]);
  });

  it("does not read or save tags without an account", () => {
    recordRecentTags("images", ["Unowned tag"], "");
    expect(readRecentTags("images", "")).toEqual([]);
    expect(localStorage.length).toBe(0);
  });

  it("allows cleanup when storage is missing or blocked", () => {
    expect(() => clearRecentTags(null)).not.toThrow();
    expect(() => clearRecentTags({ ...throwingStore(), length: 1 })).not.toThrow();
  });

  it("removes recent tags at sign-out without clearing other browser preferences", () => {
    setMediaCacheUser("staff-a");
    recordRecentTags("images", ["Private image tag"], "staff-a");
    recordRecentTags("video", ["Private video tag"], "staff-a");
    localStorage.setItem("unrelated-preference", "keep");

    clearMediaSessionCache();

    expect(readRecentTags("images", "staff-a")).toEqual([]);
    expect(readRecentTags("video", "staff-a")).toEqual([]);
    expect(localStorage.getItem("unrelated-preference")).toBe("keep");
  });

  it("does not restore tags from a save that finishes after sign-out", () => {
    recordRecentTags("images", ["Private image tag"], "staff-a");
    recordRecentTags("video", ["Private video tag"], "staff-a");
    clearMediaSessionCache();

    recordRecentTags("images", ["Late image tag"], "staff-a");
    recordRecentTags("video", ["Late video tag"], "staff-a");

    expect(readRecentTags("images", "staff-a")).toEqual([]);
    expect(readRecentTags("video", "staff-a")).toEqual([]);
    expect(localStorage.length).toBe(0);
  });

  it("stores the newest 20 tags per surface, newest first", () => {
    const store = memoryStore();
    recordRecentTags("images", ["Newark", "Budget"], "staff-a", store);
    recordRecentTags("images", ["Trenton", "newark"], "staff-a", store);
    expect(readRecentTags("images", "staff-a", store)).toEqual(["Trenton", "newark", "Budget"]);
    expect(readRecentTags("video", "staff-a", store)).toEqual([]);
    expect(recentTagsKey("video", "staff-a")).toBe("njpbs-admin:media-recent-tags:video:staff-a");

    recordRecentTags("video", Array.from({ length: 25 }, (_, index) => `tag${index}`), "staff-a", store);
    const video = readRecentTags("video", "staff-a", store);
    expect(MAX_RECENT_MEDIA_TAGS).toBe(20);
    expect(video).toHaveLength(20);
    expect(video[0]).toBe("tag0");
    expect(readRecentTags("images", "staff-a", store)).toEqual(["Trenton", "newark", "Budget"]);
  });

  it("returns an empty list when storage throws or holds bad JSON", () => {
    expect(readRecentTags("images", "staff-a", throwingStore())).toEqual([]);
    expect(() => recordRecentTags("images", ["Newark"], "staff-a", throwingStore())).not.toThrow();
    expect(readRecentTags("images", "staff-a", null)).toEqual([]);
    const store = memoryStore();
    store.setItem(recentTagsKey("images", "staff-a"), "{not json");
    expect(readRecentTags("images", "staff-a", store)).toEqual([]);
    store.setItem(recentTagsKey("images", "staff-a"), JSON.stringify({ tags: ["Newark"] }));
    expect(readRecentTags("images", "staff-a", store)).toEqual([]);
    store.setItem(recentTagsKey("images", "staff-a"), JSON.stringify(["Newark", 4, "", " "]));
    expect(readRecentTags("images", "staff-a", store)).toEqual(["Newark"]);
  });
});
