import "./home-canvas.css";
import { useCallback, useContext, useEffect, useRef, useState, type ComponentProps } from "react";
import { HOME_HERO_LIMIT, HOME_HERO_TAG_LIMIT, HOME_HERO_TAG_MAX_LENGTH, HOME_HERO_SOURCE_CAPABILITIES, HOME_HERO_SUPPORTING_COUNTS, HOME_HERO_HEADING_MAX_LENGTH, HOME_HERO_ACTION_MAX_LENGTH, homeHeroIsVideo, parseHomeHero, resolveHomeHero,
  type HomeHeroConfig, type HomeHeroManualItem, type HomeHeroCatalogItem, type HomeHeroSource } from "../../../packages/content-core/src/home-hero";
import { ContentShelfPicker, ContentShelfSources, postShelfCard } from "./ContentShelfPicker";
import { Tooltip } from "./ui/Tooltip";
import { Icon } from "./ui/Icon";
import { ActionControl } from "./ui/ActionControl";
import { TokenInput } from "./ui/TokenInput";
import { AssetImage } from "./ui/AssetImage";
import { mediaPreviewUrl } from "../lib/media-image";
import { publicSiteOrigin } from "../lib/dev-origins";
import { useResolvedMediaAsset } from "./useResolvedMediaAsset";
import { FieldRenderer } from "./FieldRenderer";
import { Button, Select, TextInput, Textarea } from "./ui/Primitives";
import { DEFAULT_CONTENT_QUERY } from "../lib/content-query";
import { SHELF_TOPICS } from "../../../packages/content-core/src/dynamic-shelves";
import { mintCollectionItemId } from "../lib/collection-item-keys";
import { loadBoundHomeHeroCatalog } from "../lib/home-hero-published-catalog";
import { loadHomeSourceSnapshot } from "../lib/home-source-snapshot";
import type { HomeSourceSnapshot } from "../../../packages/content-core/src/home-rail-render";
import { homeLayoutsEnabled } from "../lib/home-layouts";
import { HomeHeroPins } from "./HomeHeroPins";

type MediaProps = Pick<ComponentProps<typeof FieldRenderer>, "loadMedia" | "mediaPickerUnavailable" | "uploadMedia" | "mediaCategories" | "defaultUploadCategory" | "canUploadCategory" | "onMediaPickerDirtyChange">;
export function HomeHeroEditor({ value, onChange, onDraftError, error, selectionId, loadSources = loadHomeSourceSnapshot, ...media }: MediaProps & {
  loadSources?: (signal: AbortSignal) => Promise<HomeSourceSnapshot>;
  selectionId?: string;
  value: unknown; onChange: (value: HomeHeroConfig) => void; error?: string;
  onDraftError?: (message: string | null) => void;
}) {
  const config = value && typeof value === "object" ? value as HomeHeroConfig : undefined;
  const draftErrors = useRef(new Map<string, string>());
  const report = useRef(onDraftError); report.current = onDraftError;
  const reportDraftError = useCallback((key: string, message: string | null) => {
    if (message) draftErrors.current.set(key, message); else draftErrors.current.delete(key);
    report.current?.([...draftErrors.current.values()][0] ?? null);
  }, []);
  useEffect(() => { if (config?.mode !== "tag") reportDraftError("tags", null); }, [config?.mode, reportDraftError]);
  const [activeItemId, setActiveItemId] = useState<string>();
  const [unverifiedIds, setUnverifiedIds] = useState<string[]>([]);
  const [catalog, setCatalog] = useState<HomeHeroCatalogItem[]>([]);
  const catalogRequest = useRef<AbortController>(undefined);
  const [source, setSource] = useState<"media_manager" | "spotlight">("media_manager");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const sources = useContext(ContentShelfSources);
  const modeDrafts = useRef<Partial<Record<HomeHeroConfig["mode"], HomeHeroConfig>>>({});
  const automaticPins = useRef<HomeHeroConfig["pins"]>(undefined);
  if (config && config.mode !== "manual") automaticPins.current = config.pins ?? [];
  const [notice, setNotice] = useState("");
  const [classifications, setClassifications] = useState<{ categories: string[]; tags: string[] }>({ categories: [], tags: [] });
  const [nextPage, setNextPage] = useState(1);
  const [hasMorePosts, setHasMorePosts] = useState(true);
  const items = Array.isArray(config?.items) ? config.items : [];
  const itemsRef = useRef(items); itemsRef.current = items;
  const activeItem = items.find(item => item.itemId === activeItemId) ?? items[0];
  const full = items.length >= HOME_HERO_LIMIT;
  const layoutsEnabled = homeLayoutsEnabled();
  const editorial = layoutsEnabled && config?.presentation === "editorial";
  const supportingCount = config?.supportingCount ?? 3;
  let validation = error;
  try { parseHomeHero(value); } catch (cause) { validation ??= cause instanceof Error ? cause.message : "Home hero settings are invalid."; }
  function change(next: HomeHeroConfig) {
    if (layoutsEnabled) { onChange(next); return; }
    const { presentation, supportingCount, leadHeading, supportingHeading, overflowHeading, ...compatible } = next;
    onChange(compatible);
  }
  function update(next: Partial<HomeHeroConfig>) { change({ ...config, mode: config?.mode ?? "manual", ...next }); }
  function layoutDetails(): Partial<HomeHeroConfig> {
    // Presentation belongs to the whole hero. Carry it across selection-mode
    // drafts without replacing either mode's chosen stories or classification.
    return Object.fromEntries(["presentation", "supportingCount", "leadHeading", "supportingHeading", "overflowHeading"]
      .filter(key => config && Object.hasOwn(config, key))
      .map(key => [key, config![key as keyof HomeHeroConfig]]));
  }
  function add(item: HomeHeroManualItem) {
    if (items.some(existing => existing.itemId === item.itemId || (item.sourceId ? existing.source === item.source && existing.sourceId === item.sourceId : Boolean(item.href) && existing.href === item.href))) {
      setNotice(editorial ? "This destination is already in the hero. Edit its existing story below." : "This destination is already in the hero. Edit its existing slide below.");
      return;
    }
    if (!full) { setActiveItemId(item.itemId); update({ items: [...items, item] }); setNotice(`Added ${item.title || (editorial ? "a new story" : "a new slide")}.`); }
  }
  function edit(index: number, change: Partial<HomeHeroManualItem>) {
    update({ items: items.map((item, position) => position === index ? { ...item, ...change } : item) });
  }
  function move(index: number, direction: number) {
    const next = [...items];
    [next[index], next[index + direction]] = [next[index + direction], next[index]];
    update({ items: next });
  }
  const loadCatalog = useCallback(async () => {
    catalogRequest.current?.abort();
    const controller = new AbortController();
    catalogRequest.current = controller;
    const timeout = setTimeout(() => controller.abort(), 10_000);
    setLoading(true); setLoaded(false); setCatalogError("");
    try {
      const snapshot = await loadSources(controller.signal);
      if (!snapshot.publication || !snapshot.heroCatalog) throw new Error("Published catalog unavailable");
      const resolved = await loadBoundHomeHeroCatalog(snapshot, itemsRef.current, sources, media.loadMedia, controller.signal);
      if (!controller.signal.aborted) { setCatalog(resolved.catalog); setUnverifiedIds(resolved.unverifiedIds); setLoaded(true); }
    } catch {
      if (catalogRequest.current === controller) setCatalogError("The published story catalog could not be loaded. Retry to verify source-backed stories.");
    } finally {
      clearTimeout(timeout);
      if (catalogRequest.current === controller) setLoading(false);
    }
  }, [loadSources, sources.loadRecord, media.loadMedia]);
  const boundKey = items.map(item => `${item.source ?? ""}:${item.sourceId ?? ""}`).join("\0");
  const hasBoundItems = items.some(item => Boolean(item.sourceId));
  useEffect(() => {
    if (hasBoundItems) void loadCatalog();
    else setLoading(false);
    return () => { catalogRequest.current?.abort(); catalogRequest.current = undefined; };
  }, [hasBoundItems, boundKey, loadCatalog]);
  async function loadClassifications() {
    if (config?.source === "spotlight") { await loadCatalog(); return; }
    if (!sources.loadLibrarySelection || !sources.loadRecord) {
      setCatalogError("Published post choices are unavailable in this workspace."); return;
    }
    setLoading(true); setCatalogError("");
    try {
      const selection = await sources.loadLibrarySelection({ ...DEFAULT_CONTENT_QUERY, types: ["post"], page: nextPage });
      const eligible = selection.records.filter(record => (record.liveSourceVersion ?? 0) > 0 && !record.publicUpdatePending);
      const categories = new Set(classifications.categories);
      const tags = new Set(classifications.tags);
      for (let index = 0; index < eligible.length; index += 4) {
        const results = await Promise.all(eligible.slice(index, index + 4).map(record => sources.loadRecord!("post", record.id)));
        for (const result of results) {
          if (result.status !== "ready") continue;
          try { postShelfCard(result.record); } catch { continue; }
          const published = result.record.published as { metadata: Record<string, unknown> };
          for (const [field, target] of [["categories", categories], ["tags", tags]] as const) {
            const values = published.metadata[field];
            if (Array.isArray(values)) for (const value of values) {
              if (typeof value === "string" && value.trim() && !value.startsWith("format:")) target.add(value);
            }
          }
        }
      }
      setClassifications({ categories: [...categories].sort(), tags: [...tags].sort() });
      setNextPage(selection.page + 1); setHasMorePosts(selection.page < selection.pageCount);
    } catch { setCatalogError("Published post classifications could not be loaded. Retry to choose one."); }
    finally { setLoading(false); }
  }
  const classificationOptions = config?.source === "spotlight"
    ? [...new Set(catalog.filter(item => item.source === "spotlight").flatMap(item => item.categories))].sort()
    : config?.mode === "tag" ? classifications.tags : classifications.categories;
  const matchingCatalog = catalog.filter(item => item.source === source && item.title.toLowerCase().includes(query.toLowerCase()));
  const querySources = Object.entries(HOME_HERO_SOURCE_CAPABILITIES).filter(([, capabilities]) =>
    config?.mode === "tag" ? capabilities.tag : capabilities.category);
  return <fieldset className="record-field-group home-hero-editor" aria-label={editorial ? "Home lead story and headlines" : "Home hero slides"}>
    <legend>{editorial ? "Home lead story and headlines" : "Home hero slides"}</legend>
    {layoutsEnabled ? <label className="editor-field">Hero layout
      <Select value={config?.presentation ?? "carousel"} onChange={event => update({
        presentation: event.target.value as HomeHeroConfig["presentation"],
        ...(!config ? { items: [] } : {}),
      })}>
        <option value="carousel">Rotating hero</option>
        <option value="editorial">Lead story and headlines</option>
      </Select>
    </label> : null}
    {editorial ? <fieldset className="record-field-group">
      <legend>Lead story and headlines</legend>
      <p>The first eligible story is the lead. The next {supportingCount} appear as supporting headlines, and every remaining selected story appears below them. Nothing rotates.</p>
      <label className="editor-field">Supporting headlines
        <Select value={supportingCount} onChange={event => update({ supportingCount: Number(event.target.value) as HomeHeroConfig["supportingCount"] })}>
          {HOME_HERO_SUPPORTING_COUNTS.map(count => <option key={count} value={count}>{count}</option>)}
        </Select>
      </label>
      <label className="editor-field">Lead heading
        <TextInput value={config?.leadHeading ?? ""} placeholder="Top story" maxLength={HOME_HERO_HEADING_MAX_LENGTH}
          onChange={event => update({ leadHeading: event.target.value })} />
      </label>
      <label className="editor-field">Supporting heading
        <TextInput value={config?.supportingHeading ?? ""} placeholder="Latest stories" maxLength={HOME_HERO_HEADING_MAX_LENGTH}
          onChange={event => update({ supportingHeading: event.target.value })} />
      </label>
      <label className="editor-field">More-stories heading
        <TextInput value={config?.overflowHeading ?? ""} placeholder="More stories" maxLength={HOME_HERO_HEADING_MAX_LENGTH}
          onChange={event => update({ overflowHeading: event.target.value })} />
      </label>
      <p className="muted">Leave a heading blank to use the words shown in its field. A group appears only when it has stories.</p>
    </fieldset> : null}
    <p>{editorial ? "Choose up to ten linked stories." : "Show up to ten linked slides."} Empty selections use the existing Home heading, image and watch buttons.</p>
    <label className="editor-field">Selection
      <Select id={selectionId} value={config?.mode ?? "fallback"} onChange={event => {
        const mode = event.target.value;
        if (config) modeDrafts.current[config.mode] = config;
        const selected = mode as HomeHeroConfig["mode"];
        change({ ...(modeDrafts.current[selected] ?? (selected === "manual" ? { mode: "manual", items: [] }
          : selected === "tag" ? { mode: "tag", source: "cms_posts", values: ["announcement", "home", "hero", "main"], limit: 10 }
          : { mode: selected, source: "cms_posts", value: "", limit: 10 })), ...layoutDetails(),
          ...(selected !== "manual" && automaticPins.current ? { pins: automaticPins.current } : {}) });
      }}>
        {!config ? <option value="fallback">Current Home fallback</option> : null}
        <option value="manual">{editorial ? "Choose stories or paste a URL" : "Choose slides or paste a URL"}</option>
        <option value="category">Select by category</option>
        <option value="tag">Select by tags</option>
      </Select>
    </label>
    {config && config.mode !== "manual" ? <>
      <label className="editor-field">Content source<Select value={config.source ?? "cms_posts"} onChange={event => update({ source: event.target.value as HomeHeroSource, ...(config.mode === "category" ? { value: "" } : {}) })}>
        {querySources.map(([id, capabilities]) => <option key={id} value={id}>{capabilities.label}</option>)}
      </Select></label>
      <Button disabled={loading || (config.source === "cms_posts" && !hasMorePosts)} onClick={() => void loadClassifications()}>
        {config.source === "cms_posts" && nextPage > 1 ? "Load more published classifications" : "Load available classifications"}
      </Button>
      {config.mode === "tag" ? <div className="editor-field">
        <span>Tags</span>
        <TokenInput label="Home hero tags" tokens={(config.values ?? (config.value ? [config.value] : [])).map(value => ({ value }))}
          caseSensitive maxCount={HOME_HERO_TAG_LIMIT} maxLength={HOME_HERO_TAG_MAX_LENGTH} suggestions={classificationOptions}
          onDraftChange={text => reportDraftError("tags", text.trim() ? "Finish the Home hero tag with Enter or a comma, or clear the text." : null)}
          onChange={tokens => {
            const { value: legacyValue, ...next } = config;
            change({ ...next, values: tokens.map(token => token.value) });
          }} />
        <small>Add each tag with Enter or a comma. Use the published tag’s exact spelling and case. A Post appears with any listed tag or with Show in Home hero selected.</small>
      </div> : <label className="editor-field">Category<Select value={config.value ?? ""} onChange={event => update({ value: event.target.value })}>
        <option value="">Choose a {config.mode}</option>
        {config.value && !classificationOptions.includes(config.value) ? <option value={config.value}>{config.value} (saved selection)</option> : null}
        {classificationOptions.map(value => <option key={value} value={value}>{config.source === "spotlight" ? SHELF_TOPICS.find(topic => topic.id === value)?.label ?? value : value}</option>)}
      </Select></label>}
      <p>Choices come from available published content. No matching items uses the Home fallback.</p>
      {/* A different Selection owns a new picker and cancels the previous one's pending pins. */}
      <HomeHeroPins key={config.mode} pins={config.pins ?? []} onChange={pins => update({ pins })} onDraftError={reportDraftError} />
      {catalogError ? <p role="alert">{catalogError}</p> : null}
      <label className="editor-field">{editorial ? "Maximum stories" : "Maximum slides"}<Select value={config.limit ?? 10} onChange={event => update({ limit: Number(event.target.value) })}>
        {Array.from({ length: 10 }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1}</option>)}
      </Select></label>
    </> : config ? <>
      <div className="home-hero-slide-layout">
        <div className="home-hero-slide-library">
        <nav className="home-hero-slide-nav" aria-label={editorial ? "Stories" : "Slides"}><h3>{editorial ? "Story order" : "Slides"}</h3>
          <p>{items.length} of {HOME_HERO_LIMIT} {editorial ? "stories" : "slides"}</p>
          {items.map((item, index) => <Button key={item.itemId} aria-pressed={activeItem?.itemId === item.itemId}
            onClick={() => setActiveItemId(item.itemId)}><HeroArtwork item={item} loadMedia={media.loadMedia} catalog={catalog} thumbnail /><span>{item.title || catalog.find(card => card.source === item.source && card.id === item.sourceId)?.title || `${editorial ? "Story" : "Slide"} ${index + 1}`}</span><small>{editorial ? (index === 0 ? "Lead" : index <= supportingCount ? "Supporting" : "More stories") : index + 1}</small></Button>)}
        </nav>
        <div className="home-hero-add-controls">
      <ContentShelfPicker disabled={full} onAddPost={(card, postId) => add({
        itemId: String(card.itemId), source: "cms_posts", sourceId: postId, title: "", summary: "", href: "",
      })} onAdd={card => add({
        itemId: String(card.itemId), title: String(card.title ?? ""), summary: String(card.summary ?? ""),
        href: String(card.href ?? ""), imageAssetId: String(card.imageAssetId ?? ""), alt: String(card.alt ?? ""),
        ...(card.altDecorative === true ? { altDecorative: true } : {}),
      })} />
      <details><summary>Add from an API source</summary>
        <p>Choose from the current published source catalog. PBS Media Manager provides shows; Spotlight provides related stories.</p>
        <Button disabled={loading} onClick={() => void loadCatalog()}>{loaded ? "Reload source catalog" : "Load source catalog"}</Button>
        {catalogError ? <p role="alert">{catalogError}</p> : null}
        {loaded ? <>
          <label className="editor-field">Source<Select value={source} onChange={event => setSource(event.target.value as typeof source)}>
            <option value="media_manager">PBS Media Manager</option><option value="spotlight">NJ Spotlight News</option>
          </Select></label>
          <label className="editor-field">Find a source item<TextInput value={query} onChange={event => setQuery(event.target.value)} /></label>
          <ul>{matchingCatalog.map(item => <li key={item.id}>
            <ActionControl action="add-item" accessibleName={`Add ${item.title}`} contextLabel={item.title} disabled={full} onClick={() => add({ itemId: mintCollectionItemId(), title: item.title,
              summary: item.summary, href: item.href, source, sourceId: item.id })} />
          </li>)}</ul>
          {matchingCatalog.length === 0 ? <p>No source items match. Change the search, choose another source, or add a URL. An empty hero uses the Home fallback.</p> : null}
        </> : null}
      </details>
      <Button disabled={full} onClick={() => add({ itemId: mintCollectionItemId(), title: "", summary: "", href: "" })}>{editorial ? "Add a story with a URL" : "Add a slide with a URL"}</Button>
        </div>
        </div>
        <div className="home-hero-slide-fields">
      {items.map((item, index) => {
        const href = item.href.trim() || catalog.find(card => card.source === item.source && card.id === item.sourceId)?.href || item.href;
        const defaultAction = homeHeroIsVideo({ source: item.source, href }) ? "Watch the report" : "Read the story";
        return <fieldset className="record-field-group" key={item.itemId} hidden={activeItem?.itemId !== item.itemId}>
        <legend>{editorial ? "Story" : "Slide"} {index + 1}</legend>
        {editorial ? <p className="muted">{index === 0 ? "Lead story" : index <= supportingCount ? "Supporting headline" : "More stories"} · Move this story to change its position on the page.</p> : null}
        <div className="button-row home-hero-slide-actions">
        <ActionControl action="move-up" label={`Move ${editorial ? "story" : "slide"} ${index + 1} up`} disabled={index === 0} onClick={() => move(index, -1)} />
        <ActionControl action="move-down" label={`Move ${editorial ? "story" : "slide"} ${index + 1} down`} disabled={index === items.length - 1} onClick={() => move(index, 1)} />
        <Tooltip content={`Remove ${editorial ? "story" : "slide"} ${index + 1}`}><Button variant="danger" aria-label={`Remove ${editorial ? "story" : "slide"} ${index + 1}`} onClick={() => update({ items: items.filter((_, position) => position !== index) })}><Icon name="trash" /></Button></Tooltip>
        </div>
        <HeroArtwork item={item} loadMedia={media.loadMedia} catalog={catalog} />
        <FieldRenderer {...media} field={{ key: "imageAssetId", label: editorial ? "Story image" : "Slide image", kind: "asset", required: false,
          help: item.source ? "Optional station image override. Remove it to use the source artwork." : "Optional station image. The branded graphic remains when no image is selected." }}
          fieldId={`home-hero-image-${item.itemId}`} value={item.imageAssetId ?? ""} onChange={value => edit(index, { imageAssetId: String(value ?? ""), alt: "", altDecorative: false })} />
        {item.source ? <>
          <p className="muted">{item.source === "cms_posts" ? "Blank fields follow the published story. Home overrides stay until you reset them. Withdrawal removes this story even when it has overrides." : "Provider stories keep their saved text and destination. Use the current version to copy a provider correction. Feed rotation keeps this saved copy."}</p>
          <p>Image: {item.imageAssetId ? "Home override" : "Follows story"}</p>
          <Button disabled={!item.imageAssetId} onClick={() => edit(index, { imageAssetId: "", alt: "", altDecorative: false })}>Use story’s current image</Button>
        </> : null}
        {([ ["title", "Title"], ["summary", "Summary"], ["href", "Destination URL"] ] as const).map(([key, label]) => <div key={key}>
          <label className="editor-field">{label}{key === "summary"
            ? <Textarea rows={3} value={item[key]} placeholder={catalog.find(card => card.source === item.source && card.id === item.sourceId)?.[key]} onChange={event => edit(index, { [key]: event.target.value })} />
            : <TextInput value={item[key]} placeholder={catalog.find(card => card.source === item.source && card.id === item.sourceId)?.[key]} onChange={event => edit(index, { [key]: event.target.value })} />}
          </label>
          {item.source ? <><p>{label}: {item.source !== "cms_posts" && item[key].trim() ? "Saved provider copy" : item[key].trim() ? "Home override" : "Follows story"}</p>
            <Button disabled={item.source === "cms_posts" ? !item[key].trim() : !catalog.some(card => card.source === item.source && card.id === item.sourceId)} onClick={() => edit(index, { [key]: item.source === "cms_posts" ? "" : catalog.find(card => card.source === item.source && card.id === item.sourceId)?.[key] ?? item[key] })}>Use story’s current {key === "href" ? "destination" : key}</Button></> : null}
        </div>)}
        {editorial ? <><label className="editor-field">Story button text
          <TextInput value={item.actionLabel ?? ""} maxLength={HOME_HERO_ACTION_MAX_LENGTH}
            placeholder={defaultAction}
            aria-describedby={`home-hero-action-help-${item.itemId}`}
            onChange={event => edit(index, { actionLabel: event.target.value })} />
        </label>
          <small id={`home-hero-action-help-${item.itemId}`}>Optional. Leave blank to use {defaultAction}. Up to {HOME_HERO_ACTION_MAX_LENGTH} characters, on one line.</small>
        </> : null}
        {item.imageAssetId ? <>
          <label className="editor-field">Image description<TextInput value={item.alt ?? ""} disabled={item.altDecorative} aria-describedby={item.imageAssetId && !item.altDecorative && !item.alt?.trim() ? `home-hero-alt-warning-${item.itemId}` : undefined} onChange={event => edit(index, { alt: event.target.value })} /></label>
          {item.imageAssetId && !item.altDecorative && !item.alt?.trim() ? <p className="warning-text" id={`home-hero-alt-warning-${item.itemId}`}>Image description is empty. You can save and publish, but describe the image or mark it decorative when you can.</p> : null}
          <label><input type="checkbox" checked={item.altDecorative === true} onChange={event => edit(index, { altDecorative: event.target.checked, ...(event.target.checked ? { alt: "" } : {}) })} />Decorative image</label>
        </> : null}

      </fieldset>;
      })}
        </div>
        {activeItem ? <HeroSlidePreview item={activeItem} loadMedia={media.loadMedia} catalog={catalog} loaded={loaded} unverified={unverifiedIds.includes(activeItem.sourceId ?? "")} /> : null}
      </div>
    </> : null}
    {hasBoundItems ? <><Button disabled={loading} onClick={() => void loadCatalog()}>Refresh published stories</Button>{catalogError ? <p role="alert">{catalogError}</p> : null}</> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {validation ? <p role="alert">{validation}</p> : null}
  </fieldset>;
}

type HeroArtworkProps = { item: HomeHeroManualItem; loadMedia: MediaProps["loadMedia"]; catalog: HomeHeroCatalogItem[] };

function HeroArtwork({ item, loadMedia, catalog, thumbnail = false }: HeroArtworkProps & { thumbnail?: boolean }) {
  const asset = useResolvedMediaAsset(item.imageAssetId ?? "", loadMedia);
  const source = catalog.find(entry => entry.source === item.source && entry.id === item.sourceId);
  const url = item.imageAssetId
    ? (asset ? mediaPreviewUrl(asset, thumbnail ? 96 : 960) : undefined)
    : source?.image?.url;
  const fallback = <span className="home-hero-artwork-empty" aria-hidden={thumbnail || undefined}>{thumbnail ? <Icon name="image" /> : !item.imageAssetId && source?.source === "cms_posts" && !source.image
    ? "The source image is unavailable in this preview. Check the saved preview, or choose a Home image."
    : item.source ? "Source artwork is resolved for the saved preview." : "No slide image selected"}</span>;
  return <span className={thumbnail ? "home-hero-slide-thumbnail" : "home-hero-slide-artwork"}>
    {url ? <AssetImage src={new URL(url, `${publicSiteOrigin}/`).href} alt="" fallback={source?.image?.fallbackUrl && !item.imageAssetId
      ? <AssetImage src={new URL(source.image.fallbackUrl, `${publicSiteOrigin}/`).href} alt="" fallback={fallback} /> : fallback} /> : fallback}
  </span>;
}

function HeroSlidePreview({ item, loadMedia, catalog, loaded, unverified }: HeroArtworkProps & { loaded: boolean; unverified: boolean }) {
  const asset = useResolvedMediaAsset(item.imageAssetId ?? "", loadMedia);
  let card;
  try {
    card = resolveHomeHero({ mode: "manual", items: [item] }, catalog, asset ? {
      [item.imageAssetId!]: { url: mediaPreviewUrl(asset, 960), width: asset.width ?? undefined, height: asset.height ?? undefined },
    } : {})[0];
  } catch { /* Incomplete authored cards remain editable. */ }
  const providerMissing = item.source && item.source !== "cms_posts" && loaded && !catalog.some(card => card.source === item.source && card.id === item.sourceId);
  const unavailable = item.source && (!loaded || unverified);
  return <aside className="home-hero-slide-preview" aria-label="Hero preview">
    <h3>Hero preview</h3>
    {providerMissing ? <p role="status">This item is no longer in the provider feed. Its text and destination use the saved copy. The provider image is no longer available; choose a station image or use the normal fallback artwork.</p> : null}
    {unavailable ? <p role="status">This story’s published preview could not be verified. Refresh published stories or use the saved page preview.</p> : card ? <div className="home-hero-preview-card">
      {card.image ? <AssetImage referrerPolicy="no-referrer" src={new URL(card.image.url, `${publicSiteOrigin}/`).href} alt={card.image.alt ?? ""} fallback={card.image.fallbackUrl
        ? <AssetImage referrerPolicy="no-referrer" src={new URL(card.image.fallbackUrl, `${publicSiteOrigin}/`).href} alt="" fallback={<span>Story image unavailable</span>} />
        : <span>Story image unavailable</span>} /> : null}
      <strong>{card.title}</strong><p>{card.summary}</p><a href={new URL(card.href, `${publicSiteOrigin}/`).href} target="_blank" rel="noopener noreferrer">View story</a>
    </div> : <p role="status">{providerMissing ? "Complete the saved title and destination to keep this provider story on Home." : item.source ? "This story is missing or withdrawn. It stays selected but will not appear on Home." : "Complete the title and destination to preview this slide."}</p>}
  </aside>;
}
