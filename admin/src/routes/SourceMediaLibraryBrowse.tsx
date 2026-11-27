import type { ComponentProps, ReactNode, Ref } from "react";
import { MediaToolbar } from "../components/media/MediaToolbar";
import { MediaPaging, type MediaPagingProps } from "../components/media/MediaPaging";
import { DropOverlay } from "../components/media/DropOverlay";
import { UploadSheet } from "../components/media/UploadSheet";
import { MediaGrid, type MediaGridProps } from "../components/media/MediaGrid";
import { MediaRowHeader, type MediaRowHeaderProps } from "../components/media/MediaRow";
import { VideoOriginalNotices } from "../components/media/VideoOriginalStatus";
import { LoadingIndicator } from "../components/ui/LoadingIndicator";
import { Button, EmptyState, InlineMessage } from "../components/ui/Primitives";
import type { SourceMediaAssetSummary, SourceMediaPage } from "../lib/source-media";

interface SourceMediaLibraryBrowseProps {
  label: string;
  description: string;
  toolbar: ComponentProps<typeof MediaToolbar>;
  searchError: string;
  linkError: string;
  deletedName: string;
  originals: ComponentProps<typeof VideoOriginalNotices>;
  related: ReactNode;
  sizeSortFallback: boolean;
  selectionStatus: string;
  viewerAnnouncement: string;
  resultSummaryRef: Ref<HTMLParagraphElement>;
  resultQualifier: string;
  loading: boolean;
  error: string;
  onRetry: () => void;
  page: SourceMediaPage | undefined;
  filtered: boolean;
  drop: Omit<ComponentProps<typeof DropOverlay>, "children">;
  grid: Omit<MediaGridProps<SourceMediaAssetSummary>, "header" | "items">;
  rowHeader: MediaRowHeaderProps;
  paging: MediaPagingProps | null;
  bulkOpen: boolean;
  bulkNotice: ReactNode;
  bulkInspector: ReactNode;
  bulkBar: ReactNode;
  setUploadTrayTarget: Ref<HTMLDivElement>;
  upload: {
    sheet: Omit<ComponentProps<typeof UploadSheet>, "children">;
    panel: ReactNode;
  } | null;
}

export function SourceMediaLibraryBrowse({
  label,
  description,
  toolbar,
  searchError,
  linkError,
  deletedName,
  originals,
  related,
  sizeSortFallback,
  selectionStatus,
  viewerAnnouncement,
  resultSummaryRef,
  resultQualifier,
  loading,
  error,
  onRetry,
  page,
  filtered,
  drop,
  grid,
  rowHeader,
  paging,
  bulkOpen,
  bulkNotice,
  bulkInspector,
  bulkBar,
  setUploadTrayTarget,
  upload,
}: SourceMediaLibraryBrowseProps) {
  return <>
    <header className="surface-intro"><div><h2 id="video-library-title" tabIndex={-1}>{label}</h2><p>{description}</p></div></header>
    <div className="source-media-library-layout">
      <div className="source-media-library-main">
        <MediaToolbar {...toolbar} />
        {searchError ? <p role="alert">{searchError}</p> : null}
        <VideoOriginalNotices {...originals} />
        {linkError ? <InlineMessage tone="warning" title="Media link">{linkError}</InlineMessage> : null}
        {related}
        {deletedName ? <InlineMessage tone="success" title="Video deleted from library">{deletedName} was moved to the video recycle bin.</InlineMessage> : null}
        {bulkNotice}
        {sizeSortFallback ? <InlineMessage tone="info" role="status" title="File-size sorting is getting ready">
          Videos are shown by most recent update. Try file-size sorting again later.
        </InlineMessage> : null}
        <p className="sr-only" role="status">{selectionStatus}</p>
        <p className="sr-only" role="status">{viewerAnnouncement}</p>
        {page && !loading && !error ? <p className="source-video-result-summary" ref={resultSummaryRef} role="status" tabIndex={-1}>{page.total === null ? `${page.records.length} videos on this page` : `${page.total} videos`}{resultQualifier}</p> : null}
        <DropOverlay {...drop}>
          <div className="source-video-results" data-bulk-open={bulkOpen || undefined}>
            {loading ? <LoadingIndicator label="Loading videos" /> : error ? <InlineMessage tone="error" title="Video library unavailable">{error}<Button onClick={onRetry}>Try again</Button></InlineMessage>
              : page && <>
                {page.records.length === 0 ? (page.hasMore
                  ? <EmptyState title="Search continues" description="Choose Next to check more videos." />
                  : <EmptyState title="No videos found" description={filtered ? "Try a different name or clear the filters." : "Videos will appear here after they are added to this library."} />)
                  : <MediaGrid {...grid} items={page.records} header={<MediaRowHeader {...rowHeader} />} />}
              </>}
            {paging ? <MediaPaging {...paging} /> : null}
            {/* The bar floats at the bottom of the results while something is selected, as on the
                images page, so selecting never moves the grid under the pointer. */}
            {bulkInspector}
            {bulkBar}
            <div className="source-video-upload-tray" ref={setUploadTrayTarget} />
          </div>
        </DropOverlay>
      </div>
      {upload ? <UploadSheet {...upload.sheet}>
        {upload.panel}
      </UploadSheet> : null}
    </div>
  </>;
}
