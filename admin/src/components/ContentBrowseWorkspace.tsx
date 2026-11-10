import { lazy, Suspense, useState } from "react";
import { useSearchParams } from "react-router";
import { ContentLibrary } from "./ContentLibrary";
import { PagesDirectory, type PageDirectoryApi } from "./PagesDirectory";
import { RecordList, type RecordListPage } from "./RecordList";
import { Button, Panel } from "./ui/Primitives";
import { WorkspaceActions, WorkspaceTargetsScope, WorkspaceTitle } from "./WorkspaceActions";
import { canSaveContent } from "../lib/access";
import { recordDestination } from "../lib/content-nav";
import type { ContentQuery } from "../lib/content-query";
import type { LibrarySelection } from "../lib/content-library";
import type {
  BulkArchiveItem,
  BulkArchiveResponse,
} from "../lib/functions";
import type {
  SavedContentView,
  SavedContentViewMutation,
} from "../lib/saved-content-views";
import type { Principal } from "../../../packages/content-core/src/rbac";
import type { RecordKind } from "../../../packages/content-core/src/editor-admin";

const DatasetLibrary = lazy(() => import("./DatasetLibraryDialog"));

export type BrowseSurface =
  | { kind: "page-list" }
  | { kind: "library" }
  | { kind: "record-list"; record: RecordKind };

interface ContentBrowseWorkspaceProps {
  pageDirectoryApi?: PageDirectoryApi;
  principal: Principal;
  surface: BrowseSurface;
  listRecords?: (
    kind: RecordKind,
    page: number,
  ) => Promise<RecordListPage>;
  canArchiveLibrary?: boolean;
  archiveLibraryRecords?: (
    items: BulkArchiveItem[],
  ) => Promise<BulkArchiveResponse>;
  loadLibrarySelection?: (
    query: ContentQuery,
  ) => Promise<LibrarySelection>;
  loadSavedViews?: () => Promise<SavedContentView[]>;
  mutateSavedViews?: (
    mutation: SavedContentViewMutation,
  ) => Promise<SavedContentView[]>;
  onSavingChange?: (saving: boolean) => void;
  persistentEditorDirty?: boolean;
}

function labelForSurface(surface: BrowseSurface): string {
  if (surface.kind === "page-list") return "Site pages";
  if (surface.kind === "library") return "All content";
  if (surface.record === "post") return "Posts";
  return recordDestination(surface.record).label;
}

function descriptionForSurface(surface: BrowseSurface): string {
  if (surface.kind === "page-list") {
    return "Manage the pages on your public website.";
  }
  if (surface.kind === "library") {
    return "Browse records, check their public state, and continue editing.";
  }
  if (surface.record === "post") {
    return "Manage stories without losing track of drafts or live versions.";
  }
  return `Review and continue editing ${recordDestination(surface.record).label.toLocaleLowerCase()}.`;
}

// Direct browse addresses deliberately import no editor component. ContentTab swaps this
// shell for the persistent EditorWorkspace on the first page or record edit (#1129).
export function ContentBrowseWorkspace({
  pageDirectoryApi,
  principal,
  surface,
  listRecords,
  canArchiveLibrary = false,
  archiveLibraryRecords,
  loadLibrarySelection,
  loadSavedViews,
  mutateSavedViews,
  onSavingChange,
  persistentEditorDirty = false,
}: ContentBrowseWorkspaceProps) {
  const canCreate = canSaveContent(principal);
  const [params, setParams] = useSearchParams();
  const title = labelForSurface(surface);
  const description = descriptionForSurface(surface);
  const [headingActionsTarget, setHeadingActionsTarget] =
    useState<HTMLDivElement | null>(null);
  const [headingTitleTarget, setHeadingTitleTarget] =
    useState<HTMLDivElement | null>(null);

  return (
    <>
      <WorkspaceTitle>
        <span className="content-browse-route-context">{title}</span>
      </WorkspaceTitle>
      <section className="content-studio" aria-label="Content studio">
        <div className="content-studio-layout">
          <header className="content-browse-heading">
            <div
              className="content-browse-heading-copy"
              ref={setHeadingTitleTarget}
            />
            <div
              className="content-browse-heading-actions"
              ref={setHeadingActionsTarget}
            />
          </header>
          <WorkspaceTargetsScope
            actionsTarget={headingActionsTarget}
            titleTarget={headingTitleTarget}
          >
            <WorkspaceTitle>
              <div>
                <h1 id="page-title" className="programmatic-focus-target">
                  {title}
                </h1>
                <p>{description}</p>
              </div>
            </WorkspaceTitle>
            {surface.kind === "library" ? <WorkspaceActions><Button onClick={() => setParams(current => {
              const next = new URLSearchParams(current); next.set("panel", "datasets"); return next;
            })}>Datasets</Button></WorkspaceActions> : null}
            <Panel
              className="editor-canvas content-browse-panel"
              aria-labelledby="page-title"
            >
              <div className="editor-form-region editor-form-region-wide content-browse-region">
                {surface.kind === "page-list" ? (
                  <PagesDirectory
                    api={pageDirectoryApi}
                    persistentEditorDirty={persistentEditorDirty}
                  />
                ) : surface.kind === "library" || surface.record === "post" ? (
                  <ContentLibrary
                    key={surface.kind === "library" ? "library" : "posts"}
                    postOnly={surface.kind === "record-list"}
                    persistentEditorDirty={persistentEditorDirty}
                    archiveRecords={archiveLibraryRecords}
                    canArchive={canArchiveLibrary}
                    canCreate={canCreate}
                    currentUserId={principal.id}
                    loadSelection={loadLibrarySelection}
                    loadSavedViews={loadSavedViews}
                    mutateSavedViews={mutateSavedViews}
                    onMutatingChange={onSavingChange}
                  />
                ) : (
                  <RecordList
                    key={surface.record}
                    canCreate={canCreate}
                    kind={surface.record}
                    label={title}
                    loadRecords={listRecords}
                    persistentEditorDirty={persistentEditorDirty}
                  />
                )}
              </div>
            </Panel>
          </WorkspaceTargetsScope>
        </div>
      </section>
      {surface.kind === "library" && params.get("panel") === "datasets" ? <Suspense fallback={<p role="status">Loading datasets…</p>}>
        <DatasetLibrary principal={principal} />
      </Suspense> : null}
    </>
  );
}
