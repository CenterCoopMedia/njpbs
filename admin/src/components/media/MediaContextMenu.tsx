import type { ReactNode } from "react";
import {
  availableSelectionActions,
  lockedMenuActions,
  mediaMenuItems,
  mediaMenuTitle,
  mediaSelectionActions,
  mediaTileActions,
  settledMenuActions,
  type MediaTileAction,
  type MediaTileActionId,
  type MediaTileActionInput,
} from "../../lib/media-tile-actions";
import { ContextMenuArea } from "../ui/Menu";

// The card's context menu. Right-click,
// Shift+F10 and the Menu key open the same items as the card's More (Delete last in danger ink). On a selected card in a multi-selection, the menu is the
// selection's actions, titled "N items". Image and video selections include batch favorites. The items come
// from props when the menu opens; opening it makes no request. Focus returns to the card.

export interface MediaContextMenuProps {
  /** The card's facts, as MediaTile computes its own menu from. */
  tile: MediaTileActionInput;
  /** How many items are selected on this surface, on or off the page. */
  selectionCount: number;
  /** False while the card's favorite state loads or saves; the menu then leaves Favorite out. */
  favoriteSettled?: boolean;
  /** True while details or an upload hold unsaved work: the menu offers only Open details. */
  actionsDisabled?: boolean;
  /** A selection transition that the caller guards before discarding dirty details. */
  allowSelectionActionWhileDisabled?: MediaTileActionId;
  /** An inspector batch or picker owns the selection until it closes. */
  selectionBusy?: boolean;
  /** Video only: the selection can open Edit selected. */
  canEditSelection?: boolean;
  /** A single card's action. */
  onAction: (id: MediaTileActionId) => void;
  /** A multi-selection action: collect, edit-selected, favorites, or clear-selection. */
  onSelectionAction: (id: MediaTileActionId) => void;
  /** The caller's selection actions. When omitted, the menu builds them from the tile surface. */
  selectionActions?: readonly MediaTileAction[];
  children: ReactNode;
}

export function MediaContextMenu({
  actionsDisabled = false,
  allowSelectionActionWhileDisabled,
  selectionBusy = false,
  canEditSelection = false,
  children,
  favoriteSettled = true,
  onAction,
  onSelectionAction,
  selectionActions: selectionActionsProp,
  selectionCount,
  tile,
}: MediaContextMenuProps) {
  const multiple = tile.selected && selectionCount > 1;
  const selectionActions = selectionActionsProp ?? mediaSelectionActions({ surface: tile.surface, count: selectionCount, canEdit: canEditSelection });
  const items = multiple
    ? mediaMenuItems(availableSelectionActions(selectionActions, actionsDisabled, selectionBusy, allowSelectionActionWhileDisabled), onSelectionAction)
    : mediaMenuItems(lockedMenuActions(settledMenuActions(mediaTileActions(tile), favoriteSettled), actionsDisabled), onAction);
  return (
    <ContextMenuArea
      items={items}
      label={mediaMenuTitle(multiple ? selectionCount : 1, tile.name)}
      returnFocusSelector="[data-media-open]"
    >
      {children}
    </ContextMenuArea>
  );
}
