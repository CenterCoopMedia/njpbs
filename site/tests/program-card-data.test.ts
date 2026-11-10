import { describe, expect, it } from "vitest";
import { projectCmsProgram } from "../src/lib/cms-programs-loader";
import { programCardData } from "../src/lib/program-card-data";

describe("programCardData", () => {
  it("uses the published projection and a short plain-text synopsis", () => {
    const snapshot = projectCmsProgram({
      id: "show-one", status: "published", publishAt: "2026-09-28T00:00:00.000Z", published: {
        metadata: { type: "program", title: "State of the Arts", slug: "state-of-the-arts", previousSlugs: [], description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Artists across New Jersey." }] }] }, genre: "Arts" },
        sourceVersion: 1, publishedAt: "2026-09-28T00:00:00.000Z",
      },
    }, { now: new Date("2026-09-29T00:00:00.000Z") })!;
    expect(programCardData(snapshot)).toEqual({ title: "State of the Arts", url: "/programs/state-of-the-arts/", art: null, alt: "", genre: "Arts", summary: "Artists across New Jersey." });
  });
});
