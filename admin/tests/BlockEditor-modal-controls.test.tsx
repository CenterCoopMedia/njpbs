import { afterEach, describe, it, expect, vi } from "vitest";
import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { BlockEditor, type BlockEditorHandle } from "../src/components/BlockEditor";
import { createRef } from "react";
import { HomeHeroModal } from "../src/components/HomeHeroModal";
import { EditorWorkspaceViewProvider, useEditorWorkspaceView } from "../src/context/EditorWorkspaceView";
import { SuccessNoticeProvider } from "../src/components/ui/SuccessNoticeRegion";
import { ControlPresentationProvider } from "../src/context/ControlPresentationContext";
import { type AdminBlock } from "../src/lib/block-factory";

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

function kindsInOrder(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll(".block-card-kind")).map(
    (el) => el.textContent ?? "",
  );
}

function addBlock(name: string) {
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

describe("BlockEditor long-page affordances", () => {
  it("save validation and Review content reveal the invalid block after selecting Home hero", async () => {
    const editor = createRef<BlockEditorHandle>();
    const save = vi.fn();
    function Fixture() {
      const view = useEditorWorkspaceView()!;
      return <><div aria-label="Selection fields" ref={view.setSelectionTarget} />
        <HomeHeroModal value={null}><input aria-label="Hero draft" defaultValue="Retained hero" /></HomeHeroModal>
        <BlockEditor ref={editor} section="home" initialBlocks={[{ id: "invalid-heading", type: "headline", order: 0, visible: true, data: { text: "", level: 2 } }]}
          onSave={save} /></>;
    }
    render(<SuccessNoticeProvider routeKey="home"><EditorWorkspaceViewProvider kind="page"><Fixture /></EditorWorkspaceViewProvider></SuccessNoticeProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Edit Home hero" }));
    expect(screen.getByRole("region", { name: "Home hero" })).toHaveAttribute("data-selected", "true");
    await act(async () => { await editor.current!.save(); });
    const target = screen.getByLabelText("Selection fields");
    await waitFor(() => expect(within(target).getByRole("textbox", { name: "Heading" })).toBeVisible());
    await waitFor(() => expect(within(target).getByRole("textbox", { name: "Heading" })).toHaveFocus());
    expect(screen.getByRole("region", { name: "Home hero" })).not.toHaveAttribute("data-selected");
    fireEvent.click(screen.getByRole("button", { name: "Edit Home hero" }));
    fireEvent.click(screen.getByRole("button", { name: "Review content" }));
    await waitFor(() => expect(within(target).getByRole("textbox", { name: "Heading" })).toBeVisible());
    await waitFor(() => expect(within(target).getByRole("textbox", { name: "Heading" })).toHaveFocus());
    expect(save).not.toHaveBeenCalled();
  });

  it("keeps only document commands in the command bar", async () => {
    render(
      <BlockEditor
        section="home"
        initialBlocks={longPageBlocks()}
        newId={counterIds()}
        onSave={() => {}}
      />,
    );

    const commands = screen.getByRole("toolbar", {
      name: "Page editing commands",
    });
    expect(
      within(commands).queryByRole("button", { name: "Add block" }),
    ).toBeNull();
    expect(
      within(commands).getByRole("button", { name: "Save page" }),
    ).toBeTruthy();
    expect(within(commands).getByRole("button", { name: "Undo" })).toBeTruthy();
    expect(within(commands).queryByText("2 blocks")).toBeNull();
    expect(within(commands).queryByText("8 block types")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Outline" }));
    expect(await screen.findByText("2 blocks in outline")).toHaveClass("sr-only");
  });

  it("starts with a hidden outline, opens and closes it without dirtying content", async () => {
    const onDraftChange = vi.fn();
    const first = render(
      <BlockEditor
        section="home"
        initialBlocks={longPageBlocks()}
        newId={counterIds()}
        onDraftChange={onDraftChange}
      />,
    );

    const toggle = screen.getByRole("button", {
      name: "Outline",
    });
    expect(toggle).not.toHaveAttribute("aria-controls");
    expect(first.container.querySelector(".block-outline")).toBeNull();
    expect(toggle.closest(".block-editor-command-bar")).toBeTruthy();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("heading", { name: "Content outline" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Go to heading/ })).toBeNull();
    expect(
      screen.queryByRole("navigation", { name: "Content outline" }),
    ).toBeNull();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const panel = (await screen.findByRole("navigation", { name: "Content outline" })).closest(".block-outline")!;
    expect(toggle).toHaveAttribute("aria-controls", panel.id);
    expect(panel).not.toHaveAttribute("hidden");
    expect(localStorage.getItem("njpbs-admin:outline-collapsed")).toBe("false");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(panel).toHaveAttribute("hidden");
    expect(screen.queryByRole("button", { name: /Go to heading/ })).toBeNull();
    expect(localStorage.getItem("njpbs-admin:outline-collapsed")).toBe("true");
    expect(
      first.container.querySelector(".block-editor-layout"),
    ).toHaveAttribute("data-outline-collapsed", "true");
    expect(onDraftChange).not.toHaveBeenCalled();

    first.unmount();
    render(
      <BlockEditor
        section="home"
        initialBlocks={longPageBlocks()}
        newId={counterIds()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Outline" }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps a live page outline in sync and reorders from that compact view", async () => {
    const { container } = render(
      <BlockEditor
        section="home"
        initialBlocks={longPageBlocks()}
        newId={counterIds()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Outline" }));
    const outline = (await screen.findByRole("navigation", { name: "Content outline" }));
    expect(within(outline).getByText("Tonight on NJ PBS")).toBeTruthy();
    expect(within(outline).getByText("Visual separator")).toBeTruthy();

    const jump = within(outline).getByRole("button", {
      name: "Go to divider 2: Visual separator",
    });
    fireEvent.click(jump);
    expect(screen.getByRole("dialog", { name: "divider 2" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(jump.getAttribute("aria-current")).toBe("location");

    fireEvent.click(
      within(outline).getByRole("button", {
        name: "Move up: divider 2 in content outline",
      }),
    );
    expect(kindsInOrder(container)).toEqual(["divider", "heading"]);
    expect(within(outline).queryAllByText(/^Up$/)).toHaveLength(0);
    expect(within(outline).queryAllByText(/^Down$/)).toHaveLength(0);
  });

  it("inserts a chosen block at the gap between two existing blocks", async () => {
    const { container } = render(
      <BlockEditor
        section="home"
        initialBlocks={longPageBlocks()}
        newId={counterIds()}
      />,
    );

    const insert = screen.getByRole("button", {
      name: "Add content: position 2",
    });
    expect(insert).not.toHaveTextContent("Add block");
    expect(insert.querySelector(".icon")).toBeInTheDocument();
    fireEvent.click(insert);
    const choices = screen.getByRole("radiogroup", {
      name: "Content types at position 2",
    });
    fireEvent.click(within(choices).getByRole("radio", { name: "text" }));
    fireEvent.click(screen.getByRole("button", { name: "Insert block" }));

    expect(kindsInOrder(container)).toEqual(["heading", "text", "divider"]);
    fireEvent.click(screen.getByRole("button", { name: "Outline" }));
    expect(await screen.findByText("3 blocks in outline")).toHaveClass("sr-only");
  });

  it("closes a block editor without discarding its fields", () => {
    render(<BlockEditor section="home" initialBlocks={longPageBlocks()} newId={counterIds()} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit heading 1" }));
    const heading = screen.getByRole("textbox", { name: "Heading" });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("textbox", { name: "Heading" })).toBeNull();
    expect(screen.getByRole("region", { name: "heading" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Edit heading 1" }));
    expect(screen.getByRole("textbox", { name: "Heading" })).toBe(heading);
  });

  it("navigates from the outline without hiding any block", async () => {
    // Outline navigation opens the chosen editor while keeping every card on the page.
    const onDraftChange = vi.fn();
    render(
      <BlockEditor
        section="home"
        initialBlocks={longPageBlocks()}
        onDraftChange={onDraftChange}
      />,
    );

    expect(screen.queryByRole("button", { name: /^Focus/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Outline" }));
    const outline = (await screen.findByRole("navigation", { name: "Content outline" }));
    fireEvent.click(
      within(outline).getByRole("button", {
        name: "Go to divider 2: Visual separator",
      }),
    );

    expect(screen.getByRole("region", { name: "heading" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "divider" })).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "divider 2" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    // Navigation is editor-view state, not a content change.
    expect(onDraftChange).not.toHaveBeenCalled();
  });

  it("keeps every insertion gap reachable while the whole page is shown", () => {
    const { container } = render(
      <BlockEditor
        section="home"
        initialBlocks={longPageBlocks()}
        newId={counterIds()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Add content: position 2" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Add content: position 3" }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Add content: position 2" }),
    );
    fireEvent.click(within(
      screen.getByRole("radiogroup", { name: "Content types at position 2" }),
    ).getByRole("radio", { name: "text" }));
    fireEvent.click(screen.getByRole("button", { name: "Insert block" }));

    expect(kindsInOrder(container)).toEqual(["heading", "text", "divider"]);
  });

  it("names each outline jump by its content and state, not just its position", async () => {
    render(
      <BlockEditor
        section="home"
        initialBlocks={longPageBlocks()}
        newId={counterIds()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Outline" }));
    const outline = (await screen.findByRole("navigation", { name: "Content outline" }));
    // The content summary is part of the accessible name, so two blocks of the same type stay
    // distinguishable to a screen reader without reading into the button. Before this, an
    // aria-label of "Go to <type> <position>" clobbered the summary and the state badges.
    expect(
      within(outline).getByRole("button", {
        name: "Go to heading 1: Tonight on NJ PBS",
      }),
    ).toBeTruthy();
    expect(
      within(outline).getByRole("button", {
        name: "Go to divider 2: Visual separator",
      }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Edit heading 1" }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Hide from page: heading 1",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(
      within(outline).getByRole("button", {
        name: "Go to heading 1: Tonight on NJ PBS, hidden",
      }),
    ).toBeTruthy();
  });

  it("opens fields and settings together from the compact card", () => {
    render(<BlockEditor section="home" initialBlocks={longPageBlocks()} newId={counterIds()} />);
    expect(screen.queryByRole("textbox", { name: "Heading" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit heading 1" }));
    const dialog = screen.getByRole("dialog", { name: "heading 1" });
    expect(within(dialog).getByRole("textbox", { name: "Heading" })).toBeVisible();
    expect(within(dialog).getByLabelText("Heading level")).toBeVisible();
  });

  it("opens the invalid block after a refused save", () => {
    render(<BlockEditor section="home" initialBlocks={longPageBlocks()} newId={counterIds()} onSave={() => {}} />);
    addBlock("text");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("textbox", { name: "Body" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save page" }));
    const dialog = screen.getByRole("dialog", { name: "text 3" });
    expect(within(dialog).getByText("Body is required.")).toBeVisible();
    expect(within(dialog).getByRole("textbox", { name: "Body" })).toBeVisible();
  });
});

describe("BlockEditor modal controls", () => {
  it("offers header movement and Edit on compact cards and real settings for each block", () => {
    render(<BlockEditor section="home" initialBlocks={longPageBlocks()} newId={counterIds()} />);
    for (const [index, name] of ["heading", "divider"].entries()) {
      const card = screen.getByRole("region", { name });
      expect(within(card).getAllByRole("button")).toHaveLength(3);
      expect(within(card).getByRole("button", { name: `Move: ${name} plank ${index + 1}` })).toBeVisible();
      expect(within(card).getByRole("button", { name: `Move to…: ${name} ${index + 1}` })).toBeVisible();
      expect(within(card).getByRole("button", { name: `Edit ${name} ${index + 1}` })).toBeVisible();
    }
    fireEvent.click(screen.getByRole("button", { name: "Edit heading 1" }));
    expect(within(screen.getByRole("dialog")).getByLabelText("Heading level")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit divider 2" }));
    const divider = screen.getByRole("dialog", { name: "divider 2" });
    expect(within(divider).queryByLabelText("Heading level")).toBeNull();
    expect(within(divider).getByRole("button", { name: "Remove divider 2" })).toBeVisible();
  });

  it("opens by pointer and closes with Done", () => {
    render(<BlockEditor section="home" initialBlocks={longPageBlocks()} newId={counterIds()} />);
    const edit = screen.getByRole("button", { name: "Edit heading 1" });
    edit.focus();
    fireEvent.click(edit);
    expect(screen.getByRole("dialog", { name: "heading 1" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(edit).toHaveFocus();
  });

  it("keeps explicit Edit keyboard accessible in icon presentation", () => {
    render(<ControlPresentationProvider value="icons"><BlockEditor section="home" initialBlocks={longPageBlocks()} /></ControlPresentationProvider>);
    const edit = screen.getByRole("button", { name: "Edit heading 1" });
    expect(edit.tabIndex).toBe(0);
    edit.focus();
    expect(edit).toHaveFocus();
    fireEvent.click(edit);
    expect(within(screen.getByRole("dialog")).getByLabelText("Heading level")).toBeVisible();
  });

  it("opens on touch without hover help", () => {
    render(<BlockEditor section="home" initialBlocks={longPageBlocks()} newId={counterIds()} />);
    const edit = screen.getByRole("button", { name: "Edit heading 1" });
    fireEvent.pointerDown(edit, { pointerType: "touch" });
    fireEvent.pointerUp(edit, { pointerType: "touch" });
    fireEvent.click(edit);
    expect(screen.getByRole("dialog", { name: "heading 1" })).toBeVisible();
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("returns focus to Edit after native Escape cancellation", () => {
    render(<BlockEditor section="home" initialBlocks={longPageBlocks()} newId={counterIds()} />);
    const edit = screen.getByRole("button", { name: "Edit heading 1" });
    edit.focus();
    fireEvent.click(edit);
    within(screen.getByRole("dialog")).getByLabelText("Heading level").focus();
    fireEvent(screen.getByRole("dialog", { name: "heading 1" }), new Event("cancel", { cancelable: true }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(edit).toHaveFocus();
  });

  it("offers an explicit close control inside the dialog", () => {
    render(<BlockEditor section="home" initialBlocks={longPageBlocks()} newId={counterIds()} />);
    const edit = screen.getByRole("button", { name: "Edit heading 1" });
    edit.focus();
    fireEvent.click(edit);
    fireEvent.click(screen.getByRole("button", { name: "Close heading 1" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(edit).toHaveFocus();
  });

  it("does not swallow Escape from a closed card", () => {
    const parentKeyDown = vi.fn();
    render(<div onKeyDown={parentKeyDown}><BlockEditor section="home" initialBlocks={longPageBlocks()} /></div>);
    fireEvent.keyDown(screen.getByRole("region", { name: "heading" }), { key: "Escape" });
    expect(parentKeyDown).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps settings associated with their block across separate editing sessions", () => {
    const first = longPageBlocks()[0];
    render(<BlockEditor section="home" initialBlocks={[first, { ...first, id: "second", order: 1, data: { text: "Watch and listen", level: 3 } }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit heading 1" }));
    fireEvent.change(within(screen.getByRole("dialog")).getByLabelText("Heading level"), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit heading 2" }));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(within(screen.getByRole("dialog")).getByLabelText("Heading level")).toHaveValue("3");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit heading 1" }));
    expect(within(screen.getByRole("dialog")).getByLabelText("Heading level")).toHaveValue("4");
  });
});
