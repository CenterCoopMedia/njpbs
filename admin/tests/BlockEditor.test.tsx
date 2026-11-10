import { afterEach, describe, it, expect, vi } from "vitest";

// Modal editing flows include retained fields and repeated surface changes.
vi.setConfig({ testTimeout: 10_000 });
import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { BlockEditor } from "../src/components/BlockEditor";
import { WorkspaceActionsProvider } from "../src/components/WorkspaceActions";
import { ControlPresentationProvider } from "../src/context/ControlPresentationContext";
import { createBlock, type AdminBlock } from "../src/lib/block-factory";
import type {
  MediaAssetSummary,
  MediaCategoryDefinition,
} from "../src/lib/functions";
import homeComposition from "../../site/tests/fixtures/home-composition-v1.json";
import { pageCompositionRegionLabel, pageCompositionSeed } from "../../packages/content-core/src/page-composition-seeds";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

// A deterministic id generator so tests do not depend on crypto.randomUUID and ids are
// stable across a run.
function counterIds() {
  let n = 0;
  return () => `b${++n}`;
}

const pickerImage: MediaAssetSummary = {
  id: "asset-news-desk",
  name: "News desk",
  originalName: "news-desk.png",
  category: "news",
  categories: ["news"],
  tags: ["studio"],
  description: null,
  altText: "A presenter at the news desk",
  license: "NJ PBS owned",
  credit: "NJ PBS",
  mimeType: "image/png",
  kind: "image",
  sizeBytes: 2_048,
  width: 1_600,
  height: 900,
  url: "https://media.njpbs.org/news-desk.png",
  lifecycle: "active",
  version: 1,
  etag: '"media.YXNzZXQtbmV3cy1kZXNr.1"',
  createdAt: "2026-08-13T12:00:00.000Z",
  createdBy: "editor-1",
  updatedAt: "2026-08-13T12:00:00.000Z",
  updatedBy: "editor-1",
};

const pickerCategories: MediaCategoryDefinition[] = [
  {
    id: "news",
    label: "News",
    description: "Newsroom media",
    order: 10,
    active: true,
    reserved: false,
    version: 1,
    etag: '"media-category.bmV3cw.1"',
    canUpload: true,
    canManage: false,
    createdAt: null,
    createdBy: null,
    updatedAt: null,
    updatedBy: null,
  },
];

function kindsInOrder(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll(".block-card-kind")).map(
    (el) => el.textContent ?? "",
  );
}

function doneEditing() {
  for (const dialog of screen.queryAllByRole("dialog")) {
    if (dialog.classList.contains("component-editor-dialog")) {
      fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    }
  }
}

function editBlock(name: string | RegExp) {
  doneEditing();
  fireEvent.click(screen.getByRole("button", { name }));
}

function savePage() {
  doneEditing();
  fireEvent.click(screen.getByRole("button", { name: "Save page" }));
}

function addBlock(name: string) {
  doneEditing();
  const contentTrigger = screen
    .queryAllByRole("button", { name: /^Add content(?:: position \d+)?$/ })
    .at(-1);
  if (contentTrigger) {
    const position = contentTrigger
      .getAttribute("aria-label")
      ?.match(/position (\d+)/)?.[1];
    fireEvent.click(contentTrigger);
    const picker = screen.getByRole("radiogroup", {
      name: position ? `Content types at position ${position}` : "Content types",
    });
    fireEvent.click(within(picker).getByRole("radio", { name }));
    fireEvent.click(screen.getByRole("button", { name: "Insert block" }));
    return;
  }
  const trigger = screen
    .getAllByRole("button", { name: /Add block: position/ })
    .at(-1);
  if (!trigger) throw new Error("Missing block insertion control");
  const position = trigger
    .getAttribute("aria-label")
    ?.match(/position (\d+)/)?.[1];
  if (!position) throw new Error("Missing block insertion position");
  fireEvent.click(trigger);
  fireEvent.click(
    within(
      screen.getByRole("group", {
        name: `Blocks to insert at position ${position}`,
      }),
    ).getByRole("button", { name }),
  );
}

function longPageBlocks(): AdminBlock[] {
  return [
    {
      id: "heading-1",
      type: "headline",
      order: 0,
      visible: true,
      data: { text: "Tonight on NJ PBS", level: 2 },
    },
    {
      id: "divider-1",
      type: "divider",
      order: 1,
      visible: true,
      data: {},
    },
  ];
}

describe("BlockEditor palette", () => {
  it("keeps compact movement and disclosure icons in Text presentation and Remove explicit", async () => {
    render(
      <ControlPresentationProvider value="text">
        <BlockEditor
          section="home"
          initialBlocks={longPageBlocks()}
          newId={counterIds()}
        />
      </ControlPresentationProvider>,
    );

    doneEditing();
    fireEvent.click(screen.getByRole("button", { name: "Outline" }));
    const move = await screen.findByRole("button", {
      name: "Move down: heading 1 in content outline",
    });
    expect(move).not.toHaveTextContent("Move down");
    expect(move.querySelector(".icon")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Collapse: heading 1" })).toBeNull();
    editBlock("Edit heading 1");
    expect(screen.getByRole("button", { name: "Remove heading 1" })).toHaveTextContent(
      "Remove",
    );
  });

  it("uses icons for registered block actions but never hides Remove", async () => {
    render(
      <ControlPresentationProvider value="icons">
        <BlockEditor
          section="home"
          initialBlocks={longPageBlocks()}
          newId={counterIds()}
        />
      </ControlPresentationProvider>,
    );

    doneEditing();
    fireEvent.click(screen.getByRole("button", { name: "Outline" }));
    const move = await screen.findByRole("button", {
      name: "Move down: heading 1 in content outline",
    });
    expect(move).not.toHaveTextContent("Move down");
    expect(move.querySelector(".icon")).toBeInTheDocument();

    editBlock("Edit heading 1");
    const remove = screen.getByRole("button", { name: "Remove heading 1" });
    expect(remove).toHaveTextContent("Remove");
    expect(remove.querySelector(".icon")).toBeInTheDocument();

    doneEditing();
    const insert = screen.getByRole("button", { name: "Add content: position 1" });
    act(() => insert.focus());
    expect(screen.getByRole("tooltip", { hidden: true })).toHaveTextContent(
      /^Add content: position 1$/,
    );
  });

  it("offers only the blocks the home template allows, in palette order", () => {
    render(<BlockEditor section="home" newId={counterIds()} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Add content: position 1" }),
    );
    const palette = screen.getByRole("radiogroup", { name: "Content types at position 1" });
    const labels = within(palette).getAllByRole("radio").map(
      radio => radio.getAttribute("aria-label"),
    );
    expect(labels).toEqual([
      "heading",
      "text",
      "image",
      "image gallery",
      "buttons",
      "card set",
      "video or embed",
      "custom HTML",
      "content shelf",
      "manual content shelf",
      "related stories",
      "video content shelf",
      "Program, event, sponsor, or newsletter",
      "sponsor strip",
      "divider",
    ]);
  });

  it.each([
    { section: "programLanding", after: "video or embed", first: "heading" },
    { section: "genericPage", after: "election results", first: "video or embed" },
  ] as const)("places county comparison after $after in the $section palette", ({ section, after, first }) => {
    render(<BlockEditor section={section} newId={counterIds()} />);
    fireEvent.click(screen.getByRole("button", { name: "Add content: position 1" }));
    const palette = screen.getByRole("radiogroup", { name: "Content types at position 1" });
    const labels = within(palette).getAllByRole("radio").map(radio => radio.getAttribute("aria-label"));
    expect(labels[0]).toBe(first);
    expect(labels).toContain(after);
    expect(labels).toContain("county comparison");
    expect(labels.indexOf("county comparison")).toBe(labels.indexOf(after) + 1);
  });

  it("keeps custom HTML away from an editor who cannot publish", () => {
    render(<BlockEditor section="post" newId={counterIds()} canEditCustomHtml={false} initialBlocks={[
      { id: "frame", type: "html", order: 0, visible: true, data: { html: "<p>Chart</p>", title: "Chart" } },
    ]} />);
    fireEvent.click(screen.getByRole("button", { name: "Add content: position 1" }));
    const palette = screen.getByRole("radiogroup", { name: "Content types at position 1" });
    expect(within(palette).queryByRole("radio", { name: "custom HTML" })).toBeNull();
    editBlock("Edit custom HTML 1");
    expect(screen.getByText(/Only Editors, Managers and Site owners can change custom HTML/)).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /HTML/ })).toBeNull();
  });

  it("preserves the approved Post palette with related stories and election results", () => {
    render(<BlockEditor section="post" newId={counterIds()} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Add content: position 1" }),
    );
    const palette = screen.getByRole("radiogroup", { name: "Content types at position 1" });
    expect(
      within(palette).getAllByRole("radio").map(
        radio => radio.getAttribute("aria-label"),
      ),
    ).toEqual([
      "bio card",
      "data table",
      "data figure",
      "election results",
      "text",
      "image",
      "uploaded video",
      "image gallery",
      "video or embed",
      "custom HTML",
      "buttons",
      "link card",
      "related stories",
      "manual content shelf",
      "Program, event, sponsor, or newsletter",
      "newsletter signup",
      "divider",
      "sponsor strip",
    ]);
    expect(palette).not.toHaveTextContent(/columns|javascript/i);
    // A story takes related stories, not a queried row of videos (#1046).
    expect(palette).not.toHaveTextContent(/video content shelf/i);
  });

  it("does not offer an FAQ item on the home page (it is not in that catalog)", () => {
    render(<BlockEditor section="home" newId={counterIds()} />);
    expect(screen.queryByRole("radio", { name: "FAQ item" })).toBeNull();
  });

  it("keeps insertion choices quiet until one gap is opened", () => {
    const onDraftChange = vi.fn();
    render(
      <BlockEditor
        section="home"
        initialBlocks={longPageBlocks()}
        newId={counterIds()}
        onDraftChange={onDraftChange}
      />,
    );

    const toggle = screen.getByRole("button", {
      name: "Add content: position 3",
    });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("radiogroup", { name: "Content types at position 3" }),
    ).toBeNull();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("radiogroup", { name: "Content types at position 3" }),
    ).toBeTruthy();
    expect(onDraftChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.queryByRole("radiogroup", { name: "Content types at position 3" }),
    ).toBeNull();
    expect(onDraftChange).not.toHaveBeenCalled();
  });

  it("opens the first insertion control on an empty page", () => {
    render(<BlockEditor section="home" newId={counterIds()} />);

    const toggle = screen.getByRole("button", { name: "Add content: position 1" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    fireEvent.click(within(
      screen.getByRole("radiogroup", { name: "Content types at position 1" }),
    ).getByRole("radio", { name: "heading" }));
    fireEvent.click(screen.getByRole("button", { name: "Insert block" }));

    expect(screen.getByRole("region", { name: "heading" })).toBeTruthy();
    expect(
      screen.queryByRole("radiogroup", { name: "Content types at position 1" }),
    ).toBeNull();
  });
});

describe("BlockEditor placement", () => {
  it("saves incomplete content in a hidden row and rechecks it when shown", async () => {
    const initialBlocks = [createBlock("row", "row"), { ...createBlock("prose", "body"), order: 1, layout: { rowId: "row", column: 0 } }];
    const onSave = vi.fn();
    render(<BlockEditor section="post" initialBlocks={initialBlocks} onSave={onSave} />);
    savePage();
    expect(onSave).not.toHaveBeenCalled();
    editBlock("Edit row 1");
    fireEvent.click(screen.getByRole("button", { name: "Hide row" }));
    expect(screen.queryByText(/Fix the highlighted blocks/)).toBeNull();
    savePage();
    expect(onSave).toHaveBeenCalledWith([
      expect.objectContaining({ id: "row", visible: false }),
      expect.objectContaining({ id: "body", visible: true, layout: { rowId: "row", column: 0 } }),
    ]);
    await waitFor(() => expect(screen.getByRole("button", { name: "Save page" })).not.toBeDisabled());
    editBlock("Edit row 1");
    fireEvent.click(screen.getByRole("button", { name: "Show row" }));
    savePage();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Fix the highlighted blocks/)).toBeInTheDocument();
  });

  it("keeps populated row removal controls inside the affected row", () => {
    const initialBlocks = [createBlock("divider", "before"), { ...createBlock("row", "row"), order: 1 },
      { ...createBlock("divider", "child"), order: 2, layout: { rowId: "row", column: 0 } }];
    render(<BlockEditor section="post" initialBlocks={initialBlocks} />);
    const row = screen.getByRole("region", { name: "Row 1" });
    fireEvent.click(within(row).getByRole("button", { name: "Edit row 1" }));
    fireEvent.click(within(row).getByRole("button", { name: "Remove row" }));
    expect(within(row).getByText("Remove this row and its content?")).toBeVisible();
    fireEvent.click(within(row).getByRole("button", { name: "Keep row" }));
    expect(within(row).queryByText("Remove this row and its content?")).toBeNull();
  });

  it("keeps the tail column intact when the outline moves its first child down", async () => {
    const initialBlocks = [createBlock("row", "row"), ...["a", "b"].map(id => ({
      ...createBlock("divider", id), layout: { rowId: "row", column: 0 },
    }))];
    const onSave = vi.fn();
    render(<BlockEditor section="post" initialBlocks={initialBlocks} onSave={onSave} />);
    doneEditing();
    fireEvent.click(screen.getByRole("button", { name: "Outline" }));
    fireEvent.click(await screen.findByRole("button", { name: "Move down: divider 2 in content outline" }));
    savePage();
    expect(onSave).toHaveBeenCalledWith([
      expect.objectContaining({ id: "row", order: 0 }),
      expect.objectContaining({ id: "b", order: 1, layout: { rowId: "row", column: 0 } }),
      expect.objectContaining({ id: "a", order: 2, layout: { rowId: "row", column: 0 } }),
    ]);
  });

  it("keeps rich-text editor state mounted when its component dialog closes", () => {
    const seed = pageCompositionSeed("watch")!;
    render(<BlockEditor pageId="watch" section="programLanding" initialBlocks={seed.blocks as AdminBlock[]} />);
    const chooser = screen.getByRole("button", { name: "Edit Watch introduction" });
    fireEvent.click(chooser);
    const body = screen.getByRole("textbox", { name: "Body" });
    doneEditing();
    expect(body).toBeInTheDocument();
    expect(body).not.toBeVisible();
    expect(screen.queryByRole("dialog")).toBeNull();
    doneEditing();
    fireEvent.click(screen.getByRole("button", { name: "Edit Watch introduction" }));
    expect(screen.getByRole("textbox", { name: "Body" })).toBe(body);
    fireEvent.click(screen.getByRole("button", { name: /Hide from page: text 2/ }));
    expect(screen.getByRole("textbox", { name: "Body" })).toBe(body);
    fireEvent.click(screen.getByRole("button", { name: /Show on page: text 2/ }));
    doneEditing();
    fireEvent.click(screen.getByRole("button", { name: "Edit Watch introduction" }));
    expect(screen.getByRole("textbox", { name: "Body" })).toBe(body);
  });

  it("edits, adds, removes, reorders, and saves the seeded Watch composition", () => {
    const onSave = vi.fn();
    const seed = pageCompositionSeed("watch");
    if (!seed) throw new Error("Missing Watch seed");

    const { container } = render(
      <BlockEditor
        pageId="watch"
        section="programLanding"
        initialBlocks={seed.blocks as AdminBlock[]}
        newId={counterIds()}
        onSave={onSave}
      />,
    );

    doneEditing();
    fireEvent.click(screen.getByRole("button", { name: "Edit Watch destinations" }));
    fireEvent.change(screen.getByDisplayValue("Programs on demand"), {
      target: { value: "Programs any time" },
    });
    doneEditing();
    fireEvent.click(screen.getByRole("button", { name: "Outline" }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Move down: buttons 1 in content outline",
      }),
    );
    // A populated block asks before it goes (#1035); the seeded composition is populated.
    doneEditing();
    fireEvent.click(screen.getByRole("button", { name: "Edit PBS service note" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove text 4" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm removal of text 4" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Add content: position 4" }),
    );
    fireEvent.click(within(
      screen.getByRole("radiogroup", { name: "Content types at position 4" }),
    ).getByRole("radio", { name: "divider" }));
    fireEvent.click(screen.getByRole("button", { name: "Insert block" }));

    expect(kindsInOrder(container)).toEqual(["text", "buttons", "card set", "divider"]);
    savePage();
    expect(onSave).toHaveBeenCalledWith([
      expect.objectContaining({
        section: "body-copy",
        type: "prose",
        order: 0,
      }),
      expect.objectContaining({
        section: "hero-actions",
        type: "cta_row",
        order: 1,
      }),
      expect.objectContaining({
        section: "watch-destinations",
        type: "card_grid",
        order: 2,
        data: expect.objectContaining({
          cards: expect.arrayContaining([
            expect.objectContaining({ title: "Programs any time" }),
          ]),
        }),
      }),
      expect.objectContaining({ type: "divider", order: 3 }),
    ]);
  }, 15_000);

  it.each([
    ["live", "Open PBS livestream", 6, "card set"],
    ["kids", "Open PBS Kids", 5, "card set"],
    ["support", "Donate", 5, "card set"],
    ["give", "Donate through PBS", 6, "card set"],
    ["passport", "Donate through PBS", 6, "card set"],
    ["about", "Support NJ PBS", 10, "text"],
  ] as const)(
    "edits, adds, removes, reorders, and saves the seeded %s composition",
    (pageId, primaryAction, blockCount, finalKind) => {
      const onSave = vi.fn();
      const seed = pageCompositionSeed(pageId);
      if (!seed) throw new Error(`Missing ${pageId} seed`);

      const { container } = render(
        <BlockEditor
          pageId={pageId}
          section="programLanding"
          initialBlocks={seed.blocks as AdminBlock[]}
          newId={counterIds()}
          onSave={onSave}
        />,
      );

      doneEditing();
      fireEvent.click(screen.getByRole("button", { name: `Edit ${pageCompositionRegionLabel(pageId, seed.blocks[0]!.section)}` }));
      fireEvent.click(
        screen.getAllByRole("button", { name: primaryAction })[0]!,
      );
      fireEvent.change(screen.getByLabelText("Button label"), {
        target: { value: `${primaryAction} now` },
      });
      doneEditing();
      fireEvent.click(screen.getByRole("button", { name: "Outline" }));
      fireEvent.click(
        screen.getByRole("button", {
          name: "Move down: buttons 1 in content outline",
        }),
      );
      doneEditing();
      fireEvent.click(screen.getByRole("button", { name: `Edit ${pageCompositionRegionLabel(pageId, seed.blocks.at(-1)!.section)}` }));
      fireEvent.click(
        screen.getByRole("button", {
          name: `Remove ${finalKind} ${blockCount}`,
        }),
      );
      // These seeded blocks hold real content, so the removal asks first (#1035).
      fireEvent.click(
        screen.getByRole("button", {
          name: `Confirm removal of ${finalKind} ${blockCount}`,
        }),
      );
      addBlock("divider");

      expect(kindsInOrder(container)).toHaveLength(blockCount);
      expect(kindsInOrder(container).at(-1)).toBe("divider");
      savePage();

      expect(onSave).toHaveBeenCalledTimes(1);
      const saved = onSave.mock.calls[0]![0] as AdminBlock[];
      expect(saved).toHaveLength(blockCount);
      expect(saved.at(-1)).toMatchObject({
        type: "divider",
        order: blockCount - 1,
      });
      expect(saved).toContainEqual(
        expect.objectContaining({
          type: "cta_row",
          data: expect.objectContaining({
            ctas: expect.arrayContaining([
              expect.objectContaining({ label: `${primaryAction} now` }),
            ]),
          }),
        }),
      );
    },
    30_000,
  );

  it("round-trips legacy Home shelf settings and refuses an over-cap shelf", () => {
    const onSave = vi.fn();
    const legacyShelves: AdminBlock[] = [
      ["featured-shelf", "Featured on NJ PBS", "pbs_featured"],
      ["more-shelf", "More to watch", "pbs_more"],
      ["spotlight-shelf", "NJ Spotlight News", "spotlight_news"],
      ["posts-shelf", "Posts", "station_posts"],
    ].map(([section, title, source], order) => ({
      id: `legacy-shelf-${order}`,
      type: "content_shelf",
      section,
      order,
      visible: true,
      data: {
        title,
        source,
        itemLimit: 8,
        moreLabel: "Browse all",
        moreHref: "https://watch.njpbs.org/",
      },
    }));

    const { container } = render(
      <BlockEditor
        pageId="home"
        section="home"
        initialBlocks={legacyShelves}
        newId={counterIds()}
        onSave={onSave}
      />,
    );

    expect(kindsInOrder(container)).toHaveLength(4);
    addBlock("content shelf");
    expect(screen.getByText(/the home page already has as many content shelf blocks as it allows/i)).toBeTruthy();
    expect(kindsInOrder(container)).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    editBlock("Edit Featured programs shelf");
    const itemLimits = within(screen.getByRole("dialog", { name: "Featured programs shelf" })).getAllByLabelText(/Number of items/);
    fireEvent.change(itemLimits[0]!, { target: { value: "12" } });
    savePage();

    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0]![0] as AdminBlock[];
    expect(saved).toHaveLength(4);
    expect(
      saved.find((block) => block.section === "featured-shelf"),
    ).toMatchObject({
      type: "content_shelf",
      data: {
        source: "pbs_featured",
        itemLimit: 12,
      },
    });
  }, 30_000);

  it("starts empty and adds a block from the palette", async () => {
    const { container } = render(
      <BlockEditor section="home" newId={counterIds()} />,
    );
    expect(screen.queryByRole("button", { name: "Add row" })).toBeNull();
    expect(screen.getByRole("button", { name: "Add content: position 1" }))
      .toHaveAttribute("aria-expanded", "false");
    addBlock("heading");
    expect(kindsInOrder(container)).toEqual(["heading"]);
    // The block exposes the heading itself as the editing surface.
    const heading = screen.getByRole("textbox", { name: "Heading" });
    expect(heading.classList.contains("inline-headline-input")).toBe(true);
    expect(heading.closest(".editor-field")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Outline" }));
    expect(await screen.findByText("1 block in outline")).toHaveClass("sr-only");
  });

  it("refuses a second heading on home, explains why, and dismisses the error", () => {
    render(<BlockEditor section="home" newId={counterIds()} />);
    addBlock("heading");
    addBlock("heading");
    expect(screen.getByText(/already has as many heading blocks/)).toBeVisible();
    const dialog = screen.getByRole("dialog", { name: "Add content" });
    expect(within(dialog).getByRole("alert")).toHaveTextContent("could not be inserted");
    // Still just one heading placed.
    expect(screen.getAllByRole("button", { name: "Edit heading 1" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reorders and removes blocks, and undoes the last structural change", () => {
    const { container } = render(
      <BlockEditor section="home" newId={counterIds()} />,
    );
    addBlock("heading");
    addBlock("text");
    expect(kindsInOrder(container)).toEqual(["heading", "text"]);

    doneEditing();
    fireEvent.click(screen.getByRole("button", { name: "Outline" }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Move down: heading 1 in content outline",
      }),
    );
    expect(kindsInOrder(container)).toEqual(["text", "heading"]);

    fireEvent.click(
      screen.getByRole("button", { name: "Move up: heading 2 in content outline" }),
    );
    expect(kindsInOrder(container)).toEqual(["heading", "text"]);

    editBlock("Edit text 2");
    fireEvent.click(screen.getByRole("button", { name: "Remove text 2" }));
    expect(kindsInOrder(container)).toEqual(["heading"]);

    // Undo restores the removed block.
    doneEditing();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(kindsInOrder(container)).toEqual(["heading", "text"]);
  });

  it("edits a headline in its component dialog", () => {
    render(<BlockEditor section="home" newId={counterIds()} />);
    addBlock("heading");
    const input = screen.getByRole("textbox", {
      name: "Heading",
    }) as HTMLTextAreaElement;
    // A textarea, not a single-line input, so a long heading wraps like the published
    // heading instead of scrolling out of view.
    expect(input.tagName).toBe("TEXTAREA");
    expect(input.getAttribute("data-level")).toBe("2");
    fireEvent.change(input, { target: { value: "Tonight on NJ PBS" } });
    expect(
      (screen.getByRole("textbox", { name: "Heading" }) as HTMLTextAreaElement)
        .value,
    ).toBe("Tonight on NJ PBS");
  });

  it("keeps a headline to one logical line by suppressing Enter", () => {
    render(<BlockEditor section="home" newId={counterIds()} />);
    addBlock("heading");
    const input = screen.getByRole("textbox", { name: "Heading" });
    const enter = createEvent.keyDown(input, { key: "Enter" });
    fireEvent(input, enter);
    expect(enter.defaultPrevented).toBe(true);
  });

  it("normalizes pasted newlines so the saved headline matches what publishes", () => {
    const onSave = vi.fn();
    render(<BlockEditor section="home" newId={counterIds()} onSave={onSave} />);
    addBlock("heading");
    const input = screen.getByRole("textbox", {
      name: "Heading",
    }) as HTMLTextAreaElement;
    // A paste reaches onChange with the pasted value and no keydown, so the Enter guard never
    // runs. The write boundary strips the break itself; otherwise the pre-wrap textarea shows
    // two lines while the published <hN> collapses them to one.
    fireEvent.change(input, { target: { value: "Tonight on\r\n\r\nNJ PBS" } });
    expect(
      (screen.getByRole("textbox", { name: "Heading" }) as HTMLTextAreaElement)
        .value,
    ).toBe("Tonight on NJ PBS");
    savePage();
    expect(onSave).toHaveBeenCalledWith([
      expect.objectContaining({
        data: expect.objectContaining({ text: "Tonight on NJ PBS" }),
      }),
    ]);
  });

  it("changes a headline level from its settings control", () => {
    const onSave = vi.fn();
    render(<BlockEditor section="home" newId={counterIds()} onSave={onSave} />);
    addBlock("heading");
    fireEvent.change(screen.getByRole("textbox", { name: "Heading" }), {
      target: { value: "Tonight on NJ PBS" },
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Edit heading 1" }),
    );
    const level = screen.getByLabelText("Heading level") as HTMLSelectElement;
    expect(level.value).toBe("2");
    fireEvent.change(level, { target: { value: "1" } });

    expect(
      screen
        .getByRole("textbox", { name: "Heading" })
        .getAttribute("data-level"),
    ).toBe("1");
    savePage();
    expect(onSave).toHaveBeenCalledWith([
      expect.objectContaining({
        data: { text: "Tonight on NJ PBS", level: 1 },
      }),
    ]);
  });

  it("saves a stored headline level as the value the editor displays", () => {
    const onSave = vi.fn();
    const stored: AdminBlock[] = [
      {
        id: "h1",
        type: "headline",
        order: 0,
        visible: true,
        data: { text: "Tonight on NJ PBS", level: 9 },
      },
    ];
    render(
      <BlockEditor
        section="home"
        initialBlocks={stored}
        newId={counterIds()}
        onSave={onSave}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Edit heading 1" }),
    );
    expect(
      (screen.getByLabelText("Heading level") as HTMLSelectElement).value,
    ).toBe("6");
    savePage();

    expect(onSave).toHaveBeenCalledWith([
      expect.objectContaining({
        id: "h1",
        data: { text: "Tonight on NJ PBS", level: 6 },
      }),
    ]);
    expect(stored[0].data.level).toBe(9);
  });

  it("disables Undo until there is something to undo", () => {
    render(<BlockEditor section="home" newId={counterIds()} />);
    expect(
      (screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    addBlock("heading");
    expect(
      (screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("undoes a field edit rather than reaching past it to a structural op (#582)", () => {
    // A divider (no rich-text field, so no second Undo control) is the structural op sitting under
    // a later field edit on the heading.
    const { container } = render(
      <BlockEditor section="home" newId={counterIds()} />,
    );
    addBlock("heading");
    addBlock("divider");
    editBlock("Edit heading 1");
    fireEvent.change(screen.getByRole("textbox", { name: "Heading" }), {
      target: { value: "Tonight on NJ PBS" },
    });

    // Undo reverses the typing. Before #582 it removed the divider and left the heading text.
    doneEditing();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    editBlock("Edit heading 1");
    expect(
      (screen.getByRole("textbox", { name: "Heading" }) as HTMLTextAreaElement)
        .value,
    ).toBe("");
    expect(kindsInOrder(container)).toEqual(["heading", "divider"]);
  });

  it("undoes a visibility toggle rather than reaching past it (#582)", () => {
    const { container } = render(
      <BlockEditor section="home" newId={counterIds()} />,
    );
    addBlock("heading");
    addBlock("divider");
    fireEvent.click(
      screen.getByRole("button", { name: /^Hide from page: divider 2/ }),
    );
    expect(screen.getByText("Hidden from page")).toBeTruthy();

    // Undo restores visibility; it does not remove the block the earlier insert added.
    doneEditing();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(kindsInOrder(container)).toEqual(["heading", "divider"]);
    expect(screen.queryByText("Hidden from page")).toBeNull();
  });
});

describe("BlockEditor save boundary", () => {
  it("disables portaled page actions while the editor is read-only", () => {
    const target = document.createElement("div");
    document.body.append(target);
    const view = render(
      <WorkspaceActionsProvider target={target}>
        <BlockEditor
          section="home"
          initialBlocks={longPageBlocks()}
          onSave={vi.fn()}
        />
      </WorkspaceActionsProvider>,
    );

    editBlock("Edit heading 1");
    fireEvent.change(screen.getByRole("textbox", { name: "Heading" }), {
      target: { value: "Tonight on NJ PBS News" },
    });
    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();

    view.rerender(
      <WorkspaceActionsProvider target={target}>
        <BlockEditor
          section="home"
          initialBlocks={longPageBlocks()}
          onSave={vi.fn()}
          readOnly
        />
      </WorkspaceActionsProvider>,
    );

    expect(screen.getByRole("button", { name: "Save page" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
    target.remove();
  });

  it("freezes block controls and fields while an external revision restore is in flight", () => {
    const onDraftChange = vi.fn();
    const view = render(
      <BlockEditor
        section="home"
        initialBlocks={longPageBlocks()}
        onDraftChange={onDraftChange}
        onSave={vi.fn()}
      />,
    );

    editBlock("Edit heading 1");
    const heading = screen.getByRole("textbox", { name: "Heading" });
    view.rerender(<BlockEditor section="home" initialBlocks={longPageBlocks()}
      onDraftChange={onDraftChange} onSave={vi.fn()} readOnly />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Edit heading 1" })).toBeDisabled();

    for (const trigger of screen.getAllByRole("button", {
      name: /Add content: position/,
    })) {
      expect(trigger).toBeDisabled();
    }
    expect(screen.getByRole("button", { name: "Save page" })).toBeDisabled();
    expect(heading).toBeDisabled();
    expect(screen.getByText(/restoring this version/i)).toBeInTheDocument();
    fireEvent.change(heading, {
      target: { value: "Discarded edit" },
    });
    expect(heading).toHaveValue(
      "Tonight on NJ PBS",
    );
    expect(onDraftChange).not.toHaveBeenCalled();
  });

  it("refuses to save a page with an empty required block and marks the block", () => {
    const onSave = vi.fn();
    render(<BlockEditor section="home" newId={counterIds()} onSave={onSave} />);
    addBlock("heading");
    savePage();
    expect(onSave).not.toHaveBeenCalled();
    // Structure is valid (one heading is allowed on home), so the refusal is about the
    // block's own empty required field, marked on the card and summarized above the list.
    expect(screen.getByText("Heading is required.")).toBeTruthy();
    expect(screen.getByText(/Fix the highlighted blocks/)).toBeTruthy();
    const heading = screen.getByRole("textbox", { name: "Heading" });
    expect(heading.getAttribute("aria-required")).toBe("true");
    expect(heading.getAttribute("aria-invalid")).toBe("true");
    expect(
      document.getElementById(heading.getAttribute("aria-describedby")!),
    ).toHaveTextContent("Heading is required.");
  });

  it("saves the page once every required block field is filled", () => {
    const onSave = vi.fn();
    render(<BlockEditor section="home" newId={counterIds()} onSave={onSave} />);
    addBlock("heading");
    fireEvent.change(screen.getByRole("textbox", { name: "Heading" }), {
      target: { value: "Tonight on NJ PBS" },
    });
    savePage();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Saved.")).toBeTruthy();
  });

  it("refuses to save a page whose stored block payload is type-invalid (#513)", () => {
    const onSave = vi.fn();
    // A headline whose level is a string, not a number: structurally placed with its
    // required text filled, so validateSection and the required-field check both pass. Only
    // the model parser catches the bad payload. Such a block cannot be built from the
    // editor's typed inputs; it can only arrive through initialBlocks -- a stored block
    // opened for editing whose shape has drifted from the model. The save boundary must run
    // parseBlocks and refuse rather than report the drift as Saved.
    const drifted: AdminBlock[] = [
      {
        id: "h1",
        type: "headline",
        order: 0,
        visible: true,
        data: { text: "Tonight on NJ PBS", level: "two" },
      },
    ];
    render(
      <BlockEditor
        section="home"
        newId={counterIds()}
        initialBlocks={drifted}
        onSave={onSave}
      />,
    );
    savePage();
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.queryByText("Saved.")).toBeNull();
    expect(
      screen.getByText(/doesn't match the saved block format/i),
    ).toBeTruthy();
  });

  it("clears the save-error banner once the editor starts fixing a flagged block", () => {
    render(
      <BlockEditor section="home" newId={counterIds()} onSave={() => {}} />,
    );
    addBlock("heading");
    savePage();
    expect(screen.getByText(/Fix the highlighted blocks/)).toBeTruthy();
    // Editing the block clears the banner together with the markers it points at, rather
    // than leaving it accusing a page that no longer has anything highlighted.
    fireEvent.change(screen.getByRole("textbox", { name: "Heading" }), {
      target: { value: "Tonight" },
    });
    expect(screen.queryByText(/Fix the highlighted blocks/)).toBeNull();
    expect(screen.queryByText("Heading is required.")).toBeNull();
  });

  it("keeps the other blocks flagged when only one of several is fixed", () => {
    render(
      <BlockEditor section="home" newId={counterIds()} onSave={() => {}} />,
    );
    addBlock("heading");
    addBlock("text");
    savePage();
    // Both empty required blocks are flagged and the banner is up.
    expect(screen.getByText("Heading is required.")).toBeTruthy();
    expect(screen.getByText("Body is required.")).toBeTruthy();
    expect(screen.getByText(/Fix the highlighted blocks/)).toBeTruthy();
    editBlock("Edit text 2");
    expect(
      screen
        .getByRole("textbox", { name: "Body" })
        .getAttribute("aria-invalid"),
    ).toBe("true");
    // Fixing only the heading must not wipe the text block's marker: editing one block
    // changes the whole list reference, so a blanket clear would drop every marker and the
    // editor would lose sight of the still-empty body until the next save attempt. Constrain
    // Constrain the match to the inline heading so the prose toolbar's heading controls
    // are not caught too.
    editBlock("Edit heading 1");
    fireEvent.change(screen.getByRole("textbox", { name: "Heading" }), {
      target: { value: "Tonight on NJ PBS" },
    });
    expect(screen.queryByText("Heading is required.")).toBeNull();
    expect(screen.getByText("Body is required.")).toBeTruthy();
    // The banner stays up because a block is still flagged, and it can never disagree with
    // the markers because it is derived from them.
    expect(screen.getByText(/Fix the highlighted blocks/)).toBeTruthy();
  });
});

describe("BlockEditor async persist", () => {
  it("reconciles canonical ids by minted id instead of response position (#900)", async () => {
    const calls: AdminBlock[][] = [];
    const onSave = vi.fn(async (blocks: AdminBlock[]) => {
      calls.push(blocks);
      return {
        // A server transform may return persisted blocks in a different order. The explicit
        // map, not this array position, identifies which live block received each canonical id.
        blocks: [...blocks]
          .reverse()
          .map((block) => ({ ...block, id: `srv-${block.id}` })),
        mintedIds: Object.fromEntries(
          blocks.map((block) => [block.id, `srv-${block.id}`]),
        ),
      };
    });
    render(<BlockEditor section="home" newId={counterIds()} onSave={onSave} />);
    addBlock("heading");
    fireEvent.change(screen.getByRole("textbox", { name: "Heading" }), {
      target: { value: "Tonight on NJ PBS" },
    });
    addBlock("divider");

    savePage();
    expect(await screen.findByText("Saved.")).toBeTruthy();
    savePage();
    await waitFor(() => expect(calls).toHaveLength(2));

    expect(calls[1].map((block) => block.id)).toEqual(["srv-b1", "srv-b2"]);
    expect(calls[1].map((block) => block.type)).toEqual([
      "headline",
      "divider",
    ]);
  });

  it("adopts the server's canonical block ids after an async save (#515)", async () => {
    // The save returns the same block under a server-minted id. The editor adopts it, so a
    // second save sends the canonical id, not the temporary client one.
    const calls: AdminBlock[][] = [];
    const onSave = vi.fn(async (blocks: AdminBlock[]) => {
      calls.push(blocks);
      return {
        blocks: blocks.map((block) => ({ ...block, id: `srv-${block.id}` })),
        mintedIds: Object.fromEntries(
          blocks.map((block) => [block.id, `srv-${block.id}`]),
        ),
      };
    });
    render(<BlockEditor section="home" newId={counterIds()} onSave={onSave} />);
    addBlock("heading");
    fireEvent.change(screen.getByRole("textbox", { name: "Heading" }), {
      target: { value: "Tonight on NJ PBS" },
    });

    savePage();
    // The confirmation only appears once the async save resolves and its ids are adopted.
    expect(await screen.findByText("Saved.")).toBeTruthy();
    expect(calls[0][0].id).toBe("b1");

    // Saving again sends the adopted server id, proving the id was taken as the new baseline
    // rather than the editor re-sending its client-minted id.
    savePage();
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1][0].id).toBe("srv-b1");
  });

  it("surfaces the server's message when an async save is rejected and does not confirm", async () => {
    const onSave = vi.fn(async () => {
      throw new Error(
        "Save cannot publish a document; publishing is a separate action",
      );
    });
    render(<BlockEditor section="home" newId={counterIds()} onSave={onSave} />);
    addBlock("heading");
    fireEvent.change(screen.getByRole("textbox", { name: "Heading" }), {
      target: { value: "Tonight on NJ PBS" },
    });

    savePage();
    expect(
      await screen.findByText(/Save cannot publish a document/),
    ).toBeTruthy();
    expect(screen.queryByText("Saved.")).toBeNull();
    // The block stays in the editor so the save can be retried from the same content.
    editBlock("Edit heading 1");
    expect(screen.getByRole("textbox", { name: "Heading" })).toBeTruthy();
  });

  it("relabels and guards the button while an async save is in flight", async () => {
    let resolveSave: (result: {
      blocks: AdminBlock[];
      mintedIds: Record<string, string>;
    }) => void = () => {};
    const pending = new Promise<{
      blocks: AdminBlock[];
      mintedIds: Record<string, string>;
    }>((resolve) => {
      resolveSave = resolve;
    });
    let captured: AdminBlock[] = [];
    const onSave = vi.fn((blocks: AdminBlock[]) => {
      captured = blocks;
      return pending;
    });
    render(<BlockEditor section="home" newId={counterIds()} onSave={onSave} />);
    addBlock("heading");
    fireEvent.change(screen.getByRole("textbox", { name: "Heading" }), {
      target: { value: "Tonight on NJ PBS" },
    });

    savePage();
    const saving = (await screen.findByRole("button", {
      name: /^.+: Saving…$/,
    })) as HTMLButtonElement;
    expect(saving.disabled).toBe(false);
    expect(saving).toHaveAttribute("aria-disabled", "true");
    expect(saving).toHaveAttribute("aria-busy", "true");
    expect(saving.querySelector(".activity-indicator")).toBeInTheDocument();
    expect(screen.getByText("Saving page.", { selector: '[role="status"]' })).toBeInTheDocument();
    fireEvent.click(saving);
    expect(onSave).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSave({
        blocks: captured.map((block) => ({ ...block, id: `srv-${block.id}` })),
        mintedIds: Object.fromEntries(
          captured.map((block) => [block.id, `srv-${block.id}`]),
        ),
      });
      await pending;
    });
    expect(await screen.findByText("Saved.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save page" })).toBeTruthy();
  });

  it("keeps edits made while an async save is in flight instead of adopting over them", async () => {
    // The editor stays editable during a save. Adding a block before the save resolves must
    // survive: adopting the server's response to the older one-block snapshot would silently
    // discard it.
    let resolveSave: () => void = () => {};
    const onSave = vi.fn(
      (blocks: AdminBlock[]) =>
        new Promise<{
          blocks: AdminBlock[];
          mintedIds: Record<string, string>;
        }>((resolve) => {
          // Resolve with the server's answer to the SENT snapshot (one block).
          resolveSave = () =>
            resolve({
              blocks: blocks.map((block) => ({
                ...block,
                id: `srv-${block.id}`,
              })),
              mintedIds: Object.fromEntries(
                blocks.map((block) => [block.id, `srv-${block.id}`]),
              ),
            });
        }),
    );
    const { container } = render(
      <BlockEditor section="home" newId={counterIds()} onSave={onSave} />,
    );
    addBlock("heading");
    fireEvent.change(screen.getByRole("textbox", { name: "Heading" }), {
      target: { value: "First" },
    });

    savePage();
    // While the save is pending, add a second block.
    expect(await screen.findByRole("button", { name: /^.+: Saving…$/ })).toBeTruthy();
    addBlock("divider");

    await act(async () => {
      resolveSave();
    });

    // The divider added during the save is still there: the stale one-block response was not
    // adopted over it.
    expect(kindsInOrder(container)).toEqual(["heading", "divider"]);
    // The live content differs from what was persisted, so the save is not confirmed.
    expect(screen.queryByText("Saved.")).toBeNull();
    // Only the pre-save snapshot was sent to the server.
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]![0]).toHaveLength(1);

    // Saving again proves the saved block took its stable server id (srv-b1) while the block
    // added in flight kept its temporary id (b2) to be minted on this save (#515) — the id
    // did not churn back to a temporary one.
    savePage();
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave.mock.calls[1]![0].map((block) => block.id)).toEqual([
      "srv-b1",
      "b2",
    ]);
  });
});

describe("BlockEditor component fields", () => {
  it("renders prose in its component dialog and saves edits", async () => {
    const onSave = vi.fn();
    render(<BlockEditor section="home" newId={counterIds()} onSave={onSave} />);
    addBlock("text");

    const prose = screen.getByRole("textbox", { name: "Body" });
    expect(prose.closest(".inline-prose")).toBeTruthy();
    expect(prose.closest(".editor-field")).toBeNull();

    await act(async () => {
      prose.innerHTML = "<p>Local stories, edited in place.</p>";
      fireEvent.input(prose);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    savePage();

    expect(onSave).toHaveBeenCalledTimes(1);
    const savedBlocks = onSave.mock.calls[0][0];
    expect(JSON.stringify(savedBlocks[0].data.content)).toContain(
      "Local stories, edited in place.",
    );
    expect(screen.queryByRole("toolbar", { name: "Formatting for Body" })).toBeNull();
    editBlock("Edit text 1");
    fireEvent.focus(prose);
    expect(screen.getByRole("toolbar", { name: "Formatting for Body" })).toBeTruthy();
  });

  it("offers link card conversion on pages and posts but not inside rows", () => {
    const convertibleProse: AdminBlock = {
      id: "prose-1",
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
                text: "Story",
                marks: [{ type: "link", attrs: { href: "https://example.com/story" } }],
              },
              { type: "text", text: " — Outlet — Jan. 2, 2026" },
            ],
          }],
        },
      },
    };
    render(
      <BlockEditor
        section="genericPage"
        initialBlocks={[convertibleProse]}
        newId={counterIds()}
      />,
    );
    editBlock("Edit text 1");
    expect(screen.getByRole("button", { name: "Turn into link cards" })).toBeTruthy();
    cleanup();

    render(
      <BlockEditor
        section="post"
        initialBlocks={[convertibleProse]}
        newId={counterIds()}
      />,
    );
    editBlock("Edit text 1");
    expect(screen.getByRole("button", { name: "Turn into link cards" })).toBeTruthy();
    cleanup();

    render(
      <BlockEditor
        section="genericPage"
        initialBlocks={[
          {
            id: "coverage-1",
            type: "coverage_list",
            order: 0,
            visible: true,
            data: { entries: [] },
          },
          { ...convertibleProse, id: "prose-2", order: 1 },
        ]}
        newId={counterIds()}
      />,
    );
    editBlock("Edit text 2");
    expect(screen.getByRole("button", { name: "Turn into link cards" })).toBeTruthy();
    cleanup();

    render(
      <BlockEditor
        section="genericPage"
        initialBlocks={[
          createBlock("row", "row-1"),
          { ...convertibleProse, id: "row-prose", order: 1, layout: { rowId: "row-1", column: 0 } },
        ]}
        newId={counterIds()}
      />,
    );
    editBlock("Edit text 2");
    expect(screen.queryByRole("button", { name: "Turn into link cards" })).toBeNull();
  });

  it("renders a divider through the canonical rule markup", () => {
    const { container } = render(
      <BlockEditor section="home" newId={counterIds()} />,
    );
    addBlock("divider");
    expect(container.querySelector(".inline-divider hr")).toBeTruthy();
  });

  it("edits an image's asset id, alt text, and caption in its dialog", () => {
    const onSave = vi.fn();
    const { container } = render(
      <BlockEditor section="home" newId={counterIds()} onSave={onSave} />,
    );
    addBlock("image");

    const assetId = screen.getByRole("textbox", { name: "Image" });
    const alt = screen.getByRole("textbox", { name: "Alt text" });
    const caption = screen.getByRole("textbox", { name: "Caption" });
    expect(assetId.closest(".inline-image")).toBeTruthy();
    expect(assetId.closest(".editor-field")).toBeNull();
    expect(assetId.getAttribute("placeholder")).toBe("Asset id");
    expect(
      container.querySelector(".inline-image-frame")?.textContent,
    ).toContain("No asset selected");

    fireEvent.change(assetId, { target: { value: "asset-42" } });
    fireEvent.change(alt, {
      target: { value: "A host standing beside the Delaware River" },
    });
    fireEvent.change(caption, { target: { value: "Reporting from Camden" } });
    expect(
      container.querySelector(".inline-image-frame")?.textContent,
    ).toContain("asset-42");

    savePage();
    expect(onSave).toHaveBeenCalledWith([
      expect.objectContaining({
        data: {
          assetId: "asset-42",
          alt: "A host standing beside the Delaware River",
          altDecorative: false,
          caption: "Reporting from Camden",
          href: "",
          newTab: false,
        },
      }),
    ]);

    // Nothing about this block is settled anywhere but its own surface, so no Settings control
    // is offered (#1043).
    expect(
      screen.queryByRole("button", { name: "Settings: image 1" }),
    ).toBeNull();
  });

  it("chooses an image from station media and requires contextual alt text", async () => {
    const onSave = vi.fn();
    const loadMedia = vi.fn().mockResolvedValue({
      success: true,
      records: [pickerImage],
      total: 1,
      allCount: 1,
      page: 1,
      pageCount: 1,
      categoryCounts: { news: 1 },
      kindCounts: { image: 1, document: 0 },
    });
    render(
      <BlockEditor
        section="home"
        newId={counterIds()}
        onSave={onSave}
        loadMedia={loadMedia}
      />,
    );
    addBlock("image");

    expect(screen.queryByPlaceholderText("Asset id")).not.toBeInTheDocument();
    const chooseImage = screen.getByRole("button", { name: "Choose image" });
    savePage();
    const imageSelection = screen.getByRole("textbox", { name: "Image" });
    expect(imageSelection).toHaveAttribute("aria-invalid", "true");
    expect(imageSelection).toHaveAttribute("aria-describedby");

    fireEvent.click(chooseImage);
    fireEvent.click(await screen.findByRole("button", { name: /^News desk/ }));

    expect(
      screen.getByText("Suggestion: A presenter at the news desk"),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Use suggestion" }));
    savePage();

    expect(onSave).toHaveBeenCalledWith([
      expect.objectContaining({
        data: {
          assetId: "asset-news-desk",
          alt: "A presenter at the news desk",
          altDecorative: false,
          caption: "",
          href: "",
          newTab: false,
        },
      }),
    ]);
  });

  it("chooses an optional card image from station media without a raw asset id", async () => {
    const onSave = vi.fn();
    const loadMedia = vi.fn().mockResolvedValue({
      success: true,
      records: [pickerImage],
      total: 1,
      allCount: 1,
      page: 1,
      pageCount: 1,
      categoryCounts: { news: 1 },
      kindCounts: { image: 1, document: 0 },
    });
    render(
      <BlockEditor
        section="home"
        newId={counterIds()}
        onSave={onSave}
        loadMedia={loadMedia}
      />,
    );
    addBlock("card set");
    fireEvent.click(screen.getByRole("button", { name: "Add card" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Card title 1" }), {
      target: { value: "Tonight on NJ PBS" },
    });

    expect(screen.queryByPlaceholderText("Asset id")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Choose card image 1" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: /^News desk/ }));
    expect(screen.getByText("News desk")).toBeVisible();

    savePage();
    expect(onSave).toHaveBeenCalledWith([
      expect.objectContaining({
        data: expect.objectContaining({
          cards: [
            expect.objectContaining({
              title: "Tonight on NJ PBS",
              imageAssetId: "asset-news-desk",
            }),
          ],
        }),
      }),
    ]);
  });

  it("hydrates a saved image summary and alt-text suggestion", async () => {
    const image: AdminBlock = {
      id: "image-1",
      type: "image",
      order: 0,
      visible: true,
      data: { assetId: pickerImage.id, alt: "", caption: "" },
    };
    const loadMedia = vi.fn().mockResolvedValue({
      success: true,
      records: [pickerImage],
      total: 1,
      allCount: 1,
      page: 1,
      pageCount: 1,
      categoryCounts: { news: 1 },
      kindCounts: { image: 1, document: 0 },
    });

    const { container } = render(
      <BlockEditor
        section="home"
        initialBlocks={[image]}
        newId={counterIds()}
        loadMedia={loadMedia}
      />,
    );

    editBlock("Edit image 1");
    expect(await screen.findByDisplayValue("News desk")).toBeVisible();
    expect(
      container.querySelector(
        '.inline-image-frame img[src="https://media.njpbs.org/news-desk.png"]',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("Suggestion: A presenter at the news desk"),
    ).toBeVisible();
    expect(loadMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        q: "",
        assetIds: [pickerImage.id],
        kinds: ["image"],
        page: 1,
      }),
      { signal: expect.any(AbortSignal) },
    );
  });

  it("hydrates a saved card image summary", async () => {
    const cardGrid: AdminBlock = {
      id: "cards-1",
      type: "card_grid",
      order: 0,
      visible: true,
      data: {
        cards: [
          {
            title: "Tonight",
            imageAssetId: pickerImage.id,
            href: "/watch/",
          },
        ],
      },
    };
    const loadMedia = vi.fn().mockResolvedValue({
      success: true,
      records: [pickerImage],
      total: 1,
      allCount: 1,
      page: 1,
      pageCount: 1,
      categoryCounts: { news: 1 },
      kindCounts: { image: 1, document: 0 },
    });

    const { container } = render(
      <BlockEditor
        section="home"
        initialBlocks={[cardGrid]}
        newId={counterIds()}
        loadMedia={loadMedia}
      />,
    );

    editBlock("Edit card set 1");
    expect(await screen.findByText("News desk")).toBeVisible();
    expect(
      container.querySelector(
        '.inline-card-image-frame img[src="https://media.njpbs.org/news-desk.png"]',
      ),
    ).toBeTruthy();
    expect(loadMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        q: "",
        assetIds: [pickerImage.id],
        kinds: ["image"],
        page: 1,
      }),
      { signal: expect.any(AbortSignal) },
    );
  });

  it("uses the media picker for image gallery items", async () => {
    const loadMedia = vi.fn().mockResolvedValue({
      success: true,
      records: [pickerImage],
      total: 1,
      allCount: 1,
      page: 1,
      pageCount: 1,
      categoryCounts: { news: 1 },
      kindCounts: { image: 1, document: 0 },
    });
    render(
      <BlockEditor section="home" newId={counterIds()} loadMedia={loadMedia} />,
    );
    addBlock("image gallery");
    fireEvent.click(screen.getByRole("button", { name: "Add image" }));

    expect(screen.queryByPlaceholderText("Asset id")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Choose image" }));
    fireEvent.click(await screen.findByRole("button", { name: /^News desk/ }));

    expect(screen.getByDisplayValue("News desk")).toBeVisible();
  });

  it("keeps an unsaved Post image draft while inline upload commits and selects", async () => {
    const loadMedia = vi
      .fn()
      .mockResolvedValueOnce({
        success: true as const,
        records: [pickerImage],
        total: 1,
        allCount: 1,
        page: 1,
        pageCount: 1,
        categoryCounts: { news: 1 },
        kindCounts: { image: 1, document: 0 },
      })
      .mockResolvedValue({
        success: true as const,
        records: [pickerImage],
        total: 1,
        allCount: 1,
        page: 1,
        pageCount: 1,
        categoryCounts: { news: 1 },
        kindCounts: { image: 1, document: 0 },
      });
    const uploadMedia = vi.fn().mockResolvedValue({
      success: true as const,
      asset: pickerImage,
    });
    const onDraftChange = vi.fn();
    const imageBlock: AdminBlock = {
      id: "post-image",
      type: "image",
      order: 0,
      visible: true,
      data: {
        assetId: "",
        alt: "",
        altDecorative: true,
        caption: "Draft caption",
      },
    };
    render(
      <BlockEditor
        section="post"
        initialBlocks={[imageBlock]}
        loadMedia={loadMedia}
        uploadMedia={uploadMedia}
        mediaCategories={pickerCategories}
        defaultUploadCategory="news"
        canUploadCategory={() => true}
        onDraftChange={onDraftChange}
      />,
    );

    editBlock("Edit image 1");
    fireEvent.change(screen.getByRole("textbox", { name: "Caption" }), {
      target: { value: "Unsaved field report caption" },
    });
    onDraftChange.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Choose image" }));
    await screen.findByRole("button", { name: /^News desk/ });
    fireEvent.click(screen.getByRole("button", { name: "Upload image" }));
    fireEvent.change(screen.getByLabelText(/File/), {
      target: {
        files: [
          new File(["image bytes"], "news-desk.png", {
            type: "image/png",
          }),
        ],
      },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "License" }), {
      target: { value: "NJ PBS owned" },
    });
    expect(onDraftChange).not.toHaveBeenCalled();
    fireEvent.submit(
      screen.getByRole("button", { name: "Upload" }).closest("form")!,
    );

    expect(
      await screen.findByDisplayValue("Unsaved field report caption"),
    ).toBeVisible();
    expect(screen.getByDisplayValue("News desk")).toBeVisible();
    expect(
      screen.getByRole("checkbox", { name: "Mark as decorative" }),
    ).not.toBeChecked();
    expect(
      screen.getByText("Suggestion: A presenter at the news desk"),
    ).toBeVisible();
    expect(onDraftChange).toHaveBeenLastCalledWith([
      expect.objectContaining({
        data: {
          assetId: pickerImage.id,
          alt: "",
          altDecorative: false,
          caption: "Unsaved field report caption",
        },
      }),
    ]);
  });

  it("offers the same inline upload path for a Post gallery image", async () => {
    const loadMedia = vi.fn().mockResolvedValue({
      success: true as const,
      records: [pickerImage],
      total: 1,
      allCount: 1,
      page: 1,
      pageCount: 1,
      categoryCounts: { news: 1 },
      kindCounts: { image: 1, document: 0 },
    });
    const uploadMedia = vi.fn().mockResolvedValue({
      success: true as const,
      asset: pickerImage,
    });
    render(
      <BlockEditor
        section="post"
        newId={counterIds()}
        loadMedia={loadMedia}
        uploadMedia={uploadMedia}
        mediaCategories={pickerCategories}
        defaultUploadCategory="news"
        canUploadCategory={() => true}
      />,
    );
    addBlock("image gallery");
    fireEvent.click(screen.getByRole("button", { name: "Add image" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose image" }));
    await screen.findByRole("button", { name: /^News desk/ });
    fireEvent.click(screen.getByRole("button", { name: "Upload image" }));
    fireEvent.change(screen.getByLabelText(/File/), {
      target: {
        files: [
          new File(["image bytes"], "news-desk.png", {
            type: "image/png",
          }),
        ],
      },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "License" }), {
      target: { value: "NJ PBS owned" },
    });
    fireEvent.submit(
      screen.getByRole("button", { name: "Upload" }).closest("form")!,
    );

    expect(await screen.findByDisplayValue("News desk")).toBeVisible();
  });

  it("saves an image with empty alt text after a warning, and refuses one that is described and decorative", () => {
    // Empty alt text warns and never blocks (#242). Marking an image decorative and
    // describing it are still opposite claims, so that pair is refused.
    const onSave = vi.fn();
    render(<BlockEditor section="home" newId={counterIds()} onSave={onSave} />);
    addBlock("image");
    fireEvent.change(screen.getByRole("textbox", { name: "Image" }), {
      target: { value: "asset-42" },
    });
    const alt = screen.getByRole("textbox", { name: "Alt text" });
    expect(alt.getAttribute("aria-required")).toBeNull();
    expect(
      document.getElementById(alt.getAttribute("aria-describedby")!),
    ).toHaveTextContent("Alt text is empty.");

    savePage();
    expect(onSave).toHaveBeenCalledWith([
      expect.objectContaining({
        data: expect.objectContaining({ assetId: "asset-42", alt: "" }),
      }),
    ]);
    onSave.mockClear();

    editBlock("Edit image 1");
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Mark as decorative" }),
    );
    // The preview stops announcing itself as an image, matching what the published page
    // will do with an empty alt.
    expect(screen.queryByRole("img")).toBeNull();
    savePage();
    expect(onSave).toHaveBeenCalledWith([
      expect.objectContaining({
        data: {
          assetId: "asset-42",
          alt: "",
          altDecorative: true,
          caption: "",
          href: "",
          newTab: false,
        },
      }),
    ]);

    onSave.mockClear();
    editBlock("Edit image 1");
    fireEvent.change(screen.getByRole("textbox", { name: "Alt text" }), {
      target: { value: "A host beside the Delaware River" },
    });
    savePage();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("keeps marking a contradictory image after it is hidden", () => {
    // Hiding a block exempts it from completeness, which gates nothing while it is hidden.
    // The contradiction is different: parseBlocks refuses it either way, so exempting it
    // would turn a marked field into a page-wide format error naming no block, on the one
    // card the editor is least likely to reopen.
    const onSave = vi.fn();
    render(<BlockEditor section="home" newId={counterIds()} onSave={onSave} />);
    addBlock("image");
    fireEvent.change(screen.getByRole("textbox", { name: "Image" }), {
      target: { value: "asset-42" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Alt text" }), {
      target: { value: "A host beside the Delaware River" },
    });
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Mark as decorative" }),
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Hide from page: image 1",
      }),
    );
    savePage();
    expect(onSave).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "Alt text must be empty while Mark as decorative is on.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText(
        "This page can't be saved because its content doesn't match the saved block format.",
      ),
    ).toBeNull();
  });

  it("stops marking a hidden image that is merely incomplete", () => {
    const onSave = vi.fn();
    render(<BlockEditor section="home" newId={counterIds()} onSave={onSave} />);
    addBlock("image");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Hide from page: image 1",
      }),
    );
    savePage();
    expect(onSave).toHaveBeenCalled();
  });

  it("marks the image's required inline control when save finds missing content", () => {
    render(
      <BlockEditor section="home" newId={counterIds()} onSave={() => {}} />,
    );
    addBlock("image");
    savePage();

    const input = screen.getByRole("textbox", { name: "Image" });
    expect(input.getAttribute("aria-required")).toBe("true");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(
      document.getElementById(input.getAttribute("aria-describedby")!),
    ).toHaveTextContent(/required/i);
    const alt = screen.getByRole("textbox", { name: "Alt text" });
    expect(alt.getAttribute("aria-required")).toBeNull();
    expect(alt.getAttribute("aria-invalid")).toBeNull();
  });

  it("warns about empty alt text without marking the image invalid", () => {
    const image: AdminBlock = {
      id: "image-1",
      type: "image",
      order: 0,
      visible: true,
      data: { assetId: "asset-42", alt: "", caption: "" },
    };
    render(
      <BlockEditor
        section="home"
        initialBlocks={[image]}
        newId={counterIds()}
        onSave={() => {}}
      />,
    );
    editBlock("Edit image 1");

    const assetId = screen.getByRole("textbox", { name: "Image" });
    const alt = screen.getByRole("textbox", { name: "Alt text" });
    expect(assetId.getAttribute("aria-invalid")).toBeNull();
    expect(assetId.getAttribute("aria-describedby")).toBeNull();
    expect(alt.getAttribute("aria-invalid")).toBeNull();
    expect(
      document.getElementById(alt.getAttribute("aria-describedby")!),
    ).toHaveTextContent("Alt text is empty.");
  });

  it("adds, edits, reorders, and removes gallery images in its dialog", () => {
    const onSave = vi.fn();
    const { container } = render(
      <BlockEditor section="home" newId={counterIds()} onSave={onSave} />,
    );
    addBlock("image gallery");

    const gallery = screen.getByRole("group", {
      name: "Image gallery (required)",
    });
    expect(gallery.closest(".inline-image-gallery")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add image" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Image 1" }), {
      target: { value: "asset-one" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Alt text 1" }), {
      target: { value: "The first image" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Caption 1" }), {
      target: { value: "First caption" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Add image" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Image 2" }), {
      target: { value: "asset-two" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Alt text 2" }), {
      target: { value: "The second image" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Caption 2" }), {
      target: { value: "Second caption" },
    });

    expect(within(gallery).queryByText(/^Up$/)).toBeNull();
    expect(within(gallery).queryByText(/^Down$/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Move up: image 2" }));
    expect(
      Array.from(
        container.querySelectorAll(
          ".inline-gallery-item .inline-image-asset-id",
        ),
      ).map((item) => item.textContent),
    ).toEqual(["Asset id: asset-two", "Asset id: asset-one"]);
    fireEvent.click(
      screen.getByRole("button", { name: "Remove image 2 from gallery" }),
    );

    savePage();
    expect(onSave).toHaveBeenCalledWith([
      expect.objectContaining({
        data: {
          images: [
            {
              assetId: "asset-two",
              alt: "The second image",
              altDecorative: false,
              caption: "Second caption",
      itemId: expect.any(String),
            },
          ],
        },
      }),
    ]);

    // The images themselves are edited on the block's own surface, but how the gallery is
    // presented publicly is settled in Settings, so that control is offered (#1043, #1034).
    expect(
      screen.getByRole("button", { name: "Edit image gallery 1" }),
    ).toBeTruthy();
  });

  it.each([1, 2, 12])(
    "uses native named controls with %i gallery items",
    (count) => {
      const loadMedia = vi.fn().mockResolvedValue({
        success: true,
        records: [pickerImage],
        total: 1,
        allCount: 1,
        page: 1,
        pageCount: 1,
        categoryCounts: { news: 1 },
        kindCounts: { image: 1, document: 0 },
      });
      const gallery: AdminBlock = {
        id: "gallery-containment",
        type: "image_gallery",
        order: 0,
        visible: true,
        data: {
          images: Array.from({ length: count }, (_, index) => ({
            assetId: pickerImage.id,
            alt: `Gallery image ${index + 1}`,
            altDecorative: false,
            caption: `Caption ${index + 1}`,
          })),
        },
      };

      const { container } = render(
        <BlockEditor
          section="post"
          initialBlocks={[gallery]}
          newId={counterIds()}
          loadMedia={loadMedia}
        />,
      );
      editBlock("Edit image gallery 1");
      const items = container.querySelectorAll(".inline-gallery-item");
      expect(items).toHaveLength(count);

      for (const [index, item] of Array.from(items).entries()) {
        const controls = within(item as HTMLElement);
        for (const button of [
          controls.getByRole("button", { name: "Change image" }),
          controls.getByRole("button", { name: "Remove image" }),
          controls.getByRole("button", { name: `Move up: image ${index + 1}` }),
          controls.getByRole("button", { name: `Move down: image ${index + 1}` }),
          controls.getByRole("button", {
            name: `Remove image ${index + 1} from gallery`,
          }),
        ]) {
          expect(button.tagName).toBe("BUTTON");
          expect(button).toHaveAttribute("type", "button");
          if (!button.hasAttribute("disabled")) {
            expect(button.tabIndex).toBeGreaterThanOrEqual(0);
          }
        }
      }
    },
  );

  it("marks an empty gallery and each missing image as required", () => {
    render(
      <BlockEditor section="home" newId={counterIds()} onSave={() => {}} />,
    );
    addBlock("image gallery");
    savePage();

    const gallery = screen.getByRole("group", {
      name: "Image gallery (required)",
    });
    expect(gallery.getAttribute("aria-invalid")).toBe("true");
    expect(
      document.getElementById(gallery.getAttribute("aria-describedby")!),
    ).toHaveTextContent("Images is required.");

    fireEvent.click(screen.getByRole("button", { name: "Add image" }));
    const image = screen.getByRole("textbox", { name: "Image 1" });
    expect(image.getAttribute("aria-required")).toBe("true");
    expect(image.getAttribute("aria-invalid")).toBe("true");
    expect(image.getAttribute("aria-describedby")).toBe(
      gallery.getAttribute("aria-describedby"),
    );
    const alt = screen.getByRole("textbox", { name: "Alt text 1" });
    expect(alt.getAttribute("aria-required")).toBeNull();
    expect(alt.getAttribute("aria-invalid")).toBeNull();
  });

  it("adds, edits, reorders, and removes site-styled buttons in its dialog", () => {
    const onSave = vi.fn();
    const { container } = render(
      <BlockEditor section="home" newId={counterIds()} onSave={onSave} />,
    );
    addBlock("buttons");

    const buttonGroup = screen.getByRole("group", {
      name: "Buttons (required)",
    });
    expect(buttonGroup.closest(".inline-cta-row")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add button" }));
    expect(
      (screen.getByLabelText("Button variant") as HTMLSelectElement).value,
    ).toBe("primary");
    fireEvent.change(screen.getByLabelText("Button label"), {
      target: { value: "Give" },
    });
    const firstLink = screen.getByLabelText("Button link") as HTMLInputElement;
    expect(firstLink.type).toBe("text");
    expect(firstLink.inputMode).toBe("url");
    fireEvent.change(firstLink, { target: { value: "/give/" } });

    fireEvent.click(screen.getByRole("button", { name: "Add button" }));
    fireEvent.change(screen.getByLabelText("Button label"), {
      target: { value: "Watch" },
    });
    fireEvent.change(screen.getByLabelText("Button link"), {
      target: { value: "/watch/" },
    });
    fireEvent.change(screen.getByLabelText("Button variant"), {
      target: { value: "secondary" },
    });

    expect(within(buttonGroup).queryByText(/^Up$/)).toBeNull();
    expect(within(buttonGroup).queryByText(/^Down$/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Move up: button 2" }));
    expect(
      Array.from(
        container.querySelectorAll(".inline-cta-row .cta-row .btn"),
      ).map((button) => button.textContent),
    ).toEqual(["Watch", "Give"]);

    // Clicking the rendered Give button opens that button's inline controls.
    fireEvent.click(screen.getByRole("button", { name: "Give" }));
    expect(
      (screen.getByLabelText("Button label") as HTMLInputElement).value,
    ).toBe("Give");
    fireEvent.click(screen.getByRole("button", { name: "Remove button 2" }));

    savePage();
    expect(onSave).toHaveBeenCalledWith([
      expect.objectContaining({
        data: {
          ctas: [{ label: "Watch", href: "/watch/", variant: "secondary" }],
        },
      }),
    ]);

    // Nothing about this block is settled anywhere but its own surface, so no Settings control
    // is offered (#1043).
    expect(
      screen.queryByRole("button", { name: "Settings: buttons 1" }),
    ).toBeNull();
  });

  it("announces an incomplete button row and its primary inline field", () => {
    render(
      <BlockEditor section="home" newId={counterIds()} onSave={() => {}} />,
    );
    addBlock("buttons");
    savePage();

    const group = screen.getByRole("group", { name: "Buttons (required)" });
    expect(group.getAttribute("aria-invalid")).toBe("true");
    expect(
      document.getElementById(group.getAttribute("aria-describedby")!),
    ).toHaveTextContent("Buttons is required.");

    fireEvent.click(screen.getByRole("button", { name: "Add button" }));
    const label = screen.getByLabelText("Button label");
    expect(label.getAttribute("aria-required")).toBe("true");
    expect(label.getAttribute("aria-invalid")).toBe("true");
    expect(label.getAttribute("aria-describedby")).toBe(
      group.getAttribute("aria-describedby"),
    );
  });

  it("refuses an unsafe button link and marks the exact inline field", () => {
    const onSave = vi.fn();
    const ctaRow: AdminBlock = {
      id: "cta-1",
      type: "cta_row",
      order: 0,
      visible: true,
      data: {
        ctas: [
          { label: "Watch", href: "javascript:alert(1)", variant: "primary" },
        ],
      },
    };
    render(
      <BlockEditor
        section="home"
        initialBlocks={[ctaRow]}
        newId={counterIds()}
        onSave={onSave}
      />,
    );

    savePage();

    expect(onSave).not.toHaveBeenCalled();
    const link = screen.getByLabelText("Button link");
    expect(link.getAttribute("aria-invalid")).toBe("true");
    expect(
      document.getElementById(link.getAttribute("aria-describedby")!),
    ).toHaveTextContent(
      "Button link must use http, https, mailto, tel, or a relative link.",
    );
  });

  it("opens and marks the first incomplete button instead of a valid sibling", () => {
    const ctaRow: AdminBlock = {
      id: "cta-1",
      type: "cta_row",
      order: 0,
      visible: true,
      data: {
        ctas: [
          { label: "Give", href: "/give/", variant: "primary" },
          { label: "", href: "/watch/", variant: "secondary" },
        ],
      },
    };
    render(
      <BlockEditor
        section="home"
        initialBlocks={[ctaRow]}
        newId={counterIds()}
        onSave={() => {}}
      />,
    );
    savePage();

    const label = screen.getByLabelText("Button label") as HTMLInputElement;
    const link = screen.getByLabelText("Button link") as HTMLInputElement;
    expect(label.value).toBe("");
    expect(link.value).toBe("/watch/");
    expect(label.getAttribute("aria-invalid")).toBe("true");
    expect(label.getAttribute("aria-describedby")).toBeTruthy();
    expect(link.getAttribute("aria-invalid")).toBeNull();
    expect(link.getAttribute("aria-describedby")).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Give" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    expect(
      screen
        .getByRole("button", { name: "Button 2" })
        .getAttribute("aria-expanded"),
    ).toBe("true");

    // Validation chooses the incomplete CTA as a fallback, but an editor can still
    // explicitly open a sibling while the error remains.
    fireEvent.click(screen.getByRole("button", { name: "Give" }));
    expect(
      (screen.getByLabelText("Button label") as HTMLInputElement).value,
    ).toBe("Give");
    expect(
      screen.getByLabelText("Button label").getAttribute("aria-invalid"),
    ).toBeNull();
  });

  it("advances to the next incomplete button after the open one is fixed", () => {
    // Two incomplete buttons: fixing the first must move the marker to the second while
    // the page error stands, not leave the remaining incomplete button unmarked (the
    // validation must track CTA edits, not only the first flip of the page error state).
    const ctaRow: AdminBlock = {
      id: "cta-1",
      type: "cta_row",
      order: 0,
      visible: true,
      data: {
        ctas: [
          { label: "", href: "/a/", variant: "primary" },
          { label: "", href: "/b/", variant: "primary" },
        ],
      },
    };
    render(
      <BlockEditor
        section="home"
        initialBlocks={[ctaRow]}
        newId={counterIds()}
        onSave={() => {}}
      />,
    );
    savePage();

    // The first incomplete button opens and its label is marked.
    expect(
      screen
        .getByRole("button", { name: "Button 1" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    fireEvent.change(screen.getByLabelText("Button label"), {
      target: { value: "Give" },
    });

    // The marker advances to the still-incomplete second button.
    expect(
      screen
        .getByRole("button", { name: "Give" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    expect(
      screen
        .getByRole("button", { name: "Button 2" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    const nextLabel = screen.getByLabelText("Button label") as HTMLInputElement;
    expect(nextLabel.value).toBe("");
    expect(nextLabel.getAttribute("aria-invalid")).toBe("true");
  });

  it("adds, edits, reorders, and removes cards inline", async () => {
    const onSave = vi.fn();
    const { container } = render(
      <BlockEditor section="home" newId={counterIds()} onSave={onSave} />,
    );
    addBlock("card set");
    const cards = screen.getByRole("group", { name: "Cards (required)" });
    expect(cards.closest(".inline-card-grid")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Add card" }));
    const firstTitle = screen.getByRole("textbox", { name: "Card title 1" });
    expect(firstTitle.closest("h2")).toHaveClass("card-grid__title");
    fireEvent.change(firstTitle, {
      target: { value: "First card" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Add card" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Card title 2" }), {
      target: { value: "Watch NJ PBS" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Card image 2" }), {
      target: { value: "watch-card" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Card label 2" }), {
      target: { value: "   " },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Card link 2" }), {
      target: { value: "/watch/" },
    });
    const body = screen.getByRole("textbox", { name: "Card text 2" });
    await act(async () => {
      body.innerHTML =
        "<h2>Card details</h2><p>Programs from across New Jersey.</p>";
      fireEvent.input(body);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(body.querySelector("h3")).not.toHaveClass("card-grid__title");

    expect(within(cards).queryByText(/^Up$/)).toBeNull();
    expect(within(cards).queryByText(/^Down$/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Move up: card 2" }));
    expect(
      Array.from(
        container.querySelectorAll<HTMLInputElement>(".inline-card-title"),
      ).map((input) => input.value),
    ).toEqual(["Watch NJ PBS", "First card"]);
    fireEvent.click(screen.getByRole("button", { name: "Remove card 2" }));

    savePage();
    expect(onSave).toHaveBeenCalledTimes(1);
    const savedCard = onSave.mock.calls[0][0][0].data.cards[0];
    expect(savedCard).not.toHaveProperty("label");
    expect(savedCard.title).toBe("Watch NJ PBS");
    expect(savedCard.imageAssetId).toBe("watch-card");
    expect(savedCard.href).toBe("/watch/");
    expect(JSON.stringify(savedCard.body)).toContain(
      "Programs from across New Jersey.",
    );

    // Nothing about this block is settled anywhere but its own surface, so no Settings control
    // is offered (#1043).
    expect(
      screen.queryByRole("button", { name: "Settings: card set 1" }),
    ).toBeNull();
  });

  it("shows temporary seed images in every populated page editor", () => {
    const cardGrid: AdminBlock = {
      id: "cards-1",
      type: "card_grid",
      order: 0,
      visible: true,
      data: {
        cards: [{ title: "Programs", imageAssetId: "launch-watch" }],
      },
    };
    const { container } = render(
      <BlockEditor
        pageId="schedule"
        section="home"
        initialBlocks={[cardGrid]}
        onSave={() => {}}
      />,
    );
    expect(container.querySelector(".inline-card-seed-image")).toHaveAttribute(
      "src",
      "https://njpbs.org/brand/spotlight/watch.jpg",
    );

    cleanup();
    const home = render(
      <BlockEditor
        pageId="home"
        section="home"
        initialBlocks={[
          {
            ...cardGrid,
            data: {
              cards: [{ title: "PBS Kids", imageAssetId: "home-start-kids" }],
            },
          },
        ]}
        onSave={() => {}}
      />,
    );
    expect(
      home.container.querySelector(".inline-card-seed-image"),
    ).toHaveAttribute("src", "https://njpbs.org/brand/starthere/kids.webp");

    cleanup();
    const watch = render(
      <BlockEditor
        pageId="watch"
        section="programLanding"
        initialBlocks={[cardGrid]}
        onSave={() => {}}
      />,
    );
    expect(
      watch.container.querySelector(".inline-card-seed-image"),
    ).toHaveAttribute("src", "https://njpbs.org/brand/spotlight/watch.jpg");
    editBlock("Edit card set 1");
    expect(screen.getByRole("textbox", { name: "Card image 1" })).toHaveValue(
      "launch-watch",
    );
  });

  it("nests generated card headings below the preceding authored section", () => {
    const heading: AdminBlock = {
      id: "heading-1",
      type: "headline",
      order: 0,
      visible: true,
      data: { text: "Programs", level: 2 },
    };
    const cardGrid: AdminBlock = {
      id: "cards-1",
      type: "card_grid",
      order: 1,
      visible: true,
      data: {
        cards: [
          {
            title: "Local stories",
            body: {
              type: "doc",
              content: [
                {
                  type: "heading",
                  attrs: { level: 2 },
                  content: [{ type: "text", text: "Local details" }],
                },
              ],
            },
            imageAssetId: "",
            href: "",
          },
        ],
      },
    };

    render(
      <BlockEditor
        section="home"
        initialBlocks={[heading, cardGrid]}
        newId={counterIds()}
        onSave={() => {}}
      />,
    );

    editBlock("Edit card set 2");
    expect(
      screen.getByRole("textbox", { name: "Card title 1" }).closest("h3"),
    ).toHaveClass("card-grid__title");
    expect(
      screen.getByRole("heading", { level: 4, name: "Local details" }),
    ).toBeVisible();
    fireEvent.focus(screen.getByRole("textbox", { name: "Card text 1" }));
    expect(
      screen.getByRole("button", { name: "H4: Heading level 4" }),
    ).toBeVisible();
  });

  it("marks an empty card set and a missing card title as required", () => {
    render(
      <BlockEditor section="home" newId={counterIds()} onSave={() => {}} />,
    );
    addBlock("card set");
    savePage();

    const cards = screen.getByRole("group", { name: "Cards (required)" });
    expect(cards.getAttribute("aria-invalid")).toBe("true");
    expect(
      document.getElementById(cards.getAttribute("aria-describedby")!),
    ).toHaveTextContent("Cards is required.");

    fireEvent.click(screen.getByRole("button", { name: "Add card" }));
    const title = screen.getByRole("textbox", { name: "Card title 1" });
    expect(title.getAttribute("aria-required")).toBe("true");
    expect(title.getAttribute("aria-invalid")).toBe("true");
    expect(title.getAttribute("aria-describedby")).toBe(
      cards.getAttribute("aria-describedby"),
    );
  });

  it("refuses an unsafe optional card link and marks only that field", () => {
    const onSave = vi.fn();
    const cardGrid: AdminBlock = {
      id: "cards-1",
      type: "card_grid",
      order: 0,
      visible: true,
      data: {
        cards: [
          {
            title: "Programs",
            body: { type: "doc", content: [] },
            imageAssetId: "",
            href: "//evil.example",
          },
        ],
      },
    };
    render(
      <BlockEditor
        section="home"
        initialBlocks={[cardGrid]}
        newId={counterIds()}
        onSave={onSave}
      />,
    );

    savePage();

    expect(onSave).not.toHaveBeenCalled();
    const title = screen.getByRole("textbox", { name: "Card title 1" });
    const link = screen.getByRole("textbox", { name: "Card link 1" });
    expect(title.getAttribute("aria-invalid")).toBeNull();
    expect(link.getAttribute("aria-invalid")).toBe("true");
    expect(
      document.getElementById(link.getAttribute("aria-describedby")!),
    ).toHaveTextContent(
      "Card link must use http, https, mailto, tel, or a relative link.",
    );
  });

  it("refuses an unsafe link in optional card text and marks that editor", () => {
    const onSave = vi.fn();
    const cardGrid: AdminBlock = {
      id: "cards-1",
      type: "card_grid",
      order: 0,
      visible: true,
      data: {
        cards: [
          {
            title: "Programs",
            body: {
              type: "doc",
              content: [
                {
                  type: "paragraph",
                  content: [
                    {
                      type: "text",
                      text: "Watch",
                      marks: [
                        { type: "link", attrs: { href: "data:text/html,bad" } },
                      ],
                    },
                  ],
                },
              ],
            },
            imageAssetId: "",
            href: "",
          },
        ],
      },
    };
    render(
      <BlockEditor
        section="home"
        initialBlocks={[cardGrid]}
        newId={counterIds()}
        onSave={onSave}
      />,
    );

    savePage();

    expect(onSave).not.toHaveBeenCalled();
    const body = screen.getByRole("textbox", { name: "Card text 1" });
    expect(body.getAttribute("aria-invalid")).toBe("true");
    expect(
      document.getElementById(body.getAttribute("aria-describedby")!),
    ).toHaveTextContent(
      "Card text contains a link that must use http, https, mailto, tel, or a relative link.",
    );
  });

  it("edits an FAQ item inline and saves the question and answer", async () => {
    const onSave = vi.fn();
    render(
      <BlockEditor
        section="programLanding"
        newId={counterIds()}
        onSave={onSave}
      />,
    );
    addBlock("FAQ item");

    const question = screen.getByRole("textbox", { name: "Question" });
    const answer = screen.getByRole("textbox", { name: "Answer" });
    expect(question.closest(".inline-faq-item")).toBeTruthy();
    expect(question.closest("h2")).toHaveClass("faq-item__question");
    expect(answer.closest(".faq-item__question")).toBeNull();
    fireEvent.change(question, { target: { value: "Where can I watch?" } });
    await act(async () => {
      answer.innerHTML =
        "<h2>Ways to watch</h2><p>Watch online or in the PBS app.</p>";
      fireEvent.input(answer);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(answer.querySelector("h3")).not.toHaveClass("faq-item__question");

    savePage();
    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0][0][0].data;
    expect(saved.question).toBe("Where can I watch?");
    expect(JSON.stringify(saved.answer)).toContain(
      "Watch online or in the PBS app.",
    );

    // Nothing about this block is settled anywhere but its own surface, so no Settings control
    // is offered (#1043).
    expect(
      screen.queryByRole("button", { name: "Settings: FAQ item 1" }),
    ).toBeNull();
  });

  it("marks the FAQ question and answer when required content is missing", () => {
    render(
      <BlockEditor
        section="programLanding"
        newId={counterIds()}
        onSave={() => {}}
      />,
    );
    addBlock("FAQ item");
    savePage();

    for (const name of ["Question", "Answer"]) {
      const input = screen.getByRole("textbox", { name });
      expect(input.getAttribute("aria-required")).toBe("true");
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(
        document.getElementById(input.getAttribute("aria-describedby")!),
      ).toHaveTextContent(/required/i);
    }
  });

  it("names the required state of empty collection groups before any save", () => {
    // Locks in that the requirement is reachable by name on an empty group, before validation
    // marks it (the why is on collectionGroupName in InlineBlockSurface).
    render(
      <BlockEditor section="home" newId={counterIds()} onSave={() => {}} />,
    );
    addBlock("buttons");
    addBlock("image gallery");
    addBlock("card set");

    for (const [editor, name] of [
      ["Edit buttons 1", "Buttons (required)"],
      ["Edit image gallery 2", "Image gallery (required)"],
      ["Edit card set 3", "Cards (required)"],
    ]) {
      editBlock(editor);
      const group = screen.getByRole("group", { name });
      // The requirement is spoken by the name alone, with no validation error raised yet.
      expect(group.getAttribute("aria-invalid")).toBeNull();
    }
  });

  it("saves AP results map controls through the existing Embed plank", () => {
    const onSave = vi.fn();
    const { container } = render(<BlockEditor section="genericPage" newId={counterIds()} onSave={onSave} />);
    addBlock("video or embed");
    const url = "https://interactives.apelections.org/election-results/customers/layouts/organization-layouts/published/111593/29191.html";
    fireEvent.change(screen.getByRole("textbox", { name: "Video or embed link" }), { target: { value: url } });
    fireEvent.change(screen.getByRole("textbox", { name: "Map heading" }), { target: { value: "Archived Senate primary" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Caption" }), { target: { value: "June 2, 2026" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Map size" }), { target: { value: "large" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Mobile height" }), { target: { value: "700" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Map width" }), { target: { value: "wide" } });
    const frame = container.querySelector<HTMLIFrameElement>(".inline-embed-preview iframe")!;
    expect(frame.getAttribute("src")).toBe(url);
    expect(frame.getAttribute("height")).toBe("1200");
    expect(frame.getAttribute("srcdoc")).toBeNull();
    expect(frame.style.getPropertyValue("--ap-map-mobile-height")).toBe("700px");
    savePage();
    expect(onSave).toHaveBeenCalledWith([expect.objectContaining({ type: "embed", data: expect.objectContaining({ url, heading: "Archived Senate primary", caption: "June 2, 2026", mapSize: "large", mobileHeight: 700, mapWidth: "wide" }) })]);
  });

  it.each([
    ["AP to video URL", "https://interactives.apelections.org/election-results/customers/layouts/organization-layouts/published/111593/29191.html", "Mobile height", 200, "https://youtu.be/od8NMua_mEw", ["heading", "mapSize", "mobileHeight", "mapWidth"]],
    ["AP to pasted video iframe", "https://interactives.apelections.org/election-results/customers/layouts/organization-layouts/published/111593/29191.html", "Mobile height", 200, '<iframe src="https://www.youtube.com/embed/od8NMua_mEw"></iframe>', ["heading", "mapSize", "mobileHeight", "mapWidth"]],
    ["video to AP URL", "https://youtu.be/od8NMua_mEw", "Player width", 1, "https://interactives.apelections.org/election-results/customers/layouts/organization-layouts/published/111593/29191.html", ["width", "height"]],
  ] as const)("drops inactive settings when changing %s", (_direction, initialUrl, label, value, nextUrl, inactiveKeys) => {
    const onSave = vi.fn();
    render(<BlockEditor section="genericPage" newId={counterIds()} onSave={onSave} />);
    addBlock("video or embed");
    fireEvent.change(screen.getByRole("textbox", { name: "Video or embed link" }), { target: { value: initialUrl } });
    fireEvent.change(screen.getByRole("spinbutton", { name: label }), { target: { value: String(value) } });
    fireEvent.input(screen.getByRole("textbox", { name: "Video or embed link" }), { target: { value: nextUrl } });
    savePage();
    expect(onSave).toHaveBeenCalledOnce();
    const saved = onSave.mock.calls[0][0][0];
    expect(saved.data.url).toBe(nextUrl);
    for (const key of inactiveKeys) expect(saved.data).not.toHaveProperty(key);
  });

  it.each([
    ["video", "https://youtu.be/od8NMua_mEw", "https://vimeo.com/123456", { width: 960, height: 540 }],
    ["AP map", "https://interactives.apelections.org/election-results/customers/layouts/organization-layouts/published/111593/29191.html", "https://interactives.apelections.org/election-results/customers/layouts/organization-layouts/published/111593/29192.html", { heading: "Local results", mapSize: "large", mobileHeight: 700, mapWidth: "wide" }],
  ] as const)("keeps active settings when replacing a %s link with the same type", (_kind, url, nextUrl, settings) => {
    const onSave = vi.fn();
    render(<BlockEditor section="genericPage" initialBlocks={[
      { ...createBlock("embed", "same-type"), data: { url, caption: "Election coverage", ...settings } },
    ]} onSave={onSave} />);
    editBlock(/^Edit video or embed \d+$/);
    fireEvent.change(screen.getByRole("textbox", { name: "Video or embed link" }), { target: { value: nextUrl } });
    savePage();
    expect(onSave).toHaveBeenCalledOnce();
    expect(onSave.mock.calls[0][0][0].data).toMatchObject({ url: nextUrl, caption: "Election coverage", ...settings });
  });

  it.each(["blank", "truncated"])("keeps AP settings across blur while its URL is %s", state => {
    const onSave = vi.fn();
    const url = "https://interactives.apelections.org/election-results/customers/layouts/organization-layouts/published/111593/29191.html";
    const settings = { heading: "Local results", mapSize: "large", mobileHeight: 700, mapWidth: "wide" };
    render(<BlockEditor section="genericPage" initialBlocks={[
      { ...createBlock("embed", "partial-link"), data: { url, ...settings } },
    ]} onSave={onSave} />);
    editBlock(/^Edit video or embed \d+$/);
    const link = screen.getByRole("textbox", { name: "Video or embed link" });
    fireEvent.change(link, { target: { value: state === "blank" ? "" : url.slice(0, -1) } });
    fireEvent.blur(link);
    fireEvent.change(link, { target: { value: url } });
    savePage();
    expect(onSave).toHaveBeenCalledOnce();
    expect(onSave.mock.calls[0][0][0].data).toMatchObject({ url, ...settings });
  });

  it.each(["", "https://interactives.apelections.org/election-results/customers/layouts/organization-layouts/published/111593/29191.htm"])("drops invalid hidden AP values when committing partial link %s", url => {
    const onSave = vi.fn();
    render(<BlockEditor section="genericPage" allowIncomplete initialBlocks={[
      { ...createBlock("embed", "invalid-partial"), data: { url: "https://interactives.apelections.org/election-results/customers/layouts/organization-layouts/published/111593/29191.html", mobileHeight: 200, mapSize: "large" } },
    ]} onSave={onSave} />);
    editBlock(/^Edit video or embed \d+$/);
    const link = screen.getByRole("textbox", { name: "Video or embed link" });
    fireEvent.change(link, { target: { value: url } });
    fireEvent.blur(link);
    savePage();
    expect(onSave).toHaveBeenCalledOnce();
    expect(onSave.mock.calls[0][0][0].data).toMatchObject({ url, mapSize: "large" });
    expect(onSave.mock.calls[0][0][0].data).not.toHaveProperty("mobileHeight");
  });

  it("clears hidden AP settings when an ordinary link is committed", () => {
    const onSave = vi.fn();
    render(<BlockEditor section="genericPage" initialBlocks={[
      { ...createBlock("embed", "generic-link"), data: { url: "https://interactives.apelections.org/election-results/customers/layouts/organization-layouts/published/111593/29191.html", mobileHeight: 200 } },
    ]} onSave={onSave} />);
    editBlock(/^Edit video or embed \d+$/);
    const link = screen.getByRole("textbox", { name: "Video or embed link" });
    fireEvent.change(link, { target: { value: "https://example.org/report" } });
    fireEvent.blur(link);
    savePage();
    expect(onSave).toHaveBeenCalledOnce();
    expect(onSave.mock.calls[0][0][0].data).toMatchObject({ url: "https://example.org/report" });
    expect(onSave.mock.calls[0][0][0].data).not.toHaveProperty("mobileHeight");
  });

  it.each(["Home", "hidden"] as const)("clears inactive settings on %s without blocking Save", mode => {
    const onSave = vi.fn();
    const blocks = mode === "Home" ? structuredClone(homeComposition.blocks) as AdminBlock[] : [];
    blocks.push({ ...createBlock("embed", "changed-link"), order: blocks.length, visible: mode !== "hidden",
      data: { url: "https://interactives.apelections.org/election-results/customers/layouts/organization-layouts/published/111593/29191.html", mobileHeight: 200, mapSize: "large" } });
    render(<BlockEditor section={mode === "Home" ? "home" : "genericPage"}
      {...(mode === "Home" ? { pageId: "home", homeCompositionVersion: 2 as const, allowIncomplete: true } : {})}
      initialBlocks={blocks} onSave={onSave} />);
    editBlock(/^Edit video or embed \d+$/);
    fireEvent.change(screen.getByRole("textbox", { name: "Video or embed link" }), { target: { value: "https://youtu.be/od8NMua_mEw" } });
    savePage();
    expect(onSave).toHaveBeenCalledOnce();
    const saved = onSave.mock.calls[0][0].find((block: AdminBlock) => block.id === "changed-link");
    expect(saved.visible).toBe(mode !== "hidden");
    expect(saved.data).not.toHaveProperty("mobileHeight");
    expect(saved.data).not.toHaveProperty("mapSize");
  });

  it.each(["Home", "hidden"] as const)("marks an invalid active AP setting on %s before generic parsing", mode => {
    const onSave = vi.fn();
    const blocks = mode === "Home" ? structuredClone(homeComposition.blocks) as AdminBlock[] : [];
    blocks.push({ ...createBlock("embed", "invalid-active"), order: blocks.length, visible: mode !== "hidden",
      data: { url: "https://interactives.apelections.org/election-results/customers/layouts/organization-layouts/published/111593/29191.html", mobileHeight: 200 } });
    render(<BlockEditor section={mode === "Home" ? "home" : "genericPage"}
      {...(mode === "Home" ? { pageId: "home", homeCompositionVersion: 2 as const, allowIncomplete: true } : {})}
      initialBlocks={blocks} onSave={onSave} />);
    savePage();
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole("spinbutton", { name: "Mobile height" })).toHaveAttribute("aria-invalid", "true");
  });

  it.each(["//player.pbs.org/x", "javascript:alert(1)", "host.example:8080/x"])("preserves the existing hidden-embed URL contract: %s", url => {
    const onSave = vi.fn();
    render(<BlockEditor section="genericPage" initialBlocks={[
      { ...createBlock("embed", "hidden-url"), visible: false, data: { url } },
    ]} onSave={onSave} />);
    savePage();
    expect(onSave).toHaveBeenCalledOnce();
    expect(onSave.mock.calls[0][0][0]).toMatchObject({ visible: false, data: { url } });
  });

  it.each([200, 4097, 700.5])("marks an invalid AP Mobile height before save: %s", mobileHeight => {
    const onSave = vi.fn();
    render(<BlockEditor section="genericPage" newId={counterIds()} onSave={onSave} />);
    addBlock("video or embed");
    fireEvent.change(screen.getByRole("textbox", { name: "Video or embed link" }), { target: { value: "https://interactives.apelections.org/election-results/customers/layouts/organization-layouts/published/111593/29191.html" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Mobile height" }), { target: { value: String(mobileHeight) } });
    savePage();
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole("spinbutton", { name: "Mobile height" }).getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(screen.getByRole("spinbutton", { name: "Mobile height" }), { target: { value: "700" } });
    expect(screen.getByRole("spinbutton", { name: "Mobile height" }).getAttribute("aria-invalid")).toBeNull();
    savePage();
    expect(onSave).toHaveBeenCalledWith([expect.objectContaining({ data: expect.objectContaining({ mobileHeight: 700 }) })]);
  });

  it("edits an embed as the same safe link-out the site renders", () => {
    const onSave = vi.fn();
    const { container } = render(
      <BlockEditor section="home" newId={counterIds()} onSave={onSave} />,
    );
    addBlock("video or embed");

    const url = screen.getByRole("textbox", { name: "Video or embed link" });
    const caption = screen.getByRole("textbox", { name: "Caption" });
    expect(url.closest(".inline-embed")).toBeTruthy();
    expect((url as HTMLInputElement).type).toBe("text");
    expect((url as HTMLInputElement).inputMode).toBe("url");

    fireEvent.change(caption, { target: { value: "Watch the segment" } });
    fireEvent.change(url, { target: { value: "javascript:alert(1)" } });
    expect(container.querySelector(".inline-embed-preview a")).toBeNull();
    expect(
      container.querySelector(".inline-embed-preview")?.textContent,
    ).toContain("Watch the segment");

    fireEvent.change(url, {
      target: { value: "https://watch.njpbs.org/video/x" },
    });
    expect(
      container.querySelector(".inline-embed-preview a")?.getAttribute("href"),
    ).toBe("https://watch.njpbs.org/video/x");

    savePage();
    expect(onSave).toHaveBeenCalledWith([
      expect.objectContaining({
        data: {
          url: "https://watch.njpbs.org/video/x",
          caption: "Watch the segment",
        },
      }),
    ]);

    // Nothing about this block is settled anywhere but its own surface, so no Settings control
    // is offered (#1043).
    expect(
      screen.queryByRole("button", { name: "Settings: video or embed 1" }),
    ).toBeNull();
  });

  it.each([
    ["YouTube", "https://youtu.be/od8NMua_mEw", "https://www.youtube-nocookie.com/embed/od8NMua_mEw"],
    ["Vimeo", "https://vimeo.com/76979871", "https://player.vimeo.com/video/76979871?dnt=1"],
    ["TikTok", "https://www.tiktok.com/@scout2015/video/6718335390845095173", "https://www.tiktok.com/embed/v2/6718335390845095173"],
    ["TikTok", '<iframe src="https://www.tiktok.com/player/v1/6718335390845095173?music_info=1"></iframe>', "https://www.tiktok.com/embed/v2/6718335390845095173"],
    ["Instagram", "https://www.instagram.com/reel/CxYz_123Ab-/", "https://www.instagram.com/reel/CxYz_123Ab-/embed"],
    ["Facebook", "https://www.facebook.com/watch/?v=10153231379946729", "https://www.facebook.com/plugins/video.php?href=https%3A%2F%2Fwww.facebook.com%2Fwatch%2F%3Fv%3D10153231379946729"],
    ["Facebook", "https://www.facebook.com/reel/2038437459890192/", "https://www.facebook.com/plugins/video.php?href=https%3A%2F%2Fwww.facebook.com%2Freel%2F2038437459890192%2F"],
    ["PBS", "https://player.pbs.org/partnerplayer/3000000000/", "https://player.pbs.org/partnerplayer/3000000000/"],
  ])("previews and saves a %s player while preserving the pasted link", (provider, url, src) => {
    const onSave = vi.fn();
    const { container } = render(<BlockEditor section="home" newId={counterIds()} onSave={onSave} />);
    addBlock("video or embed");
    fireEvent.change(screen.getByRole("textbox", { name: "Video or embed link" }), { target: { value: url } });
    const player = container.querySelector(".inline-embed-preview iframe");
    expect(player).toHaveAttribute("src", src);
    expect(player).toHaveAttribute("title", `${provider} video player`);
    expect(player).toHaveAttribute("loading", "lazy");
    savePage();
    expect(onSave).toHaveBeenCalledWith([expect.objectContaining({ data: expect.objectContaining({ url }) })]);
  });

  it("previews and saves an X video as a link card", () => {
    const onSave = vi.fn();
    const { container } = render(<BlockEditor section="home" newId={counterIds()} onSave={onSave} />);
    addBlock("video or embed");
    const url = "https://twitter.com/NJPBS/status/1234567890123456789";
    fireEvent.change(screen.getByRole("textbox", { name: "Video or embed link" }), { target: { value: url } });
    expect(container.querySelector(".inline-embed-preview iframe")).toBeNull();
    expect(container.querySelector(".inline-embed-preview .link-card a")).toHaveAttribute("href", "https://x.com/NJPBS/status/1234567890123456789");
    savePage();
    expect(onSave).toHaveBeenCalledWith([expect.objectContaining({ data: expect.objectContaining({ url }) })]);
  });

  it("previews and saves responsive YouTube player dimensions", () => {
    const onSave = vi.fn();
    const { container } = render(
      <BlockEditor section="home" newId={counterIds()} onSave={onSave} />,
    );
    addBlock("video or embed");

    fireEvent.change(screen.getByRole("textbox", { name: "Video or embed link" }), {
      target: { value: "https://youtu.be/od8NMua_mEw" },
    });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Player width" }), {
      target: { value: "640" },
    });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Player height" }), {
      target: { value: "360" },
    });

    const frame = container.querySelector<HTMLElement>(".inline-embed-preview .embed__frame");
    const iframe = frame?.querySelector("iframe");
    expect(frame?.style.getPropertyValue("--embed-aspect-ratio")).toBe("640 / 360");
    expect(frame?.style.getPropertyValue("--embed-max-width")).toBe("640px");
    expect(iframe).toHaveAttribute("width", "640");
    expect(iframe).toHaveAttribute("height", "360");

    savePage();
    expect(onSave).toHaveBeenCalledWith([
      expect.objectContaining({
        data: {
          url: "https://youtu.be/od8NMua_mEw",
          caption: "",
          width: 640,
          height: 360,
        },
      }),
    ]);
  });

  it("removes cleared player dimensions from the saved block", () => {
    const onSave = vi.fn();
    const embed: AdminBlock = {
      ...createBlock("embed", "video-1"),
      data: {
        url: "https://youtu.be/od8NMua_mEw",
        caption: "",
        width: 640,
        height: 360,
      },
    };
    render(<BlockEditor section="home" initialBlocks={[embed]} onSave={onSave} />);
    editBlock("Edit video or embed 1");

    fireEvent.change(screen.getByRole("spinbutton", { name: "Player width" }), {
      target: { value: "" },
    });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Player height" }), {
      target: { value: "" },
    });
    savePage();

    expect(onSave).toHaveBeenCalledWith([
      expect.objectContaining({
        data: {
          url: "https://youtu.be/od8NMua_mEw",
          caption: "",
        },
      }),
    ]);
  });

  it("refuses a player size outside the safe video ratio", () => {
    const onSave = vi.fn();
    render(<BlockEditor section="home" newId={counterIds()} onSave={onSave} />);
    addBlock("video or embed");
    fireEvent.change(screen.getByRole("textbox", { name: "Video or embed link" }), {
      target: { value: "https://youtu.be/od8NMua_mEw" },
    });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Player width" }), {
      target: { value: "160" },
    });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Player height" }), {
      target: { value: "4096" },
    });

    savePage();

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getAllByText(
      "Player width and Player height must use a video ratio from 9:16 through 21:9.",
    )).not.toHaveLength(0);
  });

  it("marks the embed url when required content is missing", () => {
    render(
      <BlockEditor section="home" newId={counterIds()} onSave={() => {}} />,
    );
    addBlock("video or embed");
    savePage();

    const url = screen.getByRole("textbox", { name: "Video or embed link" });
    expect(url.getAttribute("aria-required")).toBe("true");
    expect(url.getAttribute("aria-invalid")).toBe("true");
    expect(
      document.getElementById(url.getAttribute("aria-describedby")!),
    ).toHaveTextContent("Video or embed link is required.");
  });

  it("refuses an unsafe link in an FAQ answer and marks that editor", () => {
    const onSave = vi.fn();
    const faq: AdminBlock = {
      id: "faq-1",
      type: "faq_item",
      order: 0,
      visible: true,
      data: {
        question: "Where can I watch?",
        answer: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "Watch here",
                  marks: [
                    { type: "link", attrs: { href: "javascript:alert(1)" } },
                  ],
                },
              ],
            },
          ],
        },
      },
    };
    render(
      <BlockEditor
        section="programLanding"
        initialBlocks={[faq]}
        newId={counterIds()}
        onSave={onSave}
      />,
    );

    savePage();

    expect(onSave).not.toHaveBeenCalled();
    const answer = screen.getByRole("textbox", { name: "Answer" });
    expect(answer.getAttribute("aria-invalid")).toBe("true");
    expect(
      document.getElementById(answer.getAttribute("aria-describedby")!),
    ).toHaveTextContent(
      "Answer contains a link that must use http, https, mailto, tel, or a relative link.",
    );
  });

  it("refuses an unsafe embed url and explains the accepted link forms", () => {
    const onSave = vi.fn();
    const embed: AdminBlock = {
      id: "embed-1",
      type: "embed",
      order: 0,
      visible: true,
      data: { url: "data:text/html,bad", caption: "" },
    };
    render(
      <BlockEditor
        section="home"
        initialBlocks={[embed]}
        newId={counterIds()}
        onSave={onSave}
      />,
    );

    savePage();

    expect(onSave).not.toHaveBeenCalled();
    const url = screen.getByRole("textbox", { name: "Video or embed link" });
    expect(url.getAttribute("aria-invalid")).toBe("true");
    expect(
      document.getElementById(url.getAttribute("aria-describedby")!),
    ).toHaveTextContent(
      "Video or embed link must use http, https, mailto, tel, or a relative link.",
    );
  });

  it("keeps block settings keyboard reachable inside its named editor", () => {
    render(<BlockEditor section="home" newId={counterIds()} />);
    addBlock("divider");
    addBlock("divider");
    editBlock("Edit divider 1");
    const dialog = screen.getByRole("dialog", { name: "divider 1" });
    expect(within(dialog).getByRole("button", { name: "Hide from page: divider 1" }).tabIndex).toBe(0);
    expect(within(dialog).getByRole("button", { name: "Remove divider 1" }).tabIndex).toBe(0);
    expect(within(dialog).getByRole("button", { name: "Done" }).tabIndex).toBe(0);
    expect(screen.queryByRole("button", { name: "Collapse: divider 1" })).toBeNull();
  });
});

describe("BlockEditor list-item identity", () => {
  // A card's rich-text body is the one editor that lives inside a repeatable list. Reordering
  // cards must move each editor with its card, keeping that card's own editor-local state (its
  // open link popover, its undo history). Index keys would instead pin the editor to a slot,
  // so a reorder would leave the popover on whichever card slid into the old position.
  it("keeps a card's open link editor with its own card across a reorder", () => {
    const { container } = render(
      <BlockEditor section="home" newId={counterIds()} />,
    );
    addBlock("card set");
    fireEvent.click(screen.getByRole("button", { name: "Add card" }));
    fireEvent.click(screen.getByRole("button", { name: "Add card" }));

    const titles = screen.getAllByLabelText(/Card title/);
    fireEvent.change(titles[0], { target: { value: "Alpha" } });
    fireEvent.change(titles[1], { target: { value: "Bravo" } });

    // Open the link editor on the first card's body. Exactly one link address input appears.
    fireEvent.focus(screen.getByRole("textbox", { name: "Card text 1" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Link" })[0]);
    expect(screen.getAllByLabelText("Link address")).toHaveLength(1);

    // Move the first card down. The open link editor must travel with Alpha to the second
    // slot, not stay behind on the card that slid up into the first slot.
    fireEvent.click(screen.getByRole("button", { name: "Move down: card 1" }));

    const items = Array.from(
      container.querySelectorAll<HTMLElement>(".inline-card-grid-card"),
    );
    const alphaItem = items.find((el) =>
      within(el).queryByDisplayValue("Alpha"),
    );
    const bravoItem = items.find((el) =>
      within(el).queryByDisplayValue("Bravo"),
    );
    expect(alphaItem).toBe(items[1]);
    expect(bravoItem).toBe(items[0]);
    expect(screen.getAllByLabelText("Link address")).toHaveLength(1);
    // Only Alpha's link editor stays open, whether inactive toolbars float or stay pinned.
    const alphaLink = within(screen.getByRole("toolbar", { name: "Formatting for Card text 2" }))
      .getByRole("button", { name: "Link" });
    const bravoToolbar = screen.queryByRole("toolbar", { name: "Formatting for Card text 1" });
    expect(alphaLink).toHaveAttribute("aria-expanded", "true");
    if (bravoToolbar) {
      expect(within(bravoToolbar).getByRole("button", { name: "Link" }))
        .toHaveAttribute("aria-expanded", "false");
    }
    expect(document.getElementById(alphaLink.getAttribute("aria-controls")!))
      .toContainElement(screen.getByLabelText("Link address"));
  });
});

describe("BlockEditor per-block visibility", () => {
  it("hides a block and shows it again from the card controls", () => {
    render(<BlockEditor section="home" newId={counterIds()} />);
    addBlock("divider");
    // A block starts visible: it offers a Hide control and carries no Hidden badge.
    expect(
      screen.getByRole("button", {
        name: "Hide from page: divider 1",
      }),
    ).toBeTruthy();
    expect(screen.queryByText("Hidden from page")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Hide from page: divider 1",
      }),
    );
    // Now hidden: the badge names the state and the control flips to the Show action.
    expect(screen.getByText("Hidden from page")).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Show on page: divider 1",
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: "Hide from page: divider 1",
      }),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Show on page: divider 1",
      }),
    );
    expect(screen.queryByText("Hidden from page")).toBeNull();
    expect(
      screen.getByRole("button", {
        name: "Hide from page: divider 1",
      }),
    ).toBeTruthy();
  });

  it("names the hidden state in the block card's accessible region name", () => {
    render(<BlockEditor section="home" newId={counterIds()} />);
    addBlock("divider");
    // While visible, the card region is named by its block type alone.
    expect(screen.getByRole("region", { name: "divider" })).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Hide from page: divider 1",
      }),
    );
    // Hidden: the badge folds into the region's accessible name, so a screen reader hears the
    // hidden state on landing at the region, not only on reading into it.
    expect(
      screen.getByRole("region", { name: "divider Hidden from page" }),
    ).toBeTruthy();
    expect(screen.queryByRole("region", { name: "divider" })).toBeNull();
  });

  it("hides only the targeted block and carries its hidden state through save", () => {
    const onSave = vi.fn();
    render(<BlockEditor section="home" newId={counterIds()} onSave={onSave} />);
    addBlock("divider");
    addBlock("divider");

    // Hiding the first divider leaves the second visible: the toggle is per block.
    editBlock("Edit divider 1");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Hide from page: divider 1",
      }),
    );
    expect(
      screen.getByRole("button", {
        name: "Show on page: divider 1",
      }),
    ).toBeTruthy();
    editBlock("Edit divider 2");
    expect(
      screen.getByRole("button", {
        name: "Hide from page: divider 2",
      }),
    ).toBeTruthy();
    expect(screen.getAllByText("Hidden from page")).toHaveLength(1);

    savePage();
    expect(onSave).toHaveBeenCalledWith([
      expect.objectContaining({ visible: false }),
      expect.objectContaining({ visible: true }),
    ]);
  });

  it("lets the page save once an incomplete block is hidden from the published page", () => {
    const onSave = vi.fn();
    render(<BlockEditor section="home" newId={counterIds()} onSave={onSave} />);
    // An image block requires an asset id and alt text; leave both empty.
    addBlock("image");
    savePage();
    // While visible, the incomplete block blocks the save and is flagged.
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText(/Fix the highlighted blocks/)).toBeTruthy();

    // Hiding it takes it out of the published page, so its empty required fields no longer
    // gate the save, and its stale marker clears.
    fireEvent.click(
      screen.getByRole("button", {
        name: "Hide from page: image 1",
      }),
    );
    expect(screen.queryByText(/Fix the highlighted blocks/)).toBeNull();
    savePage();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0][0]).toMatchObject({
      type: "image",
      visible: false,
    });
  });

  it("keeps an incomplete manual content shelf saveable while it is hidden", () => {
    const onSave = vi.fn();
    render(<BlockEditor section="home" newId={counterIds()} onSave={onSave} />);
    addBlock("manual content shelf");

    expect(screen.getByRole("textbox", { name: "Shelf heading" })).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "Shelf layout" })).toHaveValue("rail");

    savePage();
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Hide from page: manual content shelf 1",
      }),
    );
    savePage();

    expect(onSave).toHaveBeenCalledWith([
      expect.objectContaining({
        type: "promotion_playlist",
        visible: false,
        data: {
          title: "",
          presentation: "rail",
          columns: 3,
          placement: "before_featured",
          cards: [],
        },
      }),
    ]);
  });
});

// A 409 from cmsSaveContent means the stored page moved under this editor while it was open
// (#530). The editor's job is to make that a choice rather than a silent overwrite (#563).
// The rejection carries a `status`, which is what isConflictError reads -- the message is
// server copy and must never be what the branch depends on.
function conflictRejection() {
  return Object.assign(
    new Error(
      "This document changed since you opened it. Reload to get the current version before saving.",
    ),
    { status: 409 },
  );
}

// Returns the view so a case can re-render with changed props: the host's capability check is
// live, so "the same editor, now read-only" is a state the editor really reaches.
async function editableEditor(props: Record<string, unknown>) {
  const view = render(
    <BlockEditor section="home" newId={counterIds()} {...props} />,
  );
  addBlock("heading");
  fireEvent.change(screen.getByRole("textbox", { name: "Heading" }), {
    target: { value: "Tonight on NJ PBS" },
  });
  return view;
}

describe("BlockEditor save conflict", () => {
  it("asks which work to destroy instead of reporting a failure", async () => {
    const onSave = vi.fn(async () => {
      throw conflictRejection();
    });
    await editableEditor({ onSave, onReload: vi.fn() });

    savePage();

    // Named as a question about someone else's work, not as "Save failed" -- a conflict is not
    // a fault the person can fix by retrying.
    expect(
      await screen.findByText(
        /Someone else saved this page while you were editing it/,
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Save failed")).toBeNull();
    expect(screen.queryByText("Saved.")).toBeNull();
    // Both costs are stated on the buttons themselves, so neither can be clicked as a reflex.
    expect(
      screen.getByRole("button", {
        name: "Reload the page, discarding your changes",
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Save anyway, overwriting their changes",
      }),
    ).toBeTruthy();
  });

  it("keeps the person's blocks in the editor so neither answer is taken by default", async () => {
    const onSave = vi.fn(async () => {
      throw conflictRejection();
    });
    await editableEditor({ onSave, onReload: vi.fn() });

    savePage();
    await screen.findByText(/Someone else saved this page/);

    editBlock("Edit heading 1");
    expect(screen.getByRole("textbox", { name: "Heading" })).toHaveValue(
      "Tonight on NJ PBS",
    );
  });

  it("offers reload only when the host cannot safely overwrite a newly created page", async () => {
    const onSave = vi.fn(async () => {
      throw conflictRejection();
    });
    await editableEditor({
      onSave,
      onReload: vi.fn(),
      allowConflictOverwrite: false,
    });

    savePage();

    expect(
      await screen.findByText(
        /This page was created while you were editing it/i,
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Reload the page, discarding your changes",
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: "Save anyway, overwriting their changes",
      }),
    ).toBeNull();
  });

  it("holds the save until the conflict is answered", async () => {
    const onSave = vi.fn(async () => {
      throw conflictRejection();
    });
    await editableEditor({ onSave, onReload: vi.fn() });

    savePage();
    await screen.findByText(/Someone else saved this page/);

    // Disabled *and* refused in the handler: retrying unchanged would send the same stale
    // claim and be refused again, so the button must not be a way back into the same wall.
    const save = screen.getByRole("button", { name: "Save page" });
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("keeps holding the save when the person edits on, because the store is still ahead", async () => {
    const onSave = vi.fn(async () => {
      throw conflictRejection();
    });
    await editableEditor({ onSave, onReload: vi.fn() });

    savePage();
    await screen.findByText(/Someone else saved this page/);

    // Editing does not resolve a conflict: whatever they type next, the stored page is still
    // ahead of what they started from. Clearing on an edit would quietly re-arm an overwrite.
    editBlock("Edit heading 1");
    fireEvent.change(screen.getByRole("textbox", { name: "Heading" }), {
      target: { value: "Changed my mind" },
    });

    expect(screen.getByText(/Someone else saved this page/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save page" })).toBeDisabled();
  });

  it("forces the save when the person chooses to overwrite, and clears the conflict", async () => {
    const onSave = vi
      .fn()
      .mockRejectedValueOnce(conflictRejection())
      .mockResolvedValueOnce(undefined);
    await editableEditor({ onSave, onReload: vi.fn() });

    savePage();
    await screen.findByText(/Someone else saved this page/);

    doneEditing();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Save anyway, overwriting their changes",
      }),
    );

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    // The force flag is the only thing that distinguishes the two calls; the host turns it into
    // "send no base version", which is what makes the write win.
    expect(onSave.mock.calls[0][1]).toBeUndefined();
    expect(onSave.mock.calls[1][1]).toEqual({ force: true });
    await waitFor(() =>
      expect(screen.queryByText(/Someone else saved this page/)).toBeNull(),
    );
    expect(
      screen.getByRole("button", { name: "Save page" }),
    ).not.toBeDisabled();
  });

  it("hands the reload back to the host, which owns the read", async () => {
    const onReload = vi.fn();
    const onSave = vi.fn(async () => {
      throw conflictRejection();
    });
    await editableEditor({ onSave, onReload });

    savePage();
    await screen.findByText(/Someone else saved this page/);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Reload the page, discarding your changes",
      }),
    );

    expect(onReload).toHaveBeenCalledTimes(1);
    // The editor does not re-read or reseed itself: the host re-runs the load and remounts it.
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("offers only the overwrite when the host cannot reload", async () => {
    const onSave = vi.fn(async () => {
      throw conflictRejection();
    });
    await editableEditor({ onSave });

    savePage();
    await screen.findByText(/Someone else saved this page/);

    expect(
      screen.queryByRole("button", { name: /Reload the page/ }),
    ).toBeNull();
    expect(
      screen.getByRole("button", {
        name: "Save anyway, overwriting their changes",
      }),
    ).toBeTruthy();
  });

  it("holds the overwrite when save access is revoked while the conflict stands", async () => {
    // canSave follows a live users/{uid} snapshot, so a revoke can land in the minutes this
    // question sits on screen. handleSave refuses a forced save without it, so leaving the
    // button enabled would offer to overwrite someone's work and then do nothing at all.
    // Reload stays live: re-reading a page you may no longer save is still a way out.
    const onSave = vi.fn(async () => {
      throw conflictRejection();
    });
    const newId = counterIds();
    const view = await editableEditor({ onSave, onReload: vi.fn(), newId });

    savePage();
    await screen.findByText(/Someone else saved this page/);

    view.rerender(
      <BlockEditor
        section="home"
        newId={newId}
        onSave={onSave}
        onReload={vi.fn()}
        canSave={false}
      />,
    );

    expect(
      screen.getByRole("button", {
        name: "Save anyway, overwriting their changes",
      }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", {
        name: "Reload the page, discarding your changes",
      }),
    ).toBeEnabled();
  });

  it("announces the conflict, because it arrives while focus is still on Save", async () => {
    // The person pressed Save and focus stayed there. The answer -- the save did not happen and
    // that button is now disabled -- has to be spoken, or a screen-reader user is left with a
    // dead button and no reason. InlineMessage derives a role for error and success tones only,
    // so a warning has to ask for one.
    const onSave = vi.fn(async () => {
      throw conflictRejection();
    });
    await editableEditor({ onSave, onReload: vi.fn() });

    savePage();

    const banner = await screen.findByRole("alert");
    expect(banner.textContent).toContain(
      "Someone else saved this page while you were editing it",
    );
    expect(banner.textContent).toContain(
      "Saving now would overwrite their work",
    );
  });

  it("holds both answers while a forced save is in flight, so neither can race the other", async () => {
    // Reloading mid-save would reseed the editor from the store while the save is still out.
    // The save then reports the version its own write produced, and the host would pair that
    // version with blocks it does not describe -- a later save would claim to be composed
    // against content nobody ever saw, which is the overwrite this banner exists to prevent.
    let releaseForcedSave: (value: undefined) => void = () => {};
    const forcedSaveInFlight = new Promise<undefined>((resolve) => {
      releaseForcedSave = resolve;
    });
    const onSave = vi
      .fn()
      .mockRejectedValueOnce(conflictRejection())
      .mockImplementationOnce(() => forcedSaveInFlight);
    const onReload = vi.fn();
    await editableEditor({ onSave, onReload });

    savePage();
    await screen.findByText(/Someone else saved this page/);

    const reload = screen.getByRole("button", {
      name: "Reload the page, discarding your changes",
    });
    expect(reload).not.toBeDisabled();

    doneEditing();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Save anyway, overwriting their changes",
      }),
    );

    // The other answer is out of reach until this one settles.
    await waitFor(() => expect(reload).toBeDisabled());
    fireEvent.click(reload);
    expect(onReload).not.toHaveBeenCalled();

    // And the forced save reports its own progress and cannot be double-sent while it is out.
    // This is also the only visible save control when the page workspace owns the combined
    // Update action.
    const saveAnyway = within(screen.getByRole("alert")).getByRole("button", {
      name: "Save anyway, overwriting their changes: Saving…",
    });
    expect(saveAnyway).toHaveTextContent("Saving…");
    expect(saveAnyway).toHaveAttribute("aria-busy", "true");
    expect(saveAnyway).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByText("Saving…", { selector: ".block-editor-save-status" }),
    ).toHaveAttribute("role", "status");
    expect(
      within(screen.getByRole("alert")).queryByRole("status"),
    ).toBeNull();
    fireEvent.click(saveAnyway);
    expect(onSave).toHaveBeenCalledTimes(2);

    releaseForcedSave(undefined);
    await waitFor(() =>
      expect(screen.queryByText(/Someone else saved this page/)).toBeNull(),
    );
  });

  it("keeps the conflict standing when the forced save is refused before it is sent", async () => {
    // Answering "save anyway" on a page that is not valid leaves two true things at once: an
    // error to fix, and a question still open. Dropping the conflict here would re-enable the
    // plain Save button while the version claim it sends is still the stale one, so the person
    // would be asked the same question they already answered.
    const onSave = vi.fn(async () => {
      throw conflictRejection();
    });
    await editableEditor({ onSave, onReload: vi.fn() });

    savePage();
    await screen.findByText(/Someone else saved this page/);

    // Empty the heading, so the required-field check refuses the save inside the editor.
    editBlock("Edit heading 1");
    fireEvent.change(screen.getByRole("textbox", { name: "Heading" }), {
      target: { value: "" },
    });
    doneEditing();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Save anyway, overwriting their changes",
      }),
    );

    // What to fix is named...
    expect(
      await screen.findByText(
        "Fix the highlighted blocks before overwriting.",
      ),
    ).toBeTruthy();
    // ...and so is the fact that the save is still held, along with the button that releases it.
    expect(screen.getByText(/Someone else saved this page/)).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Save anyway, overwriting their changes",
      }),
    ).toBeTruthy();
    // The forced attempt never reached the host, so only the first save was ever sent.
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Saved.")).toBeNull();
  });

  it("keeps the conflict standing when the forced save fails on the way out", async () => {
    // Same rule for a forced save the server never accepted: nothing was overwritten, so the
    // conflict is still real and the person's answer to it still stands.
    const onSave = vi
      .fn()
      .mockRejectedValueOnce(conflictRejection())
      .mockRejectedValueOnce(new Error("The network dropped."));
    await editableEditor({ onSave, onReload: vi.fn() });

    savePage();
    await screen.findByText(/Someone else saved this page/);

    doneEditing();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Save anyway, overwriting their changes",
      }),
    );

    // The failure is reported as a failure...
    expect(await screen.findByText("The network dropped.")).toBeTruthy();
    expect(screen.getByText("Save failed")).toBeTruthy();
    // ...without swallowing the conflict, which nothing has resolved.
    expect(screen.getByText(/Someone else saved this page/)).toBeTruthy();
    expect(screen.queryByText("Saved.")).toBeNull();
  });

  it("still reports an ordinary save failure as a failure", async () => {
    // The conflict branch must not swallow every rejection. A 403 is a fault to report, not a
    // question to ask, and it keeps the retryable Save button.
    const onSave = vi.fn(async () => {
      throw Object.assign(new Error("Your role cannot save this page"), {
        status: 403,
      });
    });
    await editableEditor({ onSave, onReload: vi.fn() });

    savePage();

    expect(await screen.findByText("Save failed")).toBeTruthy();
    expect(screen.getByText(/Your role cannot save this page/)).toBeTruthy();
    expect(screen.queryByText(/Someone else saved this page/)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Save page" }),
    ).not.toBeDisabled();
  });
});

// A save must settle the draft whatever shape the host's onSave returns (#579). The prop's
// contract allows `void`, `Promise<void>`, and `Promise<BlockSaveResult>`, but only the last one
// changes the block list -- so a draft settled solely by watching the list would strand the
// other two, leaving an already-saved page stashed for the host to restore stale.
describe("BlockEditor draft settling across save shapes (#579)", () => {
  function addHeading(text: string) {
    addBlock("heading");
    fireEvent.change(screen.getByRole("textbox", { name: "Heading" }), {
      target: { value: text },
    });
  }

  it("settles the draft when the host's save returns void", () => {
    const onDraftChange = vi.fn();
    render(
      <BlockEditor
        section="home"
        newId={counterIds()}
        onSave={() => {}}
        onDraftChange={(blocks) => onDraftChange(blocks)}
      />,
    );
    addHeading("Tonight on NJ PBS");
    expect(onDraftChange.mock.lastCall?.[0]).not.toBeNull();

    savePage();

    // null is the host's cue to drop the draft and read this page fresh next time.
    expect(onDraftChange.mock.lastCall?.[0]).toBeNull();
  });

  it("settles the draft when the host's save resolves to nothing", async () => {
    const onDraftChange = vi.fn();
    render(
      <BlockEditor
        section="home"
        newId={counterIds()}
        onSave={async () => {}}
        onDraftChange={(blocks) => onDraftChange(blocks)}
      />,
    );
    addHeading("Tonight on NJ PBS");
    savePage();

    await waitFor(() => expect(onDraftChange.mock.lastCall?.[0]).toBeNull());
  });

  it("keeps the draft when the page is edited while a void save is in flight", async () => {
    const onDraftChange = vi.fn();
    let release!: () => void;
    const onSave = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    render(
      <BlockEditor
        section="home"
        newId={counterIds()}
        onSave={onSave}
        onDraftChange={(blocks) => onDraftChange(blocks)}
      />,
    );
    addHeading("Tonight on NJ PBS");
    savePage();
    // Edit while the save is still out, then let it land.
    editBlock("Edit heading 1");
    fireEvent.change(screen.getByRole("textbox", { name: "Heading" }), {
      target: { value: "Tonight on NJ PBS, edited" },
    });
    await act(async () => {
      release();
    });

    // The in-flight edit is still unsaved, so the draft stands rather than settling to null.
    expect(onDraftChange.mock.lastCall?.[0]).not.toBeNull();
  });
});

describe("BlockEditor add-block palette and outline guidance", () => {
  it("keeps the Data Hub picker open when the Page block limit refuses insertion", () => {
    const blocks = Array.from({ length: 40 }, (_, order) => ({ ...createBlock("divider", `divider-${order}`), order }));
    render(<BlockEditor section="genericPage" pageId="data-hub" initialBlocks={blocks} newId={counterIds()} />);
    fireEvent.click(screen.getByRole("button", { name: "Add content: position 41" }));
    const dialog = screen.getByRole("dialog", { name: "Add content" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Data Hub section" }));
    const commit = within(dialog).getByRole("button", { name: "Insert block" });
    fireEvent.click(commit);
    expect(dialog).toBeVisible();
    expect(within(dialog).getByRole("alert")).toHaveTextContent("could not be inserted");
    expect(commit).toBeDisabled();
    expect(document.querySelectorAll(".block-card-data_hub_section")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
  });

  it("keeps the picker open and unchanged when the reducer refuses a second headline", () => {
    const row = { ...createBlock("row", "row"), data: { columns: [12] }, order: 0 };
    const headline = { ...createBlock("headline", "headline"), layout: { rowId: row.id, column: 0 }, order: 1 };
    render(<BlockEditor section="home" initialBlocks={[row, headline]} newId={counterIds()} />);
    const undo = screen.getByRole("button", { name: "Undo" });
    expect(undo).toBeDisabled();

    const column = screen.getByRole("group", { name: "Row 1, column 1" });
    fireEvent.click(within(column).getByRole("button", { name: "Add plank to column 1" }));
    const dialog = screen.getByRole("dialog", { name: "Add content" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "heading" }));
    const commit = within(dialog).getByRole("button", { name: "Insert block" });
    commit.focus();
    fireEvent.click(commit);

    expect(dialog).toBeVisible();
    expect(within(dialog).getByRole("radio", { name: "heading" })).toBeChecked();
    expect(within(dialog).getByRole("alert")).toHaveTextContent("could not be inserted");
    expect(commit).toBeDisabled();
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.querySelectorAll(".block-card-headline")).toHaveLength(1);
    expect(undo).toBeDisabled();
  });

  it("describes each block beside its name so the shelves can be told apart", () => {
    render(<BlockEditor section="home" newId={counterIds()} />);
    fireEvent.click(screen.getByRole("button", { name: "Add content: position 1" }));
    const palette = screen.getByRole("radiogroup", { name: "Content types at position 1" });

    const contentShelf = within(palette).getByRole("radio", { name: "content shelf" });
    const manualShelf = within(palette).getByRole("radio", { name: "manual content shelf" });
    expect(contentShelf).toHaveAccessibleDescription(
      "Programs pulled automatically from PBS Media Manager.",
    );
    expect(manualShelf).toHaveAccessibleDescription(
      "Programs or pages you pick by hand and order yourself.",
    );
    expect(within(palette).getByText("A thin rule between two parts of the page.")).toBeVisible();
  });

  it("closes the modal palette on Escape and Cancel, returning focus to the opener", () => {
    render(<BlockEditor section="home" initialBlocks={longPageBlocks()} newId={counterIds()} />);
    const trigger = screen.getByRole("button", { name: "Add content: position 1" });
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Add content" });
    expect(trigger).toHaveAttribute("aria-controls", dialog.id);
    fireEvent(dialog, new Event("cancel", { bubbles: true, cancelable: true }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("marks the blocks a refused save named in the page outline and counts them", async () => {
    render(<BlockEditor section="home" newId={counterIds()} onSave={vi.fn()} />);
    addBlock("heading");
    addBlock("text");
    savePage();

    expect(screen.getByText(/Fix the highlighted blocks before saving/)).toBeTruthy();
    expect(
      screen.getByText(/blocks need attention; they are highlighted in the content/),
    ).toBeTruthy();
    doneEditing();
    fireEvent.click(screen.getByRole("button", { name: "Outline" }));
    const outline = await screen.findByRole("navigation", { name: "Content outline" });
    const flagged = within(outline).getAllByText("Needs attention");
    expect(flagged.length).toBeGreaterThan(0);
    expect(
      within(outline).getByRole("button", { name: /^Go to heading 1: .*needs attention/ }),
    ).toBeTruthy();
    expect(outline.querySelectorAll(".block-outline-item-invalid").length).toBe(flagged.length);
  });
});
