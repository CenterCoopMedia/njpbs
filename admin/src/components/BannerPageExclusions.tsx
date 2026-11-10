import { useLayoutEffect, useRef, useState, type ContextType } from "react";
import { ContentShelfPicker, ContentShelfSources } from "./ContentShelfPicker";
import { ActionControl } from "./ui/ActionControl";
import "./BannerPageExclusions.css";

// The remaining listing routes are code-owned; PUBLIC_PAGES supplies Home and service Pages.
const LISTING_PAGES = [
  { id: "route-posts", title: "Posts", path: "/posts/" },
  { id: "route-programs", title: "Programs", path: "/programs/" },
  { id: "route-events", title: "Events", path: "/events/" },
  { id: "route-search", title: "Search", path: "/search/" },
  { id: "route-coverage", title: "Coverage", path: "/coverage/" },
] as const;

export function BannerPageExclusions({ paths, onChange, disabled, sources }: {
  paths: readonly string[];
  onChange: (paths: string[]) => void;
  disabled: boolean;
  sources?: ContextType<typeof ContentShelfSources>;
}) {
  const [notice, setNotice] = useState("");
  const group = useRef<HTMLFieldSetElement>(null);
  const pendingFocus = useRef<number | "group" | null>(null);
  useLayoutEffect(() => {
    const target = pendingFocus.current;
    if (target === null) return;
    pendingFocus.current = null;
    const buttons = group.current?.querySelectorAll<HTMLButtonElement>('button[data-action="remove-item"]');
    const destination = typeof target === "number"
      ? buttons?.[Math.min(target, buttons.length - 1)] ?? group.current?.querySelector<HTMLElement>("summary")
      : group.current;
    destination?.focus();
  }, [paths]);
  return <fieldset ref={group} tabIndex={-1} className="record-field-group public-banner-exclusions" disabled={disabled}>
    <legend>Hide the NJ Decides band on these pages</legend>
    <p className="muted">The band appears across the site except on these published URLs and Pages with the NJ Decides heading. Reselect a Page or Post after its URL changes.</p>
    <ul>
      {paths.map((path, index) => <li key={path}><code>{path}</code>{" "}<ActionControl action="remove-item"
        label="Remove" accessibleName={`Show the NJ Decides band on ${path}`} disabled={disabled}
        onClick={() => { pendingFocus.current = index; onChange(paths.filter(value => value !== path)); setNotice(`Removed ${path}. Save and publish to show the band there.`); }} /></li>)}
    </ul>
    <p className="muted">{paths.length} of 50 pages selected.</p>
    {paths.length < 50 && <ContentShelfSources.Provider value={sources ?? {}}>
      <ContentShelfPicker purpose="banner" disabled={disabled} additionalPages={LISTING_PAGES} onAdd={card => {
        const href = card.href;
        if (typeof href !== "string" || paths.includes(href)) { setNotice("That page is already selected."); return; }
        if (paths.length === 49) pendingFocus.current = "group";
        onChange([...paths, href]);
        setNotice(`Selected ${href}. Save and publish to hide the band there.`);
      }} />
    </ContentShelfSources.Provider>}
    <p role="status">{notice}</p>
  </fieldset>;
}
