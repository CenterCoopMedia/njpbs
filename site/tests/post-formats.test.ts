import { describe, expect, it } from "vitest";
import { primaryPostTopic, publicPostTopics, resolvePostPresentation } from "../src/lib/post-formats";

describe("resolvePostPresentation", () => {
  it("refuses an unknown reserved format instead of exposing it as a topic", () => {
    expect(() => resolvePostPresentation(["format:unknown"])).toThrow(
      /Unsupported Post format tag/,
    );
  });

  it("refuses repeated or competing format markers", () => {
    expect(() =>
      resolvePostPresentation([
        "format:special-report",
        "format:interactive",
      ]),
    ).toThrow(/one branded format tag/);
    expect(() =>
      resolvePostPresentation(["format:multimedia", "format:multimedia"]),
    ).toThrow(/one branded format tag/);
  });
});

describe("public Post topics", () => {
  it("removes reserved presentation metadata from reader-facing topics", () => {
    expect(
      publicPostTopics([
        "New Jersey",
        " format:interactive ",
        "Environment",
      ]),
    ).toEqual(["New Jersey", "Environment"]);
  });

  it("uses the first public topic as the subject label", () => {
    expect(
      primaryPostTopic(["format:special-report", "Elections", "New Jersey"]),
    ).toBe("Elections");
    expect(primaryPostTopic(["format:interactive"])).toBe("New Jersey");
  });
});
