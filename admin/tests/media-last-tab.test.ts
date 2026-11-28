import { describe, expect, it } from "vitest";
import { lastMediaTabKey, readLastMediaTab, writeLastMediaTab } from "../src/lib/media-last-tab";

describe("last media tab", () => {
  it("returns a stored tab only when the account may still open it", () => {
    localStorage.setItem(lastMediaTabKey("u1"), "/media/images");
    expect(readLastMediaTab("u1", () => true)).toBe("/media/images");
    expect(readLastMediaTab("u1", route => route.kind !== "images")).toBeNull();
    expect(readLastMediaTab("u2", () => true)).toBeNull();
  });

  it("stores only media tab routes", () => {
    writeLastMediaTab("u1", "/media/videos/station-archive");
    expect(localStorage.getItem(lastMediaTabKey("u1"))).toBe("/media/videos/station-archive");
    writeLastMediaTab("u1", "/media/sources");
    writeLastMediaTab("u1", "/media");
    expect(localStorage.getItem(lastMediaTabKey("u1"))).toBe("/media/videos/station-archive");
  });

  it("ignores a stored path that is no longer a tab", () => {
    localStorage.setItem(lastMediaTabKey("u1"), "/media/favorites");
    expect(readLastMediaTab("u1", () => true)).toBeNull();
  });
});
