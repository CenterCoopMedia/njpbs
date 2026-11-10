import { useRef, useState } from "react";
import { MediaFilterChips } from "../components/media/MediaFilterChips";
import { MediaResultBar } from "../components/media/MediaResultBar";
import { MediaSearchField } from "../components/media/MediaSearchField";
import { MediaSortControl } from "../components/media/MediaSortControl";
import { Icon } from "../components/ui/Icon";
import { OverflowToolbar } from "../components/ui/OverflowToolbar";
import { Button } from "../components/ui/Primitives";
import type { MediaSortDirection, MediaSortField } from "../lib/functions";
import type { FilterChip } from "../lib/media-filters";

const initialChips: FilterChip[] = [
  { key: "kind:image", field: "kind", value: "image", label: "Type: Images" },
  { key: "category:news", field: "category", value: "news", label: "Category: News" },
  { key: "category:sports", field: "category", value: "sports", label: "Category: Sports" },
];

// Gallery specimen for the media toolbar's parts: the search field in the toolbar's search
// slot, the sort control, a three-chip row and the result bar with paging. The field
// listens for "/" on the document, so this specimen renders in its own document.
// Local state only; nothing is requested.
export function MediaToolbarPartsSpecimen() {
  const filterRef = useRef<HTMLButtonElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ sort: MediaSortField; direction: MediaSortDirection }>({ sort: "updatedAt", direction: "desc" });
  const [sortFromMore, setSortFromMore] = useState(false);
  const [chips, setChips] = useState(initialChips);
  const [page, setPage] = useState(1);
  const changeSort = (next: { sort: MediaSortField; direction: MediaSortDirection; page: 1 }) => {
    setSort({ sort: next.sort, direction: next.direction });
    setPage(next.page);
  };

  return (
    <div className="panel" style={{ display: "grid", gap: "var(--cms-space-4)" }}>
      <div ref={frameRef} style={{ minWidth: 0 }}>
        <OverflowToolbar
          items={[
            {
              key: "filter",
              priority: 2,
              node: (
                <Button ref={filterRef} variant="secondary">
                  <Icon name="filter" />
                  Filter
                </Button>
              ),
              menuItem: { key: "filter", label: "Filter", icon: "filter", onSelect: () => {} },
            },
            {
              key: "sort",
              priority: 1,
              node: <MediaSortControl direction={sort.direction} onChange={changeSort} sort={sort.sort} />,
              menuItem: { key: "sort", label: "Sort", icon: "sort", onSelect: () => setSortFromMore(true) },
            },
          ]}
          label="Images actions"
          search={<MediaSearchField onCommit={setQ} onSubmit={setQ} value={q} />}
        />
      </div>
      {/* While Sort sits in More, its popover anchors to the toolbar instead. */}
      <MediaSortControl
        anchorRef={frameRef}
        direction={sort.direction}
        onChange={changeSort}
        onOpenChange={setSortFromMore}
        open={sortFromMore}
        showTrigger={false}
        sort={sort.sort}
      />
      <MediaFilterChips
        chips={chips}
        filterButtonRef={filterRef}
        onClearAll={() => {
          setChips([]);
          setQ("");
        }}
        onEdit={() => {}}
        onRemove={(chip) => setChips((current) => current.filter((candidate) => candidate.key !== chip.key))}
      />
      <MediaResultBar
        filterLabels={chips.map((chip) => chip.label)}
        keyword={q !== ""}
        onPage={setPage}
        page={page}
        pageCount={3}
        total={84}
      />
    </div>
  );
}
