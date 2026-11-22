import type { EditorDocumentKind, EditorField, EditorFieldGroup } from "../../../packages/content-core/src/editor-admin";
import { parseBlocks } from "../../../packages/content-core/src/content-model";
import type { LiveBlogData } from "../../../packages/content-core/src/live-blog";
import type { LiveBlogDraft } from "../../../packages/content-core/src/live-blog-draft";
import { POST_PRESENTATIONS, postPresentationError, publicPostTopics, resolvePostPresentation, tagsWithPostPresentation, type PostPresentation } from "../../../packages/content-core/src/post-formats";
import { isPostSidebar } from "../../../packages/content-core/src/post-sidebar";
import type { StoryCredit } from "../../../packages/content-core/src/story-credits";
import { Fragment, type ComponentProps, type FormEventHandler, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import type { useCoverageLabels } from "../context/CoverageLabelsContext";
import type { useEditorWorkspaceView } from "../context/EditorWorkspaceView";
import type { AdminBlock } from "../lib/block-factory";
import { displayContentStatus } from "../lib/content-status";
import { publicSiteOrigin } from "../lib/dev-origins";
import { fieldPathKey, readFieldValue } from "../lib/field-path";
import { fieldIsRequired, recommendedFieldWarning } from "../lib/field-validation";
import type { MediaAssetSummary } from "../lib/functions";
import type { LiveBlogPublicationIssue } from "../lib/live-blog";
import { effectivePostTitle, hasExplicitPostTitle } from "../lib/post-title-inheritance";
import type { usePublishedVocabulary } from "../lib/use-published-vocabulary";
import { CoverageLabelSelect } from "./CoverageLabelSelect";
import { DataHubReportingEditor } from "./DataHubReportingEditor";
import { RetainedEditorHost } from "./RetainedEditorHost";
import { BioCatalogProvider } from "./BioCatalogContext";
import { HomeHeroEditor } from "./HomeHeroEditor";
import { HomeHeroModal } from "./HomeHeroModal";
import { HomeHeroLayoutPreview } from "./HomeHeroLayoutPreview";
import { PostLeadMediaReview } from "./PostLeadMediaReview";
import { LiveBlogEditor } from "./LiveBlogEditor";
import { LiveBlogDirectPublish } from "./LiveBlogDirectPublish";
import { InfoTooltip } from "./ui/InfoTooltip";
import { FieldRenderer } from "./FieldRenderer";
import { PostLeadMediaEditor } from "./PostLeadMediaEditor";
import { PostLeadMediaInspector } from "./PostLeadMediaInspector";
import { PostSidebarEditor } from "./PostSidebarEditor";
import { BlockEditor, type BlockEditorHandle } from "./BlockEditor";
import { EditorBento, type BentoPanel } from "./EditorBento";
import { LifecycleFeedbackRevealProvider } from "./LifecycleActionsPanel";
import type { RecordForm } from "./RecordForm";
import { renderRecordFieldGroup, renderRecordSectionFieldset } from "./RecordFormFieldGroups";
import { buildPostMetadataPanels, renderPostStoryMetadata } from "./RecordFormPostMetadata";
import { Button, Select } from "./ui/Primitives";

type RecordFormFieldInputs = Pick<ComponentProps<typeof RecordForm>,
  | "allowIncomplete" | "bylineAuthors" | "bylineAuthorsUnavailable" | "canSave" | "canUploadCategory"
  | "dataHubReportingFigure" | "dataHubReportingTarget" | "defaultUploadCategory" | "electionSourceHost"
  | "homeHeroTarget" | "kind" | "loadMedia" | "loadPublishedVocabulary" | "mediaCategories" | "newId"
  | "onMediaPickerDirtyChange" | "onReportingFigureReveal" | "pageId" | "postInspector"
  | "reportingTransport" | "saveDisabledReason" | "uploadMedia" | "writingTarget"
>;

interface RecordFormFieldsProps extends RecordFormFieldInputs {
  accessibilityFieldsForAlt: (kind: EditorDocumentKind, key: string) => { asset: string; decorative: string } | null;
  assetForAccessibilityField: (kind: EditorDocumentKind, key: string) => string | null;
  assetSuggestions: Record<string, string>;
  bylineAuthorsLoading: boolean;
  canEditCustomHtml: boolean;
  canManageAuthorProfiles: boolean;
  canManageSettings: boolean;
  changeCoverageLabel: (id?: string) => void;
  changeField: (field: EditorField, value: unknown) => void;
  changeLiveBlog: (draft: LiveBlogDraft | null) => void;
  changePostBlocks: (blocks: AdminBlock[] | null) => void;
  changeReportingDrafts: (drafts: Record<string, string>) => void;
  coverage: ReturnType<typeof useCoverageLabels>;
  coverageRegistryMissing: boolean;
  editorView: ReturnType<typeof useEditorWorkspaceView>;
  errors: Record<string, string>;
  feedback: ReactNode;
  fields: readonly EditorField[];
  focusNewLiveBlog: boolean;
  followUpBaselineKnown: boolean;
  formId: string;
  groups: readonly EditorFieldGroup[];
  hasInitialLeadMedia: boolean;
  heroFocusId: string | undefined;
  heroRevealRequest: number;
  interactionLocked: boolean;
  isPostTitleOverrideField: (kind: EditorDocumentKind, field: EditorField) => boolean;
  isPostWritingField: (field: EditorField) => boolean;
  jumpToField: (field: EditorField) => void;
  liveBlogDirectDisabledReason: string | undefined;
  liveBlogEntryKeys: Record<string, string>;
  liveBlogIssue: LiveBlogPublicationIssue | null;
  mediaPickerUnavailable: boolean;
  postBentoReveal: ComponentProps<typeof EditorBento>["revealPanel"];
  postBodyRef: Ref<BlockEditorHandle>;
  postBrandingMarkup: string;
  postTags: string[];
  presentationTagError: string | null;
  publishedRecordSlug: unknown;
  publishedTerms: ReturnType<typeof usePublishedVocabulary>;
  publishLiveBlogDirectly: (() => Promise<void>) | undefined;
  record: Record<string, unknown>;
  removeLiveBlog: () => void;
  reportDraftError: (field: EditorField, message: string | null) => void;
  reportingReveal: number;
  requestVocabulary: () => void;
  revealPostPanel: (id: string, fieldId?: string) => void;
  savedLiveBlog: LiveBlogDraft | undefined;
  sectionField: EditorField | null;
  sectionIsEditable: boolean;
  selectAsset: (field: EditorField, asset: MediaAssetSummary | null) => void;
  selfAuthorId: string | null;
  setField: (field: EditorField, value: unknown, options?: { removeOptionalOverride?: boolean }) => void;
  startLiveBlog: () => void;
  startLiveBlogRef: Ref<HTMLButtonElement>;
  submitPortalledForm: FormEventHandler<HTMLFormElement>;
}

export function RecordFormFields({
  accessibilityFieldsForAlt,
  allowIncomplete,
  assetForAccessibilityField,
  assetSuggestions,
  bylineAuthors,
  bylineAuthorsLoading,
  bylineAuthorsUnavailable,
  canEditCustomHtml,
  canManageAuthorProfiles,
  canManageSettings,
  canSave,
  canUploadCategory,
  changeCoverageLabel,
  changeField,
  changeLiveBlog,
  changePostBlocks,
  changeReportingDrafts,
  coverage,
  coverageRegistryMissing,
  dataHubReportingFigure,
  dataHubReportingTarget,
  defaultUploadCategory,
  editorView,
  electionSourceHost,
  errors,
  feedback,
  fields,
  focusNewLiveBlog,
  followUpBaselineKnown,
  formId,
  groups,
  hasInitialLeadMedia,
  heroFocusId,
  heroRevealRequest,
  homeHeroTarget,
  interactionLocked,
  isPostTitleOverrideField,
  isPostWritingField,
  jumpToField,
  kind,
  liveBlogDirectDisabledReason,
  liveBlogEntryKeys,
  liveBlogIssue,
  loadMedia,
  loadPublishedVocabulary,
  mediaCategories,
  mediaPickerUnavailable,
  newId,
  onMediaPickerDirtyChange,
  onReportingFigureReveal,
  pageId,
  postBentoReveal,
  postBodyRef,
  postBrandingMarkup,
  postInspector,
  postTags,
  presentationTagError,
  publishedRecordSlug,
  publishedTerms,
  publishLiveBlogDirectly,
  record,
  removeLiveBlog,
  reportDraftError,
  reportingReveal,
  reportingTransport,
  requestVocabulary,
  revealPostPanel,
  saveDisabledReason,
  savedLiveBlog,
  sectionField,
  sectionIsEditable,
  selectAsset,
  selfAuthorId,
  setField,
  startLiveBlog,
  startLiveBlogRef,
  submitPortalledForm,
  uploadMedia,
  writingTarget,
}: RecordFormFieldsProps) {
  const isPageWritingField = (field: EditorField): boolean =>
    kind === "page" &&
    field.path === undefined &&
    (field.key === "title" || field.key === "description");
  const pageWritingInMain = writingTarget !== undefined;

  const renderEditorField = (field: EditorField): ReactNode => {
    if (["contentLinkUrl", "contentLinkNewTab"].includes(field.key) && record.contentLinkMode !== "custom") return null;
    const pathKey = fieldPathKey(field);
    const fieldId = `record-${kind}-${pathKey.replaceAll(".", "-")}`;
    if (kind === "post" && field.key === "coverageLabelId") return record.liveBlog != null ? null
      : <CoverageLabelSelect key={pathKey} id={fieldId} record={record} disabled={interactionLocked || !canSave} onChange={changeCoverageLabel} />;
    if (kind === "post" && ["heroImageAlt", "heroImageDecorative", "heroImageCaption"].includes(field.key)) return null;
    if (kind === "post" && field.key === "heroImage") {
      const leadEditor = (imagePicker?: ComponentProps<typeof PostLeadMediaEditor>["imagePicker"]) => interactionLocked && hasInitialLeadMedia ? <PostLeadMediaReview record={record} loadMedia={loadMedia} onMediaPickerDirtyChange={onMediaPickerDirtyChange} /> : <PostLeadMediaEditor
        record={record} fieldId={fieldId} error={errors.heroImage} disabled={interactionLocked} imagePicker={imagePicker}
        onChange={value => setField({ ...field, key: "leadMedia" }, value)}
        loadMedia={loadMedia} mediaPickerUnavailable={mediaPickerUnavailable} uploadMedia={uploadMedia}
        mediaCategories={mediaCategories} defaultUploadCategory={defaultUploadCategory} canUploadCategory={canUploadCategory}
        onMediaPickerDirtyChange={onMediaPickerDirtyChange} />;
      return editorView?.kind === "post" ? <PostLeadMediaInspector key={pathKey} record={record} loadMedia={loadMedia} mediaPickerUnavailable={mediaPickerUnavailable} error={errors.heroImage}
        onRemove={interactionLocked ? undefined : () => setField({ ...field, key: "leadMedia" }, null)}>{leadEditor}</PostLeadMediaInspector> : <Fragment key={pathKey}>{leadEditor()}</Fragment>;
    }
    const value = readFieldValue(record, field);
    const postTitleOverride = isPostTitleOverrideField(kind, field);
    const hasPostTitleOverride =
      postTitleOverride && hasExplicitPostTitle(value);
    const displayedValue =
      postTitleOverride
        ? effectivePostTitle(value, record.title)
        : kind === "post" && field.key === "tags" ? publicPostTopics(postTags) : value;
    const required = fieldIsRequired(field, record);
    const displayField =
      field.required === required ? field : { ...field, required };
    const conditionalAsset = kind === "post" && field.key === "heroImageCaption"
      ? "heroImage"
      : assetForAccessibilityField(kind, field.key);
    if (
      conditionalAsset &&
      (typeof record[conditionalAsset] !== "string" ||
        record[conditionalAsset].trim() === "")
    ) {
      return null;
    }
    const altContext = accessibilityFieldsForAlt(kind, field.key);
    const suggestion =
      altContext &&
      typeof value === "string" &&
      value.trim() === "" &&
      record[altContext.decorative] !== true
        ? assetSuggestions[field.key]
        : undefined;
    return (
      <Fragment key={pathKey}>
      <FieldRenderer
        togglePresentation={editorView?.kind === "post" && ["spotlightNews", "showInHomeHero", "disableStoryCtas"].includes(field.key) ? "inline" : undefined}
        assetSummary={editorView?.kind === "post" && ["heroBackgroundImage", "heroImage"].includes(field.key) ? {
          label: field.key === "heroBackgroundImage" ? "Header background" : "Lead image",
          autoChoose: field.key === "heroImage", disabled: interactionLocked,
          description: field.key === "heroBackgroundImage" ? "Decorative · behind the heading" : "At the top of the article and in listings",
          relatedFields: groups.find(group => group.id === "hero-image")?.fields.filter(candidate => candidate !== field &&
            (field.key === "heroBackgroundImage" ? candidate.key.startsWith("heroBackground") : !candidate.key.startsWith("heroBackground"))).map(renderEditorField),
        } : undefined}
        selectPresentation={editorView?.kind === "post" && field.key === "heroBackgroundPosition" ? "crop" : undefined}
        textPresentation={editorView?.kind === "post" ? isPostWritingField(field) ? field.key === "title" ? "headline" : "summary" : !field.path && field.key === "slug" ? "identifier" : undefined : undefined}
        field={editorView?.kind === "post" ? isPostWritingField(field) && field.key === "title" ? { ...displayField, label: "Headline" } : field.key === "spotlightNews" ? { ...displayField, label: "Show NJ Spotlight News label" } : displayField : displayField}
        value={displayedValue}
        termSuggestions={kind === "post" && loadPublishedVocabulary && !field.path && (field.key === "tags" || field.key === "categories") ? {
          values: publishedTerms.vocabulary[field.key],
          ready: publishedTerms.status === "ready",
          onFocus: requestVocabulary,
          note: publishedTerms.status === "idle" ? "Type to find terms from published Posts."
            : publishedTerms.status === "loading" ? "Loading published suggestions…"
            : publishedTerms.status === "error" ? "Published suggestions are unavailable. You can still add terms."
            : "From published Posts. New terms are allowed.",
        } : undefined}
        onChange={(value) => {
          if (kind === "post" && field.key === "tags" && Array.isArray(value)) {
            const markers = postTags.filter(tag => tag.trim().toLowerCase().startsWith("format:"));
            changeField(field, [...publicPostTopics(value.filter((tag): tag is string => typeof tag === "string")), ...markers]);
          } else changeField(field, value);
        }}
        fieldId={fieldId}
        error={errors[pathKey]}
        warning={recommendedFieldWarning(field, value, { siblings: record })}
        loadMedia={loadMedia}
        mediaPickerUnavailable={mediaPickerUnavailable}
        uploadMedia={uploadMedia}
        mediaCategories={mediaCategories}
        defaultUploadCategory={defaultUploadCategory}
        canUploadCategory={canUploadCategory}
        onMediaPickerDirtyChange={onMediaPickerDirtyChange}
        onAssetSelect={
          field.kind === "asset"
            ? (asset) => selectAsset(field, asset)
            : undefined
        }
        suggestion={suggestion}
        onUseSuggestion={
          suggestion ? () => setField(field, suggestion) : undefined
        }
        valueStatus={
          postTitleOverride
            ? hasPostTitleOverride
              ? "Custom title"
              : "Using post title"
            : undefined
        }
        resetLabel={hasPostTitleOverride ? "Use post title" : undefined}
        onReset={
          hasPostTitleOverride
            ? () => {
                setField(field, "", { removeOptionalOverride: true });
                document.getElementById(fieldId)?.focus();
              }
            : undefined
        }
        bylineAuthors={bylineAuthors}
        bylineAuthorsUnavailable={bylineAuthorsUnavailable}
        onDraftError={(message) => reportDraftError(field, message)}
      />
      {field.key === "slug" && !field.path && kind === "event" && typeof record.slug === "string" && record.slug && (
        <p className="editor-field-static">Public URL: <code>{publicSiteOrigin}/events/{record.slug}/</code>{record.status === "published" && <> · <a href={`${publicSiteOrigin}/events/${publishedRecordSlug}/`} target="_blank" rel="noopener noreferrer">View live</a></>}</p>
      )}
      </Fragment>
    );
  };
  const renderFieldGroup = (
    group: (typeof groups)[number],
    groupFields: readonly EditorField[] = group.fields,
    headless = false,
  ) => renderRecordFieldGroup({
    group,
    groupFields,
    headless,
    kind,
    record,
    canManageSettings,
    editorView,
    interactionLocked,
    toggleReadonlyBoundary,
    renderEditorField,
    bylineAuthors,
    formId,
    presentation,
  });
  const renderSectionFieldset = (headless = false) => renderRecordSectionFieldset({
    sectionField,
    sectionIsEditable,
    headless,
    interactionLocked,
    toggleReadonlyBoundary,
    record,
    changeField,
    kind,
    errors,
  });
  const sectionFieldset = renderSectionFieldset();
  const postTitleField =
    kind === "post" ? fields.find((field) => field.key === "title" && field.path === undefined) : undefined;
  const postSummaryField =
    kind === "post" ? fields.find((field) => field.key === "summary" && field.path === undefined) : undefined;
  const pageTitleField =
    kind === "page" ? fields.find((field) => field.key === "title" && field.path === undefined) : undefined;
  const pageSummaryField =
    kind === "page" ? fields.find((field) => field.key === "description" && field.path === undefined) : undefined;
  const postBlocks = Array.isArray(record.blocks)
    ? (record.blocks as AdminBlock[])
    : [];
  const postRowCount = postBlocks.filter(block => block.type === "row").length;
  const postBlockCount = postBlocks.length - postRowCount;
  const compositionStatus = record.status === "draft" ? "working draft" : typeof record.status === "string" ? displayContentStatus(record.status) : "Status not set";
  const presentation = kind !== "post" ? "standard" : presentationTagError ? "" : resolvePostPresentation(postTags);
  const presentationRequirement = POST_PRESENTATIONS.find(choice => choice.value === presentation)?.requirements;
  const parsedPostBlocks = parseBlocks(postBlocks, { complete: !allowIncomplete });
  const presentationError = kind === "post" && parsedPostBlocks.ok
    ? postPresentationError({ tags: postTags, blocks: parsedPostBlocks.blocks, heroImage: record.heroImage, leadMedia: record.leadMedia }) : null;

  function toggleReadonlyBoundary(element: HTMLFieldSetElement | null) {
    element?.toggleAttribute("inert", interactionLocked);
  }

  const postPresentationField = (
    <div className="editor-field post-presentation-field">
      <div className="editor-field-label-row">
        <label className="editor-field-label" htmlFor={`${formId}-presentation`}>Presentation</label>
        {presentationRequirement ? <InfoTooltip label="Presentation" content={presentationRequirement} /> : null}
      </div>
      <Select
        disabled={interactionLocked}
        id={`${formId}-presentation`}
        value={presentation}
        aria-label="Presentation"
        aria-describedby={`${formId}-presentation-help`}
        aria-invalid={Boolean(presentationTagError)}
        onChange={event => {
          const field = fields.find(field => field.key === "tags");
          if (field) changeField(field, tagsWithPostPresentation(postTags, event.target.value as PostPresentation));
        }}
      >
        {presentationTagError ? <option value="">Choose a presentation</option> : null}
        {POST_PRESENTATIONS.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
      </Select>
      <p
        className={!presentationTagError && !presentationError ? "sr-only" : undefined}
        id={`${formId}-presentation-help`}
        role={presentationTagError ? "alert" : presentationError ? "status" : undefined}
      >
        {presentationTagError ?? presentationError ?? presentationRequirement}
        {!presentationTagError && presentationError ? " You can save this draft and complete it before approval." : null}
      </p>
    </div>
  );
  const storyMetaLink = (key: string) => {
    const field = fields.find(candidate => candidate.key === key);
    if (field) jumpToField(field);
  };
  const inPostWorkspace = editorView?.kind === "post";
  const { editorialDate, storyMeta } = renderPostStoryMetadata(record, bylineAuthors, inPostWorkspace, storyMetaLink);
  const postMetadataPanels = kind === "post" ? buildPostMetadataPanels({
    groups,
    inPostWorkspace,
    isPostWritingField,
    record,
    postTags,
    editorialDate,
    interactionLocked,
    renderFieldGroup,
  }) : [];
  const postPanels: BentoPanel[] =
    kind === "post" && postTitleField && postSummaryField
      ? [
          {
            id: "post-title",
            title: editorView?.kind ? "Article" : "Post title",
            subtitle: editorView?.kind ? `${postRowCount} ${postRowCount === 1 ? "row" : "rows"} · ${postBlockCount} ${postBlockCount === 1 ? "block" : "blocks"} · ${compositionStatus}` : undefined,
            presentation: editorView?.kind ? "article-title" : undefined,
            aside: editorView?.kind ? postPresentationField : undefined,
            outlineLabel: "Title and summary",
            defaultZone: "main",
            allowedZones: ["main"],
            body: (
              <>
              <fieldset
                className="editor-readonly-boundary post-editor-writing-boundary post-editor-title-fields"
                disabled={interactionLocked}
                ref={toggleReadonlyBoundary}
              >
                <legend className="sr-only">Post title</legend>
                {postBrandingMarkup ? <span dangerouslySetInnerHTML={{ __html: postBrandingMarkup }} /> : null}
                {renderEditorField(postTitleField)}
                {renderEditorField(postSummaryField)}
                {storyMeta}
              </fieldset>
              {renderSectionFieldset(true)}
              </>
            ),
          },
          {
            id: "post-body",
            title: "Post body",
            presentation: editorView?.kind ? "content" : undefined,
            outlineLabel: "Post body",
            defaultZone: "main",
            allowedZones: ["main"],
            body: (
              <div className="post-editor-writing-boundary" role="group" aria-label="Post body">
                {editorView?.kind ? null : <fieldset className="editor-readonly-boundary" disabled={interactionLocked} ref={toggleReadonlyBoundary}>{postPresentationField}</fieldset>}
                <BioCatalogProvider><BlockEditor
                  electionResultsApprovals={Array.isArray(record.electionResultsApprovals) ? record.electionResultsApprovals : undefined}
                  electionSourceHost={electionSourceHost ? { ...electionSourceHost, documentId: typeof record.id === "string" ? record.id : undefined, version: typeof record.version === "number" ? record.version : undefined, publicBlocks: Array.isArray((record.published as { blocks?: unknown[] } | undefined)?.blocks) ? (record.published as { blocks: AdminBlock[] }).blocks.filter(block => block.type === "election_results") : [] } : undefined}
                  ref={postBodyRef}
                  section="post"
                  liveBlogSidebar={record.liveBlog != null}
                  supplementalOutlineSections={record.liveBlog != null ? [{ label: "Live updates", onNavigate: () => revealPostPanel("post-live-blog", `${formId}-live-blog`) }] : undefined}
                  emptyDocumentKind="post"
                  canEditCustomHtml={canEditCustomHtml}
                  initialBlocks={postBlocks}
                  allowIncomplete={allowIncomplete}
                  newId={newId}
                  canSave={canSave}
                  saveDisabledReason={saveDisabledReason}
                  onDraftChange={changePostBlocks}
                  readOnly={interactionLocked}
                  readOnlyNotice={null}
                  showSaveAction={false}
                  commandsInline
                  commandLabel="Post editing commands"
                  loadMedia={loadMedia}
                  mediaPickerUnavailable={mediaPickerUnavailable}
                  uploadMedia={uploadMedia}
                  mediaCategories={mediaCategories}
                  defaultUploadCategory={defaultUploadCategory}
                  canUploadCategory={canUploadCategory}
                  onMediaPickerDirtyChange={onMediaPickerDirtyChange}
                /></BioCatalogProvider>
              </div>
            ),
          },
          {
            id: "post-live-blog", title: "Live updates", outlineLabel: "Live updates", defaultZone: "main" as const, allowedZones: ["main"] as const,
            body: record.liveBlog != null ? <>{coverageRegistryMissing ? <p>No coverage labels are published yet. You can still choose NJ Decides election artwork.</p> : null}<LiveBlogEditor value={record.liveBlog as LiveBlogDraft} saved={savedLiveBlog} followUpBaselineKnown={followUpBaselineKnown}
              coverageControl={coverage.status !== "unavailable" && !coverageRegistryMissing ? <CoverageLabelSelect record={record} id={`${formId}-live-blog-coverage`} disabled={interactionLocked || !canSave} onChange={changeCoverageLabel} /> : undefined}
              published={(record.published as { metadata?: { liveBlog?: LiveBlogData } } | undefined)?.metadata?.liveBlog}
              readOnly={interactionLocked || !canSave} onChange={changeLiveBlog} defaultCredits={record.credits as StoryCredit[]}
              focusOnMount={focusNewLiveBlog}
              onRemove={removeLiveBlog}
              authors={bylineAuthors} authorsUnavailable={bylineAuthorsUnavailable} authorsLoading={bylineAuthorsLoading} error={errors.liveBlog} publicationIssue={liveBlogIssue} controlId={`${formId}-live-blog`} entryKeys={liveBlogEntryKeys}
              selfAuthorId={selfAuthorId} canManageAuthorProfiles={canManageAuthorProfiles} showPublicationWarnings={!publishLiveBlogDirectly}
              media={{ loadMedia, mediaPickerUnavailable, uploadMedia, mediaCategories, defaultUploadCategory, canUploadCategory, onMediaPickerDirtyChange }} />
              {publishLiveBlogDirectly ? <LiveBlogDirectPublish disabledReason={liveBlogDirectDisabledReason} onPublish={publishLiveBlogDirectly}
                liveBlog={record.liveBlog as LiveBlogDraft} authors={bylineAuthors} authorsLoading={bylineAuthorsLoading} selfAuthorId={selfAuthorId} canManageAuthorProfiles={canManageAuthorProfiles} /> : null}</>
              : <Button ref={startLiveBlogRef} disabled={interactionLocked || !canSave} onClick={startLiveBlog}>Start live blog draft</Button>,
          },
          ...(record.liveBlog != null || presentation === "interactive" ? [{
            id: "post-sidebar",
            title: "Public sidebar",
            defaultZone: "side" as const,
            body: <PostSidebarEditor
              id={`${formId}-post-sidebar`}
              value={isPostSidebar(record.postSidebar) ? record.postSidebar : undefined}
              liveBlog={record.liveBlog != null}
              disabled={interactionLocked || !canSave}
              onChange={value => changeField({ key: "postSidebar", label: "Public sidebar", help: "", kind: "text", required: false }, value)}
            />,
          }] : []),
          ...postMetadataPanels,
          ...(postInspector
            ? [{
                id: "publication",
                title: "Lifecycle",
                subtitle: "Save, review, and publish this version.",
                defaultZone: "side" as const,
                body: (
                  <LifecycleFeedbackRevealProvider
                    onReveal={() => revealPostPanel("publication")}
                  >
                    <div className="post-editor-workflow">{postInspector}</div>
                  </LifecycleFeedbackRevealProvider>
                ),
              }]
            : []),
        ]
      : [];

  const pageWritingFields = pageWritingInMain && pageTitleField && pageSummaryField ? (
    <fieldset
      className="editor-readonly-boundary page-editor-title-fields post-editor-title-fields"
      disabled={interactionLocked}
      ref={toggleReadonlyBoundary}
    >
      <legend className="sr-only">Page title</legend>
      {renderEditorField(pageTitleField)}
      {renderEditorField(pageSummaryField)}
    </fieldset>
  ) : null;

  const homeHeroFields = kind === "page" && pageId === "home" ? (
    <HomeHeroModal value={record.homeHero} readOnly={interactionLocked} revealRequest={heroRevealRequest} focusTargetId={heroFocusId}
      preview={record.homeHero && typeof record.homeHero === "object" && (record.homeHero as { presentation?: unknown }).presentation === "editorial"
        ? <HomeHeroLayoutPreview value={record.homeHero} loadMedia={loadMedia}
            backgroundAssetId={typeof record.heroBackgroundImage === "string" ? record.heroBackgroundImage : undefined}
            backgroundPosition={record.heroBackgroundPosition === "center" || record.heroBackgroundPosition === "top" || record.heroBackgroundPosition === "bottom" ? record.heroBackgroundPosition : undefined} />
        : undefined}
      fallback={<><strong>{typeof record.homeHeroTitle === "string" && record.homeHeroTitle || "Current Home fallback"}</strong><p>{typeof record.homeHeroSubtitle === "string" ? record.homeHeroSubtitle : ""}</p></>}>
    <fieldset className="editor-readonly-boundary" disabled={interactionLocked} ref={toggleReadonlyBoundary}>
      <HomeHeroEditor
        selectionId={`${formId}-hero-selection`}
        value={record.homeHero} error={errors.homeHero}
        onDraftError={message => reportDraftError({ key: "homeHero", label: "Home hero", help: "Choose linked Home slides.", kind: "text", required: false }, message)}
        onChange={value => changeField({ key: "homeHero", label: "Home hero slides", help: "Choose linked Home slides.", kind: "text", required: false }, value)}
        loadMedia={loadMedia} mediaPickerUnavailable={mediaPickerUnavailable} uploadMedia={uploadMedia}
        mediaCategories={mediaCategories} defaultUploadCategory={defaultUploadCategory}
        canUploadCategory={canUploadCategory} onMediaPickerDirtyChange={onMediaPickerDirtyChange}
      />
      {homeHeroTarget ? groups.filter(group => group.id === "home-hero" || group.id === "hero-image").map(group => renderFieldGroup(group)) : null}
    </fieldset>
    </HomeHeroModal>
  ) : null;

  const reportingFields = kind === "page" && pageId === "data-hub" ? reportingTransport ? <DataHubReportingEditor
    selectedFigure={dataHubReportingFigure} onRevealFigure={onReportingFigureReveal}
    value={record.dataHubReporting} transport={reportingTransport} disabled={interactionLocked}
    controlId={`${formId}-reporting-control`} revealRequest={reportingReveal} error={errors.dataHubReporting}
    drafts={record._dataHubReportingDrafts as Record<string,string>}
    onDraftsChange={changeReportingDrafts}
    onDraftError={message => reportDraftError({key:"dataHubReporting",label:"Related reporting",help:"",kind:"text",required:false},message)}
    onChange={value => changeField({key:"dataHubReporting",label:"Related reporting",help:"",kind:"text",required:false},value)} />
    : <p role="status">Related reporting preview is unavailable. Reload this Page before editing its mapping.</p> : null;

  return kind === "post" && postTitleField && postSummaryField ? (
    <>
      <EditorBento
        storageKey="post"
        ariaLabel="Post editor sections"
        documentOutline={{
          heading: "Document",
          settingsLabel: "Post settings",
        }}
        panels={postPanels}
        revealPanel={postBentoReveal}
      />
      <fieldset
        className="editor-readonly-boundary post-editor-feedback-boundary"
        disabled={interactionLocked}
        ref={toggleReadonlyBoundary}
      >
        {feedback}
      </fieldset>
    </>
  ) : (
    <fieldset
      className="editor-readonly-boundary"
      disabled={interactionLocked}
      ref={toggleReadonlyBoundary}
    >
      {sectionFieldset}
      {groups.filter(group => !homeHeroTarget || (group.id !== "home-hero" && group.id !== "hero-image")).map((group) =>
        renderFieldGroup(
          group,
          pageWritingInMain ? group.fields.filter((field) => !isPageWritingField(field)) : group.fields,
        ))}
      {writingTarget ? createPortal(
        <form className="record-form" noValidate onSubmit={submitPortalledForm} id={`${formId}-writing`}>
          {pageWritingFields}
        </form>,
        writingTarget,
      ) : null}
      {homeHeroTarget ? createPortal(
        <form className="record-form" noValidate onSubmit={submitPortalledForm} id={`${formId}-hero`}>
          {homeHeroFields}
        </form>,
        homeHeroTarget,
      ) : homeHeroFields}
      <RetainedEditorHost target={dataHubReportingTarget ?? null}>{reportingFields}</RetainedEditorHost>
      {feedback}
    </fieldset>
  );
}
