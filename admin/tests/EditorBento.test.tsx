import { useEffect, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { EditorBento, type BentoPanel } from "../src/components/EditorBento";
import { PagePreview } from "../src/components/PagePreview";
import { createMemoryBentoStore } from "../src/lib/editor-bento-store";
import type { PreviewRequestResponse } from "../src/lib/functions";

afterEach(cleanup);

function panels(): BentoPanel[] {
  return [
    {
      id: "content",
      title: "Page content",
      outlineLabel: "Page content",
      defaultZone: "main",
      allowedZones: ["main"],
      body: <p>content body</p>,
    },
    { id: "metadata", title: "Page metadata", defaultZone: "side", body: <p>metadata body</p> },
    {
      id: "preview",
      title: "Preview",
      defaultZone: "side",
      defaultCollapsed: true,
      body: <p>preview body</p>,
    },
  ];
}

function zone(name: "Main area" | "Side panel"): HTMLElement {
  return screen.getByRole("region", { name });
}

describe("EditorBento", () => {
  it("keeps a noncollapsible summary panel open despite an older collapsed preference without rewriting it", () => {
    const store = createMemoryBentoStore({ page: [{ id: "identity", zone: "side", collapsed: true }] });
    const save = vi.spyOn(store, "save");
    render(<EditorBento storageKey="page" panels={[{ id: "identity", title: "Post identity", defaultZone: "side", collapsible: false, body: <input aria-label="Canonical byline" /> }]} store={store} />);
    expect(screen.getByRole("textbox", { name: "Canonical byline" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Post identity" })).not.toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
    expect(store.snapshot().page[0].collapsed).toBe(true);
  });

  it("places panels in their default zones and starts collapsed panels closed", () => {
    render(<EditorBento storageKey="page" panels={panels()} store={createMemoryBentoStore()} />);

    expect(within(zone("Main area")).getByText("content body")).toBeVisible();
    expect(within(zone("Side panel")).getByText("metadata body")).toBeVisible();
    // Preview defaults collapsed, so its body stays mounted but hidden (not removed), preserving
    // any state it holds across a collapse/expand.
    expect(screen.getByText("preview body")).not.toBeVisible();
    expect(
      screen.getByRole("button", { name: "Preview" }).getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("collapses and expands a panel body", () => {
    render(<EditorBento storageKey="page" panels={panels()} store={createMemoryBentoStore()} />);

    const toggle = screen.getByRole("button", { name: "Page metadata" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    // Collapsed hides the body but keeps it mounted, so its state survives.
    expect(screen.getByText("metadata body")).not.toBeVisible();
    fireEvent.click(toggle);
    expect(screen.getByText("metadata body")).toBeVisible();
  });

  it("uses the document outline to reveal settings without remounting them", () => {
    function Counter() {
      const [count, setCount] = useState(0);
      return (
        <button type="button" onClick={() => setCount((value) => value + 1)}>
          settings count {count}
        </button>
      );
    }

    const outlinedPanels = panels().map((panel) => {
      if (panel.id === "content") {
        return { ...panel, body: <input aria-label="Page title" /> };
      }
      return panel.id === "metadata" ? { ...panel, body: <Counter /> } : panel;
    });
    render(
      <EditorBento
        storageKey="page"
        panels={outlinedPanels}
        documentOutline={{ heading: "Document", settingsLabel: "Page settings" }}
        store={createMemoryBentoStore()}
      />,
    );

    const outline = screen.getByRole("navigation", { name: "Document sections" });
    const contentOutline = within(outline).getByRole("button", { name: "Page content" });
    const settingsOutline = within(outline).getByRole("button", { name: "Page settings" });
    fireEvent.focus(screen.getByRole("textbox", { name: "Page title" }));
    expect(contentOutline).toHaveAttribute("aria-current", "location");
    expect(settingsOutline).not.toHaveAttribute("aria-current");

    const settingsControl = screen.getByRole("button", { name: "settings count 0" });
    fireEvent.focus(settingsControl);
    expect(settingsOutline).toHaveAttribute("aria-current", "location");
    expect(contentOutline).not.toHaveAttribute("aria-current");
    fireEvent.click(settingsControl);
    const metadataToggle = screen.getByRole("button", { name: "Page metadata" });
    fireEvent.click(metadataToggle);
    expect(metadataToggle).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(settingsOutline);

    expect(metadataToggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "settings count 1" })).toBeVisible();
    expect(metadataToggle).toHaveFocus();
  });

  it("moves a panel to the other zone and persists it", () => {
    const store = createMemoryBentoStore();
    render(<EditorBento storageKey="page" panels={panels()} store={store} />);

    fireEvent.keyDown(screen.getByRole("button", { name: "Move section: Page metadata" }), {
      key: "ArrowLeft",
    });

    expect(within(zone("Main area")).getByText("metadata body")).toBeInTheDocument();
    const saved = store.snapshot().page;
    expect(saved.find((p) => p.id === "metadata")?.zone).toBe("main");
    // A live region reports the move for assistive tech.
    expect(screen.getByRole("status").textContent).toMatch(/Page metadata moved to the main area/i);
  });

  it("reorders within a zone and stops at its keyboard boundaries", () => {
    const store = createMemoryBentoStore();
    const save = vi.spyOn(store, "save");
    render(<EditorBento storageKey="page" panels={panels()} store={store} />);

    const metadataGrip = screen.getByRole("button", { name: "Move section: Page metadata" });
    // Metadata is first in the side zone. Up keeps it at the boundary.
    fireEvent.keyDown(metadataGrip, { key: "ArrowUp" });
    expect(
      within(zone("Side panel"))
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual(["Page metadata", "Preview"]);
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();

    fireEvent.keyDown(metadataGrip, { key: "ArrowDown" });

    const sidePanel = zone("Side panel");
    expect(
      within(sidePanel)
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual(["Preview", "Page metadata"]);
    expect(save).toHaveBeenCalledOnce();
    const announcement = screen.getByRole("status").textContent;
    expect(announcement).toMatch(/Page metadata moved down, position 2 of 2/i);

    // Metadata is now last. Down keeps it at the other boundary.
    save.mockClear();
    fireEvent.keyDown(
      within(sidePanel).getByRole("button", { name: "Move section: Page metadata" }),
      { key: "ArrowDown" },
    );
    expect(
      within(sidePanel)
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual(["Preview", "Page metadata"]);
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent(announcement ?? "");
  });

  it("keeps Page content reorderable within the main zone", () => {
    render(<EditorBento storageKey="page" panels={panels()} store={createMemoryBentoStore()} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "Move section: Page metadata" }), {
      key: "ArrowLeft",
    });

    fireEvent.keyDown(screen.getByRole("button", { name: "Move section: Page content" }), {
      key: "ArrowDown",
    });

    expect(
      within(zone("Main area"))
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual(["Page metadata", "Page content"]);
    expect(within(zone("Main area")).getByText("content body")).toBeInTheDocument();
  });

  it("keeps a collapsed panel's body mounted so its state survives", () => {
    // A body with local state: a remount on collapse would reset it to zero.
    function Counter() {
      const [n, setN] = useState(0);
      return (
        <button type="button" onClick={() => setN((value) => value + 1)}>
          count {n}
        </button>
      );
    }
    const stateful: BentoPanel[] = [
      {
        id: "content",
        title: "Page content",
        defaultZone: "main",
        allowedZones: ["main"],
        body: <Counter />,
      },
    ];
    render(
      <EditorBento storageKey="page" panels={stateful} store={createMemoryBentoStore()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "count 0" }));
    fireEvent.click(screen.getByRole("button", { name: "count 1" }));
    // Collapse then expand.
    fireEvent.click(screen.getByRole("button", { name: "Page content" }));
    fireEvent.click(screen.getByRole("button", { name: "Page content" }));
    // The count is preserved; a remount would have reset it to zero.
    expect(screen.getByRole("button", { name: "count 2" })).toBeInTheDocument();
  });

  it("keeps a panel body mounted when moving it between zones", () => {
    let mounts = 0;
    let unmounts = 0;
    function Counter() {
      const [n, setN] = useState(0);
      useEffect(() => {
        mounts += 1;
        return () => {
          unmounts += 1;
        };
      }, []);
      return (
        <button type="button" onClick={() => setN((value) => value + 1)}>
          count {n}
        </button>
      );
    }
    const stateful: BentoPanel[] = [
      { id: "metadata", title: "Page metadata", defaultZone: "side", body: <Counter /> },
    ];
    render(
      <EditorBento storageKey="page" panels={stateful} store={createMemoryBentoStore()} />,
    );

    const counter = screen.getByRole("button", { name: "count 0" });
    fireEvent.click(counter);
    fireEvent.keyDown(screen.getByRole("button", { name: "Move section: Page metadata" }), {
      key: "ArrowLeft",
    });

    const movedCounter = within(zone("Main area")).getByRole("button", { name: "count 1" });
    expect(movedCounter).toBe(counter);
    expect(movedCounter).toBeVisible();
    expect(screen.getAllByRole("button", { name: "count 1" })).toHaveLength(1);
    expect(mounts).toBe(1);
    expect(unmounts).toBe(0);
  });

  it("uses connected DOM moves so browser-owned panel state can survive reparenting", () => {
    type AtomicMoveElement = Element & {
      moveBefore?: (node: Node, child: Node | null) => void;
    };
    const elementPrototype = Element.prototype as AtomicMoveElement;
    const originalMoveBefore = elementPrototype.moveBefore;
    const moveBefore = vi.fn(function (
      this: Element,
      node: Node,
      child: Node | null,
    ) {
      this.insertBefore(node, child);
    });
    Object.defineProperty(Element.prototype, "moveBefore", {
      configurable: true,
      value: moveBefore,
      writable: true,
    });

    try {
      const movablePanels: BentoPanel[] = [
        {
          id: "metadata",
          title: "Page metadata",
          defaultZone: "side",
          body: <input aria-label="Focused draft" defaultValue="Draft text" />,
        },
      ];
      render(
        <EditorBento
          storageKey="page"
          panels={movablePanels}
          store={createMemoryBentoStore()}
        />,
      );
      const input = screen.getByRole("textbox", { name: "Focused draft" });
      const bodyHost = input.closest(".editor-bento-card-body-mount");
      if (!bodyHost) throw new Error("Expected the panel body host.");

      fireEvent.keyDown(screen.getByRole("button", { name: "Move section: Page metadata" }), {
        key: "ArrowLeft",
      });

      const hostMoves = moveBefore.mock.calls.filter(([node]) => node === bodyHost);
      expect(hostMoves).toHaveLength(2);
      expect(within(zone("Main area")).getByRole("textbox", { name: "Focused draft" })).toBe(
        input,
      );
    } finally {
      if (originalMoveBefore) {
        Object.defineProperty(Element.prototype, "moveBefore", {
          configurable: true,
          value: originalMoveBefore,
          writable: true,
        });
      } else {
        delete elementPrototype.moveBefore;
      }
    }
  });

  it("keeps a pending preview request alive when moving its panel", async () => {
    let resolvePreview: ((value: PreviewRequestResponse) => void) | undefined;
    const requestPreview = () =>
      new Promise<PreviewRequestResponse>((resolve) => {
        resolvePreview = resolve;
      });
    const previewPanel: BentoPanel[] = [
      {
        id: "preview",
        title: "Preview",
        defaultZone: "side",
        body: (
          <PagePreview
            pageId="home"
            pagePath="/"
            dirty={false}
            saving={false}
            requestPreview={requestPreview}
            loadPreviewStatus={async () => {
              throw new Error("Polling is not expected in this test.");
            }}
            headless
          />
        ),
      },
    ];
    render(
      <EditorBento
        storageKey="page"
        panels={previewPanel}
        store={createMemoryBentoStore()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Build preview" }));
    expect(within(zone("Side panel")).getByText("Requesting")).toBeVisible();
    fireEvent.keyDown(screen.getByRole("button", { name: "Move section: Preview" }), {
      key: "ArrowLeft",
    });
    expect(within(zone("Main area")).getByText("Requesting")).toBeVisible();

    await act(async () => {
      resolvePreview?.({
        success: true,
        queueId: "queue123",
        pageId: "home",
        sourceVersion: 7,
        dispatched: true,
        status: "building",
      });
    });

    expect(within(zone("Main area")).getByText(/Building saved version 7/)).toBeVisible();
  });

  it("exposes movable grips as keyboard controls and omits an immovable grip", () => {
    render(<EditorBento storageKey="page" panels={panels()} store={createMemoryBentoStore()} />);

    const contentCard = screen.getByRole("article", { name: "Page content" });
    expect(within(contentCard).queryByRole("button", { name: "Move section: Page content" })).toBeNull();
    const grip = screen.getByRole("button", { name: "Move section: Page metadata" });
    expect(grip).toHaveClass("editor-bento-grip");
    expect(grip).toHaveAttribute(
      "aria-keyshortcuts",
      "ArrowUp ArrowDown ArrowLeft ArrowRight",
    );
    expect(grip).toHaveAccessibleDescription(
      /use Up or Down to reorder, Left to move to the main area, or Right to move to the side panel/i,
    );
    expect(grip).toHaveAttribute("draggable", "true");
  });

  it("rejects a keyboard move to a disallowed zone", () => {
    const store = createMemoryBentoStore();
    const save = vi.spyOn(store, "save");
    render(<EditorBento storageKey="page" panels={[...panels(), { id: "title", title: "Title", defaultZone: "main", allowedZones: ["main"], body: <p>title body</p> }]} store={store} />);

    fireEvent.keyDown(screen.getByRole("button", { name: "Move section: Page content" }), {
      key: "ArrowRight",
    });

    expect(within(zone("Main area")).getByText("content body")).toBeInTheDocument();
    expect(within(zone("Side panel")).queryByText("content body")).not.toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("rejects a pointer drop that would move Page content to the side", () => {
    const store = createMemoryBentoStore();
    render(<EditorBento storageKey="page" panels={[...panels(), { id: "title", title: "Title", defaultZone: "main", allowedZones: ["main"], body: <p>title body</p> }]} store={store} />);
    const contentCard = screen.getByRole("article", { name: "Page content" });
    const contentGrip = contentCard.querySelector(".editor-bento-grip");
    if (!contentGrip) throw new Error("Expected the Page content drag grip.");
    const dataTransfer = {
      effectAllowed: "none",
      dropEffect: "none",
      setData() {},
    };

    fireEvent.dragStart(contentGrip, { dataTransfer });
    fireEvent.dragOver(zone("Side panel"), { dataTransfer });
    fireEvent.drop(zone("Side panel"), { dataTransfer });

    expect(within(zone("Main area")).getByText("content body")).toBeInTheDocument();
    expect(within(zone("Side panel")).queryByText("content body")).not.toBeInTheDocument();
    expect(store.snapshot().page?.find((panel) => panel.id === "content")?.zone).not.toBe(
      "side",
    );
  });

  it("keeps Page content in the main region when the bento stacks at a narrow width", () => {
    render(
      <div style={{ width: "20rem" }}>
        <EditorBento storageKey="page" panels={[...panels(), { id: "title", title: "Title", defaultZone: "main", allowedZones: ["main"], body: <p>title body</p> }]} store={createMemoryBentoStore()} />
      </div>,
    );

    fireEvent.keyDown(screen.getByRole("button", { name: "Move section: Page content" }), {
      key: "ArrowRight",
    });

    expect(within(zone("Main area")).getByText("content body")).toBeInTheDocument();
    expect(within(zone("Side panel")).queryByText("content body")).not.toBeInTheDocument();
  });

  it("restores focus to the moved card's grip after a cross-zone move", () => {
    render(<EditorBento storageKey="page" panels={panels()} store={createMemoryBentoStore()} />);

    const grip = screen.getByRole("button", { name: "Move section: Page metadata" });
    grip.focus();
    fireEvent.keyDown(grip, { key: "ArrowLeft" });

    expect(
      within(zone("Main area")).getByRole("button", { name: "Move section: Page metadata" }),
    ).toHaveFocus();
  });

  it("restores focus to the moved card's grip after a same-zone reorder", () => {
    render(<EditorBento storageKey="page" panels={panels()} store={createMemoryBentoStore()} />);

    const grip = screen.getByRole("button", { name: "Move section: Page metadata" });
    grip.focus();
    fireEvent.keyDown(grip, { key: "ArrowDown" });

    expect(
      within(zone("Side panel")).getByRole("button", { name: "Move section: Page metadata" }),
    ).toHaveFocus();
  });

  it("leaves ordinary drops inside panel controls to the control", () => {
    const editablePanels: BentoPanel[] = [
      {
        id: "metadata",
        title: "Page metadata",
        defaultZone: "main",
        body: (
          <>
            <input aria-label="Page title" />
            <textarea aria-label="Page summary" />
            <div aria-label="Page body" contentEditable role="textbox" />
            <input aria-label="Hide from search engines" type="checkbox" />
          </>
        ),
      },
    ];
    render(
      <EditorBento
        storageKey="page"
        panels={editablePanels}
        store={createMemoryBentoStore()}
      />,
    );

    for (const name of ["Page title", "Page summary", "Page body"]) {
      const drop = new Event("drop", { bubbles: true, cancelable: true });
      screen.getByRole("textbox", { name }).dispatchEvent(drop);

      expect(drop.defaultPrevented).toBe(false);
    }

    const checkboxDrop = new Event("drop", { bubbles: true, cancelable: true });
    screen.getByRole("checkbox", { name: "Hide from search engines" }).dispatchEvent(checkboxDrop);

    expect(checkboxDrop.defaultPrevented).toBe(true);
  });

  it("blocks external drops on nested non-editable card content", () => {
    render(<EditorBento storageKey="page" panels={panels()} store={createMemoryBentoStore()} />);

    const drop = new Event("drop", { bubbles: true, cancelable: true });
    screen.getByText("content body").dispatchEvent(drop);

    expect(drop.defaultPrevented).toBe(true);
  });

  it("keeps card drag and drop working over a portaled panel body", () => {
    render(<EditorBento storageKey="page" panels={panels()} store={createMemoryBentoStore()} />);
    const dataTransfer = {
      effectAllowed: "none",
      dropEffect: "none",
      setData() {},
    };
    const contentBody = screen.getByText("content body");
    const metadataBody = screen.getByText("metadata body");
    const contentCard = contentBody.closest("article");
    const metadataCard = screen.getByRole("article", { name: "Page metadata" });
    const metadataGrip = metadataCard.querySelector(".editor-bento-grip");
    if (!contentCard) throw new Error("Expected the content body to be inside its card.");
    if (!metadataGrip) throw new Error("Expected the metadata card to have a drag grip.");
    contentCard.getBoundingClientRect = () => ({ top: 0, height: 100 }) as DOMRect;

    fireEvent.dragStart(metadataGrip, { dataTransfer });
    fireEvent.dragOver(contentBody, { clientY: 10, dataTransfer });
    fireEvent.drop(contentBody, { clientY: 10, dataTransfer });

    expect(
      within(zone("Main area"))
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual(["Page metadata", "Page content"]);
    expect(within(zone("Main area")).getByText("metadata body")).toBe(metadataBody);
  });

  it("restores a persisted arrangement on mount", () => {
    const store = createMemoryBentoStore({
      page: [
        { id: "metadata", zone: "main", collapsed: false },
        { id: "content", zone: "side", collapsed: false },
        { id: "preview", zone: "side", collapsed: false },
      ],
    });
    render(<EditorBento storageKey="page" panels={panels()} store={store} />);

    expect(within(zone("Main area")).getByText("metadata body")).toBeInTheDocument();
    expect(within(zone("Main area")).getByText("content body")).toBeInTheDocument();
    expect(within(zone("Side panel")).queryByText("content body")).not.toBeInTheDocument();
    expect(zone("Main area")).toHaveAttribute("data-empty", "false");
  });
});
