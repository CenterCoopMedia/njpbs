import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { COVERAGE_LABELS_SETTINGS_ID, DEFAULT_NJ_DECIDES_SETTINGS, MAX_COVERAGE_LABELS, currentCmsSettingsSchemaFor,
  validateCmsSettingsValues, validateCoverageLabels, type CoverageLabel, type CoverageLabelsSettingsValues } from "../../../packages/content-core/src/cms-settings";
import { projectCoverageLabels } from "../../../packages/content-core/src/coverage-labels";
import { renderPostBranding } from "../../../packages/content-core/src/post-branding";
import { useSettingsPublication } from "../hooks/useSettingsPublication";
import { isConflictError, settingsPublicationRefusalMessage, type GetSettingsResponse, type MutateSettingsResponse,
  type PublishSettingsRequest, type SaveSettingsRequest } from "../lib/functions";
import { SettingsPublicationStatus } from "./SettingsPublicationStatus";
import { ActionControl } from "./ui/ActionControl";
import { AsyncActionButton, Button, InlineMessage, Panel, TextInput } from "./ui/Primitives";
import { LoadingIndicator } from "./ui/LoadingIndicator";
import { SettingsInspector, useSettingsDirty } from "./SettingsWorkspace";
import "../../../packages/content-core/src/post-branding.css";
import "./CoverageLabelsSettings.css";

export { COVERAGE_LABELS_SETTINGS_ID };
export const DEFAULT_COVERAGE_LABELS: CoverageLabelsSettingsValues = { labels: [{ id: "nj-decides-2026", name: "NJ Decides 2026",
  textColor: DEFAULT_NJ_DECIDES_SETTINGS.textColor, backgroundColor: DEFAULT_NJ_DECIDES_SETTINGS.backgroundColor,
  href: "/nj-decides-2026/", retired: false }] };
export interface CoverageLabelsSettingsTransport {
  load: () => Promise<GetSettingsResponse<CoverageLabelsSettingsValues>>;
  save: (request: SaveSettingsRequest<CoverageLabelsSettingsValues>) => Promise<MutateSettingsResponse<CoverageLabelsSettingsValues>>;
  publish: (request: PublishSettingsRequest) => Promise<MutateSettingsResponse<CoverageLabelsSettingsValues>>;
}
const schema = currentCmsSettingsSchemaFor(COVERAGE_LABELS_SETTINGS_ID)!;
type Ready = { version: number | null; values: CoverageLabelsSettingsValues; published?: CoverageLabelsSettingsValues };
function readyFromResponse(response: GetSettingsResponse<CoverageLabelsSettingsValues>): Ready {
  if (response.id !== COVERAGE_LABELS_SETTINGS_ID) throw new Error("The coverage labels could not be read.");
  if (!response.found) return { version: null, values: structuredClone(DEFAULT_COVERAGE_LABELS) };
  const data = response.settings;
  if (data.schemaVersion !== 1 || !Number.isSafeInteger(data.version) || data.version < 1 || validateCmsSettingsValues(schema, data.values)) throw new Error("The saved coverage labels are invalid.");
  const published = projectCoverageLabels(data);
  if (data.published && (!published || published.data.sourceVersion > data.version)) throw new Error("The published coverage labels are invalid.");
  return { version: data.version, values: structuredClone(data.values), ...(published ? { published: { labels: published.data.labels } } : {}) };
}
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
// Retain the deployed contract's text/background pair; only the bar is rendered.
function compatibleTextColor(backgroundColor: string): string {
  return validateCoverageLabels([{ id: "bar-color", name: "Bar color", textColor: "#000000", backgroundColor, retired: false }])
    ? "#ffffff" : "#000000";
}

export function CoverageLabelsSettings({ load, save, publish }: CoverageLabelsSettingsTransport) {
  const [ready, setReady] = useState<Ready>();
  const [draft, setDraft] = useState<CoverageLabelsSettingsValues>({ labels: [] });
  const [selectedId, setSelectedId] = useState<string>();
  const [loadError, setLoadError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState<"save" | "publish" | null>(null);
  const [message, setMessage] = useState<string>();
  const [messageTone, setMessageTone] = useState<"success" | "error">("success");
  const [conflict, setConflict] = useState(false);
  const nameInputId = useId();
  const focusNew = useRef(false);
  const { publication, observe, retry, retrying, refresh, needsRefresh } = useSettingsPublication(load,
    sourceVersion => publish({ id: COVERAGE_LABELS_SETTINGS_ID, baseVersion: sourceVersion }));
  useEffect(() => {
    let current = true; setLoadError(false); setReady(undefined);
    void load().then(response => {
      const next = readyFromResponse(response);
      if (!current) return;
      setReady(next); setDraft(next.values); setSelectedId(next.values.labels[0]?.id); setConflict(false); setMessage(undefined);
      observe(response.found ? response.publication : undefined);
    }).catch(() => { if (current) setLoadError(true); });
    return () => { current = false; };
  }, [load, attempt, observe]);
  useEffect(() => { if (focusNew.current) { focusNew.current = false; document.getElementById(nameInputId)?.focus(); } }, [selectedId, nameInputId]);
  const selected = draft.labels.find(label => label.id === selectedId);
  const error = draft.labels.some(label => !/^#[0-9a-fA-F]{6}$/.test(label.backgroundColor))
    ? "Use a six-digit hex bar color, such as #011375." : validateCmsSettingsValues(schema, draft);
  const dirty = Boolean(ready && !same(draft, ready.values));
  useSettingsDirty(dirty, pending !== null || retrying);
  function edit(patch: Partial<CoverageLabel>) {
    setDraft(current => ({ labels: current.labels.map(label => label.id === selectedId ? { ...label, ...patch } : label) }));
    setMessage(undefined);
  }
  function add() {
    const id = `label-${crypto.randomUUID()}`;
    const label: CoverageLabel = { id, name: "New coverage", textColor: DEFAULT_NJ_DECIDES_SETTINGS.backgroundColor,
      backgroundColor: DEFAULT_NJ_DECIDES_SETTINGS.textColor, retired: false };
    setDraft(current => ({ labels: [...current.labels, label] })); setSelectedId(id); focusNew.current = true; setMessage(undefined);
  }
  async function saveDraft(event: FormEvent) {
    event.preventDefault(); if (!ready || pending || error || conflict) return;
    setPending("save"); setMessage(undefined);
    try {
      const response = await save({ id: COVERAGE_LABELS_SETTINGS_ID, values: draft,
        ...(ready.version === null ? { createOnly: true as const } : { baseVersion: ready.version }) });
      const next = readyFromResponse({ ...response, found: true });
      setReady(next); setDraft(next.values); setMessageTone("success"); setMessage("Coverage labels draft saved.");
    } catch (cause) {
      setMessageTone("error");
      setConflict(isConflictError(cause)); setMessage(cause instanceof Error ? cause.message : "Coverage labels could not be saved. Your draft is still here.");
    } finally { setPending(null); }
  }
  async function publishSaved() {
    if (!ready?.version || pending || dirty || error || conflict) return;
    setPending("publish"); setMessage(undefined);
    try {
      const response = await publish({ id: COVERAGE_LABELS_SETTINGS_ID, baseVersion: ready.version });
      const next = readyFromResponse({ ...response, found: true });
      if (!response.publication || !next.published) throw new Error("The settings publication receipt is missing.");
      setReady(next); setDraft(next.values); observe(response.publication);
    } catch (cause) {
      setMessageTone("error");
      setConflict(isConflictError(cause) && !settingsPublicationRefusalMessage(cause)); setMessage(settingsPublicationRefusalMessage(cause) ?? (cause instanceof Error ? cause.message : "Coverage labels could not be published. Your draft is still here."));
    } finally { setPending(null); }
  }
  if (loadError) return <InlineMessage tone="error" title="Coverage labels could not be loaded"><Button onClick={() => setAttempt(value => value + 1)}>Reload coverage labels</Button></InlineMessage>;
  if (!ready) return <LoadingIndicator label="Loading coverage labels" />;
  return <Panel className="admin-settings-panel settings-public-panel coverage-labels-settings" aria-labelledby="coverage-labels-heading">
    <div className="panel-heading"><div><h2 id="coverage-labels-heading">Coverage labels</h2>
      <p>Create reusable labels for series and special coverage. Changes reach existing Posts after you publish the saved labels.</p></div></div>
    <form className="admin-settings-form settings-section-layout" onSubmit={saveDraft}>
      <div className="settings-section-fields">
      <div className="coverage-labels-settings__layout">
        <div><div className="coverage-labels-settings__list-heading"><h3>Saved labels</h3>
          <ActionControl action="add-item" accessibleName="Add coverage label" disabled={pending !== null || draft.labels.length >= MAX_COVERAGE_LABELS} onClick={add} /></div>
          {draft.labels.length ? <ul className="coverage-labels-settings__list">{draft.labels.map(label => <li key={label.id}>
            <Button aria-pressed={label.id === selectedId} onClick={() => setSelectedId(label.id)}>{label.name || "Untitled label"}{label.retired ? " (retired)" : ""}</Button>
          </li>)}</ul> : <p>No coverage labels yet. Add the first label.</p>}
          <p className="muted">{draft.labels.length} of {MAX_COVERAGE_LABELS} labels</p>
        </div>
        {selected ? <fieldset className="coverage-labels-settings__fields" disabled={pending !== null}><legend>Edit coverage label</legend>
          <label className="editor-field">Name<TextInput id={nameInputId} required maxLength={80} value={selected.name} onChange={event => edit({ name: event.target.value })} /></label>
          {selected.id === "nj-decides-2026" ? <p className="coverage-labels-settings__palette-note">NJ Decides 2026 uses the shared red, white and blue election bar.</p>
            : <label className="editor-field">Bar color<TextInput required value={selected.backgroundColor} onChange={event => {
              const backgroundColor = event.target.value;
              edit({ backgroundColor, ...(/^#[0-9a-fA-F]{6}$/.test(backgroundColor) ? { textColor: compatibleTextColor(backgroundColor) } : {}) });
            }} placeholder="#011375" /></label>}
          <label className="editor-field">Coverage page link (optional)<TextInput value={selected.href ?? ""} maxLength={2048} onChange={event => edit({ href: event.target.value || undefined })} placeholder="/special-coverage/" /></label>
          <Button onClick={() => edit({ retired: !selected.retired })}>{selected.retired ? "Restore label" : "Retire label"}</Button>
          <p className="editor-field-help">Retired labels stay on Posts already using them and disappear from new choices after publication.</p>
        </fieldset> : null}
      </div>
      {error ? <InlineMessage tone="error">{error}</InlineMessage> : null}
      {message ? <InlineMessage tone={conflict ? "warning" : messageTone}>{message}</InlineMessage> : null}
      {conflict ? <div><p>Your local changes are still here. Reloading replaces them with the saved labels.</p><Button onClick={() => setAttempt(value => value + 1)}>Reload saved labels</Button></div> : null}
      </div>
      <SettingsInspector label="Coverage label preview and publication">
        <h3>Preview</h3>
        {selected ? <div className="coverage-labels-settings__previews" aria-label="Coverage label previews">
          {(["light", "dark"] as const).map(surface => <div key={surface} className={`coverage-labels-settings__preview coverage-labels-settings__preview--${surface}`}><span>{surface === "light" ? "Light background" : "Dark background"}</span>
            <div dangerouslySetInnerHTML={{ __html: renderPostBranding(false, "card", selected, false) }} /></div>)}</div> : <p>Add a label to preview it.</p>}
        <p className="editor-field-help">Labels use the standard eyebrow text style. A fine border keeps the bar visible on light and dark backgrounds.</p>
        <SettingsPublicationStatus publication={publication} retry={retry} retrying={retrying} refresh={refresh} needsRefresh={needsRefresh} disabled={pending !== null} />
      </SettingsInspector>
      <div className="settings-section-actions">
      <p className="admin-settings-save-note">Save draft keeps changes private. Publish updates labels on the public site. A label must be published before it can be selected on a Post.</p>
      <div className="admin-settings-actions"><AsyncActionButton type="submit" label="Save draft" pendingLabel="Saving draft…" pending={pending === "save"} disabled={pending !== null || Boolean(error) || conflict || (!dirty && ready.version !== null)} />
        <AsyncActionButton label="Publish" pendingLabel="Publishing…" pending={pending === "publish"} disabled={pending !== null || dirty || Boolean(error) || conflict || ready.version === null || same(ready.values, ready.published)} onClick={publishSaved} /></div>
      </div>
    </form>
  </Panel>;
}
