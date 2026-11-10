import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { escapeSearchAction, mediaShortcut } from "../../lib/media-search";
import { Icon } from "../ui/Icon";
import "./MediaSearchField.css";

/** The typing pause before a search applies, the existing MEDIA_SEARCH_IDLE_MS. */
export const MEDIA_SEARCH_PAUSE_MS = 300;
const MAX_LENGTH = 200;

export interface MediaSearchFieldProps {
  /** The applied search, from the URL. The field re-syncs its draft when it changes. */
  value: string;
  /** Applies a search after a typing pause, Escape or Clear search. */
  onCommit: (value: string) => void;
  /** Applies a search on Enter, even while locked, so the page's leave guard can catch it. */
  onSubmit: (value: string) => void;
  /**
   * The details panel has unsaved work. Typing still works, but nothing applies until the
   * lock lifts; then the pending draft applies after the usual pause.
   */
  locked?: boolean;
  /** The input id. The collection picker returns focus to the default. */
  id?: string;
  /** Surface-specific accessible and visible search text. */
  label?: string;
  landmarkLabel?: string;
  placeholder?: string;
  title?: string;
  /** A surface can use a tighter server bound, such as video's 160 characters. */
  maxLength?: number;
  /** A source or account change resets a draft even when the applied search is unchanged. */
  syncKey?: string;
  /** Optional route-owned draft for controls that commit a pending search together with a filter. */
  onDraftChange?: (value: string) => void;
}

/** Focuses the field on "/" unless the person is typing elsewhere or a dialog is open. */
export function useMediaSearchShortcut(inputRef: RefObject<HTMLInputElement | null>) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (mediaShortcut(event) !== "focus-search") return;
      event.preventDefault();
      inputRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [inputRef]);
}

// The media search field. It owns the typed draft, so
// a keystroke re-renders only this field and not the results or the toolbar around it.
export function MediaSearchField({
  id = "media-search-input",
  label = "Search media",
  landmarkLabel = "Media library search",
  locked = false,
  maxLength = MAX_LENGTH,
  onCommit,
  onDraftChange,
  onSubmit,
  placeholder = "Search media",
  title = "Search names, tags, credits and types · /",
  value,
  syncKey,
}: MediaSearchFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const describedById = useId();
  const [draft, setDraft] = useState(value);
  const [syncedValue, setSyncedValue] = useState(value);
  const [syncedKey, setSyncedKey] = useState(syncKey);
  // The last search this field applied that the value has not caught up with yet.
  const committedRef = useRef<string | null>(null);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;

  // A new applied value replaces the draft, unless it is what the person is typing, so a
  // trailing space survives its own commit.
  if (syncKey !== syncedKey) {
    setSyncedKey(syncKey);
    setSyncedValue(value);
    setDraft(value);
    committedRef.current = null;
  } else if (value !== syncedValue) {
    setSyncedValue(value);
    if (value !== draft.trim()) setDraft(value);
  }

  useEffect(() => {
    committedRef.current = null;
  }, [value]);

  useEffect(() => {
    const next = draft.trim();
    if (locked || next === value || next === committedRef.current) return;
    const timer = window.setTimeout(() => {
      committedRef.current = next;
      commitRef.current(next);
    }, MEDIA_SEARCH_PAUSE_MS);
    return () => window.clearTimeout(timer);
  }, [draft, locked, value]);

  useMediaSearchShortcut(inputRef);

  function commitNow(next: string) {
    if (next === value || next === committedRef.current) return;
    committedRef.current = next;
    onCommit(next);
  }

  function clear() {
    setDraft("");
    onDraftChange?.("");
    if (escapeSearchAction(draft, locked) === "clear-and-commit") commitNow("");
  }

  return (
    <form
      aria-label={landmarkLabel}
      className="ui-overflow-toolbar-search media-search-field"
      data-filled={draft ? "" : undefined}
      onSubmit={(event) => {
        event.preventDefault();
        const next = draft.trim();
        // While locked the page may refuse this, so the draft still applies once the lock lifts.
        if (!locked) committedRef.current = next;
        onSubmit(next);
      }}
      role="search"
    >
      <label className="sr-only" htmlFor={id}>{label}</label>
      <Icon className="media-search-field-icon" name="search" />
      <input
        aria-describedby={locked ? describedById : undefined}
        className="media-search-field-input"
        id={id}
        maxLength={maxLength}
        onChange={(event) => {
          setDraft(event.target.value);
          onDraftChange?.(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          if (escapeSearchAction(draft, locked) === "blur") event.currentTarget.blur();
          else clear();
        }}
        placeholder={placeholder}
        ref={inputRef}
        title={title}
        type="search"
        value={draft}
      />
      {locked ? (
        <>
          <Icon className="media-search-field-lock" name="lock" />
          <span className="sr-only" id={describedById}>Save or discard details first.</span>
        </>
      ) : null}
      {draft ? (
        <button
          aria-label="Clear search"
          className="media-search-field-clear"
          onClick={() => {
            clear();
            inputRef.current?.focus();
          }}
          type="button"
        >
          <Icon name="close" />
        </button>
      ) : null}
      <kbd aria-hidden="true" className="media-search-field-hint">/</kbd>
    </form>
  );
}
