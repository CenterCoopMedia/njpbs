import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigationType } from "react-router";

// The focus and announcement manager for route changes. No router supplies this: React Router
// leaves route focus and screen-reader announcements to the application, so the accessible
// behavior on navigation is owned here (#587 focus-after-navigation). The contract:
//
//  - A direct page load follows normal browser behavior; the initial render never moves focus.
//  - A link navigation (PUSH/REPLACE) moves focus to the new route's heading so a keyboard or
//    screen-reader user lands on the content, and the route label is announced politely.
//  - Back or forward (POP) restores focus to the control that was focused on the destination
//    entry when it still exists, so returning to a list lands on the row the user left from;
//    otherwise it falls back to the heading.
//  - A query-only change (same pathname, different search) does not move focus, so re-filtering
//    a list does not yank a keyboard user back to the heading. The result count is announced
//    separately by the caller.

// The heading a route change focuses. The shell renders the page title with this id, and the
// element is made programmatically focusable without becoming a tab stop.
const HEADING_ID = "page-title";

// The element most recently focused while on a given history entry, keyed by the entry's
// location.key, so a POP back to that entry can restore it. Module-scoped because it must
// outlive the component across navigations within one session.
const focusByLocationKey = new Map<string, HTMLElement>();

function routeHeading(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-route-focus-heading]") ??
    document.getElementById(HEADING_ID);
}

function focusHeading(): string | null {
  const heading = routeHeading();
  if (!heading) return null;
  // Make the heading programmatically focusable without adding it to the tab order, then focus
  // it without scrolling, so the page position is left to ScrollRestoration.
  if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
  heading.focus({ preventScroll: true });
  return heading.textContent?.trim() || null;
}

// A polite live region and an announce function. The zero-width space forces a DOM change when
// the same text is announced twice in a row, so a repeated label still re-announces.
export function useRouteAnnouncer(): {
  message: string;
  announce: (text: string) => void;
} {
  const [message, setMessage] = useState("");
  const announce = useCallback((text: string) => {
    // A trailing space forces a DOM change when the same text is announced twice in a row, so a
    // repeated label still re-announces. Assistive tech trims trailing whitespace, so the space
    // is never read aloud.
    setMessage((previous) => (previous === text ? `${text} ` : text));
  }, []);
  return { message, announce };
}

export function useRouteFocus(options: {
  label: string;
  announce: (text: string) => void;
}): void {
  const { label, announce } = options;
  const location = useLocation();
  const navigationType = useNavigationType();

  // The label and announce reads at navigation time, held in refs so the navigation effect can
  // depend only on location.key and never fire from an unrelated parent re-render.
  const labelRef = useRef(label);
  labelRef.current = label;
  const announceRef = useRef(announce);
  announceRef.current = announce;

  const currentKeyRef = useRef(location.key);
  const previousPathnameRef = useRef(location.pathname);
  const isInitialRef = useRef(true);

  // Record the last focused element per history entry, so a later POP can restore it. A single
  // document-level listener covers the whole shell; it stores against the key current at focus
  // time, which is always the entry the user is on.
  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement) {
        focusByLocationKey.set(currentKeyRef.current, target);
      }
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, []);

  useEffect(() => {
    currentKeyRef.current = location.key;

    // A direct load or the first render follows normal browser focus behavior.
    if (isInitialRef.current) {
      isInitialRef.current = false;
      previousPathnameRef.current = location.pathname;
      return;
    }

    const pathnameChanged = location.pathname !== previousPathnameRef.current;
    previousPathnameRef.current = location.pathname;

    // A query-only change re-filters in place; it must not move focus to the heading.
    if (!pathnameChanged) return;

    let restored = false;
    if (navigationType === "POP") {
      const prior = focusByLocationKey.get(location.key);
      if (prior && document.contains(prior)) {
        prior.focus({ preventScroll: true });
        restored = true;
      }
    }
    const focusedLabel = restored
      ? routeHeading()?.textContent?.trim() || null
      : focusHeading();

    announceRef.current(focusedLabel ?? labelRef.current);
    // location.key changes on every navigation (push, replace, and pop), so this is the single
    // signal that a navigation happened.
  }, [location.key, location.pathname, navigationType]);
}
