import { useEffect, useState } from "react";
import type { HomeNewscastBlock } from "../../../packages/content-core/src/content-model";
import type { HomeSourceSnapshot } from "../../../packages/content-core/src/home-rail-render";
import type { HomeEditorialCatalog } from "../../../packages/content-core/src/home-source-catalog";
import { HOME_NEWSCAST_SHOW_ID } from "../../../packages/content-core/src/home-newscast-source";
import { resolvePublishedHomeNewscast } from "../../../packages/content-core/src/home-newscast-published";
import { renderHomeNewscast } from "../../../packages/content-core/src/home-newscast-section";
import { loadHomeSourceSnapshot } from "../lib/home-source-snapshot";
import type { AdminBlock } from "../lib/block-factory";
import { Button, Select, TextInput, Textarea } from "./ui/Primitives";

type Loader = (signal: AbortSignal) => Promise<HomeSourceSnapshot>;
function useNewscastCatalog(loadSources: Loader) {
  const [catalog, setCatalog] = useState<HomeEditorialCatalog>();
  const [error, setError] = useState(false), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); let current = true;
    setCatalog(undefined); setError(false);
    const timer = window.setTimeout(() => { controller.abort(); if (current) setError(true); }, 10_000);
    void loadSources(controller.signal).then(value => {
      if (!value.editorial) throw new Error("Unavailable source catalog");
      if (value.editorial.catalog.services?.newscast) resolvePublishedHomeNewscast(value.editorial.catalog.services.newscast, value.editorial.catalog.cutoffAt);
      if (current && !controller.signal.aborted) setCatalog(value.editorial.catalog);
    }).catch(() => { if (current) setError(true); }).finally(() => window.clearTimeout(timer));
    return () => { current = false; controller.abort(); window.clearTimeout(timer); };
  }, [loadSources, attempt]);
  return { catalog, error, retry: () => setAttempt(value => value + 1) };
}
export function HomeNewscastEditor({ block, readOnly, onChange, loadSources = loadHomeSourceSnapshot }: {
  block: AdminBlock; readOnly: boolean; onChange: (data: Record<string, unknown>, discrete?: boolean) => void; loadSources?: Loader;
}) {
  const data = (block as unknown as HomeNewscastBlock).data;
  const { catalog, error, retry } = useNewscastCatalog(loadSources);
  const source = catalog?.services?.newscast ? resolvePublishedHomeNewscast(catalog.services.newscast, catalog.cutoffAt) : undefined;
  const unavailable = source?.emptyReason === "withdrawn" ? "The retained episode has been withdrawn or expired."
    : !source || source.emptyReason === "source_error" ? "The approved newscast source is unavailable."
    : "The approved source has no eligible public episode yet.";
  const edit = (key: keyof typeof data, value: string, discrete = false) => {
    if (!readOnly) onChange({ ...data, [key]: value.replace(/[\r\n\t]+/g, " ") }, discrete);
  };
  return <section aria-label="Home newscast settings">
    <label>Newscast source<Select value={data.showId} disabled={readOnly} onChange={event => {
      if (event.target.value === HOME_NEWSCAST_SHOW_ID) edit("showId", event.target.value, true);
    }}><option value={HOME_NEWSCAST_SHOW_ID}>NJ PBS News with Rob Nelson</option></Select></label>
    <p>Updates automatically from the approved published source. Episode date, poster and links follow that source.</p>
    {error ? <div role="alert"><p>The published newscast could not be loaded. Your draft stays editable.</p><Button onClick={retry}>Reload published newscast</Button></div>
      : !catalog ? <p role="status">Loading published newscast…</p> : source?.episode ? <p role="status">Current episode: {source.episode.title}</p>
      : <div role="alert"><p>{unavailable} The heading, Past newscasts and Watch live links remain on Home.</p><Button onClick={retry}>Reload published newscast</Button></div>}
    <label>Heading<TextInput value={data.heading} disabled={readOnly} maxLength={120} onChange={event => edit("heading", event.target.value)} /></label>
    <label>Summary<Textarea value={data.summary} disabled={readOnly} maxLength={2000} onChange={event => edit("summary", event.target.value)} /></label>
    <p>The summary is one paragraph. Line breaks and tabs become spaces.</p>
    <label>Layout<Select value={data.layout} disabled={readOnly} onChange={event => edit("layout", event.target.value, true)}>
      <option value="feature">Poster beside copy</option><option value="compact">Compact stacked card</option>
    </Select></label>
    {([['watchLabel', 'Watch button text'], ['pastLabel', 'Past newscasts text'], ['liveLabel', 'Watch live text']] as const).map(([key, label]) =>
      <label key={key}>{label}<TextInput value={data[key]} disabled={readOnly} maxLength={120} onChange={event => edit(key, event.target.value)} /></label>)}
  </section>;
}
export function HomeNewscastPreview({ block, loadSources = loadHomeSourceSnapshot, render }: {
  block: AdminBlock; loadSources?: Loader; render: (html: string) => React.ReactNode;
}) {
  const { catalog, error, retry } = useNewscastCatalog(loadSources);
  if (!catalog && !error) return <p role="status">Loading published newscast…</p>;
  let html = "";
  try { html = renderHomeNewscast(block as unknown as HomeNewscastBlock, catalog, { complete: false }); } catch { /* Incomplete draft stays editable. */ }
  return <>{error ? <div role="alert"><p>The published newscast could not be loaded.</p><Button onClick={retry}>Reload published newscast</Button></div> : null}
    {html ? render(html) : <p role="status">Add a heading and all button text to preview this section.</p>}</>;
}
