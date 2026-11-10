import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OverflowToolbar, type OverflowToolbarItem } from "../src/components/ui/OverflowToolbar";
import { stubWidths } from "./helpers/layout-stubs";

function item(key: string, label: string, priority: number, onSelect = vi.fn()): OverflowToolbarItem {
  return {
    key,
    priority,
    node: <button data-width="120" onClick={onSelect} type="button">{label}</button>,
    menuItem: { key, label, onSelect },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("OverflowToolbar", () => {
  it("is a labeled toolbar with leading, center and trailing zones", () => {
    render(
      <OverflowToolbar
        items={[item("filter", "Filter", 2), item("sort", "Sort: Last updated", 1)]}
        label="Images actions"
        leading={<button type="button">Tab</button>}
        trailing={<button type="button">Upload</button>}
      />,
    );
    const toolbar = screen.getByRole("toolbar", { name: "Images actions" });
    for (const name of ["Tab", "Filter", "Sort: Last updated", "Upload"]) {
      expect(within(toolbar).getByRole("button", { name })).toBeInTheDocument();
    }
    expect(within(toolbar).queryByRole("button", { name: "More actions" })).toBeNull();
  });

  it("moves the lowest-priority controls into the More menu when space runs out", () => {
    stubWidths(300);
    const onSelect = vi.fn();
    render(
      <OverflowToolbar
        items={[item("filter", "Filter", 3), item("sort", "Sort: Last updated", 2), item("select", "Select page", 1, onSelect)]}
        label="Media actions"
      />,
    );
    act(() => window.dispatchEvent(new Event("resize")));

    const toolbar = screen.getByRole("toolbar", { name: "Media actions" });
    expect(within(toolbar).getByRole("button", { name: "Filter" })).toBeInTheDocument();
    expect(within(toolbar).queryByRole("button", { name: "Select page" })).toBeNull();

    fireEvent.click(within(toolbar).getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Select page" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("puts every center control in More when the trailing zone leaves no room", () => {
    stubWidths(320);
    render(
      <OverflowToolbar
        items={[item("filter", "Filter", 2), item("sort", "Sort", 1)]}
        label="Media actions"
        trailing={<button data-width="300" type="button">Upload</button>}
      />,
    );
    act(() => window.dispatchEvent(new Event("resize")));

    const toolbar = screen.getByRole("toolbar", { name: "Media actions" });
    expect(within(toolbar).queryByRole("button", { name: "Filter" })).toBeNull();
    expect(within(toolbar).getByRole("button", { name: "More actions" })).toBeInTheDocument();
  });

  it("moves between controls with arrow keys, Home and End, as one tab stop", () => {
    render(
      <OverflowToolbar
        items={[item("filter", "Filter", 2), item("sort", "Sort", 1)]}
        label="Media actions"
        trailing={<button type="button">Upload</button>}
      />,
    );
    const filter = screen.getByRole("button", { name: "Filter" });
    const sort = screen.getByRole("button", { name: "Sort" });
    const upload = screen.getByRole("button", { name: "Upload" });
    expect(filter).toHaveAttribute("tabindex", "0");
    expect(sort).toHaveAttribute("tabindex", "-1");

    filter.focus();
    fireEvent.keyDown(filter, { key: "ArrowRight" });
    expect(sort).toHaveFocus();
    expect(sort).toHaveAttribute("tabindex", "0");
    expect(filter).toHaveAttribute("tabindex", "-1");
    fireEvent.keyDown(sort, { key: "End" });
    expect(upload).toHaveFocus();
    fireEvent.keyDown(upload, { key: "ArrowRight" });
    expect(filter).toHaveFocus();
    fireEvent.keyDown(filter, { key: "ArrowLeft" });
    expect(upload).toHaveFocus();
  });

  it("leaves a search field's arrow keys and tab stop alone", () => {
    render(
      <OverflowToolbar
        items={[item("filter", "Filter", 1)]}
        label="Media actions"
        trailing={<input aria-label="Search media" type="search" />}
      />,
    );
    const search = screen.getByRole("searchbox", { name: "Search media" });
    expect(search).not.toHaveAttribute("tabindex", "-1");
    search.focus();
    fireEvent.keyDown(search, { key: "ArrowLeft" });
    expect(search).toHaveFocus();
  });

  it("mounts each control once, so refs point at the visible control", () => {
    let mounts = 0;
    function Counted() {
      useEffect(() => {
        mounts += 1;
      }, []);
      return <button data-width="120" type="button">Filter</button>;
    }
    render(
      <OverflowToolbar
        items={[{ key: "filter", priority: 1, node: <Counted />, menuItem: { key: "filter", label: "Filter", onSelect: vi.fn() } }]}
        label="Media actions"
      />,
    );
    expect(mounts).toBe(1);
  });

  it("moves the tab stop to a control focused by pointer", () => {
    render(<OverflowToolbar items={[item("filter", "Filter", 2), item("sort", "Sort", 1)]} label="Media actions" />);
    const filter = screen.getByRole("button", { name: "Filter" });
    const sort = screen.getByRole("button", { name: "Sort" });
    fireEvent.focus(sort);
    expect(sort).toHaveAttribute("tabindex", "0");
    expect(filter).toHaveAttribute("tabindex", "-1");
  });

  it("remeasures when a control's own width changes", () => {
    const observers: Array<{ callback: ResizeObserverCallback; targets: Element[] }> = [];
    vi.stubGlobal("ResizeObserver", class {
      targets: Element[] = [];
      constructor(callback: ResizeObserverCallback) {
        observers.push({ callback, targets: this.targets });
      }
      observe(target: Element) { this.targets.push(target); }
      unobserve() {}
      disconnect() {}
    });
    stubWidths(300);
    function Harness() {
      const [wide, setWide] = useState(false);
      return (
        <OverflowToolbar
          items={[
            item("filter", "Filter", 2),
            {
              key: "sort",
              priority: 1,
              node: <button data-width={wide ? "260" : "120"} onClick={() => setWide(true)} type="button">Sort</button>,
              menuItem: { key: "sort", label: "Sort", onSelect: vi.fn() },
            },
          ]}
          label="Media actions"
        />
      );
    }
    render(<Harness />);
    const sort = screen.getByRole("button", { name: "Sort" });
    const wrapper = sort.parentElement as Element;
    expect(observers.some((observer) => observer.targets.includes(wrapper))).toBe(true);
    fireEvent.click(sort);
    act(() => {
      for (const observer of observers) observer.callback([], {} as ResizeObserver);
    });
    expect(screen.queryByRole("button", { name: "Sort" })).toBeNull();
    expect(screen.getByRole("button", { name: "More actions" })).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("reserves the rendered gap and More width, which grow with the text size", () => {
    stubWidths(300);
    const real = window.getComputedStyle;
    vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
      const style = real(element, pseudo);
      if (!(element as HTMLElement).classList?.contains("ui-overflow-toolbar-center")) return style;
      return { ...style, columnGap: "16px", minWidth: "88px", paddingLeft: "0px", paddingRight: "0px" } as CSSStyleDeclaration;
    });
    render(
      <OverflowToolbar
        items={[item("filter", "Filter", 3), item("sort", "Sort", 2), item("select", "Select page", 1)]}
        label="Media actions"
      />,
    );
    act(() => window.dispatchEvent(new Event("resize")));
    // 8px and 44px would keep two controls; the rendered 16px and 88px keep one.
    expect(screen.getByRole("button", { name: "Filter" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sort" })).toBeNull();
  });

  it("clips overflow outside the focus ring's reach", () => {
    const css = readFileSync(resolve(process.cwd(), "src/components/ui/OverflowToolbar.css"), "utf8");
    const center = css.match(/\.ui-overflow-toolbar-center \{([^}]*)\}/)?.[1] ?? "";
    expect(center).toMatch(/overflow: hidden;/);
    expect(center).toMatch(/padding: var\(--ui-overflow-toolbar-ring\);/);
    expect(center).toMatch(/margin: calc\(-1 \* var\(--ui-overflow-toolbar-ring\)\);/);
  });

  it("keeps trailing controls until every center control is in More, then collapses them too", () => {
    const onDisplay = vi.fn();
    const display: OverflowToolbarItem = {
      key: "display",
      priority: 1,
      zone: "trailing",
      node: <button data-width="90" type="button">Display</button>,
      menuItem: { key: "display", label: "Display", onSelect: onDisplay },
    };
    const view = () => (
      <OverflowToolbar
        items={[item("filter", "Filter", 1), display]}
        label="Media actions"
        search={<input aria-label="Search media" data-width="44" type="search" />}
        trailing={<button data-width="115" type="button">Upload</button>}
      />
    );
    // 320: Filter would need room beside Display and Upload, so it moves to More; Display stays.
    const stub = stubWidths(320);
    const { rerender } = render(view());
    act(() => window.dispatchEvent(new Event("resize")));
    const toolbar = screen.getByRole("toolbar", { name: "Media actions" });
    expect(within(toolbar).queryByRole("button", { name: "Filter" })).toBeNull();
    expect(within(toolbar).getByRole("button", { name: "Display" })).toBeInTheDocument();
    // Search comes first in the trailing zone, then trailing controls, then fixed content.
    const trailingZone = toolbar.querySelector(".ui-overflow-toolbar-trailing") as HTMLElement;
    expect(Array.from(trailingZone.querySelectorAll("input, button")).map((element) => element.getAttribute("aria-label") ?? element.textContent))
      .toEqual(["Search media", "Display", "Upload"]);

    // 250: Display no longer fits beside More and Upload, so More absorbs it.
    stub.mockRestore();
    stubWidths(250);
    rerender(view());
    act(() => window.dispatchEvent(new Event("resize")));
    expect(within(toolbar).queryByRole("button", { name: "Display" })).toBeNull();
    expect(within(toolbar).getByRole("button", { name: "Upload" })).toBeInTheDocument();
    fireEvent.click(within(toolbar).getByRole("button", { name: "More actions" }));
    const menuItems = screen.getAllByRole("menuitem").map((element) => element.textContent);
    expect(menuItems).toEqual(["Filter", "Display"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Display" }));
    expect(onDisplay).toHaveBeenCalledTimes(1);
  });

  it("keeps a More with fixed items after the trailing controls at every width, and lists collapsed controls first", () => {
    const onShortcuts = vi.fn();
    const display: OverflowToolbarItem = {
      key: "display",
      priority: 1,
      zone: "trailing",
      node: <button data-width="90" type="button">Display</button>,
      menuItem: { key: "display", label: "Display", onSelect: vi.fn() },
    };
    const view = () => (
      <OverflowToolbar
        items={[display]}
        label="Media actions"
        moreItems={[{ key: "shortcuts", label: "Keyboard shortcuts", group: "help", onSelect: onShortcuts }]}
        search={<input aria-label="Search media" data-width="44" type="search" />}
        trailing={<button data-width="115" type="button">Upload</button>}
      />
    );
    const stub = stubWidths(600);
    const { rerender } = render(view());
    act(() => window.dispatchEvent(new Event("resize")));
    const toolbar = screen.getByRole("toolbar", { name: "Media actions" });
    const trailingZone = toolbar.querySelector(".ui-overflow-toolbar-trailing") as HTMLElement;
    // Nothing has collapsed, yet More is there, after Display and before the fixed content.
    expect(Array.from(trailingZone.querySelectorAll("input, button")).map((element) => element.getAttribute("aria-label") ?? element.textContent))
      .toEqual(["Search media", "Display", "More actions", "Upload"]);
    expect(toolbar.querySelector(".ui-overflow-toolbar-center")?.children).toHaveLength(0);
    // A page can style the always-shown More apart from one that appears only on overflow.
    expect(within(toolbar).getByRole("button", { name: "More actions" })).toHaveClass("ui-overflow-toolbar-more", "ui-overflow-toolbar-more-fixed");
    fireEvent.focus(within(toolbar).getByRole("button", { name: "More actions" }));
    expect(document.querySelector('[role="tooltip"]')).toHaveTextContent("More actions");
    fireEvent.click(within(toolbar).getByRole("button", { name: "More actions" }));
    expect(screen.getAllByRole("menuitem").map((element) => element.textContent)).toEqual(["Keyboard shortcuts"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Keyboard shortcuts" }));
    expect(onShortcuts).toHaveBeenCalledTimes(1);

    // 250: Display folds into the same More, listed before the fixed items and set apart.
    stub.mockRestore();
    stubWidths(250);
    rerender(view());
    act(() => window.dispatchEvent(new Event("resize")));
    expect(within(toolbar).queryByRole("button", { name: "Display" })).toBeNull();
    expect(within(toolbar).getAllByRole("button", { name: "More actions" })).toHaveLength(1);
    expect(trailingZone).toContainElement(within(toolbar).getByRole("button", { name: "More actions" }));
    fireEvent.click(within(toolbar).getByRole("button", { name: "More actions" }));
    const menu = screen.getByRole("menu", { name: "More actions" });
    expect(within(menu).getAllByRole("menuitem").map((element) => element.textContent)).toEqual(["Display", "Keyboard shortcuts"]);
    expect(within(menu).getAllByRole("separator")).toHaveLength(1);
  });

  it("never shrinks a trailing button below its label", () => {
    const css = readFileSync(resolve(process.cwd(), "src/components/ui/OverflowToolbar.css"), "utf8");
    expect(css).toMatch(/\.ui-overflow-toolbar-trailing > :not\(input\) \{\s*flex: none;/);
  });

  it("measures a .ui-overflow-toolbar-search wrapper at its 19rem preferred and 7rem minimum widths like a bare input", () => {
    const real = window.getComputedStyle;
    vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
      const style = real(element, pseudo);
      if (!(element as HTMLElement).classList?.contains("ui-overflow-toolbar-search")) return style;
      return { ...style, flexBasis: "304px", minWidth: "112px" } as CSSStyleDeclaration;
    });
    const display: OverflowToolbarItem = {
      key: "display",
      priority: 1,
      zone: "trailing",
      node: <button data-width="90" type="button">Display</button>,
      menuItem: { key: "display", label: "Display", onSelect: vi.fn() },
    };
    const view = () => (
      <OverflowToolbar
        items={[item("filter", "Filter", 1), display]}
        label="Media actions"
        search={(
          <form className="ui-overflow-toolbar-search" data-width="200" role="search">
            <input aria-label="Search media" type="search" />
          </form>
        )}
      />
    );
    // 480: at its 304px basis the field leaves Filter no room, though its current 200px would.
    const stub = stubWidths(480);
    const { rerender } = render(view());
    act(() => window.dispatchEvent(new Event("resize")));
    const toolbar = screen.getByRole("toolbar", { name: "Media actions" });
    expect(within(toolbar).queryByRole("button", { name: "Filter" })).toBeNull();
    expect(within(toolbar).getByRole("button", { name: "Display" })).toBeInTheDocument();

    // 300: at its 112px minimum the field leaves Display room, though its current 200px would not.
    stub.mockRestore();
    stubWidths(300);
    rerender(view());
    act(() => window.dispatchEvent(new Event("resize")));
    expect(within(toolbar).getByRole("button", { name: "Display" })).toBeInTheDocument();
  });

  it("keeps controls inside the search wrapper on native tab stops, out of the roving order", () => {
    render(
      <OverflowToolbar
        items={[item("filter", "Filter", 1)]}
        label="Media actions"
        search={(
          <form className="ui-overflow-toolbar-search" role="search">
            <input aria-label="Search media" type="search" />
            <button type="button">Clear search</button>
          </form>
        )}
        trailing={<button type="button">Upload</button>}
      />,
    );
    const filter = screen.getByRole("button", { name: "Filter" });
    const clear = screen.getByRole("button", { name: "Clear search" });
    const upload = screen.getByRole("button", { name: "Upload" });
    expect(clear).not.toHaveAttribute("tabindex");
    expect(upload).toHaveAttribute("tabindex", "-1");

    fireEvent.focus(clear);
    expect(filter).toHaveAttribute("tabindex", "0");
    clear.focus();
    fireEvent.keyDown(clear, { key: "ArrowRight" });
    expect(clear).toHaveFocus();

    filter.focus();
    fireEvent.keyDown(filter, { key: "ArrowRight" });
    expect(upload).toHaveFocus();
    fireEvent.keyDown(upload, { key: "ArrowRight" });
    expect(filter).toHaveFocus();
  });
});
