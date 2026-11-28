import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { shouldSuppressTabClick, tabEdgeFade, tabRevealOffset, type MediaTab } from "../../lib/media-tabs";
import { Icon } from "../ui/Icon";
import "./MediaTabs.css";

export interface MediaTabsProps {
  /** The tabs in order, from mediaTabs(). A tab without a count shows none. */
  tabs: readonly MediaTab[];
  /** The current tab id, or null when no tab is current. */
  currentId: string | null;
}

function carriedSearch(query: string | undefined) {
  return query ? `?${new URLSearchParams({ q: query })}` : "";
}

/** The trimmed text in the page's media search field, or null when the page has none. */
function visibleSearch() {
  const input = document.querySelector<HTMLInputElement>("form.media-search-field input[type=search]");
  return input ? input.value.trim() : null;
}

// The media tab strip. Each tab is its own page, so
// the strip is a row of links with native tab order, not an ARIA tab list. It scrolls
// sideways instead of wrapping and never scrolls the page to show the current tab.
export function MediaTabs({ currentId, tabs }: MediaTabsProps) {
  const location = useLocation();
  // A search follows the person to the next tab, so one query covers Images, Videos and Audio.
  const query = new URLSearchParams(location.search).get("q")?.trim();
  const carried = carriedSearch(query);
  const navigate = useNavigate();
  const stripRef = useRef<HTMLElement>(null);
  const currentRef = useRef<HTMLAnchorElement>(null);

  const updateFade = useCallback(() => {
    const strip = stripRef.current;
    if (strip) strip.dataset.fade = tabEdgeFade(strip);
  }, []);

  // scrollIntoView could also scroll the page, so the strip's own scrollLeft moves instead.
  const reveal = useCallback(() => {
    const strip = stripRef.current;
    const offset = strip ? tabRevealOffset(strip, currentRef.current) : null;
    if (strip && offset !== null) strip.scrollLeft = offset;
    updateFade();
  }, [updateFade]);

  // Counts often arrive after the first paint and widen the tabs, so any change to what the
  // tabs show can start or end an overflow, or push the current tab out of view.
  const content = tabs.map((tab) => `${tab.id}:${tab.label}:${tab.count ?? ""}`).join("|");
  useLayoutEffect(() => {
    reveal();
  }, [content, currentId, reveal]);

  // A late web font also widens the tabs, so measure again once the fonts settle.
  useEffect(() => {
    window.addEventListener("resize", reveal);
    document.fonts?.addEventListener("loadingdone", reveal);
    void document.fonts?.ready.then(reveal);
    return () => {
      window.removeEventListener("resize", reveal);
      document.fonts?.removeEventListener("loadingdone", reveal);
    };
  }, [reveal]);

  return (
    <div className="media-tabs-frame">
      <nav aria-label="Media sources" className="media-tabs" data-fade="none" onScroll={updateFade} ref={stripRef}>
        {tabs.map((tab) => {
          const current = tab.id === currentId;
          return (
            <Link
              aria-current={current ? "page" : undefined}
              className="media-tab"
              key={tab.id}
              onClick={(event) => {
                // Only a plain click on the page already shown does nothing, so its query stays.
                if (shouldSuppressTabClick(event, tab.path, location.pathname)) {
                  event.preventDefault();
                  return;
                }
                // The field can hold text that has not applied yet: it is in its typing pause, or
                // locked behind unsaved details. A plain click carries the text the person sees.
                if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
                const visible = visibleSearch();
                if (visible === null || visible === (query ?? "")) return;
                event.preventDefault();
                navigate(`${tab.path}${carriedSearch(visible)}`);
              }}
              ref={current ? currentRef : undefined}
              to={`${tab.path}${carried}`}
            >
              <Icon name={tab.icon} />
              <span className="media-tab-label">{tab.label}</span>
              {typeof tab.count === "number" ? (
                <>
                  {" "}
                  <span className="media-tab-count">
                    {tab.count.toLocaleString("en-US")}
                    {" "}
                    <span className="sr-only">{tab.count === 1 ? "item" : "items"}</span>
                  </span>
                </>
              ) : null}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
