import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { useSearchParams } from "react-router";
import type { Principal } from "../../../packages/content-core/src/rbac";
import { Checkbox } from "../components/ui/Checkbox";
import { Icon } from "../components/ui/Icon";
import { ContextMenuArea, Menu } from "../components/ui/Menu";
import { Button, InlineMessage } from "../components/ui/Primitives";
import { MediaFullViewer, mediaFullViewerKey, type MediaFullViewerItem } from "../components/media/MediaFullViewer";
import { MediaGrid, type MediaGridHandle, type MediaGridItemContext } from "../components/media/MediaGrid";
import { ImageViewerBody, ImageViewerHeaderActions, imageViewerFacts } from "../components/media/ImageViewer";
import { MediaPaging } from "../components/media/MediaPaging";
import { QuickLook, type QuickLookItem } from "../components/media/QuickLook";
import { MediaRow, MediaRowHeader, mediaRowColumnStyle } from "../components/media/MediaRow";
import { SelectionBar } from "../components/media/SelectionBar";
import { MediaTile } from "../components/media/MediaTile";
import { MediaToolbar, type MediaToolbarSurfaceConfiguration } from "../components/media/MediaToolbar";
import { canManageMediaMetadata } from "../lib/access";
import {
  cmsDeleteMedia,
  cmsUpdateMediaMetadata,
  type MediaAssetSummary,
  type MediaCategoryDefinition,
} from "../lib/functions";
import type { MediaAssetRef } from "../lib/media-identity";
import {
  type MediaCollectionItem,
  type MediaCollectionSummary,
} from "../lib/media-collections";
import { MEDIA_CARD_FIELD_ORDER, listColumns } from "../lib/media-display";
import { selectionAnnouncement } from "../lib/media-filters";
import { quickLookImage, quickLookPoster } from "../lib/media-quick-look";
import { encodeCollectionsMediaLocation, parseCollectionsMediaLocation } from "../lib/media-query";
import {
  availableSelectionActions,
  lockedMenuActions,
  mediaBarActions,
  mediaCollectionSelectionActions,
  mediaCollectionTileActions,
  mediaMenuItems,
  mediaMenuTitle,
  type MediaTileAction,
  type MediaTileActionId,
} from "../lib/media-tile-actions";
import {
  emptySelection,
  pageSelectionState,
  refreshSelected,
  setPageSelection,
  type MediaSelection,
} from "../lib/media-selection";
import { invalidatePoster } from "../lib/media-session-cache";
import { readRecentTags, recordRecentTags } from "../lib/recent-media-tags";
import {
  listMediaSources,
  type MediaSourceSummary,
  type SourceMediaAssetSummary,
} from "../lib/source-media";
import { useMediaDisplay } from "../lib/use-media-display";
import { VideoViewerBody, sharePosterRead } from "./SourceMediaLibrary";
import { useSourceMediaAssetRefresh } from "../lib/use-source-media-asset-refresh";
import { LeaveGuardDialog } from "./LeaveGuardDialog";

type AvailableCollectionItem = Extract<MediaCollectionItem, { available: true }>;
type AvailableR2Item = AvailableCollectionItem & {
  ref: Extract<MediaAssetRef, { backend: "r2" }>;
  asset: MediaAssetSummary;
};
type AvailableS3Item = AvailableCollectionItem & {
  ref: Extract<MediaAssetRef, { backend: "s3" }>;
  asset: SourceMediaAssetSummary;
};
type CollectionGridItem = { id: string; item: MediaCollectionItem };

export function resolveCollectionAssetOverrides(
  items: readonly MediaCollectionItem[],
  overrides: ReadonlyMap<string, MediaAssetSummary | SourceMediaAssetSummary>,
): MediaCollectionItem[] {
  return items.map(item => {
    if (!item.available) return item;
    const replacement = overrides.get(mediaFullViewerKey(item.ref));
    return replacement && replacement.version > item.asset.version
      ? { ...item, asset: replacement } as MediaCollectionItem
      : item;
  });
}

type SourceState =
  | { status: "idle" | "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; sources: Map<string, MediaSourceSummary> };

export interface MediaCollectionItemsProps {
  collection: MediaCollectionSummary;
  items: readonly MediaCollectionItem[];
  principal: Principal;
  categories: readonly MediaCategoryDefinition[];
  getIdToken: () => Promise<string>;
  userId: string;
  removalPending?: boolean;
  removalError?: string;
  onRemoveMany: (refs: readonly MediaAssetRef[]) => Promise<boolean>;
  onLoadMore: () => void;
  loadingMore: boolean;
  nextCursor: string | null;
  pages: number;
  onReload: () => void;
  onViewerRiskChange?: (active: boolean) => void;
  onViewerSavingChange?: (saving: boolean) => void;
  /** Marks viewer Close and Step URL writes so the collection route does not prompt twice. */
  onInternalNavigation?: () => void;
  navigationBlocked?: boolean;
  onKeepNavigation: () => void;
  onDiscardNavigation: () => void;
}

function isR2Item(item: AvailableCollectionItem): item is AvailableR2Item {
  return item.ref.backend === "r2";
}

function isS3Item(item: AvailableCollectionItem): item is AvailableS3Item {
  return item.ref.backend === "s3";
}

function isAvailable(item: MediaCollectionItem): item is AvailableCollectionItem {
  return item.available;
}

function sameRef(left: MediaAssetRef, right: MediaAssetRef): boolean {
  return mediaFullViewerKey(left) === mediaFullViewerKey(right);
}

/** Shared cards, selection, paging and viewer bodies for one collection's loaded membership. */
export function MediaCollectionItems({
  categories,
  collection,
  getIdToken,
  items,
  loadingMore,
  nextCursor,
  onLoadMore,
  onInternalNavigation,
  onKeepNavigation,
  onDiscardNavigation,
  onReload,
  onRemoveMany,
  onViewerRiskChange,
  onViewerSavingChange,
  navigationBlocked = false,
  pages,
  principal,
  removalError = "",
  removalPending = false,
  userId,
}: MediaCollectionItemsProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const location = parseCollectionsMediaLocation(searchParams.toString());
  const routeKey = location.selectedRef ? mediaFullViewerKey(location.selectedRef) : null;
  const { display, setDisplay, resetDisplay } = useMediaDisplay("collections");
  const gridRef = useRef<MediaGridHandle>(null);
  const deleteConfirmationId = useId();
  const [selection, setSelection] = useState<MediaSelection<CollectionGridItem>>(emptySelection);
  const [hadSelection, setHadSelection] = useState(false);
  const [viewerOrder, setViewerOrder] = useState<AvailableCollectionItem[]>([]);
  const [quickLook, setQuickLook] = useState<{ order: AvailableCollectionItem[]; key: string }>();
  const [quickLookRead, setQuickLookRead] = useState<{ key: string; fileVersion?: string | null; url: string | null }>();
  const [sourceState, setSourceState] = useState<SourceState>({ status: "idle" });
  const [sourceAttempt, setSourceAttempt] = useState(0);
  const [viewerDirty, setViewerDirty] = useState(false);
  const [viewerSaving, setViewerSaving] = useState(false);
  const [recentTagsVersion, setRecentTagsVersion] = useState(0);
  const [assetOverrides, setAssetOverrides] = useState(new Map<string, MediaAssetSummary | SourceMediaAssetSummary>());

  const resolvedItems = useMemo(() => resolveCollectionAssetOverrides(items, assetOverrides), [assetOverrides, items]);
  const gridItems = useMemo<CollectionGridItem[]>(
    () => resolvedItems.map(item => ({ id: mediaFullViewerKey(item.ref), item })),
    [resolvedItems],
  );
  const availableItems = useMemo(() => resolvedItems.filter(isAvailable), [resolvedItems]);
  const activeItem = routeKey
    ? viewerOrder.find(item => mediaFullViewerKey(item.ref) === routeKey)
    : undefined;
  const pageState = pageSelectionState(selection.items, gridItems);
  const offPage = selection.items.filter(selected => !gridItems.some(item => item.id === selected.id)).length;
  if (selection.items.length > 0 && !hadSelection) setHadSelection(true);
  const selectionStatus = selectionAnnouncement(selection.items.length, hadSelection ? 1 : 0)
    + (offPage ? `, ${offPage} from other loaded pages` : "")
    + (selection.items.length === 30 ? ". Limit of 30 reached" : "");
  const selectionActions = mediaCollectionSelectionActions(selection.items.length).map(action => (
    collection.lifecycle === "archived" && action.id === "remove-collection"
      ? { ...action, hidden: true, disabledReason: "Restore this collection before changing its items." }
      : action
  ));
  const actionsDisabled = removalPending || viewerDirty || viewerSaving;

  function writeOpened(ref: MediaAssetRef | null) {
    const next = encodeCollectionsMediaLocation(location.show, location.scope, ref);
    if (next.toString() === searchParams.toString()) return;
    onInternalNavigation?.();
    setSearchParams(next);
  }

  useEffect(() => {
    setSelection(emptySelection());
    setViewerOrder([]);
    setQuickLook(undefined);
    setQuickLookRead(undefined);
    setSourceState({ status: "idle" });
    setViewerDirty(false);
    setViewerSaving(false);
    setAssetOverrides(new Map());
  }, [collection.id, userId]);

  useEffect(() => {
    if (pages === 1) setSelection(emptySelection());
  }, [items, pages]);

  useEffect(() => {
    setSelection(previous => refreshSelected(previous, gridItems));
    setViewerOrder(previous => previous.flatMap(old => {
      const refreshed = availableItems.find(item => sameRef(item.ref, old.ref));
      return refreshed ? [refreshed] : [];
    }));
  }, [availableItems, gridItems]); // A newer server version replaces a saved local override after reload.

  useEffect(() => {
    if (!routeKey) return;
    const matching = availableItems.find(item => mediaFullViewerKey(item.ref) === routeKey);
    if (matching) setViewerOrder(previous => previous.some(item => sameRef(item.ref, matching.ref))
      ? previous
      : availableItems);
  }, [availableItems, routeKey]);

  useEffect(() => {
    onViewerRiskChange?.(viewerDirty || viewerSaving);
    return () => onViewerRiskChange?.(false);
  }, [onViewerRiskChange, viewerDirty, viewerSaving]);

  useEffect(() => {
    onViewerSavingChange?.(viewerSaving);
    return () => onViewerSavingChange?.(false);
  }, [onViewerSavingChange, viewerSaving]);

  const activeVideo = Boolean(activeItem && isS3Item(activeItem));
  useEffect(() => {
    if (!activeVideo) return;
    let current = true;
    setSourceState({ status: "loading" });
    void getIdToken().then(token => listMediaSources(token)).then(result => {
      if (current) setSourceState({ status: "ready", sources: new Map(result.sources.map(source => [source.id, source])) });
    }).catch(() => {
      if (current) setSourceState({ status: "error", message: "Video source permissions could not be loaded." });
    });
    return () => { current = false; };
  }, [activeVideo, collection.id, getIdToken, sourceAttempt, userId]);

  const quickLookRecord = quickLook?.order.find(item => mediaFullViewerKey(item.ref) === quickLook.key);
  useSourceMediaAssetRefresh({ asset: quickLookRecord && isS3Item(quickLookRecord) ? quickLookRecord.asset : undefined,
    getIdToken, onUpdated: fresh => { if (quickLookRecord && isS3Item(quickLookRecord)) replaceAsset(quickLookRecord.ref, fresh); } });
  let quickLookItem: QuickLookItem | undefined;
  if (quickLookRecord) {
    const id = mediaFullViewerKey(quickLookRecord.ref);
    if (isS3Item(quickLookRecord)) {
      quickLookItem = {
        id,
        name: quickLookRecord.asset.name,
        kind: "video",
        previewUrl: quickLookRead?.key === id && quickLookRead.fileVersion === quickLookRecord.asset.fileVersion ? quickLookRead.url : null,
      };
    } else {
      const preview = quickLookImage(quickLookRecord.asset as MediaAssetSummary);
      quickLookItem = quickLookRecord.asset.kind === "audio" ? { id, name: quickLookRecord.asset.name, kind: "audio", audio: quickLookRecord.asset } : preview.kind === "image"
        ? { id, name: quickLookRecord.asset.name, kind: "image", previewUrl: preview.url, alt: preview.alt }
        : { id, name: quickLookRecord.asset.name, kind: "document", originalUrl: (quickLookRecord.asset as MediaAssetSummary).url };
    }
  }

  useEffect(() => {
    if (!quickLookRecord || !isS3Item(quickLookRecord)) return;
    const key = mediaFullViewerKey(quickLookRecord.ref);
    const poster = quickLookPoster(quickLookRecord.asset);
    setQuickLookRead({ key, fileVersion: quickLookRecord.asset.fileVersion, url: poster.url });
    if (!poster.read) return;
    let current = true;
    const read = sharePosterRead(quickLookRecord.asset, getIdToken);
    void read.promise.then(result => {
      if (current && result && "url" in result) setQuickLookRead({ key, fileVersion: quickLookRecord.asset.fileVersion, url: result.url });
    });
    return () => { current = false; read.release(); };
  }, [getIdToken, quickLookRecord]);

  function openViewer(item: AvailableCollectionItem) {
    setViewerOrder(availableItems);
    writeOpened(item.ref);
  }

  function closeViewer() {
    setViewerOrder([]);
    writeOpened(null);
  }

  function openQuickLook(item: AvailableCollectionItem) {
    setQuickLook({ order: availableItems, key: mediaFullViewerKey(item.ref) });
  }

  function closeQuickLook(restoreFocus = true) {
    const key = quickLook?.key;
    setQuickLook(undefined);
    if (restoreFocus && key) requestAnimationFrame(() => gridRef.current?.focusItemById(key));
  }

  function stepQuickLook(direction: "previous" | "next") {
    setQuickLook(previous => {
      if (!previous) return previous;
      const index = previous.order.findIndex(item => mediaFullViewerKey(item.ref) === previous.key);
      const next = previous.order[index + (direction === "next" ? 1 : -1)];
      return next ? { ...previous, key: mediaFullViewerKey(next.ref) } : previous;
    });
  }

  function replaceAsset(ref: MediaAssetRef, asset: MediaAssetSummary | SourceMediaAssetSummary) {
    setQuickLook(previous => previous ? { ...previous, order: previous.order.map(item => sameRef(item.ref, ref)
      ? { ...item, asset } as AvailableCollectionItem : item) } : previous);
    const key = mediaFullViewerKey(ref);
    setAssetOverrides(previous => new Map(previous).set(key, asset));
    setViewerOrder(previous => previous.map(item => sameRef(item.ref, ref)
      ? { ...item, asset } as AvailableCollectionItem
      : item));
  }

  function removeFromViewer(ref: MediaAssetRef) {
    setViewerOrder(previous => previous.filter(item => !sameRef(item.ref, ref)));
    setQuickLook(previous => previous ? { ...previous, order: previous.order.filter(item => !sameRef(item.ref, ref)) } : previous);
    if (routeKey === mediaFullViewerKey(ref)) writeOpened(null);
    onReload();
  }

  async function removeMany(refs: readonly MediaAssetRef[]) {
    if (removalPending || collection.lifecycle === "archived" || refs.length < 1 || refs.length > 30) return;
    let removed = false;
    try {
      removed = await onRemoveMany(refs);
    } catch {
      return;
    }
    if (!removed) return;
    const keys = new Set(refs.map(mediaFullViewerKey));
    setSelection(previous => ({ ...previous, items: previous.items.filter(item => !keys.has(item.id)) }));
    setViewerOrder(previous => previous.filter(item => !keys.has(mediaFullViewerKey(item.ref))));
    setQuickLook(previous => previous ? { ...previous, order: previous.order.filter(item => !keys.has(mediaFullViewerKey(item.ref))) } : previous);
    if (routeKey && keys.has(routeKey)) writeOpened(null);
  }

  function clearSelection() {
    setSelection(emptySelection());
    requestAnimationFrame(() => {
      if (!gridRef.current?.focusLastCard()) document.getElementById("media-collection-items-title")?.focus();
    });
  }

  function onSelectionAction(id: MediaTileActionId) {
    if (id === "remove-collection") void removeMany(selection.items.map(item => item.item.ref));
    if (id === "clear-selection") clearSelection();
  }

  function tileActions(item: MediaCollectionItem, selected: boolean): MediaTileAction[] {
    const actions = mediaCollectionTileActions({
      available: item.available,
      selected,
      video: item.ref.backend === "s3",
    });
    return collection.lifecycle === "archived"
      ? actions.map(action => action.id === "remove-collection" ? { ...action, hidden: true } : action)
      : actions;
  }

  function itemAction(item: MediaCollectionItem, id: MediaTileActionId, toggleSelection?: () => void) {
    if (id === "remove-collection") void removeMany([item.ref]);
    if (id === "select") toggleSelection?.();
    if (!item.available) return;
    if (id === "open") openViewer(item);
    if (id === "quick-look") openQuickLook(item);
  }

  function contextMenu(
    item: MediaCollectionItem,
    context: MediaGridItemContext,
    children: ReactNode,
  ) {
    const multiple = context.selected && selection.items.length > 1;
    const actions = multiple
      ? availableSelectionActions(selectionActions, actionsDisabled, removalPending)
      : lockedMenuActions(tileActions(item, context.selected), actionsDisabled);
    return <ContextMenuArea
      items={mediaMenuItems(actions, multiple ? onSelectionAction : id => itemAction(item, id,
        () => context.onSelectChange(!context.selected, { shiftKey: false })))}
      label={mediaMenuTitle(multiple ? selection.items.length : 1, item.available ? item.asset.name : "Unavailable item")}
      returnFocusSelector="[data-media-open]">
      {children}
    </ContextMenuArea>;
  }

  function unavailableItem(record: CollectionGridItem, context: MediaGridItemContext) {
    const item = record.item;
    const actions = tileActions(item, context.selected);
    const selectionMenu = context.selected && selection.items.length > 1
      ? availableSelectionActions(selectionActions, actionsDisabled, removalPending)
      : actions;
    const name = "Unavailable item";
    if (display.layout === "list") {
      const track = <div className="media-row-track">
        <span className="media-row-mark-cell" role="gridcell"><Checkbox size="compact" className="media-row-mark" checked={context.selected} hideLabel
          label="Select unavailable collection item" disabled={actionsDisabled} tabIndex={context.tabbable ? undefined : -1}
          onChange={event => context.onSelectChange(event.currentTarget.checked, { shiftKey: false })} /></span>
        <span className="media-row-thumb" role="gridcell"><Icon name={item.ref.backend === "s3" ? "video" : "file"} /></span>
        <span className="media-row-main" role="gridcell"><button className="media-row-open" type="button"
          data-media-open="" tabIndex={context.tabbable ? 0 : -1}
          onClick={() => context.onSelectChange(!context.selected, { shiftKey: false })}>{name}</button>
          <span className="media-row-sub">This collection reference is no longer available to your account.</span>
        </span>
        {listColumns(display.fields).filter(column => column !== "name").map(column => <span key={column}
          className={`media-row-cell ${["type", "category", "dimensions", "tags"].includes(column) ? "media-row-cell-wide" : ""}`}
          data-column={column} role="gridcell"><span aria-hidden="true">—</span><span className="sr-only">None</span></span>)}
        <span className="media-row-actions" role="gridcell"><Menu className="media-row-action media-row-more" items={mediaMenuItems(selectionMenu,
          context.selected && selection.items.length > 1 ? onSelectionAction : id => itemAction(item, id,
            () => context.onSelectChange(!context.selected, { shiftKey: false })))}
          label={`More actions: ${context.selected && selection.items.length > 1 ? `${selection.items.length} items` : name}`}
          tabIndex={context.tabbable ? undefined : -1} /></span>
      </div>;
      return <div className="media-row" role="row" aria-selected={context.selected}
        data-selected={context.selected || undefined} data-unavailable="true" style={mediaRowColumnStyle(display.fields)}>
        {contextMenu(item, context, track)}
      </div>;
    }
    const tile = <div className="media-tile" data-selected={context.selected || undefined} data-unavailable="true">
      <div className="media-tile-caption"><h3 className="media-tile-name"><button className="media-tile-open" type="button"
        data-media-open="" tabIndex={context.tabbable ? 0 : -1}
        onClick={() => context.onSelectChange(!context.selected, { shiftKey: false })}>{name}</button></h3>
        <p>This collection reference is no longer available to your account.</p></div>
      <div className="media-tile-thumb"><span className="media-tile-placeholder" aria-hidden="true"><Icon name={item.ref.backend === "s3" ? "video" : "file"} /></span>
        <Checkbox checked={context.selected} className="media-tile-mark" hideLabel label="Select unavailable collection item"
          disabled={actionsDisabled} tabIndex={context.tabbable ? undefined : -1}
          onChange={event => context.onSelectChange(event.currentTarget.checked, { shiftKey: false })} />
        <div className="media-tile-actions"><Button variant="ghost" className="media-tile-action"
          aria-label="Remove unavailable item from collection"
          disabled={actionsDisabled || collection.lifecycle === "archived"} tabIndex={context.tabbable ? undefined : -1}
          onClick={() => void removeMany([item.ref])}><Icon name="remove" /></Button><Menu items={mediaMenuItems(selectionMenu,
          context.selected && selection.items.length > 1 ? onSelectionAction : id => itemAction(item, id,
            () => context.onSelectChange(!context.selected, { shiftKey: false })))}
          label={`More actions: ${context.selected && selection.items.length > 1 ? `${selection.items.length} items` : name}`}
          tabIndex={context.tabbable ? undefined : -1} /></div>
      </div>
    </div>;
    return contextMenu(item, context, tile);
  }

  function renderItem(record: CollectionGridItem, context: MediaGridItemContext) {
    const item = record.item;
    if (!item.available) return unavailableItem(record, context);
    const actions = tileActions(item, context.selected);
    const selectionMenu = context.selected && selection.items.length > 1 ? {
      count: selection.items.length,
      actions: availableSelectionActions(selectionActions, actionsDisabled, removalPending),
      onAction: onSelectionAction,
    } : undefined;
    const shared = {
      actionsDisabled,
      actionOverride: actions,
      available: true,
      canDelete: false,
      favorite: false,
      onAction: (id: MediaTileActionId) => itemAction(item, id,
        () => context.onSelectChange(!context.selected, { shiftKey: false })),
      onOpen: () => openViewer(item),
      onSelectChange: context.onSelectChange,
      opened: routeKey === record.id,
      selected: context.selected,
      selectionMenu,
      selectionMode: context.selectionMode,
      tabbable: context.tabbable,
    };
    if (isS3Item(item)) {
      const thumbnail = <span className="media-collection-video-preview" aria-hidden="true"><Icon name="video" /></span>;
      const fields = { type: display.fields.type, size: display.fields.size, duration: false, rights: false,
        updated: display.fields.updated, tags: display.fields.tags, uploader: false };
      if (display.layout === "list") {
        return <MediaRow {...shared} surface="video" asset={item.asset} fields={fields} mixedFields={display.fields}
          thumbnail={thumbnail} wrapCells={(cells: ReactElement) => contextMenu(item, context, cells)} />;
      }
      return contextMenu(item, context,
        <MediaTile {...shared} surface="video" asset={item.asset} fields={fields} thumbnail={thumbnail} />);
    } else {
      const asset = item.asset as MediaAssetSummary;
      const categoryLabel = (id: string) => categories.find(category => category.id === id)?.label ?? id;
      if (display.layout === "list") {
        return <MediaRow {...shared} surface="images" asset={asset} fields={display.fields} categoryLabel={categoryLabel}
          wrapCells={(cells: ReactElement) => contextMenu(item, context, cells)} />;
      }
      return contextMenu(item, context,
        <MediaTile {...shared} surface="images" asset={asset} fields={display.fields} categoryLabel={categoryLabel}
          getAudioToken={getIdToken} />);
    }
  }

  const toolbar: MediaToolbarSurfaceConfiguration = {
    surface: "collections",
    view: "items",
    search: null,
    filter: null,
    sort: null,
    display: {
      rows: [
        { kind: "segmented", id: "layout", label: "Layout", value: display.layout,
          options: [{ value: "grid", label: "Grid", icon: "grid" }, { value: "list", label: "List", icon: "columns" }],
          onChange: value => setDisplay({ ...display, layout: value as typeof display.layout }) },
        { kind: "segmented", id: "thumbnail", label: "Thumbnails", value: display.thumbnail,
          options: [{ value: "s", label: "Small" }, { value: "m", label: "Medium" }, { value: "l", label: "Large" }],
          onChange: value => setDisplay({ ...display, thumbnail: value as typeof display.thumbnail }) },
        { kind: "select", id: "density", label: "Density", value: display.density,
          options: [{ value: "app", label: "Use app setting", appSetting: true }, { value: "compact", label: "Compact" },
            { value: "comfortable", label: "Comfortable" }, { value: "loose", label: "Loose" }],
          onChange: value => setDisplay({ ...display, density: value as typeof display.density }) },
        { kind: "fields", id: "fields", label: "Show on cards and in list columns",
          options: MEDIA_CARD_FIELD_ORDER.map(value => ({ value, label: value.charAt(0).toUpperCase() + value.slice(1), selected: display.fields[value] })),
          onChange: value => { const field = value as keyof typeof display.fields;
            setDisplay({ ...display, fields: { ...display.fields, [field]: !display.fields[field] } }); } },
      ],
      onReset: resetDisplay,
    },
    upload: null,
    moreItems: [{ key: "select-page", label: "Select this page", icon: "check-square",
      onSelect: () => setSelection(previous => setPageSelection(previous, gridItems, true,
        { cap: { max: 30, message: "Select no more than 30 collection items." } })) }],
    shortcuts: null,
  };

  const viewerItems = viewerOrder.flatMap<MediaFullViewerItem>(item => {
    if (isS3Item(item)) return [{ ref: item.ref, kind: "video" as const, name: item.asset.name }];
    if (!isR2Item(item)) return [];
    return [{
      ref: item.ref,
      kind: item.asset.kind,
      name: item.asset.name,
      facts: imageViewerFacts(item.asset),
      actions: <ImageViewerHeaderActions getIdToken={getIdToken} asset={item.asset} />,
    }];
  });
  const navigationPrompt = navigationBlocked && !viewerSaving
    ? <LeaveGuardDialog onCancel={onKeepNavigation} onConfirm={onDiscardNavigation} />
    : null;
  const pageImageTags = useMemo(() => resolvedItems.flatMap(item => item.available && item.ref.backend === "r2"
    ? (item.asset as MediaAssetSummary).tags : []), [resolvedItems]);
  const pageVideoTags = useMemo(() => resolvedItems.flatMap(item => item.available && item.ref.backend === "s3"
    ? (item.asset as SourceMediaAssetSummary).tags : []), [resolvedItems]);
  const recentImageTags = useMemo(() => readRecentTags("images", userId), [recentTagsVersion, userId]);
  const recentVideoTags = useMemo(() => readRecentTags("video", userId), [recentTagsVersion, userId]);

  return <section className="media-collection-items-shell" data-density={display.density === "app" ? undefined : display.density}
    data-thumbnail={display.thumbnail} aria-label="Collection items">
    {removalError ? <InlineMessage tone="error" title="Collection item was not removed">{removalError}</InlineMessage> : null}
    {sourceState.status === "error" ? <InlineMessage tone="error" title="Video actions need attention">
      {sourceState.message} The video stays read-only until its source permissions load.
      <Button onClick={() => setSourceAttempt(value => value + 1)}>Try again</Button>
    </InlineMessage> : null}
    <MediaToolbar configuration={toolbar} />
    <p className="sr-only media-selection-status" role="status">{selectionStatus}</p>
    <MediaGrid label="Collection media" className="media-collection-shared-grid" items={gridItems} layout={display.layout}
      selection={selection} onSelectionChange={setSelection} handleRef={gridRef}
      rules={{ cap: { max: 30, message: "Select no more than 30 collection items." } }}
      header={display.layout === "list" ? <MediaRowHeader fields={display.fields} pageSelection={{ state: pageState,
        disabled: actionsDisabled, onChange: checked => setSelection(previous => setPageSelection(previous, gridItems, checked,
          { cap: { max: 30, message: "Select no more than 30 collection items." } })) }} /> : undefined}
      renderItem={renderItem}
      onOpen={record => record.item.available ? openViewer(record.item) : setSelection(previous => setPageSelection(previous, [record],
        !previous.items.some(item => item.id === record.id), { cap: { max: 30, message: "Select no more than 30 collection items." } }))}
      onQuickLook={record => { if (record.item.available) openQuickLook(record.item); }}
      onEscape={() => setSelection(emptySelection())} />

    {nextCursor || pages > 1 ? <MediaPaging mode="load-more" label="Collection item pages" loaded={gridItems.length}
      total={collection.itemCount} hasMore={Boolean(nextCursor)} loading={loadingMore} onMore={onLoadMore} /> : null}

    <SelectionBar label="Collection selection" count={selection.items.length} offPage={offPage} cap={30}
      info="Selection carries across loaded collection pages." pageState={pageState} pageDisabled={actionsDisabled}
      onPageChange={checked => setSelection(previous => setPageSelection(previous, gridItems, checked,
        { cap: { max: 30, message: "Select no more than 30 collection items." } }))}
      actions={mediaBarActions(selectionActions)} actionsDisabled={actionsDisabled}
      onAction={onSelectionAction} onClear={clearSelection} error={selection.error} />

    {quickLook && quickLookRecord && quickLookItem ? <QuickLook getIdToken={getIdToken} item={quickLookItem}
      position={quickLook.order.findIndex(item => mediaFullViewerKey(item.ref) === quickLook.key) + 1}
      count={quickLook.order.length} onStep={stepQuickLook} onClose={closeQuickLook}
      onPreviewError={() => {
        if (isS3Item(quickLookRecord)) invalidatePoster(quickLookRecord.ref.sourceId, quickLookRecord.ref.id, quickLookRecord.asset.fileVersion);
      }} /> : null}

    {activeItem ? <MediaFullViewer activeRef={activeItem.ref} items={viewerItems}
      navigationBlocked={navigationBlocked}
      onClose={closeViewer}
      onStep={viewerItem => writeOpened(viewerItem.ref)}
      onDirtyChange={setViewerDirty} onSavingChange={setViewerSaving}
      focusItem={ref => gridRef.current?.focusItemById(mediaFullViewerKey(ref)) ?? false}
      focusFallback={() => document.getElementById("media-collection-items-title")?.focus()}
      renderBody={context => {
        const record = viewerOrder.find(item => sameRef(item.ref, context.item.ref));
        if (!record) return null;
        if (isR2Item(record)) {
          return <><ImageViewerBody getIdToken={getIdToken} key={mediaFullViewerKey(record.ref)} asset={record.asset}
            comparisonAssets={viewerOrder.filter(isR2Item).map(item => item.asset)}
            categories={categories} canEdit={canManageMediaMetadata(principal, record.asset.category)}
            deleteMedia={async asset => cmsDeleteMedia(await getIdToken(), asset)}
            saveMetadata={async (asset, metadata) => cmsUpdateMediaMetadata(await getIdToken(), asset, metadata)}
            closePrompt={context.dirtyPrompt} footerTarget={context.footerActionsTarget}
            onDeleted={() => removeFromViewer(record.ref)}
            onDirtyChange={context.onDirtyChange} onSavingChange={context.onSavingChange}
            onReload={onReload}
            onTagsSaved={tags => { recordRecentTags("images", tags, userId); setRecentTagsVersion(value => value + 1); }}
            pageTags={pageImageTags} recentTags={recentImageTags}
            onSaved={asset => replaceAsset(record.ref, asset)} />{navigationPrompt}</>;
        }
        if (!isS3Item(record)) return null;
        const source = sourceState.status === "ready" ? sourceState.sources.get(record.ref.sourceId) : undefined;
        return <><VideoViewerBody key={mediaFullViewerKey(record.ref)} principal={principal} asset={record.asset}
          sourceLabel={source?.label} getIdToken={getIdToken}
          canEditMetadata={source?.canEditMetadata === true}
          canReplace={source?.canReplace === true}
          canExportOrientation={source?.canExportOrientation === true}
          canRequestProduction={source?.canRequestProduction === true}
          canDelete={source?.canDelete === true} deleteConfirmationId={deleteConfirmationId}
          headerTarget={context.headerActionsTarget} factsTarget={context.headerFactsTarget}
          closePrompt={context.dirtyPrompt} footerTarget={context.footerActionsTarget} pageTags={pageVideoTags} recentTags={recentVideoTags}
          navigationBlocked={false} onKeepNavigation={onKeepNavigation} onDiscardNavigation={onDiscardNavigation}
          onDeleted={() => removeFromViewer(record.ref)}
          onDirtyChange={context.onDirtyChange} onSavingChange={context.onSavingChange}
          onBusyChange={context.onBusyChange}
          onTagsSaved={tags => { recordRecentTags("video", tags, userId); setRecentTagsVersion(value => value + 1); }}
          onUpdated={asset => replaceAsset(record.ref, asset)} />{navigationPrompt}</>;
      }} /> : null}
  </section>;
}
