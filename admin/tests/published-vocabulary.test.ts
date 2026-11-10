import { describe, expect, it } from "vitest";
import { publishedVocabulary } from "../../packages/content-core/src/published-vocabulary";

const live = (tags: unknown, categories: unknown = []) => ({ type: "post", status: "published",
  published: { sourceVersion: 1, metadata: { tags, categories } } });

describe("published editorial vocabulary (#1689)", () => {
  it("uses only visible published metadata, including a live Post with a newer working draft", () => {
    expect(publishedVocabulary([
      { ...live(["education"], ["Schools"]), tags: ["draft-only"], categories: ["Draft category"] },
      { ...live(["health"]), status: "draft", publiclyVisible: true },
      { type: "post", status: "draft", tags: ["never published"] },
      { ...live(["withdrawn"]), publiclyVisible: false },
      { ...live(["deleted"]), deleted: true },
      { ...live(["pending"]), publishBuildPending: true },
      { ...live(["not live yet"]), publicSourceVersion: 2 },
      { ...live(["media tag"]), type: "media", category: "media-owning-category", section: "access-group" },
      { ...live(["bad version"]), published: { sourceVersion: 0, metadata: { tags: ["bad version"] } } },
    ])).toEqual({ tags: ["education", "health"], categories: ["Schools"] });
  });

  it("folds case and surrounding space, keeps the first saved form, and excludes reserved markers", () => {
    expect(publishedVocabulary([
      live(["education", "  Education ", "format:interactive", " FORMAT:multimedia ", "", null], ["Schools", " schools "]),
      live(["EDUCATION", "Water"], ["Health", "format:hidden"]),
    ])).toEqual({ tags: ["education", "Water"], categories: ["Health", "Schools"] });
  });
});
