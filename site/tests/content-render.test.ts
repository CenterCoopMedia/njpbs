import { describe, expect, it } from "vitest";
import {
  GALLERY_PRESENTATIONS,
  parseBlocks,
  type RichTextDoc,
} from "../../packages/content-core/src/content-model";
import {
  generatedHeadingLevelAt,
  renderBlock,
  renderResolvedImage,
  type RenderBlockOptions,
  youtubePlayerSrc,
} from "../../packages/content-core/src/content-render";
import { renderLinkCard } from "../../packages/content-core/src/coverage-list";

const doc = (content: RichTextDoc["content"]): RichTextDoc => ({ type: "doc", content });
const para = (text: string, marks?: { type: string; attrs?: Record<string, unknown> }[]) => ({
  type: "paragraph",
  content: [{ type: "text", text, marks }],
});

// Build one validated PageBlock the way the site does (through parseBlocks), so a
// fixture that is not a real block fails loudly here instead of rendering garbage.
function block(
  type: string,
  data: Record<string, unknown>,
  options: RenderBlockOptions = {},
): string | null {
  const result = parseBlocks([{ id: "b1", type, order: 0, visible: true, data }]);
  if (!result.ok) throw new Error(`invalid fixture: ${result.error}`);
  return renderBlock(result.blocks[0], options);
}

describe("renderBlock", () => {
  describe("prose", () => {
    it("renders the stored rich text through the safe renderer", () => {
      expect(block("prose", { content: doc([para("Hello world.")]) })).toBe("<p>Hello world.</p>");
    });

    it("escapes markup and drops an unsafe link scheme (routed through renderRichText)", () => {
      const html = block("prose", {
        content: doc([
          para('<b>x</b> & "q"'),
          para("link", [{ type: "link", attrs: { href: "javascript:alert(1)" } }]),
        ]),
      });
      expect(html).toBe('<p>&lt;b&gt;x&lt;/b&gt; &amp; &quot;q&quot;</p><p>link</p>');
    });

    it("opens external links in a new tab when the page frame requests it", () => {
      const html = block(
        "prose",
        {
          content: doc([
            para("External story", [{ type: "link", attrs: { href: "https://example.org/story" } }]),
            para("NJ PBS page", [{ type: "link", attrs: { href: "/about/" } }]),
          ]),
        },
        { externalLinksNewTab: true },
      );

      expect(html).toContain(
        '<a href="https://example.org/story" target="_blank" rel="noopener">External story<span class="sr-only"> (opens in new tab)</span></a>',
      );
      expect(html).toContain('<a href="/about/">NJ PBS page</a>');
    });

    it("can assign a stable id to a matching rich-text heading", () => {
      const html = block(
        "prose",
        {
          content: doc([
            {
              type: "heading",
              attrs: { level: 2 },
              content: [{ type: "text", text: "Your privacy choices" }],
            },
            para("Choose what to request."),
          ]),
        },
        {
          richTextHeadingId: (text) =>
            text.trim() === "Your privacy choices" ? "your-privacy-choices" : undefined,
        },
      );

      expect(html).toBe(
        '<h2 id="your-privacy-choices">Your privacy choices</h2>' +
          "<p>Choose what to request.</p>",
      );
    });
  });

  describe("headline", () => {
    it("defaults to an h2 when no level is set", () => {
      expect(block("headline", { text: "Section" })).toBe("<h2>Section</h2>");
    });

    it("honors an explicit level", () => {
      expect(block("headline", { text: "Top", level: 1 })).toBe("<h1>Top</h1>");
    });

    it("clamps an out-of-range level into h1..h6", () => {
      expect(block("headline", { text: "Low", level: 9 })).toBe("<h6>Low</h6>");
      expect(block("headline", { text: "High", level: 0 })).toBe("<h1>High</h1>");
    });

    it("falls back to h2 for a non-integer level", () => {
      expect(block("headline", { text: "Frac", level: 2.5 })).toBe("<h2>Frac</h2>");
    });

    it("escapes the heading text", () => {
      expect(block("headline", { text: '<script>alert("x")</script>' })).toBe(
        "<h2>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</h2>",
      );
    });
  });

  describe("divider", () => {
    it("renders a horizontal rule with no fields", () => {
      expect(block("divider", {})).toBe("<hr>");
    });
  });

  describe("content_shelf", () => {
    it("renders the editable shelf frame without copying source-owned cards", () => {
      expect(
        block("content_shelf", {
          title: "Featured on NJ PBS",
          source: "pbs_featured",
          itemLimit: 8,
          moreLabel: "Browse all",
          moreHref: "https://watch.njpbs.org/",
        }),
      ).toBe(
        '<section class="content-shelf" data-content-source="pbs_featured" data-item-limit="8">' +
          '<header class="content-shelf__head"><h2>Featured on NJ PBS</h2>' +
          '<a href="https://watch.njpbs.org/">Browse all</a></header>' +
          '<div class="content-shelf__items" data-derived-items></div></section>',
      );
    });

    it("escapes shelf copy and strips an unsafe destination", () => {
      expect(
        block("content_shelf", {
          title: "<Featured>",
          source: "spotlight_news",
          itemLimit: 4,
          moreLabel: "More & news",
          moreHref: "javascript:alert(1)",
        }),
      ).toContain(
        '<h2>&lt;Featured&gt;</h2><a>More &amp; news</a>',
      );
    });

    it("carries an authored grid presentation on the source-owned preview mount", () => {
      const markup = block("content_shelf", {
        title: "Featured", source: "pbs_featured", itemLimit: 6,
        moreLabel: "Browse all", moreHref: "https://watch.njpbs.org/",
        presentation: "grid", columns: 3,
      });
      expect(markup).toContain('data-presentation="grid" data-columns="3"');
      expect(markup).toContain('data-item-limit="6"');
      expect(markup).toContain('<div class="content-shelf__items" data-derived-items></div>');
    });
  });

  describe("image", () => {
    it("renders a figure carrying the asset reference and escaped alt", () => {
      expect(block("image", { assetId: "a1", alt: "A mural" })).toBe(
        '<figure><img data-asset-id="a1" alt="A mural"></figure>',
      );
    });

    it("adds an escaped figcaption when a caption is set", () => {
      expect(block("image", { assetId: "a1", alt: "A mural", caption: "By the river" })).toBe(
        '<figure><img data-asset-id="a1" alt="A mural"><figcaption>By the river</figcaption></figure>',
      );
    });

    it("omits the figcaption when the caption is empty", () => {
      expect(block("image", { assetId: "a1", alt: "A mural", caption: "" })).toBe(
        '<figure><img data-asset-id="a1" alt="A mural"></figure>',
      );
    });

    it("escapes the asset id, alt, and caption so a stored value cannot break out", () => {
      expect(block("image", { assetId: 'a"1', alt: "<b>art</b>", caption: 'x & "y"' })).toBe(
        '<figure><img data-asset-id="a&quot;1" alt="&lt;b&gt;art&lt;/b&gt;">' +
          "<figcaption>x &amp; &quot;y&quot;</figcaption></figure>",
      );
    });

    it("bakes a resolved media asset into static image markup", () => {
      const parsed = parseBlocks([
        {
          id: "b1",
          type: "image",
          order: 0,
          visible: true,
          data: { assetId: "a1", alt: "A mural", caption: "By the river" },
        },
      ]);
      if (!parsed.ok) throw new Error(parsed.error);

      expect(
        renderBlock(parsed.blocks[0], {
          resolveAsset: (assetId) =>
            assetId === "a1"
              ? {
                  url: "https://media.njpbs.org/cms-media/mural.webp",
                  width: 1600,
                  height: 900,
                }
              : null,
        }),
      ).toBe(
        '<figure><img data-asset-id="a1" src="https://media.njpbs.org/cms-media/mural.webp" width="1600" height="900" loading="lazy" decoding="async" alt="A mural"><figcaption>By the river</figcaption></figure>',
      );
    });

    it("bakes one escaped responsive picture contract without changing contextual text", () => {
      expect(
        renderResolvedImage('a"1', '<Mural & river>', {
          url: '/_astro/fallback-640.jpg?x="&',
          mimeType: "image/jpeg",
          width: 1600,
          height: 900,
          srcset: '/_astro/fallback-320.jpg 320w, /_astro/fallback-640.jpg 640w',
          sizes: '(max-width: 40rem) 100vw, 40rem',
          sources: [
            {
              type: "image/avif",
              srcset: '/_astro/mural-320.avif 320w, /_astro/mural-640.avif 640w',
            },
            {
              type: "image/webp",
              srcset: '/_astro/mural-320.webp 320w, /_astro/mural-640.webp 640w',
            },
          ],
        }),
      ).toBe(
        '<picture><source type="image/avif" srcset="/_astro/mural-320.avif 320w, /_astro/mural-640.avif 640w" sizes="(max-width: 40rem) 100vw, 40rem"><source type="image/webp" srcset="/_astro/mural-320.webp 320w, /_astro/mural-640.webp 640w" sizes="(max-width: 40rem) 100vw, 40rem"><img data-asset-id="a&quot;1" src="/_astro/fallback-640.jpg?x=&quot;&amp;" srcset="/_astro/fallback-320.jpg 320w, /_astro/fallback-640.jpg 640w" sizes="(max-width: 40rem) 100vw, 40rem" width="1600" height="900" loading="lazy" decoding="async" alt="&lt;Mural &amp; river&gt;"></picture>',
      );
    });

    it("tells the resolver whether an image is full content or a grid item", () => {
      const placements: Array<[string, string | undefined]> = [];
      const resolveAsset: RenderBlockOptions["resolveAsset"] = (
        assetId,
        placement,
      ) => {
        placements.push([assetId, placement]);
        return {
          url: `https://media.njpbs.org/cms-media/${assetId}.webp`,
          width: 640,
          height: 360,
        };
      };

      block("image", { assetId: "hero", alt: "Hero" }, { resolveAsset });
      block("image_gallery", {
        images: [{ assetId: "gallery", alt: "Gallery" }],
      }, { resolveAsset });
      block("card_grid", {
        cards: [{ title: "Card", imageAssetId: "card" }],
      }, { resolveAsset });

      expect(placements).toEqual([
        ["hero", "content"],
        ["gallery", "grid"],
        ["card", "grid"],
      ]);
    });
  });

  describe("cta_row", () => {
    it("renders a cta as a site-styled button, defaulting to the primary variant", () => {
      expect(block("cta_row", { ctas: [{ label: "Give", href: "/donate" }] })).toBe(
        '<div class="cta-row"><a class="btn btn--primary" href="/donate">Give</a></div>',
      );
    });

    it("maps the secondary variant to the ghost button class", () => {
      expect(
        block("cta_row", {
          ctas: [{ label: "Learn more", href: "/passport", variant: "secondary" }],
        }),
      ).toBe(
        '<div class="cta-row"><a class="btn btn--ghost" href="/passport">Learn more</a></div>',
      );
    });

    it("renders multiple buttons in their stored order", () => {
      expect(
        block("cta_row", {
          ctas: [
            { label: "Give", href: "/donate", variant: "primary" },
            { label: "Watch", href: "https://watch.njpbs.org/", variant: "secondary" },
          ],
        }),
      ).toBe(
        '<div class="cta-row"><a class="btn btn--primary" href="/donate">Give</a>' +
          '<a class="btn btn--ghost" href="https://watch.njpbs.org/">Watch</a></div>',
      );
    });

    it("drops an unsafe link scheme, leaving the button inert instead of navigating", () => {
      expect(block("cta_row", { ctas: [{ label: "Bad", href: "javascript:alert(1)" }] })).toBe(
        '<div class="cta-row"><a class="btn btn--primary">Bad</a></div>',
      );
    });

    it("escapes the button label", () => {
      expect(block("cta_row", { ctas: [{ label: "<b>x</b>", href: "/x" }] })).toBe(
        '<div class="cta-row"><a class="btn btn--primary" href="/x">&lt;b&gt;x&lt;/b&gt;</a></div>',
      );
    });

    it("renders an empty row when there are no buttons yet", () => {
      expect(block("cta_row", { ctas: [] })).toBe('<div class="cta-row"></div>');
    });

    it("opens only external buttons in a new tab when the page frame asks for it", () => {
      const ctas = [{ label: "Donate", href: "https://donate.example.org/give" }, { label: "Passport", href: "/passport" }];
      expect(block("cta_row", { ctas }, { externalLinksNewTab: true })).toBe(
        '<div class="cta-row"><a class="btn btn--primary" href="https://donate.example.org/give" target="_blank" rel="noopener">Donate<span class="sr-only"> (opens in new tab)</span></a>' +
          '<a class="btn btn--primary" href="/passport">Passport</a></div>',
      );
      // Other CMS pages keep same-tab links.
      expect(block("cta_row", { ctas })).not.toContain("_blank");
    });
  });

  describe("image_gallery", () => {
    it("renders each image as the same figure the image block uses, in stored order", () => {
      expect(
        block("image_gallery", {
          images: [
            { assetId: "a1", alt: "First" },
            { assetId: "a2", alt: "Second", caption: "By the river" },
          ],
        }),
      ).toBe(
        '<div class="image-gallery">' +
          '<figure><img data-asset-id="a1" alt="First"></figure>' +
          '<figure><img data-asset-id="a2" alt="Second"><figcaption>By the river</figcaption></figure>' +
          "</div>",
      );
    });

    it("renders an empty gallery when there are no images yet", () => {
      expect(block("image_gallery", { images: [] })).toBe('<div class="image-gallery"></div>');
    });

    // The mode a gallery stores is the mode the page publishes (#1034).
    it("renders a stored grid exactly as a gallery with no stored mode does", () => {
      const images = [{ assetId: "a1", alt: "First" }];
      expect(block("image_gallery", { images, presentation: "grid" })).toBe(
        block("image_gallery", { images }),
      );
    });

    it("renders the carousel mode as one keyboard-reachable scrolling row", () => {
      expect(
        block("image_gallery", {
          images: [{ assetId: "a1", alt: "First" }],
          presentation: "carousel",
        }),
      ).toBe(
        '<div class="image-gallery-shell image-gallery-shell--carousel">' +
          '<p class="image-gallery__hint">Scroll horizontally to see all images</p>' +
          '<div class="image-gallery image-gallery--carousel" role="group"' +
          ' aria-label="Image gallery, scroll horizontally to view all images" tabindex="0">' +
          '<figure><img data-asset-id="a1" alt="First"></figure>' +
          "</div></div>",
      );
    });

    // What the editor promises about clicking is read off the same mode registry the renderer
    // uses, so the promise has to match the markup: no anchor, no lightbox hook, in any mode.
    it("gives a gallery image no click action in any mode, which is what the editor says", () => {
      for (const presentation of GALLERY_PRESENTATIONS) {
        const html = block("image_gallery", {
          images: [{ assetId: "a1", alt: "First", caption: "By the river" }],
          presentation,
        })!;
        expect(html, presentation).not.toContain("<a ");
        expect(html, presentation).not.toMatch(/data-(?:lightbox|gallery-open)/);
        expect(html, presentation).not.toMatch(/on[a-z]+=/);
      }
    });

    it("escapes image fields the same way the single image block does", () => {
      expect(
        block("image_gallery", { images: [{ assetId: 'a"1', alt: "<b>art</b>" }] }),
      ).toBe(
        '<div class="image-gallery">' +
          '<figure><img data-asset-id="a&quot;1" alt="&lt;b&gt;art&lt;/b&gt;"></figure>' +
          "</div>",
      );
    });
  });

  describe("card_grid", () => {
    it("opens only an external card title in a new tab when the page frame asks for it", () => {
      const cards = [{ title: "Shop", href: "https://shop.example.org" }, { title: "Programs", href: "/programs" }];
      const html = block("card_grid", { cards }, { externalLinksNewTab: true });
      expect(html).toContain(
        '<a href="https://shop.example.org" target="_blank" rel="noopener">Shop<span class="sr-only"> (opens in new tab)</span></a>',
      );
      expect(html).toContain('<a href="/programs">Programs</a>');
      expect(block("card_grid", { cards })).not.toContain("_blank");
    });

    it("renders an escaped optional card label before the title", () => {
      expect(
        block("card_grid", {
          cards: [{ label: "Watch & listen", title: "Programs" }],
        }),
      ).toContain(
        '<span class="card-grid__label">Watch &amp; listen</span><h2 class="card-grid__title">Programs</h2>',
      );
    });

    it("nests authored rich-text headings below the generated card title", () => {
      expect(
        (() => {
          const parsed = parseBlocks([
            {
              id: "cards",
              type: "card_grid",
              order: 0,
              visible: true,
              data: {
                cards: [
                  {
                    title: "Story",
                    body: doc([
                      {
                        type: "heading",
                        attrs: { level: 2 },
                        content: [{ type: "text", text: "Details" }],
                      },
                      {
                        type: "heading",
                        attrs: { level: 3 },
                        content: [{ type: "text", text: "More details" }],
                      },
                    ]),
                  },
                ],
              },
            },
          ]);
          if (!parsed.ok) throw new Error(parsed.error);
          return renderBlock(parsed.blocks[0], { generatedHeadingLevel: 3 });
        })(),
      ).toContain(
        '<h3 class="card-grid__title">Story</h3><h4>Details</h4><h5>More details</h5>',
      );
    });

    it("renders a full card with image, linked title, and rich body in order", () => {
      expect(
        block("card_grid", {
          cards: [
            {
              title: "Big story",
              body: doc([para("Body copy.")]),
              imageAssetId: "hero",
              href: "/story",
            },
          ],
        }),
      ).toBe(
        '<div class="card-grid">' +
          '<article class="card-grid__card">' +
          '<figure aria-hidden="true"><img data-asset-id="hero" alt=""></figure>' +
          '<h2 class="card-grid__title"><a href="/story">Big story</a></h2>' +
          "<p>Body copy.</p>" +
          "</article>" +
          "</div>",
      );
    });

    it("renders a title-only card with no image, link, or body", () => {
      expect(block("card_grid", { cards: [{ title: "Just a title" }] })).toBe(
        '<div class="card-grid"><article class="card-grid__card"><h2 class="card-grid__title">Just a title</h2></article></div>',
      );
    });

    // The asset id is an optional free-text field with no trim on any hop, so spaces left
    // in it used to build a figure around an img with no source. Same blank-text rule the
    // caption follows: it must render exactly like the title-only card above.
    it("treats an asset id of only whitespace as no image", () => {
      expect(block("card_grid", { cards: [{ title: "Just a title", imageAssetId: "   " }] })).toBe(
        '<div class="card-grid"><article class="card-grid__card"><h2 class="card-grid__title">Just a title</h2></article></div>',
      );
    });

    it("omits an editor-seeded empty body so a title-only card is not padded with an empty paragraph", () => {
      // The editor seeds every optional body with emptyRichTextDoc() -- a doc holding a
      // single empty paragraph -- so this, not an absent body, is the shape a title-only
      // card actually reaches the renderer with. It must render like the title-only card
      // above rather than baking an empty `<p></p>`.
      expect(
        block("card_grid", {
          cards: [{ title: "Just a title", body: doc([{ type: "paragraph" }]) }],
        }),
      ).toBe(
        '<div class="card-grid"><article class="card-grid__card"><h2 class="card-grid__title">Just a title</h2></article></div>',
      );
    });

    it("keeps a card body that renders a visible non-text node like a horizontal rule", () => {
      // A rule-only body has no text, so the text-only emptiness test would wrongly drop
      // it. `renderRichText` emits `<hr>`, which the editor shows, so the body must survive
      // publication rather than be omitted as if it were the empty-paragraph seed above.
      expect(
        block("card_grid", {
          cards: [{ title: "Story", body: doc([{ type: "horizontalRule" }]) }],
        }),
      ).toBe(
        '<div class="card-grid"><article class="card-grid__card"><h2 class="card-grid__title">Story</h2><hr></article></div>',
      );
    });

    it("drops an unsafe card link, leaving the title as plain text", () => {
      expect(
        block("card_grid", { cards: [{ title: "Story", href: "javascript:alert(1)" }] }),
      ).toBe(
        '<div class="card-grid"><article class="card-grid__card"><h2 class="card-grid__title">Story</h2></article></div>',
      );
    });

    it("renders multiple cards in their stored order", () => {
      expect(
        block("card_grid", {
          cards: [{ title: "One" }, { title: "Two" }],
        }),
      ).toBe(
        '<div class="card-grid">' +
          '<article class="card-grid__card"><h2 class="card-grid__title">One</h2></article>' +
          '<article class="card-grid__card"><h2 class="card-grid__title">Two</h2></article>' +
          "</div>",
      );
    });

    it("escapes the card title", () => {
      expect(block("card_grid", { cards: [{ title: "<b>x</b>" }] })).toBe(
        '<div class="card-grid"><article class="card-grid__card"><h2 class="card-grid__title">&lt;b&gt;x&lt;/b&gt;</h2></article></div>',
      );
    });

    it("renders an empty grid when there are no cards yet", () => {
      expect(block("card_grid", { cards: [] })).toBe('<div class="card-grid"></div>');
    });
  });

  describe("faq_item", () => {
    it("nests authored rich-text headings below the generated question", () => {
      expect(
        (() => {
          const parsed = parseBlocks([
            {
              id: "faq",
              type: "faq_item",
              order: 0,
              visible: true,
              data: {
                question: "What is NJ PBS?",
                answer: doc([
                  {
                    type: "heading",
                    attrs: { level: 2 },
                    content: [{ type: "text", text: "More information" }],
                  },
                ]),
              },
            },
          ]);
          if (!parsed.ok) throw new Error(parsed.error);
          return renderBlock(parsed.blocks[0], { generatedHeadingLevel: 2 });
        })(),
      ).toContain(
        '<h2 class="faq-item__question">What is NJ PBS?</h2><h3>More information</h3>',
      );
    });

    it("renders the question as a heading above the rich-text answer", () => {
      expect(
        block("faq_item", {
          question: "What is NJ PBS?",
          answer: doc([para("A public television network.")]),
        }),
      ).toBe(
        '<div class="faq-item"><h2 class="faq-item__question">What is NJ PBS?</h2><p>A public television network.</p></div>',
      );
    });

    it("escapes the question", () => {
      expect(
        block("faq_item", { question: "<b>Q</b>?", answer: doc([para("A.")]) }),
      ).toBe(
        '<div class="faq-item"><h2 class="faq-item__question">&lt;b&gt;Q&lt;/b&gt;?</h2><p>A.</p></div>',
      );
    });
  });

  describe("link_card", () => {
    it("renders one reusable linked card with optional metadata", () => {
      const html = block("link_card", {
        title: "Station story",
        url: "https://example.com/story",
        source: "Example news",
        date: "2026-09-17",
        summary: "A short summary.",
      });

      expect(html).toContain('<article class="link-card" data-link-card>');
      expect(html).toContain('<a class="link-card__link" href="https://example.com/story">');
      expect(html).toContain('<span class="link-card__source">Example news</span>');
      expect(html).toContain('<h2 class="link-card__title">Station story</h2>');
      expect(html).toContain('<p class="link-card__summary">A short summary.</p>');
      expect(html).toContain('<time class="link-card__date" datetime="2026-09-17">Sept. 17, 2026</time>');
    });

    it("escapes content and drops an unsafe destination", () => {
      const html = renderLinkCard({
        title: "<b>Story</b>",
        url: "javascript:alert(1)",
      }, 2);
      expect(html).toContain('<div class="link-card__link">');
      expect(html).toContain('&lt;b&gt;Story&lt;/b&gt;');
      expect(html).not.toContain("javascript:");
    });
  });

  describe("coverage_list", () => {
    it("renders a linked title, outlet, and AP date under a year heading", () => {
      const html = block("coverage_list", {
        entries: [{
          title: "Maplewood’s Rob Nelson Named Anchor of New NJ PBS Daily Newscast",
          outlet: "The Village Green",
          date: "2026-09-17",
          url: "https://villagegreennj.com/towns/maplewood/maplewoods-rob-nelson-named-anchor-of-new-nj-pbs-daily-newscast/",
        }],
      });

      expect(html).toContain('<section class="coverage-list" data-coverage-list data-coverage-entry-count="1">');
      expect(html).toContain('<div class="coverage-list__group" data-coverage-group data-coverage-year="2026"><h2>2026</h2>');
      expect(html).toContain('<a class="link-card__link" href="https://villagegreennj.com/towns/maplewood/maplewoods-rob-nelson-named-anchor-of-new-nj-pbs-daily-newscast/">');
      expect(html).toContain('<span class="link-card__source">The Village Green</span>');
      expect(html).toContain('<h3 class="link-card__title">Maplewood’s Rob Nelson Named Anchor of New NJ PBS Daily Newscast</h3>');
      expect(html).toContain('<time class="link-card__date" datetime="2026-09-17">Sept. 17, 2026</time>');
    });

    it("escapes title and outlet text", () => {
      const html = block("coverage_list", {
        entries: [{ title: "<b>x</b>", outlet: "A & B", date: "", url: "" }],
      });

      expect(html).toContain('<span class="link-card__source">A &amp; B</span>');
      expect(html).toContain('<h2 class="link-card__title">&lt;b&gt;x&lt;/b&gt;</h2>');
      expect(html).not.toContain("<b>x</b>");
    });
  });

  describe("generated heading context", () => {
    it("uses h2 for a first generated heading and h3 below an authored h2 section", () => {
      const parsed = parseBlocks([
        {
          id: "section",
          type: "headline",
          order: 0,
          visible: true,
          data: { text: "Programs", level: 2 },
        },
        {
          id: "cards",
          type: "card_grid",
          order: 1,
          visible: true,
          data: { cards: [{ title: "Local stories" }] },
        },
      ]);
      if (!parsed.ok) throw new Error(parsed.error);

      expect(generatedHeadingLevelAt(parsed.blocks, 0)).toBe(2);
      expect(generatedHeadingLevelAt(parsed.blocks, 1)).toBe(3);
      expect(
        renderBlock(parsed.blocks[1], {
          generatedHeadingLevel: generatedHeadingLevelAt(parsed.blocks, 1),
        }),
      ).toContain('<h3 class="card-grid__title">Local stories</h3>');
    });

    it("ignores hidden authored headings when deriving the published outline", () => {
      const parsed = parseBlocks([
        {
          id: "hidden-section",
          type: "headline",
          order: 0,
          visible: false,
          data: { text: "Hidden subsection", level: 4 },
        },
        {
          id: "faq",
          type: "faq_item",
          order: 1,
          visible: true,
          data: {
            question: "Where can I watch?",
            answer: doc([para("Online.")]),
          },
        },
      ]);
      if (!parsed.ok) throw new Error(parsed.error);

      expect(generatedHeadingLevelAt(parsed.blocks, 1)).toBe(2);
    });
  });

  describe("embed", () => {
    it.each([
      ["Vimeo", "https://vimeo.com/76979871?autoplay=1", "https://player.vimeo.com/video/76979871?dnt=1"],
      ["Vimeo", "https://player.vimeo.com/video/76979871?autoplay=1", "https://player.vimeo.com/video/76979871?dnt=1"],
      ["Vimeo", "https://vimeo.com/channels/staffpicks/76979871", "https://player.vimeo.com/video/76979871?dnt=1"],
      // Privacy hash example from Vimeo's Player SDK basics documentation.
      ["Vimeo", "https://player.vimeo.com/video/76979871?h=8272103f6e&autoplay=1", "https://player.vimeo.com/video/76979871?h=8272103f6e&dnt=1"],
      ["Vimeo", "https://vimeo.com/76979871/8272103f6e", "https://player.vimeo.com/video/76979871?h=8272103f6e&dnt=1"],
      ["Vimeo", "https://vimeo.com/76979871?h=8272103f6e", "https://player.vimeo.com/video/76979871?h=8272103f6e&dnt=1"],
      ["TikTok", "https://www.tiktok.com/@scout2015/video/6718335390845095173", "https://www.tiktok.com/embed/v2/6718335390845095173"],
      ["TikTok", "https://www.tiktok.com/embed/v2/6718335390845095173?autoplay=1", "https://www.tiktok.com/embed/v2/6718335390845095173"],
      // Current player URL and post ID from TikTok's Embed Player documentation.
      ["TikTok", "https://www.tiktok.com/player/v1/6718335390845095173?music_info=1&description=1", "https://www.tiktok.com/embed/v2/6718335390845095173"],
      ["TikTok", "https://www.tiktok.com/player/v1/6718335390845095173/", "https://www.tiktok.com/embed/v2/6718335390845095173"],
      ["Instagram", "https://www.instagram.com/p/CxYz_123Ab-/", "https://www.instagram.com/p/CxYz_123Ab-/embed"],
      ["Instagram", "https://instagram.com/reel/CxYz_123Ab-/?utm_source=share", "https://www.instagram.com/reel/CxYz_123Ab-/embed"],
      ["Instagram", "https://www.instagram.com/reel/CxYz_123Ab-/embed", "https://www.instagram.com/reel/CxYz_123Ab-/embed"],
      ["Facebook", "https://www.facebook.com/facebook/videos/10153231379946729/?tracking=discard", "https://www.facebook.com/plugins/video.php?href=https%3A%2F%2Fwww.facebook.com%2Ffacebook%2Fvideos%2F10153231379946729%2F"],
      ["Facebook", "https://m.facebook.com/watch/?v=10153231379946729", "https://www.facebook.com/plugins/video.php?href=https%3A%2F%2Fwww.facebook.com%2Fwatch%2F%3Fv%3D10153231379946729"],
      ["Facebook", "https://www.facebook.com/plugins/video.php?href=https%3A%2F%2Fwww.facebook.com%2Ffacebook%2Fvideos%2F10153231379946729%2F&autoplay=1", "https://www.facebook.com/plugins/video.php?href=https%3A%2F%2Fwww.facebook.com%2Ffacebook%2Fvideos%2F10153231379946729%2F"],
      // Facebook Reels use the same validated video plugin as other Facebook videos.
      ["Facebook", "https://www.facebook.com/reel/2038437459890192/?tracking=discard", "https://www.facebook.com/plugins/video.php?href=https%3A%2F%2Fwww.facebook.com%2Freel%2F2038437459890192%2F"],
      ["Facebook", "https://m.facebook.com/reel/2038437459890192", "https://www.facebook.com/plugins/video.php?href=https%3A%2F%2Fwww.facebook.com%2Freel%2F2038437459890192%2F"],
      ["Facebook", "https://www.facebook.com/plugins/video.php?href=https%3A%2F%2Fwww.facebook.com%2Freel%2F2038437459890192%2F&autoplay=1", "https://www.facebook.com/plugins/video.php?href=https%3A%2F%2Fwww.facebook.com%2Freel%2F2038437459890192%2F"],
      ["PBS", "https://player.pbs.org/partnerplayer/ix6DN99Ppzn3ntnxghoZbw==/?start=0&end=0", "https://player.pbs.org/partnerplayer/ix6DN99Ppzn3ntnxghoZbw==/?start=0&end=0"],
      ["PBS", "https://player.pbs.org/portalplayer/3000000000/?tracking=discard", "https://player.pbs.org/partnerplayer/3000000000/"],
    ])("rebuilds a lazy %s player from %s", (provider, url, src) => {
      for (const input of [url, `<iframe src="${url}" onload="alert(1)"></iframe>`]) {
        const html = block("embed", { url: input, host: "ignored.example" });
        expect(html).toContain(`src="${src.replaceAll("&", "&amp;")}"`);
        expect(html).toContain(`title="${provider} video player"`);
        expect(html).toContain('loading="lazy"');
        expect(html).not.toContain("onload");
        expect(html).not.toContain("tracking=");
      }
    });

    it.each([
      "https://www.youtube.com.evil.test/watch?v=od8NMua_mEw", "https://www.youtube-nocookie.com.evil.test/embed/od8NMua_mEw",
      "https://vimeo.com.evil.test/76979871", "https://player.vimeo.com.evil.test/video/76979871",
      "https://www.tiktok.com.evil.test/@scout2015/video/6718335390845095173",
      "https://www.tiktok.com.evil.test/player/v1/6718335390845095173",
      "https://www.tiktok.com/player/v1/not-an-id", "https://www.tiktok.com/player/v1/123",
      "https://www.tiktok.com/player/v1/6718335390845095173/extra", "https://www.tiktok.com/player/v2/6718335390845095173",
      "https://www.instagram.com.evil.test/reel/CxYz_123Ab-/",
      "https://www.facebook.com.evil.test/facebook/videos/10153231379946729/",
      "https://www.facebook.com.evil.test/reel/2038437459890192/",
      "https://www.facebook.com/reel/not-an-id/", "https://www.facebook.com/reel/2038437459890192/extra",
      "https://www.facebook.com/reel/12345678901234567890123456/",
      "https://www.facebook.com/plugins/video.php?href=https%3A%2F%2Fwww.facebook.com.evil.test%2Freel%2F2038437459890192%2F",
      "https://player.pbs.org.evil.test/partnerplayer/3000000000/",
      "https://x.com.evil.test/NJPBS/status/1234567890123456789",
      "http://vimeo.com/76979871", "https://vimeo.com:444/76979871",
      "https://vimeo.com/not-a-video", "https://www.tiktok.com/@scout2015/video/not-an-id",
      "https://player.vimeo.com/video/76979871?h=bad%22hash",
      "https://vimeo.com/76979871/bad%22hash", "https://player.vimeo.com/video/76979871?h=",
      "https://www.instagram.com/reel/bad%22id/", "https://www.facebook.com/watch/?v=not-a-video",
      "https://www.facebook.com/plugins/video.php?href=https%3A%2F%2Fevil.test%2Fvideos%2F10153231379946729",
      "https://www.facebook.com/plugins/video.php?href=https%3A%2F%2Ffacebook.com.evil.test%2Fvideos%2F10153231379946729",
      "https://player.pbs.org/partnerplayer/bad%22id/", "https://x.com/NJPBS/status/not-a-video",
    ])("keeps rejected player URL %s as a link", url => {
      expect(block("embed", { url })).not.toContain("<iframe");
      expect(block("embed", { url })).toContain("<a href=");
    });

    it.each([
      "https://user:password@vimeo.com/76979871",
      "https://user%40name:private%20password@vimeo.com/76979871",
      "https://user:password@example.test/video",
      "https:\\user:password@vimeo.com/76979871",
    ])("does not reflect sign-in details from a rejected embed address: %s", url => {
      expect(block("embed", { url })).toBe('<div class="embed"></div>');
      expect(block("embed", { url, caption: "Watch the segment" }))
        .toBe('<div class="embed">Watch the segment</div>');
      expect(block("embed", { url, caption: "   " })).toBe('<div class="embed"></div>');
    });

    it("keeps only validated PBS player parameters", () => {
      const html = block("embed", { url: "https://player.pbs.org/partnerplayer/ix6DN99Ppzn3ntnxghoZbw==/?start=30&topbar=false&redirect=https://evil.test&autoplay=bad" });
      expect(html).toContain('src="https://player.pbs.org/partnerplayer/ix6DN99Ppzn3ntnxghoZbw==/?start=30&amp;topbar=false"');
      expect(html).not.toContain("evil.test");
      expect(html).not.toContain("autoplay=bad");
    });

    it("uses vertical defaults for TikTok and Instagram Reels and keeps manual sizing", () => {
      for (const url of ["https://www.tiktok.com/@scout2015/video/6718335390845095173", "https://www.instagram.com/reel/CxYz_123Ab-/"]) {
        expect(block("embed", { url })).toContain('--embed-aspect-ratio:9 / 16');
        expect(block("embed", { url, width: 360 })).toContain('width="360" height="640"');
        expect(block("embed", { url, width: 640, height: 480 })).toContain('--embed-aspect-ratio:640 / 480');
      }
      expect(block("embed", { url: "https://www.instagram.com/p/CxYz_123Ab-/" })).not.toContain('--embed-aspect-ratio:9 / 16');
    });

    it("uses provider permissions and native lazy loading, including existing YouTube players", () => {
      expect(block("embed", { url: "https://youtu.be/od8NMua_mEw" })).toContain('loading="lazy"');
      expect(block("embed", { url: "https://vimeo.com/76979871" })).toContain('allow="autoplay; fullscreen; picture-in-picture; encrypted-media"');
      expect(block("embed", { url: "https://www.tiktok.com/@scout2015/video/6718335390845095173" })).not.toContain("encrypted-media");
      expect(block("embed", { url: "https://player.pbs.org/partnerplayer/3000000000/" })).toContain('allow="encrypted-media"');
    });

    it("uses vertical Facebook Reel defaults and retains manual and pasted sizing", () => {
      const url = "https://www.facebook.com/reel/2038437459890192/";
      const plugin = "https://www.facebook.com/plugins/video.php?href=https%3A%2F%2Fwww.facebook.com%2Freel%2F2038437459890192%2F";
      for (const input of [url, plugin]) {
        expect(block("embed", { url: input })).toContain('--embed-aspect-ratio:9 / 16');
        expect(block("embed", { url: input, width: 360 })).toContain('width="360" height="640"');
        expect(block("embed", { url: input, width: 640, height: 480 })).toContain('--embed-aspect-ratio:640 / 480');
        expect(block("embed", { url: `<iframe src="${input}" width="640" height="480"></iframe>` })).toContain('--embed-aspect-ratio:640 / 480');
      }
      expect(block("embed", { url: "https://www.facebook.com/watch/?v=10153231379946729" })).not.toContain('--embed-aspect-ratio:9 / 16');
    });

    it("renders X and Twitter video links as safe link cards without widget scripts", () => {
      for (const host of ["x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"]) {
        const html = block("embed", { url: `https://${host}/NJPBS/status/1234567890123456789/video/1?tracking=discard`, caption: "Watch the interview" });
        expect(html).toContain('class="link-card"');
        expect(html).toContain('href="https://x.com/NJPBS/status/1234567890123456789"');
        expect(html).toContain("Watch the interview");
        expect(html).not.toContain("<script");
        expect(html).not.toContain("<iframe");
      }
    });

    it("renders a labeled link-out card, using the caption as the label", () => {
      expect(
        block("embed", { url: "https://watch.njpbs.org/video/x", caption: "Watch the segment" }),
      ).toBe(
        '<div class="embed"><a href="https://watch.njpbs.org/video/x">Watch the segment</a></div>',
      );
    });

    it("falls back to the url as the label when there is no caption", () => {
      expect(block("embed", { url: "https://watch.njpbs.org/video/x" })).toBe(
        '<div class="embed"><a href="https://watch.njpbs.org/video/x">https://watch.njpbs.org/video/x</a></div>',
      );
    });

    it("falls back to the url when the caption is only whitespace, so the link keeps an accessible name", () => {
      expect(
        block("embed", { url: "https://watch.njpbs.org/video/x", caption: "   " }),
      ).toBe(
        '<div class="embed"><a href="https://watch.njpbs.org/video/x">https://watch.njpbs.org/video/x</a></div>',
      );
    });

    it("drops the link for an unsafe url, keeping the label as plain text", () => {
      expect(
        block("embed", { url: "javascript:alert(1)", caption: "Watch the segment" }),
      ).toBe('<div class="embed">Watch the segment</div>');
    });

    it("escapes the caption label", () => {
      expect(
        block("embed", { url: "https://watch.njpbs.org/video/x", caption: "<b>x</b>" }),
      ).toBe(
        '<div class="embed"><a href="https://watch.njpbs.org/video/x">&lt;b&gt;x&lt;/b&gt;</a></div>',
      );
    });

    it("renders a YouTube link as a privacy-mode player with the caption as its title", () => {
      const html = block("embed", { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=5", caption: "Tonight's show" });
      expect(html).toContain('<h2 class="embed__heading">Tonight&#39;s show</h2>');
      expect(html).toContain('<iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=5" title="Tonight&#39;s show - YouTube video player"');
      expect(html).toContain("allowfullscreen");
      for (const url of ["https://youtu.be/dQw4w9WgXcQ", "https://www.youtube.com/live/dQw4w9WgXcQ?si=x"]) {
        expect(youtubePlayerSrc(url)).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
      }
    });

    it("reads the src from pasted YouTube iframe code, with or without a scheme", () => {
      for (const src of ["youtube.com/embed/od8NMua_mEw?si=abc", "https://www.youtube.com/embed/od8NMua_mEw?si=abc", "//www.youtube.com/embed/od8NMua_mEw"]) {
        const pasted = `<iframe width="560" height="315" src="${src}" title="YouTube video player" frameborder="0" allowfullscreen></iframe>`;
        expect(youtubePlayerSrc(pasted)).toBe("https://www.youtube-nocookie.com/embed/od8NMua_mEw");
      }
      expect(block("embed", { url: '<iframe src="youtube.com/embed/od8NMua_mEw"></iframe>' })).toContain('title="YouTube video player"');
    });

    it("keeps a pasted player ratio and derives a missing manual dimension", () => {
      const pasted = '<iframe width="640" height="360" src="https://www.youtube.com/embed/od8NMua_mEw"></iframe>';
      const inferred = block("embed", { url: pasted });
      expect(inferred).toContain('style="--embed-aspect-ratio:640 / 360"');
      expect(inferred).toContain('width="640" height="360"');

      const widthOnly = block("embed", { url: "https://youtu.be/od8NMua_mEw", width: 800 });
      expect(widthOnly).toContain('style="--embed-aspect-ratio:16 / 9;--embed-max-width:800px"');
      expect(widthOnly).toContain('width="800" height="450"');

      const heightOnly = block("embed", { url: "https://youtu.be/od8NMua_mEw", height: 360 });
      expect(heightOnly).toContain('style="--embed-aspect-ratio:16 / 9;--embed-max-width:640px"');
      expect(heightOnly).toContain('width="640" height="360"');

      const pastedWidthOnly = block("embed", { url: pasted, width: 320 });
      expect(pastedWidthOnly).toContain('style="--embed-aspect-ratio:640 / 360;--embed-max-width:320px"');
      expect(pastedWidthOnly).toContain('width="320" height="180"');
    });

    it("preserves a supplied player dimension while deriving its companion", () => {
      const wideSource = '<iframe width="2100" height="900" src="https://www.youtube.com/embed/od8NMua_mEw"></iframe>';
      const narrowSource = '<iframe width="900" height="1600" src="https://www.youtube.com/embed/od8NMua_mEw"></iframe>';

      const widthOnly = block("embed", { url: wideSource, width: 160 });
      expect(widthOnly).toContain('style="--embed-aspect-ratio:2100 / 900;--embed-max-width:160px"');
      expect(widthOnly).toContain('width="160" height="69"');

      const heightOnly = block("embed", { url: narrowSource, height: 90 });
      expect(heightOnly).toContain('style="--embed-aspect-ratio:900 / 1600;--embed-max-width:51px"');
      expect(heightOnly).toContain('width="51" height="90"');

      const largeHeight = block("embed", { url: "https://youtu.be/od8NMua_mEw", height: 4096 });
      expect(largeHeight).toContain('style="--embed-aspect-ratio:16 / 9;--embed-max-width:7282px"');
      expect(largeHeight).toContain('width="7282" height="4096"');
    });

    it("uses both manual dimensions as a responsive player ratio", () => {
      const html = block("embed", {
        url: "https://youtu.be/od8NMua_mEw",
        width: 640,
        height: 480,
      });
      expect(html).toContain('style="--embed-aspect-ratio:640 / 480;--embed-max-width:640px"');
      expect(html).toContain('width="640" height="480"');
    });

    it("uses the CSS default for an incomplete pasted size and ignores dimensions on links", () => {
      const incomplete = block("embed", {
        url: '<iframe width="640" src="https://www.youtube.com/embed/od8NMua_mEw"></iframe>',
      });
      expect(incomplete).not.toContain("--embed-aspect-ratio");
      expect(incomplete).not.toContain(' width="640"');

      const unsafeRatio = block("embed", {
        url: '<iframe width="160" height="4096" src="https://www.youtube.com/embed/od8NMua_mEw"></iframe>',
      });
      expect(unsafeRatio).not.toContain("--embed-aspect-ratio");
      expect(unsafeRatio).not.toContain(' height="4096"');

      const prefixedAttributes = block("embed", {
        url: '<iframe data-width="900" aria-height="1600" width="640" height="360" src="https://www.youtube.com/embed/od8NMua_mEw"></iframe>',
      });
      expect(prefixedAttributes).toContain('style="--embed-aspect-ratio:640 / 360"');
      expect(prefixedAttributes).toContain('width="640" height="360"');

      expect(block("embed", {
        url: "https://example.com/interview",
        caption: "Interview",
        width: 640,
        height: 360,
      })).toBe('<div class="embed"><a href="https://example.com/interview">Interview</a></div>');
    });

    it("adds the live light to a LIVE caption heading", () => {
      expect(block("embed", { url: "https://youtu.be/dQw4w9WgXcQ", caption: " live " })).toContain(
        '<h2 class="embed__heading"><span class="embed__live-light" aria-hidden="true"></span>live</h2>',
      );
      expect(block("embed", { url: "https://youtu.be/dQw4w9WgXcQ", caption: "Live tonight" })).not.toContain("embed__live-light");
    });

    it("keeps a validated start time from a link or pasted embed code", () => {
      const player = "https://www.youtube-nocookie.com/embed/od8NMua_mEw";
      for (const [url, start] of [
        ["https://youtu.be/od8NMua_mEw?t=268", 268],
        ["https://www.youtube.com/watch?v=od8NMua_mEw&t=268s", 268],
        ["https://www.youtube.com/live/od8NMua_mEw?t=4m28s", 268],
        ["https://www.youtube.com/watch?v=od8NMua_mEw&t=1h0m5s", 3605],
        ['<iframe src="https://www.youtube.com/embed/od8NMua_mEw?si=x&amp;start=268"></iframe>', 268],
      ] as const) {
        expect(youtubePlayerSrc(url)).toBe(`${player}?start=${start}`);
      }
      for (const t of ["0", "abc", "-5", "99999999", "4m28x"]) {
        expect(youtubePlayerSrc(`https://youtu.be/od8NMua_mEw?t=${t}`)).toBe(player);
      }
    });

    it("renders custom HTML only inside an opaque-origin sandboxed frame", () => {
      const html = block("html", { html: '<p onclick="x()">Hi "there"</p><script>alert(1)</script>', title: "Results" });
      expect(html).toMatch(/^<div class="html-frame"><iframe class="html-frame__frame" data-html-frame title="Results" sandbox="allow-scripts allow-forms allow-popups" srcdoc="/);
      expect(html).not.toContain("allow-same-origin");
      expect(html).not.toContain("<script>alert");
      expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
      expect(html).toContain("Hi &quot;there&quot;");
      expect(block("html", { html: "<p>x</p>" })).toContain('title="Embedded content"');
    });

    it("keeps custom HTML popups subject to the frame's sandbox", () => {
      const payload = '<a href="https://example.test/results" target="_blank">Results</a><script>window.open("https://example.test/results")</script>';
      const output = new DOMParser().parseFromString(block("html", { html: payload })!, "text/html");
      const frame = output.querySelector("iframe")!;
      expect(frame).not.toBeNull();
      expect(frame.getAttribute("srcdoc")).toContain(payload);

      // The HTML sandbox contract propagates restrictions to popups unless
      // allow-popups-to-escape-sandbox is granted (issue #2716).
      const permissions = frame.getAttribute("sandbox")!.split(/\s+/);
      expect(permissions).toContain("allow-popups");
      expect(permissions).not.toContain("allow-popups-to-escape-sandbox");
      expect(permissions).not.toContain("allow-same-origin");
      expect(permissions).not.toContain("allow-top-navigation");
      expect(permissions).not.toContain("allow-top-navigation-by-user-activation");
    });

    it("renders a channel live link as the channel's current live stream", () => {
      const channel = "UCabcdefghijklmnopqrstuv";
      expect(youtubePlayerSrc(`https://www.youtube.com/channel/${channel}/live`)).toBe(
        `https://www.youtube.com/embed/live_stream?channel=${channel}`,
      );
      expect(youtubePlayerSrc(`https://www.youtube.com/embed/live_stream?channel=${channel}`)).toBe(
        `https://www.youtube.com/embed/live_stream?channel=${channel}`,
      );
    });

    it("keeps the link for non-YouTube, malformed, or look-alike hosts", () => {
      for (const url of ["https://watch.njpbs.org/video/x", "https://www.youtube.com/watch?v=bad\"id", "https://evil.com/watch?v=dQw4w9WgXcQ", "http://youtu.be/dQw4w9WgXcQ", "https://www.youtube.com/@NJPBS/live"]) {
        expect(youtubePlayerSrc(url)).toBeNull();
      }
    });
  });
});

describe("a linked image", () => {
  const image = (data: Record<string, unknown>) =>
    block("image", { assetId: "asset-1", alt: "Watch the newscast", ...data });

  it("wraps the figure in the link and opens a new tab only on request", () => {
    expect(image({ href: "https://youtu.be/abc", caption: "Full episode" })).toBe(
      '<a class="image-link" href="https://youtu.be/abc"><figure><img data-asset-id="asset-1" alt="Watch the newscast"><figcaption>Full episode</figcaption></figure></a>',
    );
    expect(image({ href: "/live/", newTab: true })).toBe(
      '<a class="image-link" href="/live/" target="_blank" rel="noopener"><figure><img data-asset-id="asset-1" alt="Watch the newscast"></figure><span class="sr-only"> (opens in new tab)</span></a>',
    );
  });

  it("drops a blank, unsafe, or decorative link", () => {
    const plain = '<figure><img data-asset-id="asset-1" alt="Watch the newscast"></figure>';
    expect(image({ href: "  ", newTab: true })).toBe(plain);
    expect(image({ href: "javascript:alert(1)" })).toBe(plain);
    // The parser refuses this pair; the renderer still drops a link that reaches it.
    expect(renderBlock({
      id: "b1",
      type: "image",
      order: 0,
      visible: true,
      data: { assetId: "asset-1", alt: "", altDecorative: true, href: "/live/" },
    }, {})).not.toContain("<a ");
  });
});

describe("a decorative image", () => {
  // An empty alt silences the img; hiding the wrapper stops assistive tech announcing an
  // unnamed figure around it.
  it("hides the whole figure when it carries no caption", () => {
    expect(
      renderBlock({
        id: "b1",
        type: "image",
        order: 0,
        visible: true,
        data: { assetId: "asset-1", alt: "", altDecorative: true },
      }, {}),
    ).toBe('<figure aria-hidden="true"><img data-asset-id="asset-1" alt=""></figure>');
  });

  // A caption is text the reader is meant to get, so the figure stays exposed.
  it("stays exposed when it carries a caption", () => {
    const html = renderBlock({
      id: "b1",
      type: "image",
      order: 0,
      visible: true,
      data: { assetId: "asset-1", alt: "", altDecorative: true, caption: "Camden, 1974" },
    }, {});
    expect(html).not.toContain("aria-hidden");
    expect(html).toContain("<figcaption>Camden, 1974</figcaption>");
  });

  // Spaces left in the caption box are the realistic way to reach this: the field is
  // optional and nothing trims it, so the figure would otherwise stay exposed around a
  // figcaption holding nothing a reader can hear.
  it("treats a caption of only whitespace as no caption", () => {
    const html = renderBlock({
      id: "b1",
      type: "image",
      order: 0,
      visible: true,
      data: { assetId: "asset-1", alt: "", altDecorative: true, caption: "   " },
    }, {});
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain("<figcaption>");
  });

  it("leaves a described image exposed", () => {
    expect(
      renderBlock({
        id: "b1",
        type: "image",
        order: 0,
        visible: true,
        data: { assetId: "asset-1", alt: "A reporter at a desk" },
      }, {}),
    ).not.toContain("aria-hidden");
  });

  // Blank means blank, not "needs tidying". Padding around real words is the reader's
  // caption and stays whole; this is the line between absent and present.
  it("keeps a padded caption as written", () => {
    expect(
      renderBlock({
        id: "b1",
        type: "image",
        order: 0,
        visible: true,
        data: { assetId: "asset-1", alt: "", altDecorative: true, caption: "  Camden, 1974  " },
      }, {}),
    ).toContain("<figcaption>  Camden, 1974  </figcaption>");
  });

  // The blank-caption rule is about the caption, not about the flag, so a described
  // image must not emit an empty figcaption either.
  it("emits no figcaption for a blank caption on a described image", () => {
    expect(
      renderBlock({
        id: "b1",
        type: "image",
        order: 0,
        visible: true,
        data: { assetId: "asset-1", alt: "A reporter at a desk", caption: " \t " },
      }, {}),
    ).not.toContain("<figcaption>");
  });
});
