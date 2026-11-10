import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const multimedia = readFileSync(
  join(process.cwd(), "src", "components", "MultimediaFeaturePost.astro"),
  "utf8",
);

describe("Multimedia Feature presentation", () => {
  it("keeps format metadata out of Topics and introduces no active embed path", () => {
    expect(multimedia).toContain("publicPostTopics(post.tags)");
    expect(multimedia).not.toContain("post.tags.map");
    expect(multimedia).not.toMatch(/<iframe|<script|autoplay/i);
  });
});
