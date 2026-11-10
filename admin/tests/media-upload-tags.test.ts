import { describe, expect, it } from "vitest";
import { normalizeMediaTags } from "../src/lib/media-upload";

describe("normalizeMediaTags", () => {
  it("keeps each tag's spelling, drops a duplicate in another case and trims", () => {
    expect(normalizeMediaTags(" Interview , interview,Newark,, ")).toEqual({ tags: ["Interview", "Newark"], error: null });
  });

  it("says Keep each tag under 41 characters. for a 41-character tag", () => {
    expect(normalizeMediaTags(`ok, ${"x".repeat(41)}`)).toEqual({ tags: [], error: "Keep each tag under 41 characters." });
    expect(normalizeMediaTags("x".repeat(40)).error).toBeNull();
  });

  it("says Use 20 tags or fewer. for 21 tags", () => {
    const tags = Array.from({ length: 21 }, (_, index) => `tag${index}`);
    expect(normalizeMediaTags(tags.join(","))).toEqual({ tags: [], error: "Use 20 tags or fewer." });
    expect(normalizeMediaTags(tags.slice(0, 20).join(",")).tags).toHaveLength(20);
  });

  it("accepts a token array with the same limits and messages as the comma string", () => {
    expect(normalizeMediaTags([" Interview ", "interview", "", "Newark"])).toEqual({ tags: ["Interview", "Newark"], error: null });
    expect(normalizeMediaTags(["x".repeat(41)])).toEqual({ tags: [], error: "Keep each tag under 41 characters." });
    expect(normalizeMediaTags(Array.from({ length: 21 }, (_, index) => `tag${index}`))).toEqual({ tags: [], error: "Use 20 tags or fewer." });
    // A token holds one tag, so a comma inside it is not a separator.
    expect(normalizeMediaTags(["Newark, NJ"]).tags).toEqual(["Newark, NJ"]);
  });
});
