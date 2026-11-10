// Which gallery specimens the visual regression suite captures, and at what widths and
// control presentations.
//
// The registry itself is not restated here. The suite reads the live specimen index out of
// the running gallery (see tests/visual/specimens.spec.ts) and this module decides which of
// those entries become capture pairs. A selected id that no longer exists in the registry is
// an error, not a silent skip, so renaming a specimen fails the suite instead of quietly
// dropping a baseline.
//
// Selection rule (#1036, criterion 7). The suite captures the eight surfaces the issue's
// criterion 6 comparison names -- dashboard, library, page editor, post editor, Activity,
// publish queue, staff access, and settings -- plus the signed-in shell those surfaces live
// in and the media controls added by the redesign phases. The restore confirmation is the
// one selected lifecycle state because its placement changes the shell layout. Other data
// states (loading, empty, error, conflict, role variants, tag and media detail states)
// exercise data handling rather than control presentation, so they are excluded to keep the
// baseline set reviewable.

import {
  CONTROL_PRESENTATIONS,
  type ControlPresentation,
} from "./control-presentation";

/** One entry of the gallery's specimen registry, reduced to what a capture needs. */
export interface GallerySpecimen {
  id: string;
  title: string;
  /** The gallery's own narrow-frame hint. The suite sets its own viewport, so this is metadata only. */
  width?: number;
}

/** A flat capture pair: one specimen, one viewport width, one control presentation. */
export interface VisualSpecimenPair {
  id: string;
  title: string;
  width: number;
  presentation: ControlPresentation;
}

/**
 * The selected specimen ids, in capture order, each with the criterion 6 surface it stands
 * for. The comment on each line is the reason it is in the set.
 */
export const VISUAL_SPECIMEN_IDS: readonly string[] = [
  "control-roles", // shared neutral, commit, selected, busy, disabled and error states
  "auth-loading", // shared sign-in and admission frame
  "shell-home", // signed-in shell and rail
  "newsroom-home", // dashboard
  "content-library", // library
  "page-directory", // grouped row actions must fit their table cell
  "shell-editor", // page editor, in its shell
  "editor-structure-post", // unequal span widths and shared plank selection
  "editor-structure-page", // multiple spans, nested controls and responsive columns
  "post-metadata", // post editor
  "shell-restore-confirmation", // in-flow lifecycle confirmation and focus at desktop and mobile widths
  "activity-populated", // Activity
  "queue", // publish queue
  "users", // staff access
  "navigation-preferences", // settings
  "admin-settings-public-site-chrome", // header newsletter action: toggles, fields, preview and actions
  "record-list", // typed record list, the densest action row in the set
  "media-controls", // shared checkbox, chip and segmented control geometry for media tabs
  "media-toolbar", // toolbar overflow into More at narrow widths, never wrapping
  "media-paging-numbered", // one numbered page status and reversible movement
  "media-paging-cursor", // first, previous and next with a reload boundary
  "media-paging-load-more", // count and one forward action
  "media-video-toolbar", // video name-prefix search, one filter and locked sort
  "media-video-filter", // video-only structured filter properties
  "media-video-sort", // video name, update and file-size directions
  "media-video-display", // video display rows and bounded page sizes
  "media-favorites-toolbar", // Type chip and on-page filter scope
  "media-favorites-grid", // mixed available and unavailable Favorites in the shared grid
  "media-favorites-list", // the same page through the shared list rows
  "media-favorites-selection", // bounded mixed selection with an unavailable ref
  "media-favorites-viewer-image", // image body in the mixed full viewer
  "media-favorites-viewer-document", // document body in the same full viewer
  "media-favorites-viewer-video", // video body and backend-specific tools
  "media-collections-filter", // Status and Scope properties
  "media-collections-list", // applied Status and loaded-page Scope filters on deterministic folder cards
  "media-collections-detail", // mixed image, private video, PDF and unavailable membership in the shared grid
  "media-collections-viewer-image", // image body in the mixed collection viewer
  "media-collections-viewer-video", // cross-backend step target with private-video tools and access
  "media-collections-viewer-document", // PDF fallback after another body change in the same viewer shell
  "media-voiceovers-toolbar", // shared search, Filter and chips without unrelated actions
  "media-voiceovers-filter", // five filter properties without Display
  "media-inspector", // details inspector beside the results, and its modal sheet under 62rem
  "video-viewer-inspector", // shared inspector docked beside the player and stacked under it on narrow screens
  "media-inspector-bulk", // bulk details: preview stack, Mixed field menus, mixed tags and the section menu
  "media-token-suggestions", // tag suggestion list on the floating layer, wrapping options and its source note
  "audio-library", // unified uploaded audio and private voiceovers with shared controls
  "media-tabs", // media tab strip: current mark, counts, and the phone scroll without page overflow
  "media-filter-popover", // composed images toolbar and the Filter popover, anchored and as a phone sheet
  "media-saved-views", // personal saved views and local state controls, anchored and as a phone sheet
  "media-display-popover", // Display popover rows and bottom-end placement, anchored and as a phone sheet
  "media-tile", // shared card: mark, quick actions, badges, selected versus opened, narrow and phone tiles
  "media-list-row", // shared list row: columns from Display fields and the 43rem collapse
  "media-selection-bar", // selection bar: off-page count, caps, the disabled reason and the 21rem layout
  "media-context-menu", // card context menu: one card in menu order, and a titled multi-selection
  "media-quick-look", // loaded-page image preview, PDF fallback and video-poster stepping
  "media-upload-progress", // controlled image and video rows, full tray at desktop and summary pill on phones
  "media-upload-sheet", // fixed inspector slot and full-height phone sheet with a controlled paused video
  "media-drop-overlay", // allowed and blocked file-drag states over deterministic local results
  "image-viewer", // original image with loaded-page stepping and the docked details inspector
  "media-full-viewer-image", // mixed full-view shell with the image body and tools
  "media-full-viewer-document", // the same shell with the PDF fallback body
  "media-full-viewer-video", // the same shell with the video body and tools
];

/**
 * Specimens that mount their own ControlPresentationProvider, so the harness cannot vary
 * their mode: they render the presentation they were written to demonstrate whatever the
 * URL asks for. Capturing one under both modes would write two identical baselines under
 * two names, one of which lies about what it shows. They stay out of the selection; the
 * surfaces they demonstrate are covered by unpinned siblings.
 */
export const PRESENTATION_PINNED_SPECIMEN_IDS: readonly string[] = [
  "page-ready",
  "page-ready-icons",
  "navigation-preferences-text",
];

/**
 * The captured viewport widths: one desktop, one narrow. Both presentation modes run at
 * both, which is what makes an icon-mode overflow at 320px visible.
 */
export const VISUAL_WIDTHS: readonly number[] = [1280, 320];

/** The captured presentations. Both modes, per criterion 7. */
export const VISUAL_PRESENTATIONS: readonly ControlPresentation[] =
  CONTROL_PRESENTATIONS;

export class MissingVisualSpecimenError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(
      `The visual regression selection names specimens the gallery registry no longer has: ${missing.join(", ")}. Update the capture selection or restore the missing gallery specimens, then review the affected baselines.`,
    );
    this.name = "MissingVisualSpecimenError";
  }
}

/**
 * Turn a live specimen registry into the flat capture pairs the suite iterates.
 * Order is stable: specimen, then width, then presentation.
 */
export function visualSpecimenPairs(
  registry: readonly GallerySpecimen[],
  options: {
    selected?: readonly string[];
    widths?: readonly number[];
    presentations?: readonly ControlPresentation[];
  } = {},
): VisualSpecimenPair[] {
  const selected = options.selected ?? VISUAL_SPECIMEN_IDS;
  const widths = options.widths ?? VISUAL_WIDTHS;
  const presentations = options.presentations ?? VISUAL_PRESENTATIONS;

  const byId = new Map(registry.map((specimen) => [specimen.id, specimen]));
  const missing = selected.filter((id) => !byId.has(id));
  if (missing.length > 0) throw new MissingVisualSpecimenError(missing);

  const pairs: VisualSpecimenPair[] = [];
  for (const id of selected) {
    const specimen = byId.get(id);
    if (!specimen) continue;
    for (const width of widths) {
      for (const presentation of presentations) {
        pairs.push({ id, title: specimen.title, width, presentation });
      }
    }
  }
  return pairs;
}

/** The baseline file stem for one pair. Stable, lowercase, no spaces. */
export function visualSpecimenName(pair: VisualSpecimenPair): string {
  return `${pair.id}--${pair.presentation}--${pair.width}w`;
}

/** The gallery URL for one pair, relative to the gallery page. */
export function visualSpecimenUrl(
  galleryPath: string,
  pair: VisualSpecimenPair,
): string {
  const search = new URLSearchParams({
    embed: pair.id,
    presentation: pair.presentation,
  });
  return `${galleryPath}?${search.toString()}`;
}

/** Registry ids the selection leaves out. Reported by the suite so nothing is capped silently. */
export function unselectedSpecimenIds(
  registry: readonly GallerySpecimen[],
  selected: readonly string[] = VISUAL_SPECIMEN_IDS,
): string[] {
  const chosen = new Set(selected);
  return registry
    .map((specimen) => specimen.id)
    .filter((id) => !chosen.has(id));
}
