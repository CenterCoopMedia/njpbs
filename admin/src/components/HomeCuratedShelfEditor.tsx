import { useEditorWorkspaceView } from "../context/EditorWorkspaceView";
import { useEffect, useRef, useState } from "react";
import type { ContentShelfBlock, ContentShelfItemLimit } from "../../../packages/content-core/src/content-model";
import { HOME_SOURCE_LOCKS, homeSourceDuplicates, type HomeSourceSection } from "../../../packages/content-core/src/home-source-curation";
import { homeCatalogJson, resolveHomeShelf, type HomeEditorialSourceReceipt } from "../../../packages/content-core/src/home-source-catalog";
import type { HomeSourceSnapshot } from "../../../packages/content-core/src/home-rail-render";
import type { AdminBlock } from "../lib/block-factory";
import { loadHomeSourceSnapshot } from "../lib/home-source-snapshot";
import { useReorder } from "../hooks/useReorder";
import { ReorderHandle } from "./ReorderHandle";
import { ActionControl } from "./ui/ActionControl";
import { Button, Select, TextInput } from "./ui/Primitives";
import "./HomeCuratedShelfEditor.css";

export function HomeCuratedShelfEditor({ block, blocks, onChange, readOnly = false, loadSources = loadHomeSourceSnapshot }: {
  block: AdminBlock; blocks: AdminBlock[]; onChange: (data: Record<string, unknown>, discrete?: boolean) => void;
  readOnly?: boolean; loadSources?: (signal: AbortSignal) => Promise<HomeSourceSnapshot>;
}) {
  const shared = Boolean(useEditorWorkspaceView()?.kind);
  const shelf = block as unknown as ContentShelfBlock;
  const section = shelf.section as HomeSourceSection;
  const lock = HOME_SOURCE_LOCKS[section];
  const [catalog, setCatalog] = useState<HomeEditorialSourceReceipt>();
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [attempt, setAttempt] = useState(0);
  const searchRef = useRef<HTMLLabelElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setCatalog(undefined); setError("");
    const timer = window.setTimeout(() => controller.abort(), 10_000);
    void loadSources(controller.signal).then(value => {
      if (!value.editorial) throw new Error("The published source catalog is unavailable. Your selections are still saved.");
      if (current && !controller.signal.aborted) setCatalog(value.editorial);
    }).catch(() => { if (current) setError("Published cards could not be loaded. Keep your selections or try again."); })
      .finally(() => window.clearTimeout(timer));
    return () => { current = false; controller.abort(); window.clearTimeout(timer); };
  }, [loadSources, attempt]);
  const snapshot = catalog?.catalog.sources[section];
  const available = snapshot?.status === "ready" ? snapshot.cards : [];
  const selected = shelf.data.selectedIds ?? [];
  const picked = shelf.data.selectedIds !== undefined;
  const sourceLabel = { "home-featured": "PBS featured programs", "home-more": "PBS programs",
    "home-spotlight": "NJ Spotlight News", "home-posts": "Published NJ PBS Posts" }[section];
  const resolved = catalog ? resolveHomeShelf(shelf, catalog.catalog) : undefined;
  const duplicates = catalog ? homeSourceDuplicates(blocks.flatMap(candidate => candidate.type === "content_shelf" &&
    HOME_SOURCE_LOCKS[candidate.section as HomeSourceSection] ? [resolveHomeShelf(candidate as unknown as ContentShelfBlock, catalog.catalog)] : [])) : [];
  function replace(ids: string[]) {
    if (readOnly || !catalog || ids.length > shelf.data.itemLimit) return;
    onChange({ ...shelf.data, selectedIds: ids, selectionReceipt: catalog.receipt }, true);
  }
  function move(id: string, target: string, after: boolean) {
    const ids = selected.filter(candidate => candidate !== id);
    ids.splice(ids.indexOf(target) + (after ? 1 : 0), 0, id); replace(ids);
  }
  const reorder = useReorder({ mouseDrag: "pointer", items: selected.map(id => ({ id, label: available.find(card => card.id === id)?.title ?? `Unavailable card: ${id}` })),
    disabled: readOnly || !catalog || !picked, onMove: (id, destination) => move(id, destination.targetId, destination.after) });
  const limits = [3, 4, 6, 8, 12, 16, 24].filter(limit => limit <= lock.cap);
  const technicalControls = <>
    <label>Layout<Select value={shelf.data.presentation ?? "rail"} disabled={readOnly} onChange={event => onChange({ ...shelf.data, presentation: event.target.value,
      ...(event.target.value === "list" && selected.length <= 3 ? { itemLimit: 3 } : {}),
    }, true)}><option value="rail">Rail</option><option value="grid">Grid</option><option value="two_features">Two features</option><option value="list">List</option></Select></label>
    {shelf.data.presentation === "grid" ? <label>Desktop columns<Select value={shelf.data.columns ?? 3} disabled={readOnly} onChange={event => onChange({ ...shelf.data, columns: Number(event.target.value) }, true)}>{[2, 3, 4].map(count => <option key={count}>{count}</option>)}</Select></label> : null}
    <label>Card selection<Select value={picked ? "picked" : "automatic"} disabled={readOnly || !catalog} onChange={event => {
      if (event.target.value === "picked") replace(resolved?.cards.map(card => card.id) ?? []);
      else { const { selectedIds: _ids, selectionReceipt: _receipt, ...automatic } = shelf.data; onChange(automatic, true); }
    }}><option value="automatic">Automatic</option><option value="picked">Hand-picked</option></Select></label>
    <label>More-link label<TextInput value={shelf.data.moreLabel} maxLength={120} disabled={readOnly} onChange={event => onChange({ ...shelf.data, moreLabel: event.target.value })} /></label>
  </>;
  const sourceWarnings = <>
    {!picked && resolved?.emptyReason ? <p role="alert">{shelf.data.title} will not appear on Home: {resolved.emptyReason === "source_error" ? "the published source is unavailable" : "this source has no eligible published cards"}. No fallback cards replace it.</p> : null}
    {snapshot?.status === "error" ? <p role="alert">This source is unavailable. No replacement cards appear.</p> : null}
    {resolved?.missingIds.length ? <p role="alert">{resolved.missingIds.length} selected {resolved.missingIds.length === 1 ? "card is" : "cards are"} withdrawn or unavailable. Their IDs stay saved; they do not appear on Home.</p> : null}
    {duplicates.length ? <p role="status">Some stories are selected in more than one Home section.</p> : null}
  </>;
  const sourceControls = <>
    <p>Source: {sourceLabel}. Browse destination: {lock.browseHref}. {picked ? "Selected cards keep their order; published corrections flow through." : "Cards update automatically from this published source."}</p>
    {error ? shared ? null : <div role="alert"><p>{error}</p><Button onClick={() => setAttempt(value => value + 1)}>Reload published cards</Button></div> : !catalog ? shared ? null : <p role="status">Loading published cards…</p> : <p>Published generation {catalog.receipt.generation}.</p>}
    {picked && catalog && homeCatalogJson(shelf.data.selectionReceipt) !== homeCatalogJson(catalog.receipt)
      ? <Button disabled={readOnly} onClick={() => replace([...selected])}>Use current published cards</Button> : null}
    {shelf.data.selectedIds === undefined ? <Button disabled={readOnly || !catalog} onClick={() => replace(resolved?.cards.map(card => card.id) ?? [])}>Keep these source cards</Button> : null}
    {picked ? <><p id={reorder.helpId}>{reorder.instructions}</p><p role="status" aria-live="polite">{reorder.announcement}</p>
    <ol aria-label="Selected source cards">{selected.map((id, index) => <li key={id} {...reorder.itemProps(id)}>
      <div className="home-source-selection-card">
      <ReorderHandle {...reorder.handleProps(id)} aria-label={`Move selected card: ${available.find(card => card.id === id)?.title ?? id}`} />
      <span>{available.find(card => card.id === id)?.title ?? `Unavailable card: ${id}`}</span>
      </div><div className="home-source-selection-actions">
      <ActionControl action="move-up" disabled={readOnly || !catalog || index === 0} accessibleName={`Move card ${index + 1} up`} onClick={() => move(id, selected[index - 1], false)} />
      <ActionControl action="move-down" disabled={readOnly || !catalog || index === selected.length - 1} accessibleName={`Move card ${index + 1} down`} onClick={() => move(id, selected[index + 1], true)} />
      <ActionControl action="remove-item" disabled={readOnly || !catalog} accessibleName={`Remove card ${index + 1}`} onClick={() => { replace(selected.filter(candidate => candidate !== id)); searchRef.current?.querySelector("input")?.focus(); }} />
      </div>
    </li>)}</ol>
    <label ref={searchRef}>Find published cards<TextInput value={query} onChange={event => setQuery(event.target.value)} /></label>
    <ul aria-label="Available source cards">{available.filter(card => !selected.includes(card.id) && card.title.toLowerCase().includes(query.toLowerCase())).map(card => <li key={card.id}>
      <ActionControl action="add-item" contextLabel={card.title} accessibleName={`Add ${card.title}`} disabled={readOnly || selected.length >= shelf.data.itemLimit} onClick={() => { replace([...selected, card.id]); searchRef.current?.querySelector("input")?.focus(); }} />
    </li>)}</ul></> : <ul aria-label="Automatic source cards">{resolved?.cards.map(card => <li key={card.id}>{card.title}</li>)}</ul>}
  </>;
  return <section className="home-source-selection" aria-label={`${shelf.data.title} source cards`}>
    <label>Heading<TextInput value={shelf.data.title} maxLength={120} disabled={readOnly} onChange={event => onChange({ ...shelf.data, title: event.target.value })} /></label>
    {shared ? <div><label>Source<Select value={shelf.data.source} disabled aria-describedby={`shelf-${block.id}-source-help`}>
      <option value={shelf.data.source}>{shelf.data.source === lock.source ? sourceLabel : `Saved source: ${shelf.data.source}`}</option>
    </Select></label><small id={`shelf-${block.id}-source-help`}>Published collection assigned to this section.</small></div> : null}
    <label className={shared ? "editor-source-limit" : undefined}>{shared ? "Maximum items" : "Number of cards"}<Select value={shelf.data.itemLimit} disabled={readOnly} onChange={event => onChange({ ...shelf.data, itemLimit: Number(event.target.value) as ContentShelfItemLimit }, true)}>
      {limits.map(limit => <option value={limit} key={limit} disabled={limit < selected.length}>{limit}</option>)}
    </Select></label>
    {shared ? <><p className="editor-source-policy">The source supplies the content. This section controls its presentation.</p>
      {error ? <div role="alert"><p>{error}</p><Button onClick={() => setAttempt(value => value + 1)}>Reload published cards</Button></div> : null}
      {!catalog && !error ? <p role="status">Loading published cards…</p> : null}
      {sourceWarnings}
      <details className="editor-technical-details"><summary>Technical details</summary><div>{technicalControls}{sourceControls}</div></details>
    </> : <>{technicalControls}{sourceWarnings}{sourceControls}</>}

  </section>;
}
