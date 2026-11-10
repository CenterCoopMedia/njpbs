import { afterEach, describe, expect, it } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { EditorBento, type BentoPanel } from "../src/components/EditorBento";
import { EditorLayoutMode } from "../src/components/EditorLayoutMode";
import { createMemoryBentoStore } from "../src/lib/editor-bento-store";

function appendPageEditor() {
  const studio = document.createElement("section");
  studio.className = "content-studio";

  const editor = document.createElement("div");
  editor.className = "editor-bento";
  editor.setAttribute("aria-label", "Page editor sections");

  const layoutTools = document.createElement("div");
  layoutTools.className = "editor-bento-layout-tools";

  const grip = document.createElement("span");
  grip.className = "editor-bento-grip";
  grip.draggable = true;

  const controls = document.createElement("div");
  controls.className = "editor-bento-card-controls";
  controls.append(document.createElement("button"));

  const editable = document.createElement("div");
  editable.contentEditable = "true";

  editor.append(layoutTools, grip, controls, editable);
  studio.append(editor);
  document.body.append(studio);
  return { studio, editor, layoutTools, grip, controls, editable };
}

afterEach(() => {
  cleanup();
  document.querySelectorAll(".content-studio").forEach((node) => node.remove());
  globalThis.localStorage.clear();
});

describe("EditorLayoutMode", () => {
  it("keeps movement controls out of normal editing until requested", async () => {
    const { editor, layoutTools, grip, controls } = appendPageEditor();
    render(<EditorLayoutMode />);

    const customize = await screen.findByRole("button", {
      name: "Customize section layout",
    });

    await waitFor(() => expect(editor.dataset.layoutMode).toBe("edit"));
    expect(layoutTools).toContainElement(customize);
    expect(
      customize.compareDocumentPosition(grip) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(grip).toHaveAttribute("aria-hidden", "true");
    expect(grip.draggable).toBe(false);
    expect(grip.inert).toBe(true);
    expect(controls).toHaveAttribute("aria-hidden", "true");
    expect(controls.inert).toBe(true);

    fireEvent.click(customize);

    expect(
      screen.getByRole("button", { name: "Finish arranging sections" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(editor.dataset.layoutMode).toBe("customize");
    expect(grip).toHaveAttribute("aria-hidden", "false");
    expect(grip.draggable).toBe(true);
    expect(grip.inert).toBe(false);
    expect(controls).toHaveAttribute("aria-hidden", "false");
    expect(controls.inert).toBe(false);

    fireEvent.click(
      screen.getByRole("button", { name: "Finish arranging sections" }),
    );

    expect(editor.dataset.layoutMode).toBe("edit");
    expect(screen.getByRole("button", { name: "Customize section layout" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("preserves native editor drags while blocking hidden movement controls", async () => {
    const { editor, grip, editable } = appendPageEditor();
    render(<EditorLayoutMode />);
    await screen.findByRole("button", { name: "Customize section layout" });

    const nativeDrag = new Event("dragstart", {
      bubbles: true,
      cancelable: true,
    });
    editable.dispatchEvent(nativeDrag);
    expect(nativeDrag.defaultPrevented).toBe(false);

    const gripDrag = new Event("dragstart", {
      bubbles: true,
      cancelable: true,
    });
    grip.dispatchEvent(gripDrag);
    expect(gripDrag.defaultPrevented).toBe(true);
    expect(editor.dataset.layoutMode).toBe("edit");
  });

  it("restores the live default before later changes can persist", async () => {
    const panels: BentoPanel[] = [
      {
        id: "content",
        title: "Page content",
        toggleLabel: "Page content",
        defaultZone: "main",
        body: <p>content body</p>,
      },
      {
        id: "metadata",
        title: "Page metadata",
        toggleLabel: "Page metadata",
        defaultZone: "side",
        body: <p>metadata body</p>,
      },
    ];
    const store = createMemoryBentoStore({
      page: [
        { id: "metadata", zone: "main", collapsed: false },
        { id: "content", zone: "main", collapsed: false },
      ],
    });
    render(
      <>
        <section className="content-studio">
          <EditorBento
            storageKey="page"
            ariaLabel="Page editor sections"
            panels={panels}
            store={store}
          />
        </section>
        <EditorLayoutMode />
      </>,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Customize section layout" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Restore default order" }),
    );

    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Side panel" })).toHaveTextContent(
        "metadata body",
      ),
    );
    expect(store.snapshot()).not.toHaveProperty("page");
    expect(
      within(
        screen.getByRole("group", { name: "Page section layout" }),
      ).getByRole("status"),
    ).toHaveTextContent("The default section order was restored.");

    fireEvent.click(screen.getByRole("button", { name: "Page content" }));
    expect(store.snapshot().page).toEqual([
      { id: "content", zone: "main", collapsed: true },
      { id: "metadata", zone: "side", collapsed: false },
    ]);
  });

  it("applies the normal mode to controls added after the editor opens", async () => {
    const { editor } = appendPageEditor();
    render(<EditorLayoutMode />);
    await screen.findByRole("button", { name: "Customize section layout" });

    const lateControls = document.createElement("div");
    lateControls.className = "editor-bento-card-controls";
    editor.append(lateControls);

    await waitFor(() =>
      expect(lateControls).toHaveAttribute("aria-hidden", "true"),
    );
    expect(lateControls.inert).toBe(true);
  });
});
