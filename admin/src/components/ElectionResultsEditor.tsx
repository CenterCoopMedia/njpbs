import { useContext, useEffect, useRef, useCallback } from "react";
import { ELECTION_RACE_STATUSES, ELECTION_RESULTS_LIMITS, electionRaceKey, electionResultsError,
  type ElectionCandidate, type ElectionRace, type ElectionRaceStatus } from "../../../packages/content-core/src/election-results";
import { ElectionResultsSourceHost } from "../context/ElectionResultsSourceHost";
import { ElectionResultsSourcePanel } from "./ElectionResultsSourcePanel";
import { ElectionResultsReview } from "../context/ElectionResultsReview";
import { useRemovalNotice, useRemovalNoticeAvailable } from "../context/RemovalNoticeContext";
import type { AdminBlock } from "../lib/block-factory";
import type { EditorField } from "../../../packages/content-core/src/editor-admin";
import type { MediaCategoryDefinition } from "../lib/functions";
import type { MediaPickerLoader } from "./MediaPickerDialog";
import type { MediaUploader } from "./MediaUploadForm";
import { FieldRenderer } from "./FieldRenderer";
import { ActionControl } from "./ui/ActionControl";
import { Select, TextInput } from "./ui/Primitives";
import "./ElectionResultsEditor.css";

const photoField: EditorField = { key: "photo", label: "Candidate photo", kind: "asset", required: false,
  help: "Choose a cleared photo from Media. A photo is optional." };
const formatTime = (value: string) => new Date(value).toLocaleString("en-US", { timeZone: "America/New_York", timeZoneName: "short" });
function localTime(value: string): string {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
function newCandidate(): ElectionCandidate {
  return { id: crypto.randomUUID(), name: "", votes: null, share: null };
}
function newRace(): ElectionRace {
  return { id: crypto.randomUUID(), office: "", district: "", status: "awaiting", candidates: [newCandidate(), newCandidate()],
    sourceKind: "official", sourceLabel: "", sourceUrl: "", asOf: "", reportingShare: null };
}

export function ElectionResultsEditor({ block, readOnly = false, onChange, ...media }: {
  block: AdminBlock; readOnly?: boolean; onChange: (data: Record<string, unknown>, discrete?: boolean) => void;
  loadMedia?: MediaPickerLoader; mediaPickerUnavailable?: boolean; uploadMedia?: MediaUploader;
  mediaCategories?: readonly MediaCategoryDefinition[]; defaultUploadCategory?: string;
  canUploadCategory?: (category: string) => boolean; onMediaPickerDirtyChange?: (dirty: boolean) => void;
}) {
  const host = useContext(ElectionResultsSourceHost);
  const sourceKnown = !host?.documentId || !host.version || host.connectionStates.has(block.id);
  const connected = host?.connectionStates.get(block.id) === true;
  const manualReadOnly = readOnly || connected;
  const approvals = useContext(ElectionResultsReview);
  const removalNotice = useRemovalNotice();
  const hasRemovalNotice = useRemovalNoticeAvailable();
  const addRace = useRef<HTMLButtonElement>(null);
  const addCandidates = useRef(new Map<string, HTMLButtonElement>());
  const focusAfterRemoval = useRef<string | null | undefined>(undefined);
  const races = (Array.isArray(block.data.races) ? block.data.races : []) as ElectionRace[];
  const itemCounts = races.map(race => `${race.id}:${race.candidates.length}`).join(";");
  useEffect(() => {
    const target = focusAfterRemoval.current;
    if (target === undefined) return;
    focusAfterRemoval.current = undefined;
    if (!hasRemovalNotice) (target === null ? addRace.current : addCandidates.current.get(target))?.focus();
  }, [itemCounts, hasRemovalNotice]);
  const update = (next: ElectionRace[], discrete = false) => onChange({ races: next }, discrete);
  const changeRace = (id: string, next: ElectionRace) => update(races.map(race => race.id === id ? next : race));
  const changeCandidate = (race: ElectionRace, candidate: ElectionCandidate, patch: Partial<ElectionCandidate>) =>
    changeRace(race.id, { ...race, candidates: race.candidates.map(item => item.id === candidate.id ? { ...item, ...patch } : item) });
  const error = electionResultsError({ races }, false);
  return <section className="inline-block-surface election-results-editor" aria-label="Election results editor">
    {!sourceKnown ? <p>The connection has not been confirmed. Manual changes stay in the draft; confirm or pause the source before publishing.</p> : null}
    {connected ? <p>Connected source values are managed above. Pause updates before making a manual correction.</p> : null}
    <p>For manual changes, save the draft, request review, then Approve before publishing. Every approval records the exact race revision.</p>
    <p>Manual races require a staff publisher to approve their exact values. A concession is not a race call.</p>
    {error ? <p role="alert">{error}</p> : null}
    {races.length === 0 ? <p>Add the first race. Numbers stay private until approval and publication.</p> : null}
    {races.map((race, raceIndex) => {
      const approval = approvals.find(item => item.blockId === block.id && item.raceId === race.id);
      const approved = approval && electionRaceKey(approval.race) === electionRaceKey(race);
      const name = race.office && race.district ? `${race.office}: ${race.district}` : `Race ${raceIndex + 1}`;
      return <details className="election-results-editor__race" key={race.id} open={races.length === 1 || undefined}>
        <summary><span>{name}</span><span className="election-results-editor__approval">{approved ? `Approved revision ${approval.revision}` : "Needs approval"}</span></summary>
        <fieldset disabled={manualReadOnly}><legend className="sr-only">{name}</legend>
          <div className="election-results-editor__fields">
            <label>Office<TextInput maxLength={160} value={race.office} onChange={event => changeRace(race.id, { ...race, office: event.target.value })} /></label>
            <label>District or area<TextInput maxLength={160} value={race.district} onChange={event => changeRace(race.id, { ...race, district: event.target.value })} /></label>
            <label>Race status<Select value={race.status} onChange={event => {
              const { calledCandidateId: _candidate, apCallUrl: _url, ...rest } = race;
              changeRace(race.id, { ...rest, status: event.target.value as ElectionRaceStatus,
                ...(["official", "certified"].includes(event.target.value) ? { sourceKind: "official" } : {}),
                ...(event.target.value === "called" ? { sourceKind: "ap", calledCandidateId: "", apCallUrl: "" } : {}) });
            }}>{Object.entries(ELECTION_RACE_STATUSES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></label>
            <label>Reporting share (%)<TextInput type="number" min={0} max={100} step="any" value={race.reportingShare ?? ""}
              onChange={event => changeRace(race.id, { ...race, reportingShare: event.target.value === "" ? null : Number(event.target.value) })} /><small>Copy the source's percent counted or reporting. Leave blank if unknown.</small></label>
            <label>Source type<Select value={race.sourceKind} onChange={event => changeRace(race.id, { ...race, sourceKind: event.target.value as "ap" | "official" })}>
              <option value="official">Official results only</option><option value="ap">The Associated Press</option></Select></label>
            <label>Source name<TextInput maxLength={160} value={race.sourceLabel} onChange={event => changeRace(race.id, { ...race, sourceLabel: event.target.value })} /></label>
            <label className="election-results-editor__wide">Source link<TextInput type="url" maxLength={2000} value={race.sourceUrl} onChange={event => changeRace(race.id, { ...race, sourceUrl: event.target.value })} /></label>
            <label className="election-results-editor__wide">As of (your local time)<TextInput type="datetime-local" value={localTime(race.asOf)} onChange={event => {
              const value = new Date(event.target.value);
              changeRace(race.id, { ...race, asOf: Number.isFinite(value.getTime()) ? value.toISOString() : "" });
            }} /><small>The public card shows Eastern time. Use the source's update time.</small></label>
            {race.status === "called" ? <>
              <label>Candidate called by AP<Select value={race.calledCandidateId ?? ""} onChange={event => changeRace(race.id, { ...race, calledCandidateId: event.target.value })}>
                <option value="">Choose a candidate</option>{race.candidates.map((candidate, index) => <option key={candidate.id} value={candidate.id}>{candidate.name || `Candidate ${index + 1}`}</option>)}</Select></label>
              <label>AP call link<TextInput type="url" maxLength={2000} value={race.apCallUrl ?? ""} onChange={event => changeRace(race.id, { ...race, apCallUrl: event.target.value })} /></label>
            </> : null}
          </div>
          <p>Use the source's candidate order. Unlabeled candidates use the same neutral color. Party labels can add party color.</p>
          <div className="election-results-editor__candidates">{race.candidates.map((candidate, candidateIndex) => <details key={candidate.id} open={race.candidates.length <= 2 || undefined}>
            <summary>{candidate.name || `Candidate ${candidateIndex + 1}`}</summary>
            <div className="election-results-editor__fields">
              <label>Candidate name <span className="sr-only">{candidateIndex + 1}</span><TextInput maxLength={120} value={candidate.name} onChange={event => changeCandidate(race, candidate, { name: event.target.value })} /></label>
              <label>Party label (optional)<TextInput maxLength={60} value={candidate.party ?? ""} onChange={event => changeCandidate(race, candidate, { party: event.target.value })} /></label>
              <label>Votes<TextInput type="number" min={0} step={1} value={candidate.votes ?? ""} onChange={event => changeCandidate(race, candidate, { votes: event.target.value === "" ? null : Number(event.target.value) })} /></label>
              <label>Vote share (%)<TextInput type="number" min={0} max={100} step="any" value={candidate.share ?? ""} onChange={event => changeCandidate(race, candidate, { share: event.target.value === "" ? null : Number(event.target.value) })} /></label>
              <div className="election-results-editor__wide"><FieldRenderer field={photoField} fieldId={`results-${block.id}-${race.id}-${candidate.id}-photo`} value={candidate.photo?.assetId ?? ""} {...media}
                onChange={value => {
                  const { photo: _photo, ...rest } = candidate;
                  changeRace(race.id, { ...race, candidates: race.candidates.map(item => item.id === candidate.id
                    ? value ? { ...rest, photo: { assetId: String(value), alt: "" } } : rest : item) });
                }}
                onAssetSelect={asset => {
                  const { photo: _photo, ...rest } = candidate;
                  changeRace(race.id, { ...race, candidates: race.candidates.map(item => item.id === candidate.id
                    ? asset ? { ...rest, photo: { assetId: asset.id, alt: "", ...(asset.credit ? { caption: asset.credit } : {}) } } : rest : item) });
                }} /></div>
              {candidate.photo ? <>
                <label>Photo description<TextInput maxLength={300} value={candidate.photo.alt} onChange={event => changeCandidate(race, candidate, { photo: { ...candidate.photo!, alt: event.target.value } })} /></label>
                <label>Photo credit<TextInput maxLength={300} value={candidate.photo.caption ?? ""} onChange={event => changeCandidate(race, candidate, { photo: { ...candidate.photo!, caption: event.target.value } })} /></label>
              </> : null}
            </div>
            <ActionControl action="remove-item" label="Remove candidate" accessibleName={`Remove ${candidate.name || `candidate ${candidateIndex + 1}`} from ${name}`} disabled={manualReadOnly} onClick={() => {
              focusAfterRemoval.current = race.id;
              update(races.map(item => item.id === race.id ? { ...race, candidates: race.candidates.filter(item => item.id !== candidate.id) } : item), true);
              removalNotice(candidate.name || `candidate ${candidateIndex + 1}`);
            }} />
          </details>)}</div>
          <div className="button-row"><ActionControl action="add-item" label="Add candidate" accessibleName={`Add candidate to ${name}`} disabled={readOnly || race.candidates.length >= ELECTION_RESULTS_LIMITS.candidates}
            ref={node => { if (node) addCandidates.current.set(race.id, node); else addCandidates.current.delete(race.id); }} onClick={() => update(races.map(item => item.id === race.id ? { ...race, candidates: [...race.candidates, newCandidate()] } : item), true)} />
            <ActionControl action="remove-item" label="Remove race" accessibleName={`Remove ${name} from results`} disabled={manualReadOnly} onClick={() => {
              focusAfterRemoval.current = null;
              update(races.filter(item => item.id !== race.id), true); removalNotice(name);
            }} /></div>
        </fieldset>
        {approval ? <details className="election-results-editor__history"><summary>Race approval history</summary>
          <p>Latest approved revision {approval.revision}: {approval.approvedBy.displayName}, {formatTime(approval.approvedAt)}. Account: {approval.approvedBy.uid}.</p>
          <ol>{approval.statusHistory.map(entry => <li key={entry.revision}>{ELECTION_RACE_STATUSES[entry.status]}: Revision {entry.revision}, approved by {entry.approvedBy.displayName} ({entry.approvedBy.uid}), {formatTime(entry.approvedAt)}.</li>)}</ol>
          <p>The record's Revision history retains every approved set of values.</p>
        </details> : <p>No approved revision yet.</p>}
      </details>;
    })}
    <ActionControl ref={addRace} action="add-item" label="Add race" disabled={manualReadOnly || races.length >= ELECTION_RESULTS_LIMITS.races} onClick={() => update([...races, newRace()], true)} />
  </section>;
}

/** Source controls mount even when a lifecycle-locked manual editor has not opened. */
export function ElectionResultsSourceControls({ block, readOnly = false, onChange, draftState, ...media }: Parameters<typeof ElectionResultsEditor>[0] & { draftState?: "hidden" | "removed" }) {
  const host = useContext(ElectionResultsSourceHost);
  const report = host?.onConnectedChange;
  const onConnectedChange = useCallback((active: boolean | undefined) => report?.(block.id, active), [report, block.id]);
  const race = (block.data.races as ElectionRace[] | undefined)?.[0];
  const title = race ? race.office.trim() && race.district.trim() ? `${race.office}: ${race.district}` : "Race 1" : "Election results";
  return <ElectionResultsSourcePanel title={title} draftState={draftState} blockId={block.id} media={media} manualReadOnly={readOnly} onConnectedChange={onConnectedChange} onUseManual={data => onChange({ races: data.races }, true)} />;
}
