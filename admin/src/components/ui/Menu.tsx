import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { AnchorRect } from "../../lib/floating-position";
import { isMenuNavigationKey, nextMenuIndex } from "../../lib/menu-navigation";
import { useFloatingPosition, useOverlayRoot } from "./floating";
import { Icon, type IconName } from "./Icon";
import { Button, type ButtonVariant } from "./Primitives";
import { Tooltip } from "./Tooltip";
import "./Menu.css";

export interface MenuItem {
  key: string;
  label: string;
  description?: string;
  checked?: boolean;
  onSelect: () => void;
  icon?: IconName;
  /** Destructive items use danger ink and belong last (HIG context menus). */
  danger?: boolean;
  /** Unavailable items are hidden, not dimmed (HIG). */
  hidden?: boolean;
  /** Keep a prerequisite visible and focusable, without allowing activation. */
  disabledReason?: string;
  /** Items with different group names are separated by a divider. */
  group?: string;
  /**
   * A keyboard shortcut for the same action, shown as a hint after the label (label, such as
   * "⌘A") and stated to assistive technology in aria-keyshortcuts (keys, such as "Meta+A").
   */
  shortcut?: { label: string; keys: string };
}

interface MenuSurfaceProps {
  items: MenuItem[];
  label: string;
  /** Shows the label as a heading, as a multi-select context menu does ("12 items"). */
  showTitle: boolean;
  showGroupLabels?: boolean;
  fitBelow?: boolean;
  initialIndex: number;
  getAnchor: () => AnchorRect | null;
  onClose: (returnFocus: boolean) => void;
  ignoreOutside?: () => HTMLElement | null;
  id?: string;
}

// The open menu: WAI-ARIA menu keyboard rules shared with the account menu, one level only.
function MenuSurface({
  getAnchor,
  id,
  ignoreOutside,
  initialIndex,
  items,
  label,
  onClose,
  showTitle,
  showGroupLabels,
  fitBelow = false,
}: MenuSurfaceProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const visible = items.filter((item) => !item.hidden);
  const [active, setActive] = useState(() =>
    initialIndex < 0 ? visible.length - 1 : Math.min(initialIndex, visible.length - 1));
  const titleId = useId();
  const root = useOverlayRoot();
  const position = useFloatingPosition(true, getAnchor, surfaceRef, "bottom-start", fitBelow ? ignoreOutside : undefined, fitBelow);

  // The surface stays hidden until it is positioned, and a hidden item cannot take focus, so
  // the first focus waits for the position.
  const positioned = position !== null;
  useEffect(() => {
    if (positioned) itemRefs.current[active]?.focus();
  }, [active, positioned]);

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      const path = event.composedPath();
      if (surfaceRef.current && path.includes(surfaceRef.current)) return;
      const ignored = ignoreOutside?.();
      if (ignored && path.includes(ignored)) return;
      onClose(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [ignoreOutside, onClose]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose(true);
      return;
    }
    if (event.key === "Tab") {
      onClose(false);
      return;
    }
    if (!isMenuNavigationKey(event.key)) return;
    const next = nextMenuIndex(event.key, active, visible.length);
    if (next === null) return;
    event.preventDefault();
    setActive(next);
  }

  if (!root) return null;
  return createPortal(
    <div
      aria-label={showTitle ? undefined : label}
      aria-labelledby={showTitle ? titleId : undefined}
      className="ui-menu"
      data-fit-below={fitBelow || undefined}
      data-positioned={position ? "true" : "false"}
      id={id}
      onKeyDown={onKeyDown}
      ref={surfaceRef}
      role="menu"
      style={position ? { left: position.left, top: position.top, maxHeight: position.maxHeight } : undefined}
    >
      {showTitle ? <div className="ui-menu-title" id={titleId}>{label}</div> : null}
      {visible.map((item, index) => (
        <Fragment key={item.key}>
          {showGroupLabels && item.group && (index === 0 || item.group !== visible[index - 1].group) ? (
            <div className="ui-menu-title" role="presentation">{item.group}</div>
          ) : index > 0 && item.group !== visible[index - 1].group ? (
            <div className="ui-menu-separator" role="separator" />
          ) : null}
          <Button
            variant={item.danger ? "menu-danger" : "menu"}
            aria-disabled={item.disabledReason ? true : undefined}
            aria-keyshortcuts={item.shortcut?.keys}
            onClick={() => {
              if (item.disabledReason) return;
              onClose(true);
              item.onSelect();
            }}
            ref={(element) => {
              itemRefs.current[index] = element;
            }}
            role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
            aria-checked={item.checked}
            tabIndex={index === active ? 0 : -1}
            type="button"
          >
            {item.icon ? <Icon name={item.icon} /> : <span aria-hidden="true" className="ui-menu-icon-space" />}
            <span>{item.label}{item.description ? <> <span className="ui-menu-item-description">{item.description}</span></> : null}{item.disabledReason ? <> <span className="ui-menu-item-description">{item.disabledReason}</span></> : null}</span>
            {item.shortcut ? <span aria-hidden="true" className="ui-menu-shortcut">{item.shortcut.label}</span> : null}
          </Button>
        </Fragment>
      ))}
    </div>,
    root,
  );
}

export interface MenuProps {
  showGroupLabels?: boolean;
  /** Keep long menus below the trigger and scroll within the remaining viewport. */
  fitBelow?: boolean;
  variant?: ButtonVariant;
  disabled?: boolean;
  label: string;
  items: MenuItem[];
  icon?: IconName;
  /** Visible trigger text; without it the trigger is icon-only and named by label. */
  children?: ReactNode;
  className?: string;
  /** A tooltip for an icon-only trigger, such as "More actions" on a media card. */
  tooltip?: string;
  /** -1 takes the trigger out of the tab order, as a roving grid does for cards without focus. */
  tabIndex?: number;
}

// A menu button, such as a toolbar or tile "More actions" control.
export function Menu({ children, className, icon = "ellipsis", items, label, tabIndex, tooltip, variant, disabled, showGroupLabels, fitBelow }: MenuProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [openAt, setOpenAt] = useState<number | null>(null);
  const menuId = useId();
  const available = !disabled && items.some((item) => !item.hidden);
  const close = useCallback((returnFocus: boolean) => {
    setOpenAt(null);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  const Trigger = variant ? Button : "button";
  const trigger = (
    <Trigger
      {...(variant ? { variant } : {})}
      aria-controls={openAt === null ? undefined : menuId}
      aria-disabled={available ? undefined : true}
      aria-expanded={openAt !== null}
      aria-haspopup="menu"
      aria-label={children ? undefined : label}
      className={[variant ? "ui-menu-button" : "ui-menu-trigger", variant && !children ? "action-control-icon" : undefined, className].filter(Boolean).join(" ")}
      onClick={() => {
        if (available) setOpenAt(openAt === null ? 0 : null);
      }}
      onKeyDown={(event) => {
        if (!available || openAt !== null || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
        event.preventDefault();
        setOpenAt(event.key === "ArrowDown" ? 0 : -1);
      }}
      ref={triggerRef}
      tabIndex={tabIndex}
      type="button"
    >
      <Icon name={icon} />
      {/* A labeled button menu shows only its icon on phones. */}
      {variant && children ? <span className="button-compact-label">{children}</span> : children}
    </Trigger>
  );

  return (
    <>
      {tooltip ? <Tooltip content={tooltip}>{trigger}</Tooltip> : trigger}
      {openAt !== null ? (
        <MenuSurface
          getAnchor={() => triggerRef.current?.getBoundingClientRect() ?? null}
          id={menuId}
          ignoreOutside={() => triggerRef.current}
          initialIndex={openAt}
          items={items}
          label={label}
          onClose={close}
          showTitle={false}
          showGroupLabels={showGroupLabels}
          fitBelow={fitBelow}
        />
      ) : null}
    </>
  );
}

export interface ContextMenuAreaProps {
  /** Menu title and name, such as the item name or "12 items". */
  label: string;
  items: MenuItem[];
  children: ReactNode;
  className?: string;
  /**
   * Where focus returns after a right-click, such as a media card's name. Without it, focus
   * returns to the clicked control or to whatever had focus.
   */
  returnFocusSelector?: string;
}

// Right-click, Shift+F10 or the Menu key inside the area opens the same actions that the
// visible controls offer. Focus returns to the element that asked.
export function ContextMenuArea({ children, className, items, label, returnFocusSelector }: ContextMenuAreaProps) {
  const [anchor, setAnchor] = useState<AnchorRect | null>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const available = items.some((item) => !item.hidden);
  const close = useCallback((returnFocus: boolean) => {
    setAnchor(null);
    if (returnFocus) returnTo.current?.focus();
  }, []);

  return (
    <div
      className={["ui-context-area", className].filter(Boolean).join(" ")}
      onContextMenu={(event) => {
        if (!available) return;
        event.preventDefault();
        const area = event.currentTarget as HTMLElement;
        returnTo.current = (returnFocusSelector ? area.querySelector<HTMLElement>(returnFocusSelector) : null)
          ?? (event.target as HTMLElement).closest<HTMLElement>("button, a, [tabindex]")
          ?? (document.activeElement as HTMLElement | null);
        const { clientX: left, clientY: top } = event;
        setAnchor({ left, top, right: left, bottom: top, width: 0, height: 0 });
      }}
      onKeyDown={(event) => {
        if (!available || !((event.key === "F10" && event.shiftKey) || event.key === "ContextMenu")) return;
        event.preventDefault();
        const target = event.target as HTMLElement;
        returnTo.current = target;
        const rect = target.getBoundingClientRect();
        setAnchor({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height });
      }}
    >
      {children}
      {anchor ? (
        <MenuSurface
          // A new position is a new menu, so a second right-click reopens where it happened.
          key={`${anchor.left}:${anchor.top}`}
          getAnchor={() => anchor}
          initialIndex={0}
          items={items}
          label={label}
          onClose={close}
          showTitle
        />
      ) : null}
    </div>
  );
}
