import { beforeAll, describe, expect, it } from "vitest";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import PostPresentation from "../src/components/PostPresentation.astro";
import { projectPublishedPostRead } from "../src/lib/published-post-shadow";
import { postLeadFixture, LEAD_LAYOUTS } from "../tests/fixtures/post-lead-media";
import type { CmsRenderContext } from "../src/lib/cms-render-context";

let container: Awaited<ReturnType<typeof AstroContainer.create>>;
beforeAll(async () => { container = await AstroContainer.create(); });

describe("CMS Post image placement in emitted markup", () => {
  it.each(LEAD_LAYOUTS)("prioritizes only the lead image in %s with a background and body images", async layout => {
    const fixture = postLeadFixture(layout, "image");
    const content = structuredClone(projectPublishedPostRead(fixture, String(fixture.document.published.metadata.slug),
      "a".repeat(40), new Date("2026-10-07T13:00:00Z"))!);
    const post = content.posts[0];
    post.heroBackgroundImage = { assetId: "background-fixture", url: "/background.webp", width: 1200, height: 675, mimeType: "image/webp" };
    const html = await container.renderToString(PostPresentation, {
      props: { entry: { id: post.postId, collection: "cmsPosts", data: post }, credits: post.credits,
        canonicalUrl: `https://njpbs.org${post.path}` },
      locals: { cmsRender: { content, homeSources: {} } as CmsRenderContext },
      request: new Request(`https://njpbs.org${post.path}`),
    });
    const images = html.match(/<img\b[^>]*>/g) ?? [];
    const high = images.filter(image => image.includes('fetchpriority="high"'));
    expect(high).toHaveLength(1);
    expect(high[0]).toContain('loading="eager"');
    expect(high[0]).toContain('alt="Residents on the platform"');
    const background = images.find(image => image.includes('src="/background.webp"'));
    expect(background).toContain('loading="lazy"');
    expect(background).not.toContain('fetchpriority="high"');
    for (const image of images.filter(image => image.includes('data-asset-id='))) {
      expect(image).toContain('loading="lazy"');
    }
  });
});
