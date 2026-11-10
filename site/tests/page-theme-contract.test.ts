// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
vi.mock("astro:content", () => import("astro/content/config"));
import previewSnapshotPkg from "../../functions/lib/preview-snapshot.js";
import publicProjectionPkg from "../../functions/lib/public-content-projection.js";
import publishSnapshotPkg from "../../functions/lib/publish-snapshot.js";
import { collections } from "../src/content.config";
import { projectCmsPage, type CmsPageDoc } from "../src/lib/cms-loader";
import { projectPublishedPageRead } from "../src/lib/published-page-render";
import { publishedPageRead, customId as PAGE_ID } from "./fixtures/published-pages/fixtures";

const { createPreviewSnapshot } = previewSnapshotPkg;
const { projectPublicPageDocument } = publicProjectionPkg;
const { createPublishedSnapshot } = publishSnapshotPkg;

const NOW = new Date("2026-10-26T12:00:00.000Z");
const PUBLISHED_AT = "2026-10-26T11:00:00.000Z";

const divider = {
  id: "divider-1",
  type: "divider",
  order: 0,
  visible: true,
  data: {},
} as const;

function workingPage(pageTheme: unknown = "nj-decides") {
  return {
    id: PAGE_ID,
    title: "Election coverage",
    slug: "renamed-page",
    pageTheme,
    template: "genericPage",
    status: "published",
    publiclyVisible: true,
    publishAt: PUBLISHED_AT,
    blocks: [divider],
    version: 4,
  };
}

describe("Page theme publication contract", () => {
  it("round-trips a valid theme through snapshots and both public projections", () => {
    const working = workingPage();
    const published = createPublishedSnapshot({
      collection: "cmsPages",
      document: working,
      publishedAt: PUBLISHED_AT,
      publishedBy: "editor-1",
    });
    expect(published.metadata).toMatchObject({ pageTheme: "nj-decides" });
    expect(createPreviewSnapshot(PAGE_ID, working).pageTheme).toBe("nj-decides");

    const document = { ...working, published };
    const publicProjection = projectPublicPageDocument({
      pageId: PAGE_ID,
      document,
      assets: new Map(),
      now: NOW,
    });
    if (!("page" in publicProjection)) throw new Error("Expected a live Page projection");
    expect(publicProjection.page.pageTheme).toBe("nj-decides");
    const siteProjection = projectCmsPage(document as CmsPageDoc, {
      mode: "published",
      now: NOW,
    });
    expect(siteProjection?.pageTheme).toBe("nj-decides");
    const schema = collections.cmsPages.schema as { parse(data: unknown): unknown };
    expect(schema.parse(siteProjection)).toMatchObject({ pageTheme: "nj-decides" });
  });

  it("falls back to the default presentation for malformed historical themes", () => {
    const working = workingPage("retired-campaign-theme");
    expect(() => createPublishedSnapshot({
      collection: "cmsPages",
      document: working,
      publishedAt: PUBLISHED_AT,
      publishedBy: "editor-1",
    })).toThrow("pageTheme must be default or nj-decides");

    const published = createPublishedSnapshot({
      collection: "cmsPages",
      document: { ...working, pageTheme: "default" },
      publishedAt: PUBLISHED_AT,
      publishedBy: "editor-1",
    });
    Object.assign(published.metadata, { pageTheme: "retired-campaign-theme" });
    const document = { ...working, published };

    expect(createPreviewSnapshot(PAGE_ID, working)).not.toHaveProperty("pageTheme");
    const publicProjection = projectPublicPageDocument({
      pageId: PAGE_ID,
      document,
      assets: new Map(),
      now: NOW,
    });
    if (!("page" in publicProjection)) throw new Error("Expected a live Page projection");
    expect(publicProjection.page).not.toHaveProperty("pageTheme");
    expect(projectCmsPage(document as CmsPageDoc, {
      mode: "published",
      now: NOW,
    })).not.toHaveProperty("pageTheme");
  });

  it("keeps only valid themes through the frozen public Page read", async () => {
    const valid = publishedPageRead(PAGE_ID);
    Object.assign(valid.page, { pageTheme: "nj-decides" });
    const themed = await projectPublishedPageRead(
      valid,
      PAGE_ID,
      "a".repeat(40),
      NOW,
    );
    expect(themed.pages[0].pageTheme).toBe("nj-decides");

    const historical = publishedPageRead(PAGE_ID);
    Object.assign(historical.page, { pageTheme: "retired-campaign-theme" });
    const fallback = await projectPublishedPageRead(
      historical,
      PAGE_ID,
      "a".repeat(40),
      NOW,
    );
    expect(fallback.pages[0]).not.toHaveProperty("pageTheme");
  });
});
