import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import aboutImage from "../../../site/public/brand/spotlight/about.jpg";
import educationImage from "../../../site/public/brand/spotlight/education.jpg";
import housingImage from "../../../site/public/brand/spotlight/housing.jpg";
import domeImage from "../../../site/public/brand/spotlight/under-the-dome.jpg";
import { MediaContextMenu } from "../components/media/MediaContextMenu";
import { MediaGrid, restoreMediaFocus, type MediaGridHandle, type MediaGridItemContext } from "../components/media/MediaGrid";
import { MediaRow, MediaRowHeader } from "../components/media/MediaRow";
import { MediaTile } from "../components/media/MediaTile";
import { SelectionBar } from "../components/media/SelectionBar";
import { SegmentedControl } from "../components/ui/SegmentedControl";
import type { MediaAssetSummary, MediaSortDirection, MediaSortField } from "../lib/functions";
import { DEFAULT_MEDIA_DISPLAY } from "../lib/media-display";
import { selectionAnnouncement } from "../lib/media-filters";
import {
  clearSelection,
  emptySelection,
  offPageCount,
  pageSelectionState,
  removeSelected,
  setPageSelection,
  toggleSelection,
  VIDEO_SELECTION_CAP,
  type MediaSelection,
} from "../lib/media-selection";
import { mediaBarActions, mediaSelectionActions, type MediaTileActionId } from "../lib/media-tile-actions";
import { categoryLabel, image } from "./MediaTileSpecimen";
import "./MediaGridSpecimen.css";

// Gallery specimens for the shared grid, selection bar and context menu, which the images page uses. Local fixture
// images and data URIs only, fixed dates, and no request: every action changes local state.

const PICTURES = [domeImage, housingImage, educationImage, aboutImage];
const NAMES = [
  "Statehouse dome at dusk, Trenton",
  "Rowhouse framing, Jersey City",
  "Classroom desk, morning light",
  "Studio control room during the evening broadcast",
  "Election desk map graphic",
  "Boardwalk at first light, Asbury Park",
  "Ferry terminal, Hoboken",
  "Pine Barrens trail marker",
  "Newark Penn Station concourse",
  "Cape May lighthouse, winter",
  "Delaware Water Gap overlook",
  "Paterson Great Falls in spring",
  "Atlantic City skyline from Brigantine",
  "Princeton campus gate",
  "Camden waterfront at night",
  "Sandy Hook beach grass",
];

const PAGES: MediaAssetSummary[][] = [
  NAMES.slice(0, 11).map((name, index) => image(`p1-${index}`, name, PICTURES[index % PICTURES.length])),
  NAMES.slice(11).map((name, index) => image(`p2-${index}`, name, PICTURES[(index + 1) % PICTURES.length])),
];

type Layout = "grid" | "list";

type SpecimenSort = { sort: MediaSortField; direction: MediaSortDirection };

// The gallery sorts its fixture page locally; the images page sends the sort with its one list request.
function sortedPage(items: readonly MediaAssetSummary[], { direction, sort }: SpecimenSort): MediaAssetSummary[] {
  const key = (item: MediaAssetSummary) => (sort === "name" ? item.name : sort === "sizeBytes" ? item.sizeBytes : item[sort] ?? "");
  const sign = direction === "asc" ? 1 : -1;
  return [...items].sort((a, b) => (key(a) < key(b) ? -sign : key(a) > key(b) ? sign : 0));
}

/** The images list layout: sortable headings, the header checkbox and each row's context menu. */
export function MediaListLayoutSpecimen() {
  return <MediaGridKeyboardSpecimen initialLayout="list" />;
}

/** The interactive grid: keyboard walk, selection bar, context menu and focus return. */
export function MediaGridKeyboardSpecimen({ initialLayout = "grid" }: { initialLayout?: Layout }) {
  const [pageIndex, setPageIndex] = useState(0);
  const [pages, setPages] = useState(PAGES);
  const [layout, setLayout] = useState<Layout>(initialLayout);
  const [sort, setSort] = useState<SpecimenSort>({ sort: "updatedAt", direction: "desc" });
  const [selection, setSelection] = useState<MediaSelection<MediaAssetSummary>>(emptySelection);
  const [favorites, setFavorites] = useState<ReadonlySet<string>>(new Set(["p1-4"]));
  const [opened, setOpened] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [log, setLog] = useState("No action yet.");
  const [hadSelection, setHadSelection] = useState(false);
  const grid = useRef<MediaGridHandle>(null);
  const search = useRef<HTMLInputElement>(null);
  const items = pages[pageIndex];
  const count = selection.items.length;
  if (count > 0 && !hadSelection) setHadSelection(true);

  // Decision 3: back to the card that last had focus, else the search field.
  const returnFocus = () => restoreMediaFocus(grid.current, () => search.current?.focus());

  function clear() {
    setSelection(clearSelection());
    returnFocus();
  }

  function onEscape() {
    if (count > 0) clear();
    else if (opened) setOpened(null);
    else {
      setQuery("");
      search.current?.focus();
    }
  }

  function onAction(item: MediaAssetSummary, id: MediaTileActionId) {
    if (id === "open") setOpened(item.id);
    if (id === "favorite") {
      setFavorites((current) => {
        const next = new Set(current);
        if (next.has(item.id)) next.delete(item.id);
        else next.add(item.id);
        return next;
      });
    }
    if (id === "select") setSelection((current) => toggleSelection(current, item));
    if (id === "delete") {
      // The route opens the confirmation in details; the gallery removes the card at once
      // to show focus falling back to search when the card is gone.
      setPages((current) => current.map((page) => page.filter((entry) => entry.id !== item.id)));
      setSelection((current) => removeSelected(current, item.id));
      window.requestAnimationFrame(returnFocus);
    }
    setLog(`${id} on ${item.name}.`);
  }

  function onSelectionAction(id: MediaTileActionId) {
    if (id === "clear-selection") {
      clear();
      setLog("Cleared the selection.");
      return;
    }
    setLog(`${id} on ${count} items. A bulk action clears the selection and returns focus.`);
    clear();
  }

  function renderItem(item: MediaAssetSummary, context: MediaGridItemContext) {
    const favorite = favorites.has(item.id);
    const shared = {
      asset: item,
      canDelete: true,
      categoryLabel,
      favorite,
      fields: DEFAULT_MEDIA_DISPLAY.fields,
      onAction: (id: MediaTileActionId) => onAction(item, id),
      onOpen: () => onAction(item, "open"),
      onSelectChange: context.onSelectChange,
      opened: opened === item.id,
      selected: context.selected,
      tabbable: context.tabbable,
    };
    const menu = (child: ReactNode) => (
      <MediaContextMenu
        onAction={(id) => onAction(item, id)}
        onSelectionAction={onSelectionAction}
        selectionCount={count}
        tile={{ surface: "images", name: item.name, favorite, available: true, selected: context.selected, canDelete: true }}
      >
        {child}
      </MediaContextMenu>
    );
    // The list row is its own ARIA row, so the menu wraps its cells, not the row.
    return layout === "list"
      ? <MediaRow {...shared} wrapCells={menu} />
      : menu(<MediaTile {...shared} selectionMode={context.selectionMode} surface="images" />);
  }

  const visible = sortedPage(query ? items.filter((item) => item.name.toLowerCase().includes(query.toLowerCase())) : items, sort);

  return (
    <div className="media-grid-specimen">
      <p className="media-grid-specimen-note">
        Tab reaches the grid once. Arrows, Home, End, Page Up and Page Down move; Space selects; Shift+Arrow extends;
        Enter opens; Cmd or Ctrl+A selects this page; Shift+F10 or right-click opens the menu; Escape clears the
        selection, then closes details, then clears search.
      </p>
      <div className="media-grid-specimen-toolbar">
        <label className="media-grid-specimen-search">
          <span>Search images</span>
          <input
            id="media-grid-specimen-search"
            onChange={(event) => setQuery(event.currentTarget.value)}
            ref={search}
            type="search"
            value={query}
          />
        </label>
        <SegmentedControl
          label="Layout"
          onChange={setLayout}
          options={[{ value: "grid", label: "Grid", icon: "grid" }, { value: "list", label: "List", icon: "columns" }]}
          value={layout}
        />
        <nav aria-label="Specimen pages" className="media-grid-specimen-paging">
          {PAGES.map((_, index) => (
            <button
              aria-current={index === pageIndex ? "page" : undefined}
              className="button button-secondary"
              key={index}
              onClick={() => setPageIndex(index)}
              type="button"
            >
              Page {index + 1}
            </button>
          ))}
        </nav>
      </div>
      <p className="sr-only" role="status">{selectionAnnouncement(count, hadSelection ? 1 : 0)}</p>
      <div className="media-grid-specimen-results">
        <MediaGrid
          handleRef={grid}
          header={(
            <MediaRowHeader
              fields={DEFAULT_MEDIA_DISPLAY.fields}
              pageSelection={{
                state: pageSelectionState(selection.items, visible),
                onChange: (checked) => setSelection((current) => setPageSelection(current, visible, checked)),
              }}
              sort={{
                ...sort,
                onSortChange: (next) => {
                  setSort({ sort: next.sort, direction: next.direction });
                  setLog(`Sorted by ${next.sort}, ${next.direction === "asc" ? "ascending" : "descending"}.`);
                },
              }}
            />
          )}
          items={visible}
          label="Images"
          layout={layout}
          onEscape={onEscape}
          onOpen={(item) => onAction(item, "open")}
          onSelectionChange={setSelection}
          renderItem={renderItem}
          selection={selection}
        />
        <SelectionBar
          actions={mediaBarActions(mediaSelectionActions({ surface: "images", count, canEdit: false }))}
          count={count}
          info="Selection carries across image pages and filters."
          label="Collection selection"
          offPage={offPageCount(selection.items, visible)}
          onAction={onSelectionAction}
          onClear={clear}
          onPageChange={(checked) => setSelection((current) => setPageSelection(current, visible, checked))}
          pageState={pageSelectionState(selection.items, visible)}
        />
      </div>
      <p className="media-grid-specimen-log">
        <strong>Last action:</strong> {log} {opened ? `Details open for ${items.find((item) => item.id === opened)?.name ?? "a card"}.` : null}
      </p>
    </div>
  );
}

function BarFrame({ caption, children, narrow = false }: { caption: string; children: ReactNode; narrow?: boolean }) {
  return (
    <figure className="media-grid-specimen-figure">
      <div className={narrow ? "media-grid-specimen-bar-frame media-grid-specimen-bar-narrow" : "media-grid-specimen-bar-frame"}>
        {children}
      </div>
      <figcaption>{caption}</figcaption>
    </figure>
  );
}

const noop = () => {};

/** The selection bar in its captured states. */
export function MediaSelectionBarSpecimen() {
  const images = (count: number) => mediaBarActions(mediaSelectionActions({ surface: "images", count, canEdit: false }));
  return (
    <div className="media-grid-specimen">
      <BarFrame caption="Images: five selected, two on another page, with the info tooltip">
        <SelectionBar
          actions={images(5)}
          count={5}
          info="Selection carries across image pages and filters."
          label="Collection selection"
          offPage={2}
          onAction={noop}
          onClear={noop}
          onPageChange={noop}
          pageState="some"
        />
      </BarFrame>
      <BarFrame caption="Video: seven of the 100-video cap, three on another page">
        <SelectionBar
          actions={mediaBarActions(mediaSelectionActions({ surface: "video", count: 7, canEdit: true }))}
          cap={VIDEO_SELECTION_CAP.max}
          count={7}
          label="Video selection"
          offPage={3}
          onAction={noop}
          onClear={noop}
          onPageChange={noop}
          pageState="all"
        />
      </BarFrame>
      <BarFrame caption="Past 30: Add to collection is disabled and says why">
        <SelectionBar
          actions={images(31)}
          count={31}
          info="Selection carries across image pages and filters."
          label="Collection selection"
          offPage={26}
          onAction={noop}
          onClear={noop}
          onPageChange={noop}
          pageState="all"
        />
      </BarFrame>
      <BarFrame caption="Results narrower than 21rem: action words follow the presentation preference; the page checkbox keeps its accessible name" narrow>
        <SelectionBar
          actions={images(5)}
          count={5}
          info="Selection carries across image pages and filters."
          label="Collection selection"
          offPage={2}
          onAction={noop}
          onClear={noop}
          onPageChange={noop}
          pageState="some"
        />
      </BarFrame>
    </div>
  );
}

// Opens a card's context menu as a right-click near the thumbnail's top-left corner does,
// once fonts have settled, so each captured menu sits over its own card at every width.
function useOpenMenuOnMount(frame: RefObject<HTMLElement | null>) {
  useEffect(() => {
    let cancelled = false;
    void document.fonts.ready.then(() => window.requestAnimationFrame(() => {
      const thumb = frame.current?.querySelector<HTMLElement>(".media-tile-thumb");
      if (cancelled || !thumb) return;
      const box = thumb.getBoundingClientRect();
      thumb.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: Math.round(box.left + 24),
        clientY: Math.round(box.top + 24),
      }));
    }));
    return () => {
      cancelled = true;
    };
  }, [frame]);
}

function MenuTile({ asset, selected, selectionCount }: { asset: MediaAssetSummary; selected: boolean; selectionCount: number }) {
  return (
    <MediaContextMenu
      onAction={noop}
      onSelectionAction={noop}
      selectionCount={selectionCount}
      tile={{ surface: "images", name: asset.name, favorite: false, available: true, selected, canDelete: true }}
    >
      <MediaTile
        asset={asset}
        canDelete
        categoryLabel={categoryLabel}
        favorite={false}
        fields={DEFAULT_MEDIA_DISPLAY.fields}
        onAction={noop}
        onOpen={noop}
        onSelectChange={noop}
        selected={selected}
        selectionMode={selectionCount > 0}
        surface="images"
      />
    </MediaContextMenu>
  );
}

/** The context menu for one card and for a five-item selection, open as captured. */
export function MediaContextMenuSpecimen() {
  const single = useRef<HTMLDivElement>(null);
  const multiple = useRef<HTMLDivElement>(null);
  useOpenMenuOnMount(single);
  useOpenMenuOnMount(multiple);
  return (
    <div className="media-grid-specimen media-context-specimen">
      <figure className="media-grid-specimen-figure media-context-specimen-figure">
        <figcaption>One card: right-click, Shift+F10, the Menu key and More list the same items. Delete is last.</figcaption>
        <div className="media-context-specimen-tile" ref={single}>
          <MenuTile asset={image("menu-one", "Statehouse dome at dusk, Trenton", domeImage)} selected={false} selectionCount={0} />
        </div>
      </figure>
      <figure className="media-grid-specimen-figure media-context-specimen-figure">
        <figcaption>A selected card in a five-item selection: the menu is titled 5 items and can add or remove favorites.</figcaption>
        <div className="media-context-specimen-tile" ref={multiple}>
          <MenuTile asset={image("menu-many", "Rowhouse framing, Jersey City", housingImage)} selected selectionCount={5} />
        </div>
      </figure>
    </div>
  );
}
