import type { IconName } from "../components/ui/Icon";
import type { MenuItem } from "../components/ui/Menu";
import type { IconControlId } from "./icon-control-registry";
import { collectionCapError } from "./media-selection";
import { MAX_BULK_IMAGES } from "./source-media-bulk";

// The actions for one media card or a multi-selection (HIG). One list feeds the card's quick-action cluster, the selection bar and
// the context menu, so the menu mirrors every visible action. Unavailable actions carry
// hidden: true and the Menu leaves them out (hidden, not dimmed).
//
// Card menu order: Open details, Favorite, Add to collection, Select,
// Copy link, then Delete last in danger ink. Video has no Copy link; "Show videos uploaded
// by NAME" takes its place. Images and Videos support batch favorites
// for selections of up to 100 items.
//
// Quick Look follows Open details on both surfaces, with Open full size after it for images.
// Each is offered only when the host passes its flag,
// so a surface that has not wired the action never shows a menu item that does nothing.

export type MediaTileSurface = "images" | "video";
export type MediaTileActionId =
  | "open"
  | "quick-look"
  | "open-full-size"
  | "favorite"
  | "favorite-add"
  | "favorite-remove"
  | "collect"
  | "remove-collection"
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
  favorite: boolean;
  /** False for an archived or unavailable item; favorites are hidden for it. */
  available: boolean;
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
    {
      id: "favorite",
      label: input.favorite ? "Remove from favorites" : "Add to favorites",
      icon: "heart",
      group: "organize",
      hidden: !input.available,
      registryId: "media-favorite",
    },
    { id: "collect", label: "Add to collection", icon: "folder-plus", group: "organize", hidden: false, registryId: "media-collect" },
    { id: "select", label: input.selected ? "Deselect" : "Select", icon: "check-square", group: "organize", hidden: false, registryId: "media-select" },
    video
      ? { id: "uploader", label: `Show videos uploaded by ${input.uploader?.name ?? ""}`, icon: "users", group: "organize", hidden: !uploader }
      : { id: "copy-link", label: "Copy link", icon: "link", group: "organize", hidden: false },
    ...(input.copyFileAddress && !video ? [{ id: "copy-file-address" as const, label: "Copy file address", icon: "link" as const, group: "organize" as const, hidden: false }] : []),
    { id: "delete", label: "Delete from library", icon: "trash", group: "danger", hidden: !input.canDelete, danger: true },
  ];
}

export interface MediaFavoriteTileActionInput {
  available: boolean;
  selected: boolean;
  video: boolean;
}

/** One Favorites card never offers an add-back action after removal. */
export function mediaFavoriteTileActions(
  input: MediaFavoriteTileActionInput,
): MediaTileAction[] {
  const remove: MediaTileAction = {
    id: "favorite-remove",
    label: "Remove from favorites",
    icon: "heart-off",
    group: "organize",
    hidden: false,
    registryId: "media-favorite",
  };
  const select: MediaTileAction = {
    id: "select",
    label: input.selected ? "Deselect" : "Select",
    icon: "check-square",
    group: "organize",
    hidden: false,
    registryId: "media-select",
  };
  if (!input.available) return [remove, select];
  return [
    {
      id: "open",
      label: input.video ? "Open and play" : "Open details",
      icon: input.video ? "play" : "eye",
      group: "open",
      hidden: false,
    },
    { id: "quick-look", label: "Quick Look", icon: "image", group: "open", hidden: false },
    { ...remove, id: "favorite" },
    {
      id: "collect",
      label: "Add to collection",
      icon: "folder-plus",
      group: "organize",
      hidden: false,
      registryId: "media-collect",
    },
    select,
  ];
}

export interface MediaCollectionTileActionInput {
  available: boolean;
  selected: boolean;
  video: boolean;
}

/** Collection items can be opened or removed, but never added back to their current collection. */
export function mediaCollectionTileActions(
  input: MediaCollectionTileActionInput,
): MediaTileAction[] {
  const remove: MediaTileAction = {
    id: "remove-collection",
    label: "Remove from collection",
    icon: "remove",
    group: "organize",
    hidden: false,
  };
  const select: MediaTileAction = {
    id: "select",
    label: input.selected ? "Deselect" : "Select",
    icon: "check-square",
    group: "organize",
    hidden: false,
    registryId: "media-select",
  };
  if (!input.available) return [remove, select];
  return [
    {
      id: "open",
      label: input.video ? "Open and play" : "Open details",
      icon: input.video ? "play" : "eye",
      group: "open",
      hidden: false,
    },
    { id: "quick-look", label: "Quick Look", icon: "image", group: "open", hidden: false },
    remove,
    select,
  ];
}

/**
 * A menu's actions while the favorite state is unknown or saving: Favorite is left out, since
 * choosing it could do nothing or send a second write. The card's heart stays and says why.
 */
export function settledMenuActions(actions: MediaTileAction[], favoriteSettled: boolean): MediaTileAction[] {
  return favoriteSettled ? actions : actions.filter((action) => action.id !== "favorite");
}

/**
 * A menu's actions while details or an upload hold unsaved work: only Open details stays, which
 * the leave prompt then guards. Selecting, favoriting, collecting, copying and deleting wait
 * until the form is saved or discarded (the images page's dirty-form guard).
 */
export function lockedMenuActions(actions: MediaTileAction[], locked: boolean): MediaTileAction[] {
  return locked ? actions.filter((action) => action.id === "open") : actions;
}

/** The card's always-visible quick actions: the heart and the folder. More opens the menu. */
export function mediaClusterActions(actions: readonly MediaTileAction[]): MediaTileAction[] {
  return actions.filter((action) => !action.hidden && (action.id === "favorite" || action.id === "collect"));
}

/**
 * The menu for a multi-selection, which is also the selection bar's action set. Images:
 * Add to favorites and Remove from favorites (1–100 items), Add to collection and, when
 * the role can edit, Edit tags. Video: The same favorite actions, Add to collection and Edit
 * selected. Both: Clear selection. Bulk mode opens only from Edit tags or Edit selected.
 */
export function mediaSelectionActions({ surface, count, canEdit }: { surface: MediaTileSurface; count: number; canEdit: boolean }): MediaTileAction[] {
  const capError = collectionCapError(count, surface === "video" ? "videos" : "items");
  const bulkCapError = surface === "images" && count > MAX_BULK_IMAGES
    ? `Select no more than ${MAX_BULK_IMAGES} items in one batch.`
    : null;
  const favoriteActions: MediaTileAction[] = count >= 1 && count <= 100
    ? [
        { id: "favorite-add", label: "Add to favorites", icon: "heart", group: "organize", hidden: false },
        { id: "favorite-remove", label: "Remove from favorites", icon: "heart-off", group: "organize", hidden: false },
      ]
    : [];
  return [
    ...favoriteActions,
    {
      id: "collect",
      label: "Add to collection",
      icon: "folder-plus",
      group: "organize",
      hidden: capError !== null,
      ...(capError ? { disabledReason: capError } : {}),
    },
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

export interface MediaFavoriteSelectionActionInput {
  count: number;
  allAvailable: boolean;
}

/** Selection actions for mixed Favorites, including unavailable saved references. */
export function mediaFavoriteSelectionActions({
  count,
  allAvailable,
}: MediaFavoriteSelectionActionInput): MediaTileAction[] {
  const favoriteCapError = count > 100
    ? "Select no more than 100 favorites in one batch."
    : null;
  const collectionError = collectionCapError(count, "items") ?? (
    allAvailable ? null : "Unavailable favorites cannot be added to a collection."
  );
  return [
    {
      id: "favorite-remove",
      label: "Remove from favorites",
      icon: "heart-off",
      group: "organize",
      hidden: count < 1 || favoriteCapError !== null,
      ...(favoriteCapError ? { disabledReason: favoriteCapError } : {}),
    },
    {
      id: "collect",
      label: "Add to collection",
      icon: "folder-plus",
      group: "organize",
      hidden: count < 1 || collectionError !== null,
      ...(collectionError ? { disabledReason: collectionError } : {}),
    },
    {
      id: "clear-selection",
      label: "Clear selection",
      icon: "close",
      group: "organize",
      hidden: false,
    },
  ];
}

/** One collection membership write removes at most 30 full media references. */
export function mediaCollectionSelectionActions(count: number): MediaTileAction[] {
  const capError = collectionCapError(count, "items");
  return [
    {
      id: "remove-collection",
      label: "Remove from collection",
      icon: "remove",
      group: "organize",
      hidden: count < 1 || capError !== null,
      ...(capError ? { disabledReason: capError } : {}),
    },
    {
      id: "clear-selection",
      label: "Clear selection",
      icon: "close",
      group: "organize",
      hidden: false,
    },
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
