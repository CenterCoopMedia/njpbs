import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { EditorOverlayOwner, useOverlayOwner } from "./EditorOverlayOwner";

/** A stable portal destination retains live editor instances while their shell moves. */
export function RetainedEditorHost({ target, children, overlayOwner: requestedOverlayOwner, associateForm = true }: { target: HTMLElement | null; children: ReactNode; overlayOwner?: HTMLElement | null; associateForm?: boolean }) {
  const inheritedOverlayOwner = useOverlayOwner();
  const overlayOwner = requestedOverlayOwner !== undefined ? requestedOverlayOwner : target ? target.closest<HTMLDialogElement>("dialog") : inheritedOverlayOwner;
  const [host] = useState(() => { const element = document.createElement("div"); element.className = "editor-retained-host"; return element; });
  const placeholder = useRef<HTMLDivElement>(null);
  const owner = useRef<HTMLFormElement | null>(null);
  useLayoutEffect(() => {
    const destination = target ?? placeholder.current;
    if (!destination) return;
    if (associateForm) owner.current ??= host.closest("form") ?? placeholder.current?.closest("form") ?? null;
    // Native form ownership must survive a move outside the original form.
    const assigned = new Set<HTMLElement>();
    const associate = () => {
      const form = owner.current;
      if (!associateForm || !form?.id || !target) return;
      for (const element of host.querySelectorAll<HTMLElement>("input, select, textarea, button, fieldset")) {
        if (element.hasAttribute("form") || host.contains(element.closest("form"))) continue;
        element.setAttribute("form", form.id);
        assigned.add(element);
      }
    };
    associate();
    const observer = new MutationObserver(associate);
    if (associateForm) observer.observe(host, { childList: true, subtree: true });
    const atomic = destination as HTMLElement & { moveBefore?: (node: Node, child: Node | null) => void };
    if (host.parentElement !== destination) {
      if (host.isConnected && destination.isConnected && atomic.moveBefore) atomic.moveBefore(host, null);
      else destination.append(host);
    }
    return () => {
      observer.disconnect();
      for (const element of assigned) if (element.getAttribute("form") === owner.current?.id) element.removeAttribute("form");
    };
  }, [associateForm, host, target]);
  useLayoutEffect(() => () => host.remove(), [host]);
  return <><div className="editor-retained-host-origin" ref={placeholder} />{createPortal(<EditorOverlayOwner.Provider value={overlayOwner}>{children}</EditorOverlayOwner.Provider>, host)}</>;
}
