import { describe, expect, it } from "vitest";
import snapshots from "../../functions/lib/publish-snapshot.js";
import metadata from "../../functions/lib/content-metadata.js";
import documents from "../../functions/lib/content-document-contract.js";
import { projectCmsPost } from "../src/lib/cms-posts-projection";
import fixture from "./fixtures/shadow-posts/post.json";

describe("story CTA opt-out persistence", () => {
  it.each([true, false])("freezes the saved opt-out value %s and ignores later draft changes", disabled => {
    const document = { ...structuredClone(fixture.document.published.metadata), version: 8,
      blocks: structuredClone(fixture.document.published.blocks), credits: [], disableStoryCtas: disabled };
    expect(metadata.validateKnownMetadata(document)).toBeNull();
    const published = snapshots.createPublishedSnapshot({ collection: "cmsPosts", document,
      publishedAt: "2026-11-13T12:00:00.000Z", publishedBy: "fixture-editor" });
    expect(published.metadata).toMatchObject({ disableStoryCtas: disabled });
    const output = projectCmsPost({ id: "fixture-story", status: "published", publiclyVisible: true,
      publishAt: published.publishedAt, disableStoryCtas: !disabled, published }, { now: new Date("2026-11-13T13:00:00.000Z") });
    expect(output?.disableStoryCtas).toBe(disabled);
  });
  it("admits the optional boolean at the save boundary and rejects invalid values", () => {
    expect(documents.CONTENT_DOCUMENT_CONTRACTS.post.fields.disableStoryCtas).toBe("boolean");
    expect(metadata.validateKnownMetadata({ type: "post" })).toBeNull();
    for (const invalid of ["true", 1, null]) {
      expect(metadata.validateKnownMetadata({ type: "post", disableStoryCtas: invalid })).toBe("disableStoryCtas must be a boolean");
      const value = structuredClone(fixture.document);
      value.published.metadata = { ...value.published.metadata, disableStoryCtas: invalid } as never;
      expect(() => projectCmsPost(value, { now: new Date("2026-11-13T13:00:00.000Z") })).toThrow(/disableStoryCtas/);
    }
  });
});
