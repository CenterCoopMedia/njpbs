import { COUNTY_COMPARISON_DEFAULTS } from "../../../packages/content-core/src/county-comparison";
import { TOWN_LOOKUP_DEFAULTS } from "../../../packages/content-core/src/town-lookup";
import type { EditorBlock } from "../../../packages/content-core/src/editor-admin";
import { adminFieldsForBlock, homeLayoutsEnabled } from "./home-layouts";
import { defaultValueForField } from "./field-defaults";
import type { BlockLayout, BlockType } from "../../../packages/content-core/src/content-model";
import { HOME_NEWSCAST_DEFAULTS, createHomeNewscastBlock } from "../../../packages/content-core/src/home-newscast-section";

// An admin working block: an `EditorBlock` (the id / type / order the reducer addresses and
// renumbers) plus the ADR 0013 envelope fields the shell edits (`visible`, `data`). The
// reducer is generic over any block that carries at least `{ id, type, order }` and
// preserves the rest, so ops reorder these blocks and leave their data and visibility
// untouched. `data` is a loose bag here because the shell edits it field by field through
// the descriptor renderer; the save boundary is where `parseBlocks` pins the exact shape.
export interface AdminBlock extends EditorBlock {
  section?: string;
  layout?: BlockLayout;
  visible: boolean;
  data: Record<string, unknown>;
}

// A block's starting data: each editor field seeded from its kind's default, so a freshly
// inserted block is already in a shape the descriptor renderer can edit and the save
// boundary can validate. A divider has no editor fields, so its data is empty.
export function defaultBlockData(type: BlockType): Record<string, unknown> {
  if (type === "home_newscast") return { ...HOME_NEWSCAST_DEFAULTS };
  if (type === "document_list") return { documents: [] };
  if (type === "bio_card") return { profileId: "", kind: "person", name: "", role: "", summary: "", sourceUrl: "", sourceLabel: "", asOf: "" };
  if (type === "data_hub_section") return { sectionId: "introduction", heading: "", introduction: "" };
  if (type === "data_figure") return { datasetId: "", version: { mode: "pinned", releaseId: "" }, display: "expanded" };
  if (type === "county_comparison") return { ...COUNTY_COMPARISON_DEFAULTS };
  if (type === "town_lookup") return { ...TOWN_LOOKUP_DEFAULTS };
  if (type === "election_results") return { races: [] };
  if (type === "video") return { sourceId: "video-library", assetId: "", title: "" };
  if (type === "row") return { columns: [6, 6] };
  if (type === "record_card") return { recordKind: "program", recordId: "" };
  const data: Record<string, unknown> = {};
  for (const field of adminFieldsForBlock(type)) {
    const value = defaultValueForField(field);
    if (value !== undefined) data[field.key] = value;
  }
  if (type === "promotion_playlist") {
    data.placement = "before_featured";
    data.presentation = "rail";
    data.columns = 3;
  }
  if (type === "content_shelf" && homeLayoutsEnabled()) {
    data.presentation = "grid";
    data.columns = 3;
  }
  if (type === "sponsor_strip") data.layout = "row";
  return data;
}

// A new block of the given type. `id` is injected rather than minted here so the factory
// stays pure and deterministic in tests; the caller (the hook) owns id generation. `order`
// is provisional -- the reducer renumbers it to the array index on insert -- so it defaults
// to 0 and callers need not compute it.
export function createBlock(type: BlockType, id: string, order = 0): AdminBlock {
  if (type === "home_newscast") return { ...createHomeNewscastBlock(id), order } as unknown as AdminBlock;
  return { id, type, order, visible: true, data: defaultBlockData(type) };
}

