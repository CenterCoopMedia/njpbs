import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { fitToolbarItems } from "../../lib/toolbar-overflow";
import { useControlSize } from "../../context/ControlSizingContext";
import { useToolbarNavigation } from "./useToolbarNavigation";
import type { ButtonVariant } from "./Primitives";
import { Menu, type MenuItem } from "./Menu";
import "./OverflowToolbar.css";

export interface OverflowToolbarItem {
  key: string;
  /** Higher priority stays visible longer as the toolbar narrows. */
  priority: number;
  node: ReactNode;
  /**
   * Center controls (the default) collapse first. Trailing controls, such as Display, sit
   * before the fixed trailing content and collapse only once the center is empty.
   */
  zone?: "center" | "trailing";
  /** The same action as a More menu item, used while the control is collapsed. */
  menuItem: MenuItem;
}

export interface OverflowToolbarProps {
  label: string;
  /** Collapse both zones by priority when their placement does not imply importance. */
  collapseTogether?: boolean;
  items: OverflowToolbarItem[];
  leading?: ReactNode;
  /**
   * The search field, first in the trailing zone. It shrinks before any control is clipped.
   * A wrapper with the class ui-overflow-toolbar-search is measured like a bare field, and
   * the controls inside it keep their own tab stops and keys.
   */
  search?: ReactNode;
  /** Fixed trailing content, such as Upload, after the trailing controls. */
  trailing?: ReactNode;
  /**
   * Actions that live only in More, such as Keyboard shortcuts. With any, More shows at every
   * width in the trailing zone, after the trailing controls and before the fixed content, and
   * collapsed controls join it above these items.
   */
  moreItems?: MenuItem[];
  moreLabel?: string;
  moreVariant?: ButtonVariant;
  className?: string;
}

// Fallbacks for environments without layout; a browser reads both from the rendered CSS.
const GAP = 8;
const MORE_WIDTH = 44;

const isTextEntry = (element: Element) => element.matches('input:not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]), textarea, select');
const ITEM = ".ui-overflow-toolbar-item[data-key]";
// A search wrapper, such as a search form with a clear button, sized like a bare field.
const SEARCH = ".ui-overflow-toolbar-search";

const px = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
};

// The media toolbar: leading and trailing zones always show, and the
// center zone moves its lowest-priority controls into a More menu instead of wrapping. With
// fixed More items, that menu stays in the trailing zone at every width. It
// is one tab stop with arrow-key movement (APG toolbar); text fields keep their own stop
// and their own arrow keys.
//
// Each control is mounted once, so refs such as a popover anchor always point at the
// visible control. Widths are read from the visible controls and remembered while a control
// sits in More; a remembered width that turns out stale is corrected in the same frame
// the control is shown again, before paint.
export function OverflowToolbar({
  className,
  collapseTogether = false,
  items,
  label,
  leading,
  moreItems = [],
  moreLabel = "More actions",
  moreVariant,
  search,
  trailing,
}: OverflowToolbarProps) {
  const controlSize = useControlSize() ?? "legacy";
  const rootRef = useRef<HTMLDivElement | null>(null);
  const centerRef = useRef<HTMLDivElement>(null);
  const leadingRef = useRef<HTMLDivElement>(null);
  const trailingRef = useRef<HTMLDivElement>(null);
  const [toolbarElement, setToolbarElement] = useState<HTMLDivElement | null>(null);
  const setRoot = useCallback((element: HTMLDivElement | null) => { rootRef.current = element; setToolbarElement(element); }, []);
  useToolbarNavigation(toolbarElement);
  const widthsRef = useRef(new Map<string, number>());
  const observerRef = useRef<ResizeObserver | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  // A fixed More sits in the trailing zone, so it is measured with the fixed content there
  // and needs no separate reservation.
  const fixedMore = moreItems.length > 0;
  const collapseTogetherRef = useRef(collapseTogether);
  collapseTogetherRef.current = collapseTogether;
  const fixedMoreRef = useRef(fixedMore);
  fixedMoreRef.current = fixedMore;
  const [overflowKeys, setOverflowKeys] = useState<string[]>([]);

  const measure = useCallback(() => {
    const root = rootRef.current;
    const center = centerRef.current;
    const trailingZone = trailingRef.current;
    if (!root || !center) return;
    // A toolbar with no width is not laid out yet (hidden, or a test without layout), so
    // nothing collapses until there is a real width.
    const rootWidth = root.getBoundingClientRect().width;
    if (rootWidth <= 0) {
      setOverflowKeys((current) => (current.length === 0 ? current : []));
      return;
    }
    const widths = widthsRef.current;
    for (const element of Array.from(root.querySelectorAll<HTMLElement>(ITEM))) {
      widths.set(element.dataset.key ?? "", element.getBoundingClientRect().width);
    }
    // The gap and the More reservation follow the CSS, so they grow with the text size. The
    // center's padding only makes room for focus rings and is cancelled by its margin.
    const style = getComputedStyle(center);
    const gap = px(style.columnGap, GAP);
    const more = fixedMoreRef.current ? 0 : px(style.minWidth, MORE_WIDTH) - px(style.paddingLeft, 0) - px(style.paddingRight, 0);

    // The fixed trailing content, with a search field at its preferred and its minimum width.
    let fixedPreferred = 0;
    let fixedMinimum = 0;
    const fixed = trailingZone
      ? (Array.from(trailingZone.children) as HTMLElement[]).filter((element) => !element.matches(ITEM))
      : [];
    fixed.forEach((element, index) => {
      const width = element.getBoundingClientRect().width;
      const text = isTextEntry(element) || element.matches(SEARCH) ? getComputedStyle(element) : null;
      const spacing = index > 0 ? gap : 0;
      fixedPreferred += spacing + (text ? px(text.flexBasis, width) : width);
      fixedMinimum += spacing + (text ? px(text.minWidth, width) : width);
    });
    const leadingWidth = leadingRef.current ? leadingRef.current.getBoundingClientRect().width + gap : 0;
    const beforeFixed = fixed.length > 0 ? gap : 0;
    const candidate = (item: OverflowToolbarItem) => ({
      key: item.key,
      priority: item.priority,
      width: widths.get(item.key) ?? Number.NaN,
    });
    const centerItems = itemsRef.current.filter((item) => item.zone !== "trailing").map(candidate);
    const trailingItems = itemsRef.current.filter((item) => item.zone === "trailing").map(candidate);
    const trailingItemsWidth = trailingItems.reduce((sum, item, index) => sum + item.width + (index > 0 ? gap : 0), 0);

    // Both budgets come from fixed widths, never from what is currently shown, so a decision
    // cannot undo itself on the next measurement. Center controls show only beside every
    // trailing control and a full-width search field; trailing controls collapse only once
    // the center is empty, with the search field at its minimum.
    const trailingPreferred = fixedPreferred + (trailingItems.length > 0 ? trailingItemsWidth + beforeFixed : 0);
    const hasTrailing = fixed.length > 0 || trailingItems.length > 0;
    const centerBudget = rootWidth - leadingWidth - (hasTrailing ? gap + trailingPreferred : 0);
    const centerFit = fitToolbarItems(centerItems, centerBudget, gap, more);
    let overflow = centerFit.overflow;
    if (centerFit.visible.length === 0 && trailingItems.length > 0) {
      const trailingBudget = rootWidth - leadingWidth - more - gap - fixedMinimum - beforeFixed;
      overflow = [...overflow, ...fitToolbarItems(trailingItems, trailingBudget, gap, 0).overflow];
    }
    if (collapseTogetherRef.current) {
      const budget = rootWidth - leadingWidth - fixedMinimum - (hasTrailing ? gap : 0) - (trailingItems.length > 0 ? beforeFixed : 0);
      overflow = fitToolbarItems([...centerItems, ...trailingItems], budget, gap, more).overflow;
    }
    setOverflowKeys((current) => (current.join("|") === overflow.join("|") ? current : overflow));
  }, []);

  // Every render can change a label and so a width. The observer also catches changes React
  // does not render, such as a web font arriving: each control, the leading zone and the
  // fixed trailing content are watched, since any of them moves the budget.
  const observeParts = useCallback(() => {
    const observer = observerRef.current;
    const root = rootRef.current;
    if (!observer || !root) return;
    const parts = [
      ...Array.from(root.querySelectorAll(ITEM)),
      ...(leadingRef.current ? [leadingRef.current] : []),
      ...(trailingRef.current ? Array.from(trailingRef.current.children) : []),
    ];
    for (const element of parts) observer.observe(element);
  }, []);

  useLayoutEffect(() => {
    measure();
    observeParts();
  });

  useEffect(() => {
    window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => measure()) : null;
    observerRef.current = observer;
    const root = rootRef.current;
    if (observer && root) observer.observe(root);
    observeParts();
    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
      observerRef.current = null;
    };
  }, [measure, observeParts]);

  const hidden = new Set(overflowKeys);
  const isTrailing = (item: OverflowToolbarItem) => item.zone === "trailing";
  // The More menu lists collapsed center controls, then collapsed trailing ones.
  const overflowItems = [...items.filter((item) => !isTrailing(item)), ...items.filter(isTrailing)]
    .filter((item) => hidden.has(item.key))
    .map((item) => item.menuItem);
  const moreMenu = (menuItems: MenuItem[]) => (
    <Menu
      variant={moreVariant}
      className={fixedMore ? "ui-overflow-toolbar-more ui-overflow-toolbar-more-fixed" : "ui-overflow-toolbar-more"}
      items={menuItems}
      label={moreLabel}
      tooltip={moreLabel}
    />
  );
  const shown = (zone: boolean) => items.filter((item) => isTrailing(item) === zone && !hidden.has(item.key)).map((item) => (
    <div className="ui-overflow-toolbar-item" data-key={item.key} key={item.key}>{item.node}</div>
  ));
  const trailingShown = shown(true);

  return (
    <div
      aria-label={label}
      className={["ui-overflow-toolbar", className].filter(Boolean).join(" ")}
      data-control-size={controlSize}
      ref={setRoot}
      role="toolbar"
    >
      {leading ? <div className="ui-overflow-toolbar-leading" ref={leadingRef}>{leading}</div> : null}
      <div className="ui-overflow-toolbar-center" ref={centerRef}>
        {shown(false)}
        {!fixedMore && overflowItems.length > 0 ? moreMenu(overflowItems) : null}
      </div>
      {search || trailing || trailingShown.length > 0 || fixedMore ? (
        <div className="ui-overflow-toolbar-trailing" ref={trailingRef}>
          {search}
          {trailingShown}
          {fixedMore ? moreMenu([...overflowItems, ...moreItems]) : null}
          {trailing}
        </div>
      ) : null}
    </div>
  );
}
