import { useEffect, useId, useRef, useState } from "react";
import {
  CUSTOM_NAVIGATION_ICONS,
  MAX_CUSTOM_NAVIGATION_ITEMS,
  MAX_NAVIGATION_LABEL_LENGTH,
  MAX_NAVIGATION_URL_LENGTH,
  customNavigationCount,
  isSafeNavigationUrl,
  normalizeNavigationUrl,
  type CustomDestination,
  type CustomNavItem,
  type CustomNavLink,
} from "../lib/custom-navigation";
import { ActionControl } from "./ui/ActionControl";
import { Icon, type IconName } from "./ui/Icon";
import { AsyncActionButton, Button, InlineMessage, Select, TextInput } from "./ui/Primitives";

export type SearchNavigationContent = (
  kind: "post" | "page",
  query: string,
  page: number,
  refresh?: boolean,
) => Promise<{ items: { id: string; label: string }[]; pageCount: number }>;

function newLink(): CustomNavLink {
  return { id: `custom:${crypto.randomUUID()}`, kind: "link", label: "", destination: { kind: "url", url: "" } };
}

function normalizedDestination(destination: CustomDestination): CustomDestination {
  if (destination.kind !== "url") return destination;
  return { kind: "url", url: normalizeNavigationUrl(destination.url, window.location.origin) };
}

function validLink(link: CustomNavLink): boolean {
  if (!link.label.trim() || link.label.length > MAX_NAVIGATION_LABEL_LENGTH) return false;
  const destination = normalizedDestination(link.destination);
  return destination.kind === "url"
    ? isSafeNavigationUrl(destination.url)
    : /^[A-Za-z0-9_-]{1,128}$/.test(destination.id);
}

function IdentityFields({ item, onChange, autoFocus = false }: {
  item: CustomNavItem;
  onChange: (patch: { label?: string; icon?: IconName }) => void;
  autoFocus?: boolean;
}) {
  const base = useId();
  const icons: readonly IconName[] = item.icon && !CUSTOM_NAVIGATION_ICONS.some((icon) => icon === item.icon)
    ? [...CUSTOM_NAVIGATION_ICONS, item.icon]
    : CUSTOM_NAVIGATION_ICONS;
  return (
    <div className="custom-nav-fields">
      <div className="editor-field">
        <label className="editor-field-label" htmlFor={`${base}-label`}>Label (required)</label>
        <TextInput autoFocus={autoFocus} id={`${base}-label`} maxLength={MAX_NAVIGATION_LABEL_LENGTH}
          required value={item.label} onChange={(event) => onChange({ label: event.target.value })}
          aria-describedby={`${base}-label-help`} />
        <small className="editor-field-help" id={`${base}-label-help`}>{item.label.length} of {MAX_NAVIGATION_LABEL_LENGTH} characters used.</small>
      </div>
      <div className="editor-field">
        <label className="editor-field-label" htmlFor={`${base}-icon`}>Icon</label>
        <Select id={`${base}-icon`} value={item.icon ?? ""}
          onChange={(event) => onChange({ icon: event.target.value ? event.target.value as IconName : undefined })}>
          <option value="">Default icon</option>
          {icons.map((icon) => <option key={icon} value={icon}>{icon.charAt(0).toUpperCase() + icon.slice(1).replaceAll("-", " ")}</option>)}
        </Select>
      </div>
    </div>
  );
}

function DestinationFields({ destination, onChange, searchContent, busy, onBusyChange }: {
  destination: CustomDestination;
  onChange: (destination: CustomDestination) => void;
  searchContent?: SearchNavigationContent;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const base = useId();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ id: string; label: string }[] | null>(null);
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ id: string; label: string } | null>(null);
  const request = useRef(0);
  const searching = useRef(false);
  const picker = useRef<HTMLDivElement>(null);
  const wasBusy = useRef(false);
  useEffect(() => () => { request.current += 1; }, []);
  useEffect(() => {
    if (wasBusy.current && !busy) picker.current?.querySelector<HTMLButtonElement>(".async-action-button")?.focus();
    wasBusy.current = busy;
  }, [busy]);

  function chooseKind(kind: CustomDestination["kind"]): void {
    setResults(null);
    setError(null);
    setPageCount(0);
    setQuery("");
    setSelection(null);
    onChange(kind === "url" ? { kind, url: "" } : { kind, id: "" });
  }

  async function search(nextPage: number, refresh = false): Promise<void> {
    if (busy || searching.current || !searchContent || destination.kind === "url") return;
    const current = ++request.current;
    searching.current = true;
    onBusyChange(true);
    setError(null);
    try {
      const response = await searchContent(destination.kind, query.trim(), nextPage, refresh);
      if (request.current !== current) return;
      setResults(response.items);
      setPage(nextPage);
      setPageCount(response.pageCount);
    } catch {
      if (request.current === current) setError("Content could not be loaded. Try the search again.");
    } finally {
      if (request.current === current) {
        searching.current = false;
        onBusyChange(false);
      }
    }
  }

  const normalized = normalizedDestination(destination);
  const unsafeUrl = normalized.kind === "url" && Boolean(normalized.url) && !isSafeNavigationUrl(normalized.url);
  return (
    <div className="custom-nav-destination" ref={picker}>
      <div className="editor-field">
        <label className="editor-field-label" htmlFor={`${base}-kind`}>Links to</label>
        <Select id={`${base}-kind`} value={destination.kind} onChange={(event) => chooseKind(event.target.value as CustomDestination["kind"])}>
          <option value="url">CMS path or HTTPS address</option>
          <option value="post" disabled={!searchContent && destination.kind !== "post"}>Post</option>
          <option value="page" disabled={!searchContent && destination.kind !== "page"}>Page</option>
        </Select>
      </div>
      {destination.kind === "url" ? (
        <div className="editor-field">
          <label className="editor-field-label" htmlFor={`${base}-url`}>Address (required)</label>
          <TextInput id={`${base}-url`} required value={destination.url} maxLength={MAX_NAVIGATION_URL_LENGTH}
            aria-invalid={unsafeUrl || undefined} aria-describedby={`${base}-url-help${unsafeUrl ? ` ${base}-url-error` : ""}`}
            onChange={(event) => onChange({ kind: "url", url: event.target.value })}
            onBlur={() => onChange(normalizedDestination(destination))} />
          <small className="editor-field-help" id={`${base}-url-help`}>Use a CMS path such as /content, or an HTTPS address. External links open in a new tab.</small>
          {unsafeUrl ? <InlineMessage id={`${base}-url-error`} tone="error">Enter a CMS path or a valid HTTPS address.</InlineMessage> : null}
        </div>
      ) : (
        <div className="custom-nav-content-picker">
          <div className="editor-field">
            <label className="editor-field-label" htmlFor={`${base}-query`}>Search {destination.kind === "post" ? "posts" : "pages"}</label>
            <TextInput id={`${base}-query`} value={query} disabled={!searchContent}
              onChange={(event) => { setQuery(event.target.value); setResults(null); setPageCount(0); setError(null); }}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void search(1, true); } }} />
          </div>
          <AsyncActionButton label="Search" pendingLabel="Searching…" pending={busy} disabled={!searchContent}
            pendingAnnouncement="Searching content." onClick={() => void search(1, true)} />
          {!searchContent ? <InlineMessage>Content search is unavailable.</InlineMessage> : null}
          {destination.id ? <p className="editor-field-help" role="status">Selected {destination.kind}: {selection?.id === destination.id ? selection.label : destination.id}</p> : null}
          {error ? <InlineMessage tone="error">{error}</InlineMessage> : null}
          {results ? (
            <>
              <p className="editor-field-help" role="status">{results.length ? `${results.length} results. Page ${page} of ${Math.max(1, pageCount)}.` : "No matching content found."}</p>
              <ul className="custom-nav-search-results" aria-label="Content search results">
                {results.map((result) => (
                  <li key={result.id}><Button aria-pressed={destination.id === result.id}
                    onClick={() => { setSelection(result); onChange({ kind: destination.kind, id: result.id }); }}>{result.label}</Button></li>
                ))}
              </ul>
              {pageCount > 1 ? <div className="custom-nav-paging">
                <ActionControl action="previous-page" disabled={busy || page <= 1} onClick={() => void search(page - 1)} />
                <ActionControl action="next-page" disabled={busy || page >= pageCount} onClick={() => void search(page + 1)} />
              </div> : null}
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function CustomNavigationEditor({ item, remaining, onApply, onCancel, searchContent, hiddenIds, onHiddenChange }: {
  item?: CustomNavItem;
  remaining: number;
  onApply: (item: CustomNavItem) => void;
  onCancel: () => void;
  searchContent?: SearchNavigationContent;
  hiddenIds: readonly string[];
  onHiddenChange: (id: string, hidden: boolean) => void;
}) {
  const base = useId();
  const [draft, setDraft] = useState<CustomNavItem>(() => item ?? newLink());
  const [child, setChild] = useState<CustomNavLink | null>(null);
  const [hidden, setHidden] = useState(() => new Set(hiddenIds));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [focusRequest, setFocusRequest] = useState<string | null>(null);
  const controls = useRef(new Map<string, HTMLButtonElement>());
  useEffect(() => {
    if (!focusRequest) return;
    controls.current.get(focusRequest)?.focus();
    setFocusRequest(null);
  }, [focusRequest]);

  const capacity = Math.min(MAX_CUSTOM_NAVIGATION_ITEMS, remaining);
  const size = customNavigationCount([draft]);
  const valid = Boolean(draft.label.trim()) && draft.label.length <= MAX_NAVIGATION_LABEL_LENGTH && size <= capacity
    && (draft.kind === "link" ? validLink(draft) : draft.links.every(validLink));

  function updateIdentity(patch: { label?: string; icon?: IconName }): void {
    setDraft((current) => {
      const next = { ...current, ...patch };
      if (next.icon === undefined) delete next.icon;
      return next;
    });
    setError(null);
  }

  function apply(): void {
    if (busy || child || !valid) return;
    const next = draft.kind === "link"
      ? { ...draft, label: draft.label.trim(), destination: normalizedDestination(draft.destination) }
      : { ...draft, label: draft.label.trim(), links: draft.links.map((link) => ({ ...link, label: link.label.trim(), destination: normalizedDestination(link.destination) })) };
    try {
      if (next.kind === "section") {
        for (const link of next.links) {
          if (hidden.has(link.id) !== hiddenIds.includes(link.id)) onHiddenChange(link.id, hidden.has(link.id));
        }
      }
      onApply(next);
    } catch { setError(draft.kind === "section" ? "This span could not be applied. Try again." : "This plank could not be applied. Try again."); }
  }

  function applyChild(): void {
    if (busy || !child || !validLink(child) || draft.kind !== "section") return;
    const exists = draft.links.some((link) => link.id === child.id);
    if (!exists && size >= capacity) return;
    const link = { ...child, label: child.label.trim(), destination: normalizedDestination(child.destination) };
    setDraft({ ...draft, links: exists ? draft.links.map((current) => current.id === link.id ? link : current) : [...draft.links, link] });
    setChild(null);
    setAnnouncement(`${link.label} ${exists ? "updated" : "added"} in the span.`);
    setFocusRequest(`${link.id}:edit`);
  }

  function moveChild(id: string, direction: -1 | 1): void {
    if (draft.kind !== "section") return;
    const links = [...draft.links];
    const from = links.findIndex((link) => link.id === id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= links.length) return;
    [links[from], links[to]] = [links[to], links[from]];
    setDraft({ ...draft, links });
    setAnnouncement(`${links[to].label} moved to position ${to + 1} of ${links.length}.`);
    const action = to === 0 ? "move-down" : to === links.length - 1 ? "move-up" : direction === -1 ? "move-up" : "move-down";
    setFocusRequest(`${id}:${action}`);
  }

  function removeChild(link: CustomNavLink): void {
    if (draft.kind !== "section") return;
    const index = draft.links.findIndex((current) => current.id === link.id);
    const links = draft.links.filter((current) => current.id !== link.id);
    setHidden((current) => { const next = new Set(current); next.delete(link.id); return next; });
    setDraft({ ...draft, links });
    setAnnouncement(`${link.label} removed from the span.`);
    setFocusRequest(links[Math.min(index, links.length - 1)] ? `${links[Math.min(index, links.length - 1)].id}:edit` : "add-child");
  }

  function buttonRef(key: string) {
    return (node: HTMLButtonElement | null) => { if (node) controls.current.set(key, node); else controls.current.delete(key); };
  }

  return (
    <fieldset className="custom-nav-editor" disabled={busy} aria-busy={busy || undefined}>
      <legend>{draft.kind === "section" ? (item ? "Edit span" : "Add a span") : (item ? "Edit plank" : "Add a plank")}</legend>
      <span className="sr-only" role="status" aria-atomic="true">{announcement}</span>
      {!item ? <div className="editor-field">
        <label className="editor-field-label" htmlFor={`${base}-type`}>Type</label>
        <Select id={`${base}-type`} value={draft.kind} disabled={Boolean(child)} onChange={(event) => {
          setDraft(event.target.value === "section"
            ? { id: draft.id, kind: "section", label: draft.label, ...(draft.icon ? { icon: draft.icon } : {}), links: [] }
            : { id: draft.id, kind: "link", label: draft.label, ...(draft.icon ? { icon: draft.icon } : {}), destination: { kind: "url", url: "" } });
        }}><option value="link">Plank</option><option value="section">Span</option></Select>
      </div> : null}
      <IdentityFields item={draft} onChange={updateIdentity} autoFocus />
      {draft.kind === "link" ? <DestinationFields destination={draft.destination}
        onChange={(destination) => setDraft({ ...draft, destination })} searchContent={searchContent} busy={busy} onBusyChange={setBusy} /> : (
        <div className="custom-nav-section">
          <h3>Span planks</h3>
          <ol className="nav-preference-list" aria-label="Span plank order">
            {draft.links.map((link, index) => {
              const isHidden = hidden.has(link.id);
              return <li className="nav-preference-row" key={link.id} data-hidden={isHidden}>
                <span className="nav-preference-identity"><Icon name={link.icon ?? "link"} /><span className="nav-preference-name">{link.label}</span></span>
                <span className="nav-preference-state">{isHidden ? "Hidden" : "Shown"}</span>
                <span className="nav-preference-controls">
                  <ActionControl action="move-up" contextLabel={link.label} disabled={Boolean(child) || index === 0}
                    ref={buttonRef(`${link.id}:move-up`)} onClick={() => moveChild(link.id, -1)} />
                  <ActionControl action="move-down" contextLabel={link.label} disabled={Boolean(child) || index === draft.links.length - 1}
                    ref={buttonRef(`${link.id}:move-down`)} onClick={() => moveChild(link.id, 1)} />
                  <ActionControl action={isHidden ? "show" : "hide"} label={isHidden ? "Show in navigation" : "Hide from navigation"}
                    contextLabel={link.label} disabled={Boolean(child)} onClick={() => {
                      setHidden((current) => {
                        const next = new Set(current);
                        if (isHidden) next.delete(link.id); else next.add(link.id);
                        return next;
                      });
                      setAnnouncement(`${link.label} ${isHidden ? "shown in" : "hidden from"} your navigation. Access does not change.`);
                    }} />
                  <Button aria-label={`Edit ${link.label}`} ref={buttonRef(`${link.id}:edit`)}
                    disabled={Boolean(child)} onClick={() => setChild(link)}><Icon name="pencil" /> Edit</Button>
                  <Button aria-label={`Delete ${link.label}`} variant="danger-quiet"
                    disabled={Boolean(child)} onClick={() => removeChild(link)}><Icon name="trash" /> Delete</Button>
                </span>
              </li>;
            })}
          </ol>
          {!draft.links.length ? <p className="editor-field-help">Add planks to this span.</p> : null}
          {child ? <fieldset className="custom-nav-child-editor">
            <legend>{draft.links.some((link) => link.id === child.id) ? "Edit span plank" : "Add span plank"}</legend>
            <IdentityFields item={child} autoFocus onChange={(patch) => {
              const next = { ...child, ...patch }; if (next.icon === undefined) delete next.icon; setChild(next);
            }} />
            <DestinationFields key={child.id} destination={child.destination} onChange={(destination) => setChild({ ...child, destination })}
              searchContent={searchContent} busy={busy} onBusyChange={setBusy} />
            <div className="nav-preferences-actions">
              <Button onClick={() => {
                setChild(null);
                setFocusRequest(draft.links.some((link) => link.id === child.id) ? `${child.id}:edit` : "add-child");
              }}>Cancel plank</Button>
              <Button variant="primary" disabled={!validLink(child) || (!draft.links.some((link) => link.id === child.id) && size >= capacity)}
                onClick={applyChild}>Apply plank</Button>
            </div>
          </fieldset> : <ActionControl action="add-block" label="Add span plank" disabled={size >= capacity}
            ref={buttonRef("add-child")} onClick={() => setChild(newLink())} />}
        </div>
      )}
      <p className="editor-field-help">Planks and spans each count toward the {MAX_CUSTOM_NAVIGATION_ITEMS}-entry limit. {Math.max(0, capacity - size)} slots remain after this {draft.kind === "section" ? "span" : "plank"}.</p>
      {size > capacity ? <InlineMessage tone="error">The custom navigation limit has been reached. Remove a plank or span before you apply this change.</InlineMessage> : null}
      {error ? <InlineMessage tone="error">{error}</InlineMessage> : null}
      <div className="nav-preferences-actions">
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="primary" disabled={!valid || Boolean(child) || busy} onClick={apply}>{draft.kind === "section" ? "Apply span" : "Apply plank"}</Button>
      </div>
    </fieldset>
  );
}
