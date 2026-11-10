import { useState } from "react";
import { MediaToolbar, type MediaToolbarPopover, type MediaToolbarSortConfiguration, type MediaToolbarSurfaceConfiguration } from "../components/media/MediaToolbar";
import type { MediaFilterChipModel } from "../components/media/MediaFilterChips";
import type { MediaFilterPropertyModel } from "../components/media/MediaFilterPopover";
import type { MediaDisplayConfiguration } from "../components/media/MediaDisplayPopover";

type Surface = "video" | "favorites" | "collections" | "voiceovers";
type Choice = { value: string; label: string };
type Property = { id: string; label: string; options: readonly Choice[] };

const FILTERS: Record<Surface, readonly Property[]> = {
  video: [
    { id: "tag", label: "Tag", options: [{ value: "interview", label: "Interview" }, { value: "news", label: "News" }] },
    { id: "rights", label: "Rights review", options: [{ value: "pending", label: "Needs review" }, { value: "complete", label: "Rights recorded" }] },
    { id: "by", label: "Uploader", options: [{ value: "gallery-user", label: "Me" }] },
  ],
  favorites: [
    { id: "kind", label: "Type", options: [{ value: "image", label: "Images" }, { value: "document", label: "Documents" }, { value: "video", label: "Videos" }] },
  ],
  collections: [
    { id: "show", label: "Status", options: [{ value: "active", label: "Active" }, { value: "archived", label: "Archived" }] },
    { id: "scope", label: "Scope", options: [{ value: "private", label: "Private" }, { value: "all_staff", label: "All staff" }] },
  ],
  voiceovers: [
    { id: "style", label: "Style", options: [{ value: "news", label: "News" }, { value: "promo", label: "Promo" }] },
    { id: "recorder", label: "Recorder", options: [{ value: "staff-one", label: "Staff one" }] },
    { id: "line", label: "Line family", options: [{ value: "opening", label: "Opening" }] },
    { id: "favorites", label: "Favorites only", options: [{ value: "true", label: "Only favorites" }] },
    { id: "incomplete", label: "Incomplete attempts", options: [{ value: "true", label: "Show incomplete attempts" }] },
  ],
};

const INITIAL: Record<Surface, Record<string, string>> = {
  video: { tag: "interview" },
  favorites: { kind: "image" },
  collections: {},
  voiceovers: { style: "news" },
};

export function MediaSurfaceToolbarSpecimen({ surface, popover }: { surface: Surface; popover?: MediaToolbarPopover }) {
  const [selected, setSelected] = useState(INITIAL[surface]);
  const [search, setSearch] = useState(surface === "video" && popover !== "sort" ? "state" : "");
  const [layout, setLayout] = useState("grid");
  const [pageSize, setPageSize] = useState("24");
  const [sort, setSort] = useState(popover === "sort"
    ? { value: "size_desc", direction: "desc" }
    : { value: "name_asc", direction: "asc" });
  const [fields, setFields] = useState<string[]>(["type", "size", "duration", "rights", "tags"]);
  const properties: MediaFilterPropertyModel[] = FILTERS[surface].map(property => ({
    id: property.id,
    label: property.label,
    picker: "options",
    appliedCount: selected[property.id] ? 1 : 0,
    options: property.options.map(option => ({ ...option, selected: selected[property.id] === option.value })),
  }));
  const chips: MediaFilterChipModel[] = FILTERS[surface].flatMap(property => {
    const value = selected[property.id];
    const label = property.options.find(option => option.value === value)?.label;
    return value && label ? [{
      key: property.id,
      field: property.id,
      value,
      label: `${property.label}: ${label}`,
      scopeLabel: surface === "favorites" || (surface === "collections" && property.id === "scope") ? "On this page" : undefined,
    }] : [];
  });
  const display: MediaDisplayConfiguration = {
    rows: [
      { kind: "segmented", id: "layout", label: "Layout", value: layout,
        options: [{ value: "grid", label: "Grid", icon: "grid" }, { value: "list", label: "List", icon: "columns" }], onChange: setLayout },
      { kind: "segmented", id: "thumbnail", label: "Thumbnails", value: "m",
        options: [{ value: "s", label: "Small" }, { value: "m", label: "Medium" }, { value: "l", label: "Large" }], onChange: () => {} },
      { kind: "select", id: "density", label: "Density", value: "app",
        options: [{ value: "app", label: "Use app setting", appSetting: true }, { value: "compact", label: "Compact" }, { value: "comfortable", label: "Comfortable" }], onChange: () => {} },
      { kind: "select", id: "sort", label: "Sort by", value: sort.value,
        options: [{ value: "name_asc", label: "Name A–Z" }, { value: "updated_desc", label: "Recently updated" }, { value: "updated_asc", label: "Oldest update" },
          { value: "size_desc", label: "File size, largest first" }, { value: "size_asc", label: "File size, smallest first" }],
        disabled: surface === "video" && Boolean(search), note: surface === "video" && search ? "Clear search to change sort" : undefined,
        noteBelow: surface === "video" && Boolean(search),
        onChange: value => setSort({ value, direction: value.endsWith("_desc") ? "desc" : "asc" }) },
      { kind: "fields", id: "fields", label: "Show on cards and in list columns",
        options: [{ value: "type", label: "Type" }, { value: "size", label: "Size" }, { value: "duration", label: "Duration" }, { value: "rights", label: "Rights" }, { value: "updated", label: "Updated" }, { value: "tags", label: "Tags" }, { value: "uploader", label: "Uploader" }]
          .map(option => ({ ...option, selected: fields.includes(option.value) })),
        onChange: value => setFields(current => current.includes(value) ? current.filter(field => field !== value) : [...current, value]) },
      { kind: "select", id: "per-page", label: "Per page", value: pageSize,
        options: ["24", "48", "96"].map(value => ({ value, label: value })), onChange: setPageSize },
    ],
    onReset: () => { setLayout("grid"); setPageSize("24"); setFields(["type", "size", "duration", "rights", "tags"]); },
  };
  const favoritesDisplay: MediaDisplayConfiguration = {
    rows: display.rows.filter((row) => row.id === "layout" || row.id === "thumbnail" || row.id === "density"),
    onReset: () => setLayout("grid"),
  };
  const searchConfig = {
    value: search,
    onCommit: setSearch,
    onSubmit: setSearch,
    label: surface === "video" ? "Search video names by prefix" : "Search voiceovers",
    landmarkLabel: `${surface} search`,
    placeholder: surface === "video" ? "Search video names" : "Search voiceovers",
    title: surface === "video" ? "Search video names by prefix · /" : "Search voiceovers · /",
    maxLength: surface === "video" ? 160 : 200,
  };
  const filterConfig = {
    properties,
    chips,
    note: surface === "video" ? "Videos filter by one property at a time." : undefined,
    onSelect: (property: string, value: string) => setSelected(current => surface === "video" ? { [property]: value } : { ...current, [property]: value }),
    onRemove: (chip: MediaFilterChipModel) => setSelected(current => Object.fromEntries(Object.entries(current).filter(([key]) => key !== chip.field))),
    onClearAll: () => { setSelected({}); setSearch(""); },
  };
  const videoSort = {
    model: {
      value: sort.value === "size_asc" ? "size_desc" : sort.value,
      direction: sort.direction,
      options: [
        { value: "name_asc", label: "Name", directions: [{ value: "asc", label: "A–Z" }] as const },
        { value: "updated_desc", label: "Recently updated", directions: [{ value: "desc", label: "Newest first" }] as const },
        { value: "updated_asc", label: "Oldest update", directions: [{ value: "asc", label: "Oldest first" }] as const },
        { value: "size_desc", label: "File size", directions: [{ value: "desc", label: "Largest first" }, { value: "asc", label: "Smallest first" }] as const },
      ],
      locked: search ? { label: "Name A–Z while searching", reason: "Clear search to choose another sort" } : undefined,
    },
    onChange: ({ value, direction }) => setSort({
      value: value === "size_desc" && direction === "asc" ? "size_asc" : value,
      direction,
    }),
  } satisfies MediaToolbarSortConfiguration;
  const uploadConfig = { buttonLabel: "Upload", accessibleLabel: "Upload media", title: "Upload media", onUpload: () => {} };
  const selectionMore = [{ key: "select-page", label: "Select this page", icon: "check-square" as const, onSelect: () => {} }];
  let configuration: MediaToolbarSurfaceConfiguration;
  switch (surface) {
    case "video":
      configuration = { surface, search: searchConfig, filter: filterConfig, sort: videoSort, display, upload: uploadConfig, moreItems: selectionMore, shortcuts: null };
      break;
    case "favorites":
      configuration = { surface, search: null, filter: filterConfig, sort: null, display: favoritesDisplay, upload: null, moreItems: selectionMore, shortcuts: null };
      break;
    case "collections":
      configuration = { surface, view: "list", search: null, filter: filterConfig, sort: null, display: null, upload: null, moreItems: [], shortcuts: null };
      break;
    case "voiceovers":
      configuration = { surface, search: searchConfig, filter: filterConfig, sort: null, display: null, upload: null, moreItems: [], shortcuts: null };
      break;
  }

  return <section className="panel" style={{ display: "grid", gap: "var(--cms-space-4)" }}>
    <h2>{surface === "video" ? "Videos" : surface === "favorites" ? "Favorites" : surface === "collections" ? "Collections" : "Audio"}</h2>
    <MediaToolbar configuration={configuration} initialPopover={popover} />
  </section>;
}
