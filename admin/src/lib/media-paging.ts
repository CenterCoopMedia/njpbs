export interface MediaPagingControl {
  label: string;
  disabled: boolean;
}

export interface NumberedPagingRules {
  page: number;
  announcement: string;
  previous: MediaPagingControl;
  next: MediaPagingControl;
}

export interface CursorPagingRules extends Omit<NumberedPagingRules, "page"> {
  first: MediaPagingControl;
}

export interface LoadMorePagingRules {
  announcement: string;
  more: MediaPagingControl;
}

function positiveInteger(value: number, fallback = 1): number {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** Numbered pages know both boundaries. Invalid counters collapse to one safe page. */
export function numberedPagingRules(page: number, pageCount: number): NumberedPagingRules {
  const boundedPageCount = positiveInteger(pageCount);
  const boundedPage = Math.min(positiveInteger(page), boundedPageCount);
  return {
    page: boundedPage,
    announcement: `Page ${boundedPage} of ${boundedPageCount}`,
    previous: { label: "Previous page", disabled: boundedPage === 1 },
    next: { label: "Next page", disabled: boundedPage === boundedPageCount },
  };
}

/** Cursor pages know their history and whether the current response has a next cursor. */
export function cursorPagingRules(page: number, isLastPage: boolean): CursorPagingRules {
  const boundedPage = positiveInteger(page);
  const atFirst = boundedPage === 1;
  return {
    announcement: `Page ${boundedPage} · reload returns to page 1`,
    first: { label: "First page", disabled: atFirst },
    previous: { label: "Previous page", disabled: atFirst },
    next: { label: "Next page", disabled: isLastPage },
  };
}

/** Load-more lists keep one forward action and describe the records already present. */
export function loadMorePagingRules({
  loaded,
  total,
  hasMore,
  loading = false,
}: {
  loaded: number;
  total?: number | null;
  hasMore: boolean;
  loading?: boolean;
}): LoadMorePagingRules {
  const boundedLoaded = Number.isSafeInteger(loaded) && loaded > 0 ? loaded : 0;
  const boundedTotal = total !== null && total !== undefined && Number.isSafeInteger(total) && total >= boundedLoaded
    ? total
    : null;
  return {
    announcement: boundedTotal === null
      ? `${boundedLoaded} ${boundedLoaded === 1 ? "item" : "items"} loaded`
      : `${boundedLoaded} of ${boundedTotal} items`,
    more: {
      label: loading ? "Loading more items" : hasMore ? "Load more items" : "All items loaded",
      disabled: loading || !hasMore,
    },
  };
}
