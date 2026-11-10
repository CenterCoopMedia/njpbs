import { useEffect, useMemo, useState, type ReactNode } from "react";
import { publicSiteOrigin } from "../lib/dev-origins";
import { parseBlocks, type PageBlock } from "../../../packages/content-core/src/content-model";
import type { ResolvedRenderAsset } from "../../../packages/content-core/src/content-render";
import { pageCompositionRegionLabel, pageSeedAsset } from "../../../packages/content-core/src/page-composition-seeds";
import type { PublicPageId } from "../../../packages/content-core/src/public-pages";
import { launchFallbackRoutePages } from "../../../packages/content-core/src/launch-fallback";
import { projectCmsServicePage } from "../../../packages/content-core/src/cms-service-page";
import { renderServiceBody, renderServiceHero, renderServiceNotice, servicePageClass } from "../../../packages/content-core/src/cms-service-render";
import serviceStyles from "../../../site/src/styles/service-page.css?inline";
import scheduleStyles from "../../../site/src/styles/schedule-now-next.css?inline";
import { renderLivePlayerFrame } from "../../../packages/content-core/src/live-player-render";
import { renderScheduleNowNextFrame } from "../../../packages/content-core/src/schedule-now-next-render";
import { useLiveSchedule } from "./useLiveSchedule";
import type { AdminBlock } from "../lib/block-factory";
import { HomePreviewFrame } from "./HomePreviewFrame";
import { mediaPreviewUrl } from "../lib/media-image";
import type { MediaPickerLoader } from "./MediaPickerDialog";
import { Button, InlineMessage } from "./ui/Primitives";
import { LoadingIndicator } from "./ui/LoadingIndicator";
import { Icon, type IconName } from "./ui/Icon";
import "./service-canvas.css";

export function hasServiceCanvas(pageId: string | undefined): pageId is PublicPageId {
  return ["watch", "live", "kids", "support", "give", "passport", "about"].includes(pageId ?? "");
}

interface ServiceCanvasProps {
  pageId: PublicPageId;
  title?: string;
  description?: string;
  blocks: AdminBlock[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  renderCanvas: (frame: ReactNode, mappedIds: ReadonlySet<string>) => ReactNode;
  loadMedia?: MediaPickerLoader;
}

const selectionStyles = `
.public-page__player-frame { position: relative; }
.live-canvas-player {
  position: absolute; inset: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 0.5rem;
  padding: 1rem; text-align: center; color: var(--color-text-on-surface);
}
[data-block-id] { cursor: pointer; position: relative; }
[data-block-id]:hover, [data-block-id]:focus-within {
  outline: var(--focus-outline); outline-offset: 4px;
}
.service-canvas-select {
  position: absolute; inset-block-start: 0; inset-inline-end: 0; z-index: 5;
  min-height: 44px; padding: 0.5rem 0.75rem;
  background: var(--color-brand); color: var(--color-text-on-brand);
  border: 1px solid currentColor; border-radius: 4px; font: inherit;
}
.service-canvas-select:not(:focus-visible) {
  width: 1px; height: 1px; min-height: 0; padding: 0; border: 0;
  clip-path: inset(50%); white-space: nowrap; overflow: hidden;
}
`;

function useServiceAssets(blocks: PageBlock[], loadMedia?: MediaPickerLoader) {
  const ids = [...new Set(blocks.flatMap(block => block.type === "card_grid"
    ? block.data.cards.flatMap(card => card.imageAssetId ? [card.imageAssetId] : []) : []))].sort();
  const key = JSON.stringify(ids);
  const [resolved, setResolved] = useState<Record<string, ResolvedRenderAsset>>({});
  const [unavailable, setUnavailable] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    const requestedIds: string[] = (JSON.parse(key) as string[]).filter(id => !pageSeedAsset(id));
    setUnavailable(false);
    if (requestedIds.length === 0) return;
    void Promise.allSettled(requestedIds.map(async id => {
      if (!loadMedia) throw new Error("Media is unavailable");
      const result = await loadMedia({ q: "", assetIds: [id], categories: [], kinds: ["image"], sort: "updatedAt", direction: "desc", page: 1 });
      const asset = result.records.find(record => record.id === id);
      if (!asset) throw new Error("Image is unavailable");
      return [id, { url: mediaPreviewUrl(asset, 960), width: asset.width ?? undefined, height: asset.height ?? undefined }] as const;
    })).then(results => {
      if (!current) return;
      setResolved(Object.fromEntries(results.flatMap(result => result.status === "fulfilled" ? [result.value] : [])));
      setUnavailable(results.some(result => result.status === "rejected"));
    });
    return () => { current = false; };
  }, [key, loadMedia, attempt]);
  const assets: Record<string, ResolvedRenderAsset> = {};
  for (const id of ids) {
    const seed = pageSeedAsset(id);
    if (seed) assets[id] = { url: seed.sourceUrl, width: seed.width, height: seed.height };
    else if (resolved[id]) assets[id] = resolved[id];
  }
  return { assets, unavailable, retry: () => setAttempt(value => value + 1) };
}

function pagePartPresentation(block: AdminBlock): { icon: IconName; detail: string } {
  if (block.type === "cta_row") {
    const count = Array.isArray(block.data.ctas) ? block.data.ctas.length : 0;
    return { icon: "link", detail: `${count} ${count === 1 ? "button" : "buttons"}` };
  }
  if (block.type === "card_grid") {
    const count = Array.isArray(block.data.cards) ? block.data.cards.length : 0;
    return { icon: "dashboard", detail: `${count} ${count === 1 ? "card" : "cards"}` };
  }
  return { icon: "content", detail: "Text content" };
}

export function ServiceCanvas({ pageId, title, description, blocks, selectedId, onSelect, renderCanvas, loadMedia }: ServiceCanvasProps) {
  const live = useLiveSchedule(pageId === "live");
  // Incomplete local edits stay in their controls, never in the public renderer.
  // Only named regions feed this fixed frame. Additional rows are validated and
  // rendered together by the content canvas, not as orphaned single blocks.
  const regionBlocks = useMemo(() => blocks.filter(block => block.section !== undefined), [blocks]);
  const parsed = useMemo(() => regionBlocks.flatMap(block => {
    const result = parseBlocks([block]);
    return result.ok ? result.blocks : [];
  }), [regionBlocks]);
  const frame = launchFallbackRoutePages.find(page => page.slug === pageId)!;
  const cardRegion = pageId === "watch" ? "watch-destinations" : "service-destinations";
  const cardBlock = parsed.find(block => block.visible && block.type === "card_grid" && block.section === cardRegion);
  const { assets, unavailable, retry } = useServiceAssets(
    frame.destinationCards && cardBlock ? [cardBlock] : [],
    loadMedia,
  );
  const service = projectCmsServicePage({ frame, title: title ?? frame.title,
    description: description ?? frame.description, blocks: parsed, assets });
  const unusedDestinationCards = cardBlock && !service.page.destinationCards
    ? cardBlock.id
    : null;
  const mappedIds = new Set([...Object.values(service.blockIds), ...service.sections.map(section => section.id)]);
  const mappedBlocks = blocks.filter(block => mappedIds.has(block.id));
  const additional = blocks.filter(block => !mappedIds.has(block.id));
  const selected = mappedBlocks.find(block => block.id === selectedId);
  const label = (block: AdminBlock) => block.id === unusedDestinationCards
    ? "Unused destination cards"
    : pageCompositionRegionLabel(pageId, block.section) ?? block.type.replaceAll("_", " ");
  const select = (id: string) => {
    onSelect(id);
  };
  const integrations = pageId === "live" ? `${renderLivePlayerFrame("editor")}${renderScheduleNowNextFrame("compact")}` : "";
  const html = `<article class="${servicePageClass(service.page)}" data-cms-service-page="${pageId}">${renderServiceHero(service)}${renderServiceNotice(service)}${integrations}${renderServiceBody(service)}</article>`;
  return <div className="service-canvas">
    {pageId === "live" ? <div className="service-canvas-source">
      {live.source.status === "loading"
        ? <LoadingIndicator label="Loading the published schedule" stages={["Reading the schedule from the last public release", "Checking schedule data"]}>
            <span>You can edit page content now.</span>
          </LoadingIndicator>
        : <p className="muted" role="status">{live.source.status === "ready"
          ? `Fixed schedule from public release ${live.source.value.publication?.generation}. Schedule data prepared ${new Date(live.source.value.checkedAt).toLocaleString()}.`
          : "The published schedule could not be verified. Your page edits are still available."}</p>}
      <Button onClick={live.retry} disabled={live.source.status === "loading"}>Reload schedule</Button>
      <a href={`${publicSiteOrigin}/live/`} target="_blank" rel="noopener">Open live page (new tab)</a>
    </div> : null}
    {unavailable ? <InlineMessage tone="warning">Some images could not be loaded. Your saved image choices are unchanged. <Button onClick={retry}>Retry images</Button></InlineMessage> : null}
    {unusedDestinationCards ? <InlineMessage tone="warning">Destination cards are saved on this reading page, but they are not shown on the public page. Remove this legacy block after you confirm that its links are available in the page copy.</InlineMessage> : null}
    {parsed.length < regionBlocks.length ? <InlineMessage tone="warning">Incomplete content appears below the page. Finish its fields to see it in the layout.</InlineMessage> : null}
    {renderCanvas(<>
      <div className="service-canvas-layout">
        <section className="service-canvas-page" aria-label="Page preview">
          <header className="service-canvas-preview-header">
            <Icon name="eye" /><strong>Page preview</strong>
            <p>Shows the page with your current draft content.</p>
          </header>
          <HomePreviewFrame title={`${frame.title} page preview`} html={html}
            styles={`${serviceStyles}\n${scheduleStyles}\n${selectionStyles}`} onSelectBlock={select}
            onRender={pageId === "live" ? live.render : undefined}
            blockLabels={Object.fromEntries(mappedBlocks.map(block => [block.id, label(block)]))} />
        </section>
        <aside className="service-canvas-parts" aria-label="Page parts">
          <h3>Page parts</h3>
          <p>Select a part to edit. You can also select it in the page preview.</p>
          <nav aria-label="Page parts">
            <ul>
              {mappedBlocks.map(block => {
                const presentation = block.id === unusedDestinationCards
                  ? { icon: "dashboard" as const, detail: "Not shown on the public page" }
                  : pagePartPresentation(block);
                return <li key={block.id}>
                  <Button className="service-canvas-part" aria-label={`Edit ${label(block)}`}
                    aria-pressed={selected?.id === block.id} aria-haspopup="dialog"
                    onClick={() => onSelect(block.id)}>
                    <Icon name={presentation.icon} />
                    <span><strong>{label(block)}</strong><span>{presentation.detail}</span></span>
                  </Button>
                </li>;
              })}
            </ul>
          </nav>
          {!mappedBlocks.length ? <p>No page parts are available in this preview.</p> : null}
        </aside>
      </div>
      {additional.length ? <div className="service-canvas-additional-heading">
        <h3>Additional and hidden content</h3>
        <p className="muted">Added content follows the page sections. Hidden content stays here so you can show it again.</p>
      </div> : null}
    </>, mappedIds)}
  </div>;
}
