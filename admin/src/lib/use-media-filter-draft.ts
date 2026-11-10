import { useCallback, useEffect, useRef, useState } from "react";
import type { MediaKind } from "./functions";
import { toggleValue } from "./media-filters";

// The Filter popover's pending Type and Category choices.
// Quick toggles gather into one commit 300ms after the last, so two clicks cost one list
// call. Closing the popover commits at once. While details are unsaved each toggle commits
// at once, so the leave prompt follows the click that caused it.

export const MEDIA_FILTER_PAUSE_MS = 300;

export interface MediaFilterDraft {
  kinds: MediaKind[];
  categories: string[];
}

export interface MediaFilterDraftOptions {
  /** The applied filters, from the URL. */
  applied: MediaFilterDraft;
  /** Applies a draft. The caller resets the page to 1 (applyFilterDraft). */
  onCommit: (draft: MediaFilterDraft) => void;
  /** Commit each toggle at once, such as while details are unsaved. */
  immediate?: boolean;
}

export function useMediaFilterDraft({ applied, immediate = false, onCommit }: MediaFilterDraftOptions) {
  const [pending, setPending] = useState<MediaFilterDraft | null>(null);
  const pendingRef = useRef<MediaFilterDraft | null>(null);
  const timerRef = useRef<number | null>(null);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;
  const value = pending ?? applied;

  const cancel = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const drop = useCallback(() => {
    cancel();
    pendingRef.current = null;
    setPending(null);
  }, [cancel]);

  const flush = useCallback(() => {
    const draft = pendingRef.current;
    drop();
    if (draft) commitRef.current(draft);
  }, [drop]);

  useEffect(() => cancel, [cancel]);

  const change = (next: MediaFilterDraft) => {
    pendingRef.current = next;
    setPending(next);
    cancel();
    if (immediate) flush();
    else timerRef.current = window.setTimeout(flush, MEDIA_FILTER_PAUSE_MS);
  };

  const current = () => pendingRef.current ?? applied;
  const toggleKind = (kind: MediaKind) => change({ ...current(), kinds: toggleValue(current().kinds, kind) });
  const toggleCategory = (id: string) => change({ ...current(), categories: toggleValue(current().categories, id) });

  return { value, toggleKind, toggleCategory, flush, reset: drop };
}
