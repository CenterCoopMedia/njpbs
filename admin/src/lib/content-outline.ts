import { groupContentRows } from "../../../packages/content-core/src/content-layout";
import { DATA_HUB_SECTIONS } from "../../../packages/content-core/src/data-hub-composition";
import { BLOCK_LABELS } from "../../../packages/content-core/src/editor-admin";
import { pageCompositionRegionLabel } from "../../../packages/content-core/src/page-composition-seeds";
import type { PublicPageId } from "../../../packages/content-core/src/public-pages";
import type { AdminBlock } from "./block-factory";

export interface OutlineRowNode {
  kind: "row";
  block: AdminBlock;
  rowNumber: number;
  blockCount: number;
  columns: { column: number; blocks: AdminBlock[] }[];
}
export interface OutlineBlockNode { kind: "block"; block: AdminBlock }

/** Count authored sections, including hidden/empty content and the fixed Home hero.
 * A Home row and its members form one section, as in the public composition:
 * empty columns and hidden children do not add sections. Stored blocks stay separate.
 */
export function editorSectionCount(blocks: readonly AdminBlock[], pageId?: PublicPageId): number {
  if (pageId !== "home") return blocks.length;
  const savedNewsletter = blocks.some(block => block.section === "home-newsletter");
  return blocks.filter(block =>
    !block.layout &&
    block.section !== "home-start-action" &&
    block.section !== "home-passport-action" &&
    (!savedNewsletter || block.section !== "home-start"),
  ).length + 1;
}

/** Columns are view nodes. Keep canonical order and the original block objects. */
export function deriveContentOutline(blocks: AdminBlock[]) {
  let rowCount = 0;
  const nodes: (OutlineRowNode | OutlineBlockNode)[] = groupContentRows(blocks).map(group => {
    if (!group.row) return { kind: "block", block: group.columns[0][0] };
    return {
      kind: "row", block: group.row, rowNumber: ++rowCount,
      blockCount: group.columns.reduce((sum, column) => sum + column.length, 0),
      columns: group.columns.map((blocks, column) => ({ column, blocks })),
    };
  });
  return { nodes, rowCount, blockCount: blocks.length - rowCount };
}

export function contentColumnDomId(rowId: string, column: number) {
  return `block-column-${rowId}-${column}`;
}

function firstOutlineText(value: unknown): string | null {
  if (typeof value === "string") {
    const text = value.trim().replace(/\s+/g, " ");
    return text || null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = firstOutlineText(item);
      if (text) return text;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;

  const record = value as Record<string, unknown>;
  const priority = [
    "text",
    "title",
    "question",
    "caption",
    "alt",
    "label",
    "body",
    "content",
    "answer",
  ];
  for (const key of priority) {
    if (!(key in record)) continue;
    const text = firstOutlineText(record[key]);
    if (text) return text;
  }
  for (const [key, nested] of Object.entries(record)) {
    // Model metadata and opaque pointers do not help someone recognize a block in an outline.
    if (
      priority.includes(key) ||
      ["type", "level", "assetId", "imageAssetId", "href", "url"].includes(key)
    ) {
      continue;
    }
    const text = firstOutlineText(nested);
    if (text) return text;
  }
  return null;
}

export function outlineTypeName(block: AdminBlock): string {
  return block.section === "home-start" ? "newsletter band" : BLOCK_LABELS[block.type];
}

export function outlineTypeLabel(block: AdminBlock): string {
  const label = outlineTypeName(block);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function outlineSummary(block: AdminBlock, pageId?: PublicPageId): string {
  if (block.type === "county_comparison") return typeof block.data.heading === "string" && block.data.heading.trim() ? block.data.heading : "2020 and 2024 federal elections by county";
  if (block.type === "data_figure") return block.data.datasetId ? "Data figure" : "Choose an approved dataset";
  if (block.type === "election_results") {
    const races = Array.isArray(block.data.races) ? block.data.races : [];
    return races.length ? races.map(race => [race.office, race.district].filter(Boolean).join(": ") || "Untitled race").join("; ") : "Add the first race";
  }
  if (block.type === "data_hub_section") return String(block.data.heading ?? "").trim() || DATA_HUB_SECTIONS[block.data.sectionId as keyof typeof DATA_HUB_SECTIONS] || "Data Hub section";
  const regionTitle = pageId && pageId !== "home" ? pageCompositionRegionLabel(pageId, block.section) : null;
  if (regionTitle) return regionTitle;
  // The retained start-here record supplies the fixed newsletter boundary in
  // legacy Home documents, rather than an editable card set.
  if (block.section === "home-start") return "Newsletter signup";
  if (block.type === "newsletter_signup") return "Newsletter signup";
  if (block.type === "home_newscast") return typeof block.data.heading === "string" && block.data.heading.trim() ? block.data.heading : "Newscast";
  if (block.type === "bio_card") return typeof block.data.name === "string" && block.data.name.trim() ? `Bio: ${block.data.name}` : "Choose a bio";
  if (block.type === "video") return typeof block.data.title === "string" && block.data.title.trim() ? `Video: ${block.data.title}` : "Choose a video";
  if (block.type === "divider") return "Visual separator";
  if (block.type === "record_card") {
    const kind = typeof block.data.recordKind === "string" ? block.data.recordKind : "record";
    const id = typeof block.data.recordId === "string" ? block.data.recordId : "";
    return id ? `${kind} card: ${id}` : "Choose a record";
  }
  const text = firstOutlineText(block.data);
  if (!text) return `Empty ${BLOCK_LABELS[block.type]}`;
  return text;
}
