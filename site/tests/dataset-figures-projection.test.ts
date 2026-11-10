import { describe, expect, it } from "vitest";
import type { DatasetPublicProjection } from "../../packages/content-core/src/data-figure";
import type { DatasetFigures } from "../../packages/content-core/src/dataset-figures";
import type { PageBlock } from "../../packages/content-core/src/content-model";
import { createExternalContentManifest } from "../src/lib/external-content-feed";
import { projectCmsPost, type CmsPostDoc } from "../src/lib/cms-posts-loader";
import { projectPublishedPageRead } from "../src/lib/published-page-render";
import { assertPublicArtifactBundle } from "../src/lib/public-artifact-bundle";
import {
  now,
  publishedPageRead,
} from "./fixtures/published-pages/fixtures";

const postNow = new Date("2026-10-21T12:00:00.000Z");

const block: PageBlock = {
  id: "figure-jobs",
  type: "data_figure",
  order: 0,
  visible: true,
  data: {
    datasetId: "jobs-rate",
    version: { mode: "pinned", releaseId: "september-2026" },
    display: "expanded",
  },
};

function projection(): DatasetPublicProjection {
  return {
    datasetId: "jobs-rate",
    releaseId: "september-2026",
    revision: 2,
    digest: "a".repeat(64),
    approvedAt: "2026-10-20T14:00:00.000Z",
    release: {
      label: "New Jersey employment rate",
      unit: "percent",
      value: 4.2,
      period: { start: "2026-09-01", end: "2026-09-30", label: "September 2026" },
      geography: { level: "state", code: "NJ", label: "New Jersey" },
      adjustment: "seasonally_adjusted",
      points: [{ period: "2026-09-30", value: 4.2 }],
      chartText: "The employment rate was 4.2 percent in September 2026.",
      methodNote: "Monthly estimate.",
      comparators: [],
      source: { publisher: "Example agency", title: "Monthly release", url: "https://example.test/data" },
      releasedOn: "2026-10-15",
      verifiedOn: "2026-10-16",
      changeKind: "new_release",
      changeNote: "",
      reuse: { display: "allowed", exports: "allowed", note: "Example agency" },
    },
  };
}

function figures(): DatasetFigures {
  const release = projection();
  return {
    figures: [{
      blockId: block.id,
      datasetId: release.datasetId,
      releaseId: release.releaseId,
      revision: release.revision,
      digest: release.digest,
    }],
    releases: [release],
  };
}

function post(datasetFigures: unknown = figures()): CmsPostDoc {
  return {
    id: "data-story",
    status: "published",
    publishAt: "2026-10-20T14:00:00.000Z",
    datasetFigures: { privateWorkingField: true },
    published: {
      blocks: [block],
      datasetFigures,
      sourceVersion: 4,
      publishedAt: "2026-10-20T14:00:00.000Z",
      metadata: {
        type: "post",
        title: "A data story",
        slug: "a-data-story",
        previousSlugs: [],
        locale: "en",
        categories: [],
        tags: [],
        summary: "A frozen data figure.",
        editorialDateSource: "firstPublish",
        firstPublishedAt: "2026-10-20T14:00:00.000Z",
        credits: [],
      },
    },
  };
}

describe("frozen dataset figure projection", () => {
  it("renders the Post and external feed from the published projection only", () => {
    const projected = projectCmsPost(post(), { now: postNow })!;
    expect(projected.datasetFigures).toEqual(figures());
    expect(JSON.stringify(projected)).not.toContain("privateWorkingField");

    const manifest = createExternalContentManifest({
      site: "https://www.njpbs.org/",
      posts: [projected],
      programs: [],
      authors: [],
    });
    expect(manifest.items[0].contentHtml).toContain("New Jersey employment rate");
    expect(manifest.items[0].contentHtml).toContain("<table>");
    expect(manifest.items[0].contentHtml).not.toContain("unavailable");
  });

  it("fails closed on missing or private fields and renders a withdrawal note", () => {
    const missing = post();
    delete (missing.published as Record<string, unknown>).datasetFigures;
    expect(() => projectCmsPost(missing, { now: postNow })).toThrow("no frozen dataset figures");
    const withPrivateField = projection() as DatasetPublicProjection & { reviewerEmail: string };
    withPrivateField.reviewerEmail = "private@example.test";
    expect(() => projectCmsPost(post({ ...figures(), releases: [withPrivateField] }), { now: postNow }))
      .toThrow("invalid frozen dataset figures");
    expect(() => assertPublicArtifactBundle({
      schemaVersion: 3,
      pages: [{ pageId: "about", blocks: [block], datasetFigures: { ...figures(), releases: [withPrivateField] } }],
      posts: [], programs: [], authors: [], settings: [], receipt: {},
    })).toThrow("invalid frozen dataset figures");

    const withdrawn: DatasetFigures = {
      figures: [{ blockId: block.id, datasetId: "jobs-rate", withdrawn: true }],
      releases: [],
    };
    const projected = projectCmsPost(post(withdrawn), { now: postNow })!;
    const manifest = createExternalContentManifest({
      site: "https://www.njpbs.org/",
      posts: [projected],
      programs: [],
      authors: [],
    });
    expect(manifest.items[0].contentHtml).toContain("This data figure is unavailable.");
    expect(manifest.items[0].contentHtml).not.toContain("New Jersey employment rate");
  });

  it("carries the same frozen projection through the compiled Page reader", async () => {
    const input = publishedPageRead("contact") as ReturnType<typeof publishedPageRead> & {
      page: { blocks: PageBlock[]; datasetFigures?: DatasetFigures };
    };
    input.page.blocks = [block];
    input.page.datasetFigures = figures();
    const content = await projectPublishedPageRead(input, "contact", "a".repeat(40), now);
    expect(content.pages[0].datasetFigures).toEqual(figures());
    expect(Object.isFrozen(content.pages[0].datasetFigures)).toBe(true);
  });
});
