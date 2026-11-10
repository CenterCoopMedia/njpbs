import { useEffect, useId, useMemo, useRef, useState } from "react";
import { DATA_HUB_FIGURES, emptyDataHubReporting, emptyReportingMapping, parseDataHubReporting,
  reportingIdentityKey, reportingStoryUrl, selectReportingStories, type DataHubFigure, type DataHubReporting,
  type ReportingMapping, type ReportingStory, type ReportingTerm, type SelectedReportingStory } from "../../../packages/content-core/src/data-hub-reporting";
import { TokenInput } from "./ui/TokenInput";
import { ActionControl } from "./ui/ActionControl";
import { Button, InlineMessage, Select, TextInput } from "./ui/Primitives";
import type { PublishedVocabulary } from "../../../packages/content-core/src/published-vocabulary";
import "./DataHubReportingEditor.css";

export interface ReportingPreview {
  stories: ReportingStory[];
  checkedAt: string | null;
  failed: boolean;
  /** Source capture time, so preview and published ordering share the same cutoff. */
  cutoffAt: string;
}
export interface ReportingEditorTransport {
  preview: (mapping: ReportingMapping, signal: AbortSignal) => Promise<ReportingPreview>;
  terms: (taxonomy: "tags" | "categories", search: string, signal: AbortSignal) => Promise<ReportingTerm[]>;
  vocabulary: () => Promise<PublishedVocabulary>;
}

/** Existing Page metadata owns save/approval; this control edits one bounded value. */
export function DataHubReportingEditor({ value, onChange, transport, disabled = false, onDraftError, drafts: externalDrafts, onDraftsChange, controlId, revealRequest, error, selectedFigure, onRevealFigure }: {
  value: unknown; onChange: (value: DataHubReporting) => void;
  transport: ReportingEditorTransport; disabled?: boolean;
  onDraftError?: (message: string | null) => void;
  drafts?: Record<string,string>; onDraftsChange?: (drafts:Record<string,string>) => void;
  controlId?: string; revealRequest?: number; error?: string;
  selectedFigure?: DataHubFigure | "featured";
  onRevealFigure?: (figure: DataHubFigure | "featured") => void;
}) {
  const id = useId();
  let config = emptyDataHubReporting(); let invalid = false;
  try { config = parseDataHubReporting(value) ?? config; } catch { invalid = true; }
  const [opened, setOpened] = useState(false);
  const [localFigure, setFigure] = useState<DataHubFigure | "featured">("minimumwage");
  const figure = selectedFigure ?? localFigure;
  const [vocabulary, setVocabulary] = useState<PublishedVocabulary>({ tags: [], categories: [] });
  const [taxonomy, setTaxonomy] = useState<"tags" | "categories">("tags");
  const [query, setQuery] = useState("");
  const vocabularyRequested = useRef(false);
  const [resultTaxonomy, setResultTaxonomy] = useState<"tags" | "categories">("tags");
  const [results, setResults] = useState<ReportingTerm[]>([]);
  const [searched, setSearched] = useState(false);
  const [notice, setNotice] = useState("");
  const [localDrafts, setLocalDrafts] = useState<Record<string, string>>({});
  const drafts = externalDrafts ?? localDrafts;
  const setDrafts = (update: (current:Record<string,string>) => Record<string,string>) => {
    const next = Object.fromEntries(Object.entries(update(drafts)).filter(([,text]) => text.trim())); if (onDraftsChange) onDraftsChange(next); else setLocalDrafts(next);
  };
  const details = useRef<HTMLDetailsElement>(null);
  const revealFocus = useRef<{figure?: string; source?: string; taxonomy?: string} | null>(null);
  useEffect(() => {
    if (!revealRequest) return;
    details.current!.open = true; setOpened(true);
    const pending = Object.entries(drafts).find(([,text]) => text.trim());
    const [targetFigure,source,taxonomy] = pending?.[0].split("-") ?? [];
    revealFocus.current = { figure: targetFigure, source, taxonomy };
    if (targetFigure) {
      setFigure(targetFigure as DataHubFigure | "featured");
      onRevealFigure?.(targetFigure as DataHubFigure | "featured");
    }
  },[revealRequest]);
  useEffect(() => {
    const requested = revealFocus.current;
    if (!requested || !opened || requested.figure && requested.figure !== figure) return;
    const frame = requestAnimationFrame(() => {
      const target = requested.figure ? document.getElementById(`${id}-${requested.source}-${requested.taxonomy}`) : details.current;
      target?.focus();
      revealFocus.current = null;
    });
    return () => cancelAnimationFrame(frame);
  },[revealRequest, figure, opened, id]);
  const unfinished = Object.values(drafts).some(text => text.trim());
  const [termState, setTermState] = useState<"idle" | "loading" | "error">("idle");
  const [preview, setPreview] = useState<{ key: string; value?: ReportingPreview; error?: boolean }>();
  const [retry, setRetry] = useState(0);
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const termsRequest = useRef<AbortController | null>(null);
  const inherited = figure === "featured" && config.featured.inheritFigure;
  const mapping = figure === "featured" ? config.featured.inheritFigure ? config.figures.minimumwage ?? emptyReportingMapping() : config.featured.mapping
    : config.figures[figure] ?? emptyReportingMapping();
  const key = JSON.stringify({ figure, posts: mapping.posts, spotlight: mapping.spotlight,
    // Pin changes may need a previously unqueried story; hide/unpin stays local.
    pins: mapping.pins.map(reportingIdentityKey) });
  const requestMapping = useMemo(() => structuredClone(mapping), [key, retry]);
  useEffect(() => {
    onDraftError?.(invalid ? "Check the saved reporting mapping before editing." : unfinished ? "Finish adding or clear the reporting term before saving." : null);
  }, [invalid, unfinished, onDraftError]);
  useEffect(() => () => termsRequest.current?.abort(), []);
  useEffect(() => {
    termsRequest.current?.abort(); termsRequest.current = null;
    setResults([]); setSearched(false); setQuery(""); setTermState("idle");
  }, [figure]);
  useEffect(() => {
    if (!opened || invalid) return;
    const controller = new AbortController();
    let active = true;
    setPreview(undefined);
    const timeout = setTimeout(() => { controller.abort(); if (active) setPreview({ key, error: true }); }, 20_000);
    void transport.preview(requestMapping, controller.signal).then(value => {
      if (active && !controller.signal.aborted) setPreview({ key, value });
    }).catch(() => { if (active && !controller.signal.aborted) setPreview({ key, error: true }); }).finally(() => clearTimeout(timeout));
    return () => { active = false; clearTimeout(timeout); controller.abort(); };
  }, [opened, key, retry, requestMapping, transport, invalid]);
  async function loadVocabulary() {
    if (vocabularyRequested.current) return;
    vocabularyRequested.current = true;
    try { setVocabulary(await transport.vocabulary()); } catch { /* Manual saved terms remain usable. */ }
  }
  function commit(next: DataHubReporting) {
    if (new TextEncoder().encode(JSON.stringify(next)).length > 64 * 1024) {
      setNotice("Reporting selections are full. Remove some terms, pins or hidden stories before adding more."); return;
    }
    try { parseDataHubReporting(next); }
    catch { setNotice("Use up to five distinct terms per field. Presentation tags beginning format: are not reporting topics."); return; }
    setNotice(""); onChange(next);
  }
  function update(next: ReportingMapping) {
    commit(figure === "featured" ? { ...config, featured: { inheritFigure: false, mapping: next } }
      : { ...config, figures: { ...config.figures, [figure]: next } });
  }
  async function searchTerms() {
    termsRequest.current?.abort();
    const controller = new AbortController(); termsRequest.current = controller;
    const requestedTaxonomy = taxonomy;
    const timeout = setTimeout(() => controller.abort(), 15_000);
    setTermState("loading"); setResults([]); setSearched(false);
    try {
      const terms = await transport.terms(taxonomy, query.trim(), controller.signal);
      if (!controller.signal.aborted) { setResultTaxonomy(requestedTaxonomy); setResults(terms); setSearched(true); setTermState("idle"); }
    } catch { if (!controller.signal.aborted) setTermState("error"); }
    finally { clearTimeout(timeout); if (controller.signal.aborted && termsRequest.current === controller) setTermState("error"); }
  }
  const current = preview?.key === key ? preview : undefined;
  const stories = current?.value ? selectReportingStories(mapping, current.value.stories, Date.parse(current.value.cutoffAt)) : [];
  function editStory(story: SelectedReportingStory, action: "pin" | "hide") {
    const identity = { source: story.source, id: story.id, canonicalHref: reportingStoryUrl(story.canonicalHref) ?? reportingStoryUrl(story.href) ?? undefined };
    const pins = mapping.pins.filter(item => reportingIdentityKey(item) !== reportingIdentityKey(story.pinnedBy ?? identity));
    update(action === "pin" ? { ...mapping, pins: story.pinnedBy ? pins : [...pins, identity] }
      : { ...mapping, pins, hidden: [...mapping.hidden, identity] });
    previewHeading.current?.focus();
  }
  return <details ref={details} id={controlId} tabIndex={-1} className="data-hub-reporting-editor" onToggle={event => setOpened(event.currentTarget.open)}>
    <summary>Related reporting</summary>
    <p>Before publishing the first mapping, compare the October 17 saved selection. <a href="https://njpbs.org/data-hub/" target="_blank" rel="noopener noreferrer">View current reporting</a>.</p>
    {error ? <InlineMessage tone="error">{error}</InlineMessage> : null}
    {opened && <fieldset disabled={disabled || invalid}>
      <legend className="sr-only">Data Hub related reporting</legend>
      {invalid && <InlineMessage tone="error">The saved mapping could not be read. Reload the Page before editing.</InlineMessage>}
      {notice && <InlineMessage tone="warning">{notice}</InlineMessage>}
      {unfinished && <p role="status">Finish adding or clear the reporting term before saving. Draft terms stay with their figure.</p>}
      {selectedFigure ? <p>{selectedFigure === "featured" ? "Featured finding" : DATA_HUB_FIGURES[selectedFigure]}</p> : <><label htmlFor={`${id}-figure`}>Figure</label>
      <Select id={`${id}-figure`} value={figure} onChange={event => setFigure(event.target.value as DataHubFigure | "featured")}>
        {Object.entries(DATA_HUB_FIGURES).map(([key, title]) => <option value={key} key={key}>{title}</option>)}
        <option value="featured">Featured finding</option>
      </Select></>}
      {figure === "featured" && <label><input type="checkbox" checked={inherited} onChange={event =>
        commit({ ...config, featured: event.target.checked ? { inheritFigure: true } : { inheritFigure: false, mapping: structuredClone(mapping) } })} />Use the minimum-wage figure's reporting</label>}
      <fieldset disabled={inherited}>
        <legend>NJ PBS Posts</legend>
        <div onFocus={() => { if (!vocabulary.tags.length && !vocabulary.categories.length) void loadVocabulary(); }}>
          {(["tags", "categories"] as const).map(kind => <div key={kind}><label htmlFor={`${id}-posts-${kind}`}>{kind === "tags" ? "Tags" : "Categories"}</label><TokenInput inputId={`${id}-posts-${kind}`} label={kind === "tags" ? "Post tags" : "Post categories"}
            draft={drafts[`${figure}-posts-${kind}`] ?? ""} onDraftChange={text => setDrafts(current => ({ ...current, [`${figure}-posts-${kind}`]: text }))}
            tokens={mapping.posts[kind].map(value => ({ value }))} maxLength={200} maxCount={5} caseSensitive
            suggestions={vocabulary[kind]} suggestionsNote="From published Posts" onChange={tokens => update({ ...mapping,
              posts: { ...mapping.posts, [kind]: tokens.map(token => token.value) } })} /></div>)}
        </div>
        <p>Match any saved tag or category. Published stories only; up to three stories in total.</p>
      </fieldset>
      <fieldset disabled={inherited}>
        <legend>NJ Spotlight News</legend>
        {(["tags", "categories"] as const).map(kind => <div key={kind}><label htmlFor={`${id}-spotlight-${kind}`}>{kind === "tags" ? "Tags" : "Categories"}</label><TokenInput inputId={`${id}-spotlight-${kind}`} label={kind === "tags" ? "Spotlight tags" : "Spotlight categories"}
          draft={drafts[`${figure}-spotlight-${kind}`] ?? ""} onDraftChange={text => setDrafts(current => ({ ...current, [`${figure}-spotlight-${kind}`]: text }))}
          tokens={mapping.spotlight[kind].map(term => ({ value: term.label }))} maxLength={200} maxCount={5}
          onSubmitEntry={search => { setTaxonomy(kind); setQuery(search); setResults([]); setDrafts(current => ({ ...current, [`${figure}-spotlight-${kind}`]: "" })); }}
          onChange={tokens => update({ ...mapping, spotlight: { ...mapping.spotlight,
            [kind]: mapping.spotlight[kind].filter(term => tokens.some(token => token.value === term.label)) } })}
          placeholder="Find a term below" /></div>)}
        <div className="data-hub-reporting-editor__search">
          <label htmlFor={`${id}-taxonomy`}>Find</label>
          <Select id={`${id}-taxonomy`} value={taxonomy} onChange={event => { setTaxonomy(event.target.value as typeof taxonomy); setResults([]); }}>
            <option value="tags">Tags</option><option value="categories">Categories</option>
          </Select>
          <label htmlFor={`${id}-term`}>Term name</label>
          <TextInput id={`${id}-term`} value={query} maxLength={80} onChange={event => setQuery(event.target.value)} />
          <Button type="button" disabled={query.trim().length < 2 || termState === "loading"} onClick={() => void searchTerms()}>Find terms</Button>
        </div>
        <div role="status">{termState === "loading" ? "Finding terms…" : termState === "error" ? "Terms could not be loaded. Try again." : searched ? results.length ? `${results.length} terms found.` : "No matching terms found." : ""}</div>
        <ul>{results.map(term => <li key={term.id}>{term.label} <ActionControl action="add-item" contextLabel={term.label}
          disabled={mapping.spotlight[resultTaxonomy].length >= 5 || mapping.spotlight[resultTaxonomy].some(item => item.id === term.id || item.label === term.label)}
          onClick={() => update({ ...mapping, spotlight: { ...mapping.spotlight, [resultTaxonomy]: [...mapping.spotlight[resultTaxonomy], term] } })} /></li>)}</ul>
      </fieldset>
      <section aria-labelledby={`${id}-preview`} aria-busy={!current}>
        <h3 id={`${id}-preview`} tabIndex={-1} ref={previewHeading}>Stories that would show</h3>
        <p>Pinned stories first, then newest matches. Up to three stories.</p>
        {!current ? <p role="status">Loading matching stories…</p> : current.error ? <InlineMessage tone="error">Story preview could not be loaded. <Button type="button" onClick={() => setRetry(value => value + 1)}>Retry preview</Button></InlineMessage> : <>
          <p>{current.value?.checkedAt ? <>Last Spotlight check: <time dateTime={current.value.checkedAt}>{new Date(current.value.checkedAt).toLocaleString("en-US", { timeZone: "America/New_York" })} Eastern</time></> : "No successful Spotlight check yet."}</p>
          {current.value?.failed && <InlineMessage tone="warning">Reporting sources could not all be refreshed. Previous checked Spotlight stories are shown when available.</InlineMessage>}
          {stories.length === 0 ? <p>No matching stories. This reporting block will be hidden.</p> : <ol>{stories.map(story => <li key={reportingIdentityKey(story)}>
            <a href={story.href} target="_blank" rel="noreferrer">{story.title}</a>
            <p>{story.source === "posts" ? "NJ PBS" : "NJ Spotlight News"}{story.byline ? ` · ${story.byline}` : ""} · <time dateTime={story.publishedAt}>{story.publishedAt.slice(0, 10)}</time></p>
            <Button type="button" disabled={inherited || mapping.pins.length >= 3 && !story.pinnedBy}
              onClick={() => editStory(story, "pin")}>{story.pinnedBy ? "Unpin" : "Pin"}</Button>
            <Button type="button" disabled={inherited || mapping.hidden.length >= 20} onClick={() => editStory(story, "hide")}>Hide</Button>
          </li>)}</ol>}
        </>}
      </section>
      {mapping.pins.length > 0 && <section aria-label="Pinned stories"><h3>Pinned stories</h3><ol>{mapping.pins.map(pin => {
        const story = stories.find(story => story.pinnedBy && reportingIdentityKey(story.pinnedBy) === reportingIdentityKey(pin)) ??
          current?.value?.stories.find(story => reportingIdentityKey(story) === reportingIdentityKey(pin));
        return <li key={reportingIdentityKey(pin)}>{story?.title ?? "This pinned story is unavailable"}
          <ActionControl action="remove-item" contextLabel={story?.title ?? `unavailable ${pin.source === "posts" ? "NJ PBS" : "Spotlight"} pin`}
            disabled={inherited} onClick={() => { update({ ...mapping, pins: mapping.pins.filter(item => reportingIdentityKey(item) !== reportingIdentityKey(pin)) }); previewHeading.current?.focus(); }} />
        </li>;
      })}</ol></section>}
      {mapping.hidden.length > 0 && <details><summary>Hidden stories ({mapping.hidden.length})</summary><ul>{mapping.hidden.map(hidden => <li key={reportingIdentityKey(hidden)}>
        {current?.value?.stories.find(story => reportingIdentityKey(story) === reportingIdentityKey(hidden))?.title ?? `${hidden.source === "posts" ? "NJ PBS" : "NJ Spotlight News"} story ${hidden.id}`}
        <Button type="button" disabled={inherited} onClick={() => { update({ ...mapping, hidden: mapping.hidden.filter(item => reportingIdentityKey(item) !== reportingIdentityKey(hidden)) }); setRetry(value => value + 1); previewHeading.current?.focus(); }}>Show</Button>
      </li>)}</ul></details>}
    </fieldset>}
  </details>;
}
