import {
  GALLERY_PRESENTATION_SPECS,
  type BlockType,
} from "../../../packages/content-core/src/content-model";
import type { EditorField } from "../../../packages/content-core/src/editor-admin";

// The heading rank is the one block property that is not edited on the block's own surface: the
// text is typed in place, but the rank is a structural choice about the page, so it stays a
// settings field rather than another visible control inside the heading itself.
export const HEADLINE_LEVEL_FIELD: EditorField = {
  key: "level",
  label: "Heading level",
  help: "Choose the heading rank that fits this page's structure.",
  kind: "text",
  required: false,
};

// How a gallery is laid out on the published page (#1034). Like the heading rank, this is a
// setting rather than content the editor types on the block's surface, so it lives here and not in
// the descriptor list the collection editor walks. Its options come from the core's mode registry,
// so the editor can never offer a presentation the public renderer does not have.
export const GALLERY_PRESENTATION_FIELD: EditorField = {
  key: "presentation",
  label: "How this gallery looks",
  help: "Choose the arrangement the published page uses.",
  kind: "select",
  required: false,
  options: GALLERY_PRESENTATION_SPECS.map((spec) => ({
    value: spec.value,
    label: spec.label,
  })),
};

// What each block type can actually settle in its settings panel. Every catalog type is listed,
// so adding a block type is a compiler-forced decision rather than a silent empty panel.
//
// This is the single source both the card toolbar and the settings panel read (issue #1043).
// Render Settings only when this record names at least one editable field for the block.
// Deriving it here rather than listing block types at the
// toolbar keeps the control and the panel from ever disagreeing.
const BLOCK_SETTINGS_FIELDS: Readonly<
  Record<BlockType, readonly EditorField[]>
> = Object.freeze({
  bio_card: [],
  row: [],
  headline: [HEADLINE_LEVEL_FIELD],
  prose: [],
  divider: [],
  image: [],
  video: [],
  // A gallery settles how it is presented publicly, so its Settings control stays (#1034).
  image_gallery: [GALLERY_PRESENTATION_FIELD],
  cta_row: [],
  card_grid: [],
  link_card: [],
  document_list: [],
  faq_item: [],
  coverage_list: [],
  data_table: [],
  data_hub_section: [],
  data_figure: [],
  town_lookup: [],
  election_results: [],
  county_comparison: [],
  embed: [],
  html: [],
  content_shelf: [],
  promotion_playlist: [],
  newsletter_signup: [],
  home_newscast: [],
  // Both dynamic blocks (#1046) settle everything on their own surface: the topic, the
  // source or library, the count, the order, and the pins are the block, not decoration
  // around it. Nothing is left for a settings panel, so the Settings control stays hidden
  // rather than opening on an empty sheet.
  topic_shelf: [],
  video_playlist: [],
  record_card: [],
  sponsor_strip: [],
});

export function blockSettingsFields(type: BlockType): readonly EditorField[] {
  return BLOCK_SETTINGS_FIELDS[type] ?? [];
}

export function blockHasSettings(type: BlockType): boolean {
  return blockSettingsFields(type).length > 0;
}

