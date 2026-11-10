import { createPortal } from "react-dom";
import { isSafeNavigationUrl } from "../lib/custom-navigation";
import { useCallback, useEffect, useId, useRef, useState, type Ref, type RefObject } from "react";
import { Link } from "react-router";
import type { NavDestinationDef } from "../lib/nav-destinations";
import { Icon } from "./ui/Icon";
import { Button } from "./ui/Primitives";

/** Searches the already-authorized, personally arranged rail; never reads CMS data. */
export function WorkspaceFinder({ destinations, shortcutEnabled = true, triggerRef, fallbackFocusRef }: { destinations: readonly NavDestinationDef[]; shortcutEnabled?: boolean; triggerRef?: Ref<HTMLButtonElement>; fallbackFocusRef?: RefObject<HTMLButtonElement> }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const headingId = useId();
  const [query, setQuery] = useState("");
  const open = useCallback(() => {
    if (dialogRef.current?.open) return;
    setQuery("");
    dialogRef.current?.showModal();
    inputRef.current?.focus();
  }, []);
  const close = () => dialogRef.current?.close();
  const restoreVisibleFocus = () => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body && active.checkVisibility() && !active.closest("dialog:not([open])")) return;
    const fallback = fallbackFocusRef?.current;
    if (fallback?.checkVisibility()) fallback.focus();
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!shortcutEnabled || event.defaultPrevented || event.repeat || event.altKey || event.shiftKey ||
          !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "k") return;
      // Leave rich-text link shortcuts, ordinary typing, and other modal flows alone.
      const target = event.target;
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
      if (document.querySelector('dialog[open]:not([role="presentation"]), [aria-modal="true"]')) return;
      event.preventDefault();
      open();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, shortcutEnabled]);

  const needle = query.trim().toLocaleLowerCase();
  const entries = destinations.flatMap((destination) => [
    ...(destination.sectionOnly ? [] : [{ id: destination.id, label: destination.label, to: destination.to, icon: destination.icon, parent: "", external: destination.external }]),
    ...(destination.subitems ?? []).filter((item) => destination.sectionOnly || item.to !== destination.to).map((item) => ({
      ...item, id: `${destination.id}:${item.id}`, icon: destination.icon, parent: destination.label,
    })),
  ]).filter((entry) => isSafeNavigationUrl(entry.to)).filter((entry) => `${entry.parent} ${entry.label}`.toLocaleLowerCase().includes(needle));

  return (
    <>
      <button ref={triggerRef} type="button" className="workspace-finder-trigger"
        aria-label="Find a workspace" aria-haspopup="dialog" onClick={open} title="Find a workspace (Ctrl or Command K)">
        <Icon name="search" /><span>Find a workspace</span><kbd>K</kbd>
      </button>
      {createPortal(<dialog className="workspace-finder" ref={dialogRef} onClose={restoreVisibleFocus} aria-labelledby={headingId}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          // Search inputs consume Escape to clear their value; the finder promises to close.
          event.preventDefault();
          event.stopPropagation();
          close();
        }}>
        <div className="workspace-finder-heading">
          <h2 id={headingId}>Find a workspace</h2>
          <Button variant="ghost" onClick={close} aria-label="Close workspace search"><Icon name="close" /></Button>
        </div>
        <label className="workspace-finder-search">
          <span className="sr-only">Search workspaces</span>
          <Icon name="search" />
          <input ref={inputRef} className="field-control" type="search" value={query}
            onChange={(event) => setQuery(event.target.value)} placeholder="Pages, posts, media…" autoComplete="off" />
        </label>
        <p className="sr-only" role="status">{entries.length} {entries.length === 1 ? "destination" : "destinations"}</p>
        <ul className="workspace-finder-results">
          {entries.map((entry) => (
            <li key={entry.id}>
              {"external" in entry && entry.external ? (
                <a href={entry.to} target="_blank" rel="noopener noreferrer" aria-label={`Open ${entry.label} in a new tab`} onClick={close}>
                  <Icon name={entry.icon} /><span>{entry.label}</span>
                  <Icon name="external-link" />
                </a>
              ) : (
                <Link to={entry.to} onClick={close}>
                  <Icon name={entry.icon} /><span>{entry.label}{entry.parent ? <small>{entry.parent}</small> : null}</span>
                  <Icon name="arrow-right" />
                </Link>
              )}
            </li>
          ))}
        </ul>
        {entries.length === 0 ? <p className="workspace-finder-empty">No workspaces match. Try another name.</p> : null}
        <p className="workspace-finder-help">Tab to a destination, then Enter to open. Esc to close.</p>
      </dialog>, document.body)}
    </>
  );
}
