import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { createRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MediaGrid,
  gridColumnCount,
  restoreMediaFocus,
  type MediaGridHandle,
  type MediaGridProps,
} from "../src/components/media/MediaGrid";
import { MediaRow } from "../src/components/media/MediaRow";
import { MediaTile } from "../src/components/media/MediaTile";
import type { MediaAssetSummary } from "../src/lib/functions";
import { DEFAULT_MEDIA_DISPLAY } from "../src/lib/media-display";
import { emptySelection, type MediaSelection } from "../src/lib/media-selection";
import { categoryLabel, imageAsset } from "./media-tile-fixtures";

// The grid keyboard spec.
// jsdom has no layout, so the measured column count comes from a stubbed computed
// grid-template-columns and a stubbed ResizeObserver.

let columns = 4;
const observers: Array<() => void> = [];

class StubResizeObserver {
  constructor(private readonly callback: () => void) {
    observers.push(() => this.callback());
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

function setColumns(next: number) {
  columns = next;
  act(() => observers.forEach((notify) => notify()));
}

beforeEach(() => {
  columns = 4;
  observers.length = 0;
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
  const real = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element: Element, pseudo?: string | null) => {
    const style = real(element, pseudo);
    if (element instanceof HTMLElement && element.classList.contains("media-grid")) {
      const template = Array.from({ length: columns }, () => "200px").join(" ");
      Object.defineProperty(style, "gridTemplateColumns", { configurable: true, value: template });
    }
    return style;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.querySelectorAll("dialog").forEach((dialog) => dialog.remove());
});

const page: MediaAssetSummary[] = Array.from({ length: 10 }, (_, index) =>
  imageAsset({ id: `a${index}`, name: `Item ${index}` }));
const offPage = imageAsset({ id: "elsewhere", name: "On another page" });

interface HarnessProps {
  layout?: "grid" | "list";
  initial?: MediaSelection<MediaAssetSummary>;
  items?: MediaAssetSummary[];
  onOpen?: (item: MediaAssetSummary) => void;
  onQuickLook?: (item: MediaAssetSummary) => void;
  onEscape?: () => void;
  onChange?: (selection: MediaSelection<MediaAssetSummary>) => void;
  textFieldIn?: string;
  handle?: MediaGridProps<MediaAssetSummary>["handleRef"];
}

function Harness({
  handle,
  initial = emptySelection<MediaAssetSummary>(),
  items = page,
  layout = "grid",
  onChange,
  onEscape,
  onOpen = () => {},
  onQuickLook,
  textFieldIn,
}: HarnessProps) {
  const [selection, setSelection] = useState(initial);
  return (
    <>
      <input aria-label="Search images" id="search" type="search" />
      <MediaGrid
        handleRef={handle}
        items={items}
        label="Images"
        layout={layout}
        onEscape={onEscape}
        onOpen={onOpen}
        onQuickLook={onQuickLook}
        onSelectionChange={(next) => {
          setSelection(next);
          onChange?.(next);
        }}
        renderItem={(item, context) => layout === "list" ? (
          <MediaRow
            asset={item}
            canDelete
            categoryLabel={categoryLabel}
            favorite={false}
            fields={DEFAULT_MEDIA_DISPLAY.fields}
            onAction={() => {}}
            onOpen={() => onOpen(item)}
            onSelectChange={context.onSelectChange}
            selected={context.selected}
            tabbable={context.tabbable}
          />
        ) : (
          <>
            <MediaTile
              asset={item}
              canDelete
              categoryLabel={categoryLabel}
              favorite={false}
              fields={DEFAULT_MEDIA_DISPLAY.fields}
              onAction={() => {}}
              onOpen={() => onOpen(item)}
              onSelectChange={context.onSelectChange}
              selected={context.selected}
              selectionMode={context.selectionMode}
              surface="images"
              tabbable={context.tabbable}
            />
            {textFieldIn === item.id ? <input aria-label="Rename" type="text" /> : null}
          </>
        )}
        selection={selection}
      />
    </>
  );
}

const open = (index: number) => screen.getByRole("button", { name: new RegExp(`^Item ${index}, image`) });
const cell = (index: number) => open(index).closest("[role='gridcell']") as HTMLElement;
const selectedNames = () =>
  screen.getAllByRole("gridcell").filter((element) => element.getAttribute("aria-selected") === "true")
    .map((element) => within(element).getByRole("checkbox").closest("label")?.textContent ?? "");

function press(key: string, init: Partial<KeyboardEventInit> = {}) {
  const target = document.activeElement ?? document.body;
  return fireEvent.keyDown(target, { key, ...init });
}

describe("MediaGrid keyboard", () => {
  it("is one tab stop with roving focus", () => {
    render(<Harness />);
    const grid = screen.getByRole("grid", { name: "Images" });
    expect(grid).toHaveAttribute("aria-multiselectable", "true");
    const tabbable = [...grid.querySelectorAll<HTMLElement>("button, input")].filter((element) => element.tabIndex >= 0);
    // The focused card's name, then its checkbox and quick actions; every other
    // card's controls leave the tab order.
    expect(tabbable.map((element) => element.getAttribute("aria-label") ?? element.closest("label")?.textContent)).toEqual([
      "Item 0, image, 2.1 MB",
      "Select Item 0",
      "Add to favorites: Item 0",
      "Add to collection: Item 0",
      "More actions: Item 0",
    ]);

    open(0).focus();
    press("ArrowRight");
    expect(open(1)).toHaveFocus();
    expect(open(1).tabIndex).toBe(0);
    expect(open(0)).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("checkbox", { name: "Select Item 0" })).toHaveAttribute("tabindex", "-1");

    // Focus that arrives by pointer or Tab also moves the stop.
    fireEvent.focus(screen.getByRole("checkbox", { name: "Select Item 6" }));
    expect(open(6).tabIndex).toBe(0);
  });

  it("arrow keys move and wrap by the measured columns", () => {
    render(<Harness />);
    open(3).focus();
    press("ArrowRight");
    expect(open(4)).toHaveFocus();
    press("ArrowLeft");
    expect(open(3)).toHaveFocus();
    press("ArrowDown");
    expect(open(7)).toHaveFocus();
    // Down into the short last row (8 and 9) lands on its last item.
    press("ArrowDown");
    expect(open(9)).toHaveFocus();
    press("ArrowDown");
    expect(open(9)).toHaveFocus();
    press("ArrowUp");
    expect(open(5)).toHaveFocus();

    setColumns(3);
    press("ArrowDown");
    expect(open(8)).toHaveFocus();
  });

  it("Home, End, Cmd+Home, Cmd+End, PageUp and PageDown", () => {
    render(<Harness />);
    open(5).focus();
    press("Home");
    expect(open(4)).toHaveFocus();
    press("End");
    expect(open(7)).toHaveFocus();
    press("End", { ctrlKey: true });
    expect(open(9)).toHaveFocus();
    press("Home", { metaKey: true });
    expect(open(0)).toHaveFocus();
    // jsdom has no heights, so one row fits a screen.
    press("PageDown");
    expect(open(4)).toHaveFocus();
    press("PageDown");
    expect(open(8)).toHaveFocus();
    press("PageUp");
    expect(open(4)).toHaveFocus();
  });

  it("Space toggles and Shift+Arrow extends", () => {
    const onOpen = vi.fn();
    render(<Harness onOpen={onOpen} />);
    open(1).focus();
    const space = press(" ");
    expect(space).toBe(false);
    expect(onOpen).not.toHaveBeenCalled();
    expect(selectedNames()).toEqual(["Select Item 1"]);
    expect(cell(1)).toHaveAttribute("aria-selected", "true");

    press("ArrowRight", { shiftKey: true });
    press("ArrowRight", { shiftKey: true });
    expect(open(3)).toHaveFocus();
    expect(selectedNames()).toEqual(["Select Item 1", "Select Item 2", "Select Item 3"]);

    press(" ");
    expect(selectedNames()).toEqual(["Select Item 1", "Select Item 2"]);
  });

  it("Enter opens", () => {
    const onOpen = vi.fn();
    render(<Harness onOpen={onOpen} />);
    open(2).focus();
    press("Enter");
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(page[2]);
    expect(selectedNames()).toEqual([]);
  });

  it("Cmd or Ctrl+Y opens Quick Look only when the caller provides it", () => {
    const onQuickLook = vi.fn();
    const view = render(<Harness onQuickLook={onQuickLook} />);
    open(2).focus();
    expect(press("y", { metaKey: true })).toBe(false);
    expect(onQuickLook).toHaveBeenCalledWith(page[2]);

    view.rerender(<Harness />);
    open(3).focus();
    expect(press("y", { ctrlKey: true })).toBe(true);
    expect(onQuickLook).toHaveBeenCalledTimes(1);
  });

  it("Shift-click selects the range within the page", () => {
    const onChange = vi.fn();
    render(<Harness initial={{ items: [offPage], anchor: null, error: "" }} onChange={onChange} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Item 1" }));
    const thumbnail = cell(4).querySelector(".media-tile-thumb") as HTMLElement;
    fireEvent.click(thumbnail, { shiftKey: true });
    expect(selectedNames()).toEqual(["Select Item 1", "Select Item 2", "Select Item 3", "Select Item 4"]);
    // The off-page item stays; nothing outside the page joins.
    expect(onChange.mock.lastCall?.[0].items.map((item: MediaAssetSummary) => item.id)).toEqual([
      "elsewhere", "a1", "a2", "a3", "a4",
    ]);

    // Shift on a card's own checkbox extends too.
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Item 6" }), { shiftKey: true });
    expect(selectedNames()).toContain("Select Item 5");
  });

  it("Cmd or Ctrl-click toggles without opening", () => {
    const onOpen = vi.fn();
    render(<Harness onOpen={onOpen} />);
    fireEvent.click(open(2), { metaKey: true });
    expect(selectedNames()).toEqual(["Select Item 2"]);
    fireEvent.click(cell(5).querySelector(".media-tile-thumb") as HTMLElement, { ctrlKey: true });
    expect(selectedNames()).toEqual(["Select Item 2", "Select Item 5"]);
    fireEvent.click(open(2), { ctrlKey: true });
    expect(selectedNames()).toEqual(["Select Item 5"]);
    expect(onOpen).not.toHaveBeenCalled();
    expect(open(2).tabIndex).toBe(0);

    fireEvent.click(open(3));
    expect(onOpen).toHaveBeenCalledWith(page[3]);
  });

  it("rows regroup when the column count changes", () => {
    render(<Harness />);
    const grid = screen.getByRole("grid");
    const rowSizes = () => within(grid).getAllByRole("row").map((row) => within(row).getAllByRole("gridcell").length);
    expect(rowSizes()).toEqual([4, 4, 2]);
    for (const row of within(grid).getAllByRole("row")) {
      expect([...row.children].every((child) => child.getAttribute("role") === "gridcell")).toBe(true);
    }
    const tile = open(5);
    open(5).focus();

    setColumns(3);
    expect(rowSizes()).toEqual([3, 3, 3, 1]);
    // The card moved rows without remounting, and kept focus.
    expect(open(5)).toBe(tile);
    expect(tile).toHaveFocus();
    expect(within(within(grid).getAllByRole("row")[1]).getAllByRole("gridcell")[2]).toBe(cell(5));

    setColumns(2);
    expect(rowSizes()).toEqual([2, 2, 2, 2, 2]);
    expect(open(5)).toBe(tile);
  });

  it("keys do nothing from a text field or while a modal is open", () => {
    render(<Harness textFieldIn="a0" />);
    const rename = screen.getByRole("textbox", { name: "Rename" });
    rename.focus();
    press("ArrowRight");
    press(" ");
    expect(rename).toHaveFocus();
    expect(selectedNames()).toEqual([]);

    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    document.body.append(dialog);
    open(1).focus();
    press("ArrowRight");
    press(" ");
    expect(open(1)).toHaveFocus();
    expect(selectedNames()).toEqual([]);
  });

  it("Escape hands the cascade to the caller", () => {
    const onEscape = vi.fn();
    render(<Harness onEscape={onEscape} />);
    open(1).focus();
    press("Escape");
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it("the list layout keeps the keyboard model with Up and Down only", () => {
    render(<Harness layout="list" />);
    const grid = screen.getByRole("grid");
    expect(within(grid).getAllByRole("row")).toHaveLength(10);
    open(2).focus();
    press("ArrowDown");
    expect(open(3)).toHaveFocus();
    press("ArrowRight");
    expect(open(3)).toHaveFocus();
    press("ArrowUp");
    expect(open(2)).toHaveFocus();
    press(" ");
    expect(open(2).closest("[role='row']")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("checkbox", { name: "Select Item 4" })).toHaveAttribute("tabindex", "-1");
  });
});

describe("MediaGrid Cmd+A", () => {
  it("Cmd or Ctrl+A selects only the visible page and never unloaded results", () => {
    const onChange = vi.fn();
    render(<Harness initial={{ items: [offPage], anchor: null, error: "" }} onChange={onChange} />);
    open(0).focus();
    expect(press("a", { metaKey: true })).toBe(false);
    const ids = onChange.mock.lastCall?.[0].items.map((item: MediaAssetSummary) => item.id);
    expect(ids).toEqual(["elsewhere", ...page.map((item) => item.id)]);
    press("a", { ctrlKey: true });
    expect(onChange.mock.lastCall?.[0].items).toHaveLength(11);
  });

  it("Cmd+A in the search field keeps its text meaning", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} textFieldIn="a0" />);
    const search = screen.getByRole("searchbox", { name: "Search images" });
    search.focus();
    expect(press("a", { metaKey: true })).toBe(true);
    screen.getByRole("textbox", { name: "Rename" }).focus();
    expect(press("a", { ctrlKey: true })).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("MediaGrid focus return", () => {
  it("returns focus to the card that last had focus, else to the search field", () => {
    const handle = createRef<MediaGridHandle>();
    const search = () => screen.getByRole("searchbox", { name: "Search images" });
    const { rerender } = render(<Harness handle={handle} />);
    open(6).focus();
    search().focus();

    restoreMediaFocus(handle.current, () => search().focus());
    expect(open(6)).toHaveFocus();

    rerender(<Harness handle={handle} items={page.filter((item) => item.id !== "a6")} />);
    document.body.focus();
    restoreMediaFocus(handle.current, () => search().focus());
    expect(search()).toHaveFocus();
  });

  it("focuses an exact visible card after Quick Look stepping", () => {
    const handle = createRef<MediaGridHandle>();
    render(<Harness handle={handle} />);

    expect(handle.current?.focusItemById("a4")).toBe(true);
    expect(open(4)).toHaveFocus();
    expect(handle.current?.focusItemById("missing")).toBe(false);
    expect(open(4)).toHaveFocus();
  });
});

describe("gridColumnCount", () => {
  it("counts computed tracks and falls back to one column", () => {
    expect(gridColumnCount("200px 200px 200px")).toBe(3);
    expect(gridColumnCount("repeat(4, minmax(0px, 1fr))")).toBe(4);
    expect(gridColumnCount("minmax(0px, 1fr) 12rem")).toBe(2);
    expect(gridColumnCount("none")).toBe(1);
    expect(gridColumnCount("")).toBe(1);
  });
});
