import { describe, expect, it } from "vitest";
import { boundedMediaTime, mediaPermalink, parseMediaPermalink } from "../src/lib/media-permalink";

describe("internal media links", () => {
  it("carries only identifiers and a bounded numeric time", () => {
    expect(mediaPermalink("/media/videos/video-library", "vid_8f3a", 72)).toBe("/media/videos/video-library?asset=vid_8f3a&t=72");
    expect(parseMediaPermalink(new URLSearchParams("asset=vid_8f3a&t=72"))).toEqual({ assetId: "vid_8f3a", seconds: 72 });
  });
  it.each(["../secret", "https://storage/file?token=x", "a".repeat(129), "", "a/b"])("rejects identifier %s", id => {
    expect(parseMediaPermalink(new URLSearchParams({ asset: id })).assetId).toBeUndefined();
  });
  it.each(["-1", "NaN", "Infinity", "1e5", "", "9007199254740992"])("starts at zero for invalid time %s", t => {
    expect(parseMediaPermalink(new URLSearchParams({ asset: "video", t }))).toMatchObject({ assetId: "video", seconds: 0, error: expect.any(String) });
  });
  it("rejects ambiguous duplicate identifiers", () => {
    expect(parseMediaPermalink(new URLSearchParams("asset=a&asset=b")).error).toBeTruthy();
  });
  it("starts at zero with a message at or beyond the end", () => {
    expect(boundedMediaTime(72, 100)).toEqual({ seconds: 72 });
    expect(boundedMediaTime(100, 100)).toMatchObject({ seconds: 0, message: expect.any(String) });
    expect(boundedMediaTime(99999, 100)).toMatchObject({ seconds: 0, message: expect.any(String) });
  });
});
