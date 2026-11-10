import { homeBandBackground } from "../../../packages/content-core/src/home-band-background";
import { useResolvedMediaAsset } from "./useResolvedMediaAsset";
import { HomeNewsletterPreview } from "./HomeNewsletterEditor";
import { useEffect, useMemo, useRef, useState } from "react";
import { parseBlocks } from "../../../packages/content-core/src/content-model";
import { renderHomeDonor } from "../../../packages/content-core/src/home-donor-section";
import { HOME_DESTINATIONS, homePassportHeading } from "../../../packages/content-core/src/home-composition-contract";
import { renderHomePassport } from "../../../packages/content-core/src/home-section-render";
import { generatedHeadingLevelAt, renderBlock, type ResolvedRenderAsset, type SponsorRenderData } from "../../../packages/content-core/src/content-render";
import { renderContentGroups, contentBlockHtml } from "../../../packages/content-core/src/content-row-render";
import { installDataTableControls } from "../../../packages/content-core/src/data-table-controls";
import { installCountyComparisonControls } from "../../../packages/content-core/src/county-comparison-controls";
import { installTownLookupControls } from "../../../packages/content-core/src/town-lookup-controls";
import bioStyles from "../../../packages/content-core/src/bio.css?inline";
import { useBioCatalog } from "./BioCatalogContext";
import { pageSeedAsset } from "../../../packages/content-core/src/page-composition-seeds";
import blockStyles from "../../../packages/content-core/src/component-blocks.css?inline";
import tableStyles from "../../../packages/content-core/src/data-table.css?inline";
import shelfStyles from "../../../packages/content-core/src/custom-shelf.css?inline";
import linkCardStyles from "../../../packages/content-core/src/link-card.css?inline";
import electionResultsStyles from "../../../packages/content-core/src/election-results.css?inline";
import { installApEmbedControls } from "../../../packages/content-core/src/ap-embed-controls";
import countyComparisonStyles from "../../../packages/content-core/src/county-comparison.css?inline";
import townLookupStyles from "../../../packages/content-core/src/town-lookup.css?inline";
import type { AdminBlock } from "../lib/block-factory";
import type { MediaPickerLoader } from "./MediaPickerDialog";
import { HomePreviewFrame } from "./HomePreviewFrame";
import { HomeNewscastPreview } from "./HomeNewscastEditor";
import { installHomeNewscastPlayers } from "../../../packages/content-core/src/home-newscast-player";
import { HomeShelfLayoutPreview } from "./HomeShelfLayoutPreview";
import type { HomeSourceSnapshot } from "../../../packages/content-core/src/home-rail-render";
import { mediaPreviewUrl } from "../lib/media-image";
import { ContentShelfSources } from "./ContentShelfPicker";
import { Select } from "./ui/Primitives";
import { useContext } from "react";
import "./ComponentPhonePreview.css";

const previewStyles = `${blockStyles}\n${tableStyles}\n${shelfStyles}\n${linkCardStyles}\n${bioStyles}\n${electionResultsStyles}\n${countyComparisonStyles}\n${townLookupStyles}\nhtml, body { background: var(--color-surface-page); color: var(--color-text-on-surface); } #home-preview-root { padding: 16px; overflow-wrap: anywhere; } .cms-page__blocks { padding: 0; gap: 0; }`;

function installAuthoredPreviewControls(root: HTMLElement): () => void {
  const disposeTables = installDataTableControls(root);
  const disposeCounties = installCountyComparisonControls(root);
  installTownLookupControls(root);
  const disposeApEmbeds = root.ownerDocument.defaultView ? installApEmbedControls(root.ownerDocument.defaultView) : () => {};
  return () => { disposeTables(); disposeCounties(); disposeApEmbeds(); };
}

function assetIds(block: AdminBlock): string[] {
  const ids: string[] = [];
  const add = (value: unknown) => { if (typeof value === "string" && value.trim()) ids.push(value); };
  if (block.type === "image") add(block.data.assetId);
  if (block.type === "bio_card" && block.data.image && typeof block.data.image === "object") add((block.data.image as Record<string, unknown>).assetId);
  if (block.type === "election_results" && Array.isArray(block.data.races)) {
    for (const race of block.data.races) {
      if (!Array.isArray(race?.candidates)) continue;
      for (const candidate of race.candidates) add(candidate?.photo?.assetId);
    }
  }
  const list = block.type === "image_gallery" ? block.data.images : block.data.cards;
  if (Array.isArray(list)) for (const item of list) {
    if (item && typeof item === "object") add(block.type === "image_gallery" ? item.assetId : item.imageAssetId);
  }
  return [...new Set(ids)].sort();
}

interface ComponentPhonePreviewProps {
  block: AdminBlock; blocks?: AdminBlock[]; headingContext?: AdminBlock[]; loadMedia?: MediaPickerLoader; showPageSeedAssets?: boolean; generatedHeadingLevel?: number;
  loadHomeSources?: (signal: AbortSignal) => Promise<HomeSourceSnapshot>;
  homeV2?: boolean;
}

/** The existing modal mounts this only while its phone panel is open. */
export function ComponentPhonePreview(props: ComponentPhonePreviewProps) {
  const backgroundBlock = props.homeV2 && props.block.section?.startsWith("home-passport-")
    ? props.blocks?.find(block => block.section === "home-passport-copy") ?? props.block : props.block;
  const backgroundId = typeof backgroundBlock.data.backgroundImageAssetId === "string" ? backgroundBlock.data.backgroundImageAssetId : "";
  const background = useResolvedMediaAsset(backgroundId, props.loadMedia);
  const assets = background ? { [background.id]: { url: mediaPreviewUrl(background, 960) } } : {};
  if (backgroundId && !background) return <p role="status">Background image is loading or unavailable. Choose an available image or remove it.</p>;
  if (props.block.section === "home-newscast" && props.block.type === "home_newscast") return <HomeNewscastPreview block={props.block} loadSources={props.loadHomeSources} render={html => <ComponentPhoneFrame html={html} title="Newscast" styles="" onRender={installHomeNewscastPlayers} />} />;
  if (props.homeV2 && props.block.section?.startsWith("home-passport-")) {
    const parsed = parseBlocks((props.blocks ?? []).filter(block => block.section?.startsWith("home-passport-")), { complete: false });
    const copy = parsed.ok ? parsed.blocks.find(block => block.section === "home-passport-copy" && block.type === "prose") : undefined;
    const action = parsed.ok ? parsed.blocks.find(block => block.section === "home-passport-action" && block.type === "cta_row") : undefined;
    if (copy?.type !== "prose" || action?.type !== "cta_row") return <p role="status">Complete the Passport copy and action to preview this section.</p>;
    if (!copy.visible || !action.visible) return <p role="status">This section is removed from the page.</p>;
    const html = renderHomePassport({ backgroundImage: homeBandBackground(copy.data.backgroundImageAssetId, assets), heading: homePassportHeading(copy.data.content) ?? "",
      body: { type: "doc", content: copy.data.content.content.slice(1) }, actionLabel: action.data.ctas[0]?.label ?? "" }, HOME_DESTINATIONS.passport, true);
    return <ComponentPhoneFrame html={html} title="Passport" styles="" />;
  }
  if (props.block.section === "home-newsletter" && props.block.type === "newsletter_signup") return <HomeNewsletterPreview assets={assets} block={props.block} loadSources={props.loadHomeSources} render={html => <ComponentPhoneFrame html={html} title="Newsletter signup" styles="" />} />;
  if (props.block.type === "card_grid" && props.block.section === "home-donor") {
    const parsed = parseBlocks([props.block], { complete: false });
    let html = "";
    try { if (parsed.ok && parsed.blocks[0].type === "card_grid") html = renderHomeDonor(parsed.blocks[0], { complete: false, assets }); } catch { /* Incomplete copy stays editable. */ }
    return html ? <ComponentPhoneFrame html={html} title="Donor-advised giving" styles="" />
      : <p role="status">Add a heading and button text to preview this plank.</p>;
  }
  if (props.block.type === "content_shelf") return <HomeShelfLayoutPreview
    block={props.block} loadSources={props.loadHomeSources} homeV2={props.homeV2}
    render={html => <ComponentPhoneFrame html={html} title="Home content shelf" styles="" />} />;
  return <AuthoredComponentPhonePreview {...props} />;
}

/** A full current component, never a cropped canvas summary or another editor. */
function AuthoredComponentPhonePreview({ block, blocks, headingContext, loadMedia, showPageSeedAssets = false, generatedHeadingLevel = 2 }: ComponentPhonePreviewProps) {
  const sources = useContext(ContentShelfSources);
  const bioCatalog = useBioCatalog();
  const sponsorIds = block.type === "sponsor_strip" && Array.isArray(block.data.sponsorIds)
    ? block.data.sponsorIds.filter((id): id is string => typeof id === "string") : [];
  const sponsorKey = sponsorIds.join("\u0000");
  const [selectedSponsors, setSelectedSponsors] = useState<{ key: string; items: SponsorRenderData[] }>();
  useEffect(() => {
    if (!sponsorIds.length || !sources.loadRecord) return;
    let current = true;
    void Promise.all(sponsorIds.map(async id => {
      const result = await sources.loadRecord!("sponsor", id);
      if (result.status !== "ready" || result.record.deleted || result.record.status === "archived") return null;
      const record = result.record;
      const logoId = typeof record.logoAssetId === "string" ? record.logoAssetId : "";
      let logoUrl: string | null = null;
      if (logoId && loadMedia) {
        // A logo that fails to load leaves this sponsor as a name, not the whole strip empty.
        try {
          const media = await loadMedia({ q: "", assetIds: [logoId], categories: [], kinds: ["image"],
            sort: "updatedAt", direction: "desc", page: 1 });
          const asset = media.records.find(item => item.id === logoId);
          if (asset) logoUrl = mediaPreviewUrl(asset, 480);
        } catch {
          logoUrl = null;
        }
      }
      return { sponsorId: id, name: String(record.name ?? "Untitled sponsor"),
        href: typeof record.href === "string" ? record.href : null,
        logoUrl, logoAlt: record.logoDecorative ? "" : String(record.logoAlt ?? ""),
        logoDecorative: record.logoDecorative === true } satisfies SponsorRenderData;
    })).then(items => { if (current) setSelectedSponsors({ key: sponsorKey,
      items: items.filter((item): item is SponsorRenderData => item !== null) });
    }).catch(() => { if (current) setSelectedSponsors({ key: sponsorKey, items: [] }); });
    return () => { current = false; };
  }, [sponsorKey, sources.loadRecord, loadMedia]);
  const source = useMemo(() => blocks ? blocks.filter(item => item.id === block.id || item.visible) : [{ ...block, order: 0, layout: undefined }], [block, blocks]);
  const key = JSON.stringify([...new Set(source.flatMap(assetIds))].sort());
  const [resolved, setResolved] = useState<{ key: string; loader: MediaPickerLoader | undefined; seeds: boolean; assets: Record<string, ResolvedRenderAsset> }>();
  const [failedKey, setFailedKey] = useState<string>();
  useEffect(() => {
    let current = true;
    setFailedKey(undefined);
    const ids = JSON.parse(key) as string[];
    void Promise.resolve().then(async () => {
      if (!current) return;
      const entries: [string, ResolvedRenderAsset][] = [];
      const pending: string[] = [];
      for (const id of ids) {
        const seed = showPageSeedAssets ? pageSeedAsset(id) : null;
        if (seed) entries.push([id, { url: seed.sourceUrl, width: seed.width, height: seed.height }]);
        else pending.push(id);
      }
      // Exact-id hydration accepts 12 ids. One batch in flight also lets closing
      // the preview cancel all remaining batches before dispatch.
      for (let offset = 0; offset < pending.length; offset += 12) {
        if (!current) return;
        if (!loadMedia) throw new Error("Image preview unavailable");
        const batch = pending.slice(offset, offset + 12);
        const result = await loadMedia({ q: "", assetIds: batch, categories: [], kinds: ["image"], sort: "updatedAt", direction: "desc", page: 1 });
        for (const id of batch) {
          const asset = result.records.find(record => record.id === id);
          if (!asset) throw new Error("Image preview unavailable");
          entries.push([id, { url: mediaPreviewUrl(asset, 480), width: asset.width ?? undefined, height: asset.height ?? undefined }]);
        }
      }
      if (current) setResolved({ key, loader: loadMedia, seeds: showPageSeedAssets, assets: Object.fromEntries(entries) });
    }).catch(() => { if (current) setFailedKey(key); });
    return () => { current = false; };
  }, [key, loadMedia, showPageSeedAssets]);
  const parsed = useMemo(() => parseBlocks(source.map((item, order) => ({ ...item, order }))), [source]);
  const needsAssets = key !== "[]";
  const assets = resolved?.key === key && resolved.loader === loadMedia && resolved.seeds === showPageSeedAssets ? resolved.assets : undefined;
  let message: string | undefined;
  if (!parsed.ok) message = "Complete this component’s fields to see its preview.";
  else if (block.type === "row" && !blocks) message = "Row preview needs its column content.";
  else if (needsAssets && !assets) message = failedKey === key ? "Images could not be loaded. Your draft is unchanged." : "Loading component images…";
  else if (sponsorIds.length && sources.loadRecord && selectedSponsors?.key !== sponsorKey) message = "Loading sponsors…";
  const groups = !message && parsed.ok ? renderContentGroups(parsed.blocks, (item, index) => {
    const context: readonly { id: string; type: string; visible: boolean; data: unknown }[] = headingContext ?? parsed.blocks;
    const contextIndex = headingContext ? context.findIndex(candidate => candidate.id === item.id) : index;
    return { html: renderBlock(item, {
      allowBios: Boolean(bioCatalog) || item.type === "bio_card",
      generatedHeadingLevel: blocks ? generatedHeadingLevelAt(context, contextIndex) : generatedHeadingLevel,
      resolveAsset: id => assets?.[id] ?? null,
      sponsors: selectedSponsors?.items ?? [],
    }) };
  }) : [];
  const html = `<div class="cms-page__blocks">${groups.map(contentBlockHtml).join("")}</div>`;
  return message ? <p role="status">{message}</p> : <ComponentPhoneFrame html={html} onRender={installAuthoredPreviewControls} />;
}

const phoneSizes = [
  { width: 320, height: 568, label: "Small phone" },
  { width: 390, height: 844, label: "Phone" },
  { width: 430, height: 932, label: "Large phone" },
];

export function ComponentPhoneFrame({ html, title = "Current component", styles = previewStyles, onRender }: {
  html: string; title?: string; styles?: string; onRender?: (root: HTMLElement) => void | (() => void);
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const [phoneWidth, setPhoneWidth] = useState(390);
  const phone = phoneSizes.find(size => size.width === phoneWidth)!;
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => {
      // Fit the floating panel without changing the viewport used by public CSS.
      // An inline preview can use the editor's normal vertical scrolling.
      const height = window.innerWidth > 1120 ? Math.max(120, window.innerHeight - 180) : Infinity;
      const next = Math.min(1, element.clientWidth / phone.width, height / phone.height);
      // Ignore fitting noise smaller than a pixel in the displayed phone.
      setScale(current => Math.abs(next - current) * Math.max(phone.width, phone.height) < 1 ? current : next);
    };
    measure();
    let frame: number | null = null;
    const scheduleMeasure = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        measure();
      });
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleMeasure);
    observer?.observe(element);
    window.addEventListener("resize", scheduleMeasure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [phone]);
  return <>
    <label className="component-phone-size">Screen size
      <Select value={phoneWidth} onChange={event => setPhoneWidth(Number(event.target.value))}>
        {phoneSizes.map(size => <option key={size.width} value={size.width}>{size.label}: {size.width} × {size.height}</option>)}
      </Select>
    </label>
    <div className="component-phone-viewport" ref={viewport}>
      <div className="component-phone-screen" style={{ width: phone.width * scale, height: phone.height * scale }}>
        <div style={{ width: phone.width, transform: `scale(${scale})`, transformOrigin: "top left" }}>
          <HomePreviewFrame html={html} title={`${title} at ${phone.width} pixels`} styles={styles} viewportHeight={phone.height} onRender={onRender} interactivePlayers />
        </div>
      </div>
    </div>
    <p className="component-phone-scale">{Math.round(scale * 100)}% size · Scroll inside to see more</p>
  </>;
}
