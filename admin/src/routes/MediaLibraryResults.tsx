import { MediaResultBar } from "../components/media/MediaResultBar";
import { MediaGrid, type MediaGridProps } from "../components/media/MediaGrid";
import { MediaRowHeader, type MediaRowHeaderProps } from "../components/media/MediaRow";
import { Spinner } from "../components/ui/LoadingIndicator";
import { Button, EmptyState } from "../components/ui/Primitives";
import type { ListMediaResponse, MediaAssetSummary } from "../lib/functions";
import { MediaLoading } from "./MediaRouteLoading";

interface MediaLibraryResultsProps {
  result: ListMediaResponse | null;
  loading: boolean;
  requestPending: boolean;
  keywordFilter: boolean;
  resultKeyword: boolean;
  filterLabels: readonly string[];
  filtered: boolean;
  clearFilters: () => void;
  grid: Omit<MediaGridProps<MediaAssetSummary>, "items" | "header">;
  rowHeader: MediaRowHeaderProps;
  onFirstCursorPage: () => void;
  onPreviousCursorPage: () => void;
  onNextCursorPage: (cursor: string) => void;
  onPage: (page: number) => void;
}

export function MediaLibraryResults({
  result,
  loading,
  requestPending,
  keywordFilter,
  resultKeyword,
  filterLabels,
  filtered,
  clearFilters,
  grid,
  rowHeader,
  onFirstCursorPage,
  onPreviousCursorPage,
  onNextCursorPage,
  onPage,
}: MediaLibraryResultsProps) {
  return (
    <>
      {requestPending && result ? (
        // Visual only: the result status below the grid announces the refresh.
        <div className="media-results-updating" aria-hidden="true">
          <Spinner size="xs" />
          <span>Updating results</span>
        </div>
      ) : null}
      {loading ? <MediaLoading /> : null}
      {result ? (
        <>
          {result.records.length > 0 ? (
            <MediaGrid
              {...grid}
              items={result.records}
              header={<MediaRowHeader {...rowHeader} />}
            />
          ) : result.paging === "cursor" && result.nextCursor ? (
            <EmptyState
              title="Search continues"
              description="Choose Next to check more items."
            />
          ) : result.paging === "cursor" && (result.page > 1 || (result.total ?? 0) > 0) ? (
            <EmptyState
              title="No matches on this page"
              description="Return to a previous page."
            />
          ) : (
            <EmptyState
              title={keywordFilter ? "No keyword matches" : "No media found"}
              description="Change or clear the current filters."
              action={filtered ? (
                <Button onClick={clearFilters}>Clear filters</Button>
              ) : undefined}
            />
          )}

          {result.paging === "cursor" ? <MediaResultBar
            filterLabels={filterLabels}
            keyword={resultKeyword} page={result.page} pageCount={null}
            paging="cursor" refreshing={requestPending} total={result.total}
            isLastPage={!result.nextCursor} recordsOnPage={result.records.length}
            onFirst={onFirstCursorPage}
            onPrevious={onPreviousCursorPage}
            onNext={() => {
              if (result.nextCursor) onNextCursorPage(result.nextCursor);
            }}
          /> : <MediaResultBar
            filterLabels={filterLabels}
            keyword={resultKeyword} page={result.page} pageCount={result.pageCount}
            refreshing={requestPending} total={result.total}
            onPage={onPage}
          />}
        </>
      ) : null}
    </>
  );
}
