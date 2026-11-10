import { useEffect, useRef } from "react";
import { useSuccessNotice } from "../components/ui/SuccessNoticeRegion";

/** Restores only the canonical URL that preceded a Clear filters navigation. */
export function useClearFilterUndo(routeKey: string, search: string, restore: (search: string) => void) {
  const notice = useSuccessNotice();
  const pending = useRef<{ before: string; after: string; routeKey: string } | null>(null);
  const currentSearch = useRef(search);
  const restoreCurrent = useRef(restore);
  currentSearch.current = search;
  restoreCurrent.current = restore;

  useEffect(() => {
    const cleared = pending.current;
    if (!cleared || cleared.routeKey === routeKey) return;
    pending.current = null;
    if (search !== cleared.after) return;
    // The notice provider clears the preceding route's notice in this commit.
    window.setTimeout(() => {
      if (!notice.isCurrent() || currentSearch.current !== cleared.after) return;
      notice.show("Filters cleared.", { action: { label: "Undo", onClick: () => {
        if (notice.isCurrent() && currentSearch.current === cleared.after) restoreCurrent.current(cleared.before);
      } } });
    }, 0);
  }, [notice, routeKey, search]);

  return (before: string, after: string) => {
    if (before === after) return false;
    pending.current = { before, after, routeKey };
    return true;
  };
}
