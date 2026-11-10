import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { InlineBlockSurface } from "../src/components/InlineBlockSurface";
import { ContentShelfSources } from "../src/components/ContentShelfPicker";
import type { MediaPickerLoader } from "../src/components/MediaPickerDialog";
import type { AdminBlock } from "../src/lib/block-factory";
import type { MediaAssetSummary } from "../src/lib/functions";
import { COVERAGE_LIST_LIMITS, type PromotionPlaylistData } from "../../packages/content-core/src/content-model";

afterEach(cleanup);
beforeEach(() => vi.stubEnv("VITE_CMS_HOME_LAYOUTS_ENABLED", undefined));
afterEach(() => vi.unstubAllEnvs());

describe("Sponsor strip editor", () => {
  it("hydrates saved sponsor names and archived status without a search", async () => {
    const loadRecord = vi.fn(async () => ({ status: "ready", record: {
      id: "saved", type: "sponsor", name: "Saved supporter", status: "archived",
    } }));
    const block: AdminBlock = { id: "strip", type: "sponsor_strip", order: 0, visible: true,
      data: { heading: "Thanks", sponsorIds: ["saved"], layout: "row" } };
    render(<ContentShelfSources.Provider value={{ loadRecord: loadRecord as never }}>
      <InlineBlockSurface block={block} hasError={false} onChange={vi.fn()} />
    </ContentShelfSources.Provider>);
    expect(await screen.findByText("Saved supporter (archived)")).toBeInTheDocument();
    expect(loadRecord).toHaveBeenCalledWith("sponsor", "saved");
  });
  it("searches sponsor records, selects several, and preserves explicit order", async () => {
    const loadLibrarySelection = vi.fn(async () => ({ records: [
      { id: "a", kind: "sponsor", title: "Alpha", status: "draft" },
      { id: "b", kind: "sponsor", title: "Beta", status: "draft" },
    ], page: 1, pageCount: 1 }));
    const onChange = vi.fn();
    const block: AdminBlock = { id: "strip", type: "sponsor_strip", order: 0, visible: true,
      data: { heading: "Thanks", sponsorIds: [], layout: "row" } };
    const view = (current: AdminBlock) => <ContentShelfSources.Provider value={{ loadLibrarySelection: loadLibrarySelection as never }}>
      <InlineBlockSurface block={current} hasError={false} onChange={onChange} />
    </ContentShelfSources.Provider>;
    const rendered = render(view(block));
    fireEvent.click(screen.getByRole("button", { name: "Search sponsors" }));
    await screen.findByLabelText(/Alpha/);
    expect(loadLibrarySelection).toHaveBeenCalledWith(expect.objectContaining({ types: ["sponsor"] }));
    fireEvent.click(screen.getByLabelText(/Alpha/));
    expect(onChange).toHaveBeenLastCalledWith({ ...block.data, sponsorIds: ["a"] }, true);
    rendered.rerender(view({ ...block, data: { ...block.data, sponsorIds: ["a"] } }));
    fireEvent.click(screen.getByLabelText(/Beta/));
    expect(onChange).toHaveBeenLastCalledWith({ ...block.data, sponsorIds: ["a", "b"] }, true);
    rendered.rerender(view({ ...block, data: { ...block.data, sponsorIds: ["a", "b"] } }));
    fireEvent.click(screen.getByRole("button", { name: "Move Beta up" }));
    expect(onChange).toHaveBeenLastCalledWith({ ...block.data, sponsorIds: ["b", "a"] }, true);
  });
});

function cardGridBlock(): AdminBlock {
  return {
    id: "cards-1",
    type: "card_grid",
    order: 0,
    visible: true,
    data: {
      cards: [{ title: "Programs", body: { type: "doc", content: [] } }],
    },
  } as AdminBlock;
}

function faqBlock(): AdminBlock {
  return {
    id: "faq-1",
    type: "faq_item",
    order: 0,
    visible: true,
    data: {
      question: "Where can I watch?",
      answer: { type: "doc", content: [] },
    },
  } as AdminBlock;
}

function contentShelfBlock(): AdminBlock {
  return {
    id: "shelf-1",
    type: "content_shelf",
    order: 0,
    visible: true,
    data: {
      title: "Featured on NJ PBS",
      source: "pbs_featured",
      itemLimit: 8,
      moreLabel: "Browse all",
      moreHref: "https://watch.njpbs.org/",
    },
  };
}

const shelfImage: MediaAssetSummary = {
  id: "asset-alpha",
  name: "Alpha image",
  originalName: "alpha.png",
  category: "news",
  categories: ["news"],
  tags: [],
  description: null,
  altText: "Alpha image",
  license: "NJ PBS owned",
  credit: null,
  mimeType: "image/png",
  kind: "image",
  sizeBytes: 128,
  width: 800,
  height: 450,
  url: "https://media.njpbs.org/alpha.png",
  lifecycle: "active",
  version: 1,
  etag: '"media.YXNzZXQtYWxwaGE.1"',
  createdAt: "2026-08-13T12:00:00.000Z",
  createdBy: "editor-1",
  updatedAt: "2026-08-13T12:00:00.000Z",
  updatedBy: "editor-1",
};

function promotionShelfBlock(): AdminBlock & { data: PromotionPlaylistData } {
  return {
    id: "promotion-1",
    type: "promotion_playlist",
    order: 0,
    visible: true,
    data: {
      title: "  ",
      placement: "before_featured",
      presentation: "rail",
      cards: [
        {
          itemId: "card-zulu",
          title: "Zulu program",
          summary: "Zulu summary",
          imageAssetId: "asset-zulu",
          alt: "Zulu image",
          href: "/watch/zulu/",
        },
        {
          itemId: "card-alpha",
          title: "Alpha program",
          summary: "Alpha summary",
          imageAssetId: "asset-alpha",
          alt: "Alpha image",
          href: "/watch/alpha/",
        },
      ],
    },
  };
}

// The generated-heading rank is interpolated straight into a tag name and then cast to
// `"h1" | ... | "h6"`. The cast is a promise TypeScript cannot check, so these cover the
// runtime side of it: every caller today derives the prop from generatedHeadingLevelAt,
// which clamps, but the component's own prop type accepts any number. Issue #479 is the
// same class in the stored-content renderer, fixed there by an integer guard.
describe("InlineBlockSurface generated heading rank", () => {
  it("renders a valid heading tag for a fractional card-grid rank", () => {
    const { container } = render(
      <InlineBlockSurface
        block={cardGridBlock()}
        generatedHeadingLevel={2.5}
        hasError={false}
        onChange={() => {}}
      />,
    );
    // H2 exactly, not merely a valid tag: the shared clamp falls back to 2 on a
    // non-integer, so rounding 2.5 up to h3 would still pass a validity check while
    // disagreeing with the h2 the published page emits.
    expect(container.querySelector(".card-grid__title")?.tagName).toBe("H2");
  });

  it("renders a valid heading tag for a fractional FAQ rank", () => {
    const { container } = render(
      <InlineBlockSurface
        block={faqBlock()}
        generatedHeadingLevel={2.5}
        hasError={false}
        onChange={() => {}}
      />,
    );
    expect(container.querySelector(".faq-item__question")?.tagName).toBe("H2");
  });

  it("renders an out-of-range rank as a valid heading tag", () => {
    const { container } = render(
      <InlineBlockSurface
        block={cardGridBlock()}
        generatedHeadingLevel={9}
        hasError={false}
        onChange={() => {}}
      />,
    );
    expect(container.querySelector(".card-grid__title")?.tagName).toBe("H6");
  });

  it("keeps an ordinary integer rank untouched", () => {
    const { container } = render(
      <InlineBlockSurface
        block={faqBlock()}
        generatedHeadingLevel={3}
        hasError={false}
        onChange={() => {}}
      />,
    );
    expect(container.querySelector(".faq-item__question")?.tagName).toBe("H3");
  });

  it("keeps the content-shelf preview at the public renderer's derived rank", () => {
    render(
      <InlineBlockSurface
        block={contentShelfBlock()}
        generatedHeadingLevel={4}
        hasError={false}
        onChange={() => {}}
      />,
    );
    expect(screen.getByRole("heading", { level: 4, name: "Featured on NJ PBS" })).toBeTruthy();
  });
});

describe("InlineBlockSurface content shelf", () => {
  it.each([[3, 4], [6, 8], [12, 12]])("emits compatible existing shelf data for count %s when Home layouts are disabled", (itemLimit, expectedLimit) => {
    vi.stubEnv("VITE_CMS_HOME_LAYOUTS_ENABLED", "false");
    const block = contentShelfBlock();
    block.data = { ...block.data, presentation: "grid", columns: 3, itemLimit };
    const onChange = vi.fn();
    render(<InlineBlockSurface block={block} hasError={false} onChange={onChange} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Shelf heading" }), { target: { value: "Updated programs" } });
    expect(onChange).toHaveBeenLastCalledWith({
      ...contentShelfBlock().data, title: "Updated programs", itemLimit: expectedLimit,
    });
    expect(block.data).toMatchObject({ presentation: "grid", columns: 3, itemLimit });
  });

  it("omits layout fields and incompatible counts when Home layouts are disabled", () => {
    vi.stubEnv("VITE_CMS_HOME_LAYOUTS_ENABLED", "false");
    const block = contentShelfBlock();
    const onChange = vi.fn();
    const view = render(<InlineBlockSurface block={block} hasError={false} onChange={onChange} />);
    expect(screen.queryByLabelText("Shelf layout")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Grid columns")).not.toBeInTheDocument();
    expect(within(screen.getByLabelText(/^Number of items/)).getAllByRole("option").map(option => option.getAttribute("value")))
      .toEqual(["4", "8", "12", "16", "24"]);
    fireEvent.change(screen.getByRole("textbox", { name: "Shelf heading" }), { target: { value: "Updated programs" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...block.data, title: "Updated programs" });
    view.rerender(<InlineBlockSurface block={{ ...block, data: { ...block.data, presentation: "grid", columns: 3 } }} hasError={false} onChange={onChange} />);
    expect(screen.queryByLabelText("Shelf layout")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Grid columns")).not.toBeInTheDocument();
  });

  it("waits for a save refusal before announcing missing shelf fields", () => {
    const block: AdminBlock = {
      ...contentShelfBlock(),
      data: {
        title: "",
        source: "pbs_featured",
        itemLimit: 4,
        moreLabel: "",
        moreHref: "",
      },
    };
    const view = render(
      <InlineBlockSurface
        block={block}
        hasError={false}
        onChange={() => {}}
      />,
    );
    expect(screen.queryByRole("alert")).toBeNull();

    view.rerender(
      <InlineBlockSurface
        block={block}
        hasError={true}
        onChange={() => {}}
      />,
    );
    expect(screen.getAllByRole("alert")).toHaveLength(3);
  });

  it("edits only finite shelf parameters and explains the derived cards", () => {
    const onChange = vi.fn();
    const block = contentShelfBlock();

    render(
      <InlineBlockSurface
        block={block}
        hasError={false}
        onChange={onChange}
      />,
    );

    expect(screen.getByRole("heading", { level: 2, name: "Featured on NJ PBS" })).toBeTruthy();
    expect(screen.getByText(/cards refresh from PBS Media Manager/i)).toBeTruthy();
    expect(screen.queryByText(/Garden State Stories/i)).toBeNull();
    expect(screen.getByLabelText(/^Content source/)).toHaveValue("pbs_featured");
    expect(screen.getByLabelText(/^Number of items/)).toHaveValue("8");

    fireEvent.change(screen.getByLabelText(/^Shelf heading/), {
      target: { value: "Programs to watch" },
    });
    expect(onChange).toHaveBeenCalledWith({
      ...block.data,
      title: "Programs to watch",
    });
  });

  it("hides Home named-shelf source and destination fields", () => {
    const block = {
      ...contentShelfBlock(),
      section: "home-featured",
    };

    render(
      <InlineBlockSurface
        block={block}
        hasError={false}
        onChange={() => {}}
      />,
    );

    expect(screen.getByLabelText(/^Shelf heading/)).toHaveValue("Featured on NJ PBS");
    expect(screen.getByLabelText(/^More link label/)).toBeVisible();
    expect(screen.queryByLabelText(/^Content source/)).toBeNull();
    expect(screen.queryByLabelText(/^More link$/)).toBeNull();
    expect(screen.getByText(/Link destination:/)).toBeVisible();
  });
});

describe("InlineBlockSurface custom shelf preview", () => {
  it("loads saved images once and keeps successful results when an asset is missing", async () => {
    const loadMedia = vi.fn<MediaPickerLoader>(async () => ({
      success: true as const,
      records: [shelfImage],
      total: 1,
      allCount: 1,
      page: 1,
      pageCount: 1,
      categoryCounts: { news: 1 },
      kindCounts: { image: 1, document: 0 },
    }));
    const block = promotionShelfBlock();
    const view = render(
      <InlineBlockSurface
        block={block}
        hasError={false}
        loadMedia={loadMedia}
        onChange={() => {}}
      />,
    );

    expect(screen.getByRole("heading", { name: "Shelf heading" })).toBeTruthy();
    await waitFor(() => {
      expect(
        view.container.querySelector(
          '.inline-custom-shelf-preview img[src="https://media.njpbs.org/alpha.png"]',
        ),
      ).toBeTruthy();
    });
    expect(screen.getByText("Zulu program")).toBeTruthy();
    const previewCalls = loadMedia.mock.calls.filter(
      ([query]) => (query.assetIds?.length ?? 0) > 1,
    );
    expect(previewCalls).toHaveLength(1);
    expect(previewCalls[0]?.[0]).toEqual({
      q: "",
      assetIds: ["asset-alpha", "asset-zulu"],
      categories: [],
      kinds: ["image"],
      sort: "updatedAt",
      direction: "desc",
      page: 1,
    });

    view.rerender(
      <InlineBlockSurface
        block={{
          ...block,
          data: { ...block.data, cards: [...block.data.cards].reverse() },
        }}
        hasError={false}
        loadMedia={loadMedia}
        onChange={() => {}}
      />,
    );
    expect(
      loadMedia.mock.calls.filter(([query]) => (query.assetIds?.length ?? 0) > 1),
    ).toHaveLength(1);
    expect(
      view.container.querySelector(
        '.inline-custom-shelf-preview img[src="https://media.njpbs.org/alpha.png"]',
      ),
    ).toBeTruthy();
  });
});

describe("InlineBlockSurface seeded card images", () => {
  it("replaces a failed seed image with the named asset placeholder", () => {
    const block = cardGridBlock();
    block.data = {
      cards: [
        {
          label: "Watch",
          title: "Programs on demand",
          body: { type: "doc", content: [] },
          imageAssetId: "launch-watch",
          href: "https://watch.njpbs.org/",
        },
      ],
    };

    render(
      <InlineBlockSurface
        block={block}
        hasError={false}
        onChange={() => {}}
        showPageSeedAssets
      />,
    );

    const image = document.querySelector<HTMLImageElement>(".inline-card-seed-image");
    expect(image).not.toBeNull();
    fireEvent.error(image as HTMLImageElement);

    expect(screen.getByText("Card image")).toBeVisible();
    expect(screen.getByText("Asset id: launch-watch")).toBeVisible();
    expect(document.querySelector(".inline-card-seed-image")).toBeNull();
  });
});

describe("InlineBlockSurface link card", () => {
  it("edits the standalone card fields and shows its public preview", () => {
    const onChange = vi.fn();
    const block: AdminBlock = {
      id: "link-1",
      type: "link_card",
      order: 0,
      visible: true,
      data: {
        title: "Station story",
        url: "https://example.com/story",
        source: "Example news",
        date: "2026-09-17",
        summary: "A short summary.",
      },
    };
    render(<InlineBlockSurface block={block} hasError={false} onChange={onChange} />);
    expect(document.querySelector(".link-card__title")?.textContent).toBe("Station story");
    fireEvent.change(screen.getByRole("textbox", { name: /Card title/ }), { target: { value: "Updated story" } });
    expect(onChange).toHaveBeenCalledWith({ ...block.data, title: "Updated story" });
  });
});

describe("InlineBlockSurface coverage conversion", () => {
  it("turns linked press text into link cards without retyping", () => {
    const onConvertCoverage = vi.fn();
    const block: AdminBlock = {
      id: "prose-1",
      type: "prose",
      order: 0,
      visible: true,
      data: {
        content: {
          type: "doc",
          content: [
            {
              type: "heading",
              attrs: { level: 2 },
              content: [{ type: "text", text: "2026" }],
            },
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "Maplewood’s Rob Nelson Named Anchor of New NJ PBS Daily Newscast",
                  marks: [{
                    type: "link",
                    attrs: {
                      href: "https://villagegreennj.com/towns/maplewood/maplewoods-rob-nelson-named-anchor-of-new-nj-pbs-daily-newscast/",
                    },
                  }],
                },
                { type: "text", text: " — The Village Green — September 17, 2026" },
              ],
            },
          ],
        },
      },
    };
    const { unmount } = render(
      <InlineBlockSurface
        block={block}
        hasError={false}
        onChange={() => {}}
        onConvertCoverage={onConvertCoverage}
      />,
    );
    expect(screen.getByText(/This text looks like 1 outside article/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Turn into link cards" }));
    expect(onConvertCoverage).toHaveBeenCalledWith([{
        title: "Maplewood’s Rob Nelson Named Anchor of New NJ PBS Daily Newscast",
        outlet: "The Village Green",
        date: "2026-09-17",
        url: "https://villagegreennj.com/towns/maplewood/maplewoods-rob-nelson-named-anchor-of-new-nj-pbs-daily-newscast/",
      }]);

    unmount();
    render(
      <InlineBlockSurface
        block={block}
        hasError={false}
        onChange={() => {}}
        onConvertCoverage={onConvertCoverage}
        coverageCardCapacity={0}
      />,
    );
    expect(screen.queryByRole("button", { name: "Turn into link cards" })).toBeNull();
    expect(screen.getByText(/This page has room for 0 more link cards/)).toBeTruthy();
  });

  it("warns when conversion would drop introduction text", () => {
    const block: AdminBlock = {
      id: "prose-2",
      type: "prose",
      order: 0,
      visible: true,
      data: {
        content: {
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "NJ PBS in the news." }] },
            {
              type: "heading",
              attrs: { level: 2 },
              content: [{ type: "text", text: "2026" }],
            },
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "Maplewood’s Rob Nelson Named Anchor of New NJ PBS Daily Newscast",
                  marks: [{
                    type: "link",
                    attrs: {
                      href: "https://villagegreennj.com/towns/maplewood/maplewoods-rob-nelson-named-anchor-of-new-nj-pbs-daily-newscast/",
                    },
                  }],
                },
                { type: "text", text: " — The Village Green — September 17, 2026" },
              ],
            },
          ],
        },
      },
    };
    render(
      <InlineBlockSurface
        block={block}
        hasError={false}
        onChange={() => {}}
        onConvertCoverage={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Turn into link cards" })).toBeTruthy();
    expect(screen.getByText(/Other sentences in this block will be removed/)).toBeTruthy();
  });

  it("does not offer conversion for ordinary linked prose", () => {
    const block: AdminBlock = {
      id: "prose-3",
      type: "prose",
      order: 0,
      visible: true,
      data: {
        content: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "Watch " },
                {
                  type: "text",
                  text: "NJ PBS",
                  marks: [{ type: "link", attrs: { href: "https://watch.njpbs.org/" } }],
                },
                { type: "text", text: " tonight." },
              ],
            },
          ],
        },
      },
    };
    render(
      <InlineBlockSurface
        block={block}
        hasError={false}
        onChange={() => {}}
        onConvertCoverage={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: "Turn into link cards" })).toBeNull();
  });

  it("does not offer conversion that would drop year headings without full dates", () => {
    const block: AdminBlock = {
      id: "prose-year-headings",
      type: "prose",
      order: 0,
      visible: true,
      data: {
        content: {
          type: "doc",
          content: [
            {
              type: "heading",
              attrs: { level: 2 },
              content: [{ type: "text", text: "2026" }],
            },
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "Newer story",
                  marks: [{ type: "link", attrs: { href: "https://example.com/new" } }],
                },
                { type: "text", text: " — The Village Green" },
              ],
            },
            {
              type: "heading",
              attrs: { level: 2 },
              content: [{ type: "text", text: "2025" }],
            },
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "Older story",
                  marks: [{ type: "link", attrs: { href: "https://example.com/old" } }],
                },
                { type: "text", text: " — Outlet" },
              ],
            },
          ],
        },
      },
    };
    render(
      <InlineBlockSurface
        block={block}
        hasError={false}
        onChange={() => {}}
        onConvertCoverage={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: "Turn into link cards" })).toBeNull();
    expect(screen.getByText(/year headings/i)).toBeTruthy();
    expect(screen.getByText(/full date/i)).toBeTruthy();
  });

  it("does not offer conversion that would drop articles beyond the 100-item limit", () => {
    const block: AdminBlock = {
      id: "prose-overflow",
      type: "prose",
      order: 0,
      visible: true,
      data: {
        content: {
          type: "doc",
          content: Array.from({ length: 101 }, (_, index) => ({
            type: "paragraph",
            content: [
              {
                type: "text",
                text: `Story ${index + 1}`,
                marks: [{ type: "link", attrs: { href: `https://example.com/${index + 1}` } }],
              },
              { type: "text", text: " — Outlet — Jan. 2, 2026" },
            ],
          })),
        },
      },
    };
    render(
      <InlineBlockSurface
        block={block}
        hasError={false}
        onChange={() => {}}
        onConvertCoverage={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: "Turn into link cards" })).toBeNull();
    expect(screen.getByText(/The converter can read up to 100 articles. This text has 101/)).toBeTruthy();
  });

  it("does not offer conversion that would cut over-limit titles, outlets, or links", () => {
    const block: AdminBlock = {
      id: "prose-over-limit",
      type: "prose",
      order: 0,
      visible: true,
      data: {
        content: {
          type: "doc",
          content: [{
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "A".repeat(COVERAGE_LIST_LIMITS.title + 1),
                marks: [{ type: "link", attrs: { href: "https://example.com/story" } }],
              },
              { type: "text", text: " — Outlet — Jan. 2, 2026" },
            ],
          }],
        },
      },
    };
    render(
      <InlineBlockSurface
        block={block}
        hasError={false}
        onChange={() => {}}
        onConvertCoverage={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: "Turn into link cards" })).toBeNull();
    expect(screen.getByText(/This text is longer. Shorten it/)).toBeTruthy();
  });

  it("does not mark ordinary coverage text edits as discrete", () => {
    const onChange = vi.fn();
    render(
      <InlineBlockSurface
        block={{
          id: "coverage-1",
          type: "coverage_list",
          order: 0,
          visible: true,
          data: {
            entries: [{
              title: "Story",
              outlet: "Outlet",
              date: "2026-09-17",
              url: "https://example.com/story",
            }],
          },
        }}
        hasError={false}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: /Article title/ }), {
      target: { value: "Story edited" },
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[1]).toBeUndefined();
  });

  it("shows an empty coverage list preview until an article is added", () => {
    render(
      <InlineBlockSurface
        block={{
          id: "coverage-1",
          type: "coverage_list",
          order: 0,
          visible: true,
          data: { entries: [] },
        }}
        hasError={false}
        onChange={() => {}}
      />,
    );
    expect(screen.getByText("Add an article to see how it will look on the page.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add article" })).toBeTruthy();
  });
});

describe("Image link fields", () => {
  const imageBlock = (data: Record<string, unknown>): AdminBlock => ({
    id: "img", type: "image", order: 0, visible: true,
    data: { assetId: "a1", alt: "Watch the newscast", altDecorative: false, caption: "", href: "", newTab: false, ...data },
  });

  it("edits the link and the new-tab choice on the block data", () => {
    const onChange = vi.fn();
    const block = imageBlock({});
    const rendered = render(<InlineBlockSurface block={block} hasError={false} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText(/^Image link/), { target: { value: "https://youtu.be/abc" } });
    expect(onChange.mock.lastCall?.[0]).toEqual({ ...block.data, href: "https://youtu.be/abc" });
    rendered.rerender(<InlineBlockSurface block={imageBlock({ href: "https://youtu.be/abc" })} hasError={false} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText(/^Open link in a new tab/));
    expect(onChange.mock.lastCall?.[0]).toEqual({ ...block.data, href: "https://youtu.be/abc", newTab: true });
  });

  it("names a link on a decorative image as the error", () => {
    render(<InlineBlockSurface block={imageBlock({ alt: "", altDecorative: true, href: "/live/" })} hasError onChange={vi.fn()} />);
    expect(screen.getByText("Image link must be empty while Mark as decorative is on.")).toBeInTheDocument();
  });
});
