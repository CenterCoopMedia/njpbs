import { useContext, useEffect, useId, useRef, useState, type ComponentProps } from "react";
import { ELECTION_SHEET_COLUMNS, type ElectionRoster, type ElectionSourceMode } from "../../../packages/content-core/src/election-result-sources";
import { ElectionResultsSourceHost } from "../context/ElectionResultsSourceHost";
import { useRegisterContentQuickEditGuard } from "../context/ContentQuickActionsContext";
import type { ElectionSourceConfig, ElectionSourceMutation, ElectionSourceState } from "../lib/election-sources";
import type { ElectionResultsData } from "../../../packages/content-core/src/election-results";
import { HttpError } from "../lib/functions";
import { FieldRenderer } from "./FieldRenderer";
import { Button, Select, TextInput } from "./ui/Primitives";

const modes: Record<ElectionSourceMode, { label: string; help: string }> = {
  "approve-once": { label: "Approve the link once", help: "Review the first valid source values and approve this connection. Later valid counts and calls publish automatically. Changing the configuration requires approval again." },
  "counts-auto": { label: "Counts automatic, calls by click", help: "Valid counts publish automatically. New calls and official or certified statuses wait for a publisher to approve the exact pending changes." },
  automatic: { label: "Fully automatic", help: "Every valid source update, including calls and official or certified statuses, can publish without another click." },
};
type ApDraft = Record<string, { sourceId: string; candidateIds: Record<string, string> }>;
function apDraftFrom(config: ElectionSourceConfig): ApDraft {
  return config.source.kind === "ap" ? Object.fromEntries(Object.entries(config.source.mapping).map(([sourceId, race]) =>
    [race.raceId, { sourceId, candidateIds: Object.fromEntries(Object.entries(race.candidateIds).map(([id, candidate]) => [candidate, id])) }])) : {};
}
const initialConfig = (): ElectionSourceConfig => ({ source: { kind: "repo" }, mode: "approve-once", raceIds: [], maxAgeSeconds: 300 });
const time = (value: string | null) => value ? new Date(value).toLocaleString("en-US", { timeZone: "America/New_York", timeZoneName: "short" }) : "Not yet";
type MediaProps = Pick<ComponentProps<typeof FieldRenderer>, "loadMedia" | "mediaPickerUnavailable" | "uploadMedia" | "mediaCategories" | "defaultUploadCategory" | "canUploadCategory" | "onMediaPickerDirtyChange">;

/** Owned by the shared election editor; its host sits outside manual lifecycle locks. */
export function ElectionResultsSourcePanel({ blockId, title, draftState, onUseManual, onConnectedChange, media, manualReadOnly }: {
  blockId: string; title: string; draftState?: "hidden" | "removed"; manualReadOnly: boolean; onUseManual: (data: ElectionResultsData) => void; onConnectedChange: (connected: boolean | undefined) => void; media: MediaProps;
}) {
  const host = useContext(ElectionResultsSourceHost);
  const headingId = useId();
  const [state, setState] = useState<ElectionSourceState | null>(null);
  const [roster, setRoster] = useState<ElectionRoster | null>(null);
  const [config, setConfig] = useState<ElectionSourceConfig | null>(null);
  const [apDraft, setApDraft] = useState<ApDraft>({});
  const [configBaseline, setConfigBaseline] = useState("");
  const [configVersion, setConfigVersion] = useState(0);
  const [configContentVersion, setConfigContentVersion] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [approvedStatus, setApprovedStatus] = useState<{ revision: number; digest: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const fields = useRef<HTMLFieldSetElement>(null);
  const [needsReview, setNeedsReview] = useState(false);
  const [requiresFreshRead, setRequiresFreshRead] = useState(false);
  const sequence = useRef(0);
  const read = useRef<AbortController | null>(null);
  const owner = `${host?.collection}/${host?.documentId}/${blockId}`;
  const currentOwner = useRef(owner); currentOwner.current = owner;
  const api = host?.api;
  const documentId = host?.documentId;
  const collection = host?.collection;
  const saved = !!host?.version;
  const dirty = config !== null && JSON.stringify({ config, apDraft }) !== configBaseline;
  useRegisterContentQuickEditGuard({ label: "Election source settings", dirty, saving: busy,
    save: async () => ({ status: "unsaved-elsewhere", items: ["Election source settings: review and connect or discard them in the election section"] }) });
  useEffect(() => () => { read.current?.abort(); sequence.current++; }, []);
  useEffect(() => {
    setState(null); setApprovedStatus(null); setConfig(null); setApDraft({}); setRoster(null); setError(""); setNotice(""); setNeedsReview(false); setRequiresFreshRead(false);
    onConnectedChange(undefined);
    if (!api || !collection || !documentId || !saved) return;
    const controller = new AbortController(); read.current?.abort(); read.current = controller;
    const request = ++sequence.current; setLoading(true);
    api.get({ collection, documentId, blockId }, false, controller.signal).then(result => {
      if (request === sequence.current && !controller.signal.aborted) setState(result);
    }).catch(cause => { if (!controller.signal.aborted && request === sequence.current) setError(cause instanceof Error ? cause.message : "Connection unavailable."); })
      .finally(() => { if (request === sequence.current) setLoading(false); });
    return () => controller.abort();
  }, [api, collection, documentId, blockId, saved]);
  const connection = state?.connection;
  const statusApproved = !!connection?.pendingDigest && approvedStatus?.revision === connection.configRevision && approvedStatus.digest === connection.pendingDigest;
  const periodicRead = useRef<() => void>(() => {});
  periodicRead.current = () => { if (!busyRef.current && !loading && !config && document.visibilityState === "visible") void reload(false); };
  useEffect(() => {
    if (!connection) return;
    const timer = window.setInterval(() => periodicRead.current(), 60000);
    const focus = () => periodicRead.current();
    window.addEventListener("focus", focus);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", focus); };
  }, [api, owner, !!connection]);
  useEffect(() => { onConnectedChange(state ? !!connection && !connection.paused : undefined); }, [state, connection, onConnectedChange]);
  const busyCallback = host?.onBusyChange;
  useEffect(() => { busyCallback?.(blockId, busy); return () => busyCallback?.(blockId, false); }, [busy, busyCallback, blockId]);
  const target = collection && documentId ? { collection, documentId, blockId } : null;
  async function reload(includeRoster = false) {
    if (!api || !target || busyRef.current) return null;
    const controller = new AbortController(); read.current?.abort(); read.current = controller;
    const request = ++sequence.current; setLoading(true); setError("");
    try {
      const result = await api.get(target, includeRoster, controller.signal);
      if (controller.signal.aborted || request !== sequence.current) return null;
      setState(result); if (includeRoster) setRoster(result.roster ?? null);
      if (result.rosterError) setError(result.rosterError);
      setNeedsReview(false); setRequiresFreshRead(false); return result;
    } catch (cause) { if (!controller.signal.aborted && request === sequence.current) setError(cause instanceof Error ? cause.message : "Connection unavailable."); return null; }
    finally { if (request === sequence.current) setLoading(false); }
  }
  async function configure() {
    const result = await reload(true);
    if (!result?.roster) return;
    const value = structuredClone(result.connection?.config ?? initialConfig());
    const draft = apDraftFrom(value);
    setConfig(value); setApDraft(draft); setConfigBaseline(JSON.stringify({ config: value, apDraft: draft })); setConfigVersion(result.connection?.version ?? 0); setConfigContentVersion(Math.max(result.documentVersion ?? 0, host?.version ?? 0)); setNotice("");
  }
  const latestDocumentVersion = Math.max(state?.documentVersion ?? 0, host?.version ?? 0);
  const documentChanged = config !== null && configContentVersion !== latestDocumentVersion;
  const blocked = !host?.canPublish || !state?.canManage || host.locked || loading || busy || needsReview;
  const pauseBlocked = !host?.canPublish || !state?.canManage || (host.pauseLocked ?? host.locked) || loading || busy;
  async function mutate(request: ElectionSourceMutation) {
    if (!api || !target || (request.action === "pause" ? pauseBlocked : blocked) || busyRef.current) return;
    if (["connect", "resume"].includes(request.action) && host?.hasUnsavedWork()) { setError("Save or discard the Page/Post and Media edits before changing its source."); return; }
    const capturedOwner = owner;
    busyRef.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const result = await api.mutate(target, request);
      if (currentOwner.current !== capturedOwner) return;
      setState(before => before ? { ...before, connection: result.connection } : before);
      if (request.action === "status") setApprovedStatus({ revision: result.connection.configRevision, digest: request.pendingDigest });
      if (request.action === "connect") setConfig(null);
      else if (config && result.connection.configRevision === connection?.configRevision) setConfigVersion(result.connection.version);
      setNotice(request.action === "pause" ? "Updates paused. In-flight source values are discarded; current public values stay in place. Start a revision before making a manual correction."
        : request.action === "resume" ? "Updates resumed. The next valid source check can publish updates."
        : request.action === "approve" ? "Connection approved. The next valid source check can publish updates."
        : request.action === "status" ? "The reviewed status changes are approved. Check the next accepted update and public confirmation."
        : "Connection saved. The server checks enabled sources at 8 AM and 8 PM ET. Refresh to see the next check.");
    } catch (cause) {
      if (currentOwner.current !== capturedOwner) return;
      setError(cause instanceof Error ? cause.message : "The connection could not be changed.");
      if (cause instanceof HttpError && cause.status === 409) { setNeedsReview(true); setRequiresFreshRead(true); }
    } finally { busyRef.current = false; setBusy(false); }
  }
  function setSource(kind: "repo" | "sheet" | "ap") {
    if (!config) return;
    setApDraft({});
    setConfig({ ...config, source: kind === "sheet" ? { kind, spreadsheetId: "", tab: "Results", columns: {} }
      : kind === "ap" ? { kind, mapping: {} } : { kind } });
  }
  function setApId(raceId: string, value: string, candidateId?: string) {
    setError("");
    setApDraft(previous => {
      const race = previous[raceId] ?? { sourceId: "", candidateIds: {} };
      return { ...previous, [raceId]: candidateId ? { ...race, candidateIds: { ...race.candidateIds, [candidateId]: value } } : { ...race, sourceId: value } };
    });
  }
  function connectionConfig(): ElectionSourceConfig | null {
    if (!config || config.source.kind !== "ap") return config;
    const mapping: Extract<ElectionSourceConfig["source"], { kind: "ap" }>["mapping"] = {};
    for (const raceId of config.raceIds) {
      const draft = apDraft[raceId];
      if (!draft?.sourceId) { setError("Enter the AP race ID before connecting."); return null; }
      if (mapping[draft.sourceId]) { setError("AP race IDs must be unique across the selected roster races."); return null; }
      const candidateIds: Record<string, string> = {};
      for (const candidate of roster?.candidates.filter(item => item.raceId === raceId) ?? []) {
        const id = draft.candidateIds[candidate.id];
        if (!id) { setError(`Enter the AP candidate ID for ${candidate.name}.`); return null; }
        if (candidateIds[id]) { setError(`AP candidate IDs must be unique within ${roster?.races.find(race => race.id === raceId)?.district ?? "each race"}.`); return null; }
        candidateIds[id] = candidate.id;
      }
      mapping[draft.sourceId] = { raceId, candidateIds };
    }
    return { ...config, source: { kind: "ap", mapping } };
  }
  function validateSettings() {
    for (const input of fields.current?.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input,select") ?? []) {
      if (input.checkValidity()) continue;
      for (let ancestor = input.parentElement; ancestor; ancestor = ancestor.parentElement) {
        if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
      }
      const label = input.labels?.[0]?.textContent?.replace(/\s+/g, " ").trim() || "the required source field";
      setError(`Complete ${label} before connecting this source.`);
      input.focus(); input.reportValidity();
      return false;
    }
    return true;
  }
  if (!host) return null;
  const content = <section className="election-results-editor election-source-panel" aria-labelledby={headingId} aria-busy={busy || loading}>
    <h3 id={headingId}>Election source: {connection?.lastGoodData?.races[0] ? `${connection.lastGoodData.races[0].office}: ${connection.lastGoodData.races[0].district}` : title}</h3>
    {draftState ? <p>This section is {draftState} in the draft. Its public connection remains manageable here until publication removes it.</p> : null}
    {!documentId || !host.version ? <p>Save and publish this results section before connecting a source.</p> : <>
      {loading ? <p role="status">Checking the connection…</p> : null}
      {busy ? <p role="status">Saving the connection…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {needsReview ? <p>Refresh the connection and review its current values before trying again.</p> : null}
      {state && !connection ? <p>No source connected. Manual entry remains available for races without a source.</p> : null}
      {state && !state.canConnect ? <p>Publish this section before connecting. A source updates only its public results, leaving other draft edits private.</p> : null}
      {state && (!state.canManage || !host.canPublish) ? <p>You can inspect this connection. A staff publisher can change it.</p> : null}
      {connection ? <>
        <p><strong>{connection.config.source.kind === "repo" ? "nj-decides public results" : connection.config.source.kind === "sheet" ? "Google Sheet" : "The Associated Press"}</strong> · {connection.paused ? "Paused" : "Enabled"} · {modes[connection.config.mode].label}</p>
        <p>{modes[connection.config.mode].help}</p>
        <dl className="election-source-panel__times"><dt>Last check</dt><dd>{time(connection.lastCheckAt)}</dd><dt>Last successful source check</dt><dd>{time(connection.lastSourceSuccessAt)}</dd><dt>Last accepted update</dt><dd>{time(connection.lastGoodAt)}</dd></dl>
        {connection.lastSchedulingReason ? <p role="status">Polling deferred: {connection.lastSchedulingReason.message} Last deferral: {time(connection.lastSchedulingReason.at)}. Fresh pending values can still be approved.</p> : null}
        {connection.lastHoldReason ? <div role="alert"><strong>Update held: {connection.lastHoldReason.code}</strong><p>{connection.lastHoldReason.message}</p><p>The last good public values stay in place. Correct the source or mapping, then refresh after the next server check.</p></div> : null}
        {connection.lastGoodData ? <details><summary>Accepted source values ({connection.lastGoodData.races.length} races)</summary>{connection.lastGoodData.races.map(race => <p key={race.id}><strong>{race.office}: {race.district}</strong> · {race.status} · Source as of {time(race.asOf)}<br />{race.candidates.map(candidate => `${candidate.name}: ${candidate.votes === null ? "unknown" : candidate.votes.toLocaleString("en-US")} (${candidate.share ?? "unknown"}%)`).join("; ")}</p>)}</details>
          : <p>No update has been accepted for this connection configuration. Previous public values stay in place.</p>}
        {connection.pendingData && (connection.authorizedConfigRevision !== connection.configRevision || connection.pendingStatuses.length > 0) ? <details open><summary>{statusApproved ? "Approved status changes awaiting the next source check" : "Review pending source values"}</summary>{connection.pendingData.races.filter(race => connection.authorizedConfigRevision !== connection.configRevision || connection.pendingStatuses.includes(race.id)).map(race => {
          const before = (connection.lastGoodData ?? state?.publicData)?.races.find(item => item.id === race.id);
          return <p key={race.id}><strong>{race.office}: {race.district}</strong><br />Accepted status: {before?.status ?? "No accepted update"}{before?.calledCandidateId ? ` — ${before.candidates.find(candidate => candidate.id === before.calledCandidateId)?.name}` : ""}; pending: {race.status}{race.calledCandidateId ? ` — ${race.candidates.find(candidate => candidate.id === race.calledCandidateId)?.name}` : ""}<br />{race.candidates.map(candidate => `${candidate.name}: ${candidate.votes ?? "unknown"} (${candidate.share ?? "unknown"}%)`).join("; ")}<br />{race.sourceLabel} ({race.sourceKind}) · {race.expectedVoteShare !== undefined ? `Est. ${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(race.expectedVoteShare * 100)}% of expected vote counted` : race.reportingShare === null ? "Reporting share unavailable" : `Reporting ${race.reportingShare}%`} · As of {time(race.asOf)}<br /><a href={race.sourceUrl} target="_blank" rel="noreferrer">Pending source link</a>{race.apCallUrl ? <> · <a href={race.apCallUrl} target="_blank" rel="noreferrer">Pending AP call attribution</a></> : null}{before ? <><br />Accepted attribution: {before.sourceLabel} ({before.sourceKind}) · <a href={before.sourceUrl} target="_blank" rel="noreferrer">Accepted source link</a>{before.apCallUrl ? <> · <a href={before.apCallUrl} target="_blank" rel="noreferrer">Accepted AP call attribution</a></> : null}</> : null}</p>;
        })}</details> : null}
      </> : null}
      <div className="election-source-panel__actions">
        <Button disabled={busy || loading} onClick={() => void reload(false)}>Refresh connection</Button>
        {host.canPublish && state?.canManage ? <>
          <Button disabled={blocked || !state.canConnect || config !== null} onClick={() => void configure()}>{connection ? "Edit connection" : "Connect a source"}</Button>
          {connection ? <Button disabled={connection.paused ? blocked || host.hasUnsavedWork() : pauseBlocked} onClick={() => void mutate({ action: connection.paused ? "resume" : "pause", baseVersion: connection.version })}>{connection.paused ? "Resume updates" : "Pause updates"}</Button> : null}
          {connection && !config ? <>
            {!connection.paused && !connection.lastHoldReason && connection.pendingData && connection.authorizedConfigRevision !== connection.configRevision ? <Button disabled={blocked} onClick={() => void mutate({ action: "approve", baseVersion: connection.version })}>Approve link</Button> : null}
            {!connection.paused && !connection.lastHoldReason && connection.pendingDigest && !statusApproved && connection.config.mode === "counts-auto" ? <Button disabled={blocked} onClick={() => void mutate({ action: "status", baseVersion: connection.version, pendingDigest: connection.pendingDigest! })}>Approve status changes</Button> : null}
            {connection.paused && connection.lastGoodData ? <Button disabled={host.locked || busy || manualReadOnly} onClick={() => { const data = structuredClone(connection.lastGoodData!); for (const race of data.races) delete race.expectedVoteShare; onUseManual(data); setNotice("Accepted values copied into the manual draft. Expected-vote estimates stay with the connected source. Request review and publish the correction, then reconnect the source."); }}>Copy accepted values to manual draft</Button> : null}
          </> : null}
        </> : null}
      </div>
      {config && (connection?.version ?? 0) !== configVersion ? <p role="alert">Another publisher changed this connection. Discard these settings and reopen the current configuration before saving.</p> : null}
      {config && (documentChanged || needsReview) ? <div role="group" aria-label="Review current public election section">
        <p role="alert">The Page/Post changed after these settings opened. Your source settings are kept. Refresh the connection, review the current public section, then use its saved revision.</p>
        {state?.publicData ? <details open><summary>Current public results section</summary>{state.publicData.races.map(race => <p key={race.id}>{race.office}: {race.district} · {race.status} · As of {time(race.asOf)}<br />{race.candidates.map(candidate => `${candidate.name}: ${candidate.votes ?? "unknown"} (${candidate.share ?? "unknown"}%)`).join("; ")}</p>)}</details> : null}
        <Button disabled={busy || loading || requiresFreshRead || !state?.canConnect || !state.documentVersion || state.documentVersion !== latestDocumentVersion || (connection?.version ?? 0) !== configVersion} onClick={() => { setConfigContentVersion(state!.documentVersion!); setNeedsReview(false); setError(""); setNotice("Current public section reviewed. Your source settings are kept for this saved revision."); }}>Use saved Page/Post revision</Button>
      </div> : null}
      {config && roster ? <div role="group" aria-label="Source settings form">
        <fieldset ref={fields} disabled={blocked || !state?.canConnect}><legend>Source settings</legend>
          <label>Results source<Select value={config.source.kind} onChange={event => setSource(event.target.value as "repo" | "sheet" | "ap")}><option value="repo">nj-decides public JSON</option><option value="sheet">Google Sheet</option><option value="ap">AP Elections API</option></Select></label>
          <p>One connection uses one source. Sources are never blended automatically. The selected roster races replace this section's source results after validation.</p>
          <label>Publish mode<Select value={config.mode} onChange={event => setConfig({ ...config, mode: event.target.value as ElectionSourceMode })}>{Object.entries(modes).map(([id, mode]) => <option key={id} value={id}>{mode.label}</option>)}</Select></label>
          <p>{modes[config.mode].help}</p>
          {config.source.kind === "repo" ? <p>Reads the public nj-decides Pages roster and results JSON. The roster owns race and candidate identities. Unpublished profiles and contact details are excluded.</p> : null}
          {config.source.kind === "sheet" ? <>
            <p>Share this Sheet as Viewer with the Functions runtime service account supplied by an administrator. No staff Google sign-in or Sheet key is stored here.</p>
            <label>Spreadsheet ID<TextInput required maxLength={200} value={config.source.spreadsheetId} onChange={event => { if (config.source.kind === "sheet") setConfig({ ...config, source: { ...config.source, spreadsheetId: event.target.value } }); }} /></label>
            <label>Sheet tab<TextInput required maxLength={100} value={config.source.tab} onChange={event => { if (config.source.kind === "sheet") setConfig({ ...config, source: { ...config.source, tab: event.target.value } }); }} /></label>
            <details><summary>Review Sheet column headers</summary><p>One row per candidate. Numbers use percentage points (25 means 25%); percent-formatted cells are held. Use stable roster IDs below.</p><div className="election-results-editor__fields">{ELECTION_SHEET_COLUMNS.map(column => <label key={column}>{column}<TextInput required maxLength={120} value={config.source.kind === "sheet" ? config.source.columns[column] ?? column : column} onChange={event => { if (config.source.kind === "sheet") setConfig({ ...config, source: { ...config.source, columns: { ...config.source.columns, [column]: event.target.value } } }); }} /></label>)}</div></details>
          </> : null}
          {config.source.kind === "ap" ? <p>AP stays disabled until an administrator provisions its Functions secret and query quota. Enter AP race and candidate IDs exactly; no key belongs in Boardwalk. AP calls retain their own attribution.</p> : null}
          <fieldset><legend>Roster races</legend>{roster.races.map(race => {
            const selected = config.raceIds.includes(race.id);
            const ap = apDraft[race.id];
            return <details key={race.id} className="election-source-panel__roster"><summary>{race.office}: {race.district}{selected ? " — selected" : ""}</summary>
              <label className="election-source-panel__check"><input type="checkbox" checked={selected} onChange={event => {
                const raceIds = event.target.checked ? [...config.raceIds, race.id] : config.raceIds.filter(id => id !== race.id);
                const photos = Object.fromEntries(Object.entries(config.photos ?? {}).filter(([id]) => roster.candidates.some(candidate => candidate.id === id && raceIds.includes(candidate.raceId))));
                setConfig({ ...config, raceIds, photos });
              }} />Include {race.district}</label><p>Race ID: <code>{race.id}</code></p>
              {selected && config.source.kind === "ap" ? <label>AP race ID for {race.district}<TextInput required inputMode="numeric" pattern="[0-9]+" maxLength={20} value={ap?.sourceId ?? ""} onChange={event => setApId(race.id, event.target.value)} /></label> : null}
              {roster.candidates.filter(candidate => candidate.raceId === race.id).map(candidate => <div key={candidate.id} className="election-source-panel__candidate">
                <p><strong>{candidate.name}</strong> · {candidate.party}{candidate.incumbent ? " · Incumbent" : ""}<br />Ballot: {candidate.ballotLabel} · {candidate.ballotStatus}<br /><code>{candidate.id}</code>{candidate.aliases.length ? <><br />Aliases: {candidate.aliases.join(", ")}</> : null}</p>
                {candidate.campaignWebsite ? <a href={candidate.campaignWebsite} target="_blank" rel="noreferrer">Campaign website for {candidate.name}</a> : null}
                {candidate.publishedProfileUrl ? <a href={candidate.publishedProfileUrl} target="_blank" rel="noreferrer">Published NJ Spotlight News profile for {candidate.name}</a> : null}
                {selected && config.source.kind === "ap" ? <label>AP candidate ID for {candidate.name}<TextInput required inputMode="numeric" pattern="[0-9]+" maxLength={20} disabled={!ap?.sourceId} value={ap?.candidateIds[candidate.id] ?? ""} onChange={event => setApId(race.id, event.target.value, candidate.id)} /></label> : null}
                {selected ? <details><summary>Optional Media photo for {candidate.name}</summary><FieldRenderer {...media} field={{ key: "photo", label: "Candidate photo", kind: "asset", required: false, help: "Choose an optional cleared photo from Media." }} fieldId={`source-${blockId}-${candidate.id}`} value={config.photos?.[candidate.id]?.assetId ?? ""}
                  onChange={value => { const photos = { ...config.photos }; if (value) photos[candidate.id] = { assetId: String(value), alt: "" }; else delete photos[candidate.id]; setConfig({ ...config, photos }); }}
                  onAssetSelect={asset => { const photos = { ...config.photos }; if (asset) photos[candidate.id] = { assetId: asset.id, alt: asset.altText ?? "", ...(asset.credit ? { caption: asset.credit } : {}) }; else delete photos[candidate.id]; setConfig({ ...config, photos }); }} />
                  {config.photos?.[candidate.id] ? <><label>Photo description for {candidate.name}<TextInput required maxLength={300} value={config.photos[candidate.id].alt} onChange={event => setConfig({ ...config, photos: { ...config.photos, [candidate.id]: { ...config.photos![candidate.id], alt: event.target.value } } })} /></label><label>Photo credit for {candidate.name}<TextInput maxLength={300} value={config.photos[candidate.id].caption ?? ""} onChange={event => setConfig({ ...config, photos: { ...config.photos, [candidate.id]: { ...config.photos![candidate.id], caption: event.target.value } } })} /></label></> : null}
                </details> : null}
              </div>)}
            </details>;
          })}</fieldset>
          <details><summary>Source age limit</summary><label>Maximum source age in seconds<TextInput type="number" min={60} max={86400} step={1} required value={config.maxAgeSeconds} onChange={event => setConfig({ ...config, maxAgeSeconds: Number(event.target.value) })} /></label><p>Sheet and repo use the source as-of time. AP uses the last successful HTTP check while retaining its real race as-of time.</p></details>
          <p>Review the selected races, mapping and mode. Saving can authorize public updates.{config.mode === "approve-once" ? " This mode waits for your first approval." : " The next valid server check can publish updates in this mode."}</p>
          <Button type="button" disabled={!config.raceIds.length || (connection?.version ?? 0) !== configVersion || documentChanged} onClick={() => { if (!validateSettings()) return; const next = connectionConfig(); if (next) void mutate({ action: "connect", baseVersion: configVersion, contentVersion: configContentVersion, config: next }); }}>{connection ? "Save connection" : "Connect source"}</Button>
        </fieldset>
        <Button type="button" disabled={busy} onClick={() => { setConfig(null); setError(""); }}>Discard source settings</Button>
      </div> : null}
    </>}
  </section>;
  return content;
}
