import { MoveContentDialog } from "./MoveContentDialog";
import { HomeBandBackgroundField } from "./HomeBandBackgroundField";
import { EditorHistoryControls } from "../context/EditorTextHistory";
import { createHomeNewscastBlock } from "../../../packages/content-core/src/home-newscast-section";
import { createHomeNewsletterBlock } from "../../../packages/content-core/src/home-newsletter-section";
import { CONTENT_SHELF_PRESENTATIONS, isRichTextDoc, richTextIsEmpty } from "../../../packages/content-core/src/content-model";
import { ComponentPhonePreview } from "./ComponentPhonePreview";
import { apResultsLayoutSrc } from "../../../packages/content-core/src/embed-player";
import { BlockPreview } from "./BlockPreview";
import { ComponentEditorDialog } from "./ComponentEditorDialog";
import { EditorFrameHeader } from "./EditorFrameHeader";
import { homeCompositionGroups, homeContentAreas, homeStructuralBlocks, homeStructuralMoveNeighbors, isHomeLockedAuthoringSection } from "../../../packages/content-core/src/home-composition";
import { homeLayoutsEnabled } from "../lib/home-layouts";
import { HomeAddMenu, type OptionalHomeSection } from "./HomeAddMenu";
import { createHomeDonorBlock } from "../../../packages/content-core/src/home-donor-section";
import { HOME_COMPOSITION_REGIONS, homeCompositionError, homePassportHeading } from "../../../packages/content-core/src/home-composition-contract";
import type { ReadOnlyNotice } from "../lib/editor-save-decisions";
import "./page-outline.css";
import { RetainedEditorHost } from "./RetainedEditorHost";
import { EditorOverlayOwner } from "./EditorOverlayOwner";
import { EditorInlineWriting } from "../context/EditorInlineWriting";
import { Menu, type MenuItem } from "./ui/Menu";
import { BLOCK_TYPE_ICONS } from "./ContentPicker";
import { ControlSizingProvider } from "../context/ControlSizingContext";
import { useEditorWorkspaceView } from "../context/EditorWorkspaceView";
import { AddContent } from "./ContentPicker";
import { contentColumnDomId, outlineSummary, outlineTypeLabel } from "../lib/content-outline";
import { ContentRowCanvas, type ContentSectionFrame } from "./ContentRowCanvas";
import { contentSiblings, type ContentDestination } from "../lib/content-row-editing";
import type { HomeSourceSnapshot } from "../../../packages/content-core/src/home-rail-render";
import { BLOCK_DESCRIPTIONS } from "../lib/block-descriptions";
import { nextDataHubSection } from "../lib/data-hub-page-seed";
import { dataHubFigureSection, type DataHubSectionData } from "../../../packages/content-core/src/data-hub-composition";
import type { DataHubFigure } from "../../../packages/content-core/src/data-hub-reporting";
import { useDismissibleOverlay } from "../hooks/useDismissibleOverlay";
import {
  forwardRef,
  lazy,
  Suspense,
  memo,
  useCallback,
  useContext,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  BlockSettings,
  CustomHtmlEditing,
  InlineBlockSurface,
  isInlineBlockType,
} from "./InlineBlockSurface";
import { useSaveFlight } from "../hooks/useSaveFlight";
import { blocksEqual } from "../lib/block-equality";
import { reconcileBlockId } from "../lib/block-editor-state";
import type { SavedEditorReceipt } from "../lib/editor-save-receipt";
import { useBlockEditor } from "../hooks/useBlockEditor";
import { visibleLayoutBlocks } from "../../../packages/content-core/src/content-layout";
import {
  contradictedBlockContent,
  missingBlockContent,
} from "../lib/field-validation";
import {
  isConflictError,
  type MediaCategoryDefinition,
} from "../lib/functions";
import {
  parseBlocks,
  type BlockType,
  type CoverageEntry,
} from "../../../packages/content-core/src/content-model";
import { generatedHeadingLevels } from "../../../packages/content-core/src/heading-outline";
import {
  insertableBlocksForSection,
  SECTION_BLOCK_TOTAL_MAX,
  editorFieldsForBlock,
  apResultsEditorFields,
  validateSection,
  BLOCK_LABELS,
  type SectionId,
} from "../../../packages/content-core/src/editor-admin";
import { createBlock, type AdminBlock } from "../lib/block-factory";
import { blockHasSettings } from "../lib/block-settings";
import type { PublicPageId } from "../../../packages/content-core/src/public-pages";
import {
  pageCompositionRegionLabel,
  pageHasCompositionSeed,
} from "../../../packages/content-core/src/page-composition-seeds";
import {
  AsyncActionButton,
  Button,
  EmptyState,
  InlineMessage,
  Panel,
  Toolbar,
} from "./ui/Primitives";
import { useSuccessNotice } from "./ui/SuccessNoticeRegion";
import { Icon } from "./ui/Icon";
import { ActionControl } from "./ui/ActionControl";
import type { MediaPickerLoader } from "./MediaPickerDialog";
import type { MediaUploader } from "./MediaUploadForm";
import {
  readLayoutDisclosure,
  writeLayoutDisclosure,
} from "../lib/layout-preferences";
import { deferEditor } from "./DeferredEditor";
import { WorkspaceActions, WorkspaceSecondaryActions } from "./WorkspaceActions";
import { RemovalNoticeProvider } from "../context/RemovalNoticeContext";
import { ElectionResultsSourceHost, type ElectionSourceHost } from "../context/ElectionResultsSourceHost";
import { ElectionResultsReview } from "../context/ElectionResultsReview";
import type { ElectionRaceApproval } from "../../../packages/content-core/src/election-results";
import {
  blockIsPopulated,
  blockRemovalPrompt,
  removedBlockNotice,
  removedItemNotice,
  type RemovalPrompt,
} from "../lib/destructive-actions";

const ElectionResultsSourceControls = lazy(() => import("./ElectionResultsEditor").then(module => ({ default: module.ElectionResultsSourceControls })));

const DataHubSectionFields = lazy(() => import("./DataHubSectionFields").then(module => ({ default: module.DataHubSectionFields })));

import { LIVE_BLOG_SIDEBAR, canPlaceInLiveBlogSidebar, splitLiveBlogBlocks } from "../../../packages/content-core/src/live-blog-layout";

interface BlockEditorProps {
  liveBlogSidebar?: boolean;
  electionSourceHost?: ElectionSourceHost;
  electionResultsApprovals?: readonly ElectionRaceApproval[];
  supplementalOutlineSections?: readonly { label: string; onNavigate: () => void }[];
  onReportingSelectionChange?: (selection: {target: HTMLElement; figure: DataHubFigure | "featured"} | null) => void;
  section: SectionId;
  pageId?: PublicPageId;
  pageTitle?: string;
  pageDescription?: string;
  homeCompositionVersion?: 1 | 2;
  loadHomeSources?: (signal: AbortSignal) => Promise<HomeSourceSnapshot>;
  // A public-page adapter can narrow a template's insertion palette when that route owns only a
  // subset of the compatible stored block catalog. The server remains authoritative; this keeps
  // the visible choices aligned with what the public renderer will use.
  allowedBlockTypes?: readonly BlockType[];
  // Only a principal with content.publish may add or change custom HTML; the save
  // boundary refuses anyone else. False hides it from the palette and locks its fields.
  canEditCustomHtml?: boolean;
  emptyDocumentKind?: "page" | "post";
  initialBlocks?: AdminBlock[];
  // Draft surfaces may preserve unfinished required content. Structural, type, and safety
  // checks remain active; complete validation stays the default.
  allowIncomplete?: boolean;
  // A block id generator, injected in tests for deterministic ids. Production leaves it
  // unset and the hook uses crypto.randomUUID.
  newId?: () => string;
  // When set, the editor shows a Save button that runs the page through the save boundary
  // (validateSection) and hands the valid block list to onSave. A save that returns a promise
  // drives the async persist path: the button shows "Saving…", a rejection surfaces the
  // server's message, and a resolved save receipt is adopted as the new baseline so the editor
  // takes the server's canonical ids (#515). A void return keeps the synchronous "Saved."
  // confirmation used by the in-memory mock. Absent means a standalone editor with no save
  // affordance.
  // `force` carries the person's "Save anyway" answer to a conflict: save this content onto
  // whatever is stored now, overwriting the change this editor never saw. The host decides
  // what that means on the wire (it drops the echoed base version); the editor only reports
  // when that destructive answer is available.
  onSave?: (
    blocks: AdminBlock[],
    options?: { force?: boolean },
  ) => void | Promise<BlockSaveResult | void>;
  // Re-read the page from the store and reseed this editor, discarding unsaved blocks. The
  // conflict banner's non-overwrite answer. A host that can reload should always pass it; it is
  // the only safe resolution when allowConflictOverwrite is false.
  onReload?: () => void;
  // Most version conflicts may be resolved by explicitly overwriting the stored page. A
  // create-only conflict is different: this editor loaded no page-id document, so it has never
  // seen the page another editor just created and cannot knowingly overwrite it. In that case
  // the host sets this false and reload is the only safe answer.
  allowConflictOverwrite?: boolean;
  conflictCopy?: { title: string; message: string; reloadLabel: string };
  // Whether the signed-in role may save. When false the Save button renders disabled and
  // says why, rather than vanishing, so an editor sees the page is read-only to them.
  canSave?: boolean;
  // Optional host-level reason the save is temporarily unavailable. Capability copy remains
  // the default, while the workspace can explain a courtesy-lock claim without falsely saying
  // the signed-in role lacks permission.
  saveDisabledReason?: string;
  /** Why the canvas is inert. Null hides the notice when an embedding form already shows it. */
  readOnlyNotice?: ReadOnlyNotice | null;
  // Raised true while an async save is in flight and false when it settles, so the workspace
  // can hold navigation until the save resolves. Without it, navigating away mid-save would
  // unmount this editor, and the save's resolution would land on an unmounted component —
  // hiding a failure and losing the edited blocks with no retry path.
  onSavingChange?: (saving: boolean) => void;
  // Raised with the live block list every time it changes after the initial seed, so the host
  // can keep the work when this editor unmounts (#579). This editor is keyed on its section,
  // so leaving the surface destroys it and its state; the host holds the draft instead and
  // seeds the next mount from it.
  //
  // `null` says this page has nothing unsaved and the host should drop any draft it holds. It
  // is raised by a save that landed with no edit in flight, which is the only moment the live
  // blocks are known to match the store. A save is not otherwise a clean commit point: an edit
  // made while the save was in flight is still unsaved, which is why `reconcileIds` preserves
  // the undo stack, and clearing on every save would drop exactly that edit.
  onDraftChange?: (blocks: AdminBlock[] | null) => void;
  // A revision restore replaces the complete editor-owned snapshot when it settles. Freeze all
  // page controls during that request so no accepted local edit can be discarded by the reload.
  readOnly?: boolean;
  showSaveAction?: boolean;
  // Embedded block editors keep their local editing commands beside the block canvas instead
  // of adding them to the document-level workspace header. Page editors use the header by
  // default; a post body is embedded inside the record form and opts into the inline placement.
  commandsInline?: boolean;
  commandLabel?: string;
  // The authenticated image browser is injected by the workspace so this editor stays
  // independent of authentication and remains directly renderable in tests.
  loadMedia?: MediaPickerLoader;
  mediaPickerUnavailable?: boolean;
  uploadMedia?: MediaUploader;
  mediaCategories?: readonly MediaCategoryDefinition[];
  defaultUploadCategory?: string;
  canUploadCategory?: (category: string) => boolean;
  onMediaPickerDirtyChange?: (dirty: boolean) => void;
}

// What a save did, told apart from what the editor holds now (#1042).
//
// These are two different facts and a single boolean kept collapsing them. The editor stays
// editable while a save is in flight, so someone who keeps typing leaves the page unsaved the
// instant the write lands — true of the editor, false of the store. A caller that has to decide
// whether to warn about losing work needs `clean`; one that acts on what is stored, like building
// a preview of the saved revision, needs `landed`. Reporting `clean` to both told a person their
// changes were not saved immediately after they were written.
export interface EditorSaveOutcome {
  // The store accepted this content. Says nothing about later edits.
  landed: boolean;
  // The write landed and nothing has been edited since it was sent.
  clean: boolean;
  // Exact server acknowledgment, even if subsequent local edits remain unsaved.
  receipt?: SavedEditorReceipt;
  // Local identity of the submitted draft; never sent to the server.
  capture?: object;
}

const SAVE_REFUSED: EditorSaveOutcome = { landed: false, clean: false };

export interface CapturedEditorSave {
  readonly token: object;
  save(): Promise<EditorSaveOutcome>;
  dispose(): void;
}

export interface BlockEditorHandle {
  revealDataHubFigure: (figure: DataHubFigure | "featured") => boolean;
  captureSave: () => CapturedEditorSave;
  validateForPublication: () => boolean;
  save: (options?: { force?: boolean }) => Promise<EditorSaveOutcome>;
  // A host that persists a larger document can receive canonical block ids after this editor's
  // local validation has finished. Adopt that receipt into the live list while preserving any
  // body edit made during the outer request.
  adoptSavedIds: (
    idMap: Record<string, string>,
    sentBlocks: AdminBlock[],
  ) => void;
}

export interface BlockSaveResult {
  savedTarget?: SavedEditorReceipt;
  warnings?: string[];
  // The stored snapshot is useful to the host, but its order is not an identity contract.
  blocks: AdminBlock[];
  // The server's explicit temporary-to-canonical identity receipt. Only this map may rename
  // live editor blocks after a save; array position cannot identify a block safely (#900).
  mintedIds: Record<string, string>;
}

// A save may be synchronous (the in-memory mock returns void) or asynchronous (a real
// persist returns a promise of the canonical-id receipt). Detect the promise by its thenable
// shape rather than instanceof, so any promise-like return drives the async path.
function isThenable(value: unknown): value is Promise<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function blockCardDomId(id: string): string {
  return `block-card-${id}`;
}

// The element that actually holds focus, following shadow roots down. `document.activeElement`
// stops at the host of a shadow tree, so a plain comparison against it reads "something is
// focused" for a subtree the caller cannot see into -- which is how the design gallery, whose
// specimens are shadow-rooted, differs from the shipped admin. Walking the chain makes the same
// check answer the same way in both.
function deepActiveElement(): Element | null {
  let active: Element | null = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}

// Whether the element under an undo shortcut keeps a history of its own. A text input and a
// textarea have the browser's native field undo; a rich-text body has TipTap's. The page-level
// history stays out of both, exactly as the undo stack itself excludes rich-text edits, so the two
// Undo affordances never fight over one keystroke (#582, #1035).
function ownsItsOwnHistory(element: HTMLElement): boolean {
  return Boolean(
    element.closest("input, textarea, [contenteditable=''], [contenteditable='true']"),
  );
}

function validationFieldsForBlock(block: AdminBlock) {
  const fields = editorFieldsForBlock(block.type);
  if (block.type === "embed" && typeof block.data.url === "string" && apResultsLayoutSrc(block.data.url)) {
    fields.push(...apResultsEditorFields());
  }
  if (block.type === "content_shelf") {
    const presentation = fields.find(field => field.key === "presentation");
    if (presentation) presentation.options = CONTENT_SHELF_PRESENTATIONS.map(value => ({ value, label: value }));
  }
  return fields;
}

function hiddenBlockErrors(block: AdminBlock, fields: ReturnType<typeof validationFieldsForBlock>) {
  const errors = contradictedBlockContent(fields, block.data);
  if (block.type === "embed") errors.push(...missingBlockContent(
    fields.filter(field => field.kind === "number" || field.key === "mapSize" || field.key === "mapWidth"),
    block.data, { allowIncomplete: true },
  ));
  return errors;
}

// The page-composition surface: a palette of only the blocks this template allows, and the
// list of placed blocks, each editable through the shared descriptor renderer and
// reorderable or removable. Every guarantee an editor leans on -- off-brand blocks are not
// offered, caps are enforced, a rejected op leaves the page untouched -- comes from the
// pure core the palette and list sit on, not from this component.
// Outline navigation/arrangement is secondary work; keep it out of the writing chunk.
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
function warmHomeEditors() {
  void Promise.allSettled([newscastEditor.preload(), newsletterEditor.preload(), donorEditor.preload(), curatedShelfEditor.preload()]);
}
const PageOutline = deferEditor(() => import("./PageOutline").then(module => module.PageOutline), "Outline").Editor;

export const BlockEditor = forwardRef<BlockEditorHandle, BlockEditorProps>(
  function BlockEditor(
    {
      section,
      liveBlogSidebar = false,
      electionResultsApprovals = [],
      electionSourceHost,
      supplementalOutlineSections,
      onReportingSelectionChange,
      pageId,
      pageTitle,
      homeCompositionVersion,
      loadHomeSources,
      allowedBlockTypes,
      canEditCustomHtml = true,
      initialBlocks = [],
      allowIncomplete = false,
      newId,
      onSave,
      conflictCopy,
      onReload,
      allowConflictOverwrite = true,
      canSave = true,
      saveDisabledReason,
      readOnlyNotice,
      onSavingChange,
      onDraftChange,
      readOnly = false,
      showSaveAction = true,
      commandsInline = false,
      commandLabel = "Page editing commands",
      loadMedia,
      mediaPickerUnavailable = false,
      uploadMedia,
      mediaCategories,
      defaultUploadCategory,
      canUploadCategory,
      onMediaPickerDirtyChange,
    },
    ref,
  ) {
    const [electionConnectionStates, setElectionConnectionStates] = useState<ReadonlyMap<string, boolean>>(new Map());
    const onElectionConnectedChange = useCallback((id: string, active: boolean | undefined) => {
      setElectionConnectionStates(current => {
        if (current.get(id) === active) return current;
        const next = new Map(current); if (active === undefined) next.delete(id); else next.set(id, active); return next;
      });
    }, []);
    const view = useEditorWorkspaceView();
    useEffect(() => {
      if (pageId !== "home" || !view?.kind || !window.requestIdleCallback) return;
      const request = window.requestIdleCallback(warmHomeEditors);
      return () => window.cancelIdleCallback(request);
    }, [pageId, view?.kind]);
    const successNotice = useSuccessNotice();
    const mintBlockId = useMemo(() => newId ?? (() => crypto.randomUUID()), [newId]);
    const editor = useBlockEditor(section, initialBlocks, { newId: mintBlockId });
    useEffect(() => {
      if (editor.error) successNotice.show(editor.error, { tone: "error" });
    }, [editor.error, successNotice]);
    const visibleBlockIds = useMemo(() => new Set(visibleLayoutBlocks(editor.blocks).map(block => block.id)), [editor.blocks]);
    const savedNewsletter = editor.blocks.some(block => block.section === "home-newsletter");
    const homeAuthoringBlocks = homeCompositionVersion === undefined ? null
      : homeCompositionVersion === 1
        ? homeStructuralBlocks(editor.blocks.filter(block => block.section !== "home-start-action"))
        : editor.blocks.filter(block => block.section !== "home-start-action" && (!savedNewsletter || block.section !== "home-start"));
    const normalizeHomeOrders = homeAuthoringBlocks?.some(
      (block) => block.type === "row" || block.layout !== undefined,
    ) ?? false;
    const authoringBlocks = homeAuthoringBlocks
      ? homeAuthoringBlocks.map((block, order) => normalizeHomeOrders && block.order !== order
        ? { ...block, order }
        : block)
      : editor.blocks;
    // The canvas and outline share both membership and numbering, including the
    // legacy Home newsletter boundary and the contents of paired sections.
    const outlineBlocks = authoringBlocks;
    const outlineBlocksRef = useRef(outlineBlocks);
    outlineBlocksRef.current = outlineBlocks;
    const pendingInsertId = useRef<string | null>(null);
    const insertRowContent = useCallback((type: BlockType, destination: ContentDestination) => {
      if (readOnly || (allowedBlockTypes !== undefined && !allowedBlockTypes.includes(type))) return null;
      let insertedId: string | null;
      if (type === "data_hub_section") {
        const sectionId = nextDataHubSection(blocksRef.current);
        if (!sectionId) return null;
        const block = createBlock(type, mintBlockId());
        block.data.sectionId = sectionId;
        const next = editor.editRows({ kind: "insert", block, destination });
        insertedId = !next.error && next.blocks.some(candidate => candidate.id === block.id) ? block.id : null;
      } else insertedId = editor.insertContent(type, destination);
      pendingInsertId.current = insertedId;
      return insertedId;
    }, [readOnly, allowedBlockTypes, editor.insertContent, editor.editRows, mintBlockId]);
    // Held by identity, not rebuilt per render: the palette is a prop of every insertion control
    // on the page, and a fresh array each render would re-render all 41 of them on a page at the
    // cap, for a list that only changes when the template does (#511).
    const availableHubSection = pageId === "data-hub" ? nextDataHubSection(editor.blocks) : undefined;
    const hubSectionKey = pageId === "data-hub" ? editor.blocks.filter(block => block.type === "data_hub_section").map(block => block.data.sectionId).sort().join("\0") : "";
    const usedHubSections = useMemo(() => hubSectionKey ? hubSectionKey.split("\0") : [], [hubSectionKey]);
    const palette = useMemo(
      () =>
        (allowedBlockTypes === undefined
          ? insertableBlocksForSection(section)
          : Array.from(allowedBlockTypes)).filter(type => (type !== "data_hub_section" || pageId === "data-hub" && availableHubSection !== undefined) && type !== "row" && type !== "coverage_list" &&
            (canEditCustomHtml || type !== "html") &&
            type !== "home_newscast" && (section !== "home" || type !== "newsletter_signup") &&
            (homeCompositionVersion === undefined || type !== "content_shelf")),
      [allowedBlockTypes, section, homeCompositionVersion, canEditCustomHtml, pageId, availableHubSection],
    );
    // Every card's generated heading rank in one forward pass. Asking per card walked the whole
    // prefix again for each one, so rendering the list was quadratic in block count (#511).
    const headingLevels = useMemo(
      () => {
        if (section === "post" && liveBlogSidebar) {
          const levelsById = new Map<string, number>();
          for (const blocks of Object.values(splitLiveBlogBlocks(editor.blocks, true))) {
            const levels = generatedHeadingLevels(blocks);
            blocks.forEach((block, index) => levelsById.set(block.id, levels[index]));
          }
          return editor.blocks.map(block => levelsById.get(block.id) ?? 2);
        }
        if (homeCompositionVersion === 2) {
          const parsed = parseBlocks(editor.blocks, { complete: false });
          if (!parsed.ok || homeCompositionError("home", 2, parsed.blocks, { complete: false })) return generatedHeadingLevels(editor.blocks);
          const levelsById = new Map<string, number>();
          for (const group of homeCompositionGroups(parsed.blocks)) {
            if (group.kind !== "content") continue;
            const levels = generatedHeadingLevels(group.blocks.map(block =>
              visibleBlockIds.has(block.id) ? block : { ...block, visible: false }));
            group.blocks.forEach((block, index) => levelsById.set(block.id, levels[index]));
          }
          return editor.blocks.map(block => levelsById.get(block.id) ?? 2);
        }
        if (homeCompositionVersion !== 1) return generatedHeadingLevels(editor.blocks);
        // Public Home renders each added-content area separately. Fixed section
        // headings and headings in other areas cannot deepen its card titles.
        const levelsById = new Map<string, number>();
        for (const area of Object.values(homeContentAreas(editor.blocks))) {
          const levels = generatedHeadingLevels(area.map(block =>
            visibleBlockIds.has(block.id) ? block : { ...block, visible: false }));
          area.forEach((block, index) => levelsById.set(block.id, levels[index]));
        }
        return editor.blocks.map(block => levelsById.get(block.id) ?? 2);
      },
      [editor.blocks, homeCompositionVersion, visibleBlockIds, section, liveBlogSidebar],
    );

    // A structural refusal from validateSection (a bad placement or an over-cap page). It is
    // separate from the per-block content errors below; at most one of the two is ever set,
    // because handleSave stops at the structural check before it looks inside a block.
    const [structuralError, setStructuralError] = useState<string | null>(null);
    // Per-block "you left a required field empty" messages, keyed by block id, set when a
    // save is refused so each incomplete block can say what it needs. The "fill in the
    // highlighted blocks" banner is derived from this map rather than stored, so the banner
    // and the card markers can never disagree.
    const [blockErrors, setBlockErrors] = useState<Record<string, string[]>>(
      {},
    );
    const [saved, setSaved] = useState(false);
    // A save is in flight (an async onSave that has not resolved). The Save button disables and
    // relabels while it holds, so a second click cannot fire a concurrent save.
    const [saving, setSaving] = useState(false);
    // The server's reason for a rejected save, shown in the same banner slot as a structural
    // error. Cleared when the next edit or save attempt starts, so a stale failure never lingers.
    const [saveError, setSaveError] = useState<string | null>(null);
    const [saveWarnings, setSaveWarnings] = useState<string[]>([]);
    // The save was refused because the stored page moved under this editor (#530, #563). Held
    // apart from saveError because it is a question, not a report: retrying unchanged would send
    // the same stale claim, so the Save button stays disabled until the person answers it. It
    // deliberately survives further editing -- the stored page is still ahead no matter what
    // they type next, and clearing it on an edit would quietly re-arm a save that overwrites.
    const [conflict, setConflict] = useState(false);
    // Long-page view state stays deliberately outside the content reducer: navigating the
    // outline or opening a component changes how the page is viewed, not the page that will be
    // saved. The active id follows keyboard focus and outline jumps.
    const [activeBlockId, setActiveBlockId] = useState<string | null>(
      () => view?.kind === "post" ? null : initialBlocks.find(block => !initialBlocks.some(candidate => candidate.section === "home-newsletter") || !["home-start", "home-start-action"].includes(block.section ?? ""))?.id ?? null,
    );
    const [editRequest, setEditRequest] = useState<{ id: string; column?: number; sequence: number }>();
    useEffect(() => {
      if (editRequest?.id && !editor.blocks.some(block => block.id === editRequest.id)) {
        setEditRequest(request => request ? { ...request, id: "" } : request);
      }
    }, [editor.blocks, editRequest]);
    const [activeColumn, setActiveColumn] = useState<number | null>(null);
    const [pendingFocusColumn, setPendingFocusColumn] = useState<number | null>(null);
    const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);
    const renderKeys = useRef(new Map<string, string>());
    const blockRenderKey = useCallback((id: string): string => {
      if (!renderKeys.current.has(id)) renderKeys.current.set(id, id);
      return renderKeys.current.get(id)!;
    }, []);
    function reconcileEditorIds(idMap: Record<string, string>, savedBlocks?: readonly AdminBlock[]) {
      for (const [id, canonical] of Object.entries(idMap)) {
        if (typeof canonical === "string" && canonical) renderKeys.current.set(canonical, blockRenderKey(id));
      }
      setActiveBlockId(id => id ? idMap[id] ?? id : null);
      setEditRequest(request => request ? { ...request, id: idMap[request.id] ?? request.id } : undefined);
      setPendingFocusId(id => id ? idMap[id] ?? id : null);
      // Keep awaited continuations on canonical IDs before the reducer's render.
      // Use the same remap as the reducer, including row-layout references.
      blocksRef.current = blocksRef.current.map(block => reconcileBlockId(block, idMap, savedBlocks));
      if (capturedSave.current) {
        capturedSave.current.blocks = capturedSave.current.blocks.map(block => reconcileBlockId(block, idMap, savedBlocks));
      }
      editor.reconcileSavedIds(idMap, savedBlocks);
    }
    // The block whose removal has been asked about and not yet answered. Removing a populated
    // block destroys several fields, and in a gallery or card set several items, at once, so it
    // asks first and names what it holds (#1035). An empty block is not worth a question: it is
    // the block somebody inserted by mistake, and confirming its removal would put a dialog in
    // front of ordinary tidying.
    const [pendingRemovalId, setPendingRemovalId] = useState<string | null>(null);
    // What was just removed, and how deep the undo stack was when it went. The notice offers to
    // take exactly that removal back; once the stack moves on -- another edit, an undo, a redo --
    // an "Undo removal" button would reverse something else, so the notice is withdrawn rather
    // than left to lie (#1035).
    const [removalNotice, setRemovalNotice] = useState<
      { message: string; undoDepth: number } | null
    >(null);
    // Bumped by every history action (a removal, an undo, a redo) so the effect below can put
    // focus back inside this editor when the action destroyed whatever held it. A remove button
    // lives inside the thing it removes and the notice's Undo button disappears once it is used,
    // so without this focus falls to the document body: a keyboard user loses their place, and --
    // because the undo shortcut is scoped to this editor's own subtree -- the next Command-Z or
    // Command-Shift-Z silently does nothing (found in browser review of #1035).
    const [focusClaim, setFocusClaim] = useState(0);
    const undoNoticeRef = useRef<HTMLButtonElement>(null);
    const editorRef = useRef<HTMLDivElement>(null);
    const [localArranging, setLocalArranging] = useState(false);
    const arranging = view?.kind ? view.arranging : localArranging;
    const setArranging = view?.kind ? view.setArranging : setLocalArranging;
    const [arrangeTarget, setArrangeTarget] = useState<HTMLDivElement | null>(null);
    const [outlineCollapsed, setOutlineCollapsed] = useState(() =>
      readLayoutDisclosure("outline"),
    );
    const outlineVisible = view?.kind ? view.outlineOpen || arranging : !outlineCollapsed;
    const [outlineVisited, setOutlineVisited] = useState(outlineVisible);
    useEffect(() => { if (outlineVisible) setOutlineVisited(true); }, [outlineVisible]);
    const outlineId = useId();
    const outlineTriggerRef = useRef<HTMLButtonElement>(null);
    const closeOutline = useCallback(() => { setOutlineCollapsed(true); writeLayoutDisclosure("outline", true); }, []);
    // Set for the one block-list change an adopt causes, so the reconcile effect below knows
    // that change is the save landing (server-minted ids replacing the client's), not a user
    // edit, and keeps the "Saved." confirmation it just set rather than clearing it. A ref, not
    // state, because it must be read in the very effect run the adopt triggers without itself
    // scheduling another render.
    const adoptingRef = useRef(false);
    // The latest block list, updated every render. The async save reads this on resolve to tell
    // whether the editor changed while the save was in flight; a ref sidesteps the stale
    // editor.blocks the awaited continuation would otherwise close over.
    const blocksRef = useRef(editor.blocks);
    blocksRef.current = editor.blocks;
    // The undo depth as of this render, read by the removal notice below. Held in a ref for the
    // same reason the handlers below are: a handler that closed over the depth would change
    // identity on every history action and re-render every card that holds it (#511). A ref
    // assigned in render carries the same value the closure would have.
    const undoDepthRef = useRef(editor.undoDepth);
    undoDepthRef.current = editor.undoDepth;
    // Whether the person edited while the last save was in flight, read by the effect below to
    // decide if that save left anything unsaved. Set from the save's resolve, so like blocksRef
    // it is a ref rather than state: the effect runs in the same commit as the adopt and must
    // read the value that resolve just computed, not one from a later render.
    const editedDuringSaveRef = useRef(false);
    // The host's draft sink, held in a ref so the effect below can depend on the block list
    // alone. The host passes a fresh closure every render, so depending on the callback would
    // re-run the effect on every parent render and report a draft for a page nobody edited.
    const onDraftChangeRef = useRef(onDraftChange);
    onDraftChangeRef.current = onDraftChange;

    // The block list as it stood at the last point this page was clean: the mount's seed, or the
    // list a save just stored. The effect below reports a draft only when the live list is a
    // different array than this one.
    //
    // An identity, not a has-run flag. The reducer replaces the list only on a real change (a
    // rejected op and a cleared error both keep the same identity), so an unequal identity is an
    // edit and an equal one is not. A has-run flag would be wrong under React StrictMode, which
    // replays mount effects without resetting refs -- `main.tsx` mounts the admin inside
    // StrictMode, and so does the design gallery. The replay would find the flag already set and
    // report an untouched page as unsaved work, and the host would then stop re-reading a page
    // nobody edited. Comparing identity is idempotent, so the replay is harmless, and it stays
    // correct if React ever remounts and reuses this component's state.
    const baselineRef = useRef(editor.blocks);

    // Keep the outline selection pointed at a live block after remove and undo. The first block
    // becomes the active outline item when a formerly empty page gets one.
    useEffect(() => {
      const selected = editor.blocks.find(block => block.id === activeBlockId);
      if (activeColumn !== null && (!selected || selected.type !== "row" || activeColumn >= (selected.data.columns as number[]).length)) setActiveColumn(null);
      if (
        activeBlockId &&
        editor.blocks.some((block) => block.id === activeBlockId)
      )
        return;
      if (activeBlockId === null && view?.kind === "post") return;
      setActiveBlockId(editor.blocks[0]?.id ?? null);
    }, [activeBlockId, activeColumn, editor.blocks, view?.kind]);

    useEffect(() => {
      const id = pendingInsertId.current;
      if (!id) return;
      if (editor.error) { pendingInsertId.current = null; return; }
      if (!editor.blocks.some(block => block.id === id)) return;
      pendingInsertId.current = null;
      setEditRequest(previous => ({ id, sequence: (previous?.sequence ?? 0) + 1 }));
      setActiveBlockId(id);
      setActiveColumn(null);
      setPendingFocusColumn(null);
      setPendingFocusId(id);
    }, [editor.blocks, editor.error]);

    // An outline jump moves keyboard focus after React has rendered the destination. The card is
    // programmatically focusable but stays out of the normal tab order; this is navigation, not
    // another stop before every field.
    useEffect(() => {
      if (!pendingFocusId) return;
      const card = document.getElementById(pendingFocusColumn === null ? blockCardDomId(pendingFocusId) : contentColumnDomId(pendingFocusId, pendingFocusColumn))
        ?? document.getElementById(`block-context-${pendingFocusId}`);
      card?.focus();
      setPendingFocusId(null);
    }, [editor.blocks, pendingFocusId, pendingFocusColumn]);

    // The notice is only honest while the removal it names is still the top of the undo stack.
    // Any further recorded edit -- including the undo or redo that answers the notice itself --
    // changes the depth and takes the notice down.
    useEffect(() => {
      if (!removalNotice) return;
      if (removalNotice.undoDepth === editor.undoDepth) return;
      setRemovalNotice(null);
    }, [editor.undoDepth, removalNotice]);

    // Put focus back inside the editor after a history action, but only when the action destroyed
    // whatever held it. A removal run from a control that survives (a gallery still on screen)
    // leaves the person where they were rather than throwing them to the top of the editor. When
    // focus was destroyed, the way back takes it: the notice's Undo button if one is standing, and
    // otherwise the editor itself, which keeps the keyboard shortcut in scope so a second
    // Command-Z or a Command-Shift-Z still reaches this history.
    useEffect(() => {
      if (focusClaim === 0) return;
      const active = deepActiveElement();
      // Focus that is still somewhere in this editor is focus the person can use, so leave it.
      // Anything else -- the document body after the control was destroyed -- is nobody's place.
      if (active && editorRef.current?.contains(active)) return;
      // Re-runs when the notice comes or goes, not only when a history action bumps the claim: an
      // undo taken with the keyboard withdraws the notice in the effect above, so the button this
      // pass can see is one that is about to be unmounted. Choosing by the current notice state,
      // and running again once it settles, lands focus on the way back while there is one and on
      // the editor itself once there is not.
      (removalNotice ? undoNoticeRef.current : editorRef.current)?.focus({ preventScroll: true });
    }, [focusClaim, removalNotice]);

    // Record a removal and offer the way back. `undoDepth` is read after the removal is
    // dispatched, in the same commit, so the notice is pinned to that exact entry.
    const noticeRemoval = useCallback((message: string) => {
      setRemovalNotice({ message, undoDepth: undoDepthRef.current + 1 });
      setFocusClaim((claim) => claim + 1);
    }, []);

    const removeBlock = useCallback(
      (id: string, position: number) => {
        const block = blocksRef.current.find((candidate) => candidate.id === id);
        setPendingRemovalId(null);
        editor.removeBlock(id);
        if (block) noticeRemoval(block.type === "row" ? "Row and its content removed." : removedBlockNotice(block, position));
      },
      [editor.removeBlock, noticeRemoval],
    );

    function undoRemoval() {
      setRemovalNotice(null);
      editor.undo();
      // This control is about to unmount with the notice, so claim focus for the editor.
      setFocusClaim((claim) => claim + 1);
    }

    // Command-Z and Command-Shift-Z (Control on Windows and Linux) over the block editor.
    // Block history restores removed blocks as well as text. This is scoped to the
    // editor's own subtree: a text control owns its native undo, a rich-text body
    // owns its TipTap history, and neither should have a block quietly reappear underneath it.
    function handleHistoryShortcut(event: React.KeyboardEvent<HTMLDivElement>) {
      if (readOnly) return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      const target = event.target;
      if (target instanceof HTMLElement && ownsItsOwnHistory(target)) return;
      if (key === "z" && !event.shiftKey) {
        if (!editor.canUndo) return;
        event.preventDefault();
        editor.undo();
        // The keystroke may have been sent from the notice's Undo button, which the undo takes
        // away with it; keep focus (and so the shortcut) inside the editor either way.
        setFocusClaim((claim) => claim + 1);
        return;
      }
      // Command-Shift-Z everywhere, and Control-Y as well, which is what a Windows editor reaches
      // for first.
      if ((key === "z" && event.shiftKey) || key === "y") {
        if (!editor.canRedo) return;
        event.preventDefault();
        editor.redo();
        setFocusClaim((claim) => claim + 1);
      }
    }

    const goToBlock = useCallback((id: string, column?: number) => {
      setEditRequest(previous => ({ id, column, sequence: (previous?.sequence ?? 0) + 1 }));
      setActiveBlockId(id);
      setActiveColumn(column ?? null);
      setPendingFocusColumn(column ?? null);
      setPendingFocusId(id);
    }, []);

    const toggleOutline = useCallback(() => {
      setOutlineCollapsed((collapsed) => {
        const next = !collapsed;
        writeLayoutDisclosure("outline", next);
        return next;
      });
    }, []);

    // The per-block handlers every card and outline row holds. They take the block's id (and,
    // where the copy names a place on the page, its position) instead of closing over the block,
    // so one function serves every card and keeps its identity across renders. Without that,
    // memoizing the cards would buy nothing: a new closure per card per render is a changed prop
    // (#511). Current block state is read from `blocksRef`, which this render already updated, so
    // these do not have to be rebuilt when the list changes either.
    const activateBlock = useCallback((id: string | null, column?: number) => {
      view?.setSpecialSelection(null);
      view?.setDetailsTab("selection");
      setActiveBlockId(id);
      setActiveColumn(column ?? null);
    }, [view?.setSpecialSelection, view?.setDetailsTab]);

    const changeBlockData = useCallback(
      (id: string, data: Record<string, unknown>, discrete = false) => {
        if (!readOnly) editor.setBlockData(id, data, discrete);
      },
      [editor.setBlockData, readOnly],
    );

    const convertCoverageProse = useCallback((id: string, entries: CoverageEntry[]) => {
      if (readOnly || !palette.includes("link_card")) return;
      const cards = entries.map((entry) => ({
        ...createBlock("link_card", mintBlockId()),
        data: {
          title: entry.title,
          url: entry.url,
          source: entry.outlet,
          date: entry.date,
          summary: "",
        },
      }));
      editor.editRows({ kind: "replaceMany", id, blocks: cards });
    }, [editor.editRows, mintBlockId, palette, readOnly]);
    const coverageCardCapacity = Math.max(
      0,
      SECTION_BLOCK_TOTAL_MAX[section] - Math.max(0, editor.blocks.length - 1),
    );

    const moveBlock = useCallback(
      (id: string, toIndex: number) => {
        if (readOnly) return;
        const blocks = blocksRef.current;
        if (!blocks.some(block => block.type === "row")) {
          editor.moveBlock(id, toIndex);
          return;
        }
        const block = blocks.find(candidate => candidate.id === id);
        if (!block || block.section !== undefined && block.section !== LIVE_BLOG_SIDEBAR) return;
        const siblings = contentSiblings(blocks, block);
        const index = siblings.indexOf(block);
        const direction = Math.sign(toIndex - blocks.indexOf(block));
        if (!direction || !siblings[index + direction]) return;
        const beforeId = direction < 0 ? siblings[index - 1].id : siblings[index + 2]?.id;
        editor.editRows({ kind: "move", id, destination: { layout: block.layout, beforeId } });
      },
      [editor.moveBlock, editor.editRows, readOnly],
    );

    const canMoveOutlineBlock = useCallback(
      (block: AdminBlock) => homeCompositionVersion === undefined || block.section === undefined || (homeCompositionVersion === 2 && !isHomeLockedAuthoringSection(block.section) && block.section !== "home-passport-action"),
      [homeCompositionVersion],
    );
    const fixedOutlinePositionReason = useCallback((block: AdminBlock) => {
      if (canMoveOutlineBlock(block)) return undefined;
      if (isHomeLockedAuthoringSection(block.section)) return "The Newsletter band stays in its assigned position in this Home layout.";
      if (homeCompositionVersion === 1) return "Home sections stay in their assigned positions in the original layout. Use the editorial layout to arrange them.";
      return "Passport buttons move together with the Passport section.";
    }, [canMoveOutlineBlock, homeCompositionVersion]);

    const moveOutlineBlock = useCallback(
      (id: string, toIndex: number) => {
        if (homeCompositionVersion === undefined) {
          moveBlock(id, toIndex);
          return;
        }
        const blocks = blocksRef.current;
        const movable = blocks.find((block) => block.id === id);
        const outline = outlineBlocksRef.current;
        const outlineIndex = outline.findIndex((block) => block.id === id);
        const direction = Math.sign(toIndex - outlineIndex);
        if (readOnly || !movable || !canMoveOutlineBlock(movable) || !direction) return;
        if (movable.layout) {
          const siblings = contentSiblings(blocks, movable);
          const siblingIndex = siblings.findIndex((block) => block.id === id);
          const target = siblings[siblingIndex + direction];
          if (target) moveBlock(id, blocks.findIndex((block) => block.id === target.id));
          return;
        }
        const topLevel = homeStructuralMoveNeighbors(outline);
        const siblingIndex = topLevel.findIndex((block) => block.id === id);
        const target = topLevel[siblingIndex + direction];
        if (!target) return;
        const beforeId = direction < 0 ? target.id : topLevel[siblingIndex + 2]?.id;
        editor.editRows({ kind: homeCompositionVersion === 2 ? "homeV2Move" : homeCompositionVersion === 1 ? "homeMove" : "move", id, destination: beforeId ? { beforeId } : {} });
      },
      [editor.editRows, editor.moveBlock, homeCompositionVersion, moveBlock, canMoveOutlineBlock, readOnly],
    );

    const placeContent = useCallback((id: string, destination: ContentDestination) => {
      if (readOnly) return;
      editor.editRows({ kind: homeCompositionVersion === 2 ? "homeV2Move" : homeCompositionVersion === 1 && !destination.layout ? "homeMove" : "move", id, destination });
    }, [editor.editRows, homeCompositionVersion, readOnly]);

    const toggleBlockVisible = useCallback(
      (id: string) => {
        const block = blocksRef.current.find((candidate) => candidate.id === id);
        if (!readOnly && block && !isHomeLockedAuthoringSection(block.section)) editor.setBlockVisible(id, !block.visible, homeCompositionVersion === 2);
      },
      [editor.setBlockVisible, readOnly, homeCompositionVersion],
    );

    const requestRemoveBlock = useCallback(
      (id: string, position: number) => {
        const block = blocksRef.current.find((candidate) => candidate.id === id);
        if (homeCompositionVersion === 2 && block?.section !== undefined && block.type !== "promotion_playlist") {
          if (!readOnly) editor.setBlockVisible(id, false, true);
          return;
        }
        // A populated block asks first and says what it holds; an empty one goes at once (#1035).
        if (block && (blockIsPopulated(block) || (block.type === "row" && blocksRef.current.some(child => child.layout?.rowId === id)))) {
          setPendingRemovalId(id);
          return;
        }
        removeBlock(id, position);
      },
      [removeBlock, homeCompositionVersion, readOnly, editor.setBlockVisible],
    );

    const cancelRemoveBlock = useCallback(() => setPendingRemovalId(null), []);

    // An item removed deep inside a block's own surface reports up through context (#1035). The
    // reporter is memoized because a context value is not covered by memo: a fresh function each
    // render would re-render every card reading it, which is every card.
    const reportItemRemoval = useCallback(
      (itemName: string) => noticeRemoval(removedItemNotice(itemName)),
      [noticeRemoval],
    );

    // Settle the draft once a save lands (#579), moving the clean point above. A save is not
    // automatically a clean point: an edit composed while it was in flight is still unsaved once
    // the save returns, so that edit keeps its draft and the clean point does not move.
    //
    // Every successful save path calls this, not just the one that reconciles ids. Only a save
    // that returns canonical blocks changes the list, and only a list change reaches the effect
    // below -- so a host whose save returns void (the prop's contract allows both `void` and
    // `Promise<void>`, and the in-memory mock uses the former) would otherwise leave an
    // already-saved page stashed, and the host would restore that stale snapshot on the way back.
    function settleDraft(blocks: AdminBlock[], editedDuringSave: boolean) {
      if (editedDuringSave) {
        onDraftChangeRef.current?.(blocks);
        return;
      }
      baselineRef.current = blocks;
      onDraftChangeRef.current?.(null);
    }

    // Any change to the block list clears the saved confirmation and reconciles the error
    // markers with the new list. "Saved." never lingers over an edited-but-unsaved page. A
    // stale structural complaint is dropped, since the editor is changing structure and the
    // next save re-judges it. Content markers are recomputed per block, not wiped: fixing one
    // flagged block drops only its own markers and leaves the other still-incomplete blocks
    // flagged, so a multi-block save never loses sight of what still needs filling in. Only
    // already-flagged blocks are re-checked, so a freshly inserted empty block is not marked
    // until its own save attempt. A save that adopts canonical ids does change the list, so the
    // confirmation and markers would be cleared by the run below if the adopt branch did not
    // claim that run first -- which is what `adoptingRef` is for. They survive until a real edit.
    useEffect(() => {
      if (adoptingRef.current) {
        // This block-list change is the save being adopted (#515), not a user edit. Keep the
        // "Saved." confirmation and the cleared markers the save already set, and consume the
        // one-shot flag so the next real edit clears them as usual.
        adoptingRef.current = false;
        // Adopt the rendered list identity as the clean point. Awaited save callers
        // already received the settled draft before this commit.
        settleDraft(editor.blocks, editedDuringSaveRef.current);
        return;
      }
      if (editor.blocks === baselineRef.current) {
        // Nothing has changed since the last clean point: the mount's own run, or StrictMode
        // replaying it. There is no draft to report. Saying so here would tell the host this page
        // holds work worth keeping when it has only been opened, and the host would stop
        // re-reading a page nobody touched. The resets below are already this component's state at
        // a clean point, so skipping them changes nothing.
        return;
      }
      // A real edit: hand the live blocks to the host so leaving this surface does not destroy
      // them. The reducer only replaces the list when it really changes (a rejected op and a
      // cleared error both keep the same identity), so this tracks edits, not renders.
      onDraftChangeRef.current?.(editor.blocks);
      setSaved(false);
      setSaveError(null);
      setStructuralError(null);
      setBlockErrors((prev) => {
        if (Object.keys(prev).length === 0) return prev;
        const next: Record<string, string[]> = {};
        for (const block of editor.blocks) {
          // Drop the marker for a block that is no longer flagged. A hidden block keeps only
          // its contradiction messages, matching what the save below will check, so hiding a
          // block clears its completeness marker and leaves the one the parser still refuses.
          if (!prev[block.id]) continue;
          const fields = validationFieldsForBlock(block);
          const messages = visibleBlockIds.has(block.id)
            ? missingBlockContent(fields, block.data, {
                allowIncomplete: allowIncomplete || block.type === "newsletter_signup" && block.section === "home-newsletter" &&
                  Array.isArray(block.data.newsletterIds) && block.data.newsletterIds.length === 0,
              })
            : hiddenBlockErrors(block, fields);
          if (messages.length > 0) next[block.id] = messages;
        }
        return next;
      });
    }, [allowIncomplete, editor.blocks]);

    // If this editor unmounts, clear any saving signal it raised so the workspace does not stay
    // navigation-locked. Navigation is held while a save is in flight, so an unmount mid-save
    // should not happen; this is a backstop for an unmount from another cause.
    useEffect(() => {
      return () => onSavingChange?.(false);
    }, [onSavingChange]);

    function validateContent(complete: boolean): boolean {
      setSaveError(null);
      // The save boundary: validate the whole page before it leaves the editor, even though
      // the reducer keeps the live list valid. This is the contract validateSection names.
      const invalid = validateSection(section, editor.blocks);
      if (invalid) {
        setStructuralError(invalid.reason);
        successNotice.show(`Save stopped. ${invalid.reason}`, { tone: "error" });
        setBlockErrors({});
        setSaved(false);
        return false;
      }
      // Structure is valid; now make the softer checks the record form already makes: every
      // required field is filled in, and every URL is one the renderer will keep.
      // validateSection does not look inside a block's data, so an empty heading, a gallery
      // image with no alt text, or a stripped link would otherwise be reported as saved.
      // Refuse and mark each incomplete or invalid block instead.
      const errorsByBlock: Record<string, string[]> = {};
      for (const block of editor.blocks) {
        // A hidden block is excluded from the published page, so its required fields do not gate
        // publishing the rest. Completeness is re-checked the moment it is shown again (visible
        // flips true and it re-enters this loop). It keeps the contradiction check, though:
        // that one names a shape parseBlocks below refuses, and skipping it here would report
        // the same page as an unattributed format error instead of a marked field.
        const fields = validationFieldsForBlock(block);
        const messages = visibleBlockIds.has(block.id)
          ? missingBlockContent(fields, block.data, {
              allowIncomplete: !complete || block.type === "newsletter_signup" && block.section === "home-newsletter" &&
                Array.isArray(block.data.newsletterIds) && block.data.newsletterIds.length === 0,
            })
          : hiddenBlockErrors(block, fields);
        if (complete && homeCompositionVersion !== undefined && block.section === "home-passport-copy" && isRichTextDoc(block.data.content)) {
          if (homePassportHeading(block.data.content) === null) messages.push("Passport heading is required.");
          if (richTextIsEmpty({ type: "doc", content: block.data.content.content.slice(1) })) messages.push("Passport body is required.");
        }
        if (messages.length > 0) errorsByBlock[block.id] = messages;
      }
      if (Object.keys(errorsByBlock).length > 0) {
        const [firstInvalidBlockId] = Object.keys(errorsByBlock);
        setBlockErrors(errorsByBlock);
        setStructuralError(null);
        setSaved(false);
        successNotice.show(`Save stopped. ${errorsByBlock[firstInvalidBlockId][0]}`, {
          tone: "error", action: { label: "Review content", onClick: () => goToBlock(firstInvalidBlockId) },
        });
        // Move focus to the first refusal so the banner always points at something the editor
        // can see and fix immediately.
        setEditRequest(previous => ({ id: firstInvalidBlockId, sequence: (previous?.sequence ?? 0) + 1 }));
        setActiveBlockId(firstInvalidBlockId);
        setActiveColumn(null);
        setPendingFocusColumn(null);
        setPendingFocusId(firstInvalidBlockId);
        return false;
      }
      // Final guard: the model parser checks each block payload's type and shape, which
      // validateSection (structure) and the required-field check (emptiness) do not. A
      // payload that is placed correctly with every required field filled but still
      // type-invalid can only reach here through initialBlocks -- a stored block whose shape
      // has drifted from the model. Refuse rather than re-save the drift as if it were valid,
      // so a divergent payload cannot round-trip through the editor once the read path lands.
      const parsedForSave = parseBlocks(editor.blocks, { complete, pageId });
      const homeError = homeCompositionVersion !== undefined && parsedForSave.ok
        ? homeCompositionError(pageId ?? "", homeCompositionVersion, parsedForSave.blocks, { complete })
        : null;
      if (homeError) {
        setStructuralError(homeError);
        successNotice.show(`Save stopped. ${homeError}`, { tone: "error" });
        setBlockErrors({});
        setSaved(false);
        return false;
      }
      if (!parsedForSave.ok) {
        successNotice.show("Save stopped. This content has an unsupported block format. Review the page content.", { tone: "error" });
        setStructuralError(
          "This page can't be saved because its content doesn't match the saved block format.",
        );
        setBlockErrors({});
        setSaved(false);
        return false;
      }
      setBlockErrors({});
      setStructuralError(null);

      return true;
    }

    const capturedSave = useRef<{ blocks: AdminBlock[]; token: object; valid: boolean } | null>(null);
    const submittedSave = useRef<{ blocks: AdminBlock[]; token: object } | null>(null);
    const saveCaptured = useRef<(capture: NonNullable<typeof capturedSave.current>) => Promise<EditorSaveOutcome>>();
    const runSave = useSaveFlight<EditorSaveOutcome>();
    saveCaptured.current = capture => {
      if (readOnly || !canSave || capturedSave.current !== capture || !capture.valid) {
        return Promise.resolve(SAVE_REFUSED);
      }
      return runSave(() => persistBlocks(undefined, capture));
    };
    function captureSave(): CapturedEditorSave {
      const capture = {
        blocks: blocksRef.current,
        token: submittedSave.current?.blocks === blocksRef.current ? submittedSave.current.token : {},
        valid: validateContent(!allowIncomplete),
      };
      capturedSave.current = capture;
      return { token: capture.token,
        save: () => saveCaptured.current!(capture),
        dispose: () => { if (capturedSave.current === capture) capturedSave.current = null; },
      };
    }
    function handleSave(options?: { force?: boolean }): Promise<EditorSaveOutcome> {
      if (readOnly || !canSave || (homeCompositionVersion === 2 && !homeLayoutsEnabled())) return Promise.resolve(SAVE_REFUSED);
      return runSave(() => persistBlocks(options));
    }

    function persistBlocks(options?: { force?: boolean }, capture?: NonNullable<typeof capturedSave.current>): EditorSaveOutcome | Promise<EditorSaveOutcome> {
      if (homeCompositionVersion === 2 && !homeLayoutsEnabled()) return SAVE_REFUSED;
      // The flight owns repeated calls before React renders its saving state. Permission
      // and conflict checks still gate new writes; joining cannot authorize an overwrite.
      // A standing conflict disables the Save button, but refuse here too: a plain save while
      // one stands would send the same stale claim and be refused again. Answering the conflict
      // is the only way through, and "Save anyway" says so by forcing.
      if (conflict && !options?.force) return SAVE_REFUSED;
      // A create-only conflict has no informed overwrite path: the person never loaded the
      // document now at this page id. Keep the guard in the handler as well as hiding the button,
      // so a synthetic event or stale UI cannot turn that conflict into data loss.
      if (options?.force && (!allowConflictOverwrite || homeCompositionVersion !== undefined)) return SAVE_REFUSED;
      // Every attempt starts from a clean server-error slate, so a prior failure's message never
      // sits under a fresh save. The conflict deliberately does not clear here. Only a save that
      // actually lands settles it (or a reload, which remounts this editor and takes the state
      // with it). Clearing it on attempt would throw away the person's answer to it: a forced
      // save that never reaches the server -- because one of the checks below refuses it -- would
      // drop the banner and re-enable the plain Save button while the claim it sends is still the
      // stale one, so their next save is refused all over again and they are asked the same
      // question they already answered.
      if (capture ? !capture.valid : !validateContent(!allowIncomplete)) return SAVE_REFUSED;

      const sent = capture?.blocks ?? blocksRef.current;
      const token = capture?.token ?? (capturedSave.current?.blocks === sent ? capturedSave.current.token : {});
      submittedSave.current = { blocks: sent, token };
      // A plain save passes the blocks and nothing else, which is the whole contract for a host
      // that never has to answer a conflict. Only "Save anyway" has more to say, so only it
      // widens the call.
      const outcome = options ? onSave?.(sent, options) : onSave?.(sent);
      if (isThenable(outcome)) return (async () => {
        // Async persist path: hold the saving state until the server answers, then either adopt
        // the returned canonical blocks or surface the failure. A rejected save keeps the live
        // list untouched so the editor can retry from the same content.
        setSaving(true);
        onSavingChange?.(true);
        try {
          const persisted = await outcome;
          // The write landed, so any conflict that stood is settled: this content is what is
          // stored now, and the host has taken the version this save returned as the next base.
          // An in-flight edit still leaves the page unsaved (below), but it does not revive the
          // conflict, because the next save composes against the version this one produced.
          setConflict(false);
          // The editor stays editable while a save is in flight, so the user may have edited
          // since this save was sent. The server returns an explicit map from each sent block id
          // to its canonical one. Reconcile that map onto the live list without assuming the
          // persisted block array kept its order. With no in-flight edit this takes every server
          // id (a full adopt); if
          // the user edited during the save, the saved blocks still take their stable ids (#515)
          // while blocks added in flight keep their temporary ids and are minted on the next
          // save — so an in-flight edit is neither discarded nor left with a churning id.
          const editedDuringSave = capture ? !blocksEqual(blocksRef.current, sent) : blocksRef.current !== sent;
          // Hand it to the effect that reports the draft, which runs in the commit the adopt
          // below triggers and has to know whether this save left anything unsaved (#579).
          editedDuringSaveRef.current = editedDuringSave;
          if (persisted) {
            // Flag the resulting list change so the reconcile effect preserves the
            // save confirmation and adopts the rendered baseline identity.
            adoptingRef.current = true;
            reconcileEditorIds(persisted.mintedIds, persisted.blocks);
            // Exit-save callers inspect the retained draft before React commits.
            settleDraft(blocksRef.current, editedDuringSave);
          } else {
            // A host whose save resolves to nothing (`Promise<void>`). No ids came back, so the
            // list does not change and the effect above never runs -- settle the draft here, or
            // this saved page stays stashed and gets restored stale.
            settleDraft(blocksRef.current, editedDuringSave);
          }
          // Confirm only when the live content is exactly what was persisted; an in-flight edit
          // leaves unsaved changes, so it must not read as saved.
          if (!editedDuringSave) {
            setSaved(true);
            setSaveWarnings(persisted?.warnings ?? []);
            if (showSaveAction) successNotice.show(persisted?.warnings?.length
              ? `Page saved. ${persisted.warnings.join(" ")}`
              : "Page saved.");
          }
          return { landed: true, clean: !editedDuringSave, capture: token,
            ...(persisted?.savedTarget ? { receipt: persisted.savedTarget } : {}) };
        } catch (err) {
          successNotice.show(isConflictError(err)
            ? "Your changes were not saved because this content changed elsewhere. Your draft is still here."
            : `Save failed. ${err instanceof Error ? err.message : "Try again. Your draft is still here."}`, { tone: "error" });
          // A conflict is not a failure to report and retry -- retrying sends the same stale
          // claim. It gets its own banner rather than the generic save error, and the live blocks
          // stay exactly as they are so no resolution is taken by default. A stale version may
          // allow an explicit overwrite; a create-only conflict safely allows reload only.
          if (isConflictError(err)) {
            setConflict(true);
          } else {
            setSaveError(
              err instanceof Error
                ? err.message
                : "The save could not be completed.",
            );
          }
          setSaved(false);
          return SAVE_REFUSED;
        } finally {
          submittedSave.current = null;
          setSaving(false);
          onSavingChange?.(false);
        }
      })();
      // Synchronous host (the in-memory mock): confirm immediately. Settling the conflict here
      // too keeps one rule rather than two -- a save that lands clears it, whoever the host is.
      // A captured draft can be older than the live editor even with a synchronous host.
      setConflict(false);
      const clean = capture ? blocksEqual(blocksRef.current, sent) : blocksRef.current === sent;
      setSaved(clean);
      if (showSaveAction && clean) successNotice.show("Page saved.");
      settleDraft(blocksRef.current, !clean);
      submittedSave.current = null;
      return { landed: true, clean, capture: token };
    }

    function adoptSavedIds(
      idMap: Record<string, string>,
      sentBlocks: AdminBlock[],
    ) {
      if (Object.keys(idMap).length === 0) return;
      editedDuringSaveRef.current = blocksRef.current !== sentBlocks;
      adoptingRef.current = true;
      reconcileEditorIds(idMap);
    }

    useImperativeHandle(ref, () => ({
      revealDataHubFigure: figure => {
        const block = editor.blocks.find(block => block.type === "data_hub_section" && block.data.sectionId === figure);
        if (!block) { setActiveBlockId(null); return false; }
        setActiveBlockId(block.id); view?.openPane("details", "selection"); return true;
      },
      validateForPublication: () => validateContent(true),
      save: handleSave,
      captureSave,
      adoptSavedIds,
    }));

    // The content banner is derived, not stored, so it is on exactly when a card is marked.
    const hasBlockErrors = Object.keys(blockErrors).length > 0;
    const invalidBlockCount = Object.keys(blockErrors).length;

    const outlineControl = view?.kind ? <ActionControl action="outline" label="Outline" size="compact"
      graphic={<Icon name="outline" />} aria-controls="editor-outline-pane" aria-expanded={view.outlineOpen}
      ref={view.outlineTrigger} onClick={() => view.togglePane("outline")} /> : <>
        <Button
          className="block-outline-toggle"
          variant={outlineCollapsed ? "secondary" : "primary"}
          aria-controls={outlineVisited || outlineVisible ? outlineId : undefined}
          aria-expanded={!outlineCollapsed}
          ref={outlineTriggerRef}
          onClick={toggleOutline}
        ><Icon name="panel-left" /><span className="button-compact-label">Outline</span></Button>
    </>;

    const editingCommands = (
      <>
        <ActionControl action="undo" disabled={readOnly || !editor.canUndo} onClick={editor.undo} />
        <ActionControl action="redo" disabled={readOnly || !editor.canRedo} onClick={editor.redo} />
      </>
    );

    const commandBar = (
      <Toolbar
        className="block-editor-toolbar block-editor-command-bar"
        role="toolbar"
        aria-label={commandLabel}
      >
        {commandsInline ? outlineControl : null}
        <div className="block-editor-command-actions">
          {onSave && showSaveAction ? (
            <AsyncActionButton
              variant="primary"
              disabled={readOnly || !canSave || conflict}
              label="Save page"
              onClick={() => void handleSave()}
              pending={saving}
              pendingAnnouncement="Saving page."
              pendingLabel="Saving…"
            />
          ) : null}
          {commandsInline ? editingCommands : (
            <WorkspaceSecondaryActions>{editingCommands}</WorkspaceSecondaryActions>
          )}
          {showSaveAction && onSave && !canSave ? (
            <span className="muted">
              {saveDisabledReason ?? "Your role cannot save this page."}
            </span>
          ) : null}
          {showSaveAction && saved && !successNotice.available ? (
            <span className="success-text" role="status">
              Saved.
            </span>
          ) : null}
        </div>
      </Toolbar>
    );

    const blockLocation = (block: AdminBlock) => {
      const rowNumber = block.layout ? editor.blocks.filter(item => item.type === "row").findIndex(item => item.id === block.layout?.rowId) + 1 : 0;
      return [pageTitle ?? (section === "post" ? "Post body" : "Page content"),
        ...(block.section === LIVE_BLOG_SIDEBAR ? [liveBlogSidebar ? "Live updates sidebar" : "Saved sidebar destination"] : []),
        ...(rowNumber ? [`Row ${rowNumber}`, `Column ${block.layout!.column + 1}`] : []),
        outlineTypeLabel(block)].join(" › ");
    };

    const renderServiceBlock = (block: AdminBlock, index: number, placementControls?: ReactNode) => {
      const editorIndex = editor.blocks.findIndex((candidate) => candidate.id === block.id);
      return homeCompositionVersion !== undefined && block.section === "home-start" ? (
        editor.blocks.some(candidate => candidate.section === "home-newsletter") ? null :
        <section
          key={blockRenderKey(block.id)}
          id={`block-context-${block.id}`}
          tabIndex={-1}
          onFocus={() => activateBlock(block.id)}
          className="page-fixed-context page-fixed-context-notice"
          aria-label="Newsletter signup"
        >
          <strong><span className="block-card-index" aria-hidden="true">{index + 1}</span> Newsletter signup</strong>
          <span>The public Home newsletter band stays in its assigned position. It is not a Page block.</span>
        </section>
      ) : <BlockCard onLiveBlogSidebar={section === "post" && (liveBlogSidebar || block.section === LIVE_BLOG_SIDEBAR) && canPlaceInLiveBlogSidebar(block) ? editor.setLiveBlogSidebar : undefined} placementControls={placementControls} location={blockLocation(block)} readOnly={readOnly} editRequest={editRequest} selected={!view?.specialSelection && (activeBlockId === block.id || Boolean(homeCompositionVersion === 2 && block.section?.startsWith("home-passport-") && editor.blocks.find(item => item.id === activeBlockId)?.section?.startsWith("home-passport-")))} key={blockRenderKey(block.id)} block={block} blocks={homeCompositionVersion === 2 ? editor.blocks : undefined} dataHubSections={pageId === "data-hub" ? usedHubSections : undefined} index={index} arrangeHomeSection={homeCompositionVersion === 2} homeShelf={pageId === "home" && homeCompositionVersion !== 2}
        textLinkActions={block.type === "cta_row" && ["caption-actions", "broadcast-actions", "contact-actions", "transition-actions"].includes(block.section ?? "")}
        regionLabel={pageId === "home" && block.type === "promotion_playlist"
          ? "Manual content shelf"
          : block.section === "home-newscast" ? "Newscast" : block.section === "home-newsletter" ? "Newsletter signup" : block.section === "home-donor" ? "Donor-advised giving" : pageId ? pageCompositionRegionLabel(pageId, block.section) : null}
        editName={pageId === "home" && block.type === "promotion_playlist"
          ? manualShelfEditName(block, authoringBlocks.filter(candidate => candidate.type === "promotion_playlist"))
          : undefined}
        showPageSeedAssets={pageId ? pageHasCompositionSeed(pageId) : false} generatedHeadingLevel={headingLevels[editorIndex] ?? 2}
        errors={blockErrors[block.id]} loadMedia={loadMedia} loadHomeSources={loadHomeSources}
        mediaPickerUnavailable={mediaPickerUnavailable} uploadMedia={uploadMedia}
        mediaCategories={mediaCategories} defaultUploadCategory={defaultUploadCategory}
        onReportingSelectionChange={onReportingSelectionChange}
        canUploadCategory={canUploadCategory} onMediaPickerDirtyChange={onMediaPickerDirtyChange}
        onActivate={activateBlock} onChange={changeBlockData}
        onHomeText={block.section === "home-passport-copy"
          ? (value) => { if (!readOnly) editor.setHomeText(block.id, "passport-heading", value); }
          : undefined}
        onConvertCoverage={block.section === undefined && block.layout === undefined && palette.includes("link_card") ? convertCoverageProse : undefined}
        coverageCardCapacity={coverageCardCapacity}
        removalPrompt={pendingRemovalId === block.id ? blockRemovalPrompt(block, index + 1) : null}
        onDuplicate={editor.duplicateContent} onRemove={requestRemoveBlock} onConfirmRemove={removeBlock}
        onCancelRemove={cancelRemoveBlock} onToggleVisible={toggleBlockVisible} />;
    };

    const duplicateContent = (id: string, column?: number) => {
      if (readOnly) return;
      const containsHubSection = editor.blocks.some(block => block.type === "data_hub_section" &&
        (block.id === id || block.layout?.rowId === id && (column === undefined || block.layout.column === column)));
      if (containsHubSection) {
        successNotice.show("Each Data Hub section can appear once. Add a different section.", { tone: "error" }); return;
      }
      editor.duplicateContent(id, column);
    };
    const renderRowCanvas = (frame?: ReactNode, frameBlockIds?: ReadonlySet<string>, sectionFrames?: ReadonlyMap<string, ContentSectionFrame>) => (
      <ContentRowCanvas homeV2={homeCompositionVersion === 2} loadMedia={loadMedia} showPageSeedAssets={pageId ? pageHasCompositionSeed(pageId) : false} editRequest={editRequest} blocks={authoringBlocks} palette={palette} readOnly={readOnly}
        hideInsertionControls={Boolean(view?.kind) || homeCompositionVersion === 2} allowRows={allowedBlockTypes === undefined || allowedBlockTypes.includes("row")}
        frame={frame} frameBlockIds={frameBlockIds} sectionFrames={sectionFrames} selectedBlockId={activeBlockId} selectedColumn={activeColumn} onSelect={activateBlock}
        rowNotice={pendingRemovalId ? { id: pendingRemovalId, content: (
          <InlineMessage tone="warning" title="Remove this row and its content?">
            <span>This removes {pendingRowChildCount} content {pendingRowChildCount === 1 ? "block" : "blocks"}. You can undo the removal.</span>
            <Button onClick={() => removeBlock(pendingRemovalId, editor.blocks.findIndex(block => block.id === pendingRemovalId) + 1)}>Remove row and content</Button>
            <Button onClick={cancelRemoveBlock}>Keep row</Button>
          </InlineMessage>
        ) } : undefined}
        renderBlock={(block, index, controls) => renderServiceBlock(block, index, controls)} renderKey={blockRenderKey}
        onInsert={insertRowContent}
        onMove={placeContent}
        onDuplicate={duplicateContent}
        onSplit={(id, columns) => { if (!readOnly) editor.editRows({ kind: "split", id, columns }); }}
        onRemove={id => requestRemoveBlock(id, editor.blocks.findIndex(block => block.id === id) + 1)}
        onToggleVisible={toggleBlockVisible} />
    );
    const pendingRowChildCount = editor.blocks.filter(block => block.layout?.rowId === pendingRemovalId).length;

    const homeAdd = homeCompositionVersion === 2 ? <HomeAddMenu variant={view?.kind ? "ghost" : "secondary"} blocks={editor.blocks} palette={palette}
              allowRows={allowedBlockTypes === undefined || allowedBlockTypes.includes("row")}
              readOnly={readOnly || !homeLayoutsEnabled()} loadSources={loadHomeSources}
              destination={activeBlockId && editor.blocks.find(block => block.id === activeBlockId)?.layout
                ? { layout: editor.blocks.find(block => block.id === activeBlockId)!.layout }
                : activeBlockId && activeColumn !== null && editor.blocks.some(block => block.id === activeBlockId && block.type === "row")
                  ? { layout: { rowId: activeBlockId, column: activeColumn } } : {}}
              onInsert={insertRowContent}
              onRestore={id => {
                if (readOnly || !homeLayoutsEnabled()) return;
                editor.setBlockVisible(id, true, true);
                setActiveBlockId(id); setPendingFocusColumn(null); setPendingFocusId(id);
              }}
              onAddSection={(section: OptionalHomeSection) => {
                if (readOnly || !homeLayoutsEnabled()) return;
                const retained = blocksRef.current.find(block => block.section === section);
                if (!retained && blocksRef.current.length >= SECTION_BLOCK_TOTAL_MAX.home) return;
                const id = retained?.id ?? mintBlockId();
                if (retained) editor.setBlockVisible(id, true, true);
                else {
                  const create = section === "home-newsletter" ? createHomeNewsletterBlock
                    : section === "home-newscast" ? createHomeNewscastBlock : createHomeDonorBlock;
                  editor.editRows({ kind: "insert", destination: section === "home-newsletter"
                    ? { beforeId: blocksRef.current.find(block => block.section === "home-start")?.id } : {},
                    block: create(id) as unknown as AdminBlock });
                }
                setActiveBlockId(id); setPendingFocusColumn(null); setPendingFocusId(id);
              }}
              onAddPosts={receipt => {
                if (readOnly || !homeLayoutsEnabled() || blocksRef.current.some(block => block.section === "home-posts") || blocksRef.current.length >= SECTION_BLOCK_TOTAL_MAX.home) return;
                const id = mintBlockId();
                editor.editRows({ kind: "insert", destination: {}, block: { ...createBlock("content_shelf", id), section: "home-posts",
                  data: { title: "From NJ PBS", source: "station_posts", itemLimit: 24, moreLabel: "More from NJ PBS", moreHref: "/posts/",
                    presentation: "grid", columns: 3, selectedIds: [], selectionReceipt: receipt } } });
                setActiveBlockId(id); setPendingFocusColumn(null); setPendingFocusId(id);
              }} /> : null;
    const selected = editor.blocks.find(block => block.id === activeBlockId);
    const movableSelection = selected?.section === "home-passport-action" ? editor.blocks.find(block => block.section === "home-passport-copy") : selected;
    const addDestination: ContentDestination = selected?.layout ? { layout: selected.layout }
      : selected?.type === "row" && activeColumn !== null ? { layout: { rowId: selected.id, column: activeColumn } } : {};
    const videoChecks = section === "post" && editor.blocks.some(block => block.type === "video") ? <ActionControl action="video-checks" variant={view?.phone ? "menu" : "ghost"} size="compact" tooltipLabel="Review the selected video's source and rights checks" onClick={() => { const video = editor.blocks.find(block => block.type === "video"); if (video) goToBlock(video.id); }} /> : null;
    const sharedCommands = <>
      {outlineControl}<EditorHistoryControls arranging={arranging} readOnly={readOnly} canUndo={editor.canUndo} canRedo={editor.canRedo} undo={editor.undo} redo={editor.redo} />
      {homeCompositionVersion === 2 ? homeAdd : <AddContent toolbar blocks={editor.blocks} palette={palette} destination={addDestination}
        allowRows={allowedBlockTypes === undefined || allowedBlockTypes.includes("row")} readOnly={readOnly} onInsert={insertRowContent} triggerLabel="Add" />}
      <ActionControl action="arrange" graphic={view?.phone ? <Icon name="list-ordered" /> : undefined} size="compact" label={arranging ? "Done arranging" : "Arrange"} aria-pressed={arranging} onClick={() => setArranging(value => !value)} />
      {arranging && !view?.specialSelection && movableSelection && !readOnly && canMoveOutlineBlock(movableSelection) ? <MoveContentDialog key={blockRenderKey(movableSelection.id)} block={movableSelection} blocks={editor.blocks} pageLevelIds={(homeCompositionVersion === 2 ? homeStructuralMoveNeighbors(editor.blocks) : editor.blocks.filter(block => !block.layout)).map(block => block.id)} onMove={placeContent} /> : null}
      {view?.phone ? <WorkspaceSecondaryActions>{videoChecks}</WorkspaceSecondaryActions> : videoChecks}
      <span className="editor-selection-path">{view?.specialSelection ? "Page › Home hero" : selected ? view?.kind === "page" ? `Page › ${outlineSummary(selected, pageId)}` : blockLocation(selected) : view?.kind === "post" ? "Post › Article" : "Nothing selected"}</span>
    </>;
    const navigateOutline = useCallback((id: string, column?: number) => {
      if (!view?.kind) { goToBlock(id, column); return; }
      view.setSpecialSelection(null);
      view.setDetailsTab("selection");
      // Navigation never opens a block editor or selects the first child of a row.
      setActiveBlockId(id); setActiveColumn(column ?? null);
      if (view.phone) view.closePane("outline", false);
      setPendingFocusColumn(column ?? null); setPendingFocusId(id);
    }, [goToBlock, view?.kind, view?.phone, view?.closePane, view?.setSpecialSelection, view?.setDetailsTab]);

    return (
      <ElectionResultsSourceHost.Provider value={electionSourceHost ? { ...electionSourceHost, connectionStates: electionConnectionStates, onConnectedChange: onElectionConnectedChange } : null}>
      <ElectionResultsReview.Provider value={electionResultsApprovals}>
      <CustomHtmlEditing.Provider value={canEditCustomHtml}>
      <RemovalNoticeProvider value={reportItemRemoval}>
      <div
        className="block-editor"
        data-content-rows={pageId !== "home" || homeCompositionVersion !== undefined || undefined}
        aria-busy={readOnly}
        onKeyDown={handleHistoryShortcut}
        // Programmatically focusable, never a tab stop: it is where focus parks when a history
        // action destroys the control that held it, so the shortcut stays in scope.
        ref={editorRef}
        tabIndex={-1}
      >
        {readOnly && readOnlyNotice !== null ? (
          <InlineMessage
            tone="info"
            role="status"
            title={readOnlyNotice?.title ?? "Restoring this version"}
          >
            {readOnlyNotice?.message ??
              "Editing will resume after the current document reloads."}
          </InlineMessage>
        ) : null}
        {electionSourceHost ? <EditorOverlayOwner.Provider value={null}><div className="election-source-host"><Suspense fallback={<p>Opening election source controls…</p>}>
          {[...new Map([...(electionSourceHost.publicBlocks ?? []), ...editor.blocks.filter(block => block.type === "election_results")].map(block => [block.id, block])).values()].map(block => <ElectionResultsSourceControls key={block.id} block={block} draftState={!editor.blocks.some(item => item.id === block.id) ? "removed" : !visibleBlockIds.has(block.id) ? "hidden" : undefined} readOnly={readOnly || !editor.blocks.some(item => item.id === block.id)} onChange={(data, discrete) => changeBlockData(block.id, data, discrete)}
            loadMedia={loadMedia} mediaPickerUnavailable={mediaPickerUnavailable} uploadMedia={uploadMedia} mediaCategories={mediaCategories} defaultUploadCategory={defaultUploadCategory} canUploadCategory={canUploadCategory} onMediaPickerDirtyChange={onMediaPickerDirtyChange} />)}
        </Suspense></div></EditorOverlayOwner.Provider> : null}
        <fieldset
          className="editor-readonly-boundary"
          disabled={readOnly}
          ref={(element) => {
            element?.toggleAttribute("inert", readOnly);
          }}
        >
          {view?.kind ? <RetainedEditorHost target={view.editingTarget}><ControlSizingProvider size="compact">{sharedCommands}</ControlSizingProvider></RetainedEditorHost> : commandsInline ? commandBar : (
            <WorkspaceActions>{commandBar}</WorkspaceActions>
          )}

          {!view?.kind && !commandsInline ? <Toolbar className="block-editor-local-outline-bar block-editor-command-bar" aria-label="Content navigation">{outlineControl}</Toolbar> : null}

          {/*
        The way back from a removal, in the editor's own voice: what went, and one control that
        takes it back. It sits beside the editing commands rather than floating over the page, so
        it cannot cover the block that replaced the removed one, and it stays until it is answered,
        dismissed, or made stale — a notice that fades on a timer is no use to somebody who looked
        away (#1035).
      */}
          {removalNotice ? (
            <InlineMessage
              className="block-editor-removal-notice"
              tone="info"
              role="status"
            >
              <span>{removalNotice.message}</span>
              <Button ref={undoNoticeRef} onClick={undoRemoval}>
                Undo removal
              </Button>
              <Button
                variant="ghost"
                aria-label="Dismiss removal notice"
                onClick={() => {
                  // Dismissing takes this button away with the notice, so claim focus for the
                  // editor rather than letting it fall to the document body and take the
                  // history shortcut out of scope with it.
                  setRemovalNotice(null);
                  setFocusClaim((claim) => claim + 1);
                }}
              >
                Dismiss
              </Button>
            </InlineMessage>
          ) : null}

          {editor.error ? (
            <InlineMessage className="block-editor-error" tone="error">
              <span className="error-text">{editor.error}</span>
              <Button onClick={editor.clearError}>Dismiss</Button>
            </InlineMessage>
          ) : null}

          {/*
        The conflict gets its own slot rather than a place in the error chain below, because it
        is not the same kind of thing and the two can be true at once. It is a standing question
        about the document, not a fault in this attempt, and it outlives the attempt: answering
        "save anyway" on a page that then fails validation leaves the person with both an error
        to fix and a question still open. Showing only the conflict would hide what to fix;
        showing only the error would hide that the save is still held, and the button that
        releases it. So both render.

        Naming the available outcomes is the whole design. A normal version conflict has two:
        reloading destroys their work and saving anyway destroys someone else's. A create-only
        conflict has just one because this editor never loaded the newly created page, so an
        overwrite cannot be an informed choice.
      */}
          {conflict ? (
            <InlineMessage
              className="block-editor-error"
              tone="warning"
              // Announced, because this arrives asynchronously: the person pressed Save, focus is
              // still on Save, and the answer is that the save did not happen and the button is now
              // disabled. Without a live region a screen reader reports none of that. InlineMessage
              // only derives a role for error and success tones, so warning is silent by default --
              // right for a warning that is on screen from the start, wrong for one that appears in
              // response to an action. The tone stays warning because this is a question, not a
              // fault; the role is about when it is spoken, not how it looks.
              role="alert"
              title={
                conflictCopy?.title ?? (allowConflictOverwrite || homeCompositionVersion !== undefined
                  ? "Someone else saved this page while you were editing it"
                  : "This page was created while you were editing it")
              }
            >
              <span>
                {conflictCopy?.message ?? (homeCompositionVersion !== undefined
                  ? "Your changes are still here and have not been saved. Reload to review the latest version before applying your edits again."
                  : allowConflictOverwrite
                  ? "Your changes are still here and have not been saved. Saving now would overwrite their work."
                  : "Your changes are still here and have not been saved. Reload the page to review the version that was created.")}
              </span>
              <Toolbar>
                {onReload ? (
                  // Held while a forced save is in flight, so the two answers cannot both be taken.
                  // Reloading mid-save reseeds the editor from the store, and the save that is still
                  // out then reports the version *its* write produced -- leaving the host claiming a
                  // version that does not describe the blocks now on screen, which is the silent
                  // overwrite this whole banner exists to prevent. The host blocks its own rail the
                  // same way while saving; this is the one other way out of a hydrated page.
                  <Button onClick={onReload} disabled={saving}>
                    {conflictCopy?.reloadLabel ?? "Reload the page, discarding your changes"}
                  </Button>
                ) : null}
                {/*
              This is the save control while a conflict stands. The page workspace can hide the
              editor's ordinary Save button in favor of its combined Update action, so this
              control must report its own progress. AsyncActionButton keeps focus in place,
              announces the pending state, and refuses a second click while the write is out.

              Held too when save capability is gone: `canSave` follows a live users/{uid}
              snapshot, so a revoke can land while this question is still on screen. handleSave
              refuses it either way, which would make an enabled button a destructive-looking
              promise that quietly does nothing.
            */}
                {allowConflictOverwrite && homeCompositionVersion === undefined ? (
                  <AsyncActionButton
                    aria-label="Save anyway, overwriting their changes"
                    disabled={!canSave}
                    label="Save anyway, overwriting their changes"
                    onClick={() => void handleSave({ force: true })}
                    pending={saving}
                    pendingLabel="Saving…"
                  />
                ) : null}
              </Toolbar>
            </InlineMessage>
          ) : null}
          {conflict && saving ? (
            // Keep the polite progress update outside the assertive conflict alert. The alert
            // has already explained why the first save stopped; placing this status inside it
            // can make assistive technology repeat the whole warning when the overwrite starts.
            <span
              aria-atomic="true"
              className="block-editor-save-status sr-only"
              role="status"
            >
              Saving…
            </span>
          ) : null}

          {/* One slot for what went wrong with this attempt, so the order here is a priority. */}
          {saveWarnings.length ? <InlineMessage tone="warning" title="Record card warning">
            {saveWarnings.map(warning => <p key={warning}>{warning}</p>)}
          </InlineMessage> : null}
          {structuralError ? (
            <InlineMessage className="block-editor-error" tone="error">
              <span className="error-text">{structuralError}</span>
            </InlineMessage>
          ) : saveError ? (
            <InlineMessage
              className="block-editor-error"
              tone="error"
              title="Save failed"
            >
              <span className="error-text">{saveError}</span>
            </InlineMessage>
          ) : hasBlockErrors ? (
            <InlineMessage className="block-editor-error" tone="error">
              <span className="error-text">
                {conflict
                  ? "Fix the highlighted blocks before overwriting."
                  : "Fix the highlighted blocks before saving."}
              </span>{" "}
              {/* The first invalid block takes focus; the count names the remaining work. */}
              <span className="block-editor-error-count">
                {invalidBlockCount === 1
                  ? "1 block needs attention; it is highlighted in the content."
                  : `${invalidBlockCount} blocks need attention; they are highlighted in the content.`}
              </span>
            </InlineMessage>
          ) : null}

          {pageId === "home" && homeCompositionVersion === undefined && authoringBlocks.length === 0 ? (
            <EmptyState
              title="No manual content shelf"
              description="Add a shelf to feature selected content between the Home sections."
              action={
                <InsertBlockControl
                  index={0}
                  palette={palette}
                  onInsert={editor.insertBlock}
                />
              }
            />
          ) : (
            <>
            {!view?.kind ? homeAdd : null}
            <div className="block-editor-layout" data-outline-collapsed={outlineCollapsed ? "true" : "false"}>
              <RetainedEditorHost target={view?.kind ? arranging ? arrangeTarget : view.outlineTarget : null}>
              <Suspense fallback={<p role="status">Opening outline…</p>}>
              {outlineVisited || outlineVisible ? <PageOutline supplementalSections={supplementalOutlineSections} navigationOnly={Boolean(view?.kind && !arranging)} docked={Boolean(view?.kind)} onClose={closeOutline} triggerRef={outlineTriggerRef} palette={palette} onInsert={insertRowContent} readOnly={readOnly} renderKey={blockRenderKey} activeColumn={activeColumn}
                blocks={outlineBlocks} blockErrors={blockErrors} activeBlockId={activeBlockId}
                collapsed={view?.kind ? false : outlineCollapsed} contentId={outlineId} pageId={pageId} canMoveBlock={canMoveOutlineBlock} fixedPositionReason={fixedOutlinePositionReason} allowInsertion={homeCompositionVersion !== 2}
                includeSectionBoundariesInMoves={homeCompositionVersion !== undefined}
                onNavigateWriting={() => { setActiveBlockId(null); setActiveColumn(null); view?.setDetailsTab("document"); }} onNavigate={navigateOutline} onMove={moveOutlineBlock} onPlace={placeContent} /> : null}
              </Suspense>
              </RetainedEditorHost>
              {view?.kind ? <RetainedEditorHost target={view.selectionTarget}>
                <div className="editor-selection-details">
                  {view.specialSelection ? <h3>Home hero</h3> : selected ? <><h3 className="editor-selection-kind">{outlineTypeLabel(selected)}</h3><p className="editor-selection-title">{outlineSummary(selected, pageId)}</p>
                    {selected.type === "row" ? <Button
                      onClick={() => {
                        setArranging(false);
                        goToBlock(selected.id, activeColumn ?? undefined);
                      }}
                      disabled={readOnly}
                    ><Icon name="pen-square" />Edit row</Button> : null}
                  </> : <p>Select content in the canvas or outline to see its details.</p>}
                </div>
              </RetainedEditorHost> : null}
              <div className="editor-arrange-surface" hidden={!view?.kind || !arranging}>
                <h2>Arrange {section === "post" ? "post content" : "page sections"}</h2>
                <p>Move content using its handle or move controls. Changes remain in this draft.</p>
                <div ref={setArrangeTarget} />
              </div>
              <div className="editor-writing-canvas" hidden={Boolean(view?.kind && arranging)}>{renderRowCanvas()}</div>
            </div>
            </>
          )}
        </fieldset>
      </div>
      </RemovalNoticeProvider>
      </CustomHtmlEditing.Provider>
      </ElectionResultsReview.Provider>
      </ElectionResultsSourceHost.Provider>
    );
  },
);

// The gap between two blocks, memoized for the same reason: a page at the cap carries 41 of these,
// none of which changes when a block's content does. Its palette prop is held by identity by the
// editor above (#511).
const InsertBlockControl = memo(function InsertBlockControl({
  index,
  palette,
  onInsert,
}: {
  index: number;
  palette: readonly BlockType[];
  onInsert: (type: BlockType, index?: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const position = index + 1;
  const optionsId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  // The palette is a temporary panel like the library's create menu: Escape puts it away and
  // returns focus to the trigger, and a pointer anywhere else closes it. Without this a long
  // page could be left with several palettes standing open at once.
  useDismissibleOverlay({ open, root: rootRef, trigger: triggerRef, onClose: close });
  return (
    <div className="block-insert-control" ref={rootRef}>
      <ActionControl
        action="add-block"
        className="block-insert-trigger"
        contextLabel={`position ${position}`}
        aria-controls={optionsId}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        ref={triggerRef}
      />
      <div
        className="block-insert-options"
        id={optionsId}
        role="group"
        aria-label={`Blocks to insert at position ${position}`}
        hidden={!open}
      >
        {palette.map((type) => {
          const descriptionId = `${optionsId}-${type}`;
          return (
            <div className="block-palette-option" key={type}>
              <Button
                aria-describedby={descriptionId}
                className="block-palette-button"
                onClick={() => {
                  onInsert(type, index);
                  setOpen(false);
                }}
              >
                {BLOCK_LABELS[type]}
              </Button>
              {/* Four of these are shelves and the names alone do not tell them apart; the
                  one-line description beside each is how a person chooses without trying
                  each and undoing. */}
              <span className="block-palette-description" id={descriptionId}>
                {BLOCK_DESCRIPTIONS[type]}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
});

// One placed block, memoized on its own props.
//
// The reducer preserves the object identity of every block an edit did not touch, and the handlers
// above are id-based and stable, so a per-block edit changes this card's props for exactly one
// card and React re-renders exactly that one. Before, typing in a block re-rendered every card and
// its whole field tree, which on a page at the 40-block cap made one keystroke about three and a
// half times the work it had to be (#511).
//
// Nothing about correctness rests on the memo: it drops renders whose output would be identical.
// A change that alters what a card shows -- a move (its position), an authored heading above it
// (its generated rank), a save refusal (its markers), a removal question -- arrives as a changed
// prop and still re-renders it.
function manualShelfEditName(block: AdminBlock, shelves: readonly AdminBlock[]): string {
  const heading = String(block.data.title ?? "").trim();
  const position = shelves.findIndex(candidate => candidate.id === block.id) + 1;
  if (!heading) return `Manual content shelf ${position}`;
  const duplicate = shelves.some(candidate =>
    candidate.id !== block.id && String(candidate.data.title ?? "").trim() === heading,
  );
  return duplicate
    ? `Manual content shelf: ${heading} ${position}`
    : `Manual content shelf: ${heading}`;
}

const BlockCard = memo(function BlockCard({
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
  onReportingSelectionChange?: BlockEditorProps["onReportingSelectionChange"];
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
  const removeButton = useRef<HTMLButtonElement>(null);
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
