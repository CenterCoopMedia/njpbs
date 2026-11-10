import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { ComponentEditorDialog } from "./ComponentEditorDialog";
import { MediaCollectionPicker } from "./MediaCollectionPicker";
import { useSuccessNotice } from "./ui/SuccessNoticeRegion";
import { Button, InlineMessage, Select, TextInput, Textarea } from "./ui/Primitives";
import { cmsUpdateMediaMetadata, HttpError, type MediaAssetSummary } from "../lib/functions";
import { updateSourceMediaMetadata, type MediaSourceSummary, type SourceMediaAssetSummary } from "../lib/source-media";
import {
  BULK_SAVE_INTERVAL_MS, MAX_BULK_VIDEOS, buildBulkMetadataPlan, buildImageBulkPlan,
  classifyImageBulkFailure, emptyBulkMetadataDraft, hasBulkMetadataIntent, imageBulkSave,
  pendingBulkResults, runBulkMetadataPlan, type BulkAsset, type BulkFailure,
  type BulkMetadataDraft, type BulkMetadataPlan, type BulkPlanEntry, type BulkResult,
  type ImageBulkPatch, type MetadataPatch, type TextField,
} from "../lib/source-media-bulk";
import "./SourceMediaBulkEditor.css";
import { mediaCollectionsPath } from "../lib/routes";
import { SelectionBar } from "./media/SelectionBar";
import {
  VIDEO_SELECTION_CAP, collectionCapError, emptySelection, offPageCount, pageSelectionState, refreshSelected,
  removeSelected, selectionSummary, setPageSelection, type MediaSelection, type SelectionRules,
} from "../lib/media-selection";
import { mediaBarActions, mediaSelectionActions, type MediaTileActionId } from "../lib/media-tile-actions";
import { MediaBulkInspector } from "./media/MediaBulkInspector";
import { setMediaFavorites } from "../lib/media-favorites";
import type { useMediaFavorites } from "../lib/use-media-favorites";
import { markMediaTabCountsStale, publishFavoritesChange } from "../lib/media-session-cache";

interface NavigationGuard {
  navigationBlocked: boolean;
  onKeepNavigation: () => void;
  onDiscardNavigation: () => void;
}
const fieldLabels = { description: "Description", credit: "Credit", license: "License", tags: "Tags", rightsStatus: "Rights review" };
const statusLabels = { pending: "Not attempted", saving: "Saving", saved: "Saved", unchanged: "Unchanged", conflict: "Changed elsewhere", failed: "Needs attention", unconfirmed: "Save unconfirmed" };

export function classifyBulkSaveFailure(error: unknown): BulkFailure {
  if (error instanceof HttpError) {
    if (error.status === 409) return { status: "conflict", stop: false, message: "Changed elsewhere. Reopen this video and review its latest details before retrying." };
    if (error.status === 401 || error.status === 403) return { status: "failed", stop: true, message: "Access could not be verified. The batch stopped; check your access before retrying." };
    if (error.status === 429) return { status: "failed", stop: true, message: "The save limit was reached. The batch stopped; wait before retrying the remaining videos." };
    if (error.status >= 400 && error.status < 500 && error.status !== 408) return { status: "failed", stop: false, message: error.message || "This video could not be updated. Review its details before retrying." };
  }
  return { status: "unconfirmed", stop: true, message: "The save was not confirmed and may have completed. The batch stopped. Reopen this video to check before retrying." };
}

function displayValue(key: string, value: unknown) {
  if (Array.isArray(value)) return value.length ? value.join(", ") : "No tags";
  if (key === "rightsStatus" && value === "pending") return "Needs review";
  if (key === "rightsStatus" && value === "complete") return "Recorded";
  return typeof value === "string" && value ? value : "Empty";
}

interface BulkEditorCommonProps extends NavigationGuard {
  getIdToken: () => Promise<string>;
  initialDraft?: BulkMetadataDraft;
  onBackToEditing?: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onSavingChange: (saving: boolean) => void;
}

export type SourceMediaBulkEditorProps = BulkEditorCommonProps & (
  | {
    surface?: "video";
    sourceId: string;
    assets: readonly SourceMediaAssetSummary[];
    canEdit?: never;
    onClose: (results?: BulkResult<SourceMediaAssetSummary, MetadataPatch>[]) => void;
  }
  | {
    surface: "images";
    sourceId?: never;
    assets: readonly MediaAssetSummary[];
    canEdit: (asset: MediaAssetSummary) => boolean;
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
  save: (token: string, entry: BulkPlanEntry<T, P>) => Promise<T>;
  classifyFailure: (error: unknown) => BulkFailure;
  onClose: (results?: BulkResult<T, P>[]) => void;
}

export function SourceMediaBulkEditor(props: SourceMediaBulkEditorProps) {
  if (props.surface === "images") {
    const { assets, canEdit, initialDraft, onClose, ...common } = props;
    return <BulkEditorCore<MediaAssetSummary, ImageBulkPatch> {...common} assets={assets}
      surface="images" initialDraft={initialDraft} onClose={onClose}
      buildPlan={draft => buildImageBulkPlan(assets, draft, canEdit)}
      save={(token, entry) => imageBulkSave(token, cmsUpdateMediaMetadata)(entry)}
      classifyFailure={classifyImageBulkFailure} />;
  }
  const { assets, sourceId, onClose, ...common } = props;
  return <BulkEditorCore<SourceMediaAssetSummary, MetadataPatch> {...common} assets={assets}
    surface="video" onClose={onClose}
    buildPlan={draft => buildBulkMetadataPlan(sourceId, assets, draft)}
    save={async (token, entry) => (await updateSourceMediaMetadata(token, sourceId, entry.asset.id, entry.asset.version, entry.changes)).asset}
    classifyFailure={classifyBulkSaveFailure} />;
}

function BulkEditorCore<T extends ReviewAsset, P extends object>({
  surface, assets, getIdToken, initialDraft, onBackToEditing, onClose, onDirtyChange,
  onSavingChange, navigationBlocked, onKeepNavigation, onDiscardNavigation, buildPlan,
  save, classifyFailure,
}: BulkEditorCoreProps<T, P>) {
  const id = useId();
  const [draft, setDraft] = useState(() => initialDraft ?? emptyBulkMetadataDraft());
  const [reviewing, setReviewing] = useState(Boolean(initialDraft));
  const [validationRequested, setValidationRequested] = useState(false);
  const [saving, setSaving] = useState(false);
  const [finished, setFinished] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [runError, setRunError] = useState("");
  const [results, setResults] = useState<BulkResult<T, P>[]>();
  const busy = useRef(false);
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
    if (busy.current) return;
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
    if (busy.current || finished || !reviewing || plan.errors.length || changedCount === 0) return;
    busy.current = true;
    stopRequested.current = false;
    setSaving(true);
    setStopping(false);
    setConfirmClose(false);
    setRunError("");
    setResults(pendingBulkResults(plan));
    try {
      // One short-lived token in this call only; every save retains server auth and App Check.
      const token = await getIdToken();
      const next = await runBulkMetadataPlan(plan, {
        save: entry => save(token, entry),
        classifyFailure,
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
    footerNote={saving ? "Saves run one file at a time. Keep this window open." : "Updates affect staff-library metadata only, not the original files or public site."}
    footerActions={finished ? undefined : <>
      {reviewing && !saving && !finished ? <Button onClick={() => {
        if (onBackToEditing) { onBackToEditing(); return; }
        setReviewing(false); setResults(undefined); setRunError("");
        requestAnimationFrame(() => document.getElementById(`${id}-tags-action`)?.focus());
      }}>Back to editing</Button> : null}
      {saving ? <Button disabled={stopping} onClick={stop}>{stopping ? "Stopping after current file" : "Stop after current file"}</Button>
        : <Button variant="primary" type="submit" form={`${id}-form`} disabled={reviewing && (changedCount === 0 || plan.errors.length > 0)}>{reviewing ? `Apply to ${changedCount} ${countLabel(changedCount)}` : "Review changes"}</Button>}
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
            : saving ? <><p role="status">{completed} of {rows.length} processed · {savedCount} saved{stopping ? " · Stopping" : ""}</p><progress aria-label="Batch save progress" value={completed} max={Math.max(1, rows.length)} /></>
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
 * shared SelectionBar, the collection picker and the batch editor.
 */
export function useSourceMediaBulkEditing({ source, userId, records, favorites, pageTags = [], recentTags = [], getIdToken, disabled, onRefresh, onTagsSaved, returnFocus }: {
  source: MediaSourceSummary; userId: string; records: SourceMediaAssetSummary[];
  favorites: Pick<ReturnType<typeof useMediaFavorites>, "retryDisabled" | "reconcile">;
  pageTags?: readonly string[]; recentTags?: readonly string[];
  getIdToken: () => Promise<string>; disabled: boolean; onRefresh: () => void;
  onTagsSaved?: (tags: readonly string[]) => void;
  /** Decision 3: after Clear selection or a bulk action. Defaults to the search field. */
  returnFocus?: () => void;
}) {
  const navigate = useNavigate();
  const notice = useSuccessNotice();
  const scope = `${userId}:${source.id}`;
  const currentScope = useRef({ scope });
  if (currentScope.current.scope !== scope) currentScope.current = { scope };
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const favoriteRequest = useRef<symbol>();
  const [favoriteFeedback, setFavoriteFeedback] = useState({ scope, saving: false, status: "", error: "" });
  const favoriteState = favoriteFeedback.scope === scope ? favoriteFeedback : undefined;
  const favoritesSaving = favoriteState?.saving === true;
  const [scoped, setScoped] = useState<{ scope: string; selection: MediaSelection<SourceMediaAssetSummary> }>({ scope, selection: emptySelection() });
  const [session, setSession] = useState<{ scope: string; assets: SourceMediaAssetSummary[]; reviewing: boolean; draft?: BulkMetadataDraft }>();
  const [inspectorDirty, setInspectorDirty] = useState(false);
  const [reviewDirty, setReviewDirty] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const [saving, setSaving] = useState(false);
  // A card's Add to collection names its one video and keeps the selection; the bar's names
  // the selection and clears it once the videos are added.
  const [pickerTarget, setPickerTarget] = useState<{ assets: SourceMediaAssetSummary[]; bulk: boolean }>();
  const [collectionSuccess, setCollectionSuccess] = useState("");
  const selection = scoped.scope === scope ? scoped.selection : emptySelection<SourceMediaAssetSummary>();
  const assets = selection.items;
  const visible = records.filter(asset => asset.sourceId === source.id);
  const open = Boolean(session && session.scope === scope && source.canEditMetadata);
  const reviewOpen = open && session?.reviewing === true;
  const pickerOpen = Boolean(pickerTarget);
  const selectionBusy = open || pickerOpen || favoritesSaving;
  const locked = disabled || selectionBusy;
  const rules = useMemo<SelectionRules<SourceMediaAssetSummary>>(() => ({
    cap: VIDEO_SELECTION_CAP,
    accepts: asset => asset.sourceId === source.id,
  }), [source.id]);
  const focusAfter = () => requestAnimationFrame(() => (returnFocus ?? focusVideoSearch)());
  useEffect(() => { setScoped({ scope, selection: emptySelection() }); setSession(undefined); setPickerTarget(undefined); setCollectionSuccess(""); }, [scope, source.canEditMetadata]);
  useEffect(() => {
    favoriteRequest.current = undefined;
    setFavoriteFeedback({ scope, saving: false, status: "", error: "" });
  }, [scope]);
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
    setCollectionSuccess("");
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
  function collect(target?: SourceMediaAssetSummary) {
    if (locked) return;
    if (target) setPickerTarget({ assets: [target], bulk: false });
    else if (assets.length && !collectionCapError(assets.length, "videos")) setPickerTarget({ assets: [...assets], bulk: true });
  }
  function edit() {
    if (locked || !assets.length || !source.canEditMetadata) return;
    setSession({ scope, assets: [...assets], reviewing: false });
  }
  async function favoriteSelection(favorite: boolean) {
    if (locked || favorites.retryDisabled || favoriteRequest.current || !userId || !assets.length || assets.length > 100) return;
    const request = Symbol();
    const requestScope = currentScope.current;
    const isCurrent = () => mounted.current && currentScope.current === requestScope && favoriteRequest.current === request;
    favoriteRequest.current = request;
    // A prior single-item Undo must not race this selection's new intent.
    notice.show("Saving favorites.");
    setFavoriteFeedback({ scope, saving: true, status: "", error: "" });
    try {
      const token = await getIdToken();
      if (!isCurrent()) return;
      const result = await setMediaFavorites(token, assets.map(asset => ({ backend: "s3", sourceId: asset.sourceId, id: asset.id })), favorite);
      if (!isCurrent()) return;
      const saved = result.results.filter(item => "changed" in item);
      const changed = saved.filter(item => item.changed).length;
      const unchanged = saved.length - changed;
      const failed = result.results.length - saved.length;
      const savedIds = new Set(saved.map(item => item.ref.id));
      setScoped(previous => previous.scope !== scope ? previous : {
        scope, selection: { ...previous.selection, items: previous.selection.items.filter(asset => !savedIds.has(asset.id)), error: "" },
      });
      const message = [
        `${favorite ? "Added" : "Removed"} ${changed} ${favorite ? "to" : "from"} favorites.`,
        unchanged ? `${unchanged} already ${favorite ? "a favorite" : "not a favorite"}.` : "",
        failed ? `${failed} could not be changed. They remain selected; try again.` : "",
      ].filter(Boolean).join(" ");
      setFavoriteFeedback({ scope, saving: true, status: failed ? "" : message, error: failed ? message : "" });
      notice.show(message, failed ? { tone: "error" } : undefined);
      if (!failed) requestAnimationFrame(() => { if (mounted.current && currentScope.current === requestScope) (returnFocus ?? focusVideoSearch)(); });
    } catch {
      if (!isCurrent()) return;
      markMediaTabCountsStale();
      const message = "The favorite changes were not confirmed. Check the refreshed hearts before trying again.";
      setFavoriteFeedback({ scope, saving: true, status: "", error: message });
      notice.show(message, { tone: "error" });
    } finally {
      if (isCurrent()) {
        favorites.reconcile();
        publishFavoritesChange();
        favoriteRequest.current = undefined;
        setFavoriteFeedback(previous => ({ ...previous, saving: false }));
      }
    }
  }
  function selectionAction(id: MediaTileActionId) {
    if (id === "favorite-add" || id === "favorite-remove") void favoriteSelection(id === "favorite-add");
    if (id === "clear-selection") clear();
    if (id === "collect") collect();
    if (id === "edit-selected") edit();
  }
  function close(results?: BulkResult[]) {
    if (results) {
      const completedIds = new Set(results.filter(result => result.status === "saved" || result.status === "unchanged").map(result => result.asset.id));
      setScoped(previous => ({ ...previous, selection: { ...previous.selection, items: previous.selection.items.filter(asset => !completedIds.has(asset.id)), error: "" } }));
      const savedTags = results.filter(result => result.status === "saved").flatMap(result => result.changes.tags ?? []);
      if (savedTags.length) onTagsSaved?.(savedTags);
    }
    setSession(undefined);
    setInspectorDirty(false);
    setReviewDirty(false);
    // A successful batch can disable its opener. Return focus to a stable control.
    if (results) focusAfter();
    if (results?.some(result => result.status !== "pending" && result.status !== "unchanged")) onRefresh();
  }
  function discard() {
    setSession(undefined);
    setInspectorDirty(false);
    setReviewDirty(false);
  }
  const offPage = offPageCount(assets, visible);
  const pageState = pageSelectionState(assets, visible);
  const selectionActions = mediaSelectionActions({ surface: "video", count: assets.length, canEdit: source.canEditMetadata }).map(action =>
    favorites.retryDisabled && (action.id === "favorite-add" || action.id === "favorite-remove")
      ? { ...action, hidden: true, disabledReason: "Wait for the favorite save to finish." }
      : action);
  return {
    open, reviewOpen, dirty: open && (reviewOpen ? reviewDirty : inspectorDirty), saving: (open && saving) || favoritesSaving, discard, refreshAsset, removeAsset,
    selectionActions, selectionBusy,
    selection, rules, changeSelection, clear, collect, edit, selectionAction,
    /** The list header's Select this page: the same state and change as the bar's. */
    pageSelection: {
      state: pageState,
      disabled: locked || !visible.length,
      onChange: (checked: boolean) => changeSelection(setPageSelection(selection, visible, checked, rules)),
    },
    /** Selecting and card actions wait while the viewer, the batch editor or the picker is open. */
    locked, pickerOpen,
    /** The always-mounted announcement of the count; the bar has no live region of its own. */
    summary: assets.length ? selectionSummary({ count: assets.length, offPage, cap: MAX_BULK_VIDEOS }) : "",
    notice: <>{collectionSuccess ? <InlineMessage tone="success" title="Items added to collection">{collectionSuccess}</InlineMessage> : null}
      {!notice.available && favoritesSaving ? <p role="status">Saving favorites…</p> : null}
      {!notice.available && favoriteState?.status ? <InlineMessage tone="success" title="Favorites updated">{favoriteState.status}</InlineMessage> : null}
      {!notice.available && favoriteState?.error ? <InlineMessage tone="error" title="Favorites need attention">{favoriteState.error}</InlineMessage> : null}
      {/* A refused change with nothing selected has no bar to carry its message. */}
      {!assets.length && selection.error ? <p className="source-bulk-selection-error" role="alert">{selection.error}</p> : null}
      {pickerTarget ? <MediaCollectionPicker open userId={userId}
        refs={pickerTarget.assets.map(asset => ({ backend: "s3" as const, sourceId: asset.sourceId, id: asset.id }))}
        getIdToken={getIdToken}
        onClose={() => setPickerTarget(undefined)}
        onOpenCollections={() => navigate(mediaCollectionsPath())}
        onAdded={collection => {
          const count = pickerTarget.assets.length;
          setPickerTarget(undefined);
          if (pickerTarget.bulk) setScoped({ scope, selection: emptySelection() });
          if (!notice.available) setCollectionSuccess(`${count} ${count === 1 ? "video was" : "videos were"} added to ${collection.name}.`);
          focusAfter();
        }} /> : null}</>,
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
    inspector: open && session ? <MediaBulkInspector key={scope} open={!reviewOpen} reviewing={reviewOpen}
      surface="video" assets={session.assets} pageTags={pageTags} recentTags={recentTags} offPageCount={offPage} focusRequest={focusRequest}
      onCancel={() => close()} onReview={draft => { setReviewDirty(true); setSession(previous => previous ? { ...previous, draft, reviewing: true } : previous); }}
      onDirtyChange={setInspectorDirty} /> : null,
    editor: (navigation: NavigationGuard) => reviewOpen && session?.draft ? <SourceMediaBulkEditor key={scope} sourceId={source.id} assets={session.assets} getIdToken={getIdToken}
      initialDraft={session.draft} onBackToEditing={() => { setSession(previous => previous ? { ...previous, reviewing: false } : previous); setFocusRequest(value => value + 1); }}
      onClose={close} onDirtyChange={setReviewDirty} onSavingChange={setSaving} {...navigation} /> : null,
  };
}

function focusVideoSearch() { document.getElementById("video-search")?.focus(); }
