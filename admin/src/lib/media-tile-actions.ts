import type { IconName } from "../components/ui/Icon";
import type { MenuItem } from "../components/ui/Menu";
import type { IconControlId } from "./icon-control-registry";
import { MAX_BULK_IMAGES } from "./source-media-bulk";

// The actions for one media card or a multi-selection (HIG). One list feeds the card's quick-action cluster, the selection bar and
// the context menu, so the menu mirrors every visible action. Unavailable actions carry
// hidden: true and the Menu leaves them out (hidden, not dimmed).
//
// Card menu order: Open details, Select, Copy link, then Delete last in danger ink.
// Video has no Copy link; "Show videos uploaded by NAME" takes its place.
//
// Quick Look follows Open details on both surfaces, with Open full size after it for images.
// Each is offered only when the host passes its flag,
// so a surface that has not wired the action never shows a menu item that does nothing.

export type MediaTileSurface = "images" | "video";
export type MediaTileActionId =
  | "open"
  | "quick-look"
  | "open-full-size"
  | "select"
  | "copy-link"
  | "copy-file-address"
  | "uploader"
  | "edit-tags"
  | "edit-selected"
  | "clear-selection"
  | "delete";

export interface MediaTileAction {
  id: MediaTileActionId;
  label: string;
  icon: IconName;
  group: "open" | "organize" | "danger";
  hidden: boolean;
  danger?: boolean;
  /** The ActionControl registry id for actions drawn as icon buttons on the card. */
  registryId?: IconControlId;
  /** Why the bar shows this action disabled; the menu hides it instead. */
  disabledReason?: string;
}

export interface MediaTileActionInput {
  surface: MediaTileSurface;
  name: string;
  selected: boolean;
  /**
   * Images pass canManageMediaMetadata(principal, category); video passes the source's
   * canDelete. Delete opens the existing confirmation in details.
   */
  canDelete: boolean;
  /** Video only. The uploader filter needs a uid. */
  uploader?: { uid?: string; name: string } | null;
  /** The host opens Quick Look. */
  quickLook?: boolean;
  /** Images only. The host opens the full-size viewer. */
  openFullSize?: boolean;
  /** Public image file address is available to copy. */
  copyFileAddress?: boolean;
}

/** The context menu for one card, in menu order, with hidden flags. */
export function mediaTileActions(input: MediaTileActionInput): MediaTileAction[] {
  const video = input.surface === "video";
  const uploader = video && input.uploader?.uid ? input.uploader : null;
  const opens: MediaTileAction[] = [
    { id: "open", label: video ? "Open and play" : "Open details", icon: video ? "play" : "eye", group: "open", hidden: false },
  ];
  if (input.quickLook) opens.push({ id: "quick-look", label: "Quick Look", icon: "image", group: "open", hidden: false });
  if (input.openFullSize && !video) opens.push({ id: "open-full-size", label: "Open full size", icon: "maximize", group: "open", hidden: false });
  return [
    ...opens,
    { id: "select", label: input.selected ? "Deselect" : "Select", icon: "check-square", group: "organize", hidden: false, registryId: "media-select" },
    video
      ? { id: "uploader", label: `Show videos uploaded by ${input.uploader?.name ?? ""}`, icon: "users", group: "organize", hidden: !uploader }
      : { id: "copy-link", label: "Copy link", icon: "link", group: "organize", hidden: false },
    ...(input.copyFileAddress && !video ? [{ id: "copy-file-address" as const, label: "Copy file address", icon: "link" as const, group: "organize" as const, hidden: false }] : []),
    { id: "delete", label: "Delete from library", icon: "trash", group: "danger", hidden: !input.canDelete, danger: true },
  ];
}

/**
 * A menu's actions while details or an upload hold unsaved work: only Open details stays, which
 * the leave prompt then guards. Selecting, copying and deleting wait
 * until the form is saved or discarded (the images page's dirty-form guard).
 */
export function lockedMenuActions(actions: MediaTileAction[], locked: boolean): MediaTileAction[] {
  return locked ? actions.filter((action) => action.id === "open") : actions;
}

/**
 * The menu for a multi-selection, which is also the selection bar's action set. Images:
 * Edit tags, when the role can edit. Video: Edit selected, when the role can edit.
 * Both: Clear selection. Bulk mode opens only from Edit tags or Edit selected.
 */
export function mediaSelectionActions({ surface, count, canEdit }: { surface: MediaTileSurface; count: number; canEdit: boolean }): MediaTileAction[] {
  const bulkCapError = surface === "images" && count > MAX_BULK_IMAGES
    ? `Select no more than ${MAX_BULK_IMAGES} items in one batch.`
    : null;
  return [
    {
      id: "edit-tags",
      label: "Edit tags",
      icon: "tag",
      group: "organize",
      hidden: surface !== "images" || !canEdit || bulkCapError !== null,
      ...(bulkCapError ? { disabledReason: bulkCapError } : {}),
    },
    { id: "edit-selected", label: "Edit selected", icon: "pencil", group: "organize", hidden: surface !== "video" || !canEdit },
    { id: "clear-selection", label: "Clear selection", icon: "close", group: "organize", hidden: false },
  ];
}

/** The same selection menu is used by a card's More button and its context menu. */
export function availableSelectionActions(
  actions: readonly MediaTileAction[],
  locked: boolean,
  busy: boolean,
  allowedWhileLocked?: MediaTileActionId,
): MediaTileAction[] {
  if (busy) return [];
  return locked
    ? actions.filter(action => action.id === "clear-selection" || action.id === allowedWhileLocked)
    : [...actions];
}

/** The bar's actions: every action the menu shows, plus any it hides only because of a cap. */
export function mediaBarActions(actions: readonly MediaTileAction[]): MediaTileAction[] {
  return actions.filter((action) => !action.hidden || action.disabledReason);
}

/** A multi-selection menu is titled "N items"; one card's menu is titled with its name. */
export function mediaMenuTitle(count: number, name: string): string {
  return count > 1 ? `${count} items` : name;
}

/** Menu items for the Menu and ContextMenu primitives; each calls back with its action id. */
export function mediaMenuItems(actions: readonly MediaTileAction[], onSelect: (id: MediaTileActionId) => void): MenuItem[] {
  return actions.map((action) => ({
    key: action.id,
    label: action.label,
    icon: action.icon,
    group: action.group,
    ...(action.danger ? { danger: true } : {}),
    ...(action.hidden ? { hidden: true } : {}),
    onSelect: () => onSelect(action.id),
  }));
}
