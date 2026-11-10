import {
  cloneElement,
  isValidElement,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import { mediaGridKeyAction } from "../../lib/media-grid-keys";
import {
  changeSelection,
  selectRange,
  setPageSelection,
  type MediaSelection,
  type SelectableMedia,
  type SelectionRules,
} from "../../lib/media-selection";
import "./MediaGrid.css";

// The shared media grid (the WAI-ARIA APG grid pattern).
// One tab stop per grid: the focused card's name. Tab then walks that card's checkbox and
// quick actions and leaves the grid. Arrow, Home, End and Page keys
// follow media-grid-keys. Space toggles, Enter opens, Shift+Arrow extends, Cmd or Ctrl+A
// selects the page on screen only, and Escape goes to the caller's cascade.
//
// Rows exist for the ARIA grid only (display: contents), so the layout is the CSS auto-fill
// grid. The grid measures its column count and regroups cells into rows when it changes.
// Each card renders through a portal into its own cell element, and the cells move between
// rows by DOM moves, so a regroup never remounts a card or restarts its image or poster.

export interface MediaGridItemContext {
  index: number;
  /** This card holds the grid's one tab stop. Pass it to MediaTile or MediaRow. */
  tabbable: boolean;
  selected: boolean;
  /** Something on this surface is selected. */
  selectionMode: boolean;
  /** The card's checkbox. Shift extends a range within the page. */
  onSelectChange: (checked: boolean, modifiers: { shiftKey: boolean }) => void;
}

export interface MediaGridHandle {
  /** Focuses the card that last had focus. False when there is none or it is gone. */
  focusLastCard: () => boolean;
  /** Focuses one exact visible card. False when it is gone or has no open control. */
  focusItemById: (id: string) => boolean;
}

export interface MediaGridProps<T extends SelectableMedia> {
  /** The grid's name, such as "Images". */
  label: string;
  /** The visible page. Nothing outside it is read or selected by a key. */
  items: readonly T[];
  layout?: "grid" | "list";
  selection: MediaSelection<T>;
  onSelectionChange: (selection: MediaSelection<T>) => void;
  rules?: SelectionRules<T>;
  /** A MediaTile in the grid layout; a MediaRow, which is its own row, in the list layout. */
  renderItem: (item: T, context: MediaGridItemContext) => ReactNode;
  onOpen: (item: T) => void;
  /** Opens a light preview for the focused card. Without it, Cmd or Ctrl+Y keeps its browser action. */
  onQuickLook?: (item: T) => void;
  /** The caller's Escape cascade: clear the selection, else close details, else clear search. */
  onEscape?: () => void;
  /** The list layout's header row, such as MediaRowHeader. */
  header?: ReactNode;
  className?: string;
  /** A side editor owns this page while its selection is being changed. */
  inert?: boolean;
  handleRef?: Ref<MediaGridHandle>;
}

/** The track count of a computed grid-template-columns value; 1 when it cannot tell. */
export function gridColumnCount(template: string): number {
  const value = template.replace(/\[[^\]]*\]/g, " ").trim();
  if (!value || value === "none") return 1;
  const repeat = value.match(/^repeat\(\s*(\d+)\s*,/);
  if (repeat) return Math.max(1, Number(repeat[1]));
  let depth = 0;
  let count = 0;
  let inTrack = false;
  for (const character of value) {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (depth === 0 && /\s/.test(character)) {
      inTrack = false;
      continue;
    }
    if (!inTrack) {
      count += 1;
      inTrack = true;
    }
  }
  return Math.max(1, count);
}

/**
 * Decision 3: after Clear selection, Escape or a bulk action, focus returns to the card that
 * last had focus, or to the fallback (the search field) when that card is gone.
 */
export function restoreMediaFocus(handle: MediaGridHandle | null | undefined, fallback: () => void): void {
  if (!handle?.focusLastCard()) fallback();
}

const OTHER_CONTROL = "button, a[href], input, label, select, textarea, [role='menuitem']";

export function MediaGrid<T extends SelectableMedia>({
  className,
  handleRef,
  header,
  inert = false,
  items,
  label,
  layout = "grid",
  onEscape,
  onOpen,
  onQuickLook,
  onSelectionChange,
  renderItem,
  rules,
  selection,
}: MediaGridProps<T>) {
  const gridRef = useRef<HTMLDivElement>(null);
  const cells = useRef(new Map<string, HTMLDivElement>());
  const rowElements = useRef<Array<HTMLDivElement | null>>([]);
  const lastFocused = useRef<string | null>(null);
  const [measuredColumns, setMeasuredColumns] = useState(1);
  const [activeId, setActiveId] = useState<string | null>(null);
  const list = layout === "list";
  const columns = list ? 1 : measuredColumns;
  const selectedIds = useMemo(() => new Set(selection.items.map((item) => item.id)), [selection.items]);
  const selectionMode = selection.items.length > 0;
  useLayoutEffect(() => { gridRef.current?.toggleAttribute("inert", inert); }, [inert]);
  const active = items.some((item) => item.id === activeId) ? activeId : items[0]?.id ?? null;

  // Focus that sits in a card before a regroup, so the card can take it back after the move.
  const focusBeforeCommit = useRef<Element | null>(null);
  if (typeof document !== "undefined" && gridRef.current?.contains(document.activeElement)) {
    focusBeforeCommit.current = document.activeElement;
  }

  const rows = useMemo(() => {
    if (list) return [];
    const grouped: T[][] = [];
    for (let start = 0; start < items.length; start += columns) grouped.push(items.slice(start, start + columns));
    return grouped;
  }, [columns, items, list]);

  function cellFor(id: string): HTMLDivElement {
    let node = cells.current.get(id);
    if (!node) {
      node = document.createElement("div");
      node.className = "media-grid-cell";
      node.setAttribute("role", "gridcell");
      cells.current.set(id, node);
    }
    return node;
  }

  // Measure the column count from the laid-out grid; update only when it changes.
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid || list) return undefined;
    const measure = () => {
      const next = gridColumnCount(window.getComputedStyle(grid).gridTemplateColumns);
      setMeasuredColumns((current) => (current === next ? current : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    return () => observer.disconnect();
  }, [list]);

  // Place each card's cell in its row, in page order, and drop cells for cards that left.
  useLayoutEffect(() => {
    const keep = new Set(list ? [] : items.map((item) => item.id));
    for (const [id, node] of cells.current) {
      if (!keep.has(id)) {
        node.remove();
        cells.current.delete(id);
      }
    }
    if (list) return;
    rows.forEach((row, rowIndex) => {
      const rowElement = rowElements.current[rowIndex];
      if (!rowElement) return;
      row.forEach((item, column) => {
        const node = cellFor(item.id);
        node.dataset.mediaItem = item.id;
        node.setAttribute("aria-selected", String(selectedIds.has(item.id)));
        const at = rowElement.children[column] ?? null;
        if (at !== node) rowElement.insertBefore(node, at);
      });
      while (rowElement.children.length > row.length) rowElement.lastElementChild?.remove();
    });
    const focused = focusBeforeCommit.current;
    focusBeforeCommit.current = null;
    if (focused instanceof HTMLElement && focused.isConnected && document.activeElement !== focused
      && (document.activeElement === null || document.activeElement === document.body)) {
      focused.focus({ preventScroll: true });
    }
  });

  function itemIndex(target: EventTarget | null): number {
    const grid = gridRef.current;
    if (!grid || !(target instanceof Element) || !grid.contains(target)) return -1;
    const holder = target.closest<HTMLElement>("[data-media-item]");
    if (!holder) return -1;
    return items.findIndex((item) => item.id === holder.dataset.mediaItem);
  }

  function openControl(id: string): HTMLElement | null {
    const holder = [...(gridRef.current?.querySelectorAll<HTMLElement>("[data-media-item]") ?? [])]
      .find((element) => element.dataset.mediaItem === id);
    return holder?.querySelector<HTMLElement>("[data-media-open]") ?? null;
  }

  function focusItem(index: number): boolean {
    const item = items[index];
    if (!item) return false;
    const control = openControl(item.id);
    if (!control) return false;
    setActiveId(item.id);
    lastFocused.current = item.id;
    control.focus();
    return document.activeElement === control;
  }

  function rowsPerScreen(): number {
    const grid = gridRef.current;
    const first = grid?.querySelector<HTMLElement>("[data-media-item]");
    if (!grid || !first) return 1;
    const height = first.getBoundingClientRect().height;
    if (height <= 0) return 1;
    const gap = Number.parseFloat(window.getComputedStyle(grid).rowGap) || 0;
    // Leave a row for the sticky toolbar and the selection bar.
    return Math.max(1, Math.floor(window.innerHeight / (height + gap)) - 1);
  }

  function select(item: T, checked: boolean) {
    onSelectionChange({ ...changeSelection(selection, [item], checked, rules), anchor: item.id });
  }

  useImperativeHandle(handleRef, () => ({
    focusLastCard: () => {
      const id = lastFocused.current;
      return id ? focusItem(items.findIndex((item) => item.id === id)) : false;
    },
    focusItemById: (id) => focusItem(items.findIndex((item) => item.id === id)),
  }));

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = itemIndex(event.target);
    if (index < 0) return;
    if (list && (event.key === "ArrowLeft" || event.key === "ArrowRight")) return;
    const target = event.target as Element;
    // The card's name is the grid's focus point: Space selects it and Enter opens it, rather
    // than the button's own activation (APG grid).
    const name = target.closest("[data-media-open]");
    const action = mediaGridKeyAction(
      {
        key: event.key,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        defaultPrevented: event.isDefaultPrevented() || event.nativeEvent.defaultPrevented,
        target: name ? target.closest("[data-media-item]") : target,
      },
      { index, columns, count: items.length, rowsPerScreen: rowsPerScreen() },
    );
    switch (action.type) {
      case "move":
        event.preventDefault();
        focusItem(action.index);
        return;
      case "extend": {
        event.preventDefault();
        const anchor = selection.anchor !== null && items.some((item) => item.id === selection.anchor)
          ? selection.anchor
          : items[index].id;
        onSelectionChange(selectRange({ ...selection, anchor }, items, items[action.index].id, true, rules));
        focusItem(action.index);
        return;
      }
      case "toggle": {
        event.preventDefault();
        const item = items[action.index];
        select(item, !selectedIds.has(item.id));
        return;
      }
      case "open":
        event.preventDefault();
        onOpen(items[action.index]);
        return;
      case "quick-look":
        if (!onQuickLook) return;
        event.preventDefault();
        onQuickLook(items[action.index]);
        return;
      case "select-page":
        event.preventDefault();
        onSelectionChange(setPageSelection(selection, items, true, rules));
        return;
      case "escape":
        if (!onEscape) return;
        event.preventDefault();
        onEscape();
        return;
      // The card's ContextMenuArea opens the menu for Shift+F10 and the Menu key.
      default:
    }
  }

  function onKeyUp(event: KeyboardEvent<HTMLDivElement>) {
    // Some browsers activate a button on Space's keyup; the grid already toggled on keydown.
    if (event.key === " " && itemIndex(event.target) >= 0 && (event.target as Element).closest("[data-media-open]")) {
      event.preventDefault();
    }
  }

  // Cmd or Ctrl-click on the card body or name toggles without opening; Shift-click selects
  // the range from the anchor, within the page. The card's own controls keep their clicks.
  function onClickCapture(event: MouseEvent<HTMLDivElement>) {
    if (!(event.shiftKey || event.metaKey || event.ctrlKey)) return;
    const index = itemIndex(event.target);
    if (index < 0) return;
    const control = (event.target as Element).closest(OTHER_CONTROL);
    if (control && !control.hasAttribute("data-media-open")) return;
    event.preventDefault();
    event.stopPropagation();
    const item = items[index];
    if (event.shiftKey) onSelectionChange(selectRange(selection, items, item.id, true, rules));
    else select(item, !selectedIds.has(item.id));
    focusItem(index);
  }

  function onMouseDown(event: MouseEvent<HTMLDivElement>) {
    // Shift-click extends a selection; it should not also select the text between cards.
    if (event.shiftKey && itemIndex(event.target) >= 0 && !(event.target as Element).closest("input")) event.preventDefault();
  }

  function onFocus(event: { target: EventTarget | null }) {
    const index = itemIndex(event.target);
    if (index < 0) return;
    const id = items[index].id;
    lastFocused.current = id;
    if (id !== activeId) setActiveId(id);
  }

  function context(item: T, index: number): MediaGridItemContext {
    return {
      index,
      tabbable: item.id === active,
      selected: selectedIds.has(item.id),
      selectionMode,
      onSelectChange: (checked, { shiftKey }) => {
        setActiveId(item.id);
        lastFocused.current = item.id;
        if (shiftKey) onSelectionChange(selectRange(selection, items, item.id, checked, rules));
        else select(item, checked);
      },
    };
  }

  return (
    <div
      aria-label={label}
      aria-multiselectable="true"
      className={["media-grid", className].filter(Boolean).join(" ")}
      data-layout={layout}
      data-selection-mode={selectionMode || undefined}
      onClickCapture={onClickCapture}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onMouseDown={onMouseDown}
      ref={gridRef}
      role="grid"
    >
      {list ? (
        <>
          {header}
          {items.map((item, index) => {
            const row = renderItem(item, context(item, index));
            return isValidElement(row)
              ? cloneElement(row as ReactElement<Record<string, unknown>>, { key: item.id, "data-media-item": item.id })
              : row;
          })}
        </>
      ) : (
        <>
          {rows.map((_, rowIndex) => (
            <div
              className="media-grid-row"
              key={rowIndex}
              ref={(element) => {
                rowElements.current[rowIndex] = element;
              }}
              role="row"
            />
          ))}
          {items.map((item, index) => createPortal(renderItem(item, context(item, index)), cellFor(item.id), item.id))}
        </>
      )}
    </div>
  );
}
