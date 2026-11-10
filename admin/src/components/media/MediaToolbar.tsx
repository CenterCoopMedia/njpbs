import { WorkspaceBrowseToolbar } from "../WorkspaceActions";
import { ControlSizingProvider } from "../../context/ControlSizingContext";
import { useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type Ref, type RefObject } from "react";
import { useControlPresentation } from "../../context/ControlPresentationContext";
import type { ListMediaResponse, MediaKind } from "../../lib/functions";
import type { MediaDisplayPreferences } from "../../lib/media-display";
import {
  applyFilterDraft,
  categoryOptions,
  chooseTag,
  clearFilterChips,
  filterChips,
  pageTags,
  removeFilterChip,
  SORT_OPTIONS,
  sortDirectionLabel,
  sortDirections,
} from "../../lib/media-filters";
import type { MediaLocationState } from "../../lib/media-query";
import { UNIVERSAL_UPLOAD_ACCEPT } from "../../lib/upload-destination";
import { mediaShortcut } from "../../lib/media-search";
import { revealInlineFocus } from "../../lib/reveal-inline-focus";
import { useMediaFilterDraft } from "../../lib/use-media-filter-draft";
import {
  useSavedMediaViews,
  type SavedMediaViewsConfiguration,
} from "../../lib/use-saved-media-views";
import { ActionControl } from "../ui/ActionControl";
import { useMediaQuery } from "../ui/floating";
import { Icon } from "../ui/Icon";
import type { MenuItem } from "../ui/Menu";
import { OverflowToolbar, type OverflowToolbarItem } from "../ui/OverflowToolbar";
import { Button } from "../ui/Primitives";
import { MediaDisplayPopover, type MediaDisplayConfiguration } from "./MediaDisplayPopover";
import { MediaFilterChips, type MediaFilterChipModel, type MediaFilterEdit } from "./MediaFilterChips";
import {
  MediaFilterPopover,
  type MediaFilterProperty,
  type MediaFilterPropertyModel,
  type MediaFilterStart,
} from "./MediaFilterPopover";
import { MediaSearchField, type MediaSearchFieldProps } from "./MediaSearchField";
import { MediaShortcuts, selectPageShortcut } from "./MediaShortcuts";
import {
  MediaSortControl,
  type MediaSortControlModel,
  type MediaSortDirectionModel,
  type MediaSortModelChange,
} from "./MediaSortControl";
import "./MediaToolbar.css";

export type MediaToolbarPopover = "filter" | "sort" | "display" | "shortcuts";

export interface MediaToolbarHandle {
  /** The control that opened the current popover, or null when none is open. */
  popoverTrigger: () => HTMLElement | null;
}

export type MediaToolbarSavedViewsConfiguration = SavedMediaViewsConfiguration;

/** The existing Images API stays stable while later routes adopt a surface configuration. */
export interface MediaToolbarProps {
  audioLibrary?: boolean;
  state: MediaLocationState;
  onStateChange: (next: MediaLocationState) => void;
  result: Pick<ListMediaResponse, "records" | "kindCounts" | "categoryCounts"> | null;
  categoryLabel: (id: string) => string;
  categoryDescription?: (id: string) => string | undefined;
  categoryIds?: readonly string[];
  detailsDirty?: boolean;
  mayUpload?: boolean;
  uploadOpen?: boolean;
  uploadDraftCount?: number;
  onUpload?: () => void;
  onPickFiles?: (files: File[]) => void;
  uploadFocusRequest?: number;
  onSelectPage?: () => void;
  onOpenRecycleBin?: () => void;
  /** Lets the route capture its canonical URL before it clears the filters. */
  onClearAll?: () => void;
  display: MediaDisplayPreferences;
  onDisplayChange: (next: MediaDisplayPreferences) => void;
  onDisplayReset: () => void;
  savedViews?: MediaToolbarSavedViewsConfiguration;
  initialPopover?: MediaToolbarPopover;
  initialFilterProperty?: MediaFilterProperty;
  handleRef?: Ref<MediaToolbarHandle>;
}

export interface MediaToolbarSearchConfiguration extends MediaSearchFieldProps {}

export interface MediaToolbarFilterConfiguration {
  properties: readonly MediaFilterPropertyModel[];
  chips: readonly MediaFilterChipModel[];
  /** Visible guidance that applies to every property on this surface. */
  note?: string;
  onSelect: (property: string, value: string) => void;
  onEdit?: (edit: MediaFilterEdit) => void;
  onRemove: (chip: MediaFilterChipModel) => void;
  onClearAll: () => void;
  /** Lets a draft owner flush when Filter closes or another popover opens. */
  onOpenChange?: (open: boolean) => void;
}

export interface MediaToolbarSortConfiguration {
  model: MediaSortControlModel;
  onChange: (next: MediaSortModelChange) => void;
}

export interface MediaToolbarUploadConfiguration {
  buttonLabel: string;
  accessibleLabel: string;
  title: string;
  onUpload: () => void;
  onFiles?: (files: File[]) => void;
  accept?: string;
  multiple?: boolean;
  focusRequest?: number;
  lockedReason?: string;
}

/** Each route supplies its complete allowed control set; absent controls are explicit nulls. */
export type MediaToolbarSurfaceConfiguration =
  | {
    surface: "images";
    search: MediaToolbarSearchConfiguration;
    filter: MediaToolbarFilterConfiguration;
    sort: MediaToolbarSortConfiguration;
    display: MediaDisplayConfiguration;
    upload: MediaToolbarUploadConfiguration | null;
    moreItems: readonly MenuItem[];
    shortcuts: "images";
    onOpenRecycleBin?: () => void;
  }
  | {
    surface: "video";
    search: MediaToolbarSearchConfiguration;
    filter: MediaToolbarFilterConfiguration;
    sort: MediaToolbarSortConfiguration;
    display: MediaDisplayConfiguration;
    upload: MediaToolbarUploadConfiguration | null;
    moreItems: readonly MenuItem[];
    shortcuts: null;
  }
  | {
    surface: "favorites";
    search: null;
    filter: MediaToolbarFilterConfiguration;
    sort: null;
    display: MediaDisplayConfiguration;
    upload: null;
    moreItems: readonly MenuItem[];
    shortcuts: null;
  }
  | {
    surface: "collections";
    view: "list";
    search: null;
    filter: MediaToolbarFilterConfiguration;
    sort: null;
    display: null;
    upload: null;
    moreItems: readonly [];
    shortcuts: null;
  }
  | {
    surface: "collections";
    view: "items";
    search: null;
    filter: null;
    sort: null;
    display: MediaDisplayConfiguration;
    upload: null;
    moreItems: readonly MenuItem[];
    shortcuts: null;
  }
  | {
    surface: "voiceovers";
    search: MediaToolbarSearchConfiguration;
    filter: MediaToolbarFilterConfiguration;
    sort: null;
    display: null;
    upload: null;
    moreItems: readonly [];
    shortcuts: null;
  };

export interface ConfiguredMediaToolbarProps {
  configuration: MediaToolbarSurfaceConfiguration;
  /** Used by Images, Video, Favorites and the Collections list. */
  savedViews?: MediaToolbarSavedViewsConfiguration;
  initialPopover?: MediaToolbarPopover;
  initialFilterProperty?: MediaFilterProperty;
  handleRef?: Ref<MediaToolbarHandle>;
}

type MediaToolbarOwnerProps = ConfiguredMediaToolbarProps;

const NARROW_TOOLBAR_REM = 44;
const DISPLAY_TOOLTIP = "Change layout, size and fields · ⇧V";
const IMAGE_KINDS: readonly { value: MediaKind; label: string }[] = [
  { value: "image", label: "Images" },
  { value: "document", label: "Documents" },
];
const IMAGE_FIELDS = [
  ["type", "Type"],
  ["size", "Size"],
  ["dimensions", "Dimensions"],
  ["tags", "Tags"],
  ["category", "Category"],
  ["updated", "Updated"],
] as const;

/** The control when it is on the page, else the More trigger that holds it, else the toolbar. */
export function resolvePopoverAnchor(control: HTMLElement | null | undefined, toolbar: HTMLElement | null): HTMLElement | null {
  if (control?.isConnected) return control;
  return toolbar?.querySelector<HTMLElement>(".ui-overflow-toolbar-more") ?? toolbar;
}

function imageSortModel(state: MediaLocationState): MediaSortControlModel {
  return {
    value: state.query.sort,
    direction: state.query.direction,
    options: SORT_OPTIONS.map((option) => {
      const directions = sortDirections(option.value).map((direction) => ({
        value: direction,
        label: sortDirectionLabel(option.value, direction),
      })) as [MediaSortDirectionModel, ...MediaSortDirectionModel[]];
      return { ...option, directions };
    }),
  };
}

function imageDisplayConfiguration({
  direction,
  display,
  onDisplayChange,
  onReset,
  onSortChange,
  sort,
}: {
  direction: MediaLocationState["query"]["direction"];
  display: MediaDisplayPreferences;
  onDisplayChange: (next: MediaDisplayPreferences) => void;
  onReset: () => void;
  onSortChange: (next: MediaSortModelChange) => void;
  sort: MediaLocationState["query"]["sort"];
}): MediaDisplayConfiguration {
  return {
    rows: [
      {
        kind: "segmented", id: "layout", label: "Layout", value: display.layout,
        options: [{ value: "grid", label: "Grid", icon: "grid" }, { value: "list", label: "List", icon: "columns" }],
        onChange: (layout) => onDisplayChange({ ...display, layout: layout as MediaDisplayPreferences["layout"] }),
      },
      {
        kind: "segmented", id: "thumbnail", label: "Thumbnails", value: display.thumbnail,
        options: [{ value: "s", label: "Small" }, { value: "m", label: "Medium" }, { value: "l", label: "Large" }],
        onChange: (thumbnail) => onDisplayChange({ ...display, thumbnail: thumbnail as MediaDisplayPreferences["thumbnail"] }),
      },
      {
        kind: "select", id: "density", label: "Density", value: display.density,
        options: [
          { value: "app", label: "Use app setting", appSetting: true },
          { value: "compact", label: "Compact" },
          { value: "comfortable", label: "Comfortable" },
          { value: "loose", label: "Loose" },
        ],
        onChange: (density) => onDisplayChange({ ...display, density: density as MediaDisplayPreferences["density"] }),
      },
      {
        kind: "select", id: "sort", label: "Sort by", value: sort,
        options: SORT_OPTIONS,
        onChange: (value) => onSortChange({ value, direction }),
      },
      {
        kind: "select", id: "direction", label: "Direction", value: direction,
        options: sortDirections(sort).map((value) => ({ value, label: sortDirectionLabel(sort, value) })),
        onChange: (nextDirection) => onSortChange({ value: sort, direction: nextDirection }),
      },
      {
        kind: "fields", id: "fields", label: "Show on cards and in list columns",
        options: [
          { value: "name", label: "Name", selected: true, disabled: true, note: "Always shown" },
          ...IMAGE_FIELDS.map(([value, label]) => ({ value, label, selected: display.fields[value] })),
        ],
        note: "The list always shows Updated, so it can sort by it.",
        onChange: (field) => {
          const key = field as keyof MediaDisplayPreferences["fields"];
          onDisplayChange({ ...display, fields: { ...display.fields, [key]: !display.fields[key] } });
        },
      },
      {
        kind: "select", id: "per-page", label: "Per page", value: "30",
        options: [{ value: "30", label: "30" }], disabled: true, note: "Set by the server",
      },
    ],
    onReset,
  };
}

function ImagesMediaToolbar(props: MediaToolbarProps) {
  const {
    categoryIds = [],
    categoryLabel,
    categoryDescription,
    detailsDirty = false,
    display,
    handleRef,
    initialFilterProperty,
    initialPopover,
    mayUpload = false,
    onDisplayChange,
    onDisplayReset,
    onClearAll,
    onPickFiles,
    onSelectPage,
    onStateChange,
    onUpload,
    result,
    state,
    uploadDraftCount,
    uploadFocusRequest,
    uploadOpen = false,
    savedViews,
  } = props;
  const stateRef = useRef(state);
  stateRef.current = state;
  const changeRef = useRef(onStateChange);
  changeRef.current = onStateChange;
  const change = (next: MediaLocationState) => {
    stateRef.current = next;
    changeRef.current(next);
  };
  const draft = useMediaFilterDraft({
    applied: { kinds: state.query.kinds, categories: state.query.categories },
    immediate: detailsDirty,
    onCommit: (next) => change(applyFilterDraft(stateRef.current, next)),
  });
  const search = (q: string) => change({ ...stateRef.current, query: { ...stateRef.current.query, q, page: 1 } });
  const changeSort = ({ value, direction }: MediaSortModelChange) => change({
    ...stateRef.current,
    query: {
      ...stateRef.current.query,
      sort: value as MediaLocationState["query"]["sort"],
      direction: direction as MediaLocationState["query"]["direction"],
      page: 1,
    },
  });
  const pickTag = (tag: string) => {
    draft.flush();
    change(chooseTag(stateRef.current, tag));
    document.querySelector<HTMLInputElement>(".media-search-field-input")?.focus();
  };
  const selectedCategories = [...new Set([...state.query.categories, ...draft.value.categories])];
  const properties: MediaFilterPropertyModel[] = [
    {
      id: "kind", label: "Type", picker: "options", appliedCount: draft.value.kinds.length,
      options: IMAGE_KINDS.map((entry) => ({
        ...entry,
        selected: draft.value.kinds.includes(entry.value),
        count: result?.kindCounts?.[entry.value],
      })),
    },
    {
      id: "category", label: "Category", picker: "options", appliedCount: draft.value.categories.length,
      options: categoryOptions(result, selectedCategories, categoryIds).map((value) => ({
        value,
        label: categoryLabel(value),
        description: categoryDescription?.(value),
        selected: draft.value.categories.includes(value),
        count: result?.categoryCounts ? result.categoryCounts[value] ?? 0 : undefined,
      })),
    },
    {
      id: "tag", label: "Tag", picker: "actions", hint: "A tag replaces the search text.",
      emptyLabel: "No tags on this page",
      options: pageTags(result?.records ?? []).map((value) => ({ value, label: value })),
    },
  ];
  const chips = filterChips(state.query, categoryLabel);
  const uploadDraftLabel = uploadDraftCount === undefined ? undefined : `Continue upload (${uploadDraftCount})`;
  const configuration: MediaToolbarSurfaceConfiguration = {
    surface: "images",
    search: {
      value: state.query.q,
      onCommit: search,
      onSubmit: search,
      locked: detailsDirty,
    },
    filter: {
      properties: props.audioLibrary ? properties.filter(property => property.id !== "kind") : properties,
      chips,
      onSelect: (property, value) => {
        if (property === "kind") draft.toggleKind(value as MediaKind);
        else if (property === "category") draft.toggleCategory(value);
        else if (property === "tag") pickTag(value);
      },
      onRemove: (chip) => {
        draft.reset();
        change(removeFilterChip(stateRef.current, chip as Parameters<typeof removeFilterChip>[1]));
      },
      onClearAll: () => {
        draft.reset();
        if (onClearAll) onClearAll();
        else change(clearFilterChips(stateRef.current));
      },
      onOpenChange: (open) => {
        if (!open) draft.flush();
      },
    },
    sort: { model: imageSortModel(state), onChange: changeSort },
    display: imageDisplayConfiguration({
      direction: state.query.direction,
      display,
      onDisplayChange,
      onReset: onDisplayReset,
      onSortChange: changeSort,
      sort: state.query.sort,
    }),
    upload: mayUpload && !uploadOpen ? {
      buttonLabel: uploadDraftLabel ?? "Upload",
      accessibleLabel: uploadDraftLabel ?? "Upload media",
      title: detailsDirty ? "Save or discard details first."
        : uploadDraftLabel ? "Continue this upload with its queued files and details."
        : props.audioLibrary ? "Upload WAV audio or videos"
          : "Upload images, PDFs, or videos",
      onUpload: () => onUpload?.(),
      onFiles: onPickFiles,
      accept: UNIVERSAL_UPLOAD_ACCEPT,
      multiple: true,
      focusRequest: uploadFocusRequest,
      lockedReason: detailsDirty ? "Save or discard details first." : undefined,
    } : null,
    moreItems: onSelectPage ? [{
      key: "select-page",
      label: "Select this page",
      icon: "check-square",
      group: "selection",
      shortcut: selectPageShortcut(),
      onSelect: onSelectPage,
    }] : [],
    shortcuts: "images",
    onOpenRecycleBin: props.onOpenRecycleBin,
  };
  return (
    <MediaToolbarOwner
      configuration={configuration}
      handleRef={handleRef}
      initialFilterProperty={initialFilterProperty}
      initialPopover={initialPopover}
      savedViews={savedViews}
    />
  );
}

// One owner composes the shared toolbar anatomy and popover/focus state for every surface.
function MediaToolbarOwner({
  configuration,
  handleRef,
  initialFilterProperty,
  initialPopover,
  savedViews,
}: MediaToolbarOwnerProps) {
  const { display: configuredDisplay, filter, search, sort, upload } = configuration;
  const savedViewsConfiguration = supportsSavedViews(configuration) ? savedViews : undefined;
  const savedViewsController = useSavedMediaViews(savedViewsConfiguration);
  const display = configuredDisplay ?? (savedViewsConfiguration ? { rows: [] } : null);
  const surface = mediaToolbarSurfaceRules(configuration);
  const shortcuts = surface.imageShortcuts;
  const phone = useMediaQuery("(max-width: 47.99rem)");
  const [narrow, setNarrow] = useState(false);
  const compact = phone || narrow;
  const presentation = useControlPresentation();
  const uploadNoteId = useId();
  const chromeRef = useRef<HTMLDivElement | null>(null);
  const [chromeElement, setChromeElement] = useState<HTMLDivElement | null>(null);
  const registerChrome = useCallback((element: HTMLDivElement | null) => {
    chromeRef.current = element;
    setChromeElement(element);
  }, []);
  const filterRef = useRef<HTMLButtonElement>(null);
  const displayRef = useRef<HTMLButtonElement>(null);
  const sortRef = useRef<HTMLButtonElement>(null);
  const uploadRef = useRef<HTMLButtonElement>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const chipAnchorRef = useRef<HTMLElement | null>(null);
  const validInitialPopover = initialPopover === "display" && !display
    ? null
    : initialPopover === "filter" && !filter
      ? null
      : initialPopover === "sort" && !sort
        ? null
        : initialPopover === "shortcuts" && !shortcuts
          ? null
          : initialPopover ?? null;
  const [popover, setPopover] = useState<MediaToolbarPopover | null>(validInitialPopover);
  const [filterStart, setFilterStart] = useState<MediaFilterStart | null>(
    validInitialPopover === "filter" && initialFilterProperty ? { property: initialFilterProperty } : null,
  );

  const show = (next: MediaToolbarPopover) => {
    if (popover === "filter" && next !== "filter") filter?.onOpenChange?.(false);
    setPopover(next);
  };
  const hide = (name: MediaToolbarPopover) => {
    if (name === "filter") filter?.onOpenChange?.(false);
    setPopover((current) => (current === name ? null : current));
  };
  const showRef = useRef(show);
  showRef.current = show;
  const popoverRef = useRef(popover);
  popoverRef.current = popover;

  const filterAnchor = useMemo<RefObject<HTMLElement | null>>(() => ({
    get current() {
      const chip = chipAnchorRef.current;
      return resolvePopoverAnchor(chip?.isConnected ? chip : filterRef.current, chromeRef.current);
    },
  }), []);
  const displayAnchor = useMemo<RefObject<HTMLElement | null>>(() => ({
    get current() {
      return resolvePopoverAnchor(displayRef.current, chromeRef.current);
    },
  }), []);
  const moreAnchor = useMemo<RefObject<HTMLElement | null>>(() => ({
    get current() {
      return resolvePopoverAnchor(null, chromeRef.current);
    },
  }), []);

  useImperativeHandle(handleRef, () => ({
    popoverTrigger: () => {
      switch (popoverRef.current) {
        case "filter": return filterAnchor.current;
        case "sort": return resolvePopoverAnchor(sortRef.current, chromeRef.current);
        case "display": return displayAnchor.current;
        case "shortcuts": return moreAnchor.current;
        default: return null;
      }
    },
  }), [displayAnchor, filterAnchor, moreAnchor]);

  useEffect(() => {
    if (!display) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (mediaShortcut(event) !== "open-display") return;
      event.preventDefault();
      showRef.current("display");
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [display]);

  useEffect(() => {
    if (!savedViewsConfiguration || (popover !== "filter" && popover !== "display")) return;
    void savedViewsController.load();
  }, [
    popover,
    savedViewsConfiguration?.surface,
    savedViewsConfiguration?.userId,
    savedViewsController.load,
  ]);

  useEffect(() => {
    if (upload?.focusRequest) uploadRef.current?.focus();
  }, [upload?.focusRequest]);

  useLayoutEffect(() => {
    const chrome = chromeElement;
    const host = chrome?.closest("section") ?? chrome?.parentElement;
    if (!chrome || !host) return;
    const inShell = Boolean(chrome.closest(".workspace-browse-toolbar"));
    const previous = host.style.getPropertyValue("--media-chrome-height");
    let written = "";
    let disposed = false;
    const row = chrome.querySelector(".ui-overflow-toolbar");
    const write = () => {
      if (disposed || !chrome.isConnected) return;
      const box = chrome.getBoundingClientRect();
      const rowBox = row?.getBoundingClientRect();
      const height = box.height || rowBox?.height || 0;
      if (!inShell) {
        written = `${Math.round(height)}px`;
        host.style.setProperty("--media-chrome-height", written);
      }
      const width = getComputedStyle(chrome).display === "contents" ? rowBox?.width ?? 0 : box.width;
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      setNarrow(width > 0 && width < NARROW_TOOLBAR_REM * rem);
      const secondary = chrome.querySelector<HTMLElement>(".media-toolbar-secondary");
      const focused = document.activeElement;
      if (secondary && focused instanceof Element && secondary.contains(focused)) revealInlineFocus(secondary, focused);
    };
    write();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(write) : null;
    observer?.observe(chrome);
    if (row) observer?.observe(row);
    return () => {
      disposed = true;
      observer?.disconnect();
      if (!inShell && written && host.style.getPropertyValue("--media-chrome-height") === written) {
        if (previous) host.style.setProperty("--media-chrome-height", previous);
        else host.style.removeProperty("--media-chrome-height");
      }
    };
  }, [chromeElement]);

  const count = filter?.chips.length ?? 0;
  const toggleFilter = () => {
    if (!filter) return;
    if (popover === "filter") {
      hide("filter");
      return;
    }
    chipAnchorRef.current = null;
    setFilterStart(null);
    filter.onOpenChange?.(true);
    show("filter");
  };
  const editChip = (edit: MediaFilterEdit) => {
    if (!filter) return;
    chipAnchorRef.current = edit.anchor;
    setFilterStart({ property: edit.field, value: edit.value });
    filter.onEdit?.(edit);
    filter.onOpenChange?.(true);
    show("filter");
  };
  const filterButton = filter ? (
    <Button
      aria-expanded={popover === "filter"}
      aria-haspopup="dialog"
      aria-label={count ? `Filter, ${count} applied` : undefined}
      className="media-toolbar-filter"
      onClick={toggleFilter}
      ref={filterRef}
      variant="secondary"
    >
      <Icon name="filter" />
      <span className="button-compact-label">Filter</span>
      {count ? <span aria-hidden="true" className="media-toolbar-count">{count}</span> : null}
    </Button>
  ) : null;
  const sortControl = sort ? (
    <MediaSortControl
      model={sort.model}
      onModelChange={sort.onChange}
      onOpenChange={(open) => (open ? show("sort") : hide("sort"))}
      open={popover === "sort"}
      ref={sortRef}
    />
  ) : null;
  const chipRow = filter ? (
    <MediaFilterChips
      chips={filter.chips}
      filterButtonRef={filterRef}
      onClearAll={filter.onClearAll}
      onEdit={editChip}
      onRemove={filter.onRemove}
      showClearAllWithOneChip={
        configuration.surface === "video" ||
        configuration.surface === "favorites" ||
        configuration.surface === "collections"
      }
    />
  ) : null;
  const displayItems: OverflowToolbarItem[] = display ? [{
    key: "display",
    priority: 1,
    zone: "trailing",
    node: (
      <ActionControl
        action="media-display"
        aria-expanded={popover === "display"}
        aria-haspopup="dialog"
        label="Display"
        onClick={() => (popover === "display" ? hide("display") : show("display"))}
        ref={displayRef}
        tooltipLabel={DISPLAY_TOOLTIP}
      />
    ),
    menuItem: { key: "display", label: "Display…", icon: "sliders", onSelect: () => show("display") },
  }] : [];
  const moreItems: MenuItem[] = surface.hideMoreItemsOnPhone && phone ? [] : [
    ...configuration.moreItems,
    ...(shortcuts ? [{
      key: "shortcuts",
      label: "Keyboard shortcuts",
      icon: "info" as const,
      group: "help",
      onSelect: () => show("shortcuts"),
    }] : []),
  ];
  if (configuration.surface === "images" && configuration.onOpenRecycleBin) {
    moreItems.push({
      key: "recycle-bin",
      label: "Recycle bin",
      icon: "trash",
      group: "navigation",
      onSelect: configuration.onOpenRecycleBin,
    });
  }
  const uploadControl = upload ? (
    <>
      {compact ? null : <span aria-hidden="true" className="media-toolbar-divider" />}
      {upload.onFiles ? (
        <input
          accept={upload.accept}
          hidden
          multiple={upload.multiple}
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = "";
            if (files.length > 0) upload.onFiles?.(files);
          }}
          ref={uploadInputRef}
          type="file"
        />
      ) : null}
      <Button
        aria-describedby={upload.lockedReason ? uploadNoteId : undefined}
        aria-disabled={upload.lockedReason ? "true" : undefined}
        data-toolbar-disabled-focusable="true"
        aria-label={upload.accessibleLabel}
        className="media-toolbar-upload"
        onClick={(event) => {
          if (upload.lockedReason) {
            event.preventDefault();
            return;
          }
          if (upload.onFiles) uploadInputRef.current?.click();
          else upload.onUpload();
        }}
        ref={uploadRef}
        title={upload.title}
        variant="primary"
      >
        {presentation === "icons" ? <Icon name="upload" /> : null}
        <span className="button-compact-label">{upload.buttonLabel}</span>
        {upload.lockedReason ? <span className="sr-only" id={uploadNoteId}>{upload.lockedReason}</span> : null}
      </Button>
    </>
  ) : undefined;
  const filterOnly = Boolean(filter && !sort && !search && !display && !upload && moreItems.length === 0);
  const leading = filterButton || sortControl ? (
    <>
      {filterButton}
      {sortControl}
      {filterOnly ? null : <span aria-hidden="true" className="media-toolbar-divider" />}
    </>
  ) : undefined;
  const secondary = filterButton || sortControl || chipRow ? (
    <div aria-label={sortControl ? "Filter and sort" : "Filters"} className="media-toolbar-secondary" role="group"
      onFocusCapture={event => {
        const port = event.currentTarget;
        const target = event.target;
        // Native focus can finish its own partial reveal after focusin returns.
        queueMicrotask(() => {
          if (target === document.activeElement && port.contains(target)) revealInlineFocus(port, target);
        });
      }}>
      {filterButton}
      {sortControl}
      {chipRow}
    </div>
  ) : null;

  return (
    <>
      <WorkspaceBrowseToolbar media><div className={compact ? "media-chrome media-chrome-compact" : "media-chrome"} ref={registerChrome}>
        <OverflowToolbar
          className="media-library-toolbar"
          moreVariant="ghost"
          items={displayItems}
          label="Library controls"
          leading={compact && !filterOnly ? undefined : leading}
          moreItems={moreItems}
          search={search ? <MediaSearchField {...search} /> : undefined}
          trailing={uploadControl}
        />
        {compact && !filterOnly ? secondary : chipRow}
      </div></WorkspaceBrowseToolbar>
      {filter ? (
        <MediaFilterPopover
          anchorRef={filterAnchor}
          onOpenChange={(open) => (open ? show("filter") : hide("filter"))}
          onSelect={(property, value) => {
            filter.onSelect(property, value);
            if (propertiesCloseAfterSelection(filter.properties, property, value)) hide("filter");
          }}
          note={filter.note}
          open={popover === "filter"}
          properties={filter.properties}
          savedViews={savedViewsConfiguration ? savedViewsController : undefined}
          start={filterStart}
        />
      ) : null}
      {display ? (
        <MediaDisplayPopover
          anchorRef={displayAnchor}
          configuration={display}
          onOpenChange={(open) => (open ? show("display") : hide("display"))}
          open={popover === "display"}
          savedViewDisplayAvailable={Boolean(savedViewsConfiguration?.display)}
          savedViews={savedViewsConfiguration ? savedViewsController : undefined}
        />
      ) : null}
      {shortcuts ? (
        <MediaShortcuts
          anchorRef={moreAnchor}
          onOpenChange={(open) => (open ? show("shortcuts") : hide("shortcuts"))}
          open={popover === "shortcuts"}
        />
      ) : null}
    </>
  );
}

function propertiesCloseAfterSelection(properties: readonly MediaFilterPropertyModel[], property: string, value: string): boolean {
  const picker = properties.find((candidate) => candidate.id === property)?.picker;
  return picker === "actions" || (picker === "text" && Boolean(value.trim()));
}

function supportsSavedViews(configuration: MediaToolbarSurfaceConfiguration): boolean {
  return configuration.surface === "images"
    || configuration.surface === "video"
    || configuration.surface === "favorites"
    || (configuration.surface === "collections" && configuration.view === "list");
}

interface MediaToolbarSurfaceRules {
  hideMoreItemsOnPhone: boolean;
  imageShortcuts: boolean;
}

function mediaToolbarSurfaceRules(configuration: MediaToolbarSurfaceConfiguration): MediaToolbarSurfaceRules {
  switch (configuration.surface) {
    case "images":
      return { hideMoreItemsOnPhone: true, imageShortcuts: true };
    case "video":
    case "favorites":
    case "voiceovers":
      return { hideMoreItemsOnPhone: false, imageShortcuts: false };
    case "collections":
      switch (configuration.view) {
        case "list":
        case "items":
          return { hideMoreItemsOnPhone: false, imageShortcuts: false };
      }
  }
}

function ConfiguredMediaToolbar(props: ConfiguredMediaToolbarProps) {
  switch (props.configuration.surface) {
    case "images":
    case "video":
    case "favorites":
    case "voiceovers":
      return <MediaToolbarOwner {...props} />;
    case "collections":
      switch (props.configuration.view) {
        case "list":
        case "items":
          return <MediaToolbarOwner {...props} />;
      }
  }
}

export function MediaToolbar(props: MediaToolbarProps | ConfiguredMediaToolbarProps) {
  return <ControlSizingProvider size="standard"><SizedMediaToolbar {...props} /></ControlSizingProvider>;
}

function SizedMediaToolbar(props: MediaToolbarProps | ConfiguredMediaToolbarProps) {
  if ("configuration" in props) return <ConfiguredMediaToolbar {...props} />;
  return <ImagesMediaToolbar {...props} />;
}
