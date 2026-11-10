import { Fragment, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { HttpError } from "../lib/functions";
import { videoTime, type TranscriptAlignment, type TranscriptEdits, type TranscriptResponse, type TranscriptSegment } from "../lib/video-production";
import { matchingPassages, passageAtPosition, passageId, passageTimestamp, parseTranscriptPosition, selectedPassageRange, speakerLabel, togglePassageSelection, TRANSCRIPT_PAGE_SIZE } from "../lib/transcript-workspace";
import { ActionControl } from "./ui/ActionControl";
import { Icon } from "./ui/Icon";
import { Menu } from "./ui/Menu";
import { Button, InlineMessage, Select, TextInput, Textarea } from "./ui/Primitives";
import type { CommentThread } from "../lib/media-comment-threads";
import type { MediaComment } from "../lib/media-feedback";
import { transcriptCommentGroups } from "../lib/transcript-playback";
import { TranscriptComment } from "./media/TranscriptComment";
import "./TranscriptEditor.css";

type EditMode = "text" | "speakers";
const MAX_ALIGNMENT_PASSAGE_SECONDS = 180;

function hasWordTiming(segment: TranscriptSegment) {
  const words = segment.words;
  const normalized = (value: string) => value.trim().replace(/\s+/gu, " ");
  if (!words?.length || normalized(words.map(word => word.text.trim()).join(" ")) !== normalized(segment.text)) return false;
  let previous = segment.startSeconds;
  return words.every(word => {
    const valid = !!word.text.trim() && Number.isFinite(word.startSeconds) && Number.isFinite(word.endSeconds) &&
      word.startSeconds >= previous && word.startSeconds >= segment.startSeconds &&
      word.endSeconds > word.startSeconds && word.endSeconds <= segment.endSeconds;
    previous = word.startSeconds;
    return valid;
  });
}

function canAlignWords(segment: TranscriptSegment) {
  return !hasWordTiming(segment) && segment.overlappingSpeech !== true && !!segment.text.trim() &&
    Number.isFinite(segment.startSeconds) && Number.isFinite(segment.endSeconds) &&
    segment.endSeconds > segment.startSeconds &&
    segment.endSeconds - segment.startSeconds <= MAX_ALIGNMENT_PASSAGE_SECONDS;
}

function alignmentStatus(alignment: TranscriptAlignment, reviewed: boolean, allLoaded: boolean,
  missingWordTiming: boolean, hasEligiblePassage: boolean) {
  if (allLoaded && missingWordTiming && !hasEligiblePassage &&
      !["queued", "processing", "review_required", "ready"].includes(alignment.state)) {
    return "The corrected passages without word timing cannot be aligned automatically. The saved transcript remains available without aligned Premiere export.";
  }
  switch (alignment.state) {
    case "not_requested":
      if (!reviewed) return "Review the corrected transcript against the audio before aligning words.";
      if (!allLoaded) return "Load all passages to check whether saved corrections need word timing.";
      return missingWordTiming
        ? "One or more corrected passages need estimated word timing for Premiere export."
        : "Every passage has saved word timing. No alignment is needed.";
    case "queued": return "Word alignment is queued on the private Local worker worker.";
    case "processing": return "The private Local worker worker is estimating corrected word times.";
    case "partial": return "A batch completed. Continue alignment to process the remaining corrected passages.";
    case "review_required": return "The timing candidate is ready. Check the whole transcript and its estimated word timing against the audio, then use the review action below.";
    case "ready": return "Estimated word timing was checked against the audio with this transcript revision. Premiere export can use the aligned result.";
    case "unavailable": return "Some word timing could not be estimated safely. The saved edited transcript remains available without aligned Premiere export.";
    case "needs_reconciliation": return "The worker result could not be confirmed after three leases. Check the saved status before an explicit retry.";
    case "cancelled": return "Word alignment was cancelled. The saved edited transcript remains available.";
    case "stale": return "The video, transcript, or alignment model changed before completion. Reload the saved status, then retry if word timing is still needed.";
  }
}

export function TranscriptEditor({ pane = false, playbackSeconds, commentThreads = [], commentsIncomplete, onOpenComment, commentsAction, loadMoreAction, response, canEdit, disabled, onSeek, onSelectPassage, canSelectPassage, onSave, onAlign, onCancelAlignment, onSaved, onReload, onDirtyChange, onSavingChange, onEditingChange }: {
  pane?: boolean;
  playbackSeconds?: number;
  commentThreads?: readonly CommentThread[];
  commentsIncomplete?: boolean;
  onOpenComment?: (comment: MediaComment) => void;
  commentsAction?: ReactNode;
  loadMoreAction?: ReactNode;
  response: TranscriptResponse;
  canEdit: boolean;
  disabled: boolean;
  onSeek: (seconds: number) => void;
  onSelectPassage?: (segment: TranscriptSegment) => void;
  canSelectPassage?: (segment: TranscriptSegment) => boolean;
  onSave: (edits: TranscriptEdits) => Promise<TranscriptResponse>;
  onAlign: (retry: boolean) => Promise<TranscriptAlignment>;
  onCancelAlignment: (requestId: string) => Promise<TranscriptAlignment>;
  onSaved: (response: TranscriptResponse) => void;
  onReload: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onSavingChange: (saving: boolean) => void;
  onEditingChange: (editing: boolean) => void;
}) {
  const [editorFocusRequest, setEditorFocusRequest] = useState(0);
  const [activePassage, setActivePassage] = useState<number | null>(null);
  const [detailsPassage, setDetailsPassage] = useState<number | null>(null);
  const [editMode, setEditMode] = useState<EditMode | null>(null);
  const editing = editMode !== null;
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [roles, setRoles] = useState<Record<string, string>>({});
  const [attested, setAttested] = useState(false);
  const [saving, setSaving] = useState(false);
  const [alignmentBusy, setAlignmentBusy] = useState(false);
  const [alignmentError, setAlignmentError] = useState("");
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [speakerFilter, setSpeakerFilter] = useState("");
  const [page, setPage] = useState(0);
  const [following, setFollowing] = useState(true);
  const [followRequest, setFollowRequest] = useState(0);
  const [jump, setJump] = useState("");
  const [navigationError, setNavigationError] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const selectionAnchor = useRef<number | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const rows = useRef(new Map<number, HTMLLIElement>());
  const list = useRef<HTMLOListElement>(null);
  const [navigationTarget, setNavigationTarget] = useState<number | null>(null);
  const formId = useId();
  const helpId = useId();
  const resultsId = useId();
  const editButton = useRef<HTMLButtonElement>(null);
  const speakersButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const editorForm = useRef<HTMLFormElement>(null);
  const focusSpeaker = useRef<string>();
  const lastMode = useRef<EditMode>("text");
  const wasEditing = useRef(false);
  useEffect(() => {
    if (editing) {
      const fields = Array.from(editorForm.current?.querySelectorAll<HTMLElement>("[data-speaker-id]") ?? []);
      const target = fields.find(field => field.dataset.speakerId === focusSpeaker.current);
      const field = lastMode.current === "speakers"
        ? (target ?? fields[0])?.querySelector("input")
        : editorForm.current?.querySelector("textarea");
      (field ?? cancelButton.current)?.focus();
    } else if (wasEditing.current) (lastMode.current === "speakers" ? speakersButton : editButton).current?.focus();
    wasEditing.current = editing;
  }, [editMode, editorFocusRequest]);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const originals = response.segments ?? [];
  const savedRoles = response.transcript.speakerRoles ?? {};
  const allLoaded = !response.nextCursor && response.transcript.totalSegments !== undefined && originals.length === response.transcript.totalSegments;
  const reviewed = response.transcript.reviewedRevision != null && response.transcript.reviewedRevision === (response.transcript.editRevision ?? 0);
  const alignment = response.transcript.alignment ?? { state: "not_requested", timingBasis: "viewing-copy-elapsed" as const };
  const missingWordTiming = originals.some(segment => !hasWordTiming(segment));
  const hasEligiblePassage = alignment.state !== "not_requested" && alignment.eligiblePassages !== undefined
    ? alignment.eligiblePassages > 0 : originals.some(canAlignWords);
  const alignmentReviewRequired = alignment.state === "review_required";
  const alignmentActive = alignment.state === "queued" || alignment.state === "processing";
  const alignmentRetryable = alignment.state === "unavailable" || alignment.state === "needs_reconciliation" || alignment.state === "cancelled" || alignment.state === "stale";
  const showAlignment = alignment.state !== "not_requested" || reviewed || missingWordTiming;
  useEffect(() => {
    setAttested(false); setSelected(new Set()); selectionAnchor.current = null;
  }, [response.transcript.id, response.transcript.editRevision]);
  const savedNames = response.transcript.speakerNames ?? {};
  const changedSegments = editing ? segments.flatMap((segment, position) => {
    const original = originals[position];
    return original && (segment.text !== original.text || segment.speaker !== original.speaker)
      ? [{ index: segment.index ?? position, text: segment.text, speaker: segment.speaker }] : [];
  }) : [];
  const changedNames = editing ? Object.fromEntries(Object.keys(names)
    .filter(id => id !== "unknown" && (names[id] ?? "").trim() !== (savedNames[id] ?? ""))
    .map(id => [id, names[id].trim()])) : {};
  const changedRoles = editing ? Object.fromEntries(Object.keys(roles).filter(id => id !== "unknown" && (roles[id] ?? "").trim() !== (savedRoles[id] ?? "")).map(id => [id, roles[id].trim()])) : {};
  const speakerChanges = Object.keys(changedRoles).length > 0 || Object.keys(changedNames).length > 0;
  const dirty = speakerChanges || changedSegments.length > 0;
  const blocked = disabled || saving || alignmentBusy;
  const tooMany = changedSegments.length > 100;
  const speakers = [...new Set([...(response.transcript.speakerIds ?? []), ...originals.map(segment => segment.speaker), ...segments.map(segment => segment.speaker), ...Object.keys(savedNames), ...Object.keys(names), ...Object.keys(savedRoles), ...Object.keys(roles)])]
    .sort((a, b) => a === "unknown" ? -1 : b === "unknown" ? 1 : Number(a.slice(4)) - Number(b.slice(4)));
  const displaySegments = editing ? segments : originals;
  const displayNames = editing ? names : savedNames;
  const displayRoles = editing ? roles : savedRoles;
  // Keep the active correction mounted when its text or speaker stops matching a filter.
  // Search saved wording/assignments in text-edit mode, but render the current drafts.
  const matches = useMemo(() => matchingPassages(editMode === "text" ? originals : displaySegments, query, speakerFilter, displayNames, displayRoles)
    .map(entry => ({ ...entry, segment: displaySegments[entry.position] ?? entry.segment })), [editMode, originals, displaySegments, query, speakerFilter, displayNames, displayRoles]);
  const pageCount = Math.max(1, Math.ceil(matches.length / TRANSCRIPT_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const visible = matches.slice(currentPage * TRANSCRIPT_PAGE_SIZE, (currentPage + 1) * TRANSCRIPT_PAGE_SIZE);
  const selectedCount = originals.filter((segment, position) => selected.has(passageId(segment, position))).length;
  const hiddenSelectedCount = selectedCount - visible.filter(entry => selected.has(entry.id)).length;
  const range = selectedPassageRange(originals, selected);
  const rangeAvailable = !!range && !!canSelectPassage?.(range);
  const playingPosition = playbackSeconds === undefined ? -1 : originals.findIndex(segment =>
    segment.startSeconds <= playbackSeconds && playbackSeconds < segment.endSeconds);
  const playingId = playingPosition < 0 ? null : passageId(originals[playingPosition], playingPosition);
  const canFollow = following && !editing && !selecting && !query && !speakerFilter;
  const timedComments = useMemo(() => transcriptCommentGroups(originals, commentThreads, !response.nextCursor), [originals, commentThreads, response.nextCursor]);
  function pauseFollowing() { if (playbackSeconds !== undefined) setFollowing(false); }
  function resumeFollowing() {
    setQuery(""); setSpeakerFilter(""); setFollowing(true); setFollowRequest(value => value + 1);
  }
  useEffect(() => { if (list.current) list.current.scrollTop = 0; }, [currentPage, query, speakerFilter]);
  useEffect(() => {
    if (!canFollow || playingId === null) return;
    // Keep a focused passage mounted while staff read or expand its comments.
    if (list.current?.contains(document.activeElement)) { setFollowing(false); return; }
    const targetPage = Math.floor(playingPosition / TRANSCRIPT_PAGE_SIZE);
    if (targetPage !== currentPage) { setPage(targetPage); return; }
    const row = rows.current.get(playingId);
    const container = list.current;
    if (!row || !container || container.clientHeight === 0) return;
    const box = row.getBoundingClientRect();
    const viewport = container.getBoundingClientRect();
    if (box.top >= viewport.top && box.bottom <= viewport.bottom) return;
    // Scroll only the passage list, without moving focus or an outer viewer pane.
    container.scrollTo?.({ top: container.scrollTop + box.top - viewport.top - container.clientHeight / 3,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  }, [canFollow, playingId, playingPosition, currentPage, followRequest]);
  useEffect(() => {
    if (navigationTarget !== null) {
      const row = rows.current.get(navigationTarget);
      row?.focus({ preventScroll: true });
      row?.scrollIntoView?.({ block: "center", behavior: "instant" });
      setNavigationTarget(null);
    }
  }, [navigationTarget]);
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  useEffect(() => { onSavingChange(saving || alignmentBusy); return () => onSavingChange(false); }, [saving, alignmentBusy, onSavingChange]);
  useEffect(() => { onEditingChange(editing); return () => onEditingChange(false); }, [editing, onEditingChange]);

  function begin(mode: EditMode = "text", speaker?: string, passage?: number) {
    if (blocked || !canEdit) return;
    lastMode.current = mode; focusSpeaker.current = speaker;
    setEditorFocusRequest(value => value + 1);
    if (!editing) {
      setSegments(originals.map((segment, index) => ({ ...segment, index: segment.index ?? index })));
      setNames({ ...savedNames }); setRoles({ ...savedRoles }); setAttested(false);
      setActivePassage(passage ?? visible[0]?.id ?? null);
      setError(""); setConflict(false); setNotice("");
    } else if (mode === "text") {
      // Text mode filters saved wording/assignments, which can differ from speaker-mode drafts.
      const textMatches = matchingPassages(originals, query, speakerFilter, names, roles);
      const textPage = Math.min(page, Math.max(0, Math.ceil(textMatches.length / TRANSCRIPT_PAGE_SIZE) - 1));
      const textVisible = textMatches.slice(textPage * TRANSCRIPT_PAGE_SIZE, (textPage + 1) * TRANSCRIPT_PAGE_SIZE);
      const remembered = textVisible.find(entry => entry.id === activePassage)?.id;
      setActivePassage(passage ?? remembered ?? textVisible[0]?.id ?? null);
    }
    setSelecting(false); setSelected(new Set()); setEditMode(mode);
  }
  function cancel(reload = false) {
    if (blocked) return;
    setEditMode(null); setError(""); setConflict(false); setNotice("");
    if (reload) onReload();
  }
  function addSpeaker() {
    const reserved = response.transcript.speakerIds ? 0 : response.transcript.maxSpeakers ?? 10;
    const id = Array.from({ length: 100 - reserved }, (_, index) => `spk_${reserved + index}`)
      .find(candidate => !speakers.includes(candidate));
    if (!id) { setError("All speaker labels are in use."); return; }
    setNames(previous => ({ ...previous, [id]: speakerLabel(id) }));
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (blocked || !canEdit || !dirty || tooMany || conflict) return;
    setSaving(true); setError("");
    try {
      const saved = await onSave({ revision: response.transcript.editRevision ?? 0, segments: changedSegments, speakerNames: changedNames, speakerRoles: changedRoles });
      if (!mounted.current) return;
      onSaved(saved); setEditMode(null); setNotice(changedSegments.length ? speakerChanges ? "Passage corrections and speaker details saved." : "Transcript corrections saved." : "Speaker details saved for every passage, including passages not yet loaded.");
    } catch (error) {
      if (!mounted.current) return;
      const stale = error instanceof HttpError && error.status === 409;
      setConflict(stale);
      setError(stale ? "This transcript changed. Your edits are still here. Discard them and reload the saved transcript before editing again."
        : "Transcript corrections could not be saved. Your edits are still here.");
    } finally { if (mounted.current) setSaving(false); }
  }
  async function markReviewed() {
    if (blocked || editing || !canEdit || !allLoaded || !attested || reviewed || conflict) return;
    setSaving(true); setError("");
    try {
      const saved = await onSave({ revision: response.transcript.editRevision ?? 0, reviewed: true });
      if (!mounted.current) return;
      onSaved(saved); setAttested(false); setNotice(alignmentReviewRequired ? "Transcript and estimated word timing review saved." : "Transcript review saved.");
    } catch (error) {
      if (!mounted.current) return;
      const stale = error instanceof HttpError && error.status === 409;
      setConflict(stale);
      setError(stale ? "This transcript changed. Reload the saved transcript and check it again before marking it reviewed." : "The review could not be confirmed. Reload the saved transcript to check its review status.");
    } finally { if (mounted.current) setSaving(false); }
  }
  async function startAlignment(retry = false) {
    if (blocked || editing || !canEdit || !reviewed || !allLoaded || !hasEligiblePassage) return;
    setAlignmentBusy(true); setAlignmentError(""); setNotice("");
    try {
      const next = await onAlign(retry);
      if (!mounted.current) return;
      onSaved({ ...response, transcript: { ...response.transcript, alignment: next } });
      setNotice(retry ? "Word alignment retry saved." : alignment.state === "partial" ? "The next word alignment batch was saved." : "Word alignment request saved.");
    } catch (error) {
      if (!mounted.current) return;
      setAlignmentError(error instanceof HttpError && error.status < 500
        ? error.message : "Word alignment could not be requested. Check the saved transcript status before trying again.");
    } finally { if (mounted.current) setAlignmentBusy(false); }
  }
  async function cancelAlignment() {
    if (blocked || editing || !canEdit || !alignment.requestId || !["queued", "processing"].includes(alignment.state)) return;
    setAlignmentBusy(true); setAlignmentError(""); setNotice("");
    try {
      const next = await onCancelAlignment(alignment.requestId);
      if (!mounted.current) return;
      onSaved({ ...response, transcript: { ...response.transcript, alignment: next } });
      setNotice("Word alignment cancelled.");
    } catch (error) {
      if (!mounted.current) return;
      setAlignmentError(error instanceof HttpError && error.status < 500
        ? error.message : "Word alignment cancellation could not be confirmed. Reload its saved status before trying again.");
    } finally { if (mounted.current) setAlignmentBusy(false); }
  }
  function top(nextPage = 0) {
    pauseFollowing();
    if (list.current) list.current.scrollTop = 0;
    setPage(nextPage);
    (pane ? heading.current?.closest(".transcript-workspace")?.querySelector<HTMLInputElement>('input[type="search"]') : heading.current)?.focus({ preventScroll: true });
    heading.current?.scrollIntoView?.({ block: "start", behavior: "instant" });
  }
  function jumpToPassage(event: FormEvent) {
    pauseFollowing();
    event.preventDefault();
    const seconds = parseTranscriptPosition(jump);
    if (seconds === null) { setNavigationError("Enter elapsed seconds, m:ss, or h:mm:ss, such as 1:05:30."); return; }
    const position = passageAtPosition(displaySegments, seconds);
    if (position < 0) {
      setNavigationError(allLoaded ? "There is no passage at or after that time in this transcript." : "That time is beyond the loaded passages. Use Load more transcript below, then try again.");
      return;
    }
    setQuery(""); setSpeakerFilter(""); setPage(Math.floor(position / TRANSCRIPT_PAGE_SIZE)); setNavigationError("");
    setNavigationTarget(passageId(displaySegments[position], position));
  }
  function passageFacts(segment: TranscriptSegment) {
    return `${videoTime(segment.startSeconds)} to ${videoTime(segment.endSeconds)} · Duration ${videoTime(segment.endSeconds - segment.startSeconds)}`;
  }
  const passageList = <ol ref={list} id={resultsId} className="transcript-passages" aria-label="Transcript passages"
    onFocusCapture={pauseFollowing} onWheel={pauseFollowing} onTouchStart={pauseFollowing} onPointerDown={pauseFollowing}
    onKeyDown={event => { if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) pauseFollowing(); }}>
    {currentPage === 0 && !query && !speakerFilter ? timedComments.get(-1)?.map(thread => <TranscriptComment key={thread.comment.id} thread={thread} incomplete={commentsIncomplete} onOpen={onOpenComment} />) : null}
    {visible.map(({ segment, position, id }, visibleIndex) => {
    const name = segment.speaker === "unknown" ? speakerLabel(segment.speaker) : displayNames[segment.speaker]?.trim() || speakerLabel(segment.speaker);
    // Unknown is an unassigned voice, not a shared speaker identity.
    const previousVisible = visible[visibleIndex - 1];
    const continuation = segment.speaker !== "unknown" && !!previousVisible &&
      previousVisible.position === position - 1 && previousVisible.segment.speaker === segment.speaker;
    const active = editMode === "text" && activePassage === id;
    const validClip = !!selectedPassageRange([segment], new Set([passageId(segment, 0)]));
    const clipAvailable = validClip && !!canSelectPassage?.(segment);
    const clipReason = !validClip ? "A clip must span 0.25 seconds to 30 minutes."
      : !clipAvailable ? "Clip unavailable. Check the viewing copy and current exports." : "";
    const flags = [segment.speakerUncertain ? "Speaker uncertain" : "", segment.overlappingSpeech ? "Overlapping speech" : ""].filter(Boolean).join(" · ");
    return <Fragment key={id}><li className="transcript-row" data-playing={id === playingId || undefined} aria-current={id === playingId ? "true" : undefined} data-selecting={selecting || undefined} data-selected={selecting && selected.has(id) || undefined} tabIndex={-1}
      aria-label={`Passage ${position + 1}: ${name}`} ref={element => { if (element) rows.current.set(id, element); else rows.current.delete(id); }}>
      {selecting ? <label className="transcript-selection-check"><input type="checkbox" aria-label={`Select passage ${position + 1}`} checked={selected.has(id)} disabled={blocked} onChange={event => {
        const extend = "shiftKey" in event.nativeEvent && event.nativeEvent.shiftKey === true;
        const checked = event.target.checked;
        const anchor = selectionAnchor.current;
        setSelected(previous => togglePassageSelection(previous, id, checked, matches.map(entry => entry.id), anchor, extend));
        selectionAnchor.current = id;
      }} /></label> : null}
      <Button className="transcript-timestamp" variant="ghost" onClick={() => {
        onSeek(segment.startSeconds);
        // The phone player takes seek focus before following resumes.
        requestAnimationFrame(() => {
          if (!mounted.current || query || speakerFilter) return;
          setFollowing(true);
          setFollowRequest(value => value + 1);
        });
      }} aria-label={`Seek to ${videoTime(segment.startSeconds)}`} title={videoTime(segment.startSeconds)}>{passageTimestamp(segment.startSeconds)}</Button>
      <span className="transcript-speaker" data-continuation={continuation || undefined} title={name}>{continuation ? <span aria-hidden="true">↳</span> : name}</span>
      <div className="transcript-passage">{active ? <div className="transcript-passage-editor">
        <p className="transcript-passage-facts">{passageFacts(segment)}</p>
        <label>Speaker for passage {position + 1}<Select disabled={blocked} value={segment.speaker} onChange={event => setSegments(previous => previous.map((entry, index) => index === position ? { ...entry, speaker: event.target.value } : entry))}>
          {speakers.map(speaker => <option key={speaker} value={speaker}>{speaker === "unknown" ? speakerLabel(speaker) : names[speaker]?.trim() ? `${names[speaker].trim()} (${speakerLabel(speaker)})` : speakerLabel(speaker)}</option>)}
        </Select></label>
        <label>Passage {position + 1}<Textarea maxLength={16000} disabled={blocked} value={segment.text} onChange={event => setSegments(previous => previous.map((entry, index) => index === position ? { ...entry, text: event.target.value } : entry))} /></label>
      </div> : <p className="transcript-passage-text">{segment.text}{editMode === "text" && changedSegments.some(entry => entry.index === (segment.index ?? position)) ? <span className="transcript-draft-flag"> Unsaved correction</span> : null}
      </p>}
        {id === playingId ? <span className="transcript-playing-label">Current passage</span> : null}
        {flags ? <span className="transcript-passage-flags">{flags}</span> : null}
        {detailsPassage === id ? <div className="transcript-passage-details">
          <p>{passageFacts(segment)}</p>
          {segment.speaker !== "unknown" && displayRoles[segment.speaker] ? <p>{displayRoles[segment.speaker]}</p> : null}
          {onSelectPassage && clipReason ? <p>{clipReason}</p> : null}
          <Button variant="ghost" onClick={() => { setDetailsPassage(null); rows.current.get(id)?.querySelector<HTMLButtonElement>(".transcript-row-menu")?.focus(); }}>Hide passage details</Button>
        </div> : null}
      </div>
      <Menu className="transcript-row-menu" label={`Passage ${position + 1} actions`} tooltip={`Passage ${position + 1} actions`} disabled={blocked} items={[
        { key: "details", label: "Passage details", description: `${passageFacts(segment)}${onSelectPassage && clipReason ? ` · ${clipReason}` : ""}`, onSelect: () => setDetailsPassage(id) },
        { key: "edit", label: `Edit passage ${position + 1}`, hidden: !canEdit || editMode === "speakers", onSelect: () => begin("text", undefined, id) },
        { key: "rename", label: `Rename ${name} (${speakerLabel(segment.speaker)})`, hidden: !canEdit || segment.speaker === "unknown", onSelect: () => begin("speakers", segment.speaker) },
        { key: "clip", label: `Use passage ${position + 1} as clip`, hidden: editing || selecting || !onSelectPassage || !clipAvailable,
          onSelect: () => { if (!blocked && clipAvailable) onSelectPassage?.(segment); } },
      ]} />
    </li>{!editing ? timedComments.get(position)?.map(thread => <TranscriptComment key={thread.comment.id} thread={thread} incomplete={commentsIncomplete} onOpen={onOpenComment} />) : null}</Fragment>;
  })}</ol>;

  const searchControl = <label>Search loaded transcript<TextInput type="search" value={query} maxLength={500} disabled={saving} aria-describedby={helpId} aria-controls={resultsId} placeholder="Words, speaker, or affiliation" onChange={event => { pauseFollowing(); setQuery(event.target.value); setPage(0); }} /></label>;
  const speakerControl = <label>Filter by speaker<Select value={speakerFilter} disabled={saving} aria-controls={resultsId} onChange={event => { pauseFollowing(); setSpeakerFilter(event.target.value); setPage(0); }}><option value="">All speakers</option>{speakers.map(id => <option key={id} value={id}>{id === "unknown" ? speakerLabel(id) : displayNames[id]?.trim() ? `${displayNames[id].trim()} (${speakerLabel(id)})` : speakerLabel(id)}</option>)}</Select></label>;
  const jumpControl = <form className="transcript-jump" onSubmit={jumpToPassage}><label>Jump to time<TextInput value={jump} disabled={saving} placeholder="1:05:30" aria-invalid={navigationError ? true : undefined} aria-describedby={navigationError ? `${helpId}-jump` : helpId} onChange={event => setJump(event.target.value)} /></label><Button type="submit" disabled={saving || !jump.trim()}>Go</Button></form>;
  const coverageAndHelp = <>    <p id={helpId}>{originals.length} passages loaded{response.transcript.totalSegments !== undefined ? ` of ${response.transcript.totalSegments}` : ""}. {allLoaded ? "Search covers the entire transcript." : "Search and navigation cover loaded passages only. Load more transcript below to reach later passages."}</p>
    {editing ? <p>{editMode === "speakers" ? "Names and affiliations update every matching speaker label as you type. Save to apply them throughout the shared transcript." : "Correct wording and speaker assignments. Timestamps stay unchanged. Save up to 100 changed passages at a time; edits stay with you between pages. Filters use saved wording and speaker assignments while you correct text."}</p> : <details className="transcript-help"><summary>Transcript help</summary><p>Select a timestamp to seek the preview. Passage menus offer exact timing, corrections, speaker naming and available clip ranges. Text selection does not seek. Use Tab to reach a passage menu, then Enter or the arrow keys to open it; Escape closes it. In selection mode, Shift-select includes matching passages between the two selections.</p></details>}
</>;
  const reviewTools = <>    {showAlignment ? <section className="transcript-alignment" aria-label="Corrected word timing">
      <h4>Corrected word timing</h4>
      <p>Word times are model estimates in elapsed viewing-copy time. Check them against the audio before use.</p>
      <p role={alignmentActive ? "status" : undefined}>{alignmentStatus(alignment, reviewed, allLoaded, missingWordTiming, hasEligiblePassage)}</p>
      {alignment.unavailablePassages ? <p>{alignment.unavailablePassages} {alignment.unavailablePassages === 1 ? "passage is" : "passages are"} unavailable for automatic alignment.</p> : null}
      {!editing && alignment.state === "not_requested" && reviewed && allLoaded && hasEligiblePassage && canEdit
        ? <Button aria-busy={alignmentBusy || undefined} disabled={blocked} onClick={() => void startAlignment()}>{alignmentBusy ? "Requesting word alignment" : "Align corrected words"}</Button> : null}
      {!editing && alignment.state === "partial" && (!allLoaded || hasEligiblePassage) && canEdit
        ? <Button aria-busy={alignmentBusy || undefined} disabled={blocked || !allLoaded || !hasEligiblePassage} onClick={() => void startAlignment()}>{alignmentBusy ? "Requesting next batch" : "Continue word alignment"}</Button> : null}
      {!editing && alignmentRetryable && (!allLoaded || hasEligiblePassage) && canEdit
        ? <Button aria-busy={alignmentBusy || undefined} disabled={blocked || !allLoaded || !hasEligiblePassage} onClick={() => void startAlignment(true)}>{alignmentBusy ? "Requesting word alignment" : "Retry word alignment"}</Button> : null}
      {!editing && alignmentActive && canEdit ? <div className="video-production-buttons">
        <Button disabled={blocked} onClick={onReload}>Check alignment status</Button>
        <Button variant="danger-quiet" aria-busy={alignmentBusy || undefined} disabled={blocked || !alignment.requestId} onClick={() => void cancelAlignment()}>{alignmentBusy ? "Cancelling word alignment" : "Cancel word alignment"}</Button>
      </div> : null}
      {!editing && alignment.state === "stale" ? <Button disabled={blocked} onClick={onReload}>Reload saved transcript</Button> : null}
      {alignmentError ? <InlineMessage tone="error" title="Word alignment needs attention">{alignmentError}<Button disabled={blocked} onClick={() => { setAlignmentError(""); onReload(); }}>Reload saved transcript</Button></InlineMessage> : null}
    </section> : null}
    <section className="transcript-review" aria-label="Transcript review">
      <h4>Review status</h4>
      {reviewed ? <p>Revision {response.transcript.reviewedRevision} checked{response.transcript.reviewedByName ? ` by ${response.transcript.reviewedByName}` : " by a staff member"}{response.transcript.reviewedAt && Number.isFinite(Date.parse(response.transcript.reviewedAt)) ? ` on ${new Date(response.transcript.reviewedAt).toLocaleString("en-US", { timeZone: "America/New_York" })} ET` : ""}.</p> : <p>{alignmentReviewRequired ? "Check the entire transcript and its estimated word timing against the audio. This timing candidate cleared the earlier review record." : "Check the entire transcript against the audio before marking it reviewed. Saved corrections clear the review record."}</p>}
      {!editing && !reviewed && canEdit ? <><label className="transcript-review-check"><input type="checkbox" checked={attested} disabled={blocked || !allLoaded || conflict} onChange={event => setAttested(event.target.checked)} />{alignmentReviewRequired ? "I checked the entire transcript and estimated word timing against the audio" : "I checked the entire transcript against the audio"}</label>
        {!allLoaded ? <p>Load all passages before marking the entire transcript reviewed.</p> : null}
        <Button disabled={blocked || !allLoaded || !attested || conflict} onClick={() => void markReviewed()}>{saving ? "Saving review" : alignmentReviewRequired ? "Mark transcript and timing reviewed" : "Mark transcript reviewed"}</Button></> : null}
      {!editing && error ? <InlineMessage tone="error" title="Transcript review needs attention">{error}<Button disabled={blocked} onClick={() => { setError(""); setConflict(false); setAttested(false); onReload(); }}>Reload saved transcript</Button></InlineMessage> : null}
    </section></>;

  const resultsBar = <div className="transcript-results-bar">
      <p role="status" aria-live={canFollow && playbackSeconds !== undefined ? "off" : "polite"}>{matches.length ? pane ? `${currentPage * TRANSCRIPT_PAGE_SIZE + 1}–${Math.min((currentPage + 1) * TRANSCRIPT_PAGE_SIZE, matches.length)} of ${matches.length} matches` : `Showing ${currentPage * TRANSCRIPT_PAGE_SIZE + 1}–${Math.min((currentPage + 1) * TRANSCRIPT_PAGE_SIZE, matches.length)} of ${matches.length} matching passages.` : "No matching loaded passages."}{pane ? ` · ${allLoaded ? "Entire transcript" : `${originals.length}${response.transcript.totalSegments !== undefined ? `/${response.transcript.totalSegments}` : ""} loaded passages only`}` : ""}</p>
      {query || speakerFilter ? <Button variant="ghost" onClick={() => { setQuery(""); setSpeakerFilter(""); setPage(0); }}>Clear filters</Button> : null}
      {pageCount > 1 ? <nav aria-label="Transcript pages"><Button disabled={currentPage === 0} onClick={() => top(currentPage - 1)}>Previous page</Button><span>Page {currentPage + 1} of {pageCount}</span><Button disabled={currentPage === pageCount - 1} onClick={() => top(currentPage + 1)}>Next page</Button></nav> : null}
      {loadMoreAction}
      {commentsAction}
    </div>;

  return <section className="video-transcript transcript-workspace" data-pane={pane || undefined} data-mode={editMode ?? "read"} aria-label="Saved video transcript" onKeyDown={event => {
    // Row menus portal into the viewer dialog, outside its transcript key opt-out.
    // Their events still bubble through this React owner; keep frame stepping out.
    if ((event.key === "ArrowLeft" || event.key === "ArrowRight") &&
        event.target instanceof Element && event.target.closest('[role="menu"]')) {
      event.preventDefault(); event.stopPropagation();
    }
  }}>
    <div className="transcript-command-bar">
      <h3 ref={heading} tabIndex={-1}>Transcript</h3>
      {pane ? searchControl : null}
      <div className="transcript-command-actions" role="group" aria-label="Transcript actions">
        {playbackSeconds !== undefined ? <Button className="transcript-follow" variant="ghost" aria-pressed={canFollow} disabled={editing || selecting} onClick={() => { if (canFollow) pauseFollowing(); else resumeFollowing(); }}>{canFollow ? "Following playback" : "Follow playback"}</Button> : null}
        {pane ? null : <Button variant="ghost" onClick={() => top()}>Back to top</Button>}
        {canEdit ? pane ? <><ActionControl action="edit" ref={speakersButton} graphic={<Icon name="users" />} label="Rename speakers" accessibleName="Rename speakers" disabled={blocked} onClick={() => begin("speakers")} /><ActionControl action="edit" ref={editButton} label="Edit transcript" accessibleName="Edit transcript" disabled={blocked} onClick={() => begin()} /></> : <><Button ref={speakersButton} disabled={blocked} onClick={() => begin("speakers")}>Rename speakers</Button><Button ref={editButton} disabled={blocked} onClick={() => begin()}>Edit transcript</Button></> : null}
        {!editing && onSelectPassage ? pane ? <ActionControl action="select-all" graphic={<Icon name="check-square" />} label={selecting ? "Cancel selection" : "Select passages"} accessibleName={selecting ? "Cancel selection" : "Select passages"} disabled={blocked} aria-pressed={selecting} onClick={() => { setSelecting(value => !value); setSelected(new Set()); selectionAnchor.current = null; }} /> : <Button disabled={blocked} aria-pressed={selecting} onClick={() => { setSelecting(value => !value); setSelected(new Set()); selectionAnchor.current = null; }}>{selecting ? "Cancel selection" : "Select passages"}</Button> : null}
      </div>
    </div>

    {pane ? null : coverageAndHelp}
    <div className="transcript-find-controls">
      {pane ? null : searchControl}
      {speakerControl}
      {pane ? <details className="transcript-tools"><summary>Transcript tools & review</summary>
        {coverageAndHelp}{jumpControl}{reviewTools}
      </details> : jumpControl}
    </div>
    {selecting ? <p>Choose passages across pages and filters. Shift-select to include a range of matching passages.</p> : null}
    {navigationError ? <p id={`${helpId}-jump`} role="alert">{navigationError}</p> : null}
    {pane ? null : resultsBar}
    {notice ? <p role="status">{notice}</p> : null}
    <form id={formId} ref={editorForm} className="transcript-editor" aria-label={editing ? "Transcript corrections" : undefined} onSubmit={event => void save(event)}>
      {editMode === "speakers" ? <fieldset disabled={blocked}><legend>Speaker names</legend>
        <p>Names apply to every passage with that speaker label, including passages not yet loaded. Clear a name to restore its numbered label.</p>
        <div className="transcript-speaker-names">{speakers.filter(id => id !== "unknown").map(id => <div className="transcript-speaker-fields" key={id} data-speaker-id={id}><label>{speakerLabel(id)} name<TextInput maxLength={100} value={names[id] ?? ""} placeholder={speakerLabel(id)} onChange={event => setNames(previous => ({ ...previous, [id]: event.target.value }))} /></label><label>{speakerLabel(id)} title or affiliation<TextInput maxLength={240} value={roles[id] ?? ""} onChange={event => setRoles(previous => ({ ...previous, [id]: event.target.value }))} /></label></div>)}</div>
        <p>Unknown speaker can include different voices. Use Edit transcript to assign each unknown passage to a numbered speaker before adding a name or role.</p><Button onClick={addSpeaker}>Add speaker</Button>
      </fieldset> : null}
      {passageList}
    </form>
    {visible.length ? <nav className="transcript-page-footer" hidden={pane} aria-label="Continue transcript">
      <Button variant="ghost" onClick={() => top()}>Return to transcript top</Button>
      {currentPage > 0 ? <Button onClick={() => top(currentPage - 1)}>Read previous page</Button> : null}
      {currentPage < pageCount - 1 ? <Button onClick={() => top(currentPage + 1)}>Read next page</Button> : null}
    </nav> : null}
    {editing ? <div className="transcript-edit-actions">
      {tooMany ? <p role="alert">Save at most 100 changed passages at a time. Undo some passage changes before saving.</p> : null}
      {error ? <InlineMessage tone="error" title="Transcript corrections need attention">{error}</InlineMessage> : null}
      <p role="status">{saving ? "Saving transcript corrections." : dirty ? `Unsaved changes${changedSegments.length ? ` · ${changedSegments.length} changed passages` : ""}.` : "No unsaved changes."}</p>
      <div className="video-production-buttons"><Button form={formId} type="submit" variant="primary" disabled={blocked || !canEdit || !dirty || tooMany || conflict}>{saving ? "Saving transcript" : editMode === "speakers" && !changedSegments.length ? "Save speaker names" : "Save transcript"}</Button>
        <Button ref={cancelButton} disabled={blocked} onClick={() => cancel()}>Cancel edits</Button>
        {conflict ? <Button disabled={blocked} onClick={() => cancel(true)}>Discard edits and reload</Button> : null}</div>
    </div> : null}
    {selecting ? <div className="transcript-selection-bar" role="region" aria-label="Clip selection">
      <p role="status">{selectedCount} passages selected{hiddenSelectedCount > 0 ? ` · ${hiddenSelectedCount} outside this page or filter` : ""}.{range ? ` Continuous clip: ${videoTime(range.startSeconds)} to ${videoTime(range.endSeconds)} · ${videoTime(range.endSeconds - range.startSeconds)}.` : ""}</p>
      <p>Continuous range; includes gaps and unselected passages. Setting the range opens clip controls without exporting.</p>
      {selectedCount > 0 && !range ? <p role="alert">Choose a continuous span of 0.25 seconds to 30 minutes. Clear some passages to shorten the range.</p> : null}
      {range && !rangeAvailable ? <p>The selected range is not available for export right now. Check the viewing copy and current exports.</p> : null}
      <div className="video-production-buttons"><Button variant="primary" disabled={blocked || !rangeAvailable} onClick={() => { if (range && rangeAvailable && !blocked) onSelectPassage?.(range); }}>Use selected range as clip</Button>
        <Button disabled={blocked || !selectedCount} onClick={() => { setSelected(new Set()); selectionAnchor.current = null; }}>Clear selection</Button></div>
    </div> : null}
    {pane ? resultsBar : null}
    {pane ? null : reviewTools}
  </section>;
}
