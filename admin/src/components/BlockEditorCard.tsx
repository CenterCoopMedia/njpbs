import { HomeBandBackgroundField } from "./HomeBandBackgroundField";
import { ComponentPhonePreview } from "./ComponentPhonePreview";
import { BlockPreview } from "./BlockPreview";
import { ComponentEditorDialog } from "./ComponentEditorDialog";
import { EditorFrameHeader } from "./EditorFrameHeader";
import { RetainedEditorHost } from "./RetainedEditorHost";
import { EditorOverlayOwner } from "./EditorOverlayOwner";
import { EditorInlineWriting } from "../context/EditorInlineWriting";
import { BLOCK_TYPE_ICONS } from "./ContentPicker";
import { Menu, type MenuItem } from "./ui/Menu";
import { ControlSizingProvider } from "../context/ControlSizingContext";
import { useEditorWorkspaceView } from "../context/EditorWorkspaceView";
import { outlineSummary, outlineTypeLabel } from "../lib/content-outline";
import { dataHubFigureSection, type DataHubSectionData } from "../../../packages/content-core/src/data-hub-composition";
import type { DataHubFigure } from "../../../packages/content-core/src/data-hub-reporting";
import { lazy, memo, Suspense, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { BlockSettings, CustomHtmlEditing, InlineBlockSurface, isInlineBlockType } from "./InlineBlockSurface";
import { HOME_COMPOSITION_REGIONS } from "../../../packages/content-core/src/home-composition-contract";
import { LIVE_BLOG_SIDEBAR } from "../../../packages/content-core/src/live-blog-layout";
import { BLOCK_LABELS } from "../../../packages/content-core/src/editor-admin";
import type { CoverageEntry } from "../../../packages/content-core/src/content-model";
import type { HomeSourceSnapshot } from "../../../packages/content-core/src/home-rail-render";
import type { AdminBlock } from "../lib/block-factory";
import { blockHasSettings } from "../lib/block-settings";
import type { RemovalPrompt } from "../lib/destructive-actions";
import type { MediaCategoryDefinition } from "../lib/functions";
import type { MediaPickerLoader } from "./MediaPickerDialog";
import type { MediaUploader } from "./MediaUploadForm";
import { ActionControl } from "./ui/ActionControl";
import { Icon } from "./ui/Icon";
import { Button, InlineMessage, Panel } from "./ui/Primitives";
import { deferEditor } from "./DeferredEditor";

export type BlockReportingSelectionHandler = (selection: { target: HTMLElement; figure: DataHubFigure | "featured" } | null) => void;

const DataHubSectionFields = lazy(() => import("./DataHubSectionFields").then(module => ({ default: module.DataHubSectionFields })));

export function blockCardDomId(id: string): string {
  return `block-card-${id}`;
}

// One stable component and request per secondary owner. Idle preloading and a
// first render share the same result; already loaded owners never suspend again.
const newscastEditor = deferEditor(() => import("./HomeNewscastEditor").then(module => module.HomeNewscastEditor), "Content details");
const newsletterEditor = deferEditor(() => import("./HomeNewsletterEditor").then(module => module.HomeNewsletterEditor), "Content details");
const donorEditor = deferEditor(() => import("./HomeDonorEditor").then(module => module.HomeDonorEditor), "Content details");
const curatedShelfEditor = deferEditor(() => import("./HomeCuratedShelfEditor").then(module => module.HomeCuratedShelfEditor), "Content details");
const HomeNewscastEditor = newscastEditor.Editor;
const HomeNewsletterEditor = newsletterEditor.Editor;
const HomeDonorEditor = donorEditor.Editor;
const HomeCuratedShelfEditor = curatedShelfEditor.Editor;
export function warmHomeEditors() {
  void Promise.allSettled([newscastEditor.preload(), newsletterEditor.preload(), donorEditor.preload(), curatedShelfEditor.preload()]);
}

// One placed block, memoized on its own props.
//
// The reducer preserves the object identity of every block an edit did not touch, and the handlers
// the editor passes are id-based and stable, so a per-block edit changes this card's props for exactly one
// card and React re-renders exactly that one. Before, typing in a block re-rendered every card and
// its whole field tree, which on a page at the 40-block cap made one keystroke about three and a
// half times the work it had to be (#511).
//
// Nothing about correctness rests on the memo: it drops renders whose output would be identical.
// A change that alters what a card shows -- a move (its position), an authored heading above it
// (its generated rank), a save refusal (its markers), a removal question -- arrives as a changed
// prop and still re-renders it.
export const BlockCard = memo(function BlockCard({
  onLiveBlogSidebar,
  placementControls,
  onReportingSelectionChange,
  block, blocks, dataHubSections, selected = false, regionLabel, editName, showPageSeedAssets, generatedHeadingLevel,
  index, errors, loadMedia, mediaPickerUnavailable, uploadMedia, mediaCategories,
  defaultUploadCategory, canUploadCategory, onMediaPickerDirtyChange, onActivate,
  onChange, onHomeText, onConvertCoverage, coverageCardCapacity, onRemove, onDuplicate, onCancelRemove, onConfirmRemove, removalPrompt,
  onToggleVisible, textLinkActions = false, homeShelf = false, arrangeHomeSection = false, readOnly = false, editRequest, location, loadHomeSources,
}: {
  block: AdminBlock;
  onLiveBlogSidebar?: (id: string, sidebar: boolean) => void;
  onReportingSelectionChange?: BlockReportingSelectionHandler;
  placementControls?: ReactNode;
  blocks?: AdminBlock[];
  dataHubSections?: readonly string[];
  selected?: boolean;
  readOnly?: boolean;
  editRequest?: { id: string; column?: number; sequence: number };
  location?: string;
  homeShelf?: boolean;
  arrangeHomeSection?: boolean;
  loadHomeSources?: (signal: AbortSignal) => Promise<HomeSourceSnapshot>;
  textLinkActions?: boolean;
  regionLabel: string | null;
  editName?: string;
  showPageSeedAssets: boolean;
  generatedHeadingLevel: number;
  index: number;
  errors?: string[];
  loadMedia?: MediaPickerLoader;
  mediaPickerUnavailable?: boolean;
  uploadMedia?: MediaUploader;
  mediaCategories?: readonly MediaCategoryDefinition[];
  defaultUploadCategory?: string;
  canUploadCategory?: (category: string) => boolean;
  onMediaPickerDirtyChange?: (dirty: boolean) => void;
  onActivate: (id: string) => void;
  onChange: (id: string, data: Record<string, unknown>, discrete?: boolean) => void;
  onHomeText?: (value: string) => void;
  onConvertCoverage?: (id: string, entries: CoverageEntry[]) => void;
  coverageCardCapacity: number;
  onRemove: (id: string, position: number) => void;
  onDuplicate: (id: string) => void;
  onCancelRemove: () => void;
  onConfirmRemove: (id: string, position: number) => void;
  removalPrompt: RemovalPrompt | null;
  onToggleVisible: (id: string) => void;
}) {
  const view = useEditorWorkspaceView();
  const [dialogFieldsTarget, setDialogFieldsTarget] = useState<HTMLDivElement | null>(null);
  const [dialogSettingsTarget, setDialogSettingsTarget] = useState<HTMLDivElement | null>(null);
  const [canvasTarget, setCanvasTarget] = useState<HTMLDivElement | null>(null);
  const writingInline = view?.kind === "post" && block.type === "prose";
  const [fieldsVisited, setFieldsVisited] = useState(!view?.kind || selected || writingInline);
  useEffect(() => { if (selected || writingInline) setFieldsVisited(true); }, [selected, writingInline]);
  const renderFields = fieldsVisited || selected || writingInline || !view?.kind;
  const fieldsTarget = writingInline ? canvasTarget : view?.kind && selected ? view.selectionTarget : dialogFieldsTarget;
  const settingsTarget = view?.kind && selected ? view.selectionTarget : dialogSettingsTarget;
  const [open, setOpen] = useState(false);
  const [reportingTarget, setReportingTarget] = useState<HTMLDivElement | null>(null);
  const hubFigure = block.type === "data_hub_section" ? block.data.sectionId as DataHubSectionData["sectionId"] : undefined;
  const hasReporting = hubFigure && (hubFigure === "featured" || dataHubFigureSection(hubFigure));
  useEffect(() => {
    if (!selected || (!view?.kind && !open) || !reportingTarget || !hasReporting) return;
    onReportingSelectionChange?.({ target: reportingTarget, figure: hubFigure as DataHubFigure | "featured" });
    return () => onReportingSelectionChange?.(null);
  }, [selected, view?.kind, open, reportingTarget, hasReporting, hubFigure, onReportingSelectionChange]);
  const customHtmlLocked = !useContext(CustomHtmlEditing) && block.type === "html";
  const lastRequest = useRef(0);
  const editButton = useRef<HTMLButtonElement>(null);
  const removeButton = useRef<HTMLButtonElement | null>(null);
  // Labels belong to this editor instance, never the saved figure payload.
  const figureKey = block.type === "data_figure" ? JSON.stringify([block.data.datasetId, block.data.version]) : "";
  const [figureLabel, setFigureLabel] = useState<{ key: string; label: string | null } | null>(null);
  const resolveFigureLabel = useCallback((label: string | null) => {
    setFigureLabel(current => current?.key === figureKey && current.label === label ? current : { key: figureKey, label });
  }, [figureKey]);
  const resolvedFigureLabel = figureLabel?.key === figureKey ? figureLabel.label : null;
  const label = BLOCK_LABELS[block.type];
  const position = index + 1;
  const title = `${label} ${position}`;
  const displayType = outlineTypeLabel(block);
  const staffTitle = block.type === "data_figure" ? resolvedFigureLabel ?? displayType : (arrangeHomeSection || homeShelf ? outlineSummary(block) : regionLabel ?? outlineSummary(block));
  const resolvedEditName = block.type === "data_figure" ? `${staffTitle} ${position}` : editName ?? regionLabel ?? title;
  const actionName = block.type === "data_figure" || block.section === LIVE_BLOG_SIDEBAR ? `${staffTitle} ${position}` : staffTitle || displayType;
  const separateTitle = staffTitle.toLocaleLowerCase() !== displayType.toLocaleLowerCase();
  const requiredHomeRegion = HOME_COMPOSITION_REGIONS.some(([section]) => section === block.section) || (arrangeHomeSection && ["home-posts", "home-donor", "home-newsletter", "home-newscast"].includes(block.section ?? ""));
  const headingId = `block-${block.id}-heading`;
  const regionId = `block-${block.id}-region`;
  const hiddenId = `block-${block.id}-hidden`;
  const errorId = errors ? `block-${block.id}-error` : undefined;
  const changeData = useCallback((data: Record<string, unknown>, discrete = false) => {
    if (!readOnly) onChange(block.id, data, discrete);
  }, [block.id, onChange, readOnly]);
  const convertCoverage = useCallback((entries: CoverageEntry[]) => {
    onConvertCoverage?.(block.id, entries);
  }, [block.id, onConvertCoverage]);

  // Only an explicit request opens fields. Selection follows ordinary focus and save receipts.
  useEffect(() => {
    if (readOnly) {
      lastRequest.current = editRequest?.sequence ?? lastRequest.current;
      setOpen(false);
      return;
    }
    if (!editRequest || editRequest.sequence === lastRequest.current) return;
    lastRequest.current = editRequest.sequence;
    if (view?.kind) {
      if (editRequest.id === block.id) {
        view.setSpecialSelection(null);
        if (writingInline) canvasTarget?.querySelector<HTMLElement>('[contenteditable="true"]')?.focus();
        else {
          view.openPane("details", "selection");
          const sequence = editRequest.sequence;
          requestAnimationFrame(() => requestAnimationFrame(() => {
            if (sequence !== lastRequest.current || readOnly) return;
            const fields = document.querySelector<HTMLElement>(`[data-editor-block="${CSS.escape(block.id)}"]`);
            const target = fields?.querySelector<HTMLElement>('[aria-invalid="true"], input:not([type="hidden"]), textarea, select, [contenteditable="true"]');
            target?.focus();
          }));
        }
      }
      setOpen(false);
    } else setOpen(editRequest.id === block.id);
  }, [editRequest, block.id, readOnly, view?.kind, view?.openPane, view?.setSpecialSelection, writingInline, canvasTarget]);

  function close() {
    setOpen(false);
    onCancelRemove();
  }

  function beginEditing() {
    if (readOnly) return;
    onActivate(block.id);
    if (view?.kind) {
      if (writingInline) canvasTarget?.querySelector<HTMLElement>('[contenteditable="true"]')?.focus();
      else view.openPane("details", "selection");
    } else setOpen(true);
  }
  const menuItems: MenuItem[] = [
    { key: "details", label: "Content details", icon: "panel-right", onSelect: () => { onActivate(block.id); view?.openPane("details", "selection"); } },
    { key: "visibility", label: block.visible ? "Hide from page" : "Show on page", icon: block.visible ? "eye-off" : "eye",
      hidden: requiredHomeRegion && !arrangeHomeSection || customHtmlLocked && !block.visible,
      onSelect: () => { if (!readOnly) onToggleVisible(block.id); } },
    { key: "duplicate", label: "Duplicate", icon: "content", hidden: block.section !== undefined || block.type === "data_hub_section" || customHtmlLocked,
      onSelect: () => { if (!readOnly) onDuplicate(block.id); } },
    { key: "remove", label: "Remove", icon: "trash", danger: true, hidden: requiredHomeRegion,
      onSelect: () => { if (!readOnly) { onActivate(block.id); view?.openPane("details", "selection"); onRemove(block.id, position); } } },
  ];
  const settings = (view?.kind && !blockHasSettings(block.type) && !removalPrompt && !onLiveBlogSidebar) || requiredHomeRegion && !arrangeHomeSection ? null : <fieldset disabled={readOnly} className="block-card-settings">
    <legend>Settings</legend>
    {onLiveBlogSidebar ? <label className="editor-field">Destination
      <select value={block.section === LIVE_BLOG_SIDEBAR ? "sidebar" : "body"}
        onChange={event => { if (!readOnly) onLiveBlogSidebar(block.id, event.target.value === "sidebar"); }}>
        <option value="body">Post body</option>
        <option value="sidebar">Live updates sidebar</option>
      </select>
      <span className="muted">Beside updates on desktop, after updates on smaller screens. Move a plank outside its row to use this destination.</span>
    </label> : null}
    {!view?.kind ? <><ActionControl action={block.visible ? "hide" : "show"}
      label={arrangeHomeSection && requiredHomeRegion ? block.visible ? "Remove section from page" : "Add section to page" : block.visible ? "Hide from page" : "Show on page"} contextLabel={title}
      disabled={customHtmlLocked && !block.visible}
      onClick={() => { if (!readOnly) onToggleVisible(block.id); }} />
    </> : null}
    {blockHasSettings(block.type) ? <BlockSettings block={block} onChange={changeData} /> : null}
    {!view?.kind && block.section === undefined ? <Button disabled={customHtmlLocked} aria-label={`Duplicate ${title}`} onClick={() => { if (!readOnly) onDuplicate(block.id); }}>Duplicate</Button> : null}
    {!view?.kind && !requiredHomeRegion ? <Button variant="danger-quiet" ref={removeButton} aria-label={`Remove ${title}`}
      onClick={() => { if (!readOnly) onRemove(block.id, position); }}><Icon name="trash" /><span>Remove</span></Button> : null}
    {removalPrompt ? <InlineMessage tone="warning" title={removalPrompt.title}>
      <p>{removalPrompt.detail}</p>
      <div className="button-row">
        <Button aria-label={removalPrompt.cancelLabel} onClick={() => { onCancelRemove(); removeButton.current?.focus(); }}>Cancel</Button>
        <Button variant="danger" aria-label={removalPrompt.confirmLabel} onClick={() => { if (!readOnly) onConfirmRemove(block.id, position); }}>Remove</Button>
      </div>
    </InlineMessage> : null}
  </fieldset>;

  return <Panel data-selected={selected || undefined} id={blockCardDomId(block.id)} tabIndex={-1}
    onFocusCapture={() => onActivate(block.id)}
    onClick={view?.kind ? () => onActivate(block.id) : undefined}
    data-editor-frame={view?.kind ?? undefined}
    className={`block-card block-card-${block.type}${errors ? " block-card-invalid" : ""}${block.visible ? "" : " block-card-hidden"}`}
    aria-label={[regionLabel, label, block.visible ? null : "Hidden from page"].filter(Boolean).join(" ")}>
    <EditorFrameHeader
      scope="block"
      selected={selected}
      className="block-card-head"
      leading={view?.kind ? <Icon name={block.type === "content_shelf" ? "grid" : block.type === "newsletter_signup" ? "mail" : BLOCK_TYPE_ICONS[block.type]} /> : <span className="block-card-index" aria-hidden="true">{position}</span>}
      title={<span className="block-card-kind" id={headingId}>{view?.kind ? view.kind === "page" || block.type === "data_figure" ? staffTitle : block.type === "prose" ? "Story text" : block.type === "image" ? "Story image" : displayType : label}</span>}
      meta={view?.kind ? <>{!block.visible ? <span className="block-card-hidden-flag" id={hiddenId}>Hidden from page</span> : null}</> : separateTitle || !block.visible ? <>
        {separateTitle ? <span className="block-card-title" id={regionId} title={staffTitle}>{staffTitle}</span> : null}
        {!block.visible ? <span className="block-card-hidden-flag" id={hiddenId}>Hidden from page</span> : null}
      </> : undefined}
      actions={<ControlSizingProvider size={view?.kind ? "compact" : "legacy"}>{view?.kind ? requiredHomeRegion && !arrangeHomeSection ? <span className="editor-fixed-tag"><Icon name="lock" />Fixed</span> : null : placementControls}<ActionControl action="settings" graphic={<Icon name="pencil" />} label="Edit" accessibleName={`Edit ${resolvedEditName}`} ref={editButton} disabled={readOnly} aria-haspopup={view?.kind ? undefined : "dialog"} aria-expanded={view?.kind ? undefined : open}
        onClick={beginEditing} />{view?.kind ? <Menu variant="ghost" label={`${actionName} actions`} items={menuItems} disabled={readOnly} tooltip={`${actionName} actions`} /> : null}</ControlSizingProvider>}
    />
    {writingInline ? <div className="post-inline-writing" ref={setCanvasTarget} /> : <BlockPreview resolvedDataFigureLabel={resolvedFigureLabel ?? undefined} editorFrame={view?.kind ?? undefined} onInspect={beginEditing} onMediaPickerDirtyChange={onMediaPickerDirtyChange} block={block} loadMedia={loadMedia} showPageSeedAssets={showPageSeedAssets} generatedHeadingLevel={generatedHeadingLevel} />}
    {errors?.length ? <p className="error-text">{errors.length} {errors.length === 1 ? "field needs" : "fields need"} attention. Open this content to correct it.</p> : null}
    <ComponentEditorDialog variant="content" open={open} onClose={close} title={resolvedEditName} disabled={readOnly}
      description={location ?? regionLabel ?? "Page content"} settings={<div ref={setDialogSettingsTarget} />}
      preview={<ComponentPhonePreview block={block} blocks={arrangeHomeSection && block.section?.startsWith("home-passport-") ? blocks : undefined} homeV2={arrangeHomeSection} loadMedia={loadMedia} loadHomeSources={loadHomeSources} showPageSeedAssets={showPageSeedAssets} generatedHeadingLevel={generatedHeadingLevel} />}>
      <div ref={setDialogFieldsTarget} />
    </ComponentEditorDialog>
    <EditorOverlayOwner.Provider value={writingInline || (view?.kind && !view.phone) ? null : fieldsTarget?.closest<HTMLDialogElement>("dialog") ?? null}>
      <EditorInlineWriting.Provider value={{ inline: writingInline, readOnly }}>
        <RetainedEditorHost target={fieldsTarget} overlayOwner={view?.kind && !view.phone ? null : undefined}>
          {renderFields ? <fieldset data-editor-block={block.id} className="editor-readonly-boundary editor-retained-content-fields" disabled={readOnly} ref={element => element?.toggleAttribute("inert", readOnly)}>
            <legend className="sr-only">{displayType} fields</legend>
      {arrangeHomeSection && ["home-newsletter", "home-passport-copy", "home-donor"].includes(block.section ?? "") ?
        <HomeBandBackgroundField block={block} readOnly={readOnly} onChange={changeData}
          loadMedia={loadMedia} mediaPickerUnavailable={mediaPickerUnavailable} uploadMedia={uploadMedia}
          mediaCategories={mediaCategories} defaultUploadCategory={defaultUploadCategory}
          canUploadCategory={canUploadCategory} onMediaPickerDirtyChange={onMediaPickerDirtyChange} /> : null}
      {errors ? <p className="error-text" id={errorId} role="alert">{errors.join(" ")}</p> : null}
      {block.type === "data_hub_section" ? <Suspense fallback={<p role="status">Loading section details…</p>}><DataHubSectionFields block={block} usedSections={dataHubSections ?? []} onChange={changeData} /></Suspense> : null}
      {hasReporting ? <div ref={setReportingTarget} /> : null}
      <Suspense fallback={<p role="status">Opening content details…</p>}>
      {arrangeHomeSection && block.section === "home-newscast" ? <HomeNewscastEditor block={block} readOnly={readOnly} onChange={changeData} loadSources={loadHomeSources} /> : arrangeHomeSection && block.section === "home-newsletter" ? <HomeNewsletterEditor block={block} readOnly={readOnly} onChange={changeData} loadSources={loadHomeSources} /> : arrangeHomeSection && block.section === "home-donor" ? <HomeDonorEditor block={block} readOnly={readOnly} onChange={changeData} /> : arrangeHomeSection && block.type === "content_shelf" ? <HomeCuratedShelfEditor block={block} blocks={blocks ?? [block]} readOnly={readOnly} onChange={changeData} loadSources={loadHomeSources} /> : isInlineBlockType(block.type) ? <InlineBlockSurface homeShelf={homeShelf} block={block} readOnly={readOnly}
        textLinkActions={textLinkActions} generatedHeadingLevel={generatedHeadingLevel} onChange={changeData}
        onHomeText={onHomeText}
        onRemoveImage={view?.kind && !requiredHomeRegion ? trigger => {
          removeButton.current = trigger;
          onRemove(block.id, position);
        } : undefined}
        onResolvedDataFigureLabel={resolveFigureLabel}
        onConvertCoverage={onConvertCoverage ? convertCoverage : undefined}
        coverageCardCapacity={coverageCardCapacity}
        hasError={Boolean(errors)} errorId={errorId} showPageSeedAssets={showPageSeedAssets}
        loadMedia={loadMedia} mediaPickerUnavailable={mediaPickerUnavailable} uploadMedia={uploadMedia}
        mediaCategories={mediaCategories} defaultUploadCategory={defaultUploadCategory}
        canUploadCategory={canUploadCategory} onMediaPickerDirtyChange={onMediaPickerDirtyChange} /> : null}
      </Suspense>
          </fieldset> : null}
        </RetainedEditorHost>
        <RetainedEditorHost target={settingsTarget}>{settings}</RetainedEditorHost>
      </EditorInlineWriting.Provider>
    </EditorOverlayOwner.Provider>
  </Panel>;
});
