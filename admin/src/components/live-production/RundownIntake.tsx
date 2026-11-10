import { useCallback, useEffect, useRef, useState } from "react";
import type { BannerText } from "../../../../packages/content-core/src/live-production";
import { Button, InlineMessage, Select, TextInput } from "../ui/Primitives";
import { BannerFields, validBannerText } from "../../routes/LiveProductionPreparation";
import { useExitGuard } from "../../routes/ExitGuard";
import { bannerLines } from "../../lib/live-production-workspace";
import { proposalBaseline, proposalEditedFields, validSourceConfig, type RundownClient, type RundownChange, type RundownDecision, type RundownReview, type SourceConfig, type SourceView } from "../../lib/rundown-intake";
import styles from "./RundownIntake.css?inline";

type ProposalEdit = { change: RundownChange; reviewVersion: number; sourceGeneration: number; draftRevision: number; text: BannerText | null;
  targetId: string; overrides: string[]; changed: boolean };
const blankConfig: SourceConfig = { documentId: "", tabIds: [], enabled: false };
const message = (error: unknown) => error instanceof Error ? error.message : "The rundown request could not complete. Existing drafts remain usable.";
const statusLabels: Record<string, string> = { current: "Current source read.", waiting: "Waiting for a source read.", disabled: "Source reading paused.",
  not_configured: "No source selected.", access_lost: "Document access lost.", quota: "Google request limit reached.", oversized: "Source exceeds the intake budget.",
  invalid_source: "Selected source cannot be read.", source_changed: "Source changed during the read.", not_activated: "Document intake awaits activation.", unavailable: "Source is unavailable." };
const reasonLabels = new Map([
  ["ambiguous_grouping", "Check how the source lines are grouped, then choose a template."],
  ["editorial_annotation", "The source includes editorial notes. Check the proposed wording before accepting."],
  ["repeated_marker", "This source marker appears more than once. Check the source passage and banner identity."],
]);
function Copy({ text }: { text: BannerText | null }) {
  return <div className="rundown-copy">{text ? bannerLines(text).map((line, index) => <p key={index}>{line || "(empty title)"}</p>) : <p>No saved draft</p>}</div>;
}

export function RundownIntake({ client, sessionId, active, ended, connected, hidden, disabled, draftRevision = 0, onStateChange, onDraftChanged }: {
  client: RundownClient; sessionId: string; active: boolean; ended: boolean; connected: boolean; hidden: boolean; disabled: boolean;
  draftRevision?: number;
  onStateChange: (dirty: boolean, busy: boolean) => void; onDraftChanged: () => void;
}) {
  const [view, setView] = useState<SourceView | null>(null), [review, setReview] = useState<RundownReview | null>(null);
  const [settings, setSettings] = useState<{ base: number; config: SourceConfig } | null>(null);
  const [edit, setEdit] = useState<ProposalEdit | null>(null);
  const [busy, setBusy] = useState(false), [mutating, setMutating] = useState(false), [error, setError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null), [reload, setReload] = useState(0);
  const [pendingDecision, setPendingDecision] = useState<RundownDecision | null>(null);
  const [focusReturn, setFocusReturn] = useState(0);
  const handledFocus = useRef(0);
  const reviewHeading = useRef<HTMLHeadingElement>(null), summary = useRef<HTMLElement>(null);
  const lock = useRef(false), controller = useRef<AbortController | null>(null), sourceHash = useRef("");
  const reviewedDraftRevision = useRef(draftRevision);
  const requestExit = useExitGuard();
  const config = settings?.config ?? view?.source.config ?? blankConfig;
  const dirty = Boolean(settings || edit?.changed || pendingDecision);
  useEffect(() => { onStateChange(dirty, mutating); }, [dirty, mutating, onStateChange]);
  useEffect(() => () => onStateChange(false, false), [onStateChange]);
  useEffect(() => {
    if (focusReturn === handledFocus.current) return;
    handledFocus.current = focusReturn;
    if (!hidden) (reviewHeading.current ?? summary.current)?.focus();
  }, [focusReturn, hidden]);
  const applySource = useCallback(async (next: SourceView, signal: AbortSignal, force = false) => {
    if (signal.aborted) return;
    setView(next);
    if (!next.source.config?.enabled || !next.snapshot) { setReview(null); return; }
    const key = `${next.source.configVersion}:${next.source.generation}:${next.snapshot.hash}:${draftRevision}`;
    if (!force && sourceHash.current === key) return;
    await client.extract(sessionId, next.source.generation, signal);
    const proposed = await client.reconcile(sessionId, next.source.generation, signal);
    if (!signal.aborted) { sourceHash.current = key; reviewedDraftRevision.current = draftRevision; setReview(proposed); }
  }, [client, sessionId, draftRevision]);

  // Workspace sets connected=false for an offline or hidden browser tab.
  // Show and Prepare keep the same active source owner mounted.
  useEffect(() => {
    const abort = new AbortController(); controller.current = abort;
    let timer: ReturnType<typeof setTimeout> | undefined;
    lock.current = false; setBusy(false); setMutating(false);
    async function poll(first = false) {
      if (abort.signal.aborted) return;
      if (lock.current) { timer = setTimeout(() => void poll(), 25000); return; }
      lock.current = true; setBusy(true);
      try {
        const next = first ? await client.source(sessionId, abort.signal) : await client.refresh(sessionId, false, abort.signal);
        await applySource(next, abort.signal);
        if (!abort.signal.aborted) setPollError(null);
        if (active && next.source.config?.enabled && !abort.signal.aborted) {
          const delay = Math.max(first ? 0 : 25000, next.source.nextAttemptAtMs - next.serverNowMs);
          timer = setTimeout(() => void poll(), delay);
        }
      } catch (failure) {
        if (!abort.signal.aborted) { setPollError(message(failure)); if (active) timer = setTimeout(() => void poll(), 50000); }
      } finally { if (!abort.signal.aborted) { lock.current = false; setBusy(false); } }
    }
    if (connected && !ended) void poll(true);
    return () => { abort.abort(); clearTimeout(timer); };
  }, [client, sessionId, active, ended, connected, reload, applySource]);

  async function refresh() {
    const signal = controller.current?.signal;
    if (!signal || signal.aborted || lock.current) return;
    lock.current = true; setBusy(true); setError(null); setPollError(null);
    try { await applySource(await client.refresh(sessionId, true, signal), signal, true); }
    catch (failure) { if (!signal.aborted) setError(message(failure)); }
    finally { if (!signal.aborted) { lock.current = false; setBusy(false); } }
  }
  async function configure() {
    const signal = controller.current?.signal;
    if (!signal || signal.aborted || !settings || lock.current) return;
    lock.current = true; setBusy(true); setMutating(true); setError(null); setNotice(null);
    try {
      const saved = await client.configure(sessionId, settings.base, settings.config, signal);
      if (signal.aborted) return;
      setView(saved); setSettings(null); setReview(null); setEdit(null); sourceHash.current = "";
      setNotice("Source settings saved. No banner draft or live output changed."); setReload(value => value + 1);
    } catch (failure) { if (!signal.aborted) setError(`${message(failure)} Reload source settings to check the saved version.`); }
    finally { if (!signal.aborted) { lock.current = false; setBusy(false); setMutating(false); } }
  }
  const selectChange = (change: RundownChange) => {
    const select = () => {
    setEdit({ change, reviewVersion: review!.version, sourceGeneration: review!.sourceGeneration, draftRevision: reviewedDraftRevision.current, text: change.candidate?.text ?? null,
      targetId: change.target?.bannerId ?? "", overrides: [], changed: false }); setNotice(null);
    };
    if (edit?.changed) requestExit(select); else select();
  };
  async function decide(body: RundownDecision) {
    const signal = controller.current?.signal;
    if (!signal || signal.aborted || lock.current) return;
    lock.current = true; setBusy(true); setMutating(true); setError(null); setNotice(null); setPendingDecision(body);
    try {
      const result = await client.decide(body, signal);
      if (signal.aborted) return;
      setPendingDecision(null); setEdit(null); setMutating(false);
      setFocusReturn(value => value + 1);
      if (result.decision !== "ignored") onDraftChanged();
      setNotice(result.decision === "ignored" ? "Suggestion ignored for this source fingerprint." : result.decision === "removal_acknowledged"
        ? "Source removal acknowledged. The saved draft remains." : "Accepted into a saved draft. Cue and live output remain unchanged.");
      await applySource(await client.source(sessionId, signal), signal, true);
    } catch (failure) {
      if (!signal.aborted) {
        const status = failure && typeof failure === "object" && "status" in failure ? Number(failure.status) : 0;
        if (status >= 400 && status < 500) setPendingDecision(null);
        if (status === 409) {
          // A refused decision has no uncertain receipt. Reconcile the current
          // draft while retaining proposed wording for an explicit comparison.
          setReview(null); sourceHash.current = ""; setReload(value => value + 1);
        }
        setError(`${message(failure)}${status === 409 ? " Refresh rundown to compare the latest suggestion before trying again." : ""}`);
      }
    } finally { if (!signal.aborted) { lock.current = false; setBusy(false); setMutating(false); } }
  }
  const target = edit?.change.target ?? edit?.change.possibleTargets.find(item => item.bannerId === edit.targetId) ?? null;
  const templateOverrideRequired = Boolean(target && edit?.text && edit.text.templateId !== target.text.templateId &&
    target.protectedFields.some(field => field !== "order" && !edit.overrides.includes(field)));
  const stale = Boolean(edit && (edit.draftRevision !== draftRevision || !review || edit.reviewVersion !== review.version || edit.sourceGeneration !== review.sourceGeneration || edit.sourceGeneration !== view?.source.generation));
  const unavailable = disabled || !connected || ended || mutating || Boolean(pendingDecision);
  const actionUnavailable = unavailable || busy;
  const sourceEdit = (next: SourceConfig) => setSettings(previous => ({ base: previous?.base ?? view?.source.configVersion ?? 0, config: next }));
  const decision = (action: "accept" | "ignore"): RundownDecision => ({ action, sessionId, requestId: crypto.randomUUID(),
    sourceGeneration: edit!.sourceGeneration, reviewVersion: edit!.reviewVersion, suggestionId: edit!.change.id,
    baseVersion: action === "ignore" ? edit!.change.target?.baseVersion ?? 0 : target?.baseVersion ?? 0,
    ...(action === "accept" && edit!.text ? { text: edit!.text, overrideFields: edit!.overrides,
      editedFields: proposalEditedFields(edit!.change.candidate!, edit!.text) } : {}),
    ...(action === "accept" && !edit!.change.target && edit!.targetId ? { targetBannerId: edit!.targetId } : {}) });

  return <details className="panel rundown-intake" hidden={hidden}>
    <style>{styles}</style>
    <summary ref={summary}>Google Docs rundown{review?.changes.length ? ` · ${review.changes.length} to review` : ""}</summary>
    <div className="rundown-intake-body" aria-busy={busy}>
      <p>Review proposals before accepting them into drafts. Import and Refresh never change live output.</p>
      <p role="status">{ended ? "Session ended. Source reading stopped." : !connected ? "Source reading paused while disconnected." : view ? view.source.status === "current" && !view.snapshot ? "Source read expired. Refresh the rundown." : statusLabels[view.source.status] ?? "Source status unavailable." : "Loading source settings…"}
        {view?.snapshot && view.source.status !== "current" ? " Using the last good read." : ""}</p>
      {view?.snapshot?.diagnostics.length ? <InlineMessage tone="warning">The source has {view.snapshot.diagnostics.length} omitted or unsupported elements. Check its source passages.</InlineMessage> : null}
      {(error ?? pollError) && <InlineMessage tone="error" title="Rundown needs attention">{error ?? pollError}</InlineMessage>}
      {notice && <InlineMessage tone="success">{notice}</InlineMessage>}
      {pendingDecision && !mutating && <InlineMessage tone="warning">Decision receipt unavailable. Retry the same decision to check its result.
        <Button disabled={!connected || busy || disabled} onClick={() => void decide(pendingDecision)}>Retry decision receipt</Button></InlineMessage>}
      <div className="live-actions"><Button disabled={actionUnavailable || !view?.source.config?.enabled || Boolean(settings)} onClick={() => void refresh()}>Refresh rundown</Button></div>
      <details><summary>Source settings</summary>
        <form className="live-preparation-form" onSubmit={event => { event.preventDefault(); void configure(); }}>
          <label>Google Doc ID<TextInput value={config.documentId} disabled={unavailable} onChange={event => sourceEdit({ ...config, documentId: event.target.value })} /></label>
          <label>Selected tab IDs, separated by commas<TextInput value={config.tabIds.join(",")} disabled={unavailable} onChange={event => sourceEdit({ ...config, tabIds: event.target.value.split(",").map(id => id.trim()) })} /></label>
          <label className="rundown-check"><input type="checkbox" checked={config.enabled} disabled={unavailable} onChange={event => sourceEdit({ ...config, enabled: event.target.checked })} />Read this source</label>
          <p className="live-caption">Use exact IDs from the approved document. A parent tab does not select its child tabs. Studio activation requires the release owner.</p>
          <div className="live-actions"><Button type="submit" disabled={actionUnavailable || !settings || !validSourceConfig(config) || Boolean(edit?.changed)}>Save source settings</Button>
            {settings && <Button disabled={busy} onClick={() => setSettings(null)}>Discard source edits</Button>}
            <Button disabled={busy || mutating} onClick={() => {
              const load = () => { setSettings(null); setReload(value => value + 1); };
              if (settings) requestExit(load); else load();
            }}>Reload source settings</Button></div>
        </form>
      </details>
      {review && <><h3 ref={reviewHeading} tabIndex={-1}>Source proposals</h3>{review.changes.length ? <ol className="rundown-change-list">{review.changes.map(change => <li key={change.id}>
        <Button aria-pressed={edit?.change.id === change.id} disabled={unavailable} onClick={() => selectChange(change)}>
          {change.status.charAt(0) + change.status.slice(1).toLowerCase()} · {change.candidate?.segmentTitle || change.candidate?.tabTitle || "Source removed"}
          <span className="rundown-row-copy">{change.candidate?.rawLines.join(" / ") ?? "Keep the existing draft"}</span>
        </Button>
      </li>)}</ol> : <p>No source changes need review.</p>}</>}
      {edit && <section aria-label="Review source suggestion" className="rundown-change-editor">
        <h3>{edit.change.status === "REMOVED" ? "Source removed" : "Compare source and draft"}</h3>
        {edit.change.reasons.map(reason => <p key={reason}>{reasonLabels.get(reason) ?? (/^[a-z][a-z0-9_]*$/.test(reason) ? "Check the source passage before accepting this suggestion." : reason)}</p>)}
        {stale && <InlineMessage tone="warning">The source or review changed. Your proposed edits remain here. Select the current suggestion before deciding.</InlineMessage>}
        {edit.change.possibleTargets.length > 0 && <label>Banner identity<Select value={edit.targetId} disabled={unavailable} onChange={event => setEdit({ ...edit, targetId: event.target.value, overrides: [], changed: true })}>
          <option value="">Create a new source-linked draft</option>{edit.change.possibleTargets.map(item => <option key={item.bannerId} value={item.bannerId}>{item.sourceContext ?? "Source-linked banner"} · order {item.order + 1} · {bannerLines(item.text).join(" / ")} · v{item.baseVersion}</option>)}
        </Select></label>}
        <div className="rundown-compare"><div><h4>Current draft{target ? ` · v${target.baseVersion}` : ""}</h4>
          {target && <><p>Current order: {target.order + 1}</p>{target.sourceContext && <p>{target.sourceContext}</p>}</>}<Copy text={target?.text ?? null} /></div>
          <div><h4>Proposed draft</h4>{edit.change.candidate && <p>Source order: {edit.change.candidate.order + 1}</p>}{edit.change.status === "REMOVED" ? <p>The draft stays saved.</p> : <>
            <label>Template<Select value={edit.text?.templateId ?? ""} disabled={unavailable || stale} onChange={event => {
              const templateId = event.target.value; if (templateId !== "headline" && templateId !== "name_title") return;
              const changeTemplate = () => setEdit({ ...edit, text: proposalBaseline(edit.change.candidate!, templateId), changed: true });
              if (edit.changed) requestExit(changeTemplate); else changeTemplate();
            }}><option value="" disabled>Choose a template</option><option value="headline">One-line headline</option><option value="name_title">Name and title</option></Select></label>
            {edit.text && <BannerFields text={edit.text} disabled={unavailable} onChange={text => setEdit({ ...edit, text, changed: true })} />}
          </>}</div></div>
        {target?.protectedFields.map(field => <label className="rundown-check" key={field}><input type="checkbox" disabled={unavailable || stale} checked={edit.overrides.includes(field)}
          onChange={event => setEdit({ ...edit, overrides: event.target.checked ? [...edit.overrides, field] : edit.overrides.filter(key => key !== field), changed: true })} />Replace producer-edited {field === "templateId" ? "template" : field}</label>)}
        {target?.protectedFields.length ? <p className="live-caption">{templateOverrideRequired
          ? "To change templates, select every producer-edited text field above. Unchecked order keeps its current value."
          : "Unchecked fields keep their current draft values."}</p> : null}
        <details><summary>Source passage</summary><p>{edit.change.candidate?.tabTitle} · {edit.change.candidate?.segmentTitle}</p>
          {edit.change.candidate?.passages.map((passage, index) => <div key={index}><p className="live-caption">{passage.location}</p><pre className="rundown-passage">{passage.text}</pre></div>) ?? <p>This source passage is absent from the current read.</p>}</details>
        <div className="live-actions"><Button disabled={actionUnavailable || stale || templateOverrideRequired || Boolean(settings) || (edit.change.status !== "REMOVED" && (!edit.text || !validBannerText(edit.text)))} onClick={() => void decide(decision("accept"))}>
          {edit.change.status === "REMOVED" ? "Keep draft and acknowledge removal" : "Accept into draft"}</Button>
          <Button variant="ghost" disabled={actionUnavailable || stale} onClick={() => void decide(decision("ignore"))}>Ignore suggestion</Button></div>
        <p className="live-caption">Accept changes only the draft. Use Take or Update live separately when ready.</p>
      </section>}
    </div>
  </details>;
}
