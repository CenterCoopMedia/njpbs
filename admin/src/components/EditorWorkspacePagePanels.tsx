import { pageCompositionFixedRegions } from "../../../packages/content-core/src/page-composition-seeds";
import { publicPage, publicPagePath, type PublicPageId } from "../../../packages/content-core/src/public-pages";
import type { ComponentProps, Ref } from "react";
import { BlockEditor } from "./BlockEditor";
import type { AdminBlock } from "../lib/block-factory";
import { editorSectionCount } from "../lib/content-outline";
import type { livePublishedSourceVersion } from "../lib/content-status";
import { EditorActionSlot } from "./EditorActions";
import { EditorBento, type BentoPanel } from "./EditorBento";
import type { PageContent, Surface } from "./EditorWorkspace";
import { EditorBackLink, labelForSurface } from "./EditorWorkspaceNavigation";
import { ElectionResultsHistory } from "./ElectionResultsHistory";
import { LifecycleActionsPanel } from "./LifecycleActionsPanel";
import { PagePreview } from "./PagePreview";
import { PublishedVersionStatus } from "./PublishedVersionStatus";
import { RecordForm } from "./RecordForm";
import { RevisionHistory } from "./RevisionHistory";
import { SavedPreview, type SavedPreviewProps } from "./SavedPreview";
import { ScheduledPublicationTime } from "./ScheduledPublicationTime";
import { Icon } from "./ui/Icon";
import { AsyncActionButton, Button, InlineMessage, Toolbar } from "./ui/Primitives";
import { WorkspaceStatus } from "./WorkspaceActions";

export type PageWorkspaceLifecycle = Pick<ComponentProps<typeof LifecycleActionsPanel>,
  | "canArchive" | "canApprove" | "canEdit" | "canPublish" | "canRestore" | "canUnpublish"
  | "publicationDisabledReason" | "disabledReason" | "videos"
  | "onPublish" | "onSchedule" | "onSubmittingChange" | "onTransition"
>;

export type PageWorkspaceRevisions = Pick<ComponentProps<typeof RevisionHistory>,
  "loadRevisions" | "loadRevision" | "onRestoringChange" | "refreshKey" | "restoreDisabledReason" | "restoreRevision"
>;

export type PageEditorSharedControls = Pick<ComponentProps<typeof BlockEditor>,
  | "allowIncomplete" | "loadMedia" | "mediaPickerUnavailable" | "uploadMedia" | "mediaCategories"
  | "defaultUploadCategory" | "canUploadCategory" | "onMediaPickerDirtyChange"
  | "onReload" | "allowConflictOverwrite" | "showSaveAction"
>;

export type PageBlockEditorControls = Omit<ComponentProps<typeof BlockEditor>,
  keyof PageEditorSharedControls | "key" | "electionResultsApprovals" | "pageId" | "pageTitle" | "pageDescription" | "homeCompositionVersion" | "section"
>;

export type PageMetadataEditorControls = Omit<ComponentProps<typeof RecordForm>,
  keyof PageEditorSharedControls | "key" | "kind" | "pageId" | "initial" | "saveLabel"
>;

interface EditorWorkspacePagePanelsProps {
  pageSurface: Extract<Surface, { kind: "page" }>;
  content: Pick<PageContent,
    "homeCompositionVersion" | "publishAt" | "contentVersion" | "publishedSourceVersion"
    | "publishBuildPending" | "publishBuildQueueId" | "scheduledPublishFailure" | "electionResultsApprovals"
  > & { pageStatus?: string };
  initialMetadata: Record<string, unknown>;
  homeCanvas: boolean;
  savedPageBlocks: readonly AdminBlock[];
  visiblePageBlocks: readonly AdminBlock[];
  sharedEditorControls: PageEditorSharedControls;
  blocksEditor: PageBlockEditorControls;
  metadataEditor: PageMetadataEditorControls;
  metadataKey: string;
  inWorkspace: boolean;
  workspaceActionsAvailable: boolean;
  bentoReveal: ComponentProps<typeof EditorBento>["revealPanel"];
  revealBentoPanel: (id: string) => void;
  pageCurrentVersion?: number;
  pageLiveSourceVersion: ReturnType<typeof livePublishedSourceVersion>;
  activeSurfaceDirty: boolean;
  homeReloadDisabled: boolean;
  saving: boolean;
  homeShelfOnly: boolean;
  canConvertHomeV2: boolean;
  hasHomeV2Conversion: boolean;
  canEnableHome: boolean;
  convertingHome: boolean;
  conversionDisabledReason?: string;
  editorialConversionDisabledReason?: string;
  homeV2Confirmation: boolean;
  homeConversionError?: string;
  setHomeConversionError: (error: string | undefined) => void;
  setHomeV2Confirmation: (confirmed: boolean) => void;
  cancelEditorialConversion: () => void;
  onConvertToEditorialHome: () => Promise<void>;
  enableHomeEditing: () => Promise<void>;
  homeV2Trigger: Ref<HTMLButtonElement>;
  homeV2Cancel: Ref<HTMLButtonElement>;
  setPageWritingTarget: Ref<HTMLDivElement>;
  setHomeHeroTarget: Ref<HTMLDivElement>;
  homeEditorTarget: Ref<HTMLDivElement>;
  pageUpdate: {
    disabled: boolean;
    disabledReason?: string;
    saving: boolean;
    saved: boolean;
    error?: string;
    localConfirmation: boolean;
    updatePage: () => Promise<void>;
  } | null;
  savedPreviewEnabled: boolean;
  savedPreviewDisabledReason: string;
  preparePreview: SavedPreviewProps["preparePreview"];
  requestSavedPreview: SavedPreviewProps["requestPreview"] | undefined;
  preparePreviewSession: SavedPreviewProps["prepareSession"];
  loadPagePreviewStatus: SavedPreviewProps["loadPreviewStatus"] | undefined;
  requestPagePreview: ComponentProps<typeof PagePreview>["requestPreview"];
  savePreviewChanges: ComponentProps<typeof PagePreview>["saveChanges"];
  reloadPageForPreview: () => void;
  previewAfterReload: PublicPageId | null;
  onPreviewStarted: () => void;
  reloadPage: () => void;
  lifecycle: PageWorkspaceLifecycle | null;
  revisions: PageWorkspaceRevisions | null;
}

export function EditorWorkspacePagePanels({
  pageSurface,
  content,
  initialMetadata,
  homeCanvas,
  savedPageBlocks,
  visiblePageBlocks,
  sharedEditorControls,
  blocksEditor,
  metadataEditor,
  metadataKey,
  inWorkspace,
  workspaceActionsAvailable,
  bentoReveal,
  revealBentoPanel,
  pageCurrentVersion,
  pageLiveSourceVersion,
  activeSurfaceDirty,
  homeReloadDisabled,
  saving,
  homeShelfOnly,
  canConvertHomeV2,
  hasHomeV2Conversion,
  canEnableHome,
  convertingHome,
  conversionDisabledReason,
  editorialConversionDisabledReason,
  homeV2Confirmation,
  homeConversionError,
  setHomeConversionError,
  setHomeV2Confirmation,
  cancelEditorialConversion,
  onConvertToEditorialHome,
  enableHomeEditing,
  homeV2Trigger,
  homeV2Cancel,
  setPageWritingTarget,
  setHomeHeroTarget,
  homeEditorTarget,
  pageUpdate,
  savedPreviewEnabled,
  savedPreviewDisabledReason,
  preparePreview,
  requestSavedPreview,
  preparePreviewSession,
  loadPagePreviewStatus,
  requestPagePreview,
  savePreviewChanges,
  reloadPageForPreview,
  previewAfterReload,
  onPreviewStarted,
  reloadPage,
  lifecycle,
  revisions,
}: EditorWorkspacePagePanelsProps) {
  const registryPage = publicPage(pageSurface.pageId);
  const fixedRegions = homeCanvas
    ? []
    : pageCompositionFixedRegions(pageSurface.pageId, {
        homeCompositionVersion: content.homeCompositionVersion,
      });
  const pageTitle = typeof initialMetadata.title === "string" && initialMetadata.title.trim() ? initialMetadata.title : registryPage?.title ?? labelForSurface(pageSurface);
  const pagePath = publicPagePath(pageSurface.pageId, initialMetadata) ?? registryPage?.path;
  const blockEditorTargetId = `page-block-editor-${pageSurface.pageId}`;
  const pageUpdateReasonId = `${blockEditorTargetId}-update-reason`;

  // Title and summary sit in the main writing column like Posts. Page content stays in
  // main; metadata, preview, and lifecycle sit in the side column unless the editor moves them.
  const writingPanel: BentoPanel = {
    id: "page-title",
    title: "Title and summary",
    outlineLabel: "Title and summary",
    defaultZone: inWorkspace ? "side" : "main",
    allowedZones: inWorkspace ? ["main", "side"] : ["main"],
    body: <div ref={setPageWritingTarget} className="page-title-editor" />,
  };
  const contentPanel: BentoPanel = {
    id: "content",
    title: "Page content",
    presentation: inWorkspace ? "canvas" : undefined,
    outlineLabel: "Page content",
    subtitle: inWorkspace ? `${editorSectionCount(visiblePageBlocks, pageSurface.pageId)} sections · Select to inspect, pencil to edit` : pageSurface.pageId === "staff"
      ? "Edit authored blocks. The published roster stays generated and locked."
      : "Edit page blocks.",
    defaultZone: "main",
    allowedZones: ["main"],
    body: (
      <div className="page-content-editor">
        {pageSurface.pageId === "home" ? <div ref={setHomeHeroTarget} /> : null}
        {fixedRegions.length > 0 ? (
          <section
            className="page-fixed-context"
            role="region"
            aria-label={`Fixed ${pageTitle} page context`}
          >
            <details className="page-fixed-context-details">
              <summary>
                <span className="page-fixed-context-label">
                  <Icon name="lock" />
                  Locked content
                </span>
                <span className="page-fixed-context-count">
                  {fixedRegions.length} {fixedRegions.length === 1 ? "region" : "regions"}
                  <Icon name="chevron-down" />
                </span>
              </summary>
              <ul>
                {fixedRegions.map((region) => (
                  <li key={region.label}>
                    <strong>{region.label}</strong>
                    <span>{region.detail}</span>
                  </li>
                ))}
              </ul>
            </details>
          </section>
        ) : null}
        {pageSurface.pageId === "home" && content.homeCompositionVersion === 1 && !canConvertHomeV2 && homeConversionError ? (
          <InlineMessage tone="error">{homeConversionError}</InlineMessage>
        ) : null}
        {canConvertHomeV2 && hasHomeV2Conversion ? (
          <InlineMessage tone="info" title="Editorial Home layout">
            <div>
              <p>Start with news first, then arrange and edit your Home sections.</p>
              <Button ref={homeV2Trigger} aria-expanded={homeV2Confirmation} disabled={Boolean(editorialConversionDisabledReason)}
                onClick={() => { setHomeConversionError(undefined); setHomeV2Confirmation(true); }}>Use the editorial layout</Button>
              {editorialConversionDisabledReason ? <p>{editorialConversionDisabledReason}</p> : null}
              {homeV2Confirmation ? <div role="group" aria-labelledby="home-v2-confirmation-title" aria-describedby="home-v2-confirmation-description"
                className="lifecycle-actions-confirmation" onKeyDown={event => {
                  if (event.key === "Escape" && !convertingHome) { event.preventDefault(); cancelEditorialConversion(); }
                }}>
                <strong id="home-v2-confirmation-title">Use the editorial layout?</strong>
                <p id="home-v2-confirmation-description">This saves an editorial draft in the starting section order. The live homepage does not change until you press Publish.</p>
                <div className="button-row">
                  <Button ref={homeV2Cancel} disabled={convertingHome} onClick={cancelEditorialConversion}>Cancel</Button>
                  <AsyncActionButton variant="primary" label="Use the editorial layout" pending={convertingHome}
                    pendingLabel="Preparing editorial draft…" pendingAnnouncement="Preparing the editorial Home draft."
                    disabled={Boolean(editorialConversionDisabledReason)} onClick={() => void onConvertToEditorialHome()} />
                </div>
              </div> : null}
              {homeConversionError ? <div role="alert"><p>{homeConversionError}</p>
              <Button disabled={homeReloadDisabled} onClick={() => { setHomeConversionError(undefined); setHomeV2Confirmation(false); reloadPage(); }}>Reload Home</Button>
              </div> : null}
            </div>
          </InlineMessage>
        ) : null}
        {homeShelfOnly ? (
          <InlineMessage
            className="page-home-ownership-notice"
            tone="info"
            title="Edit the Home sections"
          >
            <p>Edit the text, images and shelf settings shown below. Your current content stays in version
              history. This does not publish the page.</p>
            {canEnableHome ? <>
              <AsyncActionButton variant="primary" label="Enable Home editing"
                disabled={Boolean(conversionDisabledReason)} pending={convertingHome}
                pendingLabel="Enabling editing…" pendingAnnouncement="Preparing the Home draft."
                onClick={() => void enableHomeEditing()} />
              {conversionDisabledReason ? <p>{conversionDisabledReason}</p> : null}
            </> : null}
            {homeConversionError ? <div role="alert">
              <p>{homeConversionError}</p>
              <Button disabled={homeReloadDisabled} onClick={() => { setHomeConversionError(undefined); reloadPage(); }}>Reload Home</Button>
            </div> : null}
          </InlineMessage>
        ) : null}
        <div
          ref={homeEditorTarget}
          id={blockEditorTargetId}
          className="page-layout-editor-target"
          tabIndex={-1}
        >
          <BlockEditor
            {...sharedEditorControls}
            {...blocksEditor}
            electionResultsApprovals={content.electionResultsApprovals}
            key={pageSurface.pageId}
            pageId={pageSurface.pageId}
            pageTitle={typeof initialMetadata.title === "string" ? initialMetadata.title : undefined}
            pageDescription={typeof initialMetadata.description === "string" ? initialMetadata.description : undefined}
            homeCompositionVersion={content.homeCompositionVersion}
            section={pageSurface.section}
          />
        </div>
      </div>
    ),
  };

  const metadataPanel: BentoPanel = {
    id: "metadata",
    title: "Page metadata",
    subtitle: pageSurface.pageId === "staff"
      ? "Edit the Staff hero background, crop, search, and social settings."
      : "Edit page labels and link previews.",
    aside: registryPage ? (
      <p className="page-public-path">
        <span>Path</span> <code>{pagePath}</code>
      </p>
    ) : undefined,
    defaultZone: "side",
    body: (
      <RecordForm
        {...sharedEditorControls}
        {...metadataEditor}
        key={metadataKey}
        kind="page"
        pageId={pageSurface.pageId}
        initial={initialMetadata}
        saveLabel="Save metadata"
      />
    ),
  };

  const panels: BentoPanel[] = [writingPanel, contentPanel, metadataPanel];
  if (registryPage && content.pageStatus !== "archived") {
    panels.push({
      id: "preview",
      title: "Preview",
      toggleLabel: workspaceActionsAvailable ? "Preview panel" : undefined,
      subtitle: "Preview the saved page on desktop and mobile.",
      defaultZone: "side",
      defaultCollapsed: true,
      body: requestSavedPreview && loadPagePreviewStatus ? (
        <SavedPreview
          key={pageSurface.pageId}
          collection="cmsPages"
          documentId={pageSurface.pageId}
          enabled={savedPreviewEnabled}
          disabledReason={savedPreviewDisabledReason}
          preparePreview={preparePreview}
          requestPreview={requestSavedPreview}
          prepareSession={preparePreviewSession}
          loadPreviewStatus={loadPagePreviewStatus}
        />
      ) : (
        <PagePreview
          key={pageSurface.pageId}
          pageId={pageSurface.pageId}
          pagePath={pagePath ?? registryPage.path}
          dirty={activeSurfaceDirty}
          saving={saving}
          savedVersion={pageCurrentVersion ?? 0}
          requestPreview={requestPagePreview}
          loadPreviewStatus={loadPagePreviewStatus}
          // The gate's two ways out of unsaved work are this workspace's own: the same page-save
          // sequence the Save draft control and the exit guard run (#1032), and the same
          // discard-and-re-read the conflict banner offers. The preview never gets a private
          // definition of saved, and never builds from work that is only in the browser (#1042).
          saveChanges={savePreviewChanges}
          discardChanges={reloadPageForPreview}
          startOnMount={previewAfterReload === pageSurface.pageId}
          onStartOnMountHandled={onPreviewStarted}
          headless
          workspaceAction={workspaceActionsAvailable}
          onReveal={() => revealBentoPanel("preview")}
        />
      ),
    });
  }
  if (lifecycle) {
    panels.push({
      id: "lifecycle",
      title: "Lifecycle",
      subtitle: "Save, review, and publish this version.",
      defaultZone: "side",
      body: (
        <>
        {content.homeCompositionVersion === 2 && savedPageBlocks.some(block => block.section === "home-newsletter" && block.visible &&
          Array.isArray(block.data.newsletterIds) && block.data.newsletterIds.length === 0) ? (
          <InlineMessage tone="info"><p>Publishing shows the standard newsletter band until a newsletter is chosen.</p></InlineMessage>
        ) : null}
        <LifecycleActionsPanel
          {...lifecycle}
          recordTitle={pageTitle}
          baseVersion={pageCurrentVersion}
          contentVersion={content.contentVersion ?? pageCurrentVersion}
          publicationSupported
          collection="cmsPages"
          documentId={pageSurface.pageId}
          headless
          liveSourceVersion={pageLiveSourceVersion}
          publicBuildQueueId={content.publishBuildQueueId ?? null}
          publicUpdatePending={content.publishBuildPending === true}
          pendingSourceVersion={content.publishedSourceVersion}
          onChanged={reloadPage}
          onReload={reloadPage}
          scheduledPublishFailure={content.scheduledPublishFailure}
          scheduledAt={content.publishAt}
          status={content.pageStatus}
          workspaceActions={workspaceActionsAvailable}
          onReveal={() => revealBentoPanel("lifecycle")}
        />
        <ElectionResultsHistory approvals={content.electionResultsApprovals} />
        </>
      ),
    });
  }
  if (revisions) {
    panels.push({
      id: "revisions",
      presentation: inWorkspace ? "history" : undefined,
      title: "Revision history",
      subtitle: "Review saved versions and changes.",
      defaultZone: "side",
      defaultCollapsed: true,
      body: (
        <RevisionHistory
          {...revisions}
          collection="cmsPages"
          currentVersion={pageCurrentVersion}
          documentId={pageSurface.pageId}
          onRestored={reloadPage}
          headless
        />
      ),
    });
  }
  return (
    <>
      {workspaceActionsAvailable ? (
        <WorkspaceStatus>
          <span className="status-label" aria-live="polite">
            {!inWorkspace ? <span className="status-label-key">Status:</span> : null}
            {" "}
            <PublishedVersionStatus collection="cmsPages" documentId={pageSurface.pageId}
              documentBar={inWorkspace ? { kind: "page", draftState: saving ? "saving" : activeSurfaceDirty ? "dirty" : pageCurrentVersion ? "saved" : "new" } : undefined}
              recordTitle={pageTitle}
              workingStatus={content.pageStatus ?? "draft"} workingVersion={pageCurrentVersion}
              contentVersion={content.contentVersion} liveSourceVersion={pageLiveSourceVersion}
              pendingSourceVersion={content.publishedSourceVersion}
              publicUpdatePending={content.publishBuildPending === true} statusOnly />
          </span>
          <ScheduledPublicationTime status={content.pageStatus} publishAt={content.publishAt} />
        </WorkspaceStatus>
      ) : null}
      <EditorBackLink surface={{ kind: "page" }} />
      {pageUpdate ? (
        <EditorActionSlot group="save">
          <Toolbar className="page-update-actions" aria-label="Save page">
            <span
              className="disabled-action-shell"
              role={pageUpdate.disabledReason ? "group" : undefined}
              aria-label={
                pageUpdate.disabledReason
                  ? `Save draft unavailable: ${pageUpdate.disabledReason}`
                  : undefined
              }
              title={pageUpdate.disabledReason}
              tabIndex={pageUpdate.disabledReason ? 0 : undefined}
            >
              <AsyncActionButton
                variant="secondary"
                icon="save"
                aria-describedby={
                  pageUpdate.disabledReason ? pageUpdateReasonId : undefined
                }
                disabled={pageUpdate.disabled}
                label="Save draft"
                onClick={() => void pageUpdate.updatePage()}
                pending={pageUpdate.saving}
                pendingAnnouncement="Saving draft."
                pendingLabel="Saving…"
              />
            </span>
            {pageUpdate.disabledReason ? (
              <span className="sr-only" id={pageUpdateReasonId}>
                {pageUpdate.disabledReason}
              </span>
            ) : null}
            {pageUpdate.saved && pageUpdate.localConfirmation ? (
              <span className="success-text" role="status">
                Saved.
              </span>
            ) : null}
            {pageUpdate.error ? (
              <span className="error-text" role="alert">
                {pageUpdate.error}
              </span>
            ) : null}
          </Toolbar>
        </EditorActionSlot>
      ) : null}
      <EditorBento
        storageKey="page"
        ariaLabel="Page editor sections"
        documentOutline={{
          heading: "Document",
          settingsLabel: "Page settings",
        }}
        panels={panels}
        revealPanel={bentoReveal}
      />
    </>
  );
}
