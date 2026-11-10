import { useState } from "react";
import { MemoryRouter } from "react-router";
import { ContentBrowseWorkspace } from "../components/ContentBrowseWorkspace";
import { QueueSurface } from "../components/QueueSurface";
import type { RecordListPage } from "../components/RecordList";
import type { QueueItem } from "../components/QueueList";
import type { ContentRecordSummary } from "../lib/content-records";
import { selectLibraryRecords } from "../lib/content-library";
import type { ReviewQueueItem } from "../lib/review-queue";
import type { Principal } from "../../../packages/content-core/src/rbac";

const owner: Principal = { id: "gallery", grants: [{ role: "super_admin" }] };
const viewer: Principal = { id: "gallery-viewer", grants: [{ role: "staff", tier: "viewer" }] };
const pending = () => new Promise<never>(() => {});

/** Real browse owners with local read outcomes; never a backend operation. */
export function BrowsingWorkflowSpecimen({ records, recordPage, requests, jobs }: {
  records: ContentRecordSummary[]; recordPage: RecordListPage;
  requests: ReviewQueueItem[]; jobs: QueueItem[];
}) {
  const params = new URLSearchParams(window.location.search);
  const family = params.get("family") ?? "directory";
  const state = params.get("state") ?? "ready";
  const [reviewRetried, setReviewRetried] = useState(false);
  const [publishRetried, setPublishRetried] = useState(false);
  const failed = state === "error";
  const load = async <T,>(value: T): Promise<T> => {
    if (state === "loading") return pending();
    if (failed) throw new Error("The local fixture could not load this list.");
    return value;
  };
  const readonly = state === "readonly";
  const entry = family === "record-list" ? "/content/sponsor" : family === "library" ? "/content/library"
    : family === "directory" && state === "empty" ? "/content?page_q=no-matching-fixture-page" : "/content";
  return <MemoryRouter initialEntries={[entry]}>
    {family === "queue" ? <QueueSurface
      reviewRequests={state === "empty" ? [] : requests}
      reviewLoading={state === "loading"} reviewError={failed && !reviewRetried ? "The local fixture could not load review requests." : null}
      onReviewRefresh={() => setReviewRetried(true)} showPublishActivity={!readonly}
      publishItems={state === "empty" ? [] : jobs}
      publishLoading={state === "loading"} publishError={failed && !publishRetried ? "The local fixture could not load publish activity." : null}
      onPublishRefresh={() => setPublishRetried(true)}
    /> : <ContentBrowseWorkspace
      principal={readonly ? viewer : owner}
      surface={family === "directory" ? { kind: "page-list" } : family === "library" ? { kind: "library" } : { kind: "record-list", record: "sponsor" }}
      pageDirectoryApi={{ sections: [{ id: "station", label: "Station" }], canCreate: !readonly,
        canOpenBuiltIn: id => id === "home", create: async () => { throw new Error("Creation is not part of this read-only fixture."); },
        load: () => load([{ id: "home", title: "Home", path: "/", section: "station", status: "draft", published: true,
          version: 2, contentVersion: 2, publishedSourceVersion: 1, publishedContentVersion: 1 }]) }}
      listRecords={() => load(state === "empty" ? { records: [], page: 1, pageCount: 1, total: 0 } : recordPage)}
      canArchiveLibrary={!readonly}
      loadLibrarySelection={query => load(selectLibraryRecords(state === "empty" ? [] : records, query, owner.id))}
      loadSavedViews={async () => []}
    />}
  </MemoryRouter>;
}
