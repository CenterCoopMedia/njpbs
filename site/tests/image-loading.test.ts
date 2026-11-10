// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createPageImageLoading } from "../../packages/content-core/src/image-loading";
import { renderBlock, renderResolvedImage } from "../../packages/content-core/src/content-render";
import { parseBlocks } from "../../packages/content-core/src/content-model";

const image = { url: "/cms-media/image.webp", width: 1200, height: 675 };

describe("page image loading contract", () => {
  it("keeps content lazy and grants at most one valid LCP candidate per page", () => {
    const imageLoading = createPageImageLoading();
    expect(imageLoading(image, "content")).toEqual({ loading: "lazy", decoding: "async" });
    const html = [
      renderResolvedImage("first", "Lead", image, { imageLoading, placement: "lcp" }),
      renderResolvedImage("second", "Background", image, { imageLoading, placement: "lcp" }),
      renderResolvedImage("third", "Body", image, { imageLoading }),
    ].join("");
    expect(html.match(/fetchpriority="high"/g)).toHaveLength(1);
    expect(html.match(/loading="eager"/g)).toHaveLength(1);
    expect(html.match(/loading="lazy"/g)).toHaveLength(2);
    expect(html.match(/decoding="async"/g)).toHaveLength(3);
    expect(createPageImageLoading()(image, "lcp").loading).toBe("eager");
  });

  it.each([undefined, null, {}, { width: 0, height: 10 }, { width: 10, height: -1 },
    { width: 10.5, height: 10 }, { width: 10, height: Number.NaN },
    { width: Number.POSITIVE_INFINITY, height: 10 }])("does not prioritize invalid intrinsic dimensions: %j", invalid => {
    const imageLoading = createPageImageLoading();
    expect(imageLoading(invalid, "lcp")).toEqual({ loading: "lazy", decoding: "async" });
    expect(imageLoading(image, "lcp").fetchpriority).toBe("high");
  });

  it("preserves resolved responsive sources and escapes every asset attribute", () => {
    const imageLoading = createPageImageLoading();
    const html = renderResolvedImage('id"<', 'Alt"<', {
      ...image, url: '/cms-media/image.webp?q="<',
      srcset: '/small.webp?q="< 320w, /large.webp 1200w', sizes: '(max-width: 40em) 100vw, 1200px',
      sources: [{ type: 'image/avif', srcset: '/small.avif?q="< 320w' }],
    }, { imageLoading, placement: "lcp", className: 'hero"<' });
    expect(html).toContain('<picture><source type="image/avif"');
    expect(html).toContain('srcset="/small.avif?q=&quot;&lt; 320w"');
    expect(html).toContain('srcset="/small.webp?q=&quot;&lt; 320w, /large.webp 1200w"');
    expect(html).toContain('src="/cms-media/image.webp?q=&quot;&lt;"');
    expect(html).toContain('alt="Alt&quot;&lt;"');
    expect(html).toContain('class="hero&quot;&lt;"');
    expect(html).toContain('width="1200" height="675" loading="eager"');
    expect(html).toContain('sizes="(max-width: 40em) 100vw, 1200px"');
  });

  it("keeps ordinary images lazy even when stored data requests priority", () => {
    const parsed = parseBlocks([{ id: "body", type: "image", visible: true, order: 0,
      data: { assetId: "asset", alt: "Body image", placement: "lcp", loading: "eager", fetchpriority: "high" } }]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error);
    const html = renderBlock(parsed.blocks[0], { resolveAsset: () => image });
    expect(html).toContain('loading="lazy"');
    expect(html).not.toContain('fetchpriority="high"');
    expect(renderResolvedImage("ordinary", "Body image", image, { placement: "lcp" })).toContain('loading="lazy"');
  });
});
