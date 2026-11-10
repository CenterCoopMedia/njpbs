import { useEffect, useState } from "react";
import type { HomeBandAssets } from "../../../packages/content-core/src/home-band-background";
import type { NewsletterSignupBlock } from "../../../packages/content-core/src/content-model";
import type { HomeSourceSnapshot } from "../../../packages/content-core/src/home-rail-render";
import { homeCatalogJson, resolveHomeNewsletter, type HomeEditorialSourceReceipt } from "../../../packages/content-core/src/home-source-catalog";
import { renderHomeNewsletter } from "../../../packages/content-core/src/home-newsletter-section";
import { loadHomeSourceSnapshot } from "../lib/home-source-snapshot";
import type { AdminBlock } from "../lib/block-factory";
import { Button, Select, TextInput, Textarea } from "./ui/Primitives";

type Loader = (signal: AbortSignal) => Promise<HomeSourceSnapshot>;
function useNewsletterCatalog(loadSources: Loader, enabled = true) {
  const [catalog, setCatalog] = useState<HomeEditorialSourceReceipt>();
  const [error, setError] = useState(false), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController(); let current = true;
    setCatalog(undefined); setError(false);
    const timer = window.setTimeout(() => { controller.abort(); if (current) setError(true); }, 10_000);
    void loadSources(controller.signal).then(value => {
      if (!value.editorial?.catalog.services) throw new Error("Unavailable Newsletter catalog");
      if (current && !controller.signal.aborted) setCatalog(value.editorial);
    }).catch(() => { if (current) setError(true); }).finally(() => window.clearTimeout(timer));
    return () => { current = false; controller.abort(); window.clearTimeout(timer); };
  }, [loadSources, attempt, enabled]);
  return { catalog, error, retry: () => setAttempt(value => value + 1) };
}
export function HomeNewsletterEditor({ block, readOnly, onChange, loadSources = loadHomeSourceSnapshot }: {
  block: AdminBlock; readOnly: boolean; onChange: (data: Record<string, unknown>, discrete?: boolean) => void; loadSources?: Loader;
}) {
  const data = (block as unknown as NewsletterSignupBlock).data;
  const { catalog, error, retry } = useNewsletterCatalog(loadSources);
  const snapshot = catalog?.catalog.services?.newsletters;
  const available = snapshot?.status === "ready" ? snapshot.records.flatMap(record => resolveHomeNewsletter({ ...block, data: {
    newsletterIds: [(record as { id: string }).id], actionLabel: "Sign up by email" } } as unknown as NewsletterSignupBlock, catalog!.catalog).cards) : [];
  const selected = data.newsletterIds[0] ?? "", missing = snapshot?.status === "ready" && selected && !available.some(card => card.id === selected);
  const change = (value: Partial<typeof data>, discrete = false) => { if (!readOnly) onChange({ ...data, ...value }, discrete); };
  const choose = (id: string) => { if (catalog && (!id || available.some(card => card.id === id))) {
    const { selectionReceipt: _receipt, ...rest } = data;
    if (!readOnly) onChange({ ...rest, newsletterIds: id ? [id] : [], ...(id ? { selectionReceipt: catalog.receipt } : {}) }, true);
  } };
  return <section aria-label="Home Newsletter settings">
    <label>Published Newsletter<Select value={selected} disabled={readOnly || !catalog || snapshot?.status !== "ready"} onChange={event => choose(event.target.value)}>
      <option value="">Choose a published Newsletter</option>
      {selected && !available.some(card => card.id === selected) ? <option value={selected}>{missing ? "Unavailable Newsletter" : "Saved Newsletter"}: {selected}</option> : null}
      {available.map(card => <option key={card.id} value={card.id}>{card.title}</option>)}
    </Select></label>
    {!selected && block.visible ? <p>The standard newsletter band appears until a newsletter is chosen.</p> : null}
    {error ? <div role="alert"><p>Published Newsletters could not be loaded. Your draft stays editable.</p><Button onClick={retry}>Reload published Newsletters</Button></div> : !catalog ? <p role="status">Loading published Newsletters…</p> : null}
    {snapshot?.status === "error" ? <Button onClick={retry}>Reload published Newsletters</Button> : null}
    {selected && (snapshot?.status === "error" || missing) ? <p role="alert">The selected Newsletter is unavailable and will not appear on Home. Its ID stays saved.</p>
      : snapshot?.status === "error" ? <p role="alert">Published Newsletters are unavailable. Reload to try again.</p> : null}
    {catalog && selected && homeCatalogJson(data.selectionReceipt) !== homeCatalogJson(catalog.receipt)
      ? <Button disabled={readOnly} onClick={() => change({ selectionReceipt: catalog.receipt }, true)}>Use current published Newsletter</Button> : null}
    <label>Heading<TextInput disabled={readOnly} value={data.heading ?? ""} maxLength={120} onChange={event => change({ heading: event.target.value.replace(/[\r\n\t]+/g, " ") })} /></label>
    <label>Summary<Textarea disabled={readOnly} value={data.intro ?? ""} maxLength={2000} onChange={event => change({ intro: event.target.value.replace(/[\r\n\t]+/g, " ") })} /></label>
    <p>Leave heading or summary empty to use the published Newsletter copy. Line breaks and tabs become spaces.</p>
    <label>Button text<TextInput disabled={readOnly} value={data.actionLabel ?? ""} maxLength={120} onChange={event => change({ actionLabel: event.target.value.replace(/[\r\n\t]+/g, " ") })} /></label>
    <p>The signup link comes from the published Newsletter. Background image overrides its artwork; remove the override to use the Newsletter image or the standard blue artwork.</p>
  </section>;
}
export function HomeNewsletterPreview({ block, loadSources = loadHomeSourceSnapshot, render, assets = {} }: {
  block: AdminBlock; loadSources?: Loader; render: (html: string) => React.ReactNode; assets?: HomeBandAssets;
}) {
  const empty = (block as unknown as NewsletterSignupBlock).data.newsletterIds.length === 0;
  const { catalog, error, retry } = useNewsletterCatalog(loadSources, block.visible && !empty);
  if (!block.visible) return <p role="status">Newsletter signup is hidden from the page.</p>;
  if (empty) {
    let html = "";
    try { html = renderHomeNewsletter(block as unknown as NewsletterSignupBlock, undefined, { complete: false, assets }); } catch { /* Incomplete draft stays editable. */ }
    return html ? <>{render(html)}<p role="status">The standard newsletter band appears until a newsletter is chosen.</p></>
      : <p role="status">Complete the Newsletter signup fields to preview this section.</p>;
  }
  if (error) return <div role="alert"><p>Published Newsletters could not be loaded.</p><Button onClick={retry}>Reload published Newsletters</Button></div>;
  if (!catalog) return <p role="status">Loading published Newsletters…</p>;
  let html = "";
  try { html = renderHomeNewsletter(block as unknown as NewsletterSignupBlock, catalog.catalog, { complete: false, assets }); } catch { /* Incomplete draft stays editable. */ }
  return html ? render(html) : <p role="status">Choose an available published Newsletter and add button text to preview this bar.</p>;
}
