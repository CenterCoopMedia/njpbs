import "./PostTemplates.css";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { buttonClassName, type ButtonVariant, type ButtonSize } from "./ui/Primitives";
import { useControlSize } from "../context/ControlSizingContext";
import { Icon, type IconName } from "./ui/Icon";
import { createPopper } from "@popperjs/core";

/** Keep the menu on screen whether its actions are in the header or form footer. */
export function PostTemplateActions({ children, label = "Post actions", hidden = false, closeOnAction = false, variant = "secondary", size, icon, iconOnly = false }: { children: ReactNode; label?: string; hidden?: boolean; closeOnAction?: boolean; variant?: ButtonVariant; size?: ButtonSize; icon?: IconName; iconOnly?: boolean }) {
  const inheritedSize = useControlSize();
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const details = useRef<HTMLDetailsElement>(null);
  const trigger = useRef<HTMLElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => { setOpen(false); }, [label]);
  useEffect(() => { if (hidden) setOpen(false); }, [hidden]);
  useEffect(() => {
    if (wasOpen.current && !open && closeOnAction &&
      (document.activeElement === document.body || menu.current?.contains(document.activeElement))) {
      trigger.current?.focus();
    }
    wasOpen.current = open;
  }, [open, closeOnAction]);
  useLayoutEffect(() => {
    if (!open || !trigger.current || !menu.current) return;
    const instance = createPopper(trigger.current, menu.current, {
      placement: "bottom-end",
      strategy: "fixed",
      modifiers: [
        { name: "offset", options: { offset: [0, 8] } },
        { name: "flip", options: { fallbackPlacements: ["top-end", "bottom-start", "top-start"] } },
        { name: "preventOverflow", options: { altAxis: true, padding: 12, tether: false } },
      ],
    });
    menu.current.querySelector<HTMLElement>("button:not(:disabled), a[href]")
      ?.focus({ preventScroll: true });
    return () => instance.destroy();
  }, [open]);
  useEffect(() => {
    if (!open) return;

    function closeOnEscape(event: KeyboardEvent) {
      const containing = details.current?.closest('dialog[open]:not([role="presentation"])');
      const blocking = Array.from(document.querySelectorAll('dialog[open]:not([role="presentation"])')).some(element => element !== containing);
      if (event.key !== "Escape" || blocking) return;
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    }

    function closeWhenOutside(event: PointerEvent) {
      const path = event.composedPath();
      const disclosure = details.current;
      const panel = menu.current;
      if ((disclosure && path.includes(disclosure)) || (panel && path.includes(panel))) return;
      if (event.target instanceof Element) {
        const containing = details.current?.closest('dialog[open]:not([role="presentation"])');
        const dialog = event.target.closest('dialog[open]:not([role="presentation"])');
        if (dialog && dialog !== containing) return;
      }
      setOpen(false);
    }

    document.addEventListener("keydown", closeOnEscape);
    document.addEventListener("pointerdown", closeWhenOutside);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("pointerdown", closeWhenOutside);
    };
  }, [open]);
  const overlayRoot = typeof document === "undefined"
    ? null
    : details.current?.closest<HTMLDialogElement>('dialog[open]:not([role="presentation"])') ?? document.getElementById("admin-overlay-root") ?? document.body;
  return (
    <>
      <details className="post-template-actions" hidden={hidden} open={open} ref={details}>
        <summary
          role="button"
          aria-controls={menuId}
          aria-expanded={open}
          ref={trigger}
          aria-label={icon ? label : undefined}
          title={iconOnly ? label : undefined}
          className={buttonClassName(variant, size ?? inheritedSize ?? "legacy", iconOnly ? "editor-action-icon-only" : undefined)}
          onClick={(event) => {
            event.preventDefault();
            setOpen((current) => !current);
          }}
        >{icon ? <Icon name={icon} /> : null}{iconOnly ? null : icon ? <span className="post-template-action-label">{label}</span> : label}</summary>
      </details>
      {overlayRoot ? createPortal(
        <div
          id={menuId}
          hidden={!open}
          aria-label={label}
          role="group"
          ref={menu}
          className="post-template-action-menu post-template-action-menu--floating"
          onClick={(event) => {
            if (!closeOnAction || !(event.target instanceof Element)) return;
            const action = event.target.closest("button:not(:disabled), a[href]");
            if (action && action.getAttribute("aria-haspopup") !== "dialog") setOpen(false);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Tab") return;
            const actions = Array.from(
              event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), a[href]"),
            );
            const active = document.activeElement;
            if (event.shiftKey && active === actions[0]) {
              event.preventDefault();
              setOpen(false);
              trigger.current?.focus();
            } else if (!event.shiftKey && active === actions.at(-1)) {
              // Let native Tab continue into the next header control after the
              // floating menu closes.
              setOpen(false);
              trigger.current?.focus();
            }
          }}
        >{children}</div>,
        overlayRoot,
      ) : null}
    </>
  );
}
