import { beforeAll, describe, expect, it } from "vitest";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import CmsPage from "../src/components/CmsPage.astro";
import PostPresentation from "../src/components/PostPresentation.astro";
import { projectCmsPreviewContent } from "../src/lib/cms-preview-content";
import { projectCmsPage } from "../src/lib/cms-loader";
import { now, blocks, input, fixture } from "../tests/fixtures/cms-preview-content";
import CmsBlocks from "../src/components/CmsBlocks.astro";
import { defaultDataHubBlocks } from "../../packages/content-core/src/data-hub-composition";
import type { CmsRenderContext } from "../src/lib/cms-render-context";
import { readFileSync } from "node:fs";
import { dataHubSectionHtml } from "../src/lib/data-hub-composition-render";

let container: Awaited<ReturnType<typeof AstroContainer.create>>;
beforeAll(async () => { container = await AstroContainer.create(); });

describe("existing templates with request-scoped content", () => {
  it("renders different Page inputs through the same imported component without a content-store update", async () => {
    const a = fixture(input("cmsPages", "Page Alpha", "A".repeat(20)));
    const b = fixture(input("cmsPages", "Page Beta", "B".repeat(20)));
    const render = async (f: typeof a) => {
      const content = projectCmsPreviewContent(f.bytes, f.request, now);
      return container.renderToString(CmsPage, {
        props: { entry: { id: "contact", collection: "cmsPages", data: content.pages[0] } },
        request: new Request("https://preview.njpbs.org/contact/"),
      });
    };
    const first = await render(a);
    const second = await render(b);
    expect(first).toContain("Page Alpha"); expect(first).not.toContain("Page Beta");
    expect(second).toContain("Page Beta"); expect(second).not.toContain("Page Alpha");
    expect(first).toContain('data-cms-content-mode="draft"');
    expect(await render(a)).toBe(first);
  });

  it("renders independent Post inputs through the same presentation component", async () => {
    const render = async (title: string, queueId: string) => {
      const f = fixture(input("cmsPosts", title, queueId));
      const post = projectCmsPreviewContent(f.bytes, f.request, now).posts[0];
      return container.renderToString(PostPresentation, {
        props: { entry: { id: post.postId, collection: "cmsPosts", data: post },
          credits: post.credits, canonicalUrl: "https://njpbs.org/posts/exact-story/" },
        request: new Request("https://preview.njpbs.org/posts/exact-story/"),
      });
    };
    const [first, second] = await Promise.all([
      render("Post Alpha", "A".repeat(20)), render("Post Beta", "B".repeat(20)),
    ]);
    expect(first).toContain("Post Alpha"); expect(first).not.toContain("Post Beta");
    expect(second).toContain("Post Beta"); expect(second).not.toContain("Post Alpha");
    expect(first).toContain("Only this draft");
    expect(second).toContain("Only this draft");
  });

  it("keeps Page body markup identical for the equivalent existing published projection", async () => {
    const f = fixture();
    const draft = projectCmsPreviewContent(f.bytes, f.request, now).pages[0];
    const published = projectCmsPage({
      id: "contact", status: "published", publishAt: now.toISOString(),
      published: { sourceVersion: 7, publishedAt: now.toISOString(), blocks,
        metadata: { title: "Exact draft", description: "", template: "genericPage" } },
    }, { mode: "published", now, assets: new Map() });
    expect(published).not.toBeNull();
    const render = (data: typeof draft) => container.renderToString(CmsPage, {
      props: { entry: { id: "contact", collection: "cmsPages", data } },
      request: new Request("https://njpbs.org/contact/"),
    });
    const draftHtml = await render(draft);
    const publicHtml = await render(published!);
    expect(draftHtml.replaceAll('data-cms-content-mode="draft"', 'data-cms-content-mode="published"')).toBe(publicHtml);
  });
});

it("renders Data Hub sections and prose through standard CmsBlocks with private/public parity", async () => {
  const source = readFileSync(new URL("../src/data/njpbs-data-hub-v16.html", import.meta.url), "utf8");
  const value = input();
  value.pageId = "data-hub";
  value.snapshot = { id: "data-hub", version: 7, template: "genericPage", title: "Exact Data Hub",
    dataHubCompositionVersion: 1, blocks: [
      { ...defaultDataHubBlocks().find(block => block.data.sectionId === "unemployment")!, order: 0 },
      { id: "staff-copy", type: "prose", order: 1, visible: true, data: { content: { type: "doc", content: [
        { type: "paragraph", content: [{ type: "text", text: "Staff context between the figures." }] },
      ] } } },
    ],
  } as typeof value.snapshot;
  const sealed = fixture(value);
  const draft = projectCmsPreviewContent(sealed.bytes, sealed.request, now);
  const published = projectCmsPage({ id: "data-hub", status: "published", publishAt: now.toISOString(),
    published: { sourceVersion: 7, publishedAt: now.toISOString(), blocks: value.snapshot.blocks,
      metadata: { title: "Exact Data Hub", template: "genericPage", dataHubCompositionVersion: 1 } },
  }, { mode: "published", now, assets: new Map() })!;
  const render = (content: typeof draft) => container.renderToString(CmsBlocks, {
    props: { entry: { id: "data-hub", collection: "cmsPages", data: content.pages[0] }, contained: false,
      resolveDataHubSection: (data: Parameters<typeof dataHubSectionHtml>[1], level: number) => dataHubSectionHtml(source, data, level) },
    request: new Request("https://njpbs.org/data-hub/"),
    locals: { cmsRender: { content, homeSources: {} } as CmsRenderContext },
  });
  const privateHtml = await render(draft);
  const publicHtml = await render({ ...draft, kind: "public-page", pages: [published] } as unknown as typeof draft);
  expect(privateHtml.replaceAll('data-cms-content-mode="draft"', 'data-cms-content-mode="published"')).toBe(publicHtml);
  for (const html of [privateHtml, publicHtml]) {
    expect(html).toContain('data-cms-page-blocks="data-hub"');
    expect(html).toContain('data-data-hub-section="unemployment"');
    expect(html).toContain("Staff context between the figures.");
    expect(html).toContain("NJ Department of Labor and Workforce Development");
  }
});
