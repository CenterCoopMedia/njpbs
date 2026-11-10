import { ControlSizingProvider } from "../../context/ControlSizingContext";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { readStoredInspectorWidth } from "../../lib/inspector-width";
import { useStoredState } from "../../lib/use-stored-state";
import { InspectorResizeHandle } from "./InspectorResizeHandle";
import { ActionControl } from "./ActionControl";
import { FOCUSABLE, useMediaQuery } from "./floating";
import { Icon } from "./Icon";
import "./Inspector.css";

interface InspectorBaseProps {
  /** A desktop companion already present on load can preserve current focus. Modal sheets always focus. */
  autoFocusOnOpen?: boolean;
  /** Align with a sibling workspace's results, below its search or related-results controls. */
  alignTo?: string;
  /** Width query at which this workspace needs the modal drawer. */
  compactQuery?: string;
  /** The region's accessible name, such as "Image details". */
  label: string;
  /** The opened item's name, or "12 items" in bulk mode. Focused on open unless docked. */
  heading: string;
  open: boolean;
  /** Unsaved work blocks Escape unless the form supplies its own discard prompt. */
  dirty?: boolean;
  onDirtyEscape?: () => void;
  /** Lossless dismissal, such as hiding an upload queue while its work stays mounted. */
  onClickOutside?: () => void;
  /** Save and cancel actions, pinned to the bottom of the panel. */
  footer?: ReactNode;
  /** Fit a standalone panel below its actual top edge, including route notices. */
  fitViewport?: boolean;
  /** Keep child state mounted while the closed panel stays hidden. */
  keepMounted?: boolean;
  /** Override the close control's accessible name for a non-details panel. */
  closeLabel?: string;
  /** Focus this route-owned fallback when the control that opened the inspector unmounted. */
  onFocusFallback?: () => void;
  /** An opener captured before this inspector's children can take focus. */
  focusReturn?: HTMLElement | null;
  /** Fixed panels can use the inspector slot without exposing its resize handle. */
  resizable?: boolean;
  /** Separates stored width and section state between inspectors. */
  storageKey?: string;
  children: ReactNode;
  className?: string;
}

/**
 * Beside results the inspector has a close control and handles Escape. Docked inside a
 * dialog such as the video viewer it has neither: the dialog owns closing, Escape and focus.
 */
export type InspectorProps = InspectorBaseProps & (
  | { docked?: false; onClose: () => void }
  | { docked: true; onClose?: never }
);

const StorageScope = createContext("media");

const serializeWidth = (value: number) => String(value);
const parseSection = (fallback: boolean) => (raw: string | null) => (raw === null ? fallback : raw === "open");
const serializeSection = (value: boolean) => (value ? "open" : "closed");

// Kept usable behind the modal sheet: menus and tooltips opened from it mount in the overlay
// root, and the toast region must stay announced. A branch that holds one of them is walked
// into, so only the rest of that branch goes inert.
const KEEP_WITHIN = "#admin-overlay-root, .success-notice-region";
const KEEP = `${KEEP_WITHIN}, [aria-live], script, style, template`;

function inertBranch(element: Element, changed: Element[]) {
  if (element.hasAttribute("inert") || element.matches(KEEP)) return;
  if (element.querySelector(KEEP_WITHIN)) {
    for (const child of Array.from(element.children)) inertBranch(child, changed);
    return;
  }
  element.setAttribute("inert", "");
  changed.push(element);
}

/**
 * Makes everything outside the sheet inert, from the sheet up to the body, crossing shadow
 * roots so the gallery's isolated specimens behave as the admin does. Elements that were
 * already inert keep their state when the sheet closes.
 */
function inertOutside(sheet: HTMLElement, keep: Element[]): () => void {
  const changed: Element[] = [];
  let node: Element = sheet;
  while (node !== document.body) {
    const parentNode = node.parentNode;
    const parent: Element | null = parentNode instanceof ShadowRoot ? parentNode.host : node.parentElement;
    if (!parentNode || !parent) break;
    for (const sibling of Array.from(parentNode.children)) {
      if (sibling !== node && !keep.includes(sibling)) inertBranch(sibling, changed);
    }
    node = parent;
  }
  return () => {
    for (const element of changed) element.removeAttribute("inert");
  };
}

// The shared details inspector: a nonmodal panel at
// the right of the results that follows the opened item. It drags between the
// inspector-min and inspector-max tokens and remembers its width; under 62rem it becomes
// a modal full-height sheet over a scrim, with the page behind it inert.
// Opening focuses the heading, closing returns focus to the control that opened it, and a
// new heading while open is announced politely. Docked in a dialog (the video viewer), it
// leaves focus, Escape and closing to that dialog and stacks under the player under 62rem.
export function Inspector({
  alignTo,
  autoFocusOnOpen = true,
  children,
  className,
  compactQuery = "(max-width: 61.99rem)",
  closeLabel = "Close details",
  dirty = false,
  docked = false,
  footer,
  fitViewport = false,
  focusReturn,
  heading,
  keepMounted = false,
  label,
  onClose,
  onClickOutside,
  onDirtyEscape,
  onFocusFallback,
  open,
  resizable: allowResize = true,
  storageKey = "media",
}: InspectorProps) {
  const compact = useMediaQuery(compactQuery);
  const modal = open && compact && !docked;
  const sheetRef = useRef<HTMLElement>(null);
  const pointerStartedInside = useRef(false);
  const scrimRef = useRef<HTMLDivElement>(null);
  const widthKey = `cms.inspector.${storageKey}.width`;
  const [width, setWidth] = useStoredState(widthKey, readStoredInspectorWidth, serializeWidth);
  const [announcement, setAnnouncement] = useState("");
  const headingRef = useRef<HTMLHeadingElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const focusFallbackRef = useRef(onFocusFallback);
  focusFallbackRef.current = onFocusFallback;
  const shownHeading = useRef(heading);
  const remeasureAlignment = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!open || modal || docked || !onClickOutside) return;
    const inside = (path: EventTarget[]) => Boolean(
      (sheetRef.current && path.includes(sheetRef.current)) ||
      path.some(node => node instanceof Element && node.matches(`${KEEP_WITHIN}, dialog, [role="dialog"]`)),
    );
    const rememberStart = (event: PointerEvent) => {
      pointerStartedInside.current = inside(event.composedPath());
    };
    const dismiss = (event: MouseEvent) => {
      const startedInside = pointerStartedInside.current;
      pointerStartedInside.current = false;
      if ((event.detail > 0 && startedInside) || inside(event.composedPath())) return;
      onClickOutside();
    };
    // The opening click has already passed capture; later clicks keep their chosen target.
    document.addEventListener("pointerdown", rememberStart, true);
    document.addEventListener("click", dismiss, true);
    return () => {
      document.removeEventListener("pointerdown", rememberStart, true);
      document.removeEventListener("click", dismiss, true);
    };
  }, [docked, modal, onClickOutside, open]);

  useLayoutEffect(() => {
    const panel = sheetRef.current;
    if (!fitViewport || !open || docked || compact || !panel) return;
    let frame = 0;
    const initialTarget = alignTo ? panel.parentElement?.querySelector(alignTo) : null;
    const measure = () => {
      const target = alignTo ? panel.parentElement?.querySelector(alignTo) : null;
      if (target && panel.parentElement) {
        panel.style.marginBlockStart = `${Math.max(0, target.getBoundingClientRect().top - panel.parentElement.getBoundingClientRect().top)}px`;
      }
      const top = Math.max(0, panel.getBoundingClientRect().top);
      panel.style.maxHeight = `max(0px, calc(100dvh - ${top}px - var(--cms-space-4)))`;
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    remeasureAlignment.current = schedule;
    measure();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
    // Notices and toolbars before the panel can move it without resizing its own row.
    for (let ancestor = panel.parentElement; ancestor; ancestor = ancestor.parentElement) {
      observer?.observe(ancestor);
    }
    for (let ancestor = initialTarget; ancestor && ancestor !== panel.parentElement; ancestor = ancestor.parentElement) {
      observer?.observe(ancestor);
    }
    window.addEventListener("resize", schedule);
    document.addEventListener("scroll", schedule, true);
    return () => {
      cancelAnimationFrame(frame);
      remeasureAlignment.current = null;
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
      document.removeEventListener("scroll", schedule, true);
      panel.style.removeProperty("max-height");
      panel.style.removeProperty("margin-block-start");
    };
  }, [alignTo, compact, docked, fitViewport, open]);

  // Results can arrive after opening; reuse the live measurement without resetting scroll geometry.
  useLayoutEffect(() => {
    if (alignTo) remeasureAlignment.current?.();
  });

  useLayoutEffect(() => {
    if (!open || docked) return;
    const active = document.activeElement;
    openerRef.current = focusReturn !== undefined
      ? focusReturn
      : active instanceof HTMLElement && active !== document.body ? active : null;
    shownHeading.current = heading;
    setAnnouncement("");
    if (autoFocusOnOpen || compact) headingRef.current?.focus();
    // Only a new opening moves focus; heading changes are announced instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // However the panel closes, including the page removing it, focus that was inside it goes
  // back to the opener rather than falling to the page. Focus the person already moved
  // elsewhere stays where it is.
  const restoreFocus = useCallback(() => {
    const opener = openerRef.current;
    openerRef.current = null;
    const active = document.activeElement;
    const lost = !active || active === document.body || Boolean(sheetRef.current?.contains(active));
    if (!lost) return;
    if (opener?.isConnected) {
      opener.focus();
      if (document.activeElement === opener) return;
    }
    focusFallbackRef.current?.();
  }, []);
  const wasOpen = useRef(open);
  useEffect(() => {
    if (wasOpen.current && !open) restoreFocus();
    wasOpen.current = open;
  }, [open, restoreFocus]);
  useEffect(() => () => {
    if (wasOpen.current) restoreFocus();
  }, [restoreFocus]);

  // A layout effect, so its cleanup lifts inert before the passive effects above return focus.
  useLayoutEffect(() => {
    const sheet = sheetRef.current;
    if (!modal || !sheet) return;
    const restoreInert = inertOutside(sheet, scrimRef.current ? [scrimRef.current] : []);
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    if (!sheet.contains(document.activeElement)) headingRef.current?.focus();
    return () => {
      restoreInert();
      document.body.style.overflow = overflow;
    };
  }, [modal]);

  useEffect(() => {
    if (!open || heading === shownHeading.current) return;
    shownHeading.current = heading;
    setAnnouncement(`Showing ${heading}`);
  }, [heading, open]);

  // Inert keeps Tab in the sheet in browsers; wrapping at the ends also covers the browser's
  // own controls, which inert cannot reach.
  function keepTabInside(event: KeyboardEvent<HTMLElement>) {
    const sheet = event.currentTarget;
    // Menus use the overlay root. When Tab closes one, return to its trigger inside this sheet.
    const menu = event.target instanceof Element ? event.target.closest<HTMLElement>('[role="menu"]') : null;
    if (menu && !sheet.contains(menu)) {
      const trigger = Array.from(sheet.querySelectorAll<HTMLElement>('[aria-controls]'))
        .find(element => element.getAttribute("aria-controls") === menu.id);
      if (trigger) {
        event.preventDefault();
        trigger.focus();
        return;
      }
    }
    const focusable = Array.from(sheet.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter(element => !element.closest("[hidden], [inert]"));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = event.currentTarget.getRootNode() instanceof ShadowRoot
      ? (event.currentTarget.getRootNode() as ShadowRoot).activeElement
      : document.activeElement;
    if (event.shiftKey && (active === first || active === headingRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  if (!open && !keepMounted) return null;

  const resizable = open && allowResize && !compact && !docked;
  const classes = [
    "ui-inspector",
    modal ? "ui-inspector-sheet" : null,
    docked ? "ui-inspector-docked" : null,
    className,
  ].filter(Boolean).join(" ");
  const close = docked ? undefined : onClose;
  return (
    <ControlSizingProvider size="standard">
    {modal ? (
      <div
        aria-hidden="true"
        className="ui-inspector-scrim"
        onClick={() => {
          if (onClickOutside) onClickOutside();
          else if (!dirty) close?.();
        }}
        ref={scrimRef}
      />
    ) : null}
    <aside
      aria-label={label}
      aria-modal={modal ? true : undefined}
      className={classes}
      hidden={!open}
      onKeyDown={(event) => {
        if (modal && event.key === "Tab") {
          keepTabInside(event);
          return;
        }
        if (!close || event.key !== "Escape" || event.defaultPrevented) return;
        // The form may open its own discard prompt; an enclosing dialog must not also act.
        event.preventDefault();
        event.stopPropagation();
        if (dirty) onDirtyEscape?.();
        else close();
      }}
      ref={sheetRef}
      role={modal ? "dialog" : undefined}
      style={resizable ? { width: `${width}rem` } : undefined}
    >
      {resizable ? (
        <InspectorResizeHandle width={width} onChange={setWidth} />
      ) : null}
      <header className="ui-inspector-header">
        <h2 className="ui-inspector-heading" ref={headingRef} tabIndex={-1}>{heading}</h2>
        {close ? <ActionControl action="close" label={closeLabel} onClick={close} variant="ghost" /> : null}
      </header>
      <p aria-live="polite" className="sr-only">{announcement}</p>
      <div className="ui-inspector-body">
        <StorageScope.Provider value={storageKey}>{children}</StorageScope.Provider>
      </div>
      {footer ? <footer className="ui-inspector-footer">{footer}</footer> : null}
    </aside>
    </ControlSizingProvider>
  );
}

export interface InspectorSectionProps {
  /** Stable id; the open or closed state is stored under it. */
  id: string;
  title: string;
  /** A short summary beside the title, such as "8" tags or "Mixed" in bulk mode. */
  count?: string | number;
  /** A control beside the heading, such as a Menu; it never sits inside the disclosure button. */
  actions?: ReactNode;
  defaultOpen?: boolean;
  /** A changed nonzero request opens the section, such as a menu action targeting it. */
  openRequest?: number;
  /** Runs after a requested section is open, so its newly visible target can receive focus. */
  onOpenRequestHandled?: () => void;
  children: ReactNode;
}

// A collapsible inspector section (disclosure pattern) that remembers its state.
export function InspectorSection({ actions, children, count, defaultOpen = true, id, onOpenRequestHandled, openRequest = 0, title }: InspectorSectionProps) {
  const scope = useContext(StorageScope);
  const key = `cms.inspector.${scope}.section.${id}`;
  const parse = useMemo(() => parseSection(defaultOpen), [defaultOpen]);
  const [expanded, setExpanded] = useStoredState(key, parse, serializeSection);
  const handledOpenRequest = useRef(0);
  const panelId = useId();
  const counted = count !== undefined && count !== "";

  useEffect(() => {
    if (!openRequest || handledOpenRequest.current === openRequest) return;
    if (!expanded) {
      setExpanded(true, false);
      return;
    }
    handledOpenRequest.current = openRequest;
    onOpenRequestHandled?.();
    // Only a new request opens the section.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, openRequest, onOpenRequestHandled]);

  function toggle() {
    setExpanded(!expanded);
  }

  return (
    <section className="ui-inspector-section">
      <div className="ui-inspector-section-head">
        <h3 className="ui-inspector-section-heading">
          <button
            aria-controls={panelId}
            aria-expanded={expanded}
            // The name keeps the title first and separates the count, as "Tags, 8".
            aria-label={counted ? `${title}, ${count}` : undefined}
            onClick={toggle}
            type="button"
          >
            <span className="ui-inspector-section-title">
              <span>{title}</span>
              {counted ? <span className="ui-inspector-section-count">{count}</span> : null}
            </span>
            <Icon name={expanded ? "chevron-up" : "chevron-down"} />
          </button>
        </h3>
        {actions ? <div className="ui-inspector-section-actions">{actions}</div> : null}
      </div>
      <div className="ui-inspector-section-body" hidden={!expanded} id={panelId}>{children}</div>
    </section>
  );
}
