import { resultStatus } from "../../lib/media-filters";
import { MediaPaging } from "./MediaPaging";
import "./MediaResultBar.css";

interface MediaResultBarBase {
  total: number | null;
  /** A keyword search applies, so the count reads "keyword results". */
  keyword: boolean;
  page: number;
  /** A newer list is loading; the count stays and reads ", updating". */
  refreshing?: boolean;
  /** Applied filter labels, heard before the count. */
  filterLabels?: readonly string[];
}

export type MediaResultBarProps = MediaResultBarBase & (
  | { paging?: undefined; pageCount: number; onPage: (page: number) => void }
  | {
      paging: "cursor";
      pageCount: null;
      isLastPage: boolean;
      recordsOnPage: number;
      onFirst: () => void;
      onPrevious: () => void;
      onNext: () => void;
    }
);

// The one result bar under the grid. One status
// node stays mounted and only its text changes, so a refresh is announced once. Paging is a
// nav with its own classes, so the older .media-result-bar > div rules never reach it.
export function MediaResultBar(props: MediaResultBarProps) {
  const { filterLabels = [], keyword, page, refreshing = false, total } = props;
  const status = total === null
    ? {
        hidden: filterLabels.length ? `Filtered by ${filterLabels.join(", ")}. ` : "",
        text: props.paging === "cursor" && props.recordsOnPage === 0 && !props.isLastPage
          ? "No matches on this page. Continue to search more items."
          : `${props.paging === "cursor" ? props.recordsOnPage : 0} ${keyword ? "keyword " : ""}${props.paging === "cursor" && props.recordsOnPage === 1 ? "result" : "results"} on this page${refreshing ? ", updating" : ""}`,
      }
    : resultStatus({
        total,
        keyword,
        page,
        pageCount: props.paging === "cursor" ? 1 : props.pageCount,
        refreshing,
        filterLabels,
      });
  const count = status.text.match(/^[\d,]+ (?:keyword )?results?/)?.[0] ?? "";

  return (
    <div className="media-result-bar">
      <p className="media-result-status" role="status">
        {status.hidden ? <span className="sr-only">{status.hidden}</span> : null}
        <strong>{count}</strong>
        {status.text.slice(count.length)}
      </p>
      {props.paging === "cursor" ? (
        page > 1 || !props.isLastPage ? <MediaPaging mode="cursor" label="Media pages"
          page={page} isLastPage={props.isLastPage} loading={refreshing}
          onFirst={props.onFirst} onPrevious={props.onPrevious} onNext={props.onNext} /> : null
      ) : props.pageCount > 1 ? (
        <MediaPaging mode="numbered" label="Media pages" page={page} pageCount={props.pageCount}
          loading={refreshing} onPage={props.onPage} showStatus={false} />
      ) : null}
    </div>
  );
}
