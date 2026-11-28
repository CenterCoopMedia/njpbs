import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ComponentEditorDialog } from "./ComponentEditorDialog";
import { Button, InlineMessage, Select, TextInput, Textarea } from "./ui/Primitives";
import { cmsUpdateMediaMetadata, type MediaAssetSummary } from "../lib/functions";
import type { MediaSourceSummary, SourceMediaAssetSummary } from "../lib/source-media";
import { useVideoMetadataBatch, type VideoBatchEntry, type VideoMetadataBatch } from "../lib/use-video-metadata-batch";
import {
  BULK_SAVE_INTERVAL_MS, MAX_BULK_VIDEOS, buildBulkMetadataPlan, buildImageBulkPlan,
  classifyImageBulkFailure, emptyBulkMetadataDraft, hasBulkMetadataIntent, imageBulkSave,
  pendingBulkResults, runBulkMetadataPlan, type BulkAsset, type BulkFailure,
  type BulkMetadataDraft, type BulkMetadataPlan, type BulkPlanEntry, type BulkResult,
  type ImageBulkPatch, type MetadataPatch, type TextField,
} from "../lib/source-media-bulk";
import "./SourceMediaBulkEditor.css";
import { SelectionBar } from "./media/SelectionBar";
import {
  VIDEO_SELECTION_CAP, emptySelection, offPageCount, pageSelectionState, refreshSelected,
  removeSelected, selectionSummary, setPageSelection, type MediaSelection, type SelectionRules,
} from "../lib/media-selection";
import { mediaBarActions, mediaSelectionActions, type MediaTileActionId } from "../lib/media-tile-actions";
import { MediaBulkInspector } from "./media/MediaBulkInspector";

interface NavigationGuard {
  navigationBlocked: boolean;
  onKeepNavigation: () => void;
  onDiscardNavigation: () => void;
}
const fieldLabels = { description: "Description", credit: "Credit", license: "License", tags: "Tags", rightsStatus: "Rights review" };
const statusLabels = { pending: "Not attempted", saving: "Saving", saved: "Saved", unchanged: "Unchanged", conflict: "Changed elsewhere", failed: "Needs attention", unconfirmed: "Save unconfirmed" };

function displayValue(key: string, value: unknown) {
  if (Array.isArray(value)) return value.length ? value.join(", ") : "No tags";
  if (key === "rightsStatus" && value === "pending") return "Needs review";
  if (key === "rightsStatus" && value === "complete") return "Recorded";
  return typeof value === "string" && value ? value : "Empty";
}

interface BulkEditorCommonProps extends NavigationGuard {
  initialDraft?: BulkMetadataDraft;
  onBackToEditing?: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onSavingChange: (saving: boolean) => void;
}

type VideoBatchStart<P = MetadataPatch> = {
  nextKey: number | undefined;
  starting: boolean;
  error?: string;
  start: (operationKey: number, entries: VideoBatchEntry<P>[]) => Promise<void>;
};

export type SourceMediaBulkEditorProps = BulkEditorCommonProps & (
  | {
    surface?: "video";
    sourceId: string;
    assets: readonly SourceMediaAssetSummary[];
    canEdit?: never;
    videoBatch: VideoBatchStart;
    onClose: () => void;
  }
  | {
    surface: "images";
    sourceId?: never;
    assets: readonly MediaAssetSummary[];
    canEdit: (asset: MediaAssetSummary) => boolean;
    getIdToken: () => Promise<string>;
    /** The inspector owns image editing, so image review always starts from its frozen draft. */
    initialDraft: BulkMetadataDraft;
    onClose: (results?: BulkResult<MediaAssetSummary, ImageBulkPatch>[]) => void;
  }
);

type ReviewAsset = BulkAsset & { name: string; originalName: string; kind?: string };

interface BulkEditorCoreProps<T extends ReviewAsset, P extends object> extends BulkEditorCommonProps {
  surface: "images" | "video";
  assets: readonly T[];
  buildPlan: (draft: BulkMetadataDraft) => BulkMetadataPlan<T, P> & {
    excluded?: { asset: T; reason: string }[];
  };
  imageSave?: {
    getIdToken: () => Promise<string>;
    save: (token: string, entry: BulkPlanEntry<T, P>) => Promise<T>;
    classifyFailure: (error: unknown) => BulkFailure;
  };
  videoBatch?: VideoBatchStart<P>;
  onClose: (results?: BulkResult<T, P>[]) => void;
}

export function SourceMediaBulkEditor(props: SourceMediaBulkEditorProps) {
  if (props.surface === "images") {
    const { assets, canEdit, getIdToken, initialDraft, onClose, ...common } = props;
    return <BulkEditorCore<MediaAssetSummary, ImageBulkPatch> {...common} assets={assets}
      surface="images" initialDraft={initialDraft} onClose={onClose}
      buildPlan={draft => buildImageBulkPlan(assets, draft, canEdit)}
      imageSave={{ getIdToken, save: (token, entry) => imageBulkSave(token, cmsUpdateMediaMetadata)(entry), classifyFailure: classifyImageBulkFailure }} />;
  }
  const { assets, sourceId, onClose, ...common } = props;
  return <BulkEditorCore<SourceMediaAssetSummary, MetadataPatch> {...common} assets={assets}
    surface="video" onClose={onClose}
    buildPlan={draft => buildBulkMetadataPlan(sourceId, assets, draft)} />;
}

function BulkEditorCore<T extends ReviewAsset, P extends object>({
  surface, assets, initialDraft, onBackToEditing, onClose, onDirtyChange,
  onSavingChange, navigationBlocked, onKeepNavigation, onDiscardNavigation, buildPlan,
  imageSave, videoBatch,
}: BulkEditorCoreProps<T, P>) {
  const id = useId();
  const [draft, setDraft] = useState(() => initialDraft ?? emptyBulkMetadataDraft());
  const [reviewing, setReviewing] = useState(Boolean(initialDraft));
  const [validationRequested, setValidationRequested] = useState(false);
  const [imageSaving, setSaving] = useState(false);
  const [finished, setFinished] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [runError, setRunError] = useState("");
  const [results, setResults] = useState<BulkResult<T, P>[]>();
  const busy = useRef(false);
  const submittedKey = useRef<number>();
  const mounted = useRef(true);
  const stopRequested = useRef(false);
  const wake = useRef<() => void>();
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const keepEditing = useRef<HTMLButtonElement>(null);
  const plan = useMemo(() => buildPlan(draft), [buildPlan, draft]);
  const excluded = plan.excluded ?? [];
  const kinds = new Set(assets.map(asset => asset.kind).filter((kind): kind is string => Boolean(kind)));
  const imageNoun = kinds.size === 1 && kinds.has("image")
    ? ["image", "images"]
    : kinds.size === 1 && kinds.has("document")
      ? ["document", "documents"]
      : ["item", "items"];
  const [singular, plural] = surface === "images" ? imageNoun : ["video", "videos"];
  const countLabel = (count: number) => count === 1 ? singular : plural;
  const changedCount = plan.entries.filter(entry => Object.keys(entry.changes).length > 0).length;
  const saving = imageSaving || videoBatch?.starting === true;
  const unresolvedResults = finished && results?.some(row => row.status !== "saved" && row.status !== "unchanged") === true;
  const dirty = hasBulkMetadataIntent(draft) && (!finished || unresolvedResults);
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  useEffect(() => { onSavingChange(saving); return () => onSavingChange(false); }, [saving, onSavingChange]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; stopRequested.current = true; wake.current?.(); };
  }, []);
  useEffect(() => { if (reviewing) reviewHeading.current?.focus(); }, [reviewing, finished]);
  useEffect(() => { if (confirmClose) keepEditing.current?.focus(); }, [confirmClose]);

  function close() {
    if (busy.current || saving) return;
    if (dirty) setConfirmClose(true);
    else onClose(results);
  }
  function stop() { stopRequested.current = true; setStopping(true); wake.current?.(); }
  function waitBetweenSaves() {
    return new Promise<void>(resolve => {
      const finish = () => { window.clearTimeout(timer); wake.current = undefined; resolve(); };
      const timer = window.setTimeout(finish, BULK_SAVE_INTERVAL_MS);
      wake.current = finish;
    });
  }
  async function apply() {
    if (busy.current || saving || finished || !reviewing || plan.errors.length || changedCount === 0) return;
    if (videoBatch) {
      const operationKey = submittedKey.current ?? videoBatch.nextKey;
      if (operationKey === undefined) return;
      submittedKey.current = operationKey;
      await videoBatch.start(operationKey, plan.entries.map(({ asset, changes }) => ({
        assetId: asset.id, expectedVersion: asset.version, changes,
      })));
      return;
    }
    if (!imageSave) return;
    busy.current = true;
    stopRequested.current = false;
    setSaving(true);
    setStopping(false);
    setConfirmClose(false);
    setRunError("");
    setResults(pendingBulkResults(plan));
    try {
      // One short-lived token in this call only; every save retains server auth and App Check.
      const token = await imageSave.getIdToken();
      const next = await runBulkMetadataPlan(plan, {
        save: entry => imageSave.save(token, entry),
        classifyFailure: imageSave.classifyFailure,
        shouldStop: () => stopRequested.current || !mounted.current,
        wait: waitBetweenSaves,
        onProgress: next => { if (mounted.current) setResults(next); },
      });
      if (mounted.current) { setResults(next); setFinished(true); }
    } catch {
      if (mounted.current) setRunError("The batch could not start. No additional saves were sent. Check your connection and try again.");
    } finally {
      busy.current = false;
      if (mounted.current) { setSaving(false); setStopping(false); }
    }
  }
  function setText(field: TextField, change: Partial<BulkMetadataDraft[TextField]>) {
    setDraft(previous => ({ ...previous, [field]: { ...previous[field], ...change } }));
  }
  const rows = results ?? pendingBulkResults(plan);
  const completed = rows.filter(row => row.status !== "pending" && row.status !== "saving").length;
  const savedCount = rows.filter(row => row.status === "saved").length;
  const unchangedCount = rows.filter(row => row.status === "unchanged").length;
  const remainingCount = rows.length - savedCount - unchangedCount;

  return <ComponentEditorDialog open title={`Edit selected ${plural}`} description={`${assets.length} selected ${plural}. Only the fields you choose will change.`}
    onClose={close} closeDisabled={saving} closeLabel={finished ? "Back to library" : "Cancel"} focusTargetId={initialDraft ? undefined : `${id}-tags-action`}
    footerNote={imageSaving ? "Saves run one file at a time. Keep this window open." : "Updates affect staff-library metadata only, not the original files or public site."}
    footerActions={finished ? undefined : <>
      {reviewing && !saving && !finished ? <Button onClick={() => {
        if (onBackToEditing) { onBackToEditing(); return; }
        submittedKey.current = undefined;
        setReviewing(false); setResults(undefined); setRunError("");
        requestAnimationFrame(() => document.getElementById(`${id}-tags-action`)?.focus());
      }}>Back to editing</Button> : null}
      {imageSaving ? <Button disabled={stopping} onClick={stop}>{stopping ? "Stopping after current file" : "Stop after current file"}</Button>
        : <Button variant="primary" type="submit" form={`${id}-form`}
          disabled={saving || (reviewing && (changedCount === 0 || plan.errors.length > 0 || Boolean(videoBatch && videoBatch.nextKey === undefined && submittedKey.current === undefined)))}>
          {reviewing ? `Apply to ${changedCount} ${countLabel(changedCount)}` : "Review changes"}
        </Button>}
    </>}>
    <div className="source-bulk-editor">
      {navigationBlocked ? <InlineMessage tone="warning" title={unresolvedResults ? "Leave with unresolved batch results?" : "Leave with unsaved batch changes?"}>
        <p>{unresolvedResults ? `Some saves are not confirmed. Check each unresolved ${singular} before retrying. Saved files are not undone.` : "Leaving discards this batch form. Already saved files are not undone."}</p>
        <Button onClick={onDiscardNavigation}>{unresolvedResults ? "Leave this page" : "Leave without saving"}</Button><Button onClick={onKeepNavigation}>{unresolvedResults ? "Keep results open" : "Keep editing"}</Button>
      </InlineMessage> : null}
      {confirmClose ? <InlineMessage tone="warning" title={unresolvedResults ? "Return with unresolved batch results?" : "Discard batch changes?"}>
        <p>{unresolvedResults ? `Check each unresolved ${singular} before retrying. Saved files are not undone.` : "This discards the unapplied form. Previously saved changes are not undone."}</p><Button onClick={() => onClose(unresolvedResults ? results : undefined)}>{unresolvedResults ? "Return to library" : "Discard batch changes"}</Button><Button ref={keepEditing} onClick={() => { setConfirmClose(false); requestAnimationFrame(() => reviewing ? reviewHeading.current?.focus() : document.getElementById(`${id}-tags-action`)?.focus()); }}>{unresolvedResults ? "Keep results open" : "Keep editing"}</Button>
      </InlineMessage> : null}
      {runError ? <InlineMessage tone="error" title="Batch needs attention">{runError}</InlineMessage> : null}
      {videoBatch?.error ? <InlineMessage tone="error" title="Batch needs attention">{videoBatch.error} Close this review to check the latest batch from the library.</InlineMessage> : null}
      {videoBatch?.starting ? <p role="status">Starting video batch…</p> : null}
      <form id={`${id}-form`} onSubmit={event => {
        event.preventDefault();
        if (reviewing) { void apply(); return; }
        setValidationRequested(true);
        if (!plan.errors.length) { setReviewing(true); setConfirmClose(false); }
      }}>
        {!reviewing ? <div className="source-bulk-fields">
          <p>Leave unchanged preserves each video's own value, even when the selected videos have different metadata. Titles and filenames are not changed in bulk.</p>
          <fieldset><legend>Tags</legend>
            <label htmlFor={`${id}-tags-action`}>Tag action</label>
            <Select id={`${id}-tags-action`} value={draft.tags.mode} onChange={event => setDraft(previous => ({ ...previous, tags: { ...previous.tags, mode: event.target.value as BulkMetadataDraft["tags"]["mode"] } }))}>
              <option value="keep">Leave unchanged</option><option value="add">Add tags</option><option value="remove">Remove specific tags</option><option value="replace">Replace all tags</option><option value="clear">Clear all tags</option>
            </Select>
            {!["keep", "clear"].includes(draft.tags.mode) ? <label>Tags to {draft.tags.mode === "replace" ? "use" : draft.tags.mode}
              <Textarea maxLength={2460} aria-describedby={`${id}-tag-help`} value={draft.tags.value} onChange={event => setDraft(previous => ({ ...previous, tags: { ...previous.tags, value: event.target.value } }))} />
            </label> : null}
            <p id={`${id}-tag-help`}>Separate tags with commas or new lines. Spelling and case must match existing tags. Each video can have 30 tags; each tag can have 80 characters.</p>
            {draft.tags.mode === "replace" || draft.tags.mode === "clear" ? <p className="source-bulk-warning">This removes the selected videos' existing tags. Check the before-and-after review before applying.</p> : null}
          </fieldset>
          <details className="source-bulk-metadata"><summary>Other metadata</summary>
            {(["description", "credit", "license"] as const).map(field => <fieldset key={field}><legend>{fieldLabels[field]}</legend>
              <label>{fieldLabels[field]} action<Select value={draft[field].mode} onChange={event => setText(field, { mode: event.target.value as BulkMetadataDraft[TextField]["mode"] })}>
                <option value="keep">Leave unchanged</option><option value="set">Set the same value</option><option value="clear">Clear this field</option>
              </Select></label>
              {draft[field].mode === "set" ? <label>New {field}{field === "description"
                ? <Textarea maxLength={2000} value={draft[field].value} onChange={event => setText(field, { value: event.target.value })} />
                : <TextInput maxLength={500} value={draft[field].value} onChange={event => setText(field, { value: event.target.value })} />}</label> : null}
            </fieldset>)}
            <fieldset><legend>Rights review</legend><label>Rights review action<Select value={draft.rightsStatus} onChange={event => setDraft(previous => ({ ...previous, rightsStatus: event.target.value as BulkMetadataDraft["rightsStatus"] }))}>
              <option value="keep">Leave unchanged</option><option value="pending">Needs review</option><option value="complete">Recorded</option>
            </Select></label><p>Recorded means staff completed the review. It does not grant permission to publish or use a video.</p></fieldset>
          </details>
          {validationRequested && plan.errors.length ? <InlineMessage tone="error" title="Fix these changes before reviewing"><ul>{plan.errors.map((error, index) => <li key={index}>{error}</li>)}</ul></InlineMessage> : null}
        </div> : <section aria-labelledby={`${id}-review`}>
          <h3 ref={reviewHeading} id={`${id}-review`} tabIndex={-1}>{finished ? "Batch results" : "Review changes"}</h3>
          {plan.errors.length ? <InlineMessage tone="error" title="Fix these changes before applying"><ul>{plan.errors.map((error, index) => <li key={index}>{error}</li>)}</ul></InlineMessage> : null}
          {finished ? <p role="status">{savedCount} saved · {unchangedCount} already matched · {remainingCount} not confirmed saved.</p>
            : imageSaving ? <><p role="status">{completed} of {rows.length} processed · {savedCount} saved{stopping ? " · Stopping" : ""}</p><progress aria-label="Batch save progress" value={completed} max={Math.max(1, rows.length)} /></>
              : <p>{changedCount} {countLabel(changedCount)} will change; {plan.entries.length - changedCount} already match. Expand a {singular} to compare its current and proposed values. Nothing is saved until you select Apply.</p>}
          {finished && remainingCount > 0 ? <InlineMessage tone="warning" title={`Some ${plural} still need attention`}>Saved changes are not rolled back. The remaining {plural} stay selected. Reopen conflicts or unconfirmed saves to review current details before starting another batch. No saves are retried automatically.</InlineMessage> : null}
          {excluded.length ? <section aria-labelledby={`${id}-excluded`}><h4 id={`${id}-excluded`}>Images left out</h4>
            <ul>{excluded.map(({ asset, reason }) => <li key={asset.id}><strong>{asset.name}</strong>: {reason}</li>)}</ul>
          </section> : null}
          <ul className="source-bulk-review" aria-label={`Selected ${plural} and changes`}>{rows.map((row, index) => <li key={row.asset.id}>
            <div className="source-bulk-review-heading"><strong>{row.asset.name}</strong><span>{statusLabels[row.status]}</span></div>
            <p>{row.asset.originalName}</p>
            {row.status === "conflict" || row.status === "failed" || row.status === "unconfirmed" ? <p>{row.message}</p> : null}
            {Object.keys(row.changes).length ? <details><summary>Changes for {row.asset.name}</summary><dl>{Object.entries(row.changes).map(([key, value]) => <div key={key}>
              <dt>{fieldLabels[key as keyof typeof fieldLabels]}</dt><dd><span>Before: {displayValue(key, (plan.entries[index].asset as unknown as Record<string, unknown>)[key])}</span><span>After: {displayValue(key, value)}</span></dd>
            </div>)}</dl></details> : <p>Already matches; no save needed.</p>}
          </li>)}</ul>
        </section>}
      </form>
    </div>
  </ComponentEditorDialog>;
}

/**
 * Selection stays local to one user/source and never expands an unloaded query. The shared
 * grid (MediaGrid) changes the selection through changeSelection and rules; this hook owns the
 * shared SelectionBar and the batch editor.
 */
export function useSourceMediaBulkEditing({ source, userId, records, pageTags = [], recentTags = [], getIdToken, disabled, onRefresh, onTagsSaved, returnFocus }: {
  source: MediaSourceSummary; userId: string; records: SourceMediaAssetSummary[];
  pageTags?: readonly string[]; recentTags?: readonly string[];
  getIdToken: () => Promise<string>; disabled: boolean; onRefresh: () => void;
  onTagsSaved?: (tags: readonly string[]) => void;
  /** Decision 3: after Clear selection or a bulk action. Defaults to the search field. */
  returnFocus?: () => void;
}) {
  const scope = `${userId}:${source.id}`;
  const [scoped, setScoped] = useState<{ scope: string; selection: MediaSelection<SourceMediaAssetSummary> }>({ scope, selection: emptySelection() });
  const [session, setSession] = useState<{ scope: string; assets: SourceMediaAssetSummary[]; reviewing: boolean; draft?: BulkMetadataDraft }>();
  const [inspectorDirty, setInspectorDirty] = useState(false);
  const [reviewDirty, setReviewDirty] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const [saving, setSaving] = useState(false);
  const recovery = useVideoMetadataBatch(userId, source.id, source.canEditMetadata, getIdToken);
  const [batchOpenScope, setBatchOpenScope] = useState<string>();
  const batchOpen = batchOpenScope === scope && source.canEditMetadata;
  const submitted = useRef<{ operationKey: number; entries: Map<string, string[]> }>();
  const selection = scoped.scope === scope ? scoped.selection : emptySelection<SourceMediaAssetSummary>();
  const assets = selection.items;
  const visible = records.filter(asset => asset.sourceId === source.id);
  const editing = Boolean(session && session.scope === scope && source.canEditMetadata);
  const open = editing || batchOpen;
  const reviewOpen = editing && session?.reviewing === true;
  const selectionBusy = open;
  const locked = disabled || selectionBusy;
  const rules = useMemo<SelectionRules<SourceMediaAssetSummary>>(() => ({
    cap: VIDEO_SELECTION_CAP,
    accepts: asset => asset.sourceId === source.id,
  }), [source.id]);
  const focusAfter = () => requestAnimationFrame(() => (returnFocus ?? focusVideoSearch)());
  useEffect(() => {
    setScoped({ scope, selection: emptySelection() });
    setSession(undefined);
    setBatchOpenScope(undefined);
    submitted.current = undefined;
  }, [scope, source.canEditMetadata]);
  useEffect(() => {
    if (selectionBusy || !records.length) return;
    setScoped(previous => {
      if (previous.scope !== scope) return previous;
      const next = refreshSelected(previous.selection, records, (item, record) => record.sourceId === source.id && record.id === item.id);
      return next === previous.selection ? previous : { scope, selection: next };
    });
  }, [records, scope, source.id, selectionBusy]);

  function changeSelection(next: MediaSelection<SourceMediaAssetSummary>) {
    if (locked) return;
    setScoped({ scope, selection: next });
  }
  function clear() {
    if (selectionBusy) return;
    setScoped({ scope, selection: emptySelection() });
    focusAfter();
  }
  function refreshAsset(asset: SourceMediaAssetSummary) {
    setScoped(previous => previous.scope !== scope ? previous : {
      scope,
      selection: { ...previous.selection, items: previous.selection.items.map(item => item.id === asset.id && item.sourceId === asset.sourceId ? asset : item) },
    });
  }
  function removeAsset(id: string) {
    setScoped(previous => ({ ...previous, selection: removeSelected(previous.selection, id) }));
  }
  function edit() {
    if (locked || !assets.length || !source.canEditMetadata) return;
    if (recovery.batch?.status === "active") {
      inspectBatch();
      return;
    }
    setSession({ scope, assets: [...assets], reviewing: false });
  }
  function inspectBatch() {
    if (locked || !source.canEditMetadata) return;
    setBatchOpenScope(scope);
    void recovery.run({ action: "inspect" });
  }
  function startBatch(operationKey: number, entries: VideoBatchEntry[]) {
    return recovery.run({ action: "start", operationKey, entries, onStarted(batch) {
      submitted.current = { operationKey: batch.operationKey, entries: new Map(entries.map(entry => [entry.assetId, entry.changes.tags ?? []])) };
      close();
      setBatchOpenScope(scope);
    } });
  }
  function selectionAction(id: MediaTileActionId) {
    if (id === "clear-selection") clear();
    if (id === "edit-selected") edit();
  }
  function close() {
    setSession(undefined);
    setInspectorDirty(false);
    setReviewDirty(false);
  }
  function closeBatch() {
    const batch = recovery.batch;
    if (batch) {
      const recorded = submitted.current;
      if (recorded?.operationKey === batch.operationKey) {
        const completedIds = new Set<string>();
        const tags: string[] = [];
        for (const item of batch.items) {
          if (item.status !== "saved" && item.status !== "unchanged") continue;
          const added = recorded.entries.get(item.assetId);
          if (!added) continue;
          if (item.status === "saved") tags.push(...added);
          completedIds.add(item.assetId);
          recorded.entries.delete(item.assetId);
        }
        if (completedIds.size) setScoped(previous => ({
          ...previous, selection: { ...previous.selection, items: previous.selection.items.filter(asset => !completedIds.has(asset.id)), error: "" },
        }));
        if (tags.length) onTagsSaved?.(tags);
      }
    }
    if (recovery.takeRefresh()) onRefresh();
    setBatchOpenScope(undefined);
    focusAfter();
  }
  function discard() {
    close();
    setBatchOpenScope(undefined);
  }
  const offPage = offPageCount(assets, visible);
  const pageState = pageSelectionState(assets, visible);
  const selectionActions = mediaSelectionActions({ surface: "video", count: assets.length, canEdit: source.canEditMetadata });
  return {
    open, reviewOpen, dirty: editing && (reviewOpen ? reviewDirty : inspectorDirty),
    saving: (editing && saving) || (batchOpen && (recovery.activity === "saving" || recovery.activity === "canceling")),
    discard, refreshAsset, removeAsset,
    selectionActions, selectionBusy,
    selection, rules, changeSelection, clear, edit, selectionAction,
    /** The list header's Select this page: the same state and change as the bar's. */
    pageSelection: {
      state: pageState,
      disabled: locked || !visible.length,
      onChange: (checked: boolean) => changeSelection(setPageSelection(selection, visible, checked, rules)),
    },
    /** Selecting and card actions wait while the viewer or the batch editor is open. */
    locked,
    /** The always-mounted announcement of the count; the bar has no live region of its own. */
    summary: assets.length ? selectionSummary({ count: assets.length, offPage, cap: MAX_BULK_VIDEOS }) : "",
    notice: <>{source.canEditMetadata && (recovery.batch || recovery.error) ? <div>
        <Button disabled={locked || Boolean(recovery.activity)} onClick={inspectBatch}>{recovery.batch ? "Latest video batch" : "Check video batch"}</Button>
      </div> : null}
      {/* A refused change with nothing selected has no bar to carry its message. */}
      {!assets.length && selection.error ? <p className="source-bulk-selection-error" role="alert">{selection.error}</p> : null}</>,
    bar: <SelectionBar
      actions={mediaBarActions(selectionActions)}
      actionsDisabled={locked}
      cap={MAX_BULK_VIDEOS}
      clearDisabled={selectionBusy}
      count={assets.length}
      error={selection.error}
      info="Selection carries across pages and filters."
      label="Video selection"
      offPage={offPage}
      onAction={selectionAction}
      onClear={clear}
      onPageChange={checked => changeSelection(setPageSelection(selection, visible, checked, rules))}
      pageDisabled={locked || !visible.length}
      pageState={pageState} />,
    inspector: editing && session ? <MediaBulkInspector key={`inspector:${scope}`} open={!reviewOpen} reviewing={reviewOpen}
      surface="video" assets={session.assets} pageTags={pageTags} recentTags={recentTags} offPageCount={offPage} focusRequest={focusRequest}
      onCancel={() => close()} onReview={draft => { setReviewDirty(true); setSession(previous => previous ? { ...previous, draft, reviewing: true } : previous); }}
      onDirtyChange={setInspectorDirty} /> : null,
    editor: (navigation: NavigationGuard) => batchOpen ? <VideoMetadataBatchDialog key={`batch:${scope}`} recovery={recovery} onClose={closeBatch} />
      : reviewOpen && session?.draft ? <SourceMediaBulkEditor key={`review:${scope}`} sourceId={source.id} assets={session.assets}
      videoBatch={{
        nextKey: recovery.batch === undefined || recovery.batch?.status === "active" ? undefined : (recovery.batch?.operationKey ?? 0) + 1,
        starting: recovery.activity === "saving", error: recovery.error, start: startBatch,
      }}
      initialDraft={session.draft} onBackToEditing={() => { setSession(previous => previous ? { ...previous, reviewing: false } : previous); setFocusRequest(value => value + 1); }}
      onClose={close} onDirtyChange={setReviewDirty} onSavingChange={setSaving} {...navigation} /> : null,
  };
}

const videoBatchStatus = {
  pending: "Pending", saved: "Saved", unchanged: "Unchanged", stale: "Changed elsewhere",
  unavailable: "Video unavailable", canceled: "Canceled",
} satisfies Record<VideoMetadataBatch["items"][number]["status"], string>;

function VideoMetadataBatchDialog({ recovery, onClose }: { recovery: ReturnType<typeof useVideoMetadataBatch>; onClose: () => void }) {
  const { batch, activity, error, pausing, pause, run } = recovery;
  const [confirmKey, setConfirmKey] = useState<number>();
  const summaryId = useId();
  const summary = useRef<HTMLParagraphElement>(null);
  const keepBatch = useRef<HTMLButtonElement>(null);
  const pending = batch?.items.filter(item => item.status === "pending").length ?? 0;
  const saved = batch?.items.filter(item => item.status === "saved").length ?? 0;
  const canContinue = batch?.status === "active" && !activity && !error;
  const confirming = canContinue && confirmKey === batch.operationKey;
  useEffect(() => {
    if (confirming) keepBatch.current?.focus();
    else summary.current?.focus();
  }, [activity, confirming]);
  return <ComponentEditorDialog open title="Video batch results" focusTargetId={summaryId}
    onClose={onClose} closeDisabled={activity === "saving" || activity === "canceling"} closeLabel="Back to library"
    footerNote="The library keeps your latest batch results."
    footerActions={activity === "saving" ? <Button disabled={pausing} onClick={pause}>{pausing ? "Pausing after current video" : "Pause after current video"}</Button>
      : error ? <Button disabled={Boolean(activity)} onClick={() => void run({ action: "inspect" })}>Check batch status</Button>
      : canContinue && !confirming ? <>
        <Button onClick={() => setConfirmKey(batch.operationKey)}>Cancel remaining videos</Button>
        <Button variant="primary" onClick={() => void run({ action: "resume", operationKey: batch.operationKey })}>Resume batch</Button>
      </> : undefined}>
    <div className="source-bulk-editor">
      <p ref={summary} id={summaryId} tabIndex={-1} role="status">
        {activity === "checking" ? "Checking latest batch…"
          : activity === "canceling" ? "Canceling remaining videos…"
          : batch ? `${saved} saved · ${pending} pending${activity === "saving" ? " · Saving" : ""}`
          : error ? "Batch results are unavailable." : "No video batch yet."}
      </p>
      {error ? <InlineMessage tone="error" title="Batch needs attention">{error}</InlineMessage> : null}
      {confirming ? <InlineMessage tone="warning" title="Cancel the remaining videos?">
        <p>Saved video changes will stay in the library.</p>
        <Button onClick={() => { setConfirmKey(undefined); void run({ action: "cancel", operationKey: batch.operationKey }); }}>Confirm cancellation</Button>
        <Button ref={keepBatch} onClick={() => setConfirmKey(undefined)}>Keep batch</Button>
      </InlineMessage> : null}
      {batch ? <ul className="source-bulk-review">{batch.items.map((item, index) => <li key={item.assetId}>
        <div className="source-bulk-review-heading"><strong>{item.name || item.originalName || `Video ${index + 1}`}</strong><span>{videoBatchStatus[item.status]}</span></div>
        {item.originalName && item.originalName !== item.name ? <p>{item.originalName}</p> : null}
        {item.status === "stale" ? <p>Open the video to review its latest details before making another change.</p> : null}
      </li>)}</ul> : null}
    </div>
  </ComponentEditorDialog>;
}

function focusVideoSearch() { document.getElementById("video-search")?.focus(); }
