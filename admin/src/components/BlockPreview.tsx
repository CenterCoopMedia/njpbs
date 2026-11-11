import { DATA_HUB_SECTIONS, type DataHubSectionId } from "../../../packages/content-core/src/data-hub-composition";
import type { DataHubSectionData } from "../../../packages/content-core/src/data-hub-composition";
import { SectionSourcePreview, VideoResourcePreview } from "./EditorResourcePreview";
import { createElement, lazy, Suspense, type ReactNode } from "react";
import { isRichTextDoc, parseBlocks, renderRichText, richTextRendersEmpty, type RichTextNode } from "../../../packages/content-core/src/content-model";
import { clampHeadingLevel, renderBlock } from "../../../packages/content-core/src/content-render";
import { parseDataTable } from "../../../packages/content-core/src/data-table";
import { pageSeedAsset } from "../../../packages/content-core/src/page-composition-seeds";
import type { AdminBlock } from "../lib/block-factory";
import { outlineSummary } from "../lib/content-outline";
import type { MediaPickerLoader } from "./MediaPickerDialog";
import { AssetImage } from "./ui/AssetImage";
import { mediaImageSources, mediaPreviewUrl } from "../lib/media-image";
import { useResolvedMediaAsset } from "./useResolvedMediaAsset";
import "./BlockPreview.css";
import { newestNoticeDocuments, noticeAddedDate, type NoticeDocument } from "../../../packages/content-core/src/document-list";
import { HomePreviewFrame } from "./HomePreviewFrame";
import blockStyles from "../../../packages/content-core/src/component-blocks.css?inline";

const DataHubSectionPreview = lazy(() => import("./DataHubSectionPreview"));
function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function items(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}

// The canonical renderer escapes text and marks. Remove links from its validated document
// before rendering so the canvas never offers navigation away from the draft.
function withoutLinks(node: RichTextNode): RichTextNode {
  return { ...node, marks: node.marks?.filter(mark => mark.type !== "link"), content: node.content?.map(withoutLinks) };
}
function Heading({ level, children }: { level: number; children: ReactNode }) {
  return createElement(`h${clampHeadingLevel(level)}`, { className: "block-preview-heading" }, children);
}
function RichPreview({ value, parentLevel }: { value: unknown; parentLevel?: number }) {
  if (!isRichTextDoc(value) || richTextRendersEmpty(value)) return <p className="block-preview-empty">Add text</p>;
  const html = renderRichText({ ...value, content: value.content.map(withoutLinks) }, parentLevel === undefined ? {} : { headingLevelOffset: parentLevel - 1, minimumHeadingLevel: Math.min(6, parentLevel + 1) });
  return <div className="block-preview-rich" dangerouslySetInnerHTML={{ __html: html }} />;
}

function Thumbnail({ assetId, caption, loadMedia, showPageSeedAssets }: {
  assetId: string; caption?: string; loadMedia?: MediaPickerLoader; showPageSeedAssets: boolean;
}) {
  const asset = useResolvedMediaAsset(assetId, loadMedia);
  const seed = showPageSeedAssets ? pageSeedAsset(assetId) : null;
  const image = asset ? mediaImageSources(asset, 480) : { src: seed?.sourceUrl };
  const fallback = <span className="block-preview-empty">{assetId ? "Image preview unavailable" : "Choose an image"}</span>;
  return <figure className="block-preview-image">
    {image.src ? <AssetImage {...image} alt="" loading="lazy" decoding="async" fallback={fallback} /> : fallback}
    {caption ? <figcaption>{caption}</figcaption> : null}
  </figure>;
}

function TablePreview({ data }: { data: Record<string, unknown> }) {
  let table;
  try { table = parseDataTable(text(data.csv)); }
  catch { return <><strong>{text(data.title) || "Data table"}</strong><p>Add table data</p></>; }
  return <><strong>{text(data.title) || "Data table"}</strong>
    <p>{table.rows.length} rows · {table.headers.length} columns</p>
    <table><thead><tr>{table.headers.slice(0, 4).map((header, index) => <th key={index}>{header}</th>)}</tr></thead>
      <tbody>{table.rows.slice(0, 2).map((row, index) => <tr key={index}>{row.slice(0, 4).map((cell, column) => <td key={column}>{cell}</td>)}</tr>)}</tbody></table>
    {text(data.source) ? <p>{text(data.source)}</p> : null}
  </>;
}

function SupportAppealPreview({ block, loadMedia, generatedHeadingLevel }: { block: AdminBlock; loadMedia?: MediaPickerLoader; generatedHeadingLevel: number }) {
  const imageId = typeof block.data.backgroundImageAssetId === "string" ? block.data.backgroundImageAssetId : "";
  const image = useResolvedMediaAsset(imageId, loadMedia);
  const parsed = parseBlocks([{ ...block, layout: undefined }], { complete: false });
  return parsed.ok ? <><HomePreviewFrame title="Support appeal preview" styles={blockStyles}
    html={renderBlock(parsed.blocks[0], { generatedHeadingLevel, resolveAsset: () => image ? {
      url: mediaPreviewUrl(image, 960), width: image.width ?? undefined, height: image.height ?? undefined,
    } : null }) || "<p>Complete the appeal fields to see its preview.</p>"} />
    {imageId && !image ? <p role="status">Image preview is loading or unavailable.</p> : null}</>
    : <p>Complete the appeal fields to see its preview.</p>;
}

export function BlockPreview({ resolvedDataFigureLabel, block, loadMedia, showPageSeedAssets = false, generatedHeadingLevel = 2, editorFrame, onInspect, onMediaPickerDirtyChange }: {
  resolvedDataFigureLabel?: string;
  block: AdminBlock; loadMedia?: MediaPickerLoader; showPageSeedAssets?: boolean; generatedHeadingLevel?: number; editorFrame?: "page" | "post"; onInspect?: () => void; onMediaPickerDirtyChange?: (dirty: boolean) => void;
}) {
  const data = block.data;
  if (block.type === "support_appeal") return <SupportAppealPreview block={block} loadMedia={loadMedia} generatedHeadingLevel={generatedHeadingLevel} />;
  if (editorFrame && block.type === "video") return <div className="block-preview"><VideoResourcePreview block={block} onInspect={onInspect} onMediaPickerDirtyChange={onMediaPickerDirtyChange} /></div>;
  if (editorFrame === "page" && ["content_shelf", "home_newscast", "embed", "newsletter_signup"].includes(block.type)) return <div className="block-preview"><SectionSourcePreview block={block} /></div>;
  const image = (assetId: unknown, caption?: string) => <Thumbnail assetId={text(assetId)} caption={caption} loadMedia={loadMedia} showPageSeedAssets={showPageSeedAssets} />;
  let content: ReactNode;
  switch (block.type) {
    case "document_list": content = <>
      <strong>PDF notices · newest first</strong>
      <ul>{newestNoticeDocuments(items(data.documents) as unknown as NoticeDocument[]).map(item => <li key={item.itemId}>
        {item.title || "Untitled notice"} · PDF{item.addedAt ? ` · Added ${noticeAddedDate(item.addedAt)}` : ""}
      </li>)}</ul>
    </>; break;
    case "bio_card": content = <>
      {data.image && typeof data.image === "object" && text((data.image as Record<string, unknown>).assetId) ? image((data.image as Record<string, unknown>).assetId) : null}
      <strong>{text(data.name) || "Choose a bio"}</strong><p>{text(data.role)}</p>
      <p>{[text(data.party), text(data.area)].filter(Boolean).join(" · ")}</p>
      <p>{text(data.summary)}</p>
    </>; break;
    case "video": content = <>
      <strong>{text(data.title) || "Choose a video"}</strong>
      {text(data.caption) ? <p>{text(data.caption)}</p> : null}
    </>; break;
    case "headline": content = <Heading level={clampHeadingLevel(typeof data.level === "number" ? data.level : undefined)}>{text(data.text) || "Add a heading"}</Heading>; break;
    case "prose": content = <RichPreview value={data.content} />; break;
    case "link_card": content = <>
      {text(data.source) ? <span>{text(data.source)}</span> : null}
      <Heading level={generatedHeadingLevel}>{text(data.title) || "Add a card title"}</Heading>
      {text(data.summary) ? <p>{text(data.summary)}</p> : null}
      {text(data.date) ? <p>{text(data.date)}</p> : null}
    </>; break;
    case "faq_item": content = <><Heading level={generatedHeadingLevel}>{text(data.question) || "Add a question"}</Heading><RichPreview value={data.answer} parentLevel={generatedHeadingLevel} /></>; break;
    case "newsletter_signup": content = <><Heading level={generatedHeadingLevel}>{text(data.heading) || "Newsletter signup"}</Heading><p>{block.section === "home-newsletter" ? Array.isArray(data.newsletterIds) && data.newsletterIds.length === 1 ? "Published Newsletter selected" : block.visible ? "The standard newsletter band appears until a newsletter is chosen." : "This section is hidden." : `${Array.isArray(data.newsletterIds) ? data.newsletterIds.length : 0} newsletters selected`}</p></>; break;
    case "home_newscast": content = <><Heading level={generatedHeadingLevel}>{text(data.heading) || "Newscast"}</Heading><p>{text(data.summary)}</p><p>NJ PBS News with Rob Nelson · Updates automatically</p></>; break;
    case "coverage_list": {
      const entries = items(data.entries);
      content = entries.length
        ? <>
            <p>{entries.length} {entries.length === 1 ? "article" : "articles"}</p>
            <ul>{entries.slice(0, 3).map((entry, index) => (
              <li key={index}>
                {text(entry.title) || "Untitled article"}
                {text(entry.outlet) ? ` · ${text(entry.outlet)}` : ""}
              </li>
            ))}</ul>
          </>
        : <p>Add an article</p>;
      break;
    }
    case "image": content = image(data.assetId, text(data.caption) || text(data.alt)); break;
    case "image_gallery": {
      const images = items(data.images);
      content = <><p>{images.length} images</p><div className="block-preview-collection">{images.slice(0, 3).map((item, index) => <div key={index}>{image(item.assetId, text(item.caption) || text(item.alt))}</div>)}</div></>;
      break;
    }
    case "card_grid":
    case "promotion_playlist": {
      const cards = items(data.cards);
      if (block.section === "home-donor") {
        const card = cards[0] ?? {};
        content = <><Heading level={generatedHeadingLevel}>{text(card.title) || "Donor-advised giving"}</Heading>
          <RichPreview value={card.body} parentLevel={generatedHeadingLevel} />
          <div className="block-preview-actions"><span>{text(card.label) || "Add button text"}</span></div></>;
        break;
      }
      content = <>{text(data.title) ? <strong>{text(data.title)}</strong> : null}<p>{cards.length} cards</p>
        <div className="block-preview-collection">{cards.slice(0, 3).map((card, index) => <div key={index}>
          {text(card.imageAssetId) ? image(card.imageAssetId) : null}
          <Heading level={generatedHeadingLevel}>{text(card.title) || "Untitled card"}</Heading>
          {card.body ? <RichPreview value={card.body} parentLevel={generatedHeadingLevel} /> : <p>{text(card.summary)}</p>}
        </div>)}</div></>;
      break;
    }
    case "cta_row": content = <div className="block-preview-actions">{items(data.ctas).length ? items(data.ctas).slice(0, 4).map((cta, index) => <span key={index}>{text(cta.label) || "Add a button label"}</span>) : <p>Add a button</p>}</div>; break;
    case "embed": content = <><strong>Embedded content</strong><p>{text(data.url) || "Add an embed URL"}</p><p>{text(data.caption)}</p></>; break;
    case "html": content = <><strong>Custom HTML</strong><p>{text(data.title) || "Untitled frame"}</p><p>{text(data.html) ? "Scripts run on the published page, not in this editor." : "Add HTML"}</p></>; break;
    case "data_table": content = <TablePreview data={data} />; break;
    case "data_hub_section": content = <Suspense fallback={<strong>{DATA_HUB_SECTIONS[data.sectionId as DataHubSectionId]}</strong>}><DataHubSectionPreview data={data as unknown as DataHubSectionData} level={generatedHeadingLevel} /></Suspense>; break;
    case "data_figure": {
      const version = data.version && typeof data.version === "object" && !Array.isArray(data.version)
        ? data.version as Record<string, unknown> : {};
      content = <><strong>Data figure</strong>
        <p>{resolvedDataFigureLabel || (data.datasetId ? "Approved dataset" : "Choose an approved dataset")}</p>
        <p>{version.mode === "latestApproved" ? "Latest approved release" : text(version.releaseId) ? "Pinned reporting release" : "Choose a reporting release"} · {data.display === "compact" ? "Compact" : "Expanded"}</p></>;
      break;
    }
    case "county_comparison": content = <><Heading level={generatedHeadingLevel}>{text(data.heading) || "How counties voted in 2020 and 2024"}</Heading><p>21 counties · U.S. Senate, combined House votes and turnout</p><p>{text(data.intro)}</p></>; break;
    case "town_lookup": content = <><strong>{text(data.heading) || "Town election lookup"}</strong><p>{text(data.introduction)}</p><p>564 municipalities · Historical presidential and 2024 federal results</p></>; break;
    case "election_results": {
      const races = items(data.races);
      content = <><strong>Election results</strong>{races.length
        ? races.map((race, index) => <p key={index}>{text(race.office) || "Add office"}: {text(race.district) || "Add district"} · {items(race.candidates).length} candidates</p>)
        : <p>Add the first race</p>}<p>Manual changes need approval. Connected results use their source mode.</p></>;
      break;
    }
    case "record_card": content = <>
      <strong>{text(data.recordKind) || "Record"} card</strong>
      <p>{text(data.recordId) || "Choose a record"}</p>
    </>; break;
    case "content_shelf":
    case "topic_shelf":
    case "video_playlist": content = <><strong>{text(data.title) || "Add a shelf title"}</strong>
      <p>{text(data.source) || text(data.library) || "Choose a source"}{text(data.topic) ? ` · ${text(data.topic)}` : ""}</p>
      <p>{typeof data.itemLimit === "number" ? `Up to ${data.itemLimit} items` : "Choose an item count"}</p></>; break;
    case "divider": content = <hr />; break;
    default: content = <p>{outlineSummary(block)}</p>;
  }
  return <div className="block-preview">
    <div className="block-preview-content" aria-hidden="true" ref={element => element?.setAttribute("inert", "")}>{content}</div>
    <span className="sr-only">{outlineSummary(block)}</span>
    {block.section !== "home-donor" && ["image_gallery", "card_grid", "promotion_playlist", "data_table", "cta_row", "coverage_list"].includes(block.type) ? <p className="block-preview-note">Edit to view all items</p> : null}
  </div>;
}
