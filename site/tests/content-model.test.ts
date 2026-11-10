import { electionRace } from "../../tests/fixtures/election-results";
import { describe, expect, it } from "vitest";
import * as deployedLinks from "../../functions/lib/safe-href.js";
import {
  BLOCK_TYPES,
  EDITORIAL_TYPES,
  GALLERY_PRESENTATIONS,
  GALLERY_PRESENTATION_SPECS,
  galleryPresentation,
  isAssignableContentStatus,
  isRichTextDoc,
  isSafeHref,
  keyOf,
  parseBlocks,
  parseScheduledPublishFailure,
  renderRichText,
  restoreRevision,
  snapshotRevision,
  type BlockType,
  type EditorialBase,
  type EditorialRecord,
  type PageBlock,
  type PageSingleton,
  type PostRecord,
  type PublishedSnapshot,
  type RichTextDoc,
} from "../../packages/content-core/src/content-model";

const doc = (content: RichTextDoc["content"]): RichTextDoc => ({ type: "doc", content });
const para = (text: string, marks?: { type: string; attrs?: Record<string, unknown> }[]) =>
  ({ type: "paragraph", content: [{ type: "text", text, marks }] });
const block = (id: string, type: string, data: Record<string, unknown> = {}, order = 0) => ({
  id,
  type,
  order,
  visible: true,
  data,
});

describe("parseScheduledPublishFailure", () => {
  const failure = {
    failedAt: "2026-08-13T18:30:00.000Z",
    failedBy: "system:scheduler",
    reason: "The scheduled publication failed.",
  };

  it("accepts the complete server-owned failure receipt", () => {
    expect(parseScheduledPublishFailure(failure)).toEqual(failure);
  });

  it.each([
    null,
    [],
    { ...failure, failedAt: "" },
    { ...failure, failedBy: 42 },
    { ...failure, reason: "" },
    { ...failure, reason: "   " },
  ])("rejects an invalid receipt (%o)", (value) => {
    expect(parseScheduledPublishFailure(value)).toBeUndefined();
  });
});

describe("renderRichText", () => {
  it("styles standalone link paragraphs without treating surrounding prose as actions", () => {
    const linked = { type: "text", text: "Read more", marks: [{ type: "link", attrs: { href: "/about/" } }] };
    const content = doc([
      { type: "paragraph", content: [linked] },
      { type: "paragraph", content: [{ type: "text", text: "Before " }, linked, { type: "text", text: " after." }] },
      para("Unsafe", [{ type: "link", attrs: { href: "javascript:alert(1)" } }]),
      { type: "paragraph", content: [] },
    ]);
    const html = renderRichText(content, { standaloneLinkClass: "section-links" });
    expect(html).toBe('<p class="section-links"><a href="/about/">Read more</a></p><p>Before <a href="/about/">Read more</a> after.</p><p>Unsafe</p><p></p>');
    expect(renderRichText(content)).not.toContain('class="section-links"');
    expect(renderRichText(doc([{ type: "paragraph", content: [linked] }]), { standaloneLinkClass: 'x" onclick="bad' }))
      .toContain('class="x&quot; onclick=&quot;bad"');
  });

  it("opens external links safely only when the page frame asks for that behavior", () => {
    const content = doc([
      para("External", [{ type: "link", attrs: { href: "https://example.org/?a=1&b=2" } }]),
      para("Local", [{ type: "link", attrs: { href: "/about/" } }]),
      para("Unsafe", [{ type: "link", attrs: { href: "javascript:alert(1)" } }]),
    ]);
    const html = renderRichText(content, { externalLinksNewTab: true });
    expect(html).toContain('href="https://example.org/?a=1&amp;b=2" target="_blank" rel="noopener"');
    expect(html).toContain('External<span class="sr-only"> (opens in new tab)</span>');
    expect(html).toContain('<a href="/about/">Local</a>');
    expect(html).toContain('<p>Unsafe</p>');
    expect(renderRichText(content)).not.toContain('target="_blank"');
  });

  it("does not publish credentials from a web link", () => {
    const content = doc([
      para("Source", [{ type: "link", attrs: { href: "https://user:secret@example.test/story" } }]),
    ]);
    expect(renderRichText(content, { externalLinksNewTab: true })).toBe("<p>Source</p>");
  });

  it("renders paragraphs, headings, and lists", () => {
    const html = renderRichText(
      doc([
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Title" }] },
        para("Body."),
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [para("one")] },
            { type: "listItem", content: [para("two")] },
          ],
        },
      ]),
    );
    expect(html).toBe(
      "<h2>Title</h2><p>Body.</p><ul><li><p>one</p></li><li><p>two</p></li></ul>",
    );
  });

  it("escapes text so stored content cannot inject markup", () => {
    const html = renderRichText(doc([para('<script>alert("x")</script> & more')]));
    expect(html).toBe("<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; more</p>");
  });

  it("wraps marks and escapes the link href", () => {
    const html = renderRichText(
      doc([para("hi", [{ type: "bold" }, { type: "link", attrs: { href: "/a?b=1&c=2" } }])]),
    );
    expect(html).toBe('<p><a href="/a?b=1&amp;c=2"><strong>hi</strong></a></p>');
  });

  it("emits the legacy-host opt-in only for an exact true link attribute", () => {
    const marked = renderRichText(
      doc([
        para("WNET", [
          {
            type: "link",
            attrs: { href: "https://www.wnet.org/", allowLegacyHost: true },
          },
        ]),
      ]),
    );
    const unmarked = renderRichText(
      doc([
        para("WNET", [
          {
            type: "link",
            attrs: {
              href: "https://www.wnet.org/",
              allowLegacyHost: "true",
            },
          },
        ]),
      ]),
    );

    expect(marked).toBe(
      '<p><a href="https://www.wnet.org/" data-allow-legacy-host="true">WNET</a></p>',
    );
    expect(unmarked).toBe(
      '<p><a href="https://www.wnet.org/">WNET</a></p>',
    );
  });

  it("drops an unsafe link scheme to plain text", () => {
    const html = renderRichText(
      doc([para("click", [{ type: "link", attrs: { href: "javascript:alert(1)" } }])]),
    );
    expect(html).toBe("<p>click</p>");
  });

  it("keeps a bare relative link (no scheme)", () => {
    const html = renderRichText(
      doc([para("home", [{ type: "link", attrs: { href: "../donate" } }])]),
    );
    expect(html).toBe('<p><a href="../donate">home</a></p>');
  });

  it("drops a protocol-relative link so external URLs must be explicit", () => {
    const html = renderRichText(
      doc([para("x", [{ type: "link", attrs: { href: "//evil.example.com" } }])]),
    );
    expect(html).toBe("<p>x</p>");
  });

  it("drops a control-char-obfuscated javascript link", () => {
    const html = renderRichText(
      doc([para("x", [{ type: "link", attrs: { href: "java\nscript:alert(1)" } }])]),
    );
    expect(html).toBe("<p>x</p>");
  });

  it("clamps an out-of-range heading level to a valid tag", () => {
    const html = renderRichText(
      doc([{ type: "heading", attrs: { level: 9 }, content: [{ type: "text", text: "x" }] }]),
    );
    expect(html).toBe("<h6>x</h6>");
  });

  it("rejects a fractional heading level before clamping", () => {
    const html = renderRichText(
      doc([{ type: "heading", attrs: { level: 2.5 }, content: [{ type: "text", text: "x" }] }]),
    );
    expect(html).toBe("<h2>x</h2>");
  });

  it("renders the children of an unknown node so text survives", () => {
    const html = renderRichText(
      doc([{ type: "callout", content: [para("kept")] }]),
    );
    expect(html).toBe("<p>kept</p>");
  });
});

describe("isRichTextDoc", () => {
  it("accepts a doc node", () => {
    expect(isRichTextDoc(doc([para("x")]))).toBe(true);
  });
  it("rejects an HTML string (the shape the model forbids)", () => {
    expect(isRichTextDoc("<p>x</p>")).toBe(false);
    expect(isRichTextDoc(null)).toBe(false);
    expect(isRichTextDoc({ type: "paragraph" })).toBe(false);
  });
  it("rejects a structurally malformed tree the renderer would crash on", () => {
    expect(isRichTextDoc({ type: "doc", content: [null] })).toBe(false);
    expect(isRichTextDoc({ type: "doc", content: [{ text: "no type" }] })).toBe(false);
    expect(isRichTextDoc({ type: "doc", content: [{ type: "paragraph", content: [42] }] })).toBe(false);
  });
  it("rejects non-object node and mark attrs", () => {
    expect(isRichTextDoc({ type: "doc", attrs: 42, content: [] })).toBe(false);
    expect(isRichTextDoc({ type: "doc", content: [{ type: "paragraph", attrs: 42 }] })).toBe(false);
    expect(isRichTextDoc({
      type: "doc",
      content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: "bad" }] }],
    })).toBe(false);
  });
});

describe("parseBlocks", () => {
  it("accepts an ADR 0013-shaped block set and preserves order", () => {
    const prose: PageBlock = {
      id: "b2",
      type: "prose",
      order: 1,
      visible: true,
      data: { content: doc([para("body")]) },
    };
    const input = [
      block("b1", "headline", { text: "H" }, 0),
      prose,
      block("b3", "image", { assetId: "a1", alt: "logo" }, 2),
    ];
    const result = parseBlocks(input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.blocks.map((b) => b.type)).toEqual(["headline", "prose", "image"]);
  });

  it("rejects a non-array", () => {
    expect(parseBlocks({ id: "b1", type: "headline" })).toEqual({ ok: false, error: "blocks must be an array" });
  });

  it("rejects a block missing its immutable id", () => {
    expect(parseBlocks([{ type: "headline", order: 0, visible: true, data: {} }])).toEqual({
      ok: false,
      error: "blocks[0] is missing a string id",
    });
  });

  it("rejects an unknown block type with a located error", () => {
    expect(
      parseBlocks([
        block("b1", "headline", { text: "H" }, 0),
        { id: "b2", type: "carousel", order: 1, visible: true, data: {} },
      ]),
    ).toEqual({ ok: false, error: "blocks[1] has unknown type carousel" });
  });

  it("rejects a block missing its order, visible flag, or data envelope", () => {
    expect(parseBlocks([{ id: "b1", type: "headline", visible: true, data: {} }]).ok).toBe(false);
    expect(parseBlocks([{ id: "b1", type: "headline", order: 0, data: {} }]).ok).toBe(false);
    expect(parseBlocks([{ id: "b1", type: "headline", order: 0, visible: true }]).ok).toBe(false);
  });

  it("rejects an array as the data object", () => {
    expect(parseBlocks([{ id: "b1", type: "headline", order: 0, visible: true, data: [] }])).toEqual({
      ok: false,
      error: "blocks[0] is missing a data object",
    });
  });

  it("rejects a repeated block id so history and media usage cannot conflate two blocks", () => {
    expect(
      parseBlocks([
        block("dup", "headline", { text: "H" }, 0),
        block("dup", "prose", { content: doc([para("body")]) }, 1),
      ]),
    ).toEqual({ ok: false, error: "blocks[1] repeats id dup" });
  });

  it("rejects a known block whose required data fields are incomplete", () => {
    expect(parseBlocks([block("b1", "prose")])).toEqual({
      ok: false,
      error: "blocks[0] has invalid data for prose",
    });
  });

  it("accepts an optional card label and rejects a non-string label", () => {
    expect(parseBlocks([
      block("cards", "card_grid", { cards: [{ label: "Watch", title: "Programs" }] }),
    ]).ok).toBe(true);
    expect(parseBlocks([
      block("cards", "card_grid", { cards: [{ label: 42, title: "Programs" }] }),
    ])).toEqual({
      ok: false,
      error: "blocks[0] has invalid data for card_grid",
    });
  });

  it("admits already-saved nested media collections above the editor cap", () => {
    const images = Array.from({ length: 13 }, (_, index) => ({
      itemId: `image-${index}`,
      assetId: `asset-${index}`,
      alt: `Image ${index}`,
    }));
    const cards = Array.from({ length: 13 }, (_, index) => ({
      itemId: `card-${index}`,
      title: `Card ${index}`,
      imageAssetId: `asset-${index}`,
    }));

    expect(parseBlocks([
      block("gallery", "image_gallery", { images: images.slice(0, 12) }),
      block("cards", "card_grid", { cards: cards.slice(0, 12) }, 1),
    ]).ok).toBe(true);

    for (const candidate of [
      block("gallery", "image_gallery", { images }),
      block("cards", "card_grid", { cards }),
    ]) {
      expect(parseBlocks([candidate]).ok).toBe(true);
    }
  });

  it("rejects a non-plain data object", () => {
    expect(parseBlocks([{
      id: "b1",
      type: "divider",
      order: 0,
      visible: true,
      data: new Date(0),
    }])).toEqual({
      ok: false,
      error: "blocks[0] is missing a data object",
    });
  });

  it("rejects divider data with a non-enumerable property", () => {
    const data = Object.defineProperty({}, "unexpected", { value: true });
    expect(parseBlocks([block("b1", "divider", data)])).toEqual({
      ok: false,
      error: "blocks[0] has invalid data for divider",
    });
  });

  it("rejects a prose block whose rich-text attrs violate the declared type", () => {
    expect(parseBlocks([block("b1", "prose", {
      content: { type: "doc", content: [{ type: "paragraph", attrs: 42 }] },
    })])).toEqual({
      ok: false,
      error: "blocks[0] has invalid data for prose",
    });
  });

  it("rejects invalid data for every declared block discriminant", () => {
    const invalidData: Record<BlockType, Record<string, unknown>> = {
      county_comparison: { datasetVersion: "unreviewed", heading: "", intro: "", source: "" },
      town_lookup: { heading: "Past results", introduction: "", sourceLine: 42 },
      election_results: { races: [electionRace({ reportingShare: 101 })] },
      data_hub_section: { sectionId: "unreviewed", heading: "", introduction: "" },
      data_figure: { datasetId: "../forged", version: { mode: "latestApproved" }, display: "expanded" },
      home_newscast: { showId: "wrong-program", layout: "arbitrary" },
      document_list: { documents: [{ itemId: "bad", title: "Missing PDF" }] },
      bio_card: { profileId: "example-person", kind: "person", name: "Example Person" },
      data_table: { title: "Population", csv: 42, source: "Census", sourceHref: "" },
      row: {},
      headline: {},
      prose: {},
      image: { assetId: "asset-1" },
      image_gallery: { images: [{ assetId: "asset-1" }] },
      cta_row: { ctas: [{ label: "Watch" }] },
      support_appeal: { heading: "Support NJ PBS", copy: "Help local stories.", buttonLabel: "Donate", href: "/support/", style: "pink" },
      card_grid: { cards: [{}] },
      link_card: { title: "Missing link" },
      faq_item: { question: "Question?" },
      coverage_list: { entries: [{ title: "Headline" }] },
      embed: {},
      html: { html: 42 },
      content_shelf: {
        title: "Featured",
        source: "custom_query",
        itemLimit: 100,
        moreLabel: "Browse all",
        moreHref: "/watch/",
      },
      promotion_playlist: {
        title: "Remembering Dolly Parton",
        placement: "anywhere",
        cards: [],
      },
      newsletter_signup: { newsletterIds: ["duplicate", "duplicate"] },
      topic_shelf: {
        title: "Related",
        topic: "anything-an-editor-types",
        source: "njpbs_related_index",
        itemLimit: 4,
        sort: "newest",
      },
      video_playlist: {
        title: "Watch",
        topic: "immigration",
        library: "youtube",
        itemLimit: 4,
        sort: "newest",
      },
      record_card: { recordKind: "post", recordId: "bad/id" },
      sponsor_strip: { sponsorIds: ["same", "same"], layout: "row" },
      divider: { unexpected: true },
      video: { sourceId: "media-library", assetId: "abc123", title: "Clip" },
    };
    for (const type of BLOCK_TYPES) {
      const candidate = block(`b-${type}`, type, invalidData[type]);
      expect(parseBlocks([{ ...candidate, ...(type === "home_newscast" ? { section: "home-newscast" } : {}) }])).toEqual({
        ok: false,
        error: `blocks[0] has invalid data for ${type}`,
      });
    }
  });

  it("covers every declared block discriminant", () => {
    const validData: Record<BlockType, Record<string, unknown>> = {
      county_comparison: { datasetVersion: "nj-federal-counties-2020-2024-v1", heading: "", intro: "", source: "" },
      town_lookup: { heading: "Past results", introduction: "", sourceLine: "NJ Spotlight News" },
      election_results: { races: [electionRace()] },
      data_hub_section: { sectionId: "unemployment", heading: "", introduction: "" },
      data_figure: { datasetId: "dataset-1", version: { mode: "pinned", releaseId: "release-1" }, display: "expanded" },
      home_newscast: { showId: "ad1f378e-9779-4ef1-a629-40a8a6f8f8d5", heading: "Latest newscast", summary: "", layout: "feature",
        watchLabel: "Watch the latest", pastLabel: "Past newscasts", liveLabel: "Watch live" },
      document_list: { documents: [] },
      bio_card: { profileId: "example-person", kind: "person", name: "Example Person", role: "State senator",
        summary: "Previously served on the local council.", sourceUrl: "https://example.org/biography",
        sourceLabel: "Official biography", asOf: "2026-10-03" },
      record_card: { recordKind: "program", recordId: "program_123", variant: "card" },
      data_table: {
        title: "County population",
        csv: "County,Population\nEssex,854917",
        source: "U.S. Census Bureau",
        sourceHref: "https://www.census.gov/",
      },
      row: { columns: [6, 6] },
      headline: { text: "Heading" },
      prose: { content: doc([para("Body")]) },
      image: { assetId: "asset-1", alt: "Description" },
      image_gallery: { images: [{ assetId: "asset-1", alt: "Description" }] },
      cta_row: { ctas: [{ label: "Watch", href: "/watch/" }] },
      support_appeal: { heading: "Support NJ PBS", copy: "Help local stories.", buttonLabel: "Donate", href: "/support/", style: "blue" },
      card_grid: { cards: [{ title: "Program" }] },
      link_card: {
        title: "NJ PBS coverage",
        url: "https://example.com/story",
        source: "Example news",
        date: "2026-09-17",
        summary: "A short summary.",
      },
      faq_item: { question: "Question?", answer: doc([para("Answer.")]) },
      coverage_list: {
        entries: [{
          title: "Maplewood’s Rob Nelson Named Anchor of New NJ PBS Daily Newscast",
          outlet: "The Village Green",
          date: "2026-09-17",
          url: "https://villagegreennj.com/towns/maplewood/maplewoods-rob-nelson-named-anchor-of-new-nj-pbs-daily-newscast/",
        }],
      },
      embed: { url: "https://player.pbs.org/example" },
      content_shelf: {
        title: "Featured",
        source: "pbs_featured",
        itemLimit: 8,
        moreLabel: "Browse all",
        moreHref: "/watch/",
      },
      promotion_playlist: {
        title: "Remembering Dolly Parton",
        placement: "before_featured",
        cards: [
          {
            itemId: "dolly-1",
            title: "Dolly Parton: I will always love you",
            summary: "Celebrate the life and music of Dolly Parton.",
            imageAssetId: "dolly-image-1",
            alt: "Dolly Parton performs onstage",
            href: "https://www.pbs.org/show/dolly-parton/",
          },
          {
            itemId: "dolly-2",
            title: "Dolly Parton and friends",
            summary: "A concert from the PBS archive.",
            imageAssetId: "dolly-image-2",
            alt: "Dolly Parton smiles during a concert",
            href: "https://www.pbs.org/video/dolly-parton-and-friends/",
          },
          {
            itemId: "dolly-3",
            title: "Dolly Parton: Song by song",
            summary: "Artists reflect on her songwriting legacy.",
            imageAssetId: "dolly-image-3",
            alt: "Dolly Parton holds an acoustic guitar",
            href: "https://www.pbs.org/video/dolly-parton-song-by-song/",
          },
        ],
      },
      newsletter_signup: { newsletterIds: ["newsletter-one"], heading: "Get updates" },
      topic_shelf: {
        title: "More on Delaney Hall",
        topic: "delaney-hall",
        source: "njpbs_related_index",
        itemLimit: 4,
        sort: "newest",
      },
      video_playlist: {
        title: "Watch: immigration",
        topic: "immigration",
        library: "njpbs_watch",
        itemLimit: 4,
        sort: "newest",
      },
      sponsor_strip: { heading: "Our sponsors", sponsorIds: ["sponsor-1"], layout: "grid" },
      divider: {},
      video: { sourceId: "video-library", assetId: "abc123", title: "Clip" },
      html: { html: "<p>Results</p>", title: "Election results" },
    };
    for (const type of BLOCK_TYPES) {
      const candidate = block(`b-${type}`, type, validData[type]);
      expect(parseBlocks([{ ...candidate, ...(type === "home_newscast" ? { section: "home-newscast" } : {}) }]).ok).toBe(true);
    }
  });

  it("requires one to twelve complete, uniquely identified promotion cards", () => {
    const card = (itemId: string) => ({
      itemId,
      title: "Program",
      summary: "Program summary.",
      imageAssetId: `asset-${itemId}`,
      alt: "Dolly Parton performs onstage",
      href: "https://www.pbs.org/video/program/",
    });
    const promotion = (cards: unknown[]) => block("promo", "promotion_playlist", {
      title: "Remembering Dolly Parton",
      placement: "before_featured",
      cards,
    });

    expect(parseBlocks([promotion([])]).ok).toBe(false);
    expect(parseBlocks([promotion([card("1")])]).ok).toBe(true);
    expect(parseBlocks([promotion(Array.from({ length: 13 }, (_, index) => card(String(index))))]).ok).toBe(false);
    expect(parseBlocks([promotion([card("1"), card("1"), card("3")])]).ok).toBe(false);
    expect(parseBlocks([promotion([card("1"), card("2"), { ...card("3"), summary: "" }])]).ok).toBe(false);
    expect(parseBlocks([promotion([card("1"), card("2"), { ...card("3"), alt: "", altDecorative: true }])]).ok).toBe(true);
    // Empty alt text warns in the editor and never blocks publication (#242).
    expect(parseBlocks([promotion([card("1"), { ...card("2"), alt: "" }])]).ok).toBe(true);
  });

  it("keeps an incomplete promotion draft saveable while it is hidden", () => {
    const hiddenDraft = block("promo", "promotion_playlist", {
      title: "",
      placement: "before_featured",
      cards: [{
        itemId: "draft-card",
        title: "",
        summary: "",
        imageAssetId: "",
        alt: "",
        href: "",
      }],
    });

    expect(parseBlocks([{ ...hiddenDraft, visible: false }]).ok).toBe(true);
    expect(parseBlocks([hiddenDraft]).ok).toBe(false);
  });
});

describe("editorial record contract", () => {
  type IsRequired<T, K extends keyof T> = {} extends Pick<T, K> ? false : true;

  const base = {
    id: "record_01",
    slug: "current-slug",
    previousSlugs: ["old-slug"],
    locale: "en",
    status: "published" as const,
    publishAt: "2026-07-10T00:00:00Z",
  };

  it("includes posts in the iterable editorial types", () => {
    expect(EDITORIAL_TYPES).toContain("post");
  });

  it("no longer carries article as a stored editorial type (#1039)", () => {
    // A loader iterates these to map a type to a storage collection. Leaving article
    // here would keep a retired model reachable from the model layer itself, even
    // with its editor descriptors gone.
    expect(EDITORIAL_TYPES).not.toContain("article");
  });

  it("keeps active-work assignment out of terminal lifecycle states", () => {
    expect(isAssignableContentStatus("draft")).toBe(true);
    expect(isAssignableContentStatus("in_review")).toBe(true);
    expect(isAssignableContentStatus("approved")).toBe(true);
    expect(isAssignableContentStatus("scheduled")).toBe(true);
    expect(isAssignableContentStatus("published")).toBe(false);
    expect(isAssignableContentStatus("archived")).toBe(false);
    expect(isAssignableContentStatus("future_status")).toBe(false);
  });

  it("carries previous slugs on the shared editorial base", () => {
    const record: EditorialBase = base;
    const previousSlugsRequired: IsRequired<EditorialBase, "previousSlugs"> = true;
    expect(record.previousSlugs).toEqual(["old-slug"]);
    expect(previousSlugsRequired).toBe(true);
  });

  it("represents posts with working blocks and a published snapshot", () => {
    const post: PostRecord = {
      ...base,
      type: "post",
      title: "Station update",
      date: "2026-07-10",
      tags: ["station"],
      blocks: [],
      published: {
        blocks: [],
        metadata: {
          type: "post",
          title: "Station update",
          date: "2026-07-10",
          tags: ["station"],
          slug: base.slug,
          previousSlugs: base.previousSlugs,
          locale: base.locale,
        },
        publishedAt: "2026-07-10T01:00:00Z",
        publishedBy: "user_01",
        sourceVersion: 1,
      },
    };
    const record: EditorialRecord = post;
    expect(record.type).toBe("post");
    expect(post.published?.publishedBy).toBe("user_01");
  });

  it("keeps the last published page blocks separate from working blocks", () => {
    const publishedAtRequired: IsRequired<PublishedSnapshot, "publishedAt"> = true;
    const publishedByRequired: IsRequired<PublishedSnapshot, "publishedBy"> = true;
    const workingBlock: PageBlock = {
      id: "working",
      type: "headline",
      order: 0,
      visible: true,
      data: { text: "Draft heading" },
    };
    const publishedBlock: PageBlock = {
      id: "published",
      type: "headline",
      order: 0,
      visible: true,
      data: { text: "Live heading" },
    };
    const page: PageSingleton = {
      ...base,
      title: "About",
      blocks: [workingBlock],
      published: {
        blocks: [publishedBlock],
        metadata: { title: "About" },
        publishedAt: "2026-07-10T01:00:00Z",
        publishedBy: "user_01",
        sourceVersion: 1,
      },
    };
    expect(page.blocks[0].id).toBe("working");
    expect(page.published?.blocks[0].id).toBe("published");
    expect(publishedAtRequired).toBe(true);
    expect(publishedByRequired).toBe(true);
  });

  it("allows a draft page with no published snapshot yet", () => {
    const page: PageSingleton = {
      ...base,
      status: "draft",
      title: "New page",
      blocks: [],
    };
    expect(page.published).toBeUndefined();
  });
});

describe("keyOf", () => {
  it("keys a record on its immutable id, never the slug", () => {
    const record = { id: "art_01", slug: "old-slug", previousSlugs: [], locale: "en", status: "published" as const, publishAt: "2026-07-07T00:00:00Z" };
    expect(keyOf(record)).toBe("art_01");
    expect(keyOf({ ...record, slug: "new-slug" })).toBe("art_01");
  });
});

describe("snapshotRevision / restoreRevision: whole-doc, independent copies (issue #200)", () => {
  const NOW = "2026-07-14T12:00:00.000Z";
  function post(): PostRecord {
    return {
      id: "p1",
      type: "post",
      slug: "hello",
      previousSlugs: [],
      locale: "en",
      status: "published",
      publishAt: NOW,
      title: "Hello",
      date: NOW,
      tags: ["news"],
      blocks: [
        { id: "b1", type: "prose", order: 0, visible: true, data: { content: { type: "doc", content: [] } } },
        { id: "b2", type: "image", order: 1, visible: true, data: { assetId: "asset-9", alt: "A test" } },
      ],
    };
  }

  it("snapshots the whole record, including blocks and asset references", () => {
    const rev = snapshotRevision(post(), { seq: 3, at: NOW, by: "e1" });
    expect(rev.seq).toBe(3);
    expect(rev.takenAt).toBe(NOW);
    expect(rev.takenBy).toBe("e1");
    expect(rev.snapshot.blocks).toHaveLength(2);
    expect((rev.snapshot.blocks[1].data as { assetId: string }).assetId).toBe("asset-9");
  });

  it("does not alias the live record: editing it later cannot mutate the snapshot", () => {
    const record = post();
    const rev = snapshotRevision(record, { seq: 1, at: NOW });
    record.title = "Edited after the snapshot";
    record.blocks.push({ id: "b3", type: "divider", order: 2, visible: true, data: {} });
    expect(rev.snapshot.title).toBe("Hello");
    expect(rev.snapshot.blocks).toHaveLength(2);
  });

  it("restores an independent copy: mutating the restored record cannot corrupt the revision", () => {
    const rev = snapshotRevision(post(), { seq: 1, at: NOW });
    const restored = restoreRevision(rev);
    expect(restored.title).toBe("Hello");
    expect(restored.blocks).toHaveLength(2);
    restored.title = "Changed";
    restored.blocks.pop();
    expect(rev.snapshot.title).toBe("Hello");
    expect(rev.snapshot.blocks).toHaveLength(2);
  });
});

describe("isSafeHref (the shared editor/renderer link predicate)", () => {
  // Exported so the editor's link tool can offer exactly what the renderer keeps.
  // It is a boolean view of safeHref, so these cases mirror the link-drop cases the
  // renderRichText tests assert, pinning the contract at the canonical source rather
  // than only through the rendered output.
  it.each(["https://pbs.org", "http://pbs.org", "mailto:member@example.org", "tel:+15551234567"])(
    "keeps the safe scheme %s",
    (href) => {
      expect(isSafeHref(href)).toBe(true);
    },
  );

  it.each(["../donate", "about", "#section", "?campaign=passport"])(
    "keeps the scheme-less relative link %s",
    (href) => {
      expect(isSafeHref(href)).toBe(true);
    },
  );

  it.each([
    "ftp://host/file",
    "sms:+15551234567",
    "javascript:alert(1)",
    "data:text/html,x",
    "//evil.example.com",
    "java\nscript:alert(1)",
  ])("drops the unsafe or protocol-relative link %s", (href) => {
    expect(isSafeHref(href)).toBe(false);
  });

  it("drops a non-string or empty href", () => {
    expect(isSafeHref(undefined)).toBe(false);
    expect(isSafeHref(42)).toBe(false);
    expect(isSafeHref("   ")).toBe(false);
  });

  it.each([
    "https://user:secret@example.test/story",
    "http://user@example.test/",
    "https://:secret@example.test/",
    "HTTPS://us%65r:p%40ss@example.test/",
    "https:\\\\user:secret@example.test/",
    "https:///user:secret@example.test/",
    "https://",
  ])("rejects credentials or malformed web addresses: %s", (href) => {
    expect(isSafeHref(href)).toBe(false);
    expect(deployedLinks.isSafeHref(href)).toBe(false);
  });
});

// A gallery now stores how it is presented publicly (#1034). The mode is content data, so it
// travels with the block through the same parse boundary as the images themselves.
describe("the gallery presentation mode", () => {
  it("still parses a gallery stored before the mode existed", () => {
    const parsed = parseBlocks([
      block("b1", "image_gallery", { images: [{ assetId: "a1", alt: "A reporter" }] }),
    ]);
    expect(parsed.ok).toBe(true);
    // Absent stays absent: nothing rewrites stored content on the way in, and the resolver
    // below is what supplies today's behavior.
    expect(parsed.ok && parsed.blocks[0].data).not.toHaveProperty("presentation");
  });

  it("resolves an absent mode to the grid every stored gallery renders as today", () => {
    expect(galleryPresentation({ images: [] })).toBe("grid");
    expect(galleryPresentation({ images: [], presentation: "carousel" })).toBe("carousel");
  });

  it("parses each supported mode and keeps it through the round trip", () => {
    for (const presentation of GALLERY_PRESENTATIONS) {
      const parsed = parseBlocks([
        block("b1", "image_gallery", { images: [{ assetId: "a1", alt: "A" }], presentation }),
      ]);
      expect(parsed.ok, presentation).toBe(true);
      expect(parsed.ok && parsed.blocks[0].data).toMatchObject({ presentation });
    }
  });

  // Safe to refuse because the field is new: no stored gallery can already hold a mode, so
  // this cannot take published content offline. Accepting one would hand the renderer a class
  // no stylesheet defines and publish an unstyled row.
  it("refuses a mode the public renderer does not have", () => {
    expect(
      parseBlocks([
        block("b1", "image_gallery", { images: [], presentation: "masonry" }),
      ]),
    ).toEqual({ ok: false, error: "blocks[0] has invalid data for image_gallery" });
    expect(
      parseBlocks([block("b1", "image_gallery", { images: [], presentation: 2 })]).ok,
    ).toBe(false);
  });

  // The editor's explanation of what a mode does publicly is read from here, so the two
  // cannot drift into a UI that promises a lightbox the renderer never emits.
  it("describes every mode it offers, and offers every mode it describes", () => {
    expect(GALLERY_PRESENTATION_SPECS.map((spec) => spec.value)).toEqual([
      ...GALLERY_PRESENTATIONS,
    ]);
    for (const spec of GALLERY_PRESENTATION_SPECS) {
      expect(spec.label.length, spec.value).toBeGreaterThan(0);
      expect(spec.layout.length, spec.value).toBeGreaterThan(0);
      // Every mode states the click result plainly, and today that result is the same in
      // both: the renderer emits no link and the site has no lightbox.
      expect(spec.clickBehavior, spec.value).toMatch(/does nothing/i);
    }
  });
});

describe("collection item identity", () => {
  it.each([
    {
      type: "image_gallery" as const,
      data: {
        images: [
          { itemId: "same-item", assetId: "image-1", alt: "First" },
          { itemId: "same-item", assetId: "image-2", alt: "Second" },
        ],
      },
    },
    {
      type: "card_grid" as const,
      data: {
        cards: [
          { itemId: "same-item", title: "First" },
          { itemId: "same-item", title: "Second" },
        ],
      },
    },
  ])("refuses repeated item ids in a $type block", ({ type, data }) => {
    expect(parseBlocks([block("b1", type, data)])).toEqual({
      ok: false,
      error: `blocks[0] has invalid data for ${type}`,
    });
  });

  it("keeps accepting legacy items that have no item id", () => {
    expect(
      parseBlocks([
        block("b1", "image_gallery", {
          images: [
            { assetId: "image-1", alt: "First" },
            { assetId: "image-2", alt: "Second" },
          ],
        }),
      ]).ok,
    ).toBe(true);
  });
});

describe("the decorative image flag", () => {
  // The shape parser and the editorial rule answer different questions on purpose.
  // Tightening this to demand a resolved alt would make every page already holding an
  // image with an empty alt fail to parse, taking published content offline to enforce a
  // rule about what may be saved next.
  it("still parses an image stored before the decorative option existed", () => {
    expect(parseBlocks([block("b1", "image", { assetId: "asset-1", alt: "" })]).ok).toBe(true);
  });

  // The parser refuses what no stored page can already hold.
  it("refuses a stored image that is both decorative and described", () => {
    expect(
      parseBlocks([
        block("b1", "image", { assetId: "asset-1", alt: "A reporter", altDecorative: true }),
      ]),
    ).toEqual({ ok: false, error: "blocks[0] has invalid data for image" });
  });

  it("refuses a non-boolean decorative flag", () => {
    expect(
      parseBlocks([
        block("b1", "image", { assetId: "asset-1", alt: "", altDecorative: "yes" }),
      ]).ok,
    ).toBe(false);
  });

  it("keeps the decorative flag through a parse round trip", () => {
    const parsed = parseBlocks([
      block("b1", "image", { assetId: "asset-1", alt: "", altDecorative: true }),
    ]);
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.blocks[0].data).toMatchObject({ altDecorative: true });
  });
});


